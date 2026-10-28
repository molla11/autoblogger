import { HttpException } from "@nestjs/common";
import { Database, Sql, one, put, list } from "./db";
import { digest, now } from "./security";
import { SourceBlobStore, SourceRef } from "./source-blobs";

/** Records remain readable through a durable recovery copy until blob deletion commits. */
export class SourceRepository {
  constructor(
    readonly db: Database,
    readonly store: SourceBlobStore,
  ) {}
  backupId(ref: SourceRef) {
    return "source:" + digest(`${ref.storage}:${ref.bucket || ""}:${ref.key}`);
  }
  async hydrate(event: any, ownerId: string, sql: Sql = this.db): Promise<any> {
    if (event.type !== "snapshot" || !event.data?.contentRef) return event;
    const ref: SourceRef = event.data.contentRef;
    this.store.validate(ref, ownerId);
    let content: string;
    try {
      content = await this.store.read(ref, ownerId);
    } catch (error) {
      const backup = await one(
        sql,
        "source_backups",
        this.backupId(ref),
        ownerId,
      );
      if (!backup || digest(backup.content) !== ref.hash) throw error;
      content = backup.content;
    }
    const { contentRef, ...data } = event.data;
    return { ...event, data: { ...data, content } };
  }
  async references(ref: SourceRef): Promise<string[]> {
    const result = await this.db.query(
      `SELECT id FROM events WHERE owner_id=$1 AND data->'data'->'contentRef'->>'key'=$2 AND data->'data'->'contentRef'->>'storage'=$3`,
      [ref.ownerId, ref.key, ref.storage],
    );
    return result.rows.map((row) => row.id);
  }
  async backup(ref: SourceRef, content: string) {
    this.store.validate(ref, ref.ownerId);
    if (digest(content) !== ref.hash)
      throw new Error("Source recovery copy hash mismatch");
    await put(
      this.db,
      "source_backups",
      {
        id: this.backupId(ref),
        ownerId: ref.ownerId,
        ref,
        content,
        createdAt: now(),
      },
      ref.sessionId,
    );
  }
  async discard(ref: SourceRef, content: string) {
    if ((await this.references(ref)).length) return;
    await this.backup(ref, content);
    await this.store.remove(ref, ref.ownerId);
    await this.db.query(
      "DELETE FROM source_backups WHERE id=$1 AND owner_id=$2",
      [this.backupId(ref), ref.ownerId],
    );
  }
  async deleteSafely<T>(
    events: any[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const ids = new Set(events.map((event) => event.id));
    const refs = new Map<string, { ref: SourceRef; event: any }>();
    for (const event of events)
      if (event.type === "snapshot" && event.data?.contentRef) {
        const ref: SourceRef = event.data.contentRef;
        this.store.validate(ref, event.ownerId);
        refs.set(this.backupId(ref), { ref, event });
      }
    const candidates: SourceRef[] = [];
    for (const { ref, event } of refs.values()) {
      if ((await this.references(ref)).some((id) => !ids.has(id))) continue;
      const hydrated = await this.hydrate(event, ref.ownerId);
      await this.backup(ref, hydrated.data.content);
      candidates.push(ref);
    }
    try {
      for (const ref of candidates) await this.store.remove(ref, ref.ownerId);
    } catch {
      throw new HttpException(
        "Source storage deletion failed; records and recovery copies are retained for retry",
        503,
      );
    }
    const result = await operation();
    for (const ref of candidates)
      await this.db.query(
        "DELETE FROM source_backups WHERE id=$1 AND owner_id=$2",
        [this.backupId(ref), ref.ownerId],
      );
    return result;
  }
  async recover() {
    let pending = 0;
    for (const backup of await list(this.db, "source_backups")) {
      try {
        this.store.validate(backup.ref, backup.ownerId);
        if ((await this.references(backup.ref)).length)
          await this.store.restore(backup.ref, backup.ownerId, backup.content);
        else await this.store.remove(backup.ref, backup.ownerId);
        await this.db.query(
          "DELETE FROM source_backups WHERE id=$1 AND owner_id=$2",
          [backup.id, backup.ownerId],
        );
      } catch {
        pending++;
      }
    }
    return { pending };
  }
}
