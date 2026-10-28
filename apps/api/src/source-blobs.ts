import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { BadRequestException, ForbiddenException } from "@nestjs/common";

export type SourceRef = {
  storage: "local" | "supabase";
  ownerId: string;
  sessionId: string;
  hash: string;
  bytes: number;
  key: string;
  bucket?: string;
};
export interface SourceRemote {
  write(bucket: string, key: string, content: Uint8Array): Promise<void>;
  read(bucket: string, key: string): Promise<Uint8Array>;
  remove(bucket: string, key: string): Promise<void>;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class SupabaseSourceRemote implements SourceRemote {
  private async bucket(name: string) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
      throw new Error("Supabase source storage credentials are not configured");
    const { createClient } = await import("@supabase/supabase-js");
    return createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { persistSession: false },
      },
    ).storage.from(name);
  }
  async write(bucket: string, key: string, content: Uint8Array) {
    const { error } = await (
      await this.bucket(bucket)
    ).upload(key, content, {
      upsert: true,
      contentType: "text/plain; charset=utf-8",
    });
    if (error) throw new Error("Source blob upload failed");
  }
  async read(bucket: string, key: string) {
    const { data, error } = await (await this.bucket(bucket)).download(key);
    if (error || !data) throw new Error("Source blob download failed");
    if (data.size > 1048576)
      throw new Error("Source blob exceeds maximum size");
    return new Uint8Array(await data.arrayBuffer());
  }
  async remove(bucket: string, key: string) {
    const { error } = await (await this.bucket(bucket)).remove([key]);
    if (error) throw new Error("Source blob deletion failed");
  }
}
export class SourceBlobStore {
  readonly mode: "local" | "supabase";
  readonly bucket: string;
  constructor(
    readonly root: string,
    options: {
      mode?: "local" | "supabase";
      bucket?: string;
      remote?: SourceRemote;
    } = {},
  ) {
    this.mode = options.mode || "local";
    this.bucket = options.bucket || "autoblogger-sources";
    this.remote = options.remote || new SupabaseSourceRemote();
  }
  private remote: SourceRemote;
  ref(ownerId: string, sessionId: string, content: string): SourceRef {
    const digest = hash(content);
    return {
      storage: this.mode,
      ownerId,
      sessionId,
      hash: digest,
      bytes: Buffer.byteLength(content),
      key: `sources/${hash(ownerId)}/${hash(sessionId)}/${digest}.txt`,
      ...(this.mode === "supabase" ? { bucket: this.bucket } : {}),
    };
  }
  validate(ref: SourceRef, ownerId: string) {
    if (ref.ownerId !== ownerId)
      throw new ForbiddenException("Source blob belongs to another account");
    if (
      !["local", "supabase"].includes(ref.storage) ||
      !/^[a-f0-9]{64}$/.test(ref.hash) ||
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 0 ||
      ref.bytes > 1048576 ||
      ref.key !==
        `sources/${hash(ownerId)}/${hash(ref.sessionId)}/${ref.hash}.txt` ||
      (ref.storage === "supabase" &&
        (!ref.bucket || !/^[a-zA-Z0-9_-]{1,100}$/.test(ref.bucket)))
    )
      throw new BadRequestException("Invalid source blob reference");
  }
  async write(
    ownerId: string,
    sessionId: string,
    content: string,
  ): Promise<SourceRef> {
    const ref = this.ref(ownerId, sessionId, content);
    await this.restore(ref, ownerId, content);
    return ref;
  }
  async restore(ref: SourceRef, ownerId: string, content: string) {
    this.validate(ref, ownerId);
    if (hash(content) !== ref.hash || Buffer.byteLength(content) !== ref.bytes)
      throw new Error("Source content hash mismatch");
    if (ref.storage === "supabase")
      return this.remote.write(ref.bucket!, ref.key, Buffer.from(content));
    const target = path.join(this.root, ref.key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = target + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async read(ref: SourceRef, ownerId: string): Promise<string> {
    this.validate(ref, ownerId);
    const data =
      ref.storage === "supabase"
        ? Buffer.from(await this.remote.read(ref.bucket!, ref.key))
        : await readFile(path.join(this.root, ref.key));
    if (
      data.byteLength !== ref.bytes ||
      hash(data.toString("utf8")) !== ref.hash
    )
      throw new Error("Source content hash mismatch");
    return data.toString("utf8");
  }
  async remove(ref: SourceRef, ownerId: string) {
    this.validate(ref, ownerId);
    if (ref.storage === "supabase")
      return this.remote.remove(ref.bucket!, ref.key);
    await unlink(path.join(this.root, ref.key)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
