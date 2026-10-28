import * as vscode from "vscode";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { Journal } from "./journal";
import { Recorder, RunContext } from "./recorder";
import { BoundedOutput, MAX_FILE_BYTES, validateServiceUrl } from "./safety";
import { apiRequest, HttpError, syncJournals } from "./sync";

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
  private config() {
    return vscode.workspace.getConfiguration("autoblogger");
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
    const commands: Record<string, () => unknown> = {
      start: () => this.start(),
      stop: () => this.stop(),
      note: () => this.note(false),
      bookmark: () => this.note(true),
      export: () => this.export(),
      connect: () => this.connect(),
      disconnect: () => this.disconnect(),
      sync: () => this.sync(true),
      exclude: () => this.exclude(),
      status: () => this.showStatus(),
    };
    for (const [name, handler] of Object.entries(commands))
      this.context.subscriptions.push(
        vscode.commands.registerCommand(`autoblogger.${name}`, async () => {
          try {
            await handler();
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

  private async start(): Promise<void> {
    if (this.active) {
      await vscode.window.showInformationMessage("이미 기록 중입니다.");
      return;
    }
    if (!vscode.workspace.isTrusted)
      throw new Error("신뢰한 작업 폴더에서 기록을 시작하세요.");
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length)
      throw new Error("먼저 C/C++/Python 풀이가 있는 작업 폴더를 여세요.");
    const chosen =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({
            placeHolder: "기록할 문제 풀이 폴더",
          });
    if (!chosen) return;
    const excludes = this.config().get<string[]>("excludePatterns", []);
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
    this.render();
    await vscode.window.showInformationMessage(
      "기록을 시작했습니다. 통합 터미널에서 직접 실행하세요. 확장은 컴파일·실행하지 않습니다.",
    );
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
    const editor = vscode.window.activeTextEditor;
    const text = await vscode.window.showInputBox({
      prompt: bookmark ? "북마크 설명" : "당시 판단·저지 결과 등 메모",
      value: bookmark ? "북마크" : "",
    });
    if (text === undefined || !text.trim()) return;
    await this.active.memo(
      editor?.document.uri.fsPath,
      text,
      editor ? editor.selection.active.line + 1 : undefined,
      bookmark,
    );
    this.render();
  }

  private async export(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      this.journals
        .map((journal) => ({
          label: journal.manifest.name,
          description: journal.manifest.startedAt,
          detail: journal.manifest.recording ? "기록 중" : "종료",
          journal,
        }))
        .reverse(),
      { placeHolder: "내보낼 세션" },
    );
    if (!choice) return;
    if (this.active?.journal === choice.journal)
      for (const file of [...this.edits.keys()]) await this.flushEdit(file);
    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(
          choice.journal.manifest.rootPath,
          `autoblogger-${choice.journal.manifest.id}.json`,
        ),
      ),
      filters: { JSON: ["json"] },
    });
    if (!destination) return;
    await vscode.workspace.fs.writeFile(
      destination,
      Buffer.from(
        JSON.stringify(
          {
            schemaVersion: 1,
            source: "autoblogger-recorder",
            session: choice.journal.manifest,
            events: choice.journal.all(),
          },
          null,
          2,
        ),
      ),
    );
    await vscode.window.showInformationMessage("세션 JSON을 내보냈습니다.");
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
    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
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
    this.errorText = "";
    await vscode.window.showInformationMessage(
      "Autoblogger 계정을 연결했습니다. 기기는 웹 설정에서 폐기할 수 있습니다.",
    );
    await this.sync(true);
  }
  private async disconnect(): Promise<void> {
    const token = await this.context.secrets.get(TOKEN_KEY);
    const id = this.context.globalState.get<string>("deviceId");
    if (token && id) {
      try {
        await apiRequest(
          this.apiUrl(),
          token,
          `/devices/${encodeURIComponent(id)}`,
          "DELETE",
        );
      } catch {
        void vscode.window.showWarningMessage(
          "로컬 연결은 해제합니다. 서버가 연결되지 않아 기기 폐기는 웹 설정에서 확인하세요.",
        );
      }
    }
    await this.context.secrets.delete(TOKEN_KEY);
    await this.context.secrets.delete(LOGIN_KEY);
    await this.context.globalState.update("deviceId", undefined);
    await this.context.globalState.update("deviceApiUrl", undefined);
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
  private async exclude(): Promise<void> {
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
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
      vscode.ConfigurationTarget.Workspace,
    );
    await this.active.journal.update({ excludePatterns: excluded });
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (token && this.active.journal.manifest.projectId) {
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
    await vscode.window.showInformationMessage(
      `${pattern}: 이후 수집에서 제외했습니다. 이전 기록 삭제는 웹에서 가능합니다.`,
    );
  }
  private async configurationChanged(): Promise<void> {
    if (this.active)
      await this.active.journal.update({
        excludePatterns: this.config().get<string[]>("excludePatterns", []),
      });
    this.nextSyncAt = 0;
    this.render();
  }
  private async showStatus(): Promise<void> {
    const pending = this.journals.reduce(
      (sum, journal) => sum + journal.pendingCount(),
      0,
    );
    const terminals = vscode.window.terminals.filter(
      (terminal) => terminal.shellIntegration,
    ).length;
    await vscode.window
      .showInformationMessage(
        `Autoblogger · ${this.active ? this.active.journal.manifest.name + " 기록 중" : "기록 중지"} · ${pending}개 전송 대기 · shell integration 터미널 ${terminals}개. ${terminals ? "" : "실행 정보 없음: 통합 터미널의 shell integration을 활성화하세요."}`,
        "기록 시작/중지",
        "동기화",
        "로그",
      )
      .then(async (selection) => {
        if (selection === "기록 시작/중지")
          await (this.active ? this.stop() : this.start());
        if (selection === "동기화") await this.sync(true);
        if (selection === "로그") this.output.show();
      });
  }
  async shutdown(): Promise<void> {
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
