import { mkdir, open, readFile, rename, readdir, truncate } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { RecordEvent, SessionManifest, SyncAck } from './types';

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temp = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temp,'wx',0o600);
  try { await handle.writeFile(JSON.stringify(value,null,2)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp,file);
}

/** Append-only events are kept after acknowledgement so export never loses local history. */
export class Journal {
  private events: RecordEvent[] = [];
  private received = new Set<number>();
  private serial: Promise<unknown> = Promise.resolve();
  private constructor(readonly directory: string, public manifest: SessionManifest) {}

  static async create(storage: string, manifest: SessionManifest): Promise<Journal> {
    const directory = path.join(storage,manifest.id);
    await mkdir(directory,{recursive:true,mode:0o700});
    await atomicJson(path.join(directory,'session.json'),manifest);
    return new Journal(directory,manifest);
  }

  static async load(directory: string): Promise<Journal> {
    const manifest = JSON.parse(await readFile(path.join(directory,'session.json'),'utf8')) as SessionManifest;
    if (manifest.schemaVersion !== 1 || !manifest.id || typeof manifest.rootPath !== 'string') throw new Error('Unsupported session journal');
    const journal = new Journal(directory,manifest);
    let raw = Buffer.alloc(0);
    try { raw = await readFile(path.join(directory,'events.jsonl')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const lastNewline = raw.lastIndexOf(10);
    // A killed process can leave a partial last append. Preserve it, then recover only committed complete lines.
    if (raw.length && lastNewline !== raw.length - 1) {
      const recovery = await open(path.join(directory,`recovery-${Date.now()}.partial`),'wx',0o600);
      try { await recovery.writeFile(raw.subarray(lastNewline + 1)); await recovery.sync(); } finally { await recovery.close(); }
      await truncate(path.join(directory,'events.jsonl'),lastNewline + 1);
      raw = raw.subarray(0,lastNewline + 1);
    }
    for (const line of raw.toString('utf8').split('\n').filter(Boolean)) {
      const event = JSON.parse(line) as RecordEvent;
      if (event.sessionId !== manifest.id || event.sequence !== journal.events.length + 1) throw new Error('Session journal sequence mismatch; original retained');
      journal.events.push(event);
    }
    try {
      const state = JSON.parse(await readFile(path.join(directory,'ack.json'),'utf8'));
      if (!Array.isArray(state.received)) throw new Error('Invalid acknowledgement state');
      journal.received = new Set(state.received.filter((n: unknown) => Number.isInteger(n) && Number(n) > 0 && Number(n) <= journal.events.length));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return journal;
  }

  static async list(storage: string): Promise<Journal[]> {
    await mkdir(storage,{recursive:true,mode:0o700});
    const entries = await readdir(storage,{withFileTypes:true});
    const journals: Journal[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try { journals.push(await Journal.load(path.join(storage,entry.name))); }
      catch (error) { throw new Error(`Cannot recover session ${entry.name}: ${(error as Error).message}`); }
    }
    return journals.sort((a,b) => a.manifest.startedAt.localeCompare(b.manifest.startedAt));
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => undefined);
    return next;
  }

  append(event: Omit<RecordEvent,'id'|'sessionId'|'sequence'>): Promise<RecordEvent> {
    return this.exclusive(async () => {
      const full = {...event,id:randomUUID(),sessionId:this.manifest.id,sequence:this.events.length + 1};
      const handle = await open(path.join(this.directory,'events.jsonl'),'a',0o600);
      try { await handle.writeFile(JSON.stringify(full) + '\n'); await handle.sync(); } finally { await handle.close(); }
      this.events.push(full);
      return full;
    });
  }

  update(patch: Partial<SessionManifest>): Promise<void> {
    return this.exclusive(async () => {
      const next = {...this.manifest,...patch};
      await atomicJson(path.join(this.directory,'session.json'),next);
      this.manifest = next;
    });
  }

  all(): RecordEvent[] { return structuredClone(this.events); }
  pending(limit = 100, maxBytes = 2 * 1024 * 1024): RecordEvent[] {
    const result: RecordEvent[] = []; let bytes = 0;
    for (const event of this.events) {
      if (this.received.has(event.sequence)) continue;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (result.length && (result.length >= limit || bytes + size > maxBytes)) break;
      result.push(structuredClone(event)); bytes += size;
    }
    return result;
  }
  pendingCount(): number { return this.events.length - this.received.size; }

  acknowledge(ack: SyncAck, sent: number[]): Promise<void> {
    return this.exclusive(async () => {
      if (!Number.isInteger(ack.ackThrough) || ack.ackThrough < 0 || ack.ackThrough > this.events.length ||
        !Array.isArray(ack.received) || !Array.isArray(ack.gaps)) throw new Error('Invalid server acknowledgement');
      const next = new Set(this.received);
      for (const sequence of sent) {
        if (!Number.isInteger(sequence) || sequence < 1 || sequence > this.events.length) throw new Error('Invalid sent sequence');
        if (!ack.gaps.includes(sequence) && (sequence <= ack.ackThrough || ack.received.includes(sequence))) next.add(sequence);
      }
      // Any explicit server gap must be retried, even if an earlier reply acknowledged it.
      for (const gap of ack.gaps) next.delete(gap);
      await atomicJson(path.join(this.directory,'ack.json'),{received:[...next].sort((a,b) => a - b)});
      this.received = next;
    });
  }
}
