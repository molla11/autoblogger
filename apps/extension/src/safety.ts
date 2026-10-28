import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpath, readFile, stat } from 'node:fs/promises';

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

/** Both collection and transmission use this filter. Never interpolate captured data into a shell. */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-(?:or-v1-)?|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{16,}\b/g, '[REDACTED TOKEN]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED AWS KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED JWT]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{10,}/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[=:]\s*["']?)([^\s"'`;\[]{6,})/gi, '$1[REDACTED]')
    .replace(/\b[a-f0-9]{24}:[a-f0-9]{64}\b/gi, '[REDACTED GHOST KEY]');
}

export function globMatches(pattern: string, relativePath: string): boolean {
  const value = relativePath.split(path.sep).join('/');
  let expression = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { expression += '(?:.*/)?'; i++; }
      else expression += '.*';
    } else if (c === '*') expression += '[^/]*';
    else if (c === '?') expression += '[^/]';
    else expression += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(expression + '$').test(value);
}

export function withinRoot(root: string, absolute: string): boolean {
  const relative = path.relative(root, absolute);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function eligiblePath(root: string, absolute: string, excludes: string[]): boolean {
  return withinRoot(root, absolute) && ['.c', '.cpp', '.py'].includes(path.extname(absolute).toLowerCase()) &&
    !excludes.some(glob => globMatches(glob, path.relative(root, absolute)));
}

/** realpath prevents a project symlink from collecting files outside the selected root. */
export async function readSafeText(root: string, absolute: string, allowInput = false): Promise<string | undefined> {
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(absolute)]);
    if (!withinRoot(realRoot, realFile)) return undefined;
    if (!allowInput && !['.c', '.cpp', '.py'].includes(path.extname(realFile).toLowerCase())) return undefined;
    const info = await stat(realFile);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const bytes = await readFile(realFile);
    if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) return undefined;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return redact(text);
  } catch { return undefined; }
}

/** Keep bounded head/tail buffers even for a runaway program; memory does not grow with output. */
export class BoundedOutput {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private total = 0;
  private readonly marker = '\n… [output truncated] …\n';
  constructor(readonly limit = MAX_OUTPUT_BYTES) {
    if (limit < 128 || limit > MAX_OUTPUT_BYTES) throw new Error('Invalid output limit');
  }
  append(chunk: string): void {
    const bytes = Buffer.from(chunk);
    this.total += bytes.length;
    const headLimit = Math.floor((this.limit - Buffer.byteLength(this.marker)) / 2);
    if (this.head.length < headLimit) {
      const take = Math.min(headLimit - this.head.length, bytes.length);
      this.head = Buffer.concat([this.head, bytes.subarray(0, take)]);
      this.tail = Buffer.concat([this.tail, bytes.subarray(take)]).subarray(-this.limit);
    } else this.tail = Buffer.concat([this.tail, bytes]).subarray(-this.limit);
  }
  value(): string {
    const decodeBoundary = (bytes: Buffer): string => {
      let start = 0;
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      return new TextDecoder().decode(bytes.subarray(start),{stream:true});
    };
    const raw = this.total <= this.limit ? Buffer.concat([this.head,this.tail]).toString('utf8') :
      decodeBoundary(this.head) + this.marker + decodeBoundary(this.tail.subarray(-(this.limit - this.head.length - Buffer.byteLength(this.marker))));
    const value = redact(raw.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ''));
    if (Buffer.byteLength(value) <= this.limit) return value;
    const bytes = Buffer.from(value), budget = Math.floor((this.limit - Buffer.byteLength(this.marker)) / 2);
    return decodeBoundary(bytes.subarray(0,budget)) + this.marker + decodeBoundary(bytes.subarray(-budget));
  }
}

export function validateServiceUrl(raw: string): URL {
  const url = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error('HTTPS 주소 또는 로컬 HTTP 주소만 사용할 수 있습니다.');
  }
  return url;
}
