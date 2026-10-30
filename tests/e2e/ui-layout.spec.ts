import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
const API = "http://127.0.0.1:4000/api";
async function seed(request: APIRequestContext, label: string) {
  const email = `layout-${label}-${Date.now()}@local.test`;
  const { token } = await (
    await request.post(API + "/auth/local", { data: { email } })
  ).json();
  const headers = { Authorization: `Bearer ${token}` };
  const sample = await (
    await request.post(API + "/samples", { headers })
  ).json();
  return { token, headers, sample };
}
async function signIn(page: Page, token: string, path = "/") {
  await page.addInitScript(
    (value) => localStorage.setItem("autoblogger.session", value),
    token,
  );
  await page.goto(path);
}
test("large source comparisons keep a bounded number of rendered rows", async ({
  page,
  request,
}) => {
  const { token, headers, sample } = await seed(request, "large-diff");
  const session = await (
    await request.post(API + `/projects/${sample.session.projectId}/sessions`, {
      headers,
      data: {},
    })
  ).json();
  const fileId = crypto.randomUUID();
  const response = await request.post(API + `/sessions/${session.id}/events`, {
    headers,
    data: {
      events: ["a", "b"].map((value, index) => ({
        id: crypto.randomUUID(),
        sessionId: session.id,
        sequence: index + 1,
        type: "snapshot",
        fileId,
        filePath: "large.py",
        occurredAt: new Date(Date.now() + index).toISOString(),
        data: { content: (value + "\n").repeat(150000) },
      })),
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, token, `/?session=${session.id}`);
  await page.locator(".event-row").last().click();
  const pane = page.locator("#event-pane");
  await expect(pane.locator(".code-diff tbody tr")).toHaveCount(500);
  await expect(
    pane.getByRole("navigation", { name: "코드 비교 페이지" }),
  ).toContainText("1 / 600");
  await pane.getByRole("button", { name: "다음 코드 비교" }).click();
  await expect(
    pane.getByRole("navigation", { name: "코드 비교 페이지" }),
  ).toContainText("2 / 600");
  await expect(
    pane.locator(".code-diff tbody tr").first().locator(".ln").first(),
  ).toHaveText("501");
});
test("session timeline keeps one row per event and shows the selection beside the list", async ({
  page,
  request,
}) => {
  const { token, sample } = await seed(request, "split");
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, token, `/?session=${sample.session.id}`);
  const rows = page.locator(".event-row");
  await expect(rows).toHaveCount(6);
  const pane = page.locator("#event-pane");
  await rows.filter({ hasText: "터미널 실행" }).first().click();
  await expect(pane).toContainText("$ g++ sum.cpp -o sum && ./sum");
  await expect(pane).toContainText(
    "정상 종료는 정답 여부를 의미하지 않습니다.",
  );
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(2)).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(2)).toBeFocused();
  await expect(pane.locator(".memo-text")).toContainText(
    "입력 2 3의 기대값은 5인데",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeLessThanOrEqual(900);
});
test("narrow timeline expands the chosen event in place", async ({
  page,
  request,
}) => {
  const { token, sample } = await seed(request, "narrow");
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, token, `/?session=${sample.session.id}`);
  const run = page
    .locator(".event-row")
    .filter({ hasText: "터미널 실행" })
    .first();
  await expect(run).toHaveAttribute("aria-expanded", "false");
  await run.click();
  await expect(run).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".event-item .event-pane")).toContainText("-1");
  await run.click();
  await expect(page.locator(".event-pane")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
});
test("article library filters by status and opens rows by their title", async ({
  page,
  request,
}) => {
  const { token, headers, sample } = await seed(request, "library");
  const create = async (title: string) =>
    (
      await request.post(API + "/articles", {
        headers,
        data: { sessionId: sample.session.id, title },
      })
    ).json();
  const done = await create("편집을 마친 글");
  await create("작성 중인 글");
  const completed = await request.post(API + `/articles/${done.id}/complete`, {
    headers,
    data: { expectedVersion: done.version },
  });
  expect(completed.ok()).toBeTruthy();
  await signIn(page, token);
  await page
    .getByRole("button", { name: /글 보관함/ })
    .first()
    .click();
  const list = page.locator(".panel .row-list");
  await expect(list.getByRole("heading")).toHaveCount(2);
  await page.getByRole("button", { name: /^편집 완료/ }).click();
  await expect(list.getByRole("heading")).toHaveCount(1);
  await expect(
    list.getByRole("heading", { name: "편집을 마친 글" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^전체/ }).click();
  await page.getByLabel("글 검색").fill("작성 중");
  await list
    .getByRole("heading", { name: "작성 중인 글", exact: true })
    .click();
  await expect(page.getByLabel("글 제목")).toHaveValue("작성 중인 글");
});
test("timeline shows what changed and drafting starts only after reviewing the input", async ({
  page,
  request,
}) => {
  const { token, sample } = await seed(request, "draft");
  let jobRequests = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === API + "/jobs") jobRequests++;
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, token, `/?session=${sample.session.id}`);
  const rows = page.locator(".event-row");
  await expect(rows.first()).toContainText("첫 저장");
  await expect(rows.filter({ hasText: "터미널 실행" }).first()).toContainText(
    "-1",
  );
  await expect(rows.filter({ hasText: "터미널 실행" }).last()).toContainText(
    "결과 변화",
  );
  await rows.filter({ hasText: "코드 수정" }).click();
  const pane = page.locator("#event-pane");
  await expect(pane.locator(".code-diff tr.del")).toContainText("a-b");
  await expect(pane.locator(".code-diff tr.add")).toContainText("a+b");
  await page.getByRole("button", { name: /^실행 2:/ }).click();
  await expect(pane).toContainText("5");
  await page.getByRole("button", { name: "초안 만들기", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "초안 만들기" });
  await expect(sheet).toContainText("사건 6개 · 코드 변경 3 · 실행 2 · 메모 1");
  await expect(sheet.getByRole("textbox")).toHaveValue("");
  await expect(
    sheet.getByRole("button", { name: "초안 생성 시작", exact: true }),
  ).toBeEnabled();
  await sheet.getByRole("button", { name: "취소", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(jobRequests).toBe(0);
});
