import * as vscode from "vscode";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { Journal } from "./journal";
import { Recorder, RunContext } from "./recorder";
import { BoundedOutput, MAX_FILE_BYTES, validateServiceUrl } from "./safety";
import { apiRequest, HttpError, syncJournals } from "./sync";
import { ExtensionUi, SessionItem } from "./ui/controller";
import { Action, defaults, Settings, Surface, validateSettings, ViewState } from "./ui/protocol";
import { eligiblePath, globMatches, readSafeText, withinRoot } from "./safety";

interface PendingEdit {
  before: string;
  after: string;
  version: number;
  unknown: boolean;
  timer: NodeJS.Timeout;
}
interface ActiveRun {
  recorder: Recorder;
  context: Promise<RunContext | undefined>;
  output: BoundedOutput;
  stream: Promise<void>;
}
interface PendingLogin {
  verifier: string;
  state: string;
  apiUrl: string;
  expiresAt: number;
}
const TOKEN_KEY = "autoblogger.deviceToken";
const LOGIN_KEY = "autoblogger.pendingLogin";
const IDLE_MS = 30 * 60 * 1000;

class Extension {
  private active?: Recorder;
  private journals: Journal[] = [];
  private baselines = new Map<string, string>();
  private edits = new Map<string, PendingEdit>();
  private runs = new Map<vscode.TerminalShellExecution, ActiveRun>();
  private timers: NodeJS.Timeout[] = [];
  private syncing = false;
  private nextSyncAt = 0;
  private failures = 0;
  private errorText = "";
  private ui?: ExtensionUi;
  private lastEditor?: { file: string; line: number };
  private actionQueue: Promise<unknown> = Promise.resolve();
  private summaryCache = new Map<string, { summaries: unknown[]; fetchedAt: string }>();
  private summaryAttempts = new Map<string, number>();
  private summariesLoading = new Set<string>();
  private summaryErrors = new Map<string, string>();
  private snapshots = new Map<string, string>();
  private readonly storage: string;
  private readonly status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    30,
  );
  private readonly output = vscode.window.createOutputChannel("Autoblogger");

  constructor(private readonly context: vscode.ExtensionContext) {
    this.storage = path.join(context.globalStorageUri.fsPath, "sessions");
    this.status.command = "autoblogger.status";
    context.subscriptions.push(this.status, this.output, {
      dispose: () => this.dispose(),
    });
  }
  private config(root = this.active?.journal.manifest.rootPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) {
    return vscode.workspace.getConfiguration("autoblogger", root ? vscode.Uri.file(root) : null);
  }
  private apiUrl() {
    return this.config()
      .get<string>("apiUrl", "http://127.0.0.1:4000/api")
      .replace(/\/$/, "");
  }
  private webUrl() {
    return this.config()
      .get<string>("webUrl", "http://localhost:3000")
      .replace(/\/$/, "");
  }

  async initialize(): Promise<void> {
    this.journals = await Journal.list(this.storage);
    for (const journal of this.journals)
      await new Recorder(journal).recoverInterruptedRuns();
    const open = this.journals.filter((journal) => journal.manifest.recording);
    for (const journal of open) {
      const recorder = new Recorder(journal);
      if (
        Date.now() - Date.parse(journal.manifest.lastActivityAt) >= IDLE_MS ||
        this.active
      )
        await recorder.stop("idle");
      else this.active = recorder;
    }
    for (const document of vscode.workspace.textDocuments)
      this.remember(document);
    if (this.active) await this.active.initialSnapshots();
    this.ui = await ExtensionUi.create(this.context, {
      sessions: () => this.sessionItems(),
      model: (surface, id, state) => this.uiModel(surface, id, state),
      action: (action, payload, id) => this.dispatch(action, payload, id),
    });
    this.context.subscriptions.push(this.ui);
    const capture = (editor: vscode.TextEditor | undefined) => {
      if (editor?.document.uri.scheme === "file") this.lastEditor = { file: editor.document.uri.fsPath, line: editor.selection.active.line + 1 };
      this.ui?.refresh();
    };
    capture(vscode.window.activeTextEditor);
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(capture),
      vscode.window.onDidChangeTextEditorSelection(event => capture(event.textEditor)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.ui?.refresh()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.ui?.refresh()),
      vscode.workspace.registerTextDocumentContentProvider("autoblogger-snapshot", { provideTextDocumentContent: uri => this.snapshots.get(uri.toString()) ?? "기록을 다시 열어 주세요." }),
    );
    const commands: Record<string, (...args: any[]) => unknown> = {
      start: () => this.dispatch("start", {}),
      stop: () => this.dispatch("stop", {}),
      note: () => this.note(false),
      bookmark: () => this.note(true),
      export: () => vscode.commands.executeCommand("autoblogger.sessions.focus"),
      connect: () => this.dispatch("connect", {}),
      disconnect: () => this.dispatch("disconnect", {}),
      sync: () => this.dispatch("sync", {}),
      exclude: () => this.dispatch("exclude", {}),
      status: () => this.showStatus(),
      openSettings: () => this.ui?.open("settings"),
      openSession: (id: string | { id: string }) => this.ui?.open("session", typeof id === "string" ? id : id?.id),
    };
    for (const [name, handler] of Object.entries(commands))
      this.context.subscriptions.push(
        vscode.commands.registerCommand(`autoblogger.${name}`, async (...args: any[]) => {
          try {
            return await handler(...args);
          } catch (error) {
            this.fail(error, true);
          }
        }),
      );
    this.context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) =>
        this.remember(document),
      ),
      vscode.workspace.onDidChangeTextDocument((event) => this.changed(event)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.saved(document).catch((error) => this.fail(error));
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        void this.flushEdit(document.uri.fsPath).catch((error) =>
          this.fail(error),
        );
        this.baselines.delete(document.uri.fsPath);
      }),
      vscode.window.onDidStartTerminalShellExecution((event) =>
        this.runStarted(event),
      ),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        void this.runEnded(event).catch((error) => this.fail(error));
      }),
      vscode.window.registerUriHandler({
        handleUri: (uri) =>
          this.callback(uri).catch((error) => this.fail(error, true)),
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("autoblogger"))
          void this.configurationChanged().catch((error) => this.fail(error));
      }),
    );
    this.timers.push(
      setInterval(() => {
        this.ui?.refresh();
        void this.sync().catch((error) => this.fail(error));
      }, 5000),
    );
    this.timers.push(
      setInterval(() => {
        if (
          this.active &&
          this.runs.size === 0 &&
          Date.now() -
            Date.parse(this.active.journal.manifest.lastActivityAt) >=
            IDLE_MS
        ) {
          void this.stop("idle").catch((error) => this.fail(error));
        }
      }, 10000),
    );
    this.render();
    if (this.active)
      void vscode.window.showInformationMessage(
        "Autoblogger: 이전 기록 세션을 복구했습니다.",
      );
  }

  private render(): void {
    const pending = this.journals.reduce(
      (sum, journal) => sum + journal.pendingCount(),
      0,
    );
    this.status.text = `${this.active ? "$(record) 기록 중" : "$(circle-slash) 기록 중지"}${pending ? ` · ${pending} 대기` : ""}${this.errorText ? " $(warning)" : ""}`;
    this.status.tooltip =
      this.errorText ||
      "Autoblogger — 통합 터미널 shell integration의 실행만 관찰합니다.";
    this.status.show();
    this.ui?.refresh();
  }
  private fail(error: unknown, notify = false): void {
    this.errorText = error instanceof Error ? error.message : "기록 처리 오류";
    this.output.appendLine(`${new Date().toISOString()} ${this.errorText}`);
    this.render();
    if (notify)
      void vscode.window.showErrorMessage(`Autoblogger: ${this.errorText}`);
  }
  private remember(document: vscode.TextDocument): void {
    if (
      this.active?.eligible(document.uri.fsPath) &&
      !document.isUntitled &&
      document.uri.scheme === "file"
    )
      this.baselines.set(document.uri.fsPath, document.getText());
  }

  private async start(root?: string): Promise<void> {
    if (this.active) {
      throw new Error("이미 기록 중입니다.");
    }
    if (!vscode.workspace.isTrusted)
      throw new Error("신뢰한 작업 폴더에서 기록을 시작하세요.");
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length)
      throw new Error("먼저 C/C++/Python 풀이가 있는 작업 폴더를 여세요.");
    const chosen = root ? folders.find(folder => folder.uri.fsPath === root) : folders.length === 1 ? folders[0] : undefined;
    if (!chosen) { await this.showStatus(); throw new Error("사이드바에서 기록할 작업 폴더를 선택하세요."); }
    const excludes = this.config(chosen.uri.fsPath).get<string[]>("excludePatterns", []);
    this.active = await Recorder.start(
      this.storage,
      chosen.uri.fsPath,
      excludes,
    );
    this.journals.push(this.active.journal);
    this.baselines.clear();
    for (const document of vscode.workspace.textDocuments)
      this.remember(document);
    this.errorText = "";
    await this.context.workspaceState.update("lastStop", undefined);
    this.render();
    void this.sync(true);
  }

  private changed(event: vscode.TextDocumentChangeEvent): void {
    const file = event.document.uri.fsPath;
    if (
      !this.active?.eligible(file) ||
      event.document.uri.scheme !== "file" ||
      !event.contentChanges.length
    )
      return;
    const after = event.document.getText();
    if (Buffer.byteLength(after) > MAX_FILE_BYTES) return;
    const previous = this.edits.get(file);
    if (previous) clearTimeout(previous.timer);
    const before = previous?.before ?? this.baselines.get(file);
    this.baselines.set(file, after);
    if (before === undefined) return;
    const unknown =
      previous?.unknown ||
      event.contentChanges.some(
        (change) =>
          change.text.length > 80 ||
          change.rangeLength > 80 ||
          change.text.split("\n").length > 3,
      );
    const timer = setTimeout(() => {
      void this.flushEdit(file).catch((error) => this.fail(error));
    }, 2000);
    this.edits.set(file, {
      before,
      after,
      version: event.document.version,
      unknown: !!unknown,
      timer,
    });
    this.render();
  }
  private async flushEdit(file: string): Promise<void> {
    const edit = this.edits.get(file);
    if (!edit) return;
    this.edits.delete(file);
    clearTimeout(edit.timer);
    await this.active?.edit(
      file,
      edit.before,
      edit.after,
      edit.version,
      edit.unknown,
    );
    this.render();
  }
  private async saved(document: vscode.TextDocument): Promise<void> {
    if (!this.active?.eligible(document.uri.fsPath)) return;
    await this.flushEdit(document.uri.fsPath);
    await this.active?.snapshot(document.uri.fsPath, document.version);
    this.remember(document);
    this.render();
  }

  private runStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    if (
      !this.active ||
      !event.execution.cwd ||
      event.execution.cwd.scheme !== "file"
    )
      return;
    const recorder = this.active;
    // read() must be called synchronously in the start callback to avoid losing initial output.
    const iterable = event.execution.read();
    const output = new BoundedOutput(
      this.config().get<number>("outputLimitBytes", 262144),
    );
    const stream = (async () => {
      try {
        for await (const chunk of iterable) output.append(chunk);
      } catch {
        /* terminal disappeared */
      }
    })();
    const context = recorder.beginRun(
      event.execution.commandLine.value,
      event.execution.cwd.fsPath,
    );
    this.runs.set(event.execution, { recorder, context, output, stream });
  }
  private async runEnded(
    event: vscode.TerminalShellExecutionEndEvent,
  ): Promise<void> {
    const run = this.runs.get(event.execution);
    if (!run) return;
    this.runs.delete(event.execution);
    await run.stream;
    const context = await run.context;
    if (context)
      await run.recorder.endRun(context, event.exitCode, run.output.value());
    this.render();
  }

  private async stop(
    reason: "manual" | "idle" | "remote" = "manual",
  ): Promise<void> {
    if (!this.active) return;
    for (const file of [...this.edits.keys()]) await this.flushEdit(file);
    await this.active.stop(reason);
    await this.context.workspaceState.update("lastStop", { reason, at: new Date().toISOString() });
    this.active = undefined;
    this.baselines.clear();
    this.render();
    if (reason !== "manual")
      void vscode.window.showInformationMessage(
        reason === "idle"
          ? "Autoblogger: 30분 유휴로 기록을 중지했습니다."
          : "Autoblogger: 웹 설정에 따라 기록을 중지했습니다.",
      );
    void this.sync(true);
  }
  private async note(bookmark: boolean): Promise<void> {
    if (!this.active) throw new Error("먼저 기록을 시작하세요.");
    await this.ui?.focusMemo(bookmark);
  }

  private async exportSession(id: string): Promise<string> {
    const journal = this.findJournal(id);
    if (this.active?.journal === journal)
      for (const file of [...this.edits.keys()]) await this.flushEdit(file);
    const snapshot = { schemaVersion: 1, source: "autoblogger-recorder", session: structuredClone(journal.manifest), events: journal.all() };
    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(journal.manifest.rootPath, `autoblogger-${id}.json`)),
      filters: { JSON: ["json"] },
    });
    if (!destination) return "내보내기를 취소했습니다.";
    await vscode.workspace.fs.writeFile(destination, Buffer.from(JSON.stringify(snapshot, null, 2)));
    return `${snapshot.events.length}번 사건까지 JSON으로 내보냈습니다.`;
  }

  private async connect(): Promise<void> {
    validateServiceUrl(this.apiUrl());
    validateServiceUrl(this.webUrl());
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const pending: PendingLogin = {
      verifier,
      state,
      apiUrl: this.apiUrl(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    await this.context.secrets.store(LOGIN_KEY, JSON.stringify(pending));
    const callback = await vscode.env.asExternalUri(
      vscode.Uri.parse(
        `${vscode.env.uriScheme}://${this.context.extension.id}/auth`,
      ),
    );
    const url = new URL(this.webUrl() + "/connect");
    url.searchParams.set("challenge", challenge);
    url.searchParams.set("state", state);
    url.searchParams.set("callback", callback.toString());
    url.searchParams.set(
      "name",
      `${vscode.env.appName} (${vscode.env.remoteName ?? process.platform})`,
    );
    this.render();
    if (!await vscode.env.openExternal(vscode.Uri.parse(url.toString()))) throw new Error("브라우저를 열지 못했습니다. 다시 연결하세요.");
  }
  private async callback(uri: vscode.Uri): Promise<void> {
    if (uri.path !== "/auth") return;
    const saved = await this.context.secrets.get(LOGIN_KEY);
    if (!saved)
      throw new Error("진행 중인 계정 연결이 없습니다. 다시 연결하세요.");
    const pending = JSON.parse(saved) as PendingLogin;
    const query = new URLSearchParams(uri.query),
      code = query.get("code");
    if (
      !code ||
      query.get("state") !== pending.state ||
      pending.expiresAt < Date.now() ||
      pending.apiUrl !== this.apiUrl()
    )
      throw new Error("만료되었거나 일치하지 않는 계정 연결입니다.");
    const result = await apiRequest<{ token: string; device: { id: string } }>(
      pending.apiUrl,
      undefined,
      "/devices/exchange",
      "POST",
      { code, verifier: pending.verifier },
    );
    await this.context.secrets.store(TOKEN_KEY, result.token);
    await this.context.secrets.delete(LOGIN_KEY);
    await this.context.globalState.update("deviceId", result.device.id);
    await this.context.globalState.update("deviceApiUrl", pending.apiUrl);
    try {
      const me = await apiRequest<{ email?: string; id: string }>(pending.apiUrl, result.token, "/me");
      await this.context.globalState.update("accountLabel", me.email || me.id);
    } catch { await this.context.globalState.update("accountLabel", undefined); }
    this.errorText = "";
    this.render();
    await this.sync(true);
  }
  private async disconnect(): Promise<void> {
    this.errorText = "";
    const token = await this.context.secrets.get(TOKEN_KEY);
    const id = this.context.globalState.get<string>("deviceId");
    if (token && id) {
      try {
        await apiRequest(
          this.context.globalState.get<string>("deviceApiUrl") || this.apiUrl(),
          token,
          `/devices/${encodeURIComponent(id)}`,
          "DELETE",
        );
      } catch {
        this.errorText = "로컬 연결 해제 완료. 서버 기기 폐기에 실패했습니다. 웹 데이터 관리에서 폐기 여부를 확인하세요.";
        void vscode.window.showWarningMessage(
          "로컬 연결은 해제합니다. 서버가 연결되지 않아 기기 폐기는 웹 설정에서 확인하세요.",
        );
      }
    }
    await this.context.secrets.delete(TOKEN_KEY);
    await this.context.secrets.delete(LOGIN_KEY);
    await this.context.globalState.update("deviceId", undefined);
    await this.context.globalState.update("deviceApiUrl", undefined);
    await this.context.globalState.update("accountLabel", undefined);
    this.render();
  }

  private async sync(force = false): Promise<void> {
    if (
      this.syncing ||
      (!force &&
        (!this.config().get<boolean>("autoSync", true) ||
          Date.now() < this.nextSyncAt))
    )
      return;
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (!token) return;
    if (
      this.context.globalState.get<string>("deviceApiUrl") !== this.apiUrl()
    ) {
      this.fail(
        new Error("API 주소가 변경되었습니다. 계정을 다시 연결하세요."),
      );
      return;
    }
    this.syncing = true;
    this.render();
    try {
      await syncJournals({
        apiUrl: this.apiUrl(),
        token,
        journals: this.journals,
        active: this.active,
        onRemoteStop: () => this.stop("remote"),
      });
      this.failures = 0;
      this.errorText = "";
      await this.context.globalState.update("lastSyncedAt", new Date().toISOString());
    } catch (error) {
      this.failures++;
      if (error instanceof HttpError && error.status === 401) {
        await this.context.secrets.delete(TOKEN_KEY);
        this.fail(
          new Error(
            "기기 인증이 만료되거나 폐기되었습니다. 다시 계정을 연결하세요.",
          ),
          force,
        );
      } else this.fail(error, force);
    } finally {
      this.syncing = false;
      this.nextSyncAt =
        Date.now() +
        Math.min(
          300000,
          this.config().get<number>("syncIntervalSeconds", 15) *
            1000 *
            2 ** Math.min(5, this.failures),
        );
      this.render();
    }
  }
  private async exclude(file = this.lastEditor?.file): Promise<void> {
    if (!file || !this.active?.eligible(file))
      throw new Error("기록 중인 대상 파일을 먼저 여세요.");
    const pattern = path
      .relative(this.active.journal.manifest.rootPath, file)
      .split(path.sep)
      .join("/");
    const excluded = [
      ...new Set([
        ...this.config().get<string[]>("excludePatterns", []),
        pattern,
      ]),
    ];
    const pending = this.edits.get(file);
    if (pending) clearTimeout(pending.timer);
    this.edits.delete(file);
    this.baselines.delete(file);
    await this.config().update(
      "excludePatterns",
      excluded,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
    await this.active.journal.update({ excludePatterns: [...new Set([...excluded, ...(this.active.journal.manifest.remoteExcludePatterns ?? [])])] });
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (token && this.active.journal.manifest.projectId && this.context.globalState.get<string>("deviceApiUrl") === this.apiUrl()) {
      try {
        await apiRequest(
          this.apiUrl(),
          token,
          `/projects/${this.active.journal.manifest.projectId}`,
          "PATCH",
          { excludePatterns: excluded },
        );
      } catch {
        this.fail(
          new Error(
            "파일 제외는 로컬에 적용했습니다. 웹 설정 동기화는 연결 후 확인하세요.",
          ),
        );
      }
    }
    this.render();
  }
  private async configurationChanged(): Promise<void> {
    if (this.active)
      await this.active.journal.update({
        excludePatterns: [...new Set([...this.config().get<string[]>("excludePatterns", []), ...(this.active.journal.manifest.remoteExcludePatterns ?? [])])],
      });
    this.nextSyncAt = 0;
    this.render();
  }
  private async showStatus(): Promise<void> {
    await vscode.commands.executeCommand("autoblogger.recording.focus");
  }
  private sessionItems(): SessionItem[] {
    return this.journals.map(journal => ({ ...journal.manifest, pending: journal.pendingCount(), count: journal.count }));
  }
  private findJournal(id: string): Journal {
    const journal = this.journals.find(journal => journal.manifest.id === id);
    if (!journal) throw new Error("세션을 찾을 수 없습니다. 세션 목록에서 다시 선택하세요.");
    return journal;
  }
  private settings(root?: string): Settings {
    const config = this.config(root);
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, config.get(key, value)])) as Settings;
  }
  private async uiModel(surface: Surface, id: string | undefined, state: ViewState) {
    const root = (surface === "settings" ? state.root : undefined) || this.active?.journal.manifest.rootPath || state.root || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const token = await this.context.secrets.get(TOKEN_KEY);
    const pending = await this.context.secrets.get(LOGIN_KEY);
    const login = pending ? JSON.parse(pending) as PendingLogin : undefined;
    const settings = this.settings(root);
    const boundApi = this.context.globalState.get<string>("deviceApiUrl");
    const connection = login && login.expiresAt > Date.now() ? "connecting" : token ? boundApi === this.apiUrl() ? "connected" : "changed" : "disconnected";
    const last = this.lastEditor;
    const targetFile = root && last && eligiblePath(root, last.file, this.active?.journal.manifest.excludePatterns ?? settings.excludePatterns) ? last.file : undefined;
    const readable = targetFile && root ? await readSafeText(root, targetFile) !== undefined : false;
    const target = { sessionId: this.active?.journal.manifest.id ?? "", ...(targetFile && readable ? { file: targetFile, line: last?.line } : {}) };
    const base = {
      active: this.active ? { ...this.active.journal.manifest, count: this.active.journal.count } : undefined,
      folders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({ name: folder.name, path: folder.uri.fsPath })),
      root, trusted: vscode.workspace.isTrusted, target,
      currentFile: last?.file, collection: targetFile && readable ? "수집 대상" : last ? "수집 제외: 지원 확장자·제외 규칙·크기·프로젝트 경계를 확인하세요." : "코드 파일을 열면 수집 상태가 표시됩니다.",
      connection, deviceId: this.context.globalState.get<string>("deviceId"),
      account: this.context.globalState.get<string>("accountLabel"),
      pending: this.journals.reduce((sum, journal) => sum + journal.pendingCount(), 0),
      syncing: this.syncing, autoSync: settings.autoSync, error: this.errorText,
      lastSyncedAt: this.context.globalState.get<string>("lastSyncedAt"),
      terminals: vscode.window.terminals.filter(terminal => terminal.shellIntegration?.cwd).length,
      host: vscode.env.remoteName || "로컬", apiUrl: this.apiUrl(),
      elapsedMinutes: this.active ? Math.floor((Date.now() - Date.parse(this.active.journal.manifest.startedAt)) / 60000) : 0,
      lastStop: this.context.workspaceState.get("lastStop"),
    };
    if (surface === "settings") return { ...base, settings, defaults, revision: JSON.stringify(settings), remoteExcludes: this.active?.journal.manifest.remoteExcludePatterns ?? [],
      settingSources: Object.fromEntries(Object.keys(defaults).map(key => {
        const inspected = this.config(root).inspect(key);
        return [key, inspected?.workspaceFolderValue !== undefined ? "폴더" : inspected?.workspaceValue !== undefined ? "작업 영역" : inspected?.globalValue !== undefined ? "사용자/원격 사용자" : "기본값"];
      })), excludedFiles: this.active?.journal.overview().filter(e => e.filePath && settings.excludePatterns.some(p => globMatches(p, e.filePath!))).map(e => e.filePath).filter((value, index, list) => list.indexOf(value) === index) ?? [] };
    if (surface !== "session" || !id) return base;
    const journal = this.findJournal(id);
    const overview = journal.overview();
    const files = [...new Map(overview.filter(e => e.fileId).map(e => [e.fileId!, { id: e.fileId!, path: e.filePath! }])).values()];
    const filtered = overview.filter(e => (!state.file || e.fileId === state.file) && (!state.kind || e.type === state.kind) && (state.tab !== "notes" || e.type === "memo") && (state.tab !== "files" || ["snapshot", "edit", "run"].includes(e.type))).sort((a,b) => a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence);
    const page = Math.min(state.page ?? 0, Math.max(0, Math.ceil(filtered.length / 60) - 1));
    const events = filtered.slice(page * 60, (page + 1) * 60);
    const selected = state.eventId ? journal.event(state.eventId) : undefined;
    const webReason = connection !== "connected" ? "계정을 연결하세요." : !journal.manifest.serverCreated || journal.pendingCount() ? "이 세션의 동기화를 완료하세요." : journal.manifest.apiUrl !== this.apiUrl() ? "이 세션을 연결한 서버로 설정하세요." : "";
    if (!webReason && token && Date.now() - (this.summaryAttempts.get(id) ?? 0) > 15000 && !this.summariesLoading.has(id)) {
      void this.fetchSummaries(journal, token).catch(error => this.summaryErrors.set(id, error instanceof Error ? error.message : "요약을 불러오지 못했습니다."));
    }
    return { ...base, session: journal.manifest, events, total: filtered.length, count: journal.count, page, files, selected, sessionPending: journal.pendingCount(),
      gaps: overview.filter(e => !e.acknowledged).slice(0,100).map(e => e.sequence), webReason,
      summary: this.summaryCache.get(id) ?? this.context.globalState.get(`summary.${id}`),
      summaryError: this.summaryErrors.get(id),
    };
  }
  private dispatch(action: Action, payload: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    const next = this.actionQueue.then(() => this.uiAction(action, payload, sessionId));
    this.actionQueue = next.catch(() => undefined);
    return next.finally(() => this.render());
  }
  private async fetchSummaries(journal: Journal, token: string) {
    const id = journal.manifest.id;
    if (this.summariesLoading.has(id)) return;
    this.summaryAttempts.set(id, Date.now()); this.summariesLoading.add(id);
    try {
      const remote = await apiRequest<{ summaries: Array<{ summary?: string; text?: string; createdAt?: string }> }>(this.apiUrl(), token, `/sessions/${id}`);
      const value = { summaries: (remote.summaries ?? []).slice(-30).map(s => ({ text: String(s.summary || s.text || "").slice(0, 4000), createdAt: s.createdAt })), fetchedAt: new Date().toISOString() };
      this.summaryCache.set(id, value); this.summaryErrors.delete(id);
      await this.context.globalState.update(`summary.${id}`, value);
    } finally { this.summariesLoading.delete(id); this.ui?.refresh(); }
  }
  private async uiAction(action: Action, payload: Record<string, unknown>, panelSessionId?: string): Promise<unknown> {
    const id = panelSessionId ?? (typeof payload.sessionId === "string" ? payload.sessionId : this.active?.journal.manifest.id);
    const journal = id ? this.findJournal(id) : undefined;
    switch (action) {
      case "start": await this.start(typeof payload.root === "string" ? payload.root : undefined); return "기록을 시작했습니다.";
      case "stop": await this.stop(); return "기록을 중지했습니다.";
      case "settings": this.ui?.open("settings"); return;
      case "session": if (id) this.ui?.open("session", id); return;
      case "folder": await vscode.commands.executeCommand("vscode.openFolder"); return;
      case "trust": await vscode.commands.executeCommand("workbench.trust.manage"); return;
      case "terminal": await vscode.commands.executeCommand("workbench.action.terminal.toggleTerminal"); return;
      case "shellHelp": await vscode.env.openExternal(vscode.Uri.parse("https://code.visualstudio.com/docs/terminal/shell-integration")); return;
      case "logs": this.output.show(); return;
      case "connect": this.ui?.open("settings"); await this.connect(); return "브라우저에서 로그인한 뒤 VS Code로 돌아오세요.";
      case "cancelConnect": await this.context.secrets.delete(LOGIN_KEY); return "계정 연결을 취소했습니다.";
      case "disconnect": await this.disconnect(); return "이 기기의 로컬 연결을 해제했습니다. 기록은 보존됩니다.";
      case "sync": await this.sync(true); if (this.errorText) throw new Error(this.errorText); return "동기화 상태를 확인했습니다.";
      case "export": if (!id) throw new Error("세션을 선택하세요."); return this.exportSession(id);
      case "memo": {
        const target = payload.target as { sessionId?: string; file?: string; line?: number } | undefined;
        if (!this.active || !target || target.sessionId !== this.active.journal.manifest.id || (panelSessionId && panelSessionId !== target.sessionId)) throw new Error("메모의 대상 세션이 종료되었거나 바뀌었습니다. 입력 내용은 보존됩니다.");
        if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 16384) throw new Error("메모는 1~16,384자로 입력하세요.");
        if (target.file !== undefined && (typeof target.file !== "string" || !this.active.eligible(target.file))) throw new Error("메모 대상 파일이 수집 범위 밖입니다.");
        if (target.line !== undefined && (!Number.isInteger(target.line) || target.line < 1)) throw new Error("메모의 줄 번호가 잘못되었습니다.");
        await this.active.memo(target.file, payload.text, target.line, payload.bookmark === true);
        return { message: "메모를 저장했습니다.", clearDraft: true };
      }
      case "exclude": {
        const file = typeof payload.file === "string" ? payload.file : this.lastEditor?.file;
        await this.exclude(file); return "이후 수집에서 제외했습니다. 기존 기록은 보존됩니다.";
      }
      case "saveSettings": {
        const root = typeof payload.root === "string" ? payload.root : undefined;
        if (root && !vscode.workspace.workspaceFolders?.some(f => f.uri.fsPath === root)) throw new Error("열린 작업 폴더를 선택하세요.");
        const values = validateSettings(payload.values);
        const config = this.config(root);
        if (payload.revision !== JSON.stringify(this.settings(root))) throw new Error("다른 화면에서 설정이 바뀌었습니다. 최신 값 불러오기를 누른 뒤 다시 저장하세요.");
        const target = payload.scope === "folder" && root ? vscode.ConfigurationTarget.WorkspaceFolder : payload.scope === "workspace" && vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : payload.scope === "user" ? vscode.ConfigurationTarget.Global : undefined;
        if (target === undefined) throw new Error("설정 저장 범위를 선택하세요.");
        for (const [key, value] of Object.entries(values)) await config.update(key, value, target);
        await this.configurationChanged(); return { message: "설정을 저장했습니다.", settingsSaved: true, revision: JSON.stringify(this.settings(root)) };
      }
      case "file": case "snapshot": case "diff": {
        if (!journal || typeof payload.eventId !== "string") throw new Error("사건을 선택하세요.");
        const event = journal.event(payload.eventId);
        if (!event) throw new Error("사건을 찾을 수 없습니다.");
        if (action === "file") {
          if (!event.filePath) throw new Error("연결된 파일이 없습니다.");
          const file = path.resolve(journal.manifest.rootPath, event.filePath);
          if (!withinRoot(journal.manifest.rootPath, file) || await readSafeText(journal.manifest.rootPath, file) === undefined) throw new Error("현재 파일을 열 수 없습니다. 보존된 스냅샷을 확인하세요.");
          await vscode.window.showTextDocument(vscode.Uri.file(file)); return "현재 작업 파일입니다. 기록 당시 코드와 다를 수 있습니다.";
        }
        const selected = event.type === "run" ? journal.event(String(event.data.snapshotId)) : event;
        if (!selected) throw new Error("연결된 코드 버전이 없습니다.");
        const uriFor = (suffix: string, text: string) => {
          const uri = vscode.Uri.from({ scheme: "autoblogger-snapshot", path: `/${journal.manifest.id}/${selected.id}/${suffix}/${selected.filePath ?? "code.txt"}` });
          this.snapshots.set(uri.toString(), text); return uri;
        };
        if (action === "snapshot") {
          if (selected.type !== "snapshot") throw new Error("스냅샷 또는 실행 사건을 선택하세요.");
          await vscode.window.showTextDocument(uriFor("snapshot", String(selected.data.content ?? "")), { preview: false });
        } else {
          if (!["snapshot", "edit"].includes(selected.type)) throw new Error("코드 저장·수정 사건을 선택하세요.");
          if (selected.data.truncated) throw new Error("큰 편집의 원문이 생략되었습니다. 저장 스냅샷으로 비교하세요.");
          const previous = selected.fileId ? journal.previousSnapshot(selected.fileId, selected.sequence) : undefined;
          const before = String(selected.type === "edit" ? selected.data.before ?? "" : previous?.data.content ?? "");
          const after = String(selected.type === "edit" ? selected.data.after ?? "" : selected.data.content ?? "");
          await vscode.commands.executeCommand("vscode.diff", uriFor("before", before), uriFor("after", after), `${selected.filePath} · 기록 비교`);
        }
        return;
      }
      case "summaries": case "web": case "webSettings": {
        validateServiceUrl(this.webUrl());
        if (action === "webSettings") { await vscode.env.openExternal(vscode.Uri.parse(this.webUrl() + "/?view=settings")); return; }
        const token = await this.context.secrets.get(TOKEN_KEY);
        if (!token || this.context.globalState.get<string>("deviceApiUrl") !== this.apiUrl()) throw new Error("계정을 연결하세요.");
        if (!journal?.manifest.serverCreated || journal.manifest.apiUrl !== this.apiUrl() || journal.pendingCount()) throw new Error("이 세션의 동기화를 완료하세요.");
        if (action === "summaries") {
          await this.fetchSummaries(journal, token); return "서버 요약을 갱신했습니다.";
        }
        const remote = await apiRequest<{ files: Array<{ id: string }> }>(this.apiUrl(), token, `/sessions/${journal.manifest.id}`);
        const url = new URL(this.webUrl()); url.searchParams.set("session", journal.manifest.id);
        if (typeof payload.fileId === "string" && payload.fileId) {
          if (!remote.files.some(file => file.id === payload.fileId)) throw new Error("선택한 파일을 서버에서 찾을 수 없습니다.");
          url.searchParams.set("file", payload.fileId);
        }
        await vscode.env.openExternal(vscode.Uri.parse(url.toString())); return;
      }
    }
  }
  async shutdown(): Promise<void> {
    await this.ui?.flush();
    for (const file of [...this.edits.keys()]) await this.flushEdit(file);
    // Keep recording manifest open to resume after extension-host restart. Idle timeout still applies.
  }
  private dispose(): void {
    for (const timer of this.timers) clearInterval(timer);
    for (const edit of this.edits.values()) clearTimeout(edit.timer);
  }
}

let instance: Extension | undefined;
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  instance = new Extension(context);
  try {
    await instance.initialize();
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Autoblogger 복구 실패: ${(error as Error).message}. 원본 로컬 기록은 보존되어 있습니다.`,
    );
  }
}
export async function deactivate(): Promise<void> {
  await instance?.shutdown();
}
