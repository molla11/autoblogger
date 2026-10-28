import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { GhostClient, GhostError } from "../../packages/ai/src/ghost";

/** Real, loopback-only Ghost integration test; never reads the production .env.local. */
async function main() {
  const credentialPath =
    process.argv[2] ?? "/tmp/autoblogger-ghost/test-credentials.json";
  const credentials = JSON.parse(await readFile(credentialPath, "utf8"));
  const target = new URL(credentials.url);
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname),
    "This test must only use a loopback Ghost instance",
  );
  const client = new GhostClient({ ...credentials, allowLocal: true });
  const results: Array<{ name: string; status: string; detail?: string }> = [];
  const record = (name: string, detail?: string) => {
    results.push({ name, status: "passed", detail });
    process.stdout.write("PASS " + name + "\n");
  };
  const articleId = randomUUID();
  const lexical = (html: string) => ({
    root: {
      type: "root",
      version: 1,
      direction: null,
      format: "",
      indent: 0,
      children: [
        {
          type: "html",
          version: 1,
          html,
          id: "private-block-id",
          evidenceIds: ["private-event-id"],
          review: "needs_review",
        },
      ],
    },
  });
  let postId: string | undefined;
  try {
    await client.checkConnection();
    record("custom integration authentication");
    const html =
      '<h2>Local algorithm evidence</h2><p>Observed exit is not judge acceptance.</p><pre><code class="language-cpp">int main() { return 0; }</code></pre><pre><code class="language-diff">- old\n+ new</code></pre>';
    let post = await client.publish({
      articleId,
      title: "Autoblogger isolated fixture",
      lexical: lexical(html),
      status: "draft",
    });
    postId = post.id;
    assert.equal(post.status, "draft");
    record("create draft HTML card");
    const draft = await client.getPost(post.id);
    assert.ok(draft.lexical.includes("language-cpp"));
    assert.ok(draft.lexical.includes("language-diff"));
    assert.ok(!draft.lexical.includes("private-block-id"));
    assert.ok(!draft.lexical.includes("private-event-id"));
    record("read draft and strip private block metadata");
    const reconciled = await client.publish({
      articleId,
      title: post.title,
      lexical: lexical(html),
      status: "draft",
    });
    assert.equal(reconciled.id, post.id);
    record("idempotent create reconciliation");
    post = await client.publish({
      articleId,
      title: post.title,
      lexical: lexical(html),
      status: "published",
      remoteId: post.id,
      expectedUpdatedAt: post.updated_at,
    });
    assert.equal(post.status, "published");
    const page = await fetch(post.url);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.ok(pageHtml.includes("language-cpp"));
    assert.ok(pageHtml.includes("language-diff"));
    record("publish and render code/diff in actual Ghost page");
    const beforeUpdate = post.updated_at;
    post = await client.publish({
      articleId,
      title: "Updated local fixture",
      lexical: lexical(html + "<p>Updated revision.</p>"),
      status: "published",
      remoteId: post.id,
      expectedUpdatedAt: beforeUpdate,
    });
    assert.equal(post.title, "Updated local fixture");
    record("update published post");
    await assert.rejects(
      client.publish({
        articleId,
        title: "Must not overwrite",
        lexical: lexical("<p>stale</p>"),
        status: "published",
        remoteId: post.id,
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }),
      (error: unknown) =>
        error instanceof GhostError && error.code === "GHOST_CONFLICT",
    );
    assert.equal(
      (await client.getPost(post.id)).title,
      "Updated local fixture",
    );
    record("remote-change conflict preserves remote post");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNQaDgARAwQCgAkDgWBfAdHdAAAAABJRU5ErkJggg==",
      "base64",
    );
    const image = await client.uploadImage(
      png,
      "autoblogger-local-test.png",
      "image/png",
    );
    assert.equal(new URL(image).hostname, target.hostname);
    const uploaded = await fetch(image);
    assert.equal(uploaded.status, 200);
    assert.ok((await uploaded.arrayBuffer()).byteLength > 0);
    record("upload image and fetch Ghost asset");
    post = await client.publish({
      articleId,
      title: post.title,
      lexical: lexical(
        html + `<figure><img src="${image}" alt="local fixture"></figure>`,
      ),
      status: "published",
      remoteId: post.id,
      expectedUpdatedAt: post.updated_at,
    });
    assert.ok((await (await fetch(post.url)).text()).includes(image));
    record("render uploaded image in published page");
    post = await client.publish({
      articleId,
      title: post.title,
      lexical: lexical(html),
      status: "draft",
      remoteId: post.id,
      expectedUpdatedAt: post.updated_at,
    });
    assert.equal((await client.getPost(post.id)).status, "draft");
    assert.equal(
      (await fetch(`${target.origin}/autoblogger-${articleId}/`)).status,
      404,
    );
    record("unpublish confirmed remotely and public URL removed");
    await client.deletePost(post.id);
    postId = undefined;
    record("delete isolated test post");
  } finally {
    if (postId) {
      try {
        await client.deletePost(postId);
      } catch {
        /* preserve test-only state for debugging */
      }
    }
    await writeFile(
      "/tmp/autoblogger-ghost/test-results.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          ghostVersion: "6.67.0",
          target: target.origin,
          results,
          productionTouched: false,
        },
        null,
        2,
      ),
    );
  }
}
void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.name + ": " + error.message : "Ghost test failed"}\n`,
  );
  process.exitCode = 1;
});
