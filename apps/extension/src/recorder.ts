import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Journal, atomicJson } from "./journal";
import {
  BoundedOutput,
  eligiblePath,
  globMatches,
  hash,
  MAX_FILE_BYTES,
  readSafeText,
  redact,
  withinRoot,
} from "./safety";
import { parseCommand, ParsedCommand, runStatus } from "./parser";
import { RecordEvent } from "./types";

export interface RunContext {
  executionId: string;
  parsed: ParsedCommand;
  command: string;
  cwd: string;
  startedAt: string;
  snapshotId?: string;
  filePath?: string;
  inputSnapshot?: { path: string; content: string; hash: string };
}

export function textDiff(before: string, after: string): string {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === a.length && start === b.length) return "";
  return [
    `@@ -${start + 1},${endA - start} +${start + 1},${endB - start} @@`,
    ...a.slice(start, endA).map((line) => "-" + line),
    ...b.slice(start, endB).map((line) => "+" + line),
  ].join("\n");
}

export class Recorder {
  private snapshots = new Map<string, string>();
  private builds = new Map<string, { snapshotId: string; filePath: string }>();
  private pendingRuns = new Map<string, RunContext>();
  private serial: Promise<unknown> = Promise.resolve();
  constructor(readonly journal: Journal) {
    for (const event of journal.all()) {
      if (event.type === "snapshot" && event.filePath)
        this.snapshots.set(event.filePath + ":" + event.data.hash, event.id);
      if (
        event.type === "run" &&
        ((event.data.kind === "compile" && event.data.status === "success") ||
          (event.data.kind === "compile_run" &&
            ["success", "runtime_error"].includes(
              String(event.data.status),
            ))) &&
        event.data.executable &&
        event.data.snapshotId &&
        event.filePath
      ) {
        this.builds.set(String(event.data.cwd) + ":" + event.data.executable, {
          snapshotId: String(event.data.snapshotId),
          filePath: event.filePath,
        });
      }
    }
  }

  /** Persisting the start separately lets a killed extension host recover an unknown-ended run honestly. */
  async recoverInterruptedRuns(): Promise<void> {
    let pending: RunContext[];
    try {
      pending = JSON.parse(
        await readFile(
          path.join(this.journal.directory, "pending-runs.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!Array.isArray(pending)) throw new Error("Invalid pending run journal");
    for (const context of pending)
      this.pendingRuns.set(context.executionId, context);
    for (const context of pending) {
      if (!context.executionId || !context.parsed || !context.startedAt)
        throw new Error("Invalid pending run journal");
      if (
        !this.journal
          .all()
          .some(
            (event) =>
              event.type === "run" &&
              event.data.executionId === context.executionId,
          )
      ) {
        await this.endRun(
          context,
          undefined,
          "[extension host restarted before execution ended; output unavailable]",
        );
      } else this.pendingRuns.delete(context.executionId);
    }
    this.pendingRuns.clear();
    await atomicJson(
      path.join(this.journal.directory, "pending-runs.json"),
      [],
    );
  }

  static async start(
    storage: string,
    rootPath: string,
    excludes: string[],
  ): Promise<Recorder> {
    const now = new Date().toISOString();
    const journal = await Journal.create(storage, {
      schemaVersion: 1,
      id: randomUUID(),
      rootPath: path.resolve(rootPath),
      name: path.basename(rootPath),
      startedAt: now,
      lastActivityAt: now,
      recording: true,
      excludePatterns: excludes,
    });
    const recorder = new Recorder(journal);
    await journal.append({
      type: "session_start",
      occurredAt: now,
      data: { rootPath: redact(rootPath) },
    });
    await recorder.initialSnapshots();
    return recorder;
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn);
    this.serial = next.catch(() => undefined);
    return next;
  }
  eligible(file: string): boolean {
    return eligiblePath(
      this.journal.manifest.rootPath,
      path.resolve(file),
      this.journal.manifest.excludePatterns,
    );
  }
  private fileFields(file: string): { fileId: string; filePath: string } {
    const relative = path
      .relative(this.journal.manifest.rootPath, file)
      .split(path.sep)
      .join("/");
    return {
      fileId: hash(this.journal.manifest.id + ":" + relative).slice(0, 32),
      filePath: relative,
    };
  }
  private async activity(occurredAt = new Date().toISOString()): Promise<void> {
    await this.journal.update({ lastActivityAt: occurredAt });
  }

  private async snapshotText(
    file: string,
    content: string,
    occurredAt: string,
    documentVersion?: number,
  ): Promise<RecordEvent | undefined> {
    if (!this.eligible(file)) return undefined;
    const fields = this.fileFields(file),
      digest = hash(content);
    const existing = this.snapshots.get(fields.filePath + ":" + digest);
    if (existing)
      return this.journal.all().find((event) => event.id === existing);
    const event = await this.journal.append({
      type: "snapshot",
      occurredAt,
      documentVersion,
      ...fields,
      data: { content, hash: digest },
    });
    this.snapshots.set(fields.filePath + ":" + digest, event.id);
    return event;
  }

  async initialSnapshots(): Promise<void> {
    const root = this.journal.manifest.rootPath;
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const relative = path
          .relative(root, absolute)
          .split(path.sep)
          .join("/");
        if (entry.isSymbolicLink()) continue;
        if (
          this.journal.manifest.excludePatterns.some(
            (glob) =>
              globMatches(glob, relative) || globMatches(glob, relative + "/"),
          )
        )
          continue;
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile() && this.eligible(absolute))
          await this.snapshot(absolute);
      }
    };
    await visit(root);
  }

