import { readFile, mkdir, writeFile } from "node:fs/promises";
import { GhostClient, ghostFingerprint } from "../packages/ai/src";
const base = process.env.TEST_API_URL || "http://127.0.0.1:4001/api";
async function main() {
  const credentials = JSON.parse(
    await readFile(
      process.env.GHOST_TEST_CREDENTIALS ||
        "/tmp/autoblogger-ghost/test-credentials.json",
      "utf8",
    ),
  );
  if (!["127.0.0.1", "localhost"].includes(new URL(credentials.url).hostname))
    throw new Error("This smoke test only permits an isolated local Ghost");
  const ghost = new GhostClient({ ...credentials, allowLocal: true });
  let token = "";
  async function req(path: string, method = "GET", body?: unknown) {
    const r = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(path + " " + r.status + " " + JSON.stringify(d));
    return d;
  }
  token = (
    await req("/auth/local", "POST", {
      email: "publication-" + Date.now() + "@local.test",
    })
  ).token;
  await req("/ghost", "POST", credentials);
  const { session } = await req("/samples", "POST", {});
  const form = new FormData();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  form.append("file", new Blob([png], { type: "image/png" }), "pixel.png");
  const uploadResponse = await fetch(base + "/uploads", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: form,
  });
  if (!uploadResponse.ok) throw new Error("Upload failed");
  const upload = (await uploadResponse.json()) as any;
  const localImage = new URL(upload.url, base).href;
  let article = await req("/articles", "POST", {
    sessionId: session.id,
    title: "Local worker publication test",
  });
  const lexical = {
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "html",
          version: 1,
          html: `<h2>Rich test</h2><p><strong>Preserve bold</strong> and <em>italic</em></p><pre><code class="language-diff">- old\n+ new</code></pre><img src="${localImage.replace(/&/g, "&amp;")}" alt="test image">`,
        },
      ],
    },
    autobloggerEditor: { type: "doc", content: [] },
  };
  const blocks = [
    {
      id: "text",
      type: "paragraph",
      text: "Preserve bold and italic",
      evidenceIds: [],
      review: "needs_review",
    },
    {
      id: "image",
      type: "image",
      text: "test image",
      url: localImage,
      evidenceIds: [],
      review: "needs_review",
    },
  ];
  article = await req("/articles/" + article.id, "PUT", {
    title: article.title,
    expectedVersion: article.version,
    lexical,
    blocks,
  });
  async function publish(
    status: "draft" | "published",
    expectedRemoteUpdatedAt?: string,
    fail = false,
    expectedRemoteFingerprint?: string,
  ) {
    const job = await req("/jobs", "POST", {
      kind: "publish",
      articleId: article.id,
      targetStatus: status,
      expectedRemoteUpdatedAt,
      expectedRemoteFingerprint,
    });
    for (let i = 0; i < 120; i++) {
      const j = await req("/jobs/" + job.id);
      if (j.status === "failed") {
        if (fail) return j;
        throw new Error(j.error);
      }
      if (j.status === "completed") {
        if (fail) throw new Error("Expected conflict");
        article = await req("/articles/" + article.id);
        return j;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("Publish timed out");
  }
  const checks: string[] = [];
  let remoteId = "";
  try {
    await publish("draft");
    remoteId = article.publication.remoteId;
    let remote = await ghost.getPost(remoteId);
    const content = JSON.stringify(JSON.parse(remote.lexical));
    if (
      !content.includes("<strong>Preserve bold</strong>") ||
      !content.includes("<em>italic</em>") ||
      content.includes("/api/uploads/") ||
      content.includes("autobloggerEditor")
    )
      throw new Error("Rich/image conversion failed");
    checks.push(
      "Worker uploads owner-verified API image and preserves rich HTML",
    );
    await publish("published");
    remote = await ghost.getPost(remoteId);
    const page = await fetch(remote.url);
    if (!page.ok) throw new Error("Published page unavailable");
    checks.push("Worker publishes actual local Ghost page");
    const edited = await ghost.publish({
      articleId: article.id,
      title: "Remote edited independently",
      lexical: JSON.parse(remote.lexical),
      status: "published",
      remoteId,
      expectedUpdatedAt: remote.updated_at,
    });
    const conflict = await publish("published", undefined, true);
    if (conflict.errorCode !== "GHOST_CONFLICT")
      throw new Error("Expected remote conflict");
    if ((await ghost.getPost(remoteId)).title !== "Remote edited independently")
      throw new Error("Remote was overwritten");
    checks.push("Worker refuses stale remote state");
    await publish("draft", edited.updated_at, false, ghostFingerprint(edited));
    remote = await ghost.getPost(remoteId);
    if (remote.status !== "draft") throw new Error("Unpublish not confirmed");
    checks.push("Explicit compared version unpublishes successfully");
    console.log(
      JSON.stringify(
        { checks, backend: base, ghost: credentials.url },
        null,
        2,
      ),
    );
    await mkdir(".data/reports", { recursive: true });
    await writeFile(
      ".data/reports/publication.json",
      JSON.stringify(
        { checks, backend: base, ghost: credentials.url },
        null,
        2,
      ),
    );
  } finally {
    if (remoteId) await ghost.deletePost(remoteId);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
