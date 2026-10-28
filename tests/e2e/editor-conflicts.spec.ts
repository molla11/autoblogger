import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
const API = "http://127.0.0.1:4000/api";
async function seed(request: APIRequestContext, label: string) {
  const email = `browser-${label}-${Date.now()}@local.test`;
  const auth = await request.post(API + "/auth/local", { data: { email } });
  expect(auth.ok()).toBeTruthy();
  const { token } = await auth.json();
  const headers = { Authorization: `Bearer ${token}` };
  const project = await (
    await request.post(API + "/projects", {
      headers,
      data: { name: `테스트 ${label}` },
    })
  ).json();
  const session = await (
    await request.post(API + `/projects/${project.id}/sessions`, {
      headers,
      data: {},
    })
  ).json();
  const memoId = crypto.randomUUID(),
    fileId = crypto.randomUUID();
  const ingested = await request.post(API + `/sessions/${session.id}/events`, {
    headers,
    data: {
      events: [
        {
          id: memoId,
          sessionId: session.id,
          sequence: 1,
          type: "memo",
          fileId,
          filePath: "solution.py",
          occurredAt: new Date().toISOString(),
          data: {
            text: "입력의 개수를 확인한 후 반복 범위를 수정했다.",
            bookmark: true,
          },
        },
      ],
    },
  });
  expect(ingested.ok()).toBeTruthy();
  const created = await (
    await request.post(API + "/articles", {
      headers,
      data: { sessionId: session.id, fileId, title: `검증 글 ${label}` },
    })
  ).json();
  const blocks = [
    {
      id: "paragraph-one",
      type: "paragraph",
      text: "처음 기록한 풀이 설명입니다.",
      evidenceIds: [memoId],
      review: "needs_review",
    },
  ];
  const article = await (
    await request.put(API + `/articles/${created.id}`, {
      headers,
      data: {
        expectedVersion: created.version,
        title: created.title,
        blocks,
        lexical: {
          root: {
            type: "root",
            version: 1,
            children: [
              {
                type: "html",
                version: 1,
                html: "<p>처음 기록한 풀이 설명입니다.</p>",
              },
            ],
          },
        },
      },
    })
  ).json();
  return { token, headers, article, memoId, userEmail: email };
}
async function open(page: Page, token: string, title: string) {
  await page.goto("/");
  await page.evaluate(
    (t) => localStorage.setItem("autoblogger.session", t),
    token,
  );
  await page.reload();
  await page
    .getByRole("button", { name: /글 보관함/ })
    .first()
    .click();
  await page.getByRole("heading", { name: title, exact: true }).click();
  await expect(page.getByLabel("글 제목")).toHaveValue(title);
  await expect(page.locator('[contenteditable="true"]')).toBeVisible();
}
async function current(
  request: APIRequestContext,
  id: string,
  headers: Record<string, string>,
) {
  return (await request.get(API + `/articles/${id}`, { headers })).json();
}
test("two tabs preserve an unsaved draft on conflict and allow explicit reload", async ({
  page,
  context,
  request,
}) => {
  const { token, headers, article } = await seed(request, "conflict");
  await open(page, token, article.title);
  const other = await context.newPage();
  await open(other, token, article.title);
  await page.getByLabel("글 제목").fill("첫 번째 탭에서 저장한 제목");
  await expect
    .poll(async () => (await current(request, article.id, headers)).title)
    .toBe("첫 번째 탭에서 저장한 제목");
  await other.getByLabel("글 제목").fill("두 번째 탭의 보존할 편집");
  await expect(
    other.getByText(
      "다른 탭에서 문서가 수정되었습니다. 현재 편집 내용은 유지됩니다.",
    ),
  ).toBeVisible();
  await expect(other.getByLabel("글 제목")).toHaveValue(
    "두 번째 탭의 보존할 편집",
  );
  expect((await current(request, article.id, headers)).title).toBe(
    "첫 번째 탭에서 저장한 제목",
  );
  const downloaded = other.waitForEvent("download");
  await other.getByRole("button", { name: "현재 편집 내려받기" }).click();
  expect((await downloaded).suggestedFilename()).toBe("unsaved-article.json");
  other.once("dialog", (dialog) => dialog.accept());
  await other.getByRole("button", { name: "서버 버전 불러오기" }).click();
  await expect(other.getByLabel("글 제목")).toHaveValue(
    "첫 번째 탭에서 저장한 제목",
  );
  await other.close();
});
test("editing a reviewed block visibly invalidates its review and retains original evidence", async ({
  page,
  request,
}) => {
  const { token, headers, article, memoId } = await seed(request, "evidence");
  // The model review is supplied only at the read boundary, avoiding any paid AI request.
  await page.route(API + `/articles/${article.id}`, async (route) => {
    if (route.request().method() === "GET") {
      const response = await route.fetch();
      const body = await response.json();
      body.blocks = body.blocks.map((b: any) => ({
        ...b,
        review: "supported",
      }));
      await route.fulfill({ response, json: body });
    } else await route.continue();
  });
  await open(page, token, article.title);
  await expect(
    page.getByText("기록이 뒷받침함", { exact: true }),
  ).toBeVisible();
  await page.unroute(API + `/articles/${article.id}`);
  await page
    .getByLabel("글 본문")
    .fill("새롭게 수정한 설명은 다시 확인해야 합니다.");
  await expect(page.getByText("확인 필요", { exact: true })).toBeVisible();
  await expect
    .poll(
      async () => (await current(request, article.id, headers)).blocks[0].text,
    )
    .toBe("새롭게 수정한 설명은 다시 확인해야 합니다.");
  const saved = await current(request, article.id, headers);
  expect(saved.blocks[0].review).toBe("needs_review");
  expect(saved.blocks[0].evidenceIds).toEqual([memoId]);
});
test("restores a saved revision as a new version without deleting history", async ({
  page,
  request,
}) => {
  const { token, headers, article } = await seed(request, "restore");
  await open(page, token, article.title);
  await page.getByLabel("글 제목").fill("복원 전 최신 편집");
  await expect
    .poll(async () => (await current(request, article.id, headers)).title)
    .toBe("복원 전 최신 편집");
  await expect(page.getByText(/저장됨 · v/)).toBeVisible();
  await page.getByRole("button", { name: "버전", exact: true }).click();
  const row = page
    .locator(".version-list>div")
    .filter({
      has: page.getByText(`버전 ${article.version}`, { exact: true }),
    });
  await row.getByRole("button", { name: "복원", exact: true }).click();
  await expect(page.getByLabel("글 제목")).toHaveValue(article.title);
  expect((await current(request, article.id, headers)).version).toBeGreaterThan(
    article.version + 1,
  );
  const revisions = await (
    await request.get(API + `/articles/${article.id}/revisions`, { headers })
  ).json();
  expect(revisions.length).toBeGreaterThanOrEqual(4);
});
test("rich marks, code languages, diff and an uploaded image survive save and reopening", async ({
  page,
  request,
}) => {
  const { token, headers, article, memoId } = await seed(request, "rich");
  const image = await request.post(API + "/uploads", {
    headers,
    multipart: {
      file: {
        name: "pixel.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
          "base64",
        ),
      },
    },
  });
  expect(image.ok()).toBeTruthy();
  const upload = await image.json();
  const imageUrl = new URL(upload.url, API).href;
  const richDocument = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "bold-p" },
        content: [
          { type: "text", text: "강조한 설명", marks: [{ type: "bold" }] },
          { type: "text", text: "과 기울인 생각", marks: [{ type: "italic" }] },
        ],
      },
      {
        type: "codeBlock",
        attrs: { id: "code-cpp", language: "cpp" },
        content: [{ type: "text", text: "int answer = 42;" }],
      },
      {
        type: "codeBlock",
        attrs: { id: "code-diff", language: "diff" },
        content: [{ type: "text", text: "- a - b\n+ a + b" }],
      },
      {
        type: "image",
        attrs: { id: "img-one", src: imageUrl, alt: "검증용 이미지" },
      },
    ],
  };
  const blocks = [
    {
      id: "bold-p",
      type: "paragraph",
      text: "강조한 설명과 기울인 생각",
      evidenceIds: [memoId],
      review: "needs_review",
    },
    {
      id: "code-cpp",
      type: "code",
      text: "int answer = 42;",
      language: "cpp",
      evidenceIds: [],
      review: "needs_review",
    },
    {
      id: "code-diff",
      type: "code",
      text: "- a - b\n+ a + b",
      language: "diff",
      evidenceIds: [],
      review: "needs_review",
    },
    {
      id: "img-one",
      type: "image",
      text: "검증용 이미지",
      url: imageUrl,
      evidenceIds: [],
      review: "needs_review",
    },
  ];
  const updated = await request.put(API + `/articles/${article.id}`, {
    headers,
    data: {
      expectedVersion: article.version,
      title: article.title,
      blocks,
      lexical: {
        root: {
          type: "root",
          version: 1,
          children: [{ type: "html", version: 1, html: "<p>seed</p>" }],
        },
        autobloggerEditor: richDocument,
      },
    },
  });
  expect(updated.ok()).toBeTruthy();
  await open(page, token, article.title);
  await expect(page.locator(".prose-editor strong")).toHaveText("강조한 설명");
  await expect(page.locator(".prose-editor em")).toHaveText("과 기울인 생각");
  await expect(page.locator(".prose-editor code.language-cpp")).toHaveText(
    "int answer = 42;",
  );
  await expect(page.locator(".prose-editor code.language-diff")).toContainText(
    "+ a + b",
  );
  await expect(page.locator(".prose-editor img")).toBeVisible();
  await page.getByLabel("글 제목").fill("리치 문서 저장 확인");
  await expect
    .poll(async () => (await current(request, article.id, headers)).title)
    .toBe("리치 문서 저장 확인");
  const saved = await current(request, article.id, headers);
  expect(
    saved.lexical.autobloggerEditor.content[0].content[0].marks[0].type,
  ).toBe("bold");
  expect(saved.lexical.root.children[0].html).toContain(
    "<strong>강조한 설명</strong>",
  );
  expect(saved.blocks.find((b: any) => b.id === "code-diff").language).toBe(
    "diff",
  );
  expect(saved.blocks.find((b: any) => b.id === "img-one").url).toContain(
    "/api/uploads/",
  );
  await open(page, token, "리치 문서 저장 확인");
  await expect(page.locator(".prose-editor strong")).toHaveText("강조한 설명");
  await expect(page.locator(".prose-editor code.language-diff")).toContainText(
    "+ a + b",
  );
  await expect(page.locator(".prose-editor img")).toHaveAttribute(
    "alt",
    "검증용 이미지",
  );
});
test("ordinary users have no admin UI and cannot access admin APIs", async ({
  page,
  request,
}) => {
  const { token, headers, article } = await seed(request, "regular");
  await open(page, token, article.title);
  await expect(
    page.getByRole("button", { name: "관리자", exact: true }),
  ).toHaveCount(0);
  const response = await request.get(API + "/admin", { headers });
  expect(response.status()).toBe(403);
  const mutation = await request.patch(API + "/admin/settings", {
    headers,
    data: { model: "bad-model", provider: "bad-provider" },
  });
  expect(mutation.status()).toBe(403);
});
test("remote conflict requires explicit comparison acceptance and pins the observed remote revision", async ({
  page,
  request,
}) => {
  const { token, article } = await seed(request, "remote");
  const observed = "2026-10-29T02:00:00.000Z";
  let publishRequest: any;
  await page.route(API + `/articles/${article.id}/remote`, (route) =>
    route.fulfill({
      json: {
        conflict: true,
        fingerprint: "observed-content-fingerprint",
        remote: {
          title: "Ghost에서 수정한 글",
          updated_at: observed,
          status: "published",
          html: "<p>원격에서 추가한 설명</p>",
        },
      },
    }),
  );
  await page.route(API + "/jobs", async (route) => {
    if (route.request().method() === "POST") {
      publishRequest = route.request().postDataJSON();
      await route.fulfill({
        json: {
          id: "mock-publication",
          kind: "publish",
          status: "queued",
          progress: 0,
          createdAt: new Date().toISOString(),
        },
      });
    } else await route.continue();
  });
  await open(page, token, article.title);
  await page.getByRole("button", { name: "Ghost 초안", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Ghost 원격 변경 확인" }),
  ).toBeVisible();
  expect(publishRequest).toBeUndefined();
  await expect(
    page
      .frameLocator('iframe[title="Ghost 원격 본문"]')
      .getByText("원격에서 추가한 설명"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "비교한 편집본으로 초안 저장", exact: true })
    .click();
  expect(publishRequest).toMatchObject({
    kind: "publish",
    articleId: article.id,
    targetStatus: "draft",
    expectedRemoteUpdatedAt: observed,
    expectedRemoteFingerprint: "observed-content-fingerprint",
  });
});
test("library editing completion is explicit and content changes make it editable again", async ({
  page,
  request,
}) => {
  const { token, headers, article } = await seed(request, "completion");
  await open(page, token, article.title);
  await page.getByRole("button", { name: "편집 완료", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "편집 완료됨", exact: true }),
  ).toBeDisabled();
  const completed = await current(request, article.id, headers);
  expect(completed.editingCompletedAt).toBeTruthy();
  expect(completed.status).not.toBe("published");
  await page.getByLabel("글 제목").fill("완료 후 다시 다듬는 글");
  await expect
    .poll(async () => (await current(request, article.id, headers)).title)
    .toBe("완료 후 다시 다듬는 글");
  expect(
    (await current(request, article.id, headers)).editingCompletedAt,
  ).toBeNull();
  await expect(
    page.getByRole("button", { name: "편집 완료", exact: true }),
  ).toBeEnabled();
});
