import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { OpenRouterClient, ModelError } from "./openrouter";
import { AiService, groupAttempts } from "./pipeline";
import {
  GhostClient,
  cleanGhostLexical,
  ghostFingerprint,
  isPublicAddress,
  validateExternalUrl,
} from "./ghost";
import {
  blocksToLexical,
  blocksToMarkdown,
  type ArticleBlock,
  type RecordEvent,
  type ModelRun,
} from "@autoblogger/shared";
const settings = { model: "openai/gpt-6.1-terra", provider: "Azure" };
const schema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
const params = {
  task: "test",
  input: { code: "untrusted" },
  system: "test",
  settings,
  schema,
  validate: (v: any) => {
    if (typeof v.text !== "string") throw new Error("invalid");
    return v;
  },
};
const ok = (content: unknown, provider = "Azure") =>
  new Response(
    JSON.stringify({
      provider,
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { cost: 0.001, prompt_tokens: 5, completion_tokens: 3 },
    }),
  );
describe("OpenRouter enforcement and accounting", () => {
  it("pins provider, denies data collection and records actual cost", async () => {
    let request: any;
    const runs: ModelRun[] = [];
    const client = new OpenRouterClient({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        request = JSON.parse(init!.body as string);
        return ok({ text: "ok" });
      },
      onModelRun: (r) => {
        runs.push(r);
      },
    });
    const result = await client.complete(params);
    expect(request.model).toBe(settings.model);
    expect(request.provider).toEqual({
      only: ["azure/eu"],
      order: ["azure/eu"],
      allow_fallbacks: false,
      data_collection: "deny",
      require_parameters: true,
    });
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(result.data.text).toBe("ok");
    expect(runs[0].cost).toBe(0.001);
    expect(result.runs).toHaveLength(1);
  });
  it("never retries or silently falls back for unsupported provider", async () => {
    let calls = 0;
    const runs: ModelRun[] = [];
    const client = new OpenRouterClient({
      apiKey: "test",
      fetch: async () => {
        calls++;
        return new Response(
          JSON.stringify({ error: { message: "No endpoints" } }),
          { status: 404 },
        );
      },
      onModelRun: (r) => {
        runs.push(r);
      },
    });
    await expect(client.complete(params)).rejects.toThrow("404");
    expect(calls).toBe(1);
    expect(runs[0].status).toBe("failed");
  });
  it("rejects unexpected provider and malformed structured output", async () => {
    const client = new OpenRouterClient({
      apiKey: "test",
      fetch: async () => ok({ text: "ok" }, "OpenAI"),
    });
    await expect(client.complete(params)).rejects.toMatchObject({
      code: "PROVIDER_MISMATCH",
    });
    const invalid = new OpenRouterClient({
      apiKey: "test",
      fetch: async () => ok({ wrong: true }),
    });
    await expect(invalid.complete(params)).rejects.toThrow("invalid");
  });
  it("consumes fragmented SSE comments and final usage without leaking stream directives", async () => {
    const text =
      ": heartbeat\n\ndata: " +
      JSON.stringify({
        provider: "Azure",
        choices: [{ delta: { content: '{"text":"' } }],
      }) +
      "\n\ndata: " +
      JSON.stringify({ choices: [{ delta: { content: '안녕"}' } }] }) +
      "\n\ndata: " +
      JSON.stringify({
        usage: { cost: 0.003, prompt_tokens: 7, completion_tokens: 8 },
        choices: [],
      }) +
      "\n\ndata: [DONE]\n";
    const bytes = new TextEncoder().encode(text);
    let deltas = "";
    const client = new OpenRouterClient({
      apiKey: "test",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < bytes.length; i += 7)
                c.enqueue(bytes.slice(i, i + 7));
              c.close();
            },
          }),
        ),
    });
    const result = await client.complete({
      ...params,
      onDelta: (d) => {
        deltas += d;
      },
    });
    expect(result.data.text).toBe("안녕");
    expect(deltas).toBe('{"text":"안녕"}');
    expect(result.runs[0].cost).toBe(0.003);
  });
  it("honors pre-cancellation without making any request", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: "test",
      fetch: async () => {
        calls++;
        return ok({ text: "bad" });
      },
    });
    await expect(
      client.complete({ ...params, signal: AbortSignal.abort() }),
    ).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
});
describe("evidence and export", () => {
  const event: RecordEvent = {
    id: "e1",
    sessionId: "s",
    sequence: 1,
    type: "snapshot",
    fileId: "f",
    occurredAt: new Date().toISOString(),
    data: { content: "int main() {}" },
  };
  it("never verifies unsupported or nonexistent evidence despite model opinion", async () => {
    const ai = new AiService({
      apiKey: "test",
      fetch: async () =>
        ok({
          reviews: [
            { id: "b1", status: "supported", reason: "yes" },
            { id: "b2", status: "supported", reason: "yes" },
          ],
        }),
    });
    const blocks: ArticleBlock[] = [
      {
        id: "b1",
        type: "paragraph",
        text: "Accepted",
        evidenceIds: [],
        review: "needs_review",
      },
      {
        id: "b2",
        type: "paragraph",
        text: "Accepted",
        evidenceIds: ["fake"],
        review: "needs_review",
      },
    ];
    const result = await ai.verify({ events: [event], blocks, settings });
    expect(result.blocks.every((b) => b.review === "needs_review")).toBe(true);
  });
  it("groups attempts separately by file and respects recorded run snapshot", () => {
    const events: RecordEvent[] = [
      event,
      {
        ...event,
        id: "e2",
        sequence: 2,
        type: "run",
        data: { snapshotId: "e1", status: "normal_exit" },
      },
      { ...event, id: "e3", sequence: 3 },
    ];
    const attempts = groupAttempts(events);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].snapshotId).toBe("e1");
    expect(attempts[1].status).toBe("unexecuted");
  });
  it("preserves code containing fences and escapes HTML export", () => {
    const b: ArticleBlock = {
      id: "b",
      type: "code",
      text: "```\n<script>x()</script>",
      language: "cpp",
      evidenceIds: [],
      review: "needs_review",
    };
    expect(blocksToMarkdown([b])).toContain("````cpp");
    expect(JSON.stringify(blocksToLexical([b]))).toContain("&lt;script&gt;");
  });
});
describe("Ghost boundary", () => {
  it("rejects loopback, private, mapped IPv6 and redirects before authenticated requests", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "2001:db8::1",
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    await expect(
      validateExternalUrl("http://127.0.0.1"),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      validateExternalUrl("https://127.0.0.1"),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      validateExternalUrl("https://a:b@example.com"),
    ).rejects.toBeInstanceOf(Error);
  });
  it("strips app metadata and malicious HTML before export", () => {
    const result = cleanGhostLexical({
      root: {
        type: "root",
        blockId: "private",
        children: [
          {
            type: "html",
            html: '<script>x()</script><img src="https://example.com/a" onerror="x()"><p>Hello</p>',
            evidenceIds: ["secret"],
          },
          { type: "evidence", text: "private" },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/onerror|script|secret|private/);
    expect(result.root.children).toHaveLength(1);
  });
  it("reconciles lost creates and refuses remote changes", async () => {
    let post: any = null;
    let writes = 0;
    const server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET") {
        res.end(JSON.stringify({ posts: post ? [post] : [] }));
        return;
      }
      let body = "";
      for await (const part of req) body += part;
      const input = JSON.parse(body).posts[0];
      writes++;
      post = {
        ...input,
        id: "remote-id",
        updated_at: "2026-10-29T00:00:00.000Z",
        url: "https://example.com/post",
      };
      res.end(JSON.stringify({ posts: [post] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const port = (server.address() as any).port;
      const client = new GhostClient({
        url: `http://127.0.0.1:${port}`,
        key: "id:" + "ab".repeat(32),
        allowLocal: true,
      });
      const input = {
        articleId: "a1",
        title: "test",
        lexical: blocksToLexical([]),
        status: "draft" as const,
      };
      const first = await client.publish(input);
      expect(first.id).toBe("remote-id");
      expect((await client.publish(input)).id).toBe("remote-id");
      expect(writes).toBe(1);
      await expect(
        client.publish({
          ...input,
          remoteId: first.id,
          expectedUpdatedAt: "old",
        }),
      ).rejects.toMatchObject({ code: "GHOST_CONFLICT" });
      expect(writes).toBe(1);
      await client.publish({
        ...input,
        status: "published",
        remoteId: first.id,
        expectedUpdatedAt: first.updated_at,
      });
      expect(post.status).toBe("published");
      const fingerprint = ghostFingerprint(post);
      post.title = "Edited in the same second";
      await expect(
        client.publish({
          ...input,
          remoteId: first.id,
          expectedUpdatedAt: first.updated_at,
          expectedFingerprint: fingerprint,
        }),
      ).rejects.toMatchObject({ code: "GHOST_CONFLICT" });
      expect(post.title).toBe("Edited in the same second");
      await expect(client.deletePost(first.id)).resolves.toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
