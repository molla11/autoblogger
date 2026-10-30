export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:4000/api"
).replace(/\/$/, "");
const TOKEN_KEY = "autoblogger.session";
export const getToken = () =>
  typeof window === "undefined"
    ? ""
    : window.localStorage.getItem(TOKEN_KEY) || "";
export const setToken = (token: string) =>
  token
    ? window.localStorage.setItem(TOKEN_KEY, token)
    : window.localStorage.removeItem(TOKEN_KEY);
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details: unknown,
  ) {
    super(message);
  }
}
export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(API_URL + path, {
    ...options,
    headers,
    cache: "no-store",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      Array.isArray(data?.message)
        ? data.message.join(", ")
        : data?.message || `요청 실패 (${response.status})`,
      response.status,
      data,
    );
  return data as T;
}
export const post = <T = unknown>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const patch = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export function download(
  name: string,
  value: unknown,
  mime = "application/json",
) {
  const blob = new Blob(
    [typeof value === "string" ? value : JSON.stringify(value, null, 2)],
    { type: mime },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function watchEvents(
  path: string,
  onData: (data: unknown) => void,
  signal: AbortSignal,
) {
  const response = await fetch(API_URL + path, {
    headers: { Authorization: `Bearer ${getToken()}` },
    signal,
  });
  if (!response.ok || !response.body)
    throw new Error("실시간 연결을 열 수 없습니다.");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let separator;
    while ((separator = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          onData(JSON.parse(data));
        } catch {
          /* heartbeat/non-JSON event */
        }
      }
    }
  }
}
export const date = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "—";
export const time = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(new Date(value))
    : "—";
const relative = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
export const ago = (value?: string) => {
  if (!value) return "—";
  const seconds = (Date.now() - new Date(value).getTime()) / 1000;
  if (seconds < 60) return "방금";
  if (seconds < 3600) return relative.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86400) return relative.format(-Math.round(seconds / 3600), "hour");
  if (seconds < 86400 * 7)
    return relative.format(-Math.round(seconds / 86400), "day");
  return date(value);
};
export const money = (value: unknown) => `$${Number(value || 0).toFixed(3)}`;
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
