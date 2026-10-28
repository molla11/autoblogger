import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  HttpException,
} from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Subject } from "rxjs";
import { SourceBlobStore, SourceRef } from "./source-blobs";
import { SourceRepository } from "./source-repository";
import { replaceEditorBlock } from "./rich-text";
import { Database, Sql, one, list, put, Table } from "./db";
import { config, validateConfig } from "./config";
import {
  digest,
  token,
  now,
  redact,
  encryptionKey,
  encrypt,
  decrypt,
  text,
  id,
  validPath,
  equal,
  matchesGlob,
  truncateOutput,
} from "./security";

export type User = {
  id: string;
  email: string;
  role: "admin" | "user";
  dailyLimit: number;
  monthlyLimit: number;
  createdAt: string;
};
const blockTypes = ["heading", "paragraph", "quote", "code", "list", "image"];
const emptyLexical = {
  root: {
    type: "root",
    version: 1,
    children: [],
    direction: null,
    format: "",
    indent: 0,
  },
};
const eventTypes = [
  "snapshot",
  "edit",
  "run",
  "memo",
  "session_start",
  "session_stop",
];
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (x) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        x
      ]!,
  );
@Injectable()
export class ApiService {
  db!: Database;
  key!: Buffer;
  changes = new Subject<{
    ownerId: string;
    sessionId?: string;
    jobId?: string;
    data: any;
  }>();
  onEvents?: (ownerId: string, sessionId: string) => void;
  deleteExternal?: (user: User, article: any) => Promise<void>;
  sourceStore: SourceBlobStore;
  sources!: SourceRepository;
  constructor(options: { sourceStore?: SourceBlobStore } = {}) {
    if (
      process.env.SNAPSHOT_STORAGE &&
      !["local", "supabase"].includes(process.env.SNAPSHOT_STORAGE)
    )
      throw new Error("SNAPSHOT_STORAGE must be local or supabase");
    this.sourceStore =
      options.sourceStore ||
      new SourceBlobStore(path.join(config.dataDir, "source-blobs"), {
        mode:
          process.env.SNAPSHOT_STORAGE === "supabase" ? "supabase" : "local",
        bucket: process.env.SUPABASE_SOURCE_BUCKET || "autoblogger-sources",
      });
  }
  async init(location?: string) {
    validateConfig();
    await mkdir(config.dataDir, { recursive: true });
    let secret = process.env.ENCRYPTION_KEY;
    if (!secret) {
      const p = path.join(config.dataDir, "encryption.key");
      try {
        secret = await readFile(p, "utf8");
      } catch {
        secret = token();
        await writeFile(p, secret, { mode: 0o600, flag: "wx" });
      }
    }
    this.key = encryptionKey(secret!);
    this.db = await new Database(
      location ||
        process.env.DATABASE_URL ||
        path.join(config.dataDir, "postgres"),
    ).init();
    this.sources = new SourceRepository(this.db, this.sourceStore);
    await this.db.withAdvisoryLock("source-blob-mutations", () =>
      this.sources.recover(),
    );
    if (!(await one(this.db, "settings", "ai")))
      await put(this.db, "settings", {
        id: "ai",
        model: "openai/gpt-6.1-terra",
        provider: "Azure",
      });
    return this;
  }
  async close() {
    await this.db.close();
    this.changes.complete();
  }
  async userByEmail(email: string) {
    const found = (await list(this.db, "users")).find((x) => x.email === email);
    if (found) return found as User;
    const user: User = {
      id: randomUUID(),
      email,
      role:
        email === "admin@local.test" && config.authMode === "local"
          ? "admin"
          : "user",
      dailyLimit: 3,
      monthlyLimit: 15,
      createdAt: now(),
    };
    await put(this.db, "users", user);
    return user;
  }
  async localAuth(email: any) {
    if (config.authMode !== "local") throw new NotFoundException();
    email = text(email, "email", 200).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new BadRequestException("Invalid email");
    if (
      email !== "admin@local.test" &&
      !(await list(this.db, "users")).some((u) => u.email === email)
    )
      await this.ensureSignupAllowed(email);
    const user = await this.userByEmail(email);
    const device = await this.createDevice(user, "Local web session");
    return { token: device.token, user };
  }
  private jwks: any;
  async authenticate(value?: string): Promise<User> {
    if (!value?.startsWith("Bearer "))
      throw new UnauthorizedException("Login required");
    const raw = value.slice(7);
    if (!raw || raw.length > 8000) throw new UnauthorizedException();
    const hashed = digest(raw);
    const r = await this.db.query(
      `SELECT data FROM devices WHERE data->>'tokenHash'=$1`,
      [hashed],
    );
    const device = r.rows[0]?.data;
    if (device) {
      if (device.revokedAt || device.expiresAt < now())
        throw new UnauthorizedException("Device token expired or revoked");
      const user = await one(this.db, "users", device.ownerId);
      if (!user) throw new UnauthorizedException();
      return user;
    }
    if (config.authMode === "local")
      throw new UnauthorizedException("Invalid local token");
    const base = process.env.SUPABASE_URL;
    if (!base) throw new UnauthorizedException("Supabase is not configured");
    try {
      this.jwks ||= createRemoteJWKSet(
        new URL(`${base}/auth/v1/.well-known/jwks.json`),
      );
      const { payload } = await jwtVerify(raw, this.jwks, {
        issuer: `${base}/auth/v1`,
        audience: "authenticated",
      });
      if (!payload.sub || typeof payload.email !== "string") throw new Error();
      let user = await one(this.db, "users", payload.sub);
      if (!user) {
        if (process.env.ADMIN_USER_ID !== payload.sub)
          await this.ensureSignupAllowed(payload.email);
        user = {
          id: payload.sub,
          email: payload.email,
          role: process.env.ADMIN_USER_ID === payload.sub ? "admin" : "user",
          dailyLimit: 3,
          monthlyLimit: 15,
          createdAt: now(),
        };
        await put(this.db, "users", user);
      }
      return user;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new UnauthorizedException("Invalid Supabase token");
    }
  }
  admin(user: User) {
    if (user.role !== "admin")
      throw new ForbiddenException("Administrator only");
  }
  async ensureSignupAllowed(email: string) {
    const settings = await this.settings();
    const spent = (await list(this.db, "model_runs")).reduce(
      (s, x) => s + (x.cost || 0),
      0,
    );
    let exhausted = spent >= Number(process.env.OPENROUTER_TEST_BUDGET || 20);
    if (
      process.env.OPENROUTER_API_KEY &&
      process.env.SIGNUP_CREDIT_CHECK !== "false"
    ) {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/key", {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          },
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const result: any = await response.json();
          if (
            typeof result.data?.limit_remaining === "number" &&
            result.data.limit_remaining <= 0
          )
            exhausted = true;
        }
      } catch {
        /* Existing measured usage still enforces the local budget during key endpoint outages. */
      }
    }
    if (
      settings.signupPaused ||
      process.env.SIGNUPS_PAUSED === "true" ||
      exhausted
    ) {
      const entry = {
        id: "waitlist:" + digest(email.toLowerCase()),
        email,
        createdAt: now(),
        reason: exhausted ? "credit_exhausted" : "paused",
      };
      if (!(await one(this.db, "settings", entry.id)))
        await put(this.db, "settings", entry);
      throw new HttpException(
        {
          message:
            "현재 신규 가입은 대기 목록으로 접수됩니다. 기존 사용자는 계속 로그인할 수 있습니다.",
          code: "SIGNUP_WAITLIST",
        },
        503,
      );
    }
  }
  async usage(user: User) {
    const runs = await list(this.db, "model_runs", user.id),
      today = now().slice(0, 10),
      month = today.slice(0, 7);
    return {
      day: runs
        .filter((r) => r.createdAt?.slice(0, 10) === today)
        .reduce((s, r) => s + (r.cost || 0), 0),
      month: runs
        .filter((r) => r.createdAt?.slice(0, 7) === month)
        .reduce((s, r) => s + (r.cost || 0), 0),
    };
  }
  async me(user: User) {
    return { ...user, usage: await this.usage(user) };
  }
  async createDevice(user: User, name: any) {
    const secret = token();
    const device = {
      id: randomUUID(),
      ownerId: user.id,
      name: text(name || "VS Code", "name", 100),
      tokenHash: digest(secret),
      createdAt: now(),
      expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
    };
    await put(this.db, "devices", device);
    const { tokenHash, ...safe } = device;
    return { ...safe, token: secret };
  }
  async devices(user: User) {
    return (await list(this.db, "devices", user.id)).map(
      ({ tokenHash, ...d }) => d,
    );
  }
  async revokeDevice(user: User, deviceId: string) {
    const device = await this.owned("devices", deviceId, user);
    device.revokedAt = now();
    await put(this.db, "devices", device);
    return { revoked: true };
  }
  async pair(user: User, body: any) {
    const challenge = text(body.challenge, "challenge", 100);
    if (!/^[a-zA-Z0-9_-]{43}$/.test(challenge))
      throw new BadRequestException("Invalid PKCE challenge");
    const code = token();
    await put(this.db, "device_pairs", {
      id: digest(code),
      ownerId: user.id,
      challenge,
      name: text(body.name || "VS Code", "name", 100),
      expiresAt: Date.now() + 300000,
    });
    return { code };
  }
  async exchange(body: any) {
    const code = text(body.code, "code", 200),
      verifier = text(body.verifier, "verifier", 128);
    if (verifier.length < 43) throw new BadRequestException("Invalid verifier");
    const hashed = digest(code);
    let user!: User,
      name = "";
    await this.db.transaction(async (tx) => {
      const pair = await one(tx, "device_pairs", hashed);
      if (
        !pair ||
        pair.expiresAt < Date.now() ||
        !equal(
          pair.challenge,
          createHash("sha256").update(verifier).digest("base64url"),
        )
      )
        throw new UnauthorizedException("Invalid or expired pairing code");
      const consumed = await tx.query(
        "DELETE FROM device_pairs WHERE id=$1 RETURNING id",
        [hashed],
      );
      if (!consumed.rows.length)
        throw new UnauthorizedException("Pairing code already consumed");
      user = await one(tx, "users", pair.ownerId);
      name = pair.name;
    });
    const result = await this.createDevice(user, name);
    const { token, ...device } = result;
    return { token, device };
  }
  async owned(table: Table, entityId: string, user: User, sql: Sql = this.db) {
    const result = await one(sql, table, id(entityId), user.id);
    if (!result) throw new NotFoundException("Resource not found");
    return result;
  }
  async projects(user: User) {
    return list(this.db, "projects", user.id);
  }
  async createProject(user: User, body: any) {
    const project = {
      id: randomUUID(),
      ownerId: user.id,
      name: text(body.name, "name", 150),
      rootPath: typeof body.rootPath === "string" ? body.rootPath : "",
      excludePatterns: this.excludes(body.excludePatterns || []),
      excluded: false,
      createdAt: now(),
    };
    await put(this.db, "projects", project);
    return project;
  }
  excludes(value: any) {
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      value.some((x) => typeof x !== "string" || x.length > 300)
    )
      throw new BadRequestException("Invalid exclude patterns");
    return value;
  }
  async patchProject(user: User, projectId: string, body: any) {
    const p = await this.owned("projects", projectId, user);
    if (body.name !== undefined) p.name = text(body.name, "name", 150);
    if (body.excluded !== undefined) p.excluded = Boolean(body.excluded);
    if (body.excludePatterns !== undefined)
      p.excludePatterns = this.excludes(body.excludePatterns);
    await put(this.db, "projects", p);
    return p;
  }
  async sessions(user: User, projectId: string) {
    await this.owned("projects", projectId, user);
    return list(this.db, "sessions", user.id, projectId);
  }
  async patchFile(user: User, fileId: string, body: any) {
    const file = await this.owned("files", fileId, user);
    if (body.problemStatement !== undefined) {
      if (
        typeof body.problemStatement !== "string" ||
        body.problemStatement.length > 50000
      )
        throw new BadRequestException("Invalid problem statement");
      file.problemStatement = redact(body.problemStatement);
    }
    await put(this.db, "files", file, file.projectId);
    return file;
  }
  async createSession(user: User, projectId: string, body: any) {
    const project = await this.owned("projects", projectId, user);
    if (project.excluded)
      throw new ForbiddenException("Project recording is excluded");
    const sessionId = body.id ? id(body.id) : randomUUID();
    const existing = await one(this.db, "sessions", sessionId);
    if (existing) {
      if (existing.ownerId !== user.id || existing.projectId !== projectId)
        throw new ConflictException("Session ID already exists");
      return existing;
    }
    if (body.deviceId) await this.owned("devices", body.deviceId, user);
    const session = {
      id: sessionId,
      ownerId: user.id,
      projectId,
      deviceId: body.deviceId || null,
      startedAt: this.date(body.startedAt || now()),
      endedAt: null,
      recording: true,
      createdAt: now(),
      provenance: "recorded",
    };
    await put(this.db, "sessions", session, projectId);
    return session;
  }
  date(value: any) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
      throw new BadRequestException("Invalid timestamp");
    return new Date(value).toISOString();
  }
  async session(user: User, sessionId: string) {
    const session = await this.owned("sessions", sessionId, user);
    const storedEvents = (
      await this.db.query(
        "SELECT data FROM events WHERE owner_id=$1 AND session_id=$2 ORDER BY sequence",
        [user.id, sessionId],
      )
    ).rows.map((x) => x.data);
    const events = await Promise.all(
      storedEvents.map((event) => this.sources.hydrate(event, user.id)),
    );
    const fileIds = new Set(events.map((x) => x.fileId));
    const files = (
      await list(this.db, "files", user.id, session.projectId)
    ).filter((f) => fileIds.has(f.id));
    return {
      session,
      files,
      events,
      summaries: await list(this.db, "summaries", user.id, sessionId),
      gaps: this.ack(events).gaps,
    };
  }
  async patchSession(user: User, sessionId: string, body: any) {
    const s = await this.owned("sessions", sessionId, user);
    if (body.endedAt) s.endedAt = this.date(body.endedAt);
    if (body.recording !== undefined) s.recording = Boolean(body.recording);
    if (s.endedAt) s.recording = false;
    await put(this.db, "sessions", s, s.projectId);
    return s;
  }
  ack(events: any[]) {
    const received = events.map((x) => x.sequence).sort((a, b) => a - b),
      set = new Set(received);
    let ackThrough = 0;
    while (set.has(ackThrough + 1)) ackThrough++;
    const max = received.at(-1) || 0,
      gaps = [];
    for (let i = ackThrough + 1; i < max && gaps.length < 10000; i++)
      if (!set.has(i)) gaps.push(i);
    return { ackThrough, received, gaps };
  }
  async ingest(user: User, sessionId: string, body: any) {
    const session = await this.owned("sessions", sessionId, user);
    let project = await this.owned("projects", session.projectId, user);
    if (project.excluded)
      throw new ForbiddenException("Project recording is excluded");
    if (!Array.isArray(body.events) || body.events.length > 1000)
      throw new BadRequestException("Maximum 1000 events per batch");
    const writes: { ref: SourceRef; content: string }[] = [];
    await this.db.withAdvisoryLock("source-blob-mutations", async () => {
      await this.owned("sessions", sessionId, user);
      project = await this.owned("projects", session.projectId, user);
      if (project.excluded)
        throw new ForbiddenException("Project recording is excluded");
      try {
        await this.db.transaction(async (tx) => {
          for (const input of body.events) {
            if (
              !input ||
              !eventTypes.includes(input.type) ||
              input.sessionId !== sessionId ||
              !Number.isSafeInteger(input.sequence) ||
              input.sequence < 1 ||
              input.sequence > 1000000 ||
              !input.data ||
              typeof input.data !== "object"
            )
              throw new BadRequestException("Invalid record event");
            if (Object.prototype.hasOwnProperty.call(input.data, "contentRef"))
              throw new BadRequestException(
                "contentRef is a server-managed field",
              );
            id(input.id);
            this.date(input.occurredAt);
            if (Buffer.byteLength(JSON.stringify(input)) > 1500000)
              throw new BadRequestException("Event too large");
            const ev = redact({
              ...input,
              ownerId: user.id,
              receivedAt: now(),
            });
            if (ev.type === "run" && typeof ev.data.output === "string")
              ev.data.output = truncateOutput(ev.data.output);
            if (ev.filePath && !ev.fileId)
              ev.fileId = digest(`${session.projectId}:${ev.filePath}`);
            if (ev.type === "snapshot" && typeof ev.data.content === "string")
              ev.data.hash = digest(ev.data.content);
            const prior = await tx.query(
              "SELECT data FROM events WHERE id=$1 OR (session_id=$2 AND sequence=$3)",
              [ev.id, sessionId, ev.sequence],
            );
            if (prior.rows.length) {
              const p = await this.sources.hydrate(
                prior.rows[0].data,
                user.id,
                tx,
              );
              const { receivedAt: _a, ownerId: _b, ...a } = p;
              const { receivedAt: _c, ownerId: _d, ...b } = ev;
              if (!isDeepStrictEqual(a, b))
                throw new ConflictException("Event ID or sequence conflicts");
              continue;
            }
            if (ev.filePath) {
              validPath(ev.filePath);
              if (
                project.excludePatterns.some((p: string) =>
                  matchesGlob(ev.filePath, p),
                )
              )
                throw new ForbiddenException("File excluded");
              const fileId =
                ev.fileId || digest(`${session.projectId}:${ev.filePath}`);
              const existing = await one(tx, "files", fileId);
              if (
                existing &&
                (existing.ownerId !== user.id ||
                  existing.projectId !== session.projectId ||
                  existing.path !== ev.filePath)
              )
                throw new ConflictException("File ID conflicts");
              if (!existing)
                await put(
                  tx,
                  "files",
                  {
                    id: fileId,
                    ownerId: user.id,
                    projectId: session.projectId,
                    path: ev.filePath,
                    language: ev.filePath.split(".").at(-1),
                    problemStatement: "",
                    createdAt: now(),
                  },
                  session.projectId,
                );
              ev.fileId = fileId;
            } else if (ev.fileId) {
              const f = await this.owned("files", ev.fileId, user, tx);
              if (f.projectId !== session.projectId)
                throw new BadRequestException(
                  "File belongs to another project",
                );
            }
            if (["snapshot", "edit"].includes(ev.type) && !ev.fileId)
              throw new BadRequestException("File required");
            if (ev.type === "snapshot") {
              if (
                typeof ev.data.content !== "string" ||
                Buffer.byteLength(ev.data.content) > 1048576 ||
                ev.data.content.includes("\0")
              )
                throw new BadRequestException("Invalid snapshot");
              ev.data.hash = digest(ev.data.content);
              const content = ev.data.content;
              const ref = this.sourceStore.ref(user.id, sessionId, content);
              writes.push({ ref, content });
              await this.sourceStore.restore(ref, user.id, content);
              ev.data = { ...ev.data, contentRef: ref };
              delete ev.data.content;
            }
            await tx.query(
              "INSERT INTO events(id,owner_id,session_id,sequence,data) VALUES($1,$2,$3,$4,$5)",
              [ev.id, user.id, sessionId, ev.sequence, JSON.stringify(ev)],
            );
            if (ev.type === "snapshot")
              await tx.query(
                "INSERT INTO snapshots(id,file_id,hash,data) VALUES($1,$2,$3,$4)",
                [ev.id, ev.fileId, ev.data.hash, JSON.stringify(ev.data)],
              );
            if (ev.type === "edit")
              await tx.query(
                "INSERT INTO edits(id,file_id,data) VALUES($1,$2,$3)",
                [ev.id, ev.fileId, JSON.stringify(ev.data)],
              );
            if (ev.type === "run" && ev.data.snapshotId) {
              const linked = await tx.query(
                "SELECT data FROM events WHERE id=$1",
                [ev.data.snapshotId],
              );
              if (
                linked.rows.length &&
                (linked.rows[0].data.ownerId !== user.id ||
                  linked.rows[0].data.sessionId !== sessionId ||
                  linked.rows[0].data.type !== "snapshot" ||
                  (ev.fileId && linked.rows[0].data.fileId !== ev.fileId))
              )
                throw new BadRequestException(
                  "Run snapshot must belong to the same session and file",
                );
            }
            if (ev.type === "run")
              await tx.query(
                "INSERT INTO runs(id,file_id,snapshot_id,data) VALUES($1,$2,$3,$4)",
                [
                  ev.id,
                  ev.fileId || null,
                  ev.data.snapshotId || null,
                  JSON.stringify(ev.data),
                ],
              );
            if (ev.type === "memo")
              await tx.query(
                "INSERT INTO memos(id,file_id,data) VALUES($1,$2,$3)",
                [ev.id, ev.fileId || null, JSON.stringify(ev.data)],
              );
          }
        });
      } catch (error) {
        for (const write of writes)
          await this.sources.discard(write.ref, write.content).catch(() => {});
        throw error;
      }
    });
    const view = await this.session(user, sessionId);
    this.changes.next({
      ownerId: user.id,
      sessionId,
      data: { type: "records", count: view.events.length },
    });
    if (body.events.some((x: any) => ["snapshot", "run"].includes(x.type)))
      this.onEvents?.(user.id, sessionId);
    return this.ack(view.events);
  }
  async sample(user: User) {
    const project = await this.createProject(user, {
        name: "샘플: 두 수의 합",
        rootPath: "sample",
      }),
      session = await this.createSession(user, project.id, {});
    session.provenance = "mock";
    await put(this.db, "sessions", session, project.id);
    const fileId = randomUUID(),
      snapshot1 = randomUUID(),
      snapshot2 = randomUUID();
    const make = (
      type: string,
      data: any,
      seq: number,
      eventId = randomUUID(),
    ) => ({
      id: eventId,
      sessionId: session.id,
      sequence: seq,
      type,
      fileId,
      filePath: "sum.cpp",
      occurredAt: new Date(Date.now() - (7 - seq) * 60000).toISOString(),
      data,
    });
    const broken =
        "#include <iostream>\nint main(){ int a,b; std::cin>>a>>b; std::cout<<a-b; }\n",
      fixed = broken.replace("a-b", "a+b");
    const events = [
      make("snapshot", { content: broken, hash: digest(broken) }, 1, snapshot1),
      make(
        "run",
        {
          command: "g++ sum.cpp -o sum && ./sum",
          cwd: "sample",
          kind: "compile_run",
          status: "success",
          exitCode: 0,
          output: "-1",
          durationMs: 115,
          snapshotId: snapshot1,
        },
        2,
      ),
      make(
        "memo",
        {
          text: "입력 2 3의 기대값은 5인데 -1이 나왔다. 뺄셈 연산자를 덧셈으로 수정한다.",
          bookmark: true,
        },
        3,
      ),
      make(
        "edit",
        {
          before: broken,
          after: fixed,
          diff: "- a-b\n+ a+b",
          source: "direct",
        },
        4,
      ),
      make("snapshot", { content: fixed, hash: digest(fixed) }, 5, snapshot2),
      make(
        "run",
        {
          command: "g++ sum.cpp -o sum && ./sum",
          cwd: "sample",
          kind: "compile_run",
          status: "success",
          exitCode: 0,
          output: "5",
          durationMs: 98,
          snapshotId: snapshot2,
        },
        6,
      ),
    ];
    await this.ingest(user, session.id, { events });
    return { project, session };
  }
  async articles(user: User) {
    return list(this.db, "articles", user.id);
  }
  validateBlocks(blocks: any) {
    if (!Array.isArray(blocks) || blocks.length > 500)
      throw new BadRequestException("Invalid blocks");
    const ids = new Set<string>();
    for (const b of blocks) {
      if (
        !b ||
        typeof b.id !== "string" ||
        ids.has(b.id) ||
        !blockTypes.includes(b.type) ||
        typeof b.text !== "string" ||
        b.text.length > 200000 ||
        !Array.isArray(b.evidenceIds) ||
        b.evidenceIds.some((x: any) => typeof x !== "string")
      )
        throw new BadRequestException("Invalid article block");
      ids.add(b.id);
    }
    return blocks;
  }
  async createArticle(user: User, body: any) {
    const session = await this.owned("sessions", body.sessionId, user);
    const fileIds = (
      await this.db.query(
        `SELECT DISTINCT data->>'fileId' AS id FROM events WHERE session_id=$1 AND owner_id=$2 AND data->>'fileId' IS NOT NULL`,
        [body.sessionId, user.id],
      )
    ).rows.map((r) => r.id);
    if (!body.fileId && fileIds.length > 1)
      throw new BadRequestException("Choose one source file for the article");
    body = { ...body, fileId: body.fileId || fileIds[0] };
    if (body.fileId && !fileIds.includes(body.fileId))
      throw new BadRequestException("File not recorded in this session");
    if (body.fileId) {
      const file = await this.owned("files", body.fileId, user);
      if (file.projectId !== session.projectId)
        throw new BadRequestException("File belongs to another project");
    }
    const article = {
      id: randomUUID(),
      ownerId: user.id,
      sessionId: body.sessionId,
      fileId: body.fileId || null,
      title: body.title ? text(body.title, "title", 300) : "새 문제 풀이 기록",
      version: 1,
      lexical: emptyLexical,
      blocks: [],
      status: "local",
      createdAt: now(),
      updatedAt: now(),
    };
    await this.db.transaction(async (tx) => {
      await put(tx, "articles", article, article.sessionId);
      await this.revision(tx, article, "manual");
    });
    return article;
  }
  async revision(tx: Sql, article: any, kind: string) {
    const rev = {
      id: randomUUID(),
      ownerId: article.ownerId,
      articleId: article.id,
      version: article.version,
      kind,
      article: structuredClone(article),
      createdAt: now(),
    };
    await put(tx, "revisions", rev, article.id);
    if (kind === "auto")
      await tx.query(
        `DELETE FROM revisions WHERE id IN (SELECT id FROM revisions WHERE parent_id=$1 AND data->>'kind'='auto' ORDER BY (data->>'version')::int DESC OFFSET 50)`,
        [article.id],
      );
    return rev;
  }
  async saveArticle(
    user: User,
    articleId: string,
    body: any,
    internal = false,
  ) {
    const blocks = this.validateBlocks(body.blocks);
    if (!Number.isInteger(body.expectedVersion))
      throw new BadRequestException("expectedVersion required");
    if (
      !body.lexical ||
      typeof body.lexical !== "object" ||
      JSON.stringify(body.lexical).length > 2000000
    )
      throw new BadRequestException("Invalid editor document");
    return this.db.transaction(async (tx) => {
      const old = await this.owned("articles", articleId, user, tx);
      if (old.version !== body.expectedVersion)
        throw new ConflictException("Article changed in another tab");
      const oldById = new Map(old.blocks.map((b: any) => [b.id, b]));
      const validEvidence = new Set(
        (
          await tx.query(
            "SELECT id FROM events WHERE session_id=$1 AND owner_id=$2",
            [old.sessionId, user.id],
          )
        ).rows.map((e) => e.id),
      );
      const nextBlocks = blocks.map((b: any) => {
        const prior: any = oldById.get(b.id);
        const evidenceIds = b.evidenceIds.filter((x: string) =>
          validEvidence.has(x),
        );
        const changed =
          !prior ||
          ["text", "type", "language", "url", "evidenceIds"].some(
            (k) => JSON.stringify(prior[k]) !== JSON.stringify(b[k]),
          );
        return {
          ...b,
          evidenceIds,
          review: !evidenceIds.length
            ? "needs_review"
            : internal
              ? b.review || "needs_review"
              : changed
                ? "needs_review"
                : prior.review,
        };
      });
      const contentChanged =
        old.title !== body.title ||
        !isDeepStrictEqual(old.lexical, body.lexical) ||
        !isDeepStrictEqual(
          old.blocks.map(({ review, ...b }: any) => b),
          nextBlocks.map(({ review, ...b }: any) => b),
        );
      const article = {
        ...old,
        title: text(body.title, "title", 300),
        lexical: body.lexical,
        blocks: nextBlocks,
        version: old.version + 1,
        updatedAt: now(),
        editingCompletedAt: contentChanged
          ? null
          : old.editingCompletedAt || null,
      };
      const r = await tx.query(
        "UPDATE articles SET version=$1,data=$2 WHERE id=$3 AND owner_id=$4 AND version=$5 RETURNING id",
        [
          article.version,
          JSON.stringify(article),
          articleId,
          user.id,
          old.version,
        ],
      );
      if (!r.rows.length)
        throw new ConflictException("Article changed in another tab");
      await tx.query("DELETE FROM evidence WHERE parent_id=$1", [articleId]);
      for (const b of nextBlocks)
        for (const eventId of b.evidenceIds)
          await put(
            tx,
            "evidence",
            {
              id: randomUUID(),
              ownerId: user.id,
              articleId,
              blockId: b.id,
              eventId,
              review: b.review,
            },
            articleId,
          );
      await this.revision(
        tx,
        article,
        internal
          ? body.kind || "generated"
          : body.kind === "auto"
            ? "auto"
            : "manual",
      );
      return article;
    });
  }
  async completeArticle(user: User, articleId: string, body: any) {
    if (!Number.isInteger(body.expectedVersion))
      throw new BadRequestException("expectedVersion required");
    return this.db.transaction(async (tx) => {
      const article = await this.owned("articles", articleId, user, tx);
      if (article.version !== body.expectedVersion)
        throw new ConflictException("Article changed in another tab");
      const editingCompletedAt = article.editingCompletedAt || now();
      const updated = await tx.query(
        `UPDATE articles SET data=data || $1::jsonb WHERE id=$2 AND owner_id=$3 AND version=$4 RETURNING data`,
        [
          JSON.stringify({ editingCompletedAt }),
          articleId,
          user.id,
          body.expectedVersion,
        ],
      );
      if (!updated.rows.length)
        throw new ConflictException("Article changed in another tab");
      const metricId = "complete:" + articleId;
      if (!(await one(tx, "metrics", metricId, user.id)))
        await put(
          tx,
          "metrics",
          {
            id: metricId,
            ownerId: user.id,
            type: "editing_completed",
            articleId,
            sessionId: article.sessionId,
            createdAt: editingCompletedAt,
          },
          articleId,
        );
      return updated.rows[0].data;
    });
  }
  async updateReviews(
    user: User,
    articleId: string,
    expectedVersion: number,
    reviewed: any[],
  ) {
    return this.db.transaction(async (tx) => {
      const article = await this.owned("articles", articleId, user, tx);
      if (article.version !== expectedVersion)
        return { stale: true, version: article.version };
      const reviews = new Map(reviewed.map((b) => [b.id, b]));
      const validEvidence = new Set(
        (
          await tx.query(
            "SELECT id FROM events WHERE session_id=$1 AND owner_id=$2",
            [article.sessionId, user.id],
          )
        ).rows.map((e) => e.id),
      );
      const blocks = article.blocks.map((b: any) => {
        const review = reviews.get(b.id);
        const match =
          review &&
          ["text", "type", "language", "url", "evidenceIds"].every((k) =>
            isDeepStrictEqual(b[k], review[k]),
          );
        return {
          ...b,
          review:
            match &&
            b.evidenceIds.length &&
            b.evidenceIds.every((id: string) => validEvidence.has(id))
              ? review.review
              : b.review,
        };
      });
      const updated = await tx.query(
        `UPDATE articles SET data=jsonb_set(data,'{blocks}',$1::jsonb) WHERE id=$2 AND owner_id=$3 AND version=$4 RETURNING data`,
        [JSON.stringify(blocks), articleId, user.id, expectedVersion],
      );
      if (!updated.rows.length) return { stale: true };
      for (const b of blocks)
        await tx.query(
          `UPDATE evidence SET data=jsonb_set(data,'{review}',$1::jsonb) WHERE parent_id=$2 AND data->>'blockId'=$3`,
          [JSON.stringify(b.review), articleId, b.id],
        );
      return { stale: false, version: expectedVersion };
    });
  }
  async revisions(user: User, articleId: string) {
    await this.owned("articles", articleId, user);
    return (await list(this.db, "revisions", user.id, articleId)).sort(
      (a, b) => b.version - a.version,
    );
  }
  async restore(user: User, articleId: string, body: any) {
    const rev = await this.owned("revisions", body.revisionId, user);
    if (rev.articleId !== articleId) throw new NotFoundException();
    return this.saveArticle(user, articleId, {
      ...rev.article,
      expectedVersion: body.expectedVersion,
      kind: "manual",
    });
  }
  async suggestions(user: User, articleId: string) {
    await this.owned("articles", articleId, user);
    return list(this.db, "suggestions", user.id, articleId);
  }
  async resolveSuggestion(user: User, suggestionId: string, body: any) {
    const s = await this.owned("suggestions", suggestionId, user);
    if (s.status !== "pending")
      throw new ConflictException("Suggestion already resolved");
    if (body.action === "reject") {
      s.status = "rejected";
      await put(this.db, "suggestions", s, s.articleId);
      return s;
    }
    if (body.action !== "accept")
      throw new BadRequestException("Unknown action");
    const article = await this.owned("articles", s.articleId, user);
    if (
      s.baseVersion !== article.version ||
      body.expectedVersion !== article.version
    )
      throw new ConflictException({
        message: "Document changed; compare the suggestion before applying",
        code: "STALE_SUGGESTION",
        suggestion: s,
        currentVersion: article.version,
      });
    const blocks = article.blocks.map((b: any) =>
      b.id === s.blockId ? { ...s.block, id: b.id, review: "needs_review" } : b,
    );
    const replacement = { ...s.block, id: s.blockId, review: "needs_review" };
    const lexical = replaceEditorBlock(
      article.lexical,
      article.blocks,
      replacement,
    );
    const updated = await this.saveArticle(
      user,
      article.id,
      {
        expectedVersion: article.version,
        title: article.title,
        blocks,
        lexical,
        kind: "ai",
      },
      true,
    );
    s.status = "accepted";
    await put(this.db, "suggestions", s, s.articleId);
    return updated;
  }
  async markdown(user: User, articleId: string) {
    const article = await this.owned("articles", articleId, user);
    const { blocksToMarkdown } = await import("@autoblogger/shared");
    return {
      markdown: `# ${article.title}\n\n${blocksToMarkdown(article.blocks.map((b: any) => (b.type === "image" && b.url?.startsWith("/api/") ? { ...b, url: new URL(b.url, config.webUrl).href } : b)))}`,
    };
  }
  async preview(user: User, articleId: string) {
    const article = await this.owned("articles", articleId, user);
    const { rewriteGhostImages } = await import("@autoblogger/ai");
    const lexical = await rewriteGhostImages(
      article.lexical,
      async (src: string) => {
        const url = new URL(src, config.webUrl),
          match = /^\/api\/uploads\/([^/]+)$/.exec(url.pathname);
        const ownOrigins = [
          new URL(config.webUrl).origin,
          `http://127.0.0.1:${config.port}`,
          `http://localhost:${config.port}`,
          process.env.API_PUBLIC_URL,
        ].filter(Boolean);
        if (match && ownOrigins.includes(url.origin)) {
          const signed = await this.uploadUrl(
            user,
            decodeURIComponent(match[1]),
          );
          return new URL(
            signed.url,
            process.env.API_PUBLIC_URL || `http://127.0.0.1:${config.port}`,
          ).href;
        }
        return url.href;
      },
    );
    const cards = lexical.root.children
      .filter((node: any) => node.type === "html")
      .map((node: any) => node.html)
      .join("\n");
    return {
      html: `<article><h1>${escape(article.title)}</h1>${cards}</article>`,
    };
  }
  async ghost(user: User) {
    const connection = (await list(this.db, "ghost_connections", user.id))[0];
    return connection
      ? {
          connected: true,
          id: connection.id,
          url: connection.url,
          lastCheckedAt: connection.lastCheckedAt,
        }
      : { connected: false };
  }
  async connectGhost(user: User, body: any) {
    const url = text(body.url, "url", 2000),
      key = text(body.key, "key", 500);
    if (!/^[a-f0-9]+:[a-f0-9]+$/i.test(key))
      throw new BadRequestException("Invalid Ghost Admin API key");
    const { GhostClient } = await import("@autoblogger/ai");
    const client = new GhostClient({
      url,
      key,
      allowLocal:
        process.env.ALLOW_LOCAL_GHOST === "true" &&
        config.authMode === "local" &&
        !config.production,
    });
    await client.checkConnection();
    const old = (await list(this.db, "ghost_connections", user.id))[0];
    const connection = {
      id: old?.id || randomUUID(),
      ownerId: user.id,
      url,
      encryptedKey: encrypt(key, this.key),
      lastCheckedAt: now(),
    };
    await put(this.db, "ghost_connections", connection);
    return this.ghost(user);
  }
  async ghostClient(user: User) {
    const c = (await list(this.db, "ghost_connections", user.id))[0];
    if (!c) throw new BadRequestException("Connect Ghost in settings first");
    const { GhostClient } = await import("@autoblogger/ai");
    return new GhostClient({
      url: c.url,
      key: decrypt(c.encryptedKey, this.key),
      allowLocal:
        process.env.ALLOW_LOCAL_GHOST === "true" &&
        config.authMode === "local" &&
        !config.production,
    });
  }
  async disconnectGhost(user: User) {
    await this.db.query("DELETE FROM ghost_connections WHERE owner_id=$1", [
      user.id,
    ]);
    return { connected: false };
  }
  async remote(user: User, articleId: string) {
    const article = await this.owned("articles", articleId, user);
    if (!article.publication?.remoteId)
      return { remote: null, conflict: false };
    const client = await this.ghostClient(user),
      remote = await client.getPost(article.publication.remoteId);
    const { ghostFingerprint } = await import("@autoblogger/ai");
    const fingerprint = ghostFingerprint(remote);
    return {
      remote,
      fingerprint,
      conflict:
        remote.updated_at !== article.publication.updatedAt ||
        Boolean(
          article.publication.fingerprint &&
          fingerprint !== article.publication.fingerprint,
        ),
    };
  }
  async upload(user: User, file: any) {
    if (
      !file?.buffer ||
      file.size > 10 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        file.mimetype,
      )
    )
      throw new BadRequestException(
        "PNG, JPEG, GIF, WebP image up to 10 MB required",
      );
    this.validateImage(file.buffer, file.mimetype);
    const uploadId = randomUUID(),
      filename =
        uploadId +
        "." +
        (
          {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/gif": "gif",
            "image/webp": "webp",
          } as any
        )[file.mimetype];
    await mkdir(path.join(config.dataDir, "uploads"), { recursive: true });
    await writeFile(
      path.join(config.dataDir, "uploads", filename),
      file.buffer,
      { flag: "wx" },
    );
    const upload = {
      id: uploadId,
      ownerId: user.id,
      filename,
      mime: file.mimetype,
      size: file.size,
      url: `/api/uploads/${uploadId}`,
      createdAt: now(),
    };
    await put(this.db, "uploads", upload);
    return this.uploadUrl(user, upload.id);
  }
  async readUpload(user: User, uploadId: string) {
    const upload = await this.owned("uploads", uploadId, user);
    if (upload.storagePath) {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
        throw new BadRequestException("Storage not configured");
      const { createClient } = await import("@supabase/supabase-js");
      const { data, error } = await createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      )
        .storage.from(upload.bucket)
        .download(upload.storagePath);
      if (error || !data)
        throw new NotFoundException("Uploaded object not found");
      if (data.size > 10 * 1024 * 1024)
        throw new BadRequestException("Image too large");
      const buffer = Buffer.from(await data.arrayBuffer());
      this.validateImage(buffer, upload.mime);
      return {
        upload: {
          ...upload,
          filename: upload.id + "." + upload.mime.split("/")[1],
        },
        buffer,
      };
    }
    return {
      upload,
      buffer: await readFile(
        path.join(config.dataDir, "uploads", upload.filename),
      ),
    };
  }
  validateImage(buffer: Buffer, mime: string) {
    const okay =
      mime === "image/png"
        ? buffer
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === "image/jpeg"
          ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
          : mime === "image/gif"
            ? ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString())
            : mime === "image/webp"
              ? buffer.subarray(0, 4).toString() === "RIFF" &&
                buffer.subarray(8, 12).toString() === "WEBP"
              : false;
    if (!okay)
      throw new BadRequestException("Image content does not match MIME type");
  }

  async uploadUrl(user: User, uploadId: string) {
    await this.owned("uploads", uploadId, user);
    const expires = String(Date.now() + 7 * 86400000);
    const signature = createHmac("sha256", this.key)
      .update(uploadId + ":" + expires)
      .digest("hex");
    return {
      id: uploadId,
      url: `/api/uploads/${uploadId}?expires=${expires}&signature=${signature}`,
    };
  }
  async readSignedUpload(uploadId: string, query: any) {
    const expires = typeof query.expires === "string" ? query.expires : "";
    const signature =
      typeof query.signature === "string" ? query.signature : "";
    const expected = createHmac("sha256", this.key)
      .update(uploadId + ":" + expires)
      .digest("hex");
    if (
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now() ||
      !equal(signature, expected)
    )
      throw new UnauthorizedException("Image link expired");
    const upload = await one(this.db, "uploads", uploadId);
    if (!upload) throw new NotFoundException();
    const user = await one(this.db, "users", upload.ownerId);
    return this.readUpload(user, uploadId);
  }
  async signedUpload(user: User, body: any) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
      throw new BadRequestException("Supabase Storage is not configured");
    const mime = text(body.mime, "mime", 100);
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime))
      throw new BadRequestException("Unsupported image type");
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    );
    const uploadId = randomUUID(),
      storagePath = `${user.id}/${uploadId}`,
      bucket = process.env.SUPABASE_STORAGE_BUCKET || "autoblogger";
    const { data, error } = await client.storage
      .from(bucket)
      .createSignedUploadUrl(storagePath, { upsert: false });
    if (error) throw new BadRequestException("Unable to create upload URL");
    await put(this.db, "uploads", {
      id: uploadId,
      ownerId: user.id,
      storagePath,
      bucket,
      mime,
      createdAt: now(),
    });
    return {
      id: uploadId,
      url: data.signedUrl,
      path: data.path,
      token: data.token,
    };
  }
  uploadReferences(value: any): string[] {
    return [
      ...new Set(
        [
          ...JSON.stringify(value).matchAll(/\/api\/uploads\/([a-f0-9-]{36})/g),
        ].map((x) => x[1]),
      ),
    ];
  }
  async cleanupUploads(user: User, ids: string[]) {
    for (const uploadId of new Set(ids)) {
      const upload = await one(this.db, "uploads", uploadId, user.id);
      if (!upload) continue;
      let used = false;
      for (const table of ["articles", "revisions", "jobs"]) {
        const found = await this.db.query(
          `SELECT id FROM ${table} WHERE owner_id=$1 AND data::text LIKE $2 LIMIT 1`,
          [user.id, "%" + uploadId + "%"],
        );
        if (found.rows.length) {
          used = true;
          break;
        }
      }
      if (used) continue;
      if (upload.filename)
        await unlink(
          path.join(config.dataDir, "uploads", upload.filename),
        ).catch(() => {});
      if (
        upload.storagePath &&
        process.env.SUPABASE_URL &&
        process.env.SUPABASE_SERVICE_ROLE_KEY
      ) {
        const { createClient } = await import("@supabase/supabase-js");
        const { error } = await createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_ROLE_KEY,
        )
          .storage.from(upload.bucket)
          .remove([upload.storagePath]);
        if (error) continue;
      }
      await this.db.query("DELETE FROM uploads WHERE id=$1 AND owner_id=$2", [
        uploadId,
        user.id,
      ]);
    }
  }
  async deleteArticle(
    user: User,
    articleId: string,
    transaction?: Sql,
  ): Promise<{
    deleted: boolean;
    ghostPostsRetained: boolean;
    uploadIds?: string[];
  }> {
    const remove = async (tx: Sql) => {
      const article = await this.owned("articles", articleId, user, tx);
      const revisions = await list(tx, "revisions", user.id, articleId);
      const uploadIds = this.uploadReferences({ article, revisions });
      await tx.query(
        `UPDATE model_runs SET data=(data-'input'-'output') || '{"contentDeleted":true}'::jsonb WHERE owner_id=$1 AND data->>'jobId' IN (SELECT id FROM jobs WHERE owner_id=$1 AND data->>'articleId'=$2)`,
        [user.id, articleId],
      );
      await tx.query(
        `DELETE FROM jobs WHERE owner_id=$1 AND data->>'articleId'=$2`,
        [user.id, articleId],
      );
      for (const table of ["revisions", "evidence", "suggestions", "metrics"])
        await tx.query(
          `DELETE FROM ${table} WHERE parent_id=$1 AND owner_id=$2`,
          [articleId, user.id],
        );
      await tx.query("DELETE FROM articles WHERE id=$1 AND owner_id=$2", [
        articleId,
        user.id,
      ]);
      return uploadIds;
    };
    if (transaction)
      return {
        deleted: true,
        ghostPostsRetained: true,
        uploadIds: await remove(transaction),
      };
    const uploadIds = await this.db.transaction(remove);
    await this.cleanupUploads(user, uploadIds);
    return { deleted: true, ghostPostsRetained: true };
  }
  async deleteSession(user: User, sessionId: string) {
    await this.owned("sessions", sessionId, user);
    return this.db.withAdvisoryLock("source-blob-mutations", async () => {
      const events = (
        await this.db.query(
          "SELECT data FROM events WHERE owner_id=$1 AND session_id=$2",
          [user.id, sessionId],
        )
      ).rows.map((row) => row.data);
      return this.sources.deleteSafely(events, () =>
        this.deleteSessionRecords(user, sessionId),
      );
    });
  }
  private async deleteSessionRecords(user: User, sessionId: string) {
    await this.owned("sessions", sessionId, user);
    const uploadIds: string[] = [];
    await this.db.transaction(async (tx) => {
      for (const article of await list(tx, "articles", user.id, sessionId)) {
        const removed = await this.deleteArticle(user, article.id, tx);
        uploadIds.push(...(removed.uploadIds || []));
      }
      for (const table of ["summaries", "attempts"])
        await tx.query(
          `DELETE FROM ${table} WHERE parent_id=$1 AND owner_id=$2`,
          [sessionId, user.id],
        );
      await tx.query(
        `UPDATE model_runs SET data=(data-'input'-'output') || '{"contentDeleted":true}'::jsonb WHERE owner_id=$1 AND (data->>'sessionId'=$2 OR data->>'jobId' IN (SELECT id FROM jobs WHERE owner_id=$1 AND data->>'sessionId'=$2))`,
        [user.id, sessionId],
      );
      await tx.query(
        `DELETE FROM jobs WHERE owner_id=$1 AND (data->'input'->>'sessionId'=$2)`,
        [user.id, sessionId],
      );
      await tx.query("DELETE FROM sessions WHERE id=$1 AND owner_id=$2", [
        sessionId,
        user.id,
      ]);
      await tx.query(
        `DELETE FROM files WHERE owner_id=$1 AND NOT EXISTS(SELECT 1 FROM events WHERE events.data->>'fileId'=files.id)`,
        [user.id],
      );
    });
    await this.cleanupUploads(user, uploadIds);
    return { deleted: true, ghostPostsRetained: true };
  }
  async deleteProject(user: User, projectId: string) {
    await this.owned("projects", projectId, user);
    for (const session of await list(this.db, "sessions", user.id, projectId))
      await this.deleteSession(user, session.id);
    await this.db.query(
      "DELETE FROM files WHERE parent_id=$1 AND owner_id=$2",
      [projectId, user.id],
    );
    await this.db.query("DELETE FROM projects WHERE id=$1 AND owner_id=$2", [
      projectId,
      user.id,
    ]);
    return { deleted: true, ghostPostsRetained: true };
  }
  async accountExport(user: User) {
    const output: any = { exportedAt: now(), user };
    for (const table of [
      "projects",
      "sessions",
      "files",
      "articles",
      "revisions",
      "evidence",
      "suggestions",
      "model_runs",
      "summaries",
      "attempts",
    ] as Table[])
      output[table] = await list(this.db, table, user.id);
    output.events = (
      await this.db.query(
        "SELECT data FROM events WHERE owner_id=$1 ORDER BY session_id,sequence",
        [user.id],
      )
    ).rows.map((x) => x.data);
    output.events = await Promise.all(
      output.events.map((event: any) => this.sources.hydrate(event, user.id)),
    );
    return output;
  }
  async deleteAccount(user: User, body: any) {
    return this.db.withAdvisoryLock("source-blob-mutations", async () => {
      const events = (
        await this.db.query("SELECT data FROM events WHERE owner_id=$1", [
          user.id,
        ])
      ).rows.map((row) => row.data);
      return this.sources.deleteSafely(events, () =>
        this.deleteAccountRecords(user, body),
      );
    });
  }
  private async deleteAccountRecords(user: User, body: any) {
    if (body.deleteGhostPosts) {
      if (!this.deleteExternal)
        throw new BadRequestException("Ghost deletion unavailable");
      for (const article of await list(this.db, "articles", user.id))
        if (article.publication?.remoteId)
          await this.deleteExternal(user, article);
    }
    for (const upload of await list(this.db, "uploads", user.id)) {
      if (upload.filename)
        await unlink(
          path.join(config.dataDir, "uploads", upload.filename),
        ).catch(() => {});
      if (
        upload.storagePath &&
        process.env.SUPABASE_SERVICE_ROLE_KEY &&
        process.env.SUPABASE_URL
      ) {
        const { createClient } = await import("@supabase/supabase-js");
        const { error } = await createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_ROLE_KEY,
        )
          .storage.from(upload.bucket)
          .remove([upload.storagePath]);
        if (error)
          throw new BadRequestException(
            "Storage deletion failed; account retained for retry",
          );
      }
    }
    await this.db.query("DELETE FROM users WHERE id=$1", [user.id]);
    return {
      deleted: true,
      ghostPostsRetained: !body.deleteGhostPosts,
      backups: "External provider backups follow their retention policy",
    };
  }
  async retention(user: User) {
    this.admin(user);
    return this.db.withAdvisoryLock("source-blob-mutations", async () => {
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      const events = (
        await this.db.query(
          "SELECT data FROM events WHERE data->>'occurredAt'<$1",
          [cutoff],
        )
      ).rows.map((row) => row.data);
      return this.sources.deleteSafely(events, () =>
        this.retentionRecords(user, cutoff),
      );
    });
  }
  private async retentionRecords(user: User, cutoff: string) {
    this.admin(user);
    const old = await this.db.query(
      `SELECT id,session_id FROM events WHERE data->>'occurredAt'<$1`,
      [cutoff],
    );
    const expired = new Set(old.rows.map((x) => x.id));
    await this.db.transaction(async (tx) => {
      for (const row of old.rows)
        await tx.query(`DELETE FROM evidence WHERE data->>'eventId'=$1`, [
          row.id,
        ]);
      await tx.query(`DELETE FROM events WHERE data->>'occurredAt'<$1`, [
        cutoff,
      ]);
      const strip = (blocks: any[]) =>
        blocks.map((b: any) => ({
          ...b,
          review: b.evidenceIds?.some((x: string) => expired.has(x))
            ? "needs_review"
            : b.review,
          evidenceIds: (b.evidenceIds || []).filter(
            (x: string) => !expired.has(x),
          ),
        }));
      for (const sessionId of new Set(old.rows.map((x) => x.session_id))) {
        await tx.query("DELETE FROM summaries WHERE parent_id=$1", [sessionId]);
        await tx.query("DELETE FROM attempts WHERE parent_id=$1", [sessionId]);
        await tx.query(
          `UPDATE model_runs SET data=(data-'input'-'output') || '{"contentDeleted":true}'::jsonb WHERE data->>'sessionId'=$1 OR data->>'jobId' IN (SELECT id FROM jobs WHERE data->>'sessionId'=$1)`,
          [sessionId],
        );
        await tx.query(`DELETE FROM jobs WHERE data->>'sessionId'=$1`, [
          sessionId,
        ]);
        for (const a of await list(tx, "articles", undefined, sessionId)) {
          a.blocks = strip(a.blocks);
          a.version++;
          a.updatedAt = now();
          await put(tx, "articles", a, sessionId);
          for (const revision of await list(tx, "revisions", a.ownerId, a.id)) {
            revision.article.blocks = strip(revision.article.blocks);
            await put(tx, "revisions", revision, a.id);
          }
          await tx.query("DELETE FROM suggestions WHERE parent_id=$1", [a.id]);
        }
      }
      await tx.query(
        `DELETE FROM files WHERE NOT EXISTS(SELECT 1 FROM events WHERE events.data->>'fileId'=files.id) AND NOT EXISTS(SELECT 1 FROM articles WHERE articles.data->>'fileId'=files.id)`,
      );
    });
    return { deletedEvents: old.rows.length, cutoff };
  }
  async settings(user?: User) {
    if (user) this.admin(user);
    return one(this.db, "settings", "ai");
  }
  async updateSettings(user: User, body: any) {
    this.admin(user);
    const previous = await this.settings();
    if (
      body.signupPaused !== undefined &&
      typeof body.signupPaused !== "boolean"
    )
      throw new BadRequestException("signupPaused must be boolean");
    const settings = {
      ...previous,
      id: "ai",
      model:
        body.model === undefined
          ? previous.model
          : text(body.model, "model", 200),
      provider:
        body.provider === undefined
          ? previous.provider
          : text(body.provider, "provider", 100),
      signupPaused:
        body.signupPaused === undefined
          ? Boolean(previous.signupPaused)
          : body.signupPaused,
      updatedAt: now(),
      updatedBy: user.id,
    };
    await put(this.db, "settings", settings);
    return settings;
  }
  async setLimits(user: User, userId: string, body: any) {
    this.admin(user);
    const target = await one(this.db, "users", userId);
    if (!target) throw new NotFoundException();
    for (const field of ["dailyLimit", "monthlyLimit"])
      if (body[field] !== undefined) {
        if (
          typeof body[field] !== "number" ||
          !Number.isFinite(body[field]) ||
          body[field] < 0 ||
          body[field] > 10000
        )
          throw new BadRequestException("Invalid limit");
        target[field] = body[field];
      }
    await put(this.db, "users", target);
    return target;
  }
  async dashboard(user: User) {
    this.admin(user);
    const users = await list(this.db, "users"),
      modelRuns = await list(this.db, "model_runs"),
      jobs = await list(this.db, "jobs");
    const totalCost = modelRuns.reduce((s, x) => s + (x.cost || 0), 0);
    let credit: any = { available: false };
    if (process.env.OPENROUTER_API_KEY)
      try {
        const r = await fetch("https://openrouter.ai/api/v1/key", {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          },
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) {
          const value: any = await r.json();
          credit = {
            available: true,
            limit: value.data.limit,
            remaining: value.data.limit_remaining,
            usage: value.data.usage,
          };
        }
      } catch {}
    const alerts =
      totalCost >= 16
        ? ["테스트 예산의 80% 이상을 사용했습니다."]
        : totalCost >= 10
          ? ["테스트 예산의 50% 이상을 사용했습니다."]
          : [];
    const sessions = await list(this.db, "sessions");
    const completedSessions = new Set(
      (await list(this.db, "metrics"))
        .filter((m) => m.type === "editing_completed")
        .map((m) => m.sessionId),
    ).size;
    const recordedSessions = sessions.length;
    const durations = modelRuns
      .filter((x) => typeof x.durationMs === "number")
      .map((x) => x.durationMs)
      .sort((a, b) => a - b);
    return {
      users: await Promise.all(users.map((u) => this.me(u))),
      modelRuns,
      jobs,
      settings: await this.settings(),
      waitlist: (await list(this.db, "settings")).filter((x) =>
        x.id.startsWith("waitlist:"),
      ),
      credit,
      alerts,
      metrics: {
        completedSessions,
        recordedSessions,
        completionRate: recordedSessions
          ? completedSessions / recordedSessions
          : 0,
        modelCost: totalCost,
        modelCalls: modelRuns.length,
        p95Ms: durations[Math.ceil(durations.length * 0.95) - 1] || 0,
      },
    };
  }
}
