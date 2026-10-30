import { describe, expect, it } from "vitest";
import { defaults, parseMessage, validateSettings, viewState } from "./protocol";

describe("webview trust boundary", () => {
  it("rejects arbitrary commands, oversized payloads and malformed messages", () => {
    for (const value of [null, [], { id: "1", type: "action", action: "workbench.action.terminal.sendSequence", payload: {} }, { id: "1", type: "view", payload: { draft: "a".repeat(40001) } }]) expect(() => parseMessage(value)).toThrow();
    expect(parseMessage({ id: "1", type: "action", action: "memo", payload: { text: "<script>" } }).action).toBe("memo");
  });
  it("persists only bounded display state and a fixed memo target", () => {
    expect(viewState({ tab: "notes", draft: "a".repeat(20000), page: -1, token: "secret", target: { sessionId: "s", file: "/tmp/code.py", line: 2, command: "exec" } })).toEqual({ tab: "notes", draft: "a".repeat(16384), page: 0, target: { sessionId: "s", file: "/tmp/code.py", line: 2 } });
  });
  it("rejects credential-bearing URLs, invalid ranges and malformed exclusions before writing any setting", () => {
    for (const change of [{ apiUrl: "https://user:password@example.com" }, { webUrl: "javascript:alert(1)" }, { apiUrl: "http://example.com" }, { syncIntervalSeconds: 4 }, { outputLimitBytes: 262145 }, { excludePatterns: [""] }]) expect(() => validateSettings({ ...defaults, ...change })).toThrow();
    expect(validateSettings({ ...defaults, excludePatterns: ["*.py", "*.py"] }).excludePatterns).toEqual(["*.py"]);
  });
});
