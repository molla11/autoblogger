import { validateServiceUrl } from "../safety";

export type Surface = "recording" | "connection" | "session" | "settings";
export interface ViewState {
  tab?: "timeline" | "files" | "notes";
  file?: string;
  kind?: string;
  page?: number;
  eventId?: string;
  root?: string;
  draft?: string;
  bookmark?: boolean;
  target?: { sessionId: string; file?: string; line?: number };
}
export const defaults = {
  apiUrl: "http://127.0.0.1:4000/api",
  webUrl: "http://localhost:3000",
  excludePatterns: ["**/node_modules/**", "**/.git/**", "**/.venv/**", "**/venv/**"],
  autoSync: true,
  syncIntervalSeconds: 15,
  outputLimitBytes: 262144,
};
export type Settings = typeof defaults;
export const actions = ["start", "stop", "memo", "export", "connect", "cancelConnect", "disconnect", "sync", "exclude", "settings", "session", "folder", "trust", "terminal", "shellHelp", "logs", "file", "snapshot", "diff", "web", "webSettings", "saveSettings", "summaries"] as const;
export type Action = typeof actions[number];
export interface UiMessage { id: string; type: "ready" | "view" | "action"; action?: Action; payload: Record<string, unknown> }
export function parseMessage(value: unknown): UiMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("잘못된 화면 요청입니다.");
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.length > 100 || !["ready", "view", "action"].includes(String(m.type))) throw new Error("잘못된 화면 요청입니다.");
  if (m.type === "action" && !actions.includes(m.action as Action)) throw new Error("지원하지 않는 동작입니다.");
  if (!m.payload || typeof m.payload !== "object" || Array.isArray(m.payload) || JSON.stringify(m.payload).length > 40000) throw new Error("화면 입력이 너무 크거나 잘못되었습니다.");
  return { id: m.id, type: m.type as UiMessage["type"], action: m.action as Action, payload: m.payload as Record<string, unknown> };
}
export function viewState(value: Record<string, unknown>): ViewState {
  const result: ViewState = {};
  if (["timeline", "files", "notes"].includes(String(value.tab))) result.tab = value.tab as ViewState["tab"];
  for (const key of ["file", "kind", "eventId", "root", "draft"] as const)
    if (typeof value[key] === "string") result[key] = value[key].slice(0, key === "draft" ? 16384 : 2048);
  if (Number.isInteger(value.page)) result.page = Math.max(0, Math.min(1000000, Number(value.page)));
  if (typeof value.bookmark === "boolean") result.bookmark = value.bookmark;
  const target = value.target as Record<string, unknown> | undefined;
  if (target && typeof target.sessionId === "string") {
    result.target = { sessionId: target.sessionId.slice(0, 100) };
    if (typeof target.file === "string") result.target.file = target.file.slice(0, 2048);
    if (Number.isInteger(target.line) && Number(target.line) > 0) result.target.line = Number(target.line);
  }
  return result;
}
export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object") throw new Error("설정 값을 확인하세요.");
  const s = value as Settings;
  for (const key of ["apiUrl", "webUrl"] as const) {
    if (typeof s[key] !== "string" || s[key].length > 2048) throw new Error(`${key}: 주소를 확인하세요.`);
    try { validateServiceUrl(s[key]); } catch { throw new Error(`${key}: HTTPS 또는 로컬 HTTP 주소를 입력하세요.`); }
  }
  if (typeof s.autoSync !== "boolean") throw new Error("자동 동기화 값을 확인하세요.");
  if (!Number.isInteger(s.syncIntervalSeconds) || s.syncIntervalSeconds < 5 || s.syncIntervalSeconds > 300) throw new Error("동기화 주기는 5~300초입니다.");
  if (!Number.isInteger(s.outputLimitBytes) || s.outputLimitBytes < 1024 || s.outputLimitBytes > 262144) throw new Error("출력 상한은 1,024~262,144바이트입니다.");
  if (!Array.isArray(s.excludePatterns) || s.excludePatterns.length > 100 || s.excludePatterns.some(p => typeof p !== "string" || !p.trim() || p.length > 512)) throw new Error("제외 규칙은 빈 값 없이 최대 100개, 각각 512자까지 입력하세요.");
  return { apiUrl: s.apiUrl.replace(/\/$/, ""), webUrl: s.webUrl.replace(/\/$/, ""), autoSync: s.autoSync, syncIntervalSeconds: s.syncIntervalSeconds, outputLimitBytes: s.outputLimitBytes, excludePatterns: [...new Set(s.excludePatterns)] };
}
