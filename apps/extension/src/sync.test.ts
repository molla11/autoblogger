import { afterEach, describe, expect, it } from "vitest";
import { createServer, Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Journal } from "./journal";
import { syncJournals } from "./sync";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
describe("server synchronization", () => {
  it("replays after a dropped response without duplicating server events and recovers acknowledgement holes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "autoblogger-sync-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    let drop = true,
      requests = 0,
      sessionCreated = 0;
    const received = new Map<number, string>();
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      if (req.headers.authorization !== "Bearer test-token") {
        res.statusCode = 401;
        res.end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      const send = (value: unknown) => res.end(JSON.stringify(value));
      if (req.url === "/api/me") return void send({ id: "owner" });
      if (req.url === "/api/projects" && req.method === "GET")
        return void send([
          { id: "project", rootPath: dir, excludePatterns: [] },
        ]);
      if (req.url === "/api/projects/project/sessions") {
        sessionCreated++;
        return void send({ id: body.id });
      }
      if (req.url === "/api/sessions/session")
        return void send({ session: { recording: true } });
      if (req.url === "/api/sessions/session/events") {
        requests++;
        for (const event of body.events) {
          if (requests === 1 && event.sequence === 2) continue;
          if (received.has(event.sequence))
            expect(received.get(event.sequence)).toBe(event.id);
          received.set(event.sequence, event.id);
        }
        if (drop) {
          drop = false;
          req.socket.destroy();
          return;
        }
        return void send({
          ackThrough: 3,
          received: [...received.keys()],
          gaps: [],
        });
      }
      res.statusCode = 404;
      send({});
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address() as { port: number };
    const apiUrl = `http://127.0.0.1:${address.port}/api`;
    const journal = await Journal.create(dir, {
      schemaVersion: 1,
      id: "session",
      rootPath: dir,
      name: "test",
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      recording: true,
      excludePatterns: [],
    });
    for (let i = 0; i < 3; i++)
      await journal.append({
        type: "memo",
        occurredAt: new Date().toISOString(),
        data: { text: `note ${i}` },
      });
    await expect(
      syncJournals({ apiUrl, token: "test-token", journals: [journal] }),
    ).rejects.toThrow();
    expect(journal.pendingCount()).toBe(3);
    const restored = await Journal.load(journal.directory);
    await syncJournals({ apiUrl, token: "test-token", journals: [restored] });
    expect(restored.pendingCount()).toBe(0);
    expect(received.size).toBe(3);
    expect(sessionCreated).toBe(1);
  });
});
