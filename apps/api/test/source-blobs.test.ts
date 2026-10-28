import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiService, User } from "../src/service";
import { SourceBlobStore, SourceRemote, SourceRef } from "../src/source-blobs";
import { list } from "../src/db";
class FakeRemote implements SourceRemote {
  objects = new Map<string, Uint8Array>();
  failWrite = false;
  failRemoveAt = 0;
  removes = 0;
  async write(bucket: string, key: string, content: Uint8Array) {
    if (this.failWrite) throw new Error("offline");
    this.objects.set(bucket + ":" + key, new Uint8Array(content));
  }
  async read(bucket: string, key: string) {
    const data = this.objects.get(bucket + ":" + key);
    if (!data) throw new Error("not found");
    return data;
  }
  async remove(bucket: string, key: string) {
    this.removes++;
    if (this.failRemoveAt === this.removes) throw new Error("remove offline");
    this.objects.delete(bucket + ":" + key);
  }
}
const instances: ApiService[] = [],
  roots: string[] = [];
afterEach(async () => {
  for (const api of instances.splice(0)) await api.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup(remote?: FakeRemote) {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoblogger-sources-"));
  roots.push(root);
  const store = new SourceBlobStore(
    root,
    remote ? { mode: "supabase", bucket: "private-sources", remote } : {},
  );
  const api = await new ApiService({ sourceStore: store }).init("memory://");
  instances.push(api);
  const user = await api.userByEmail("source@local.test");
  const project = await api.createProject(user, { name: "sources" });
  const session = await api.createSession(user, project.id, {
    id: "../../client-controlled/session",
  });
  return { api, user, session, store, root };
}
function snapshot(
  sessionId: string,
  sequence: number,
  content = "print(1)",
  occurredAt = new Date().toISOString(),
) {
  return {
    id: randomUUID(),
    sessionId,
    sequence,
    type: "snapshot",
    filePath: "code.py",
    occurredAt,
    data: { content, hash: "client hash is recalculated" },
  };
}
async function rawRef(api: ApiService, eventId: string): Promise<SourceRef> {
  const row = (
    await api.db.query("SELECT data FROM events WHERE id=$1", [eventId])
  ).rows[0].data;
  expect(row.data).not.toHaveProperty("content");
  return row.data.contentRef;
}
describe("source blob persistence", () => {
  it("stores local source bytes under hashed paths and hydrates session/export with idempotent ack", async () => {
    const { api, user, session, root } = await setup();
    const event = snapshot(session.id, 1);
    await api.ingest(user, session.id, { events: [event] });
    const ref = await rawRef(api, event.id);
    expect(ref.key).not.toContain("client-controlled");
    expect(ref.key).not.toContain("..");
    expect(await readFile(path.join(root, ref.key), "utf8")).toBe("print(1)");
    expect((await api.session(user, session.id)).events[0].data.content).toBe(
      "print(1)",
    );
    expect((await api.accountExport(user)).events[0].data.content).toBe(
      "print(1)",
    );
    expect(
      await api.ingest(user, session.id, { events: [event] }),
    ).toMatchObject({ ackThrough: 1, received: [1] });
    await api.deleteSession(user, session.id);
    await expect(readFile(path.join(root, ref.key))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rejects supplied references and traversal, and enforces blob ownership", async () => {
    const { api, user, session, store } = await setup();
    const event = snapshot(session.id, 1);
    await expect(
      api.ingest(user, session.id, {
        events: [
          {
            ...event,
            data: { ...event.data, contentRef: { key: "../../secret" } },
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await api.ingest(user, session.id, { events: [event] });
    const ref = await rawRef(api, event.id);
    await expect(
      store.read({ ...ref, key: "../../secret" }, user.id),
    ).rejects.toMatchObject({ status: 400 });
    await expect(store.read(ref, "other-owner")).rejects.toMatchObject({
      status: 403,
    });
  });
  it("keeps PostgreSQL records empty if blob upload fails and permits retry", async () => {
    const remote = new FakeRemote(),
      { api, user, session } = await setup(remote);
    remote.failWrite = true;
    const event = snapshot(session.id, 1);
    await expect(
      api.ingest(user, session.id, { events: [event] }),
    ).rejects.toThrow("offline");
    expect((await api.session(user, session.id)).events).toEqual([]);
    remote.failWrite = false;
    await api.ingest(user, session.id, { events: [event] });
    expect(remote.objects.size).toBe(1);
    expect((await api.session(user, session.id)).events[0].data.content).toBe(
      "print(1)",
    );
  });
  it("retains readable originals after partial remote deletion failure and cleans up on retry", async () => {
    const remote = new FakeRemote(),
      { api, user, session } = await setup(remote);
    const events = [
      snapshot(session.id, 1, "print(1)"),
      snapshot(session.id, 2, "print(2)"),
    ];
    await api.ingest(user, session.id, { events });
    remote.failRemoveAt = 2;
    await expect(api.deleteSession(user, session.id)).rejects.toMatchObject({
      status: 503,
    });
    expect(remote.objects.size).toBe(1);
    expect(
      (await api.session(user, session.id)).events.map((e) => e.data.content),
    ).toEqual(["print(1)", "print(2)"]);
    expect(await list(api.db, "source_backups", user.id)).toHaveLength(2);
    expect(await api.ingest(user, session.id, { events })).toMatchObject({
      ackThrough: 2,
    });
    remote.failRemoveAt = 0;
    await api.deleteSession(user, session.id);
    expect(remote.objects.size).toBe(0);
    expect(await list(api.db, "source_backups", user.id)).toHaveLength(0);
  });
  it("recovers deleted bytes when the metadata deletion transaction did not finish", async () => {
    const remote = new FakeRemote(),
      { api, user, session } = await setup(remote);
    const event = snapshot(session.id, 1);
    await api.ingest(user, session.id, { events: [event] });
    const raw = (
      await api.db.query("SELECT data FROM events WHERE id=$1", [event.id])
    ).rows[0].data;
    await expect(
      api.sources.deleteSafely([raw], async () => {
        throw new Error("database rollback");
      }),
    ).rejects.toThrow("database rollback");
    expect(remote.objects.size).toBe(0);
    expect((await api.session(user, session.id)).events[0].data.content).toBe(
      "print(1)",
    );
    expect(await api.sources.recover()).toEqual({ pending: 0 });
    expect(remote.objects.size).toBe(1);
    expect(await list(api.db, "source_backups", user.id)).toHaveLength(0);
  });
  it("retention preserves a deduplicated blob still referenced by a recent snapshot", async () => {
    const remote = new FakeRemote(),
      { api, user, session } = await setup(remote);
    const old = snapshot(session.id, 1, "same", "2020-01-01T00:00:00.000Z"),
      recent = snapshot(session.id, 2, "same");
    await api.ingest(user, session.id, { events: [old, recent] });
    expect(remote.objects.size).toBe(1);
    const admin = await api.userByEmail("admin@local.test");
    await api.retention(admin);
    expect(remote.objects.size).toBe(1);
    expect((await api.session(user, session.id)).events[0].data.content).toBe(
      "same",
    );
    await api.deleteAccount(user, {});
    expect(remote.objects.size).toBe(0);
  });
  it("still reads legacy inline snapshots without migrating them implicitly", async () => {
    const { api, user, session } = await setup();
    const event = {
      ...snapshot(session.id, 1),
      ownerId: user.id,
      receivedAt: new Date().toISOString(),
    };
    await api.db.query(
      "INSERT INTO events(id,owner_id,session_id,sequence,data) VALUES($1,$2,$3,$4,$5)",
      [event.id, user.id, session.id, 1, JSON.stringify(event)],
    );
    expect((await api.session(user, session.id)).events[0].data.content).toBe(
      "print(1)",
    );
  });
});
