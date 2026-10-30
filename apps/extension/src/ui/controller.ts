import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicJson } from "../journal";
import { Action, parseMessage, Surface, ViewState, viewState } from "./protocol";

export interface SessionItem { id: string; name: string; rootPath: string; startedAt: string; recording: boolean; pending: number; count: number }
export interface UiService {
  sessions(): SessionItem[];
  model(surface: Surface, sessionId: string | undefined, state: ViewState): Promise<unknown>;
  action(action: Action, payload: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}
interface Port { webview: vscode.Webview; surface: Surface; sessionId?: string; key: string; state: ViewState; visible: () => boolean; version: number; last?: string; ready: boolean; disposed: boolean; queue: Promise<unknown> }
type TreeNode = { root: string } | SessionItem;
class SessionTree implements vscode.TreeDataProvider<TreeNode> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private service: UiService) {}
  refresh() { this.changed.fire(); }
  dispose() { this.changed.dispose(); }
  getChildren(element?: TreeNode): TreeNode[] {
    const sessions = this.service.sessions().reverse();
    if (!element) return [...new Set(sessions.map(s => s.rootPath))].map(root => ({ root }));
    return "root" in element ? sessions.filter(s => s.rootPath === element.root) : [];
  }
  getTreeItem(element: TreeNode): vscode.TreeItem {
    if ("root" in element) {
      const item = new vscode.TreeItem(element.root.split(/[\\/]/).pop() || element.root, vscode.TreeItemCollapsibleState.Expanded);
      item.id = element.root; item.tooltip = element.root; item.iconPath = new vscode.ThemeIcon("folder"); return item;
    }
    const item = new vscode.TreeItem(new Date(element.startedAt).toLocaleString("ko-KR"));
    item.id = element.id; item.description = `${element.recording ? "기록 중" : "종료"} · ${element.pending}개 대기`;
    item.tooltip = `${element.name}\n${element.count}개 사건\n${element.rootPath}`;
    item.iconPath = new vscode.ThemeIcon(element.recording ? "record" : "history"); item.contextValue = "autoblogger.session";
    item.command = { command: "autoblogger.openSession", title: "세션 열기", arguments: [element.id] }; return item;
  }
}
export class ExtensionUi implements vscode.Disposable {
  private ports = new Set<Port>();
  private panels = new Map<string, vscode.WebviewPanel>();
  private timer?: NodeJS.Timeout;
  private tree: SessionTree;
  private treeVersion = "";
  private disposables: vscode.Disposable[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  static async create(context: vscode.ExtensionContext, service: UiService) {
    const directory = (context.storageUri ?? vscode.Uri.joinPath(context.globalStorageUri, "empty-workspace")).fsPath;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "gui-state.json");
    let saved: Record<string, ViewState> = {};
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw))
        saved = Object.fromEntries(Object.entries(raw).filter(([key, value]) => key.startsWith("gui.") && value && typeof value === "object").map(([key, value]) => [key, viewState(value as Record<string, unknown>)]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") void vscode.window.showWarningMessage("Autoblogger 화면 상태를 복원하지 못했습니다. 원본 기록은 보존됩니다.");
    }
    return new ExtensionUi(context, service, file, saved);
  }
  private constructor(private context: vscode.ExtensionContext, private service: UiService, private stateFile: string, private saved: Record<string, ViewState>) {
    this.tree = new SessionTree(service);
    this.disposables.push(this.tree, vscode.window.createTreeView("autoblogger.sessions", { treeDataProvider: this.tree, showCollapseAll: true }));
    for (const surface of ["recording", "connection"] as const)
      this.disposables.push(vscode.window.registerWebviewViewProvider(`autoblogger.${surface}`, {
        resolveWebviewView: view => {
          const port = this.attach(view.webview, surface, () => view.visible);
          view.onDidChangeVisibility(() => { if (view.visible) void this.refreshPort(port); });
          view.onDidDispose(() => this.detach(port));
        },
      }));
    this.disposables.push(vscode.window.registerWebviewPanelSerializer("autoblogger.session", {
      deserializeWebviewPanel: async (panel, state) => {
        const stored = state as { sessionId?: unknown } | undefined;
        const id = typeof stored?.sessionId === "string" ? stored.sessionId : undefined;
        if (!id || !service.sessions().some(s => s.id === id)) { panel.dispose(); return; }
        this.attachPanel(panel, "session", id);
      },
    }));
    this.disposables.push(vscode.window.registerWebviewPanelSerializer("autoblogger.settings", {
      deserializeWebviewPanel: async panel => { this.attachPanel(panel, "settings"); },
    }));
  }
  private key(surface: Surface, id?: string) { return `gui.${surface}${id ? "." + id : ""}`; }
  private attach(webview: vscode.Webview, surface: Surface, visible: () => boolean, sessionId?: string): Port {
    const key = this.key(surface, sessionId);
    const port: Port = { webview, surface, sessionId, key, state: this.saved[key] ?? this.context.workspaceState.get<ViewState>(key, {}), visible, version: 0, ready: false, disposed: false, queue: Promise.resolve() };
    this.ports.add(port);
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(24).toString("base64");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "app.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "app.js"));
    webview.onDidReceiveMessage(raw => {
      port.queue = port.queue.then(async () => {
        let id = "";
        try {
          const m = parseMessage(raw); id = m.id;
          if (m.type === "ready") { port.ready = true; port.last = undefined; }
          else if (m.type === "view") {
            port.state = viewState(m.payload);
            this.saved[key] = port.state;
            const write = this.writes.then(() => atomicJson(this.stateFile, this.saved));
            this.writes = write.catch(() => undefined);
            await write;
          } else {
            const result = await this.service.action(m.action!, m.payload, sessionId);
            await webview.postMessage({ type: "result", id, result });
          }
          await this.refreshPort(port);
        } catch (error) {
          await webview.postMessage({ type: "error", id, message: error instanceof Error ? error.message : "화면 요청에 실패했습니다." });
        }
      }).catch(() => undefined);
    });
    webview.html = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};"><link rel="stylesheet" href="${css}"><title>Autoblogger</title></head><body data-surface="${surface}"><main id="app" aria-label="Autoblogger"><p>기록을 불러오는 중…</p></main><div id="feedback" role="status" aria-live="polite"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    return port;
  }
  private detach(port: Port) { port.disposed = true; this.ports.delete(port); }
  private attachPanel(panel: vscode.WebviewPanel, surface: "session" | "settings", id?: string) {
    const key = this.key(surface, id);
    this.panels.set(key, panel);
    panel.title = surface === "settings" ? "Autoblogger 설정·연결" : `세션: ${this.service.sessions().find(s => s.id === id)?.name ?? "풀이"}`;
    panel.iconPath = new vscode.ThemeIcon(surface === "settings" ? "settings-gear" : "history");
    const port = this.attach(panel.webview, surface, () => panel.visible, id);
    panel.onDidChangeViewState(() => { if (panel.visible) void this.refreshPort(port); });
    panel.onDidDispose(() => { this.panels.delete(key); this.detach(port); });
    return port;
  }
  open(surface: "session" | "settings", id?: string) {
    if (surface === "session" && !this.service.sessions().some(s => s.id === id)) throw new Error("세션을 찾을 수 없습니다.");
    const key = this.key(surface, id);
    const existing = this.panels.get(key);
    if (existing) { existing.reveal(); return; }
    const panel = vscode.window.createWebviewPanel(`autoblogger.${surface}`, "Autoblogger", vscode.ViewColumn.Active, { enableScripts: true });
    this.attachPanel(panel, surface, id);
  }
  async focusMemo(bookmark: boolean) {
    await vscode.commands.executeCommand("autoblogger.recording.focus");
    for (const port of this.ports) if (port.surface === "recording") {
      port.state.bookmark = bookmark;
      await this.refreshPort(port);
      await port.webview.postMessage({ type: "focusMemo", bookmark });
    }
  }
  refresh() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const fingerprint = JSON.stringify(this.service.sessions());
      if (fingerprint !== this.treeVersion) { this.treeVersion = fingerprint; this.tree.refresh(); }
      for (const port of this.ports) void this.refreshPort(port);
    }, 120);
  }
  private async refreshPort(port: Port) {
    if (!port.ready || port.disposed || !port.visible()) return;
    const version = ++port.version;
    try {
      const model = await this.service.model(port.surface, port.sessionId, port.state);
      if (port.disposed || port.version !== version) return;
      const serialized = JSON.stringify({ model, view: port.state, sessionId: port.sessionId });
      if (serialized === port.last) return;
      port.last = serialized;
      await port.webview.postMessage({ type: "model", model, view: port.state, sessionId: port.sessionId });
    } catch (error) {
      await port.webview.postMessage({ type: "error", message: error instanceof Error ? error.message : "화면을 불러올 수 없습니다." });
    }
  }
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    for (const panel of this.panels.values()) panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.ports.clear();
  }
  async flush() { await Promise.all([...this.ports].map(port => port.queue)); await this.writes; }
}
