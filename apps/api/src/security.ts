import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { BadRequestException } from "@nestjs/common";
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export const now = () => new Date().toISOString();
export function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function redact(value: any): any {
  if (typeof value === "string")
    return value
      .replace(
        /\b(?:sk-or-v1-|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}\b/g,
        "[REDACTED]",
      )
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        "[REDACTED]",
      )
      .replace(
        /((?:api[_-]?key|secret|password|access[_-]?token)\s*[=:]\s*["']?)[^\s"']{8,}/gi,
        "$1[REDACTED]",
      );
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v)]),
    );
  return value;
}
export function encryptionKey(secret: string) {
  if (!secret) throw new Error("Encryption key not configured");
  return createHash("sha256").update(secret).digest();
}
export function encrypt(value: string, key: Buffer) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  return [
    iv.toString("base64"),
    cipher.update(value, "utf8", "base64") + cipher.final("base64"),
    cipher.getAuthTag().toString("base64"),
  ].join(".");
}
export function decrypt(value: string, key: Buffer) {
  const [iv, data, tag] = value.split(".");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64"),
  );
  cipher.setAuthTag(Buffer.from(tag, "base64"));
  return cipher.update(data, "base64", "utf8") + cipher.final("utf8");
}
export function text(value: any, name: string, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new BadRequestException(
      `${name} must be non-empty text up to ${max} characters`,
    );
  return value.trim();
}
export function id(value: any, name = "id") {
  return text(value, name, 200);
}
export function validPath(value: string) {
  if (
    value.includes("\0") ||
    value.split(/[\\/]/).includes("..") ||
    !/^.*\.(?:c|cpp|py)$/i.test(value)
  )
    throw new BadRequestException("Unsupported source file path");
  return value;
}
export function matchesGlob(filename: string, pattern: string) {
  const normalized = filename.replace(/\\/g, "/");
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return (
    new RegExp("^" + source + "$").test(normalized) ||
    (!pattern.includes("/") &&
      new RegExp("^" + source + "$").test(normalized.split("/").at(-1) || ""))
  );
}
export function truncateOutput(value: string, limit = 256 * 1024) {
  const b = Buffer.from(value);
  if (b.length <= limit) return value;
  const marker = "\n… output truncated …\n";
  const room = limit - Buffer.byteLength(marker),
    half = Math.floor(room / 2);
  return (
    b.subarray(0, half).toString("utf8") +
    marker +
    b.subarray(b.length - (room - half)).toString("utf8")
  );
}
