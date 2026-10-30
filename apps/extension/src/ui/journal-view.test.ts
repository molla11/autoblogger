import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Journal } from "../journal";

it("browses 10,000 events without copying source payloads and preserves ACK holes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "autoblogger-ui-load-"));
  try {
    const manifest = { schemaVersion: 1, id: "large", rootPath: directory, name: "large", startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), recording: false, excludePatterns: [] };
    await writeFile(path.join(directory, "session.json"), JSON.stringify(manifest));
    const rows = Array.from({ length: 10000 }, (_, i) => ({ id: `event-${i}`, sessionId: "large", sequence: i + 1, type: "snapshot", fileId: "file", filePath: "solve.py", occurredAt: manifest.startedAt, data: { content: "# source\n".repeat(128) } }));
    await writeFile(path.join(directory, "events.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const journal = await Journal.load(directory);
    await journal.acknowledge({ ackThrough: 10000, received: [], gaps: [8] }, rows.map(row => row.sequence));
    const memory = process.memoryUsage().heapUsed, start = performance.now();
    const overview = journal.overview();
    const duration = performance.now() - start;
    expect(overview).toHaveLength(10000);
    expect(overview.every(event => !("data" in event))).toBe(true);
    expect(overview.filter(event => !event.acknowledged).map(event => event.sequence)).toEqual([8]);
    const selected = journal.event("event-9999")!;
    selected.data.content = "changed only in UI";
    expect(journal.event("event-9999")!.data.content).toBe(rows[9999].data.content);
    expect(journal.previousSnapshot("file", 10000)?.sequence).toBe(9999);
    console.log(`GUI 10k overview: ${duration.toFixed(1)}ms, heap delta ${((process.memoryUsage().heapUsed-memory)/1024/1024).toFixed(2)}MiB; ${JSON.stringify(overview.slice(0,60)).length} bytes per 60-row page`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
