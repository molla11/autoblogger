import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BoundedOutput,
  eligiblePath,
  globMatches,
  MAX_OUTPUT_BYTES,
  readSafeText,
  redact,
  validateServiceUrl,
} from "./safety";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
describe("collection boundaries", () => {
  it("filters secrets while preserving useful source", () => {
    const source = `const answer = 42;\nOPENROUTER_API_KEY="sk-or-v1-${"a".repeat(64)}";\nAuthorization: Bearer ${"b".repeat(40)}\npassword = 'secretpassword'`;
    const clean = redact(source);
    expect(clean).toContain("answer = 42");
    expect(clean).not.toContain("a".repeat(64));
    expect(clean).not.toContain("b".repeat(40));
    expect(clean).not.toContain("secretpassword");
    expect(redact("a".repeat(24) + ":" + "b".repeat(64))).toBe(
      "[REDACTED GHOST KEY]",
    );
  });
  it("handles rooted glob exclusions and traversal", () => {
    expect(globMatches("**/node_modules/**", "node_modules/source.py")).toBe(
      true,
    );
    expect(
      globMatches("**/node_modules/**", "deep/node_modules/source.py"),
    ).toBe(true);
    expect(globMatches("*.py", "deep/source.py")).toBe(false);
    expect(eligiblePath("/work", "/work/../private.py", [])).toBe(false);
    expect(eligiblePath("/work", "/work/a.ts", [])).toBe(false);
    expect(eligiblePath("/work", "/work/a.cpp", [])).toBe(true);
  });
  it("rejects binaries, over-size files and symlinks outside root", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "autoblogger-safety-"));
    temporary.push(temp);
    const root = path.join(temp, "project");
    await mkdir(root);
    await writeFile(path.join(temp, "private.py"), "private_data");
    await symlink(path.join(temp, "private.py"), path.join(root, "link.py"));
    await writeFile(path.join(root, "binary.cpp"), Buffer.from([97, 0, 98]));
    await writeFile(path.join(root, "big.py"), "a".repeat(1024 * 1024 + 1));
    await writeFile(path.join(root, "ok.py"), "print(1)");
    expect(
      await readSafeText(root, path.join(root, "link.py")),
    ).toBeUndefined();
    expect(
      await readSafeText(root, path.join(root, "binary.cpp")),
    ).toBeUndefined();
    expect(await readSafeText(root, path.join(root, "big.py"))).toBeUndefined();
    expect(await readSafeText(root, path.join(root, "ok.py"))).toBe("print(1)");
  });
  it("bounds UTF-8 output and preserves head/tail after unlimited chunks", () => {
    const output = new BoundedOutput();
    output.append("FIRST\n");
    for (let i = 0; i < 1000; i++) output.append("한".repeat(500));
    output.append("\nLAST");
    expect(Buffer.byteLength(output.value())).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    );
    expect(output.value().slice(0, 10)).toContain("FIRST");
    expect(output.value().slice(-10)).toContain("LAST");
    expect(output.value().includes("output truncated")).toBe(true);
    const small = new BoundedOutput();
    small.append("hello ");
    small.append("world");
    expect(small.value()).toBe("hello world");
  });
  it("keeps credentials off plaintext nonlocal or embedded-credential URLs", () => {
    expect(validateServiceUrl("http://127.0.0.1:4000/api").port).toBe("4000");
    expect(() => validateServiceUrl("http://example.com/api")).toThrow();
    expect(() => validateServiceUrl("https://user:pass@example.com")).toThrow();
  });
});
