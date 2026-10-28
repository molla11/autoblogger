import { describe, it, expect } from "vitest";
import { draftPreview } from "./stream-preview";
describe("safe cumulative draft preview", () => {
  it("renders complete structured output without field names or IDs", () =>
    expect(
      draftPreview('{"title":"풀이","blocks":[{"id":"x","text":"설명"}]}'),
    ).toEqual({ title: "풀이", paragraphs: ["설명"] }));
  it("shows partial text before the last JSON string closes", () =>
    expect(
      draftPreview('{"title":"풀이","blocks":[{"text":"작성 중인 문장'),
    ).toEqual({ title: "풀이", paragraphs: ["작성 중인 문장"] }));
  it("decodes newlines and escaped quotes", () =>
    expect(
      draftPreview('{"blocks":[{"text":"print(\\"hello\\")\\nnext"}]}')
        .paragraphs,
    ).toEqual(['print("hello")\nnext']));
  it("waits safely on partial unicode and backslash escapes", () => {
    expect(draftPreview('{"text":"hello\\u12').paragraphs).toEqual(["hello"]);
    expect(draftPreview('{"text":"hello\\').paragraphs).toEqual(["hello"]);
  });
  it("returns no claims for absent text", () =>
    expect(draftPreview('{"blocks":[')).toEqual({ title: "", paragraphs: [] }));
});
