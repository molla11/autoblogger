import { describe, expect, it } from "vitest";
import { parseCommand, runStatus, tokenizeShell } from "./parser";

describe("terminal command observation", () => {
  it("links a quoted compilation and matching executable without executing shell text", () => {
    expect(
      parseCommand(
        'g++ -std=c++17 "my solution.cpp" -o "my solution" && ./"my solution" < "sample input.txt"',
        "/work",
      ),
    ).toEqual({
      kind: "compile_run",
      source: "/work/my solution.cpp",
      executable: "/work/my solution",
      input: "/work/sample input.txt",
    });
    expect(parseCommand("clang++ a.cpp -ofast", "/work")?.executable).toBe(
      "/work/fast",
    );
  });
  it("only recognizes a single allowed source file and conservative shell composition", () => {
    for (const command of [
      "g++ a.cpp b.cpp",
      "g++ a.cpp; ./a.out",
      "g++ a.cpp && ./other",
      "echo x | python3 a.py",
      "python3 -m module",
      'python3 -c "print(1)"',
      'python3 "$(cat x).py"',
      "python3 `echo x`.py",
      "g++ -c a.cpp",
      "g++ a.cpp && ./a.out && rm x",
    ]) {
      expect(parseCommand(command, "/work"), command).toBeUndefined();
    }
  });
  it("records Python options and redirects but excludes external runners", () => {
    expect(
      parseCommand(
        "python3 -u -X dev solve.py < input.txt > output.txt",
        "/work",
      ),
    ).toEqual({
      kind: "python",
      source: "/work/solve.py",
      input: "/work/input.txt",
    });
    expect(parseCommand("./a.out < case.txt", "/work")).toEqual({
      kind: "execute",
      executable: "/work/a.out",
      input: "/work/case.txt",
    });
    expect(parseCommand("code solve.py", "/work")).toBeUndefined();
    expect(tokenizeShell('python3 "unterminated.py')).toBeUndefined();
  });
  it("distinguishes compile/runtime/unknown and never equates exit zero with accepted", () => {
    expect(runStatus("compile", 1, "")).toEqual({ status: "compile_error" });
    expect(
      runStatus("compile_run", 1, "a.cpp:4:2: error: missing semicolon"),
    ).toEqual({ status: "compile_error" });
    expect(runStatus("python", 1, "SyntaxError: invalid syntax")).toEqual({
      status: "compile_error",
    });
    expect(runStatus("execute", 139, "Segmentation fault")).toEqual({
      status: "runtime_error",
      signal: 11,
    });
    expect(runStatus("python", 0, "wrong output")).toEqual({
      status: "success",
    });
    expect(runStatus("execute", undefined, "")).toEqual({ status: "unknown" });
  });
});
