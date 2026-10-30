import { describe, expect, it } from "vitest";
import { diffLines, diffStat, withContext } from "./line-diff";
describe("line diff", () => {
  it("marks only the changed line and keeps line numbers on both sides", () => {
    const rows = diffLines(
      "#include <iostream>\nint main(){ return a-b; }\n",
      "#include <iostream>\nint main(){ return a+b; }\n",
    );
    expect(rows).toEqual([
      { type: "same", text: "#include <iostream>", oldNo: 1, newNo: 1 },
      { type: "del", text: "int main(){ return a-b; }", oldNo: 2 },
      { type: "add", text: "int main(){ return a+b; }", newNo: 2 },
    ]);
    expect(diffStat(rows)).toEqual({ added: 1, removed: 1 });
  });
  it("aligns insertions in the middle instead of rewriting the tail", () => {
    const rows = diffLines("a\nb\nc\nd", "a\nb\nx\nc\nd");
    expect(rows.map((r) => r.type)).toEqual(["same", "same", "add", "same", "same"]);
    expect(rows[3]).toEqual({ type: "same", text: "c", oldNo: 3, newNo: 4 });
  });
  it("treats a first save as all additions and an identical save as no change", () => {
    expect(diffStat(diffLines("", "x\ny\n"))).toEqual({ added: 2, removed: 0 });
    expect(diffStat(diffLines("x\r\ny\n", "x\ny"))).toEqual({ added: 0, removed: 0 });
  });
  it("folds unchanged lines outside the context window", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const pieces = withContext(diffLines(before, after), 2);
    expect(pieces[0]).toEqual({ type: "gap", hidden: 8 });
    expect(pieces.filter((p) => p.type !== "gap")).toHaveLength(6);
    expect(pieces.at(-1)).toEqual({ type: "gap", hidden: 7 });
    expect(withContext(diffLines("same", "same"))).toEqual([]);
  });
});