  snapshot(file: string, version?: number): Promise<RecordEvent | undefined> {
    const occurredAt = new Date().toISOString();
    const disk = readSafeText(this.journal.manifest.rootPath, file);
    return this.serially(async () => {
      if (!this.journal.manifest.recording || !this.eligible(file))
        return undefined;
      const content = await disk;
      if (content === undefined) return undefined;
      await this.activity(occurredAt);
      return this.snapshotText(file, content, occurredAt, version);
    });
  }

  edit(
    file: string,
    before: string,
    after: string,
    version: number,
    unknown: boolean,
  ): Promise<void> {
    const occurredAt = new Date().toISOString();
    return this.serially(async () => {
      if (
        !this.journal.manifest.recording ||
        !this.eligible(file) ||
        Buffer.byteLength(after) > MAX_FILE_BYTES ||
        Buffer.byteLength(before) > MAX_FILE_BYTES ||
        after.includes("\0")
      )
        return;
      before = redact(before);
      after = redact(after);
      if (before === after) return;
      let data: Record<string, unknown> = {
        before,
        after,
        diff: textDiff(before, after),
        source: unknown ? "unknown" : "direct",
      };
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_FILE_BYTES) {
        const diff = new BoundedOutput();
        diff.append(String(data.diff));
        data = {
          diff: diff.value(),
          source: "unknown",
          truncated: true,
          beforeHash: hash(before),
          afterHash: hash(after),
          reason: "Large edit; full saved content remains in snapshots",
        };
      }
      await this.journal.append({
        type: "edit",
        occurredAt,
        documentVersion: version,
        ...this.fileFields(file),
        data,
      });
      await this.activity(occurredAt);
    });
  }

  memo(
    file: string | undefined,
    text: string,
    line?: number,
    bookmark = false,
  ): Promise<void> {
    return this.serially(async () => {
      if (!this.journal.manifest.recording) return;
      if (file && !this.eligible(file))
        throw new Error("메모는 기록 대상 파일에만 연결할 수 있습니다.");
      const occurredAt = new Date().toISOString();
      await this.journal.append({
        type: "memo",
        occurredAt,
        ...(file ? this.fileFields(file) : {}),
        data: { text: redact(text).slice(0, 16384), line, bookmark },
      });
      await this.activity(occurredAt);
    });
  }

  beginRun(command: string, cwd: string): Promise<RunContext | undefined> {
    const startedAt = new Date().toISOString();
    const parsed = parseCommand(command, cwd);
    if (
      !parsed ||
      !this.journal.manifest.recording ||
      !withinRoot(this.journal.manifest.rootPath, cwd)
    )
      return Promise.resolve(undefined);
    // Start the disk read immediately, before durable journal writes or any terminal-end callback.
    const disk = parsed.source
      ? readSafeText(this.journal.manifest.rootPath, parsed.source)
      : Promise.resolve(undefined);
    const input = parsed.input
      ? readSafeText(this.journal.manifest.rootPath, parsed.input, true)
      : Promise.resolve(undefined);
    return this.serially(async () => {
      const context: RunContext = {
        executionId: randomUUID(),
        parsed,
        command: redact(command),
        cwd,
        startedAt,
      };
      if (parsed.source) {
        const content = await disk;
        if (content === undefined || !this.eligible(parsed.source))
          return undefined;
        const event = await this.snapshotText(
          parsed.source,
          content,
          startedAt,
        );
        context.snapshotId = event?.id;
        context.filePath = parsed.source;
      } else if (parsed.executable) {
        const build = this.builds.get(cwd + ":" + parsed.executable);
        if (build) {
          context.snapshotId = build.snapshotId;
          context.filePath = path.resolve(
            this.journal.manifest.rootPath,
            build.filePath,
          );
        }
      }
      const inputText = await input;
      if (parsed.input && inputText !== undefined)
        context.inputSnapshot = {
          path: path.relative(this.journal.manifest.rootPath, parsed.input),
          content: inputText,
          hash: hash(inputText),
        };
      this.pendingRuns.set(context.executionId, context);
      await atomicJson(path.join(this.journal.directory, "pending-runs.json"), [
        ...this.pendingRuns.values(),
      ]);
      await this.activity(startedAt);
      return context;
    });
  }

  endRun(
    context: RunContext,
    exitCode: number | undefined,
    output: string,
  ): Promise<void> {
    return this.serially(async () => {
      const endedAt = new Date().toISOString();
      const result = runStatus(context.parsed.kind, exitCode, output);
      // A combined && command classified as a runtime error still produced the executable.
      if (
        context.parsed.executable &&
        context.snapshotId &&
        context.filePath &&
        ((context.parsed.kind === "compile" && exitCode === 0) ||
          (context.parsed.kind === "compile_run" &&
            ["success", "runtime_error"].includes(result.status)))
      ) {
        this.builds.set(context.cwd + ":" + context.parsed.executable, {
          snapshotId: context.snapshotId,
          filePath: this.fileFields(context.filePath).filePath,
        });
      }
      await this.journal.append({
        type: "run",
        occurredAt: context.startedAt,
        ...(context.filePath ? this.fileFields(context.filePath) : {}),
        data: {
          executionId: context.executionId,
          command: context.command,
          cwd: redact(context.cwd),
          kind: context.parsed.kind,
          ...result,
          exitCode: exitCode ?? null,
          output: redact(output),
          startedAt: context.startedAt,
          endedAt,
          durationMs: Math.max(
            0,
            Date.parse(endedAt) - Date.parse(context.startedAt),
          ),
          snapshotId: context.snapshotId ?? null,
          inputSnapshot: context.inputSnapshot,
          executable: context.parsed.executable
            ? redact(context.parsed.executable)
            : undefined,
          linkage: context.snapshotId ? "observed" : "unavailable",
        },
      });
      this.pendingRuns.delete(context.executionId);
      await atomicJson(path.join(this.journal.directory, "pending-runs.json"), [
        ...this.pendingRuns.values(),
      ]);
      await this.activity(endedAt);
    });
  }

  stop(reason: "manual" | "idle" | "remote" = "manual"): Promise<void> {
    return this.serially(async () => {
      if (!this.journal.manifest.recording) return;
      const endedAt = new Date().toISOString();
      await this.journal.append({
        type: "session_stop",
        occurredAt: endedAt,
        data: { reason },
      });
      await this.journal.update({ recording: false, endedAt });
    });
  }
}
