import { test, expect } from "@playwright/test";
test("actual Azure draft streams into editor and background review does not conflict with editing", async ({
  page,
}) => {
  test.skip(
    process.env.LIVE_AI_TEST !== "true",
    "Opt-in paid OpenRouter integration test",
  );
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "작업 공간 열기" }).click();
  await page.getByRole("button", { name: "샘플로 둘러보기" }).click();
  const started = Date.now();
  await page.getByRole("button", { name: "초안 만들기", exact: true }).click();
  await expect(page.getByLabel("글 제목")).toBeVisible({ timeout: 120000 });
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible())
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByLabel("글 본문")).toContainText(/확인|검증|수정/);
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const token = localStorage.getItem("autoblogger.session");
          const r = await fetch("http://127.0.0.1:4000/api/jobs", {
            headers: { Authorization: "Bearer " + token },
          });
          const jobs = await r.json();
          return jobs.some(
            (j: any) => j.kind === "verify" && j.status === "completed",
          );
        }),
      { timeout: 60000 },
    )
    .toBe(true);
  await page
    .getByLabel("글 제목")
    .fill("실제 Azure 생성 후 브라우저 편집 확인");
  await expect(page.getByText(/저장됨 · v/)).toBeVisible();
  await expect(page.getByText("저장 충돌", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "편집 완료", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "편집 완료됨", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: ".data/screenshots/live-ai-editor.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    "Live browser draft+review+edit completed in",
    Date.now() - started,
    "ms",
  );
});
