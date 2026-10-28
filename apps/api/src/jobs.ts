import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { ApiService, User } from "./service";
import { list, one, put } from "./db";
import { config } from "./config";
import { now, redact } from "./security";

export class JobService {
  private queue?: Queue;
  private worker?: Worker;
  private controllers = new Map<string, AbortController>();
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Set<Promise<any>>();
  constructor(readonly api: ApiService) {}
  async init(isWorker = false) {
    if (process.env.REDIS_URL && !process.env.DATABASE_URL)
      throw new Error(
        "Redis workers require shared PostgreSQL DATABASE_URL; PGlite is single-process",
      );
    if (process.env.REDIS_URL) {
      const u = new URL(process.env.REDIS_URL);
      const connection = {
        host: u.hostname,
        port: Number(u.port || 6379),
        username: u.username || undefined,
        password: u.password || undefined,
        db: Number(u.pathname.slice(1) || 0),
        ...(u.protocol === "rediss:" ? { tls: {} } : {}),
      };
      this.queue = new Queue("autoblogger", { connection });
      if (isWorker)
        this.worker = new Worker(
          "autoblogger",
          async (job) => this.execute(String(job.data.id), true),
          { connection, concurrency: 2 },
        );
    } else if (config.production)
      throw new Error("Production worker requires Redis");
    this.api.onEvents = (ownerId, sessionId) => {
      const key = ownerId + ":" + sessionId;
      clearTimeout(this.timers.get(key));
      this.timers.set(
        key,
        setTimeout(async () => {
          this.timers.delete(key);
          if (
            process.env.AUTO_SUMMARIES === "false" ||
            !process.env.OPENROUTER_API_KEY
          )
            return;
          try {
            const user = await one(this.api.db, "users", ownerId);
            if (user) await this.create(user, { kind: "summarize", sessionId });
          } catch (error: any) {
            if (error?.status === 409)
              this.api.onEvents?.(
                ownerId,
                sessionId,
              ); /* Quota/config errors preserve originals without repeated paid calls. */
          }
        }, 2000),
      );
    };
    this.api.deleteExternal = async (user, article) => {
      const client = await this.api.ghostClient(user);
      await client.deletePost(article.publication.remoteId);
    };
    if (!this.queue) {
      for (const job of await list(this.api.db, "jobs"))
        if (["queued", "running"].includes(job.status)) {
          if (job.status === "running") {
            job.status = "failed";
            job.error = "Worker interrupted; retry retains immutable input";
            await put(this.api.db, "jobs", job);
          } else this.launch(job.id);
        }
    }
    return this;
  }
  async close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled([...this.pending]);
    await this.worker?.close();
    await this.queue?.close();
  }
  launch(id: string) {
    const p = Promise.resolve()
      .then(() => this.execute(id))
      .catch(() => {})
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
  async budget(user: User, sql = this.api.db as import("./db").Sql) {
    const runs = await list(sql, "model_runs", user.id);
    const day = now().slice(0, 10),
      month = day.slice(0, 7);
    const usage = {
      day: runs
        .filter((x) => x.createdAt?.slice(0, 10) === day)
        .reduce((s, x) => s + (x.cost || 0), 0),
      month: runs
        .filter((x) => x.createdAt?.slice(0, 7) === month)
        .reduce((s, x) => s + (x.cost || 0), 0),
    };
    if (usage.day >= user.dailyLimit || usage.month >= user.monthlyLimit)
      throw new HttpException(
        {
          message:
            "AI usage limit reached; recording and editing remain available",
          code: "USAGE_LIMIT",
        },
        429,
      );
    const spent = (await list(sql, "model_runs")).reduce(
      (s, x) => s + (x.cost || 0),
      0,
    );
    if (spent >= Number(process.env.OPENROUTER_TEST_BUDGET || 20))
      throw new HttpException("Development test budget exhausted", 429);
    const active = (await list(sql, "jobs", user.id)).some(
      (j) => j.kind !== "publish" && ["queued", "running"].includes(j.status),
    );
    if (active)
      throw new ConflictException("Another AI task is already active");
  }
  async create(user: User, body: any) {
    if (
      !["generate", "summarize", "suggest", "verify", "publish"].includes(
        body.kind,
      )
    )
      throw new BadRequestException("Invalid job kind");
    if (body.kind !== "publish") await this.budget(user);
    let article: any, session: any;
    if (body.articleId) {
      article = await this.api.owned("articles", body.articleId, user);
      body = {
        ...body,
        sessionId: article.sessionId,
        fileId: article.fileId || body.fileId,
      };
    }
    if (body.sessionId) session = await this.api.session(user, body.sessionId);
    if (!session) throw new BadRequestException("Session is required");
    if (["suggest", "verify", "publish"].includes(body.kind) && !article)
      throw new BadRequestException("Article is required");
    if (body.kind === "generate" && !article) {
      article = await this.api.createArticle(user, {
        sessionId: body.sessionId,
        fileId: body.fileId,
        title: "초안 생성 중",
      });
      body = { ...body, articleId: article.id };
    }
    if (
      body.kind === "suggest" &&
      !article.blocks.find((b: any) => b.id === body.blockId)
    )
      throw new BadRequestException("Block not found");
    if (
      body.kind === "publish" &&
      !["draft", "published"].includes(body.targetStatus)
    )
      throw new BadRequestException("Invalid publication state");
    let events = session.events.filter(
      (e: any) => !body.fileId || e.fileId === body.fileId,
    );
    if (body.kind === "summarize") {
      const seen = new Set(
        session.summaries.flatMap((s: any) => s.eventIds || []),
      );
      events = events.filter((e: any) => !seen.has(e.id));
      if (!events.length)
        throw new BadRequestException("No new events to summarize");
    }
    const selectedFile = body.fileId
      ? session.files.find((f: any) => f.id === body.fileId)
      : session.files.length === 1
        ? session.files[0]
        : undefined;
    if (body.fileId && !selectedFile)
      throw new BadRequestException("File not recorded in this session");
    const input = {
      ...body,
      events,
      problemStatement: selectedFile?.problemStatement || "",
      article: article ? structuredClone(article) : undefined,
      settings: await this.api.settings(),
    };
    const job = {
      id: randomUUID(),
      ownerId: user.id,
      kind: body.kind,
      status: "queued",
      progress: 0,
      input,
      articleId: article?.id,
      sessionId: body.sessionId,
      createdAt: now(),
      updatedAt: now(),
      attempts: 0,
    };
    await this.api.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
      if (body.kind !== "publish") await this.budget(user, tx);
      else await this.publicationAvailable(user, body.articleId, tx);
      await put(tx, "jobs", job);
    });
    if (body.kind === "publish")
      await this.api.revision(this.api.db, article, "publication");
    await this.enqueue(job);
    return this.safe(job);
  }
  async publicationAvailable(
    user: User,
    articleId: string,
    sql = this.api.db as import("./db").Sql,
  ) {
    if (
      (await list(sql, "jobs", user.id)).some(
        (j) =>
          j.kind === "publish" &&
          j.articleId === articleId &&
          ["queued", "running"].includes(j.status),
      )
    )
      throw new ConflictException(
        "A publication for this article is already active",
      );
  }
  async enqueue(job: any) {
    try {
      if (this.queue)
        await this.queue.add(
          job.kind,
          { id: job.id },
          { jobId: job.id, removeOnComplete: 100, removeOnFail: 100 },
        );
      else this.launch(job.id);
    } catch (error: any) {
      await this.set(job, {
        status: "failed",
        error: "Queue registration failed; retry when Redis is available",
      });
      throw new HttpException("Queue unavailable; job recorded for retry", 503);
    }
  }
  safe(job: any) {
    const { input, ...safe } = job;
    return {
      ...safe,
      settings: input?.settings,
      baseVersion: input?.article?.version,
    };
  }
  async get(user: User, id: string) {
    return this.safe(await this.api.owned("jobs", id, user));
  }
  async all(user: User) {
    return (await list(this.api.db, "jobs", user.id))
      .map((j) => this.safe(j))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async set(job: any, values: any) {
    Object.assign(job, values, { updatedAt: now() });
    const updated = await this.api.db.query(
      `UPDATE jobs SET data=$1 WHERE id=$2 AND owner_id=$3 AND ($4::text IS NULL OR data->>'executionToken'=$4) AND (data->>'status'<>'cancelled' OR $5::boolean) RETURNING id`,
      [
        JSON.stringify(job),
        job.id,
        job.ownerId,
        job.executionToken || null,
        values.status === "cancelled",
      ],
    );
    if (!updated.rows.length) return false;
    this.api.changes.next({
      ownerId: job.ownerId,
      jobId: job.id,
      sessionId: job.sessionId,
      data: this.safe(job),
    });
    return true;
  }
  async cancel(user: User, id: string) {
    const job = await this.api.owned("jobs", id, user);
    if (job.status === "completed" || job.status === "failed")
      throw new ConflictException("Job already finished");
    if (job.kind === "publish" && job.status === "running")
      throw new ConflictException(
        "Publication is already being sent; wait for remote confirmation",
      );
    job.status = "cancelled";
    job.updatedAt = now();
    await this.api.db.query(
      `UPDATE jobs SET data=data || $1::jsonb WHERE id=$2 AND owner_id=$3`,
      [
        JSON.stringify({ status: "cancelled", updatedAt: job.updatedAt }),
        id,
        user.id,
      ],
    );
    this.controllers.get(id)?.abort();
    const queued = await this.queue?.getJob(id);
    if (queued && !(await queued.isActive())) await queued.remove();
    return this.safe(job);
  }
  async retry(user: User, id: string) {
    const job = await this.api.owned("jobs", id, user);
    if (!["failed", "cancelled"].includes(job.status))
      throw new ConflictException("Only failed or cancelled jobs can retry");
    if (job.kind !== "publish") await this.budget(user);
    if (job.input.article)
      await this.api.owned("articles", job.input.article.id, user);
    if (job.sessionId) await this.api.owned("sessions", job.sessionId, user);
    await this.api.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
      const latest = await one(tx, "jobs", id, user.id);
      if (!latest || !["failed", "cancelled"].includes(latest.status))
        throw new ConflictException("Job already retried");
      if (job.kind !== "publish") await this.budget(user, tx);
      else await this.publicationAvailable(user, job.articleId, tx);
      job.status = "queued";
      job.error = null;
      job.progress = 0;
      job.updatedAt = now();
      await put(tx, "jobs", job);
    });
    if (this.queue) {
      const old = await this.queue.getJob(id);
      if (old) await old.remove();
    }
    await this.enqueue(job);
    return this.safe(job);
  }
  async alive(job: any, signal: AbortSignal) {
    if (signal.aborted) throw new Error("Cancelled");
    const current = await one(this.api.db, "jobs", job.id, job.ownerId);
    if (!current || current.status === "cancelled")
      throw new Error("Cancelled");
    if (job.executionToken && current.executionToken !== job.executionToken)
      throw new Error("Worker lease superseded");
    const user = await one(this.api.db, "users", job.ownerId);
    if (!user) throw new Error("Account deleted");
    if (job.input.article)
      await this.api.owned("articles", job.input.article.id, user);
    await this.api.owned("sessions", job.sessionId, user);
    return user as User;
  }
  async preparePublication(
    user: User,
    job: any,
    client: {
      uploadImage: (
        data: Uint8Array,
        filename: string,
        mime: string,
      ) => Promise<string>;
    },
  ) {
    const { rewriteGhostImages, safeFetch } = await import("@autoblogger/ai");
    const source = job.input.article.lexical;
    const origins = new Set(
      [
        config.webUrl,
        `http://127.0.0.1:${config.port}`,
        `http://localhost:${config.port}`,
        process.env.API_PUBLIC_URL,
      ]
        .filter(Boolean)
        .map((value) => new URL(value!).origin),
    );
    return rewriteGhostImages(source, async (src: string) => {
      if (job.imageMap?.[src]) return job.imageMap[src];
      const url = new URL(src, config.webUrl);
      const match = /^\/api\/uploads\/([^/]+)$/.exec(url.pathname);
      let buffer: Buffer, mime: string, filename: string;
      if (match && origins.has(url.origin)) {
        const stored = await this.api.readUpload(
          user,
          decodeURIComponent(match[1]),
        );
        buffer = stored.buffer;
        mime = stored.upload.mime;
        filename = stored.upload.filename;
      } else {
        const response = await safeFetch(url.href, {
          headers: { "User-Agent": "autoblogger/0.1" },
        });
        if (!response.ok)
          throw new BadRequestException("Unable to fetch remote image");
        mime = (response.headers.get("content-type") || "").split(";")[0];
        buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 10 * 1024 * 1024)
          throw new BadRequestException("Image too large");
        this.api.validateImage(buffer, mime);
        filename =
          "image-" + randomUUID() + "." + (mime.split("/")[1] || "bin");
      }
      const uploaded = await client.uploadImage(buffer, filename, mime);
      job.imageMap = { ...job.imageMap, [src]: uploaded };
      await this.set(job, { imageMap: job.imageMap });
      return uploaded;
    });
  }
  async execute(id: string, reclaim = false) {
    let job = await one(this.api.db, "jobs", id);
    if (
      !job ||
      !(job.status === "queued" || (reclaim && job.status === "running"))
    )
      return;
    if (job.attempts >= 5) {
      await this.set(job, {
        status: "failed",
        error: "Worker retry limit reached",
      });
      return;
    }
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const signal = controller.signal;
    const cancellationTimer = setInterval(async () => {
      try {
        const current = await one(this.api.db, "jobs", id);
        if (
          !current ||
          current.status === "cancelled" ||
          (job.executionToken && current.executionToken !== job.executionToken)
        )
          controller.abort();
      } catch {
        controller.abort();
      }
    }, 1000);
    try {
      const user = await this.alive(job, signal);
      const claimed = await this.api.db.query(
        `UPDATE jobs SET data=data || $1::jsonb WHERE id=$2 AND (data->>'status'='queued' OR ($3::boolean AND data->>'status'='running')) RETURNING data`,
        [
          JSON.stringify({
            status: "running",
            progress: 5,
            attempts: job.attempts + 1,
            executionToken: randomUUID(),
            updatedAt: now(),
          }),
          job.id,
          reclaim,
        ],
      );
      if (!claimed.rows.length) return;
      job = claimed.rows[0].data;
      const { AiService } = await import("@autoblogger/ai");
      const ai = new AiService({
        apiKey: process.env.OPENROUTER_API_KEY,
        onModelRun: async (run: any) => {
          if (await one(this.api.db, "users", user.id)) {
            const live = await one(this.api.db, "jobs", job.id);
            const stored = live
              ? run
              : { ...run, input: undefined, output: undefined };
            await put(this.api.db, "model_runs", {
              ...stored,
              ownerId: user.id,
              jobId: job.id,
              sessionId: job.sessionId,
              createdAt: run.createdAt || now(),
            });
          }
        },
      });
      const input = job.input;
      const params = {
        events: input.events,
        problemStatement: input.problemStatement,
        settings: input.settings,
        signal,
        ownerId: user.id,
        jobId: job.id,
      };
      let result: any;
      if (job.kind === "generate") {
        result = await ai.generate({
          ...params,
          onProgress: async (progress: any) => {
            const update =
              typeof progress === "number"
                ? { progress }
                : typeof progress === "string"
                  ? { delta: progress }
                  : { ...progress };
            const streamedText = (
              (job.stream?.text || "") + (update.delta || "")
            ).slice(0, 1000000);
            await this.set(job, {
              progress: Math.min(
                90,
                Math.max(10, Number(update.progress) || 20),
              ),
              stream: { ...update, text: streamedText },
              ...(update.delta && !job.firstTokenAt
                ? { firstTokenAt: now() }
                : {}),
            });
          },
        });
        await this.alive(job, signal);
        const article = await this.api.saveArticle(
          user,
          input.article.id,
          {
            expectedVersion: input.article.version,
            title: result.title,
            blocks: result.blocks,
            lexical: result.lexical,
            kind: "generated",
          },
          true,
        );
        for (const attempt of result.attempts || [])
          await put(
            this.api.db,
            "attempts",
            {
              ...attempt,
              id: attempt.id || randomUUID(),
              ownerId: user.id,
              sessionId: job.sessionId,
            },
            job.sessionId,
          );
        result = { articleId: article.id, version: article.version };
      } else if (job.kind === "summarize") {
        result = await ai.summarize(params);
        await this.alive(job, signal);
        const summary = {
          id: randomUUID(),
          ownerId: user.id,
          sessionId: job.sessionId,
          text: result.text,
          eventIds: input.events.map((e: any) => e.id),
          createdAt: now(),
        };
        await put(this.api.db, "summaries", summary, job.sessionId);
        result = { summary };
      } else if (job.kind === "suggest") {
        const block = input.article.blocks.find(
          (b: any) => b.id === input.blockId,
        );
        result = await ai.suggest({
          ...params,
          block,
          instruction: input.instruction || "더 짧게",
        });
        await this.alive(job, signal);
        const suggestion = {
          id: randomUUID(),
          ownerId: user.id,
          articleId: input.article.id,
          blockId: block.id,
          baseVersion: input.article.version,
          original: block,
          block: result.block,
          status: "pending",
          createdAt: now(),
        };
        await put(this.api.db, "suggestions", suggestion, input.article.id);
        result = { suggestion };
      } else if (job.kind === "verify") {
        result = await ai.verify({ ...params, blocks: input.article.blocks });
        await this.alive(job, signal);
        const updated = await this.api.updateReviews(
          user,
          input.article.id,
          input.article.version,
          result.blocks,
        );
        result = {
          articleId: input.article.id,
          version: updated.version,
          reviewStale: updated.stale,
        };
      } else if (job.kind === "publish") {
        const client = await this.api.ghostClient(user);
        const article = structuredClone(input.article);
        const lexical =
          job.preparedLexical ||
          (await this.preparePublication(user, job, client));
        await this.set(job, { preparedLexical: lexical });
        await this.alive(job, signal);
        const { ghostFingerprint } = await import("@autoblogger/ai");
        const remote = await this.api.db.withAdvisoryLock(
          "publish:" + article.id,
          async () => {
            await this.alive(job, signal);
            return client.publish({
              articleId: article.id,
              title: article.title,
              lexical,
              status: input.targetStatus,
              remoteId: article.publication?.remoteId,
              expectedUpdatedAt:
                input.expectedRemoteUpdatedAt || article.publication?.updatedAt,
              expectedFingerprint:
                input.expectedRemoteFingerprint ||
                article.publication?.fingerprint,
            });
          },
        );
        await this.alive(job, signal);
        const current = await this.api.owned("articles", article.id, user);
        current.publication = {
          remoteId: remote.id,
          fingerprint: ghostFingerprint(remote),
          updatedAt: remote.updated_at,
          url: remote.url,
          status: remote.status,
          version: article.version,
        };
        current.status = remote.status === "published" ? "published" : "draft";
        await this.api.db.query(
          "UPDATE articles SET data=data || $1::jsonb WHERE id=$2 AND owner_id=$3",
          [
            JSON.stringify({
              publication: current.publication,
              status: current.status,
            }),
            current.id,
            user.id,
          ],
        );
        result = { publication: current.publication };
      }
      await this.set(job, {
        status: "completed",
        progress: 100,
        result,
        completedAt: now(),
      });
      if (job.kind === "generate") {
        try {
          const review = await this.create(user, {
            kind: "verify",
            articleId: result.articleId,
          });
          await this.set(job, {
            result: { ...result, reviewJobId: review.id },
          });
        } catch (e: any) {
          await this.set(job, {
            result: { ...result, reviewPending: true, reviewReason: e.message },
          });
        }
      }
    } catch (error: any) {
      const live = await one(this.api.db, "jobs", id);
      if (live && live.status !== "cancelled")
        await this.set(job, {
          status: signal.aborted ? "cancelled" : "failed",
          error: redact(error?.message || "Job failed"),
          errorCode: error?.code || null,
        });
    } finally {
      clearInterval(cancellationTimer);
      this.controllers.delete(id);
    }
  }
}
