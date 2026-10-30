"use client";
import { Fragment, useMemo, useState } from "react";
import {
  FileCode2,
  FileText,
  Terminal,
  MessageSquare,
  Bookmark,
  GitCompareArrows,
  FileDown,
  Trash2,
  Sparkles,
  Square,
  ChevronDown,
  ChevronRight,
  Clock3,
  ShieldCheck,
  NotebookPen,
} from "lucide-react";
import { api, patch, download, date, time, money } from "@/lib/api";
import {
  diffLines,
  diffStat,
  withContext,
  type DiffRow,
} from "@/lib/line-diff";
import type { Article, RecordEvent, SessionDetail } from "@/lib/types";
import {
  Badge,
  Empty,
  Modal,
  PageHead,
  articleStatusLabel,
  useMediaQuery,
} from "./ui";
export const eventName = (event: RecordEvent) =>
  event.type === "run"
    ? "터미널 실행"
    : event.type === "snapshot"
      ? "코드 저장"
      : event.type === "edit"
        ? "코드 수정"
        : event.type === "memo"
          ? event.data.bookmark
            ? "북마크"
            : "메모"
          : event.type === "session_start"
            ? "기록 시작"
            : "기록 종료";
const safe = (value: unknown) =>
  value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
const runStatuses: Record<string, string> = {
  success: "정상 종료",
  normal_exit: "정상 종료",
  compile_error: "컴파일 에러",
  runtime_error: "런타임 에러",
  unknown: "판단 불가",
};
// Color is reserved for what needs attention: errors. A normal exit is not
// a correct answer, so it stays neutral.
const runTone = (status: string) =>
  status.includes("error") ? "red" : "neutral";
function RunStatus({ status }: { status: string }) {
  return <Badge tone={runTone(status)}>{runStatuses[status] || status}</Badge>;
}
const eventIcon = (event: RecordEvent) =>
  event.type === "run"
    ? Terminal
    : event.type === "edit"
      ? GitCompareArrows
      : event.type === "memo"
        ? event.data.bookmark
          ? Bookmark
          : MessageSquare
        : event.type === "snapshot"
          ? FileCode2
          : ShieldCheck;
const sameFile = (a: RecordEvent, b: RecordEvent) =>
  (a.fileId || a.filePath) === (b.fileId || b.filePath);
const lineCount = (value: unknown) =>
  safe(value).replace(/\n$/, "").split("\n").length;
const firstLine = (value: unknown) => safe(value).trim().split("\n")[0];
function previous(event: RecordEvent, events: RecordEvent[]) {
  const index = events.indexOf(event);
  for (let i = index - 1; i >= 0; i--)
    if (events[i].type === event.type && sameFile(events[i], event))
      return events[i];
  return undefined;
}
function codeChange(event: RecordEvent, events: RecordEvent[]) {
  const data = event.data;
  if (event.type === "edit" && (data.before != null || data.after != null))
    return diffLines(safe(data.before), safe(data.after));
  if (event.type === "snapshot") {
    const before = previous(event, events);
    if (before) return diffLines(safe(before.data.content), safe(data.content));
  }
  return undefined;
}
type Insight = { rows?: DiffRow[]; resultChanged?: boolean };
function useInsights(events: RecordEvent[]) {
  return useMemo(() => {
    const map = new Map<string, Insight>();
    for (const event of events) {
      if (event.type === "edit" || event.type === "snapshot")
        map.set(event.id, { rows: codeChange(event, events) });
      if (event.type === "run") {
        const before = previous(event, events);
        map.set(event.id, {
          resultChanged:
            !!before &&
            (before.data.status !== event.data.status ||
              safe(before.data.output).trim() !==
                safe(event.data.output).trim()),
        });
      }
    }
    return map;
  }, [events]);
}
function DiffStat({ rows }: { rows: DiffRow[] }) {
  const stat = diffStat(rows);
  return (
    <span className="diffstat">
      <ins>+{stat.added}</ins>
      <del>−{stat.removed}</del>
    </span>
  );
}
function EventSummary({
  event,
  insight,
}: {
  event: RecordEvent;
  insight?: Insight;
}) {
  const data = event.data;
  if (event.type === "run")
    return (
      <>
        <RunStatus status={String(data.status || "unknown")} />
        {insight?.resultChanged && <Badge tone="amber">결과 변화</Badge>}
        <code title={safe(data.command)}>
          {firstLine(data.output) || "출력 없음"}
        </code>
        {data.durationMs != null && (
          <span className="event-aside">
            {Number(data.durationMs).toLocaleString()}ms
          </span>
        )}
      </>
    );
  if (event.type === "memo")
    return <span className="event-quote">{firstLine(data.text)}</span>;
  if (event.type === "edit")
    return (
      <>
        {insight?.rows ? (
          <DiffStat rows={insight.rows} />
        ) : (
          <span className="event-aside">변경 내용 기록</span>
        )}
        {data.source === "unknown" && <Badge>출처 미확인</Badge>}
      </>
    );
  if (event.type === "snapshot")
    return insight?.rows ? (
      <DiffStat rows={insight.rows} />
    ) : (
      <span className="event-aside">첫 저장 · {lineCount(data.content)}줄</span>
    );
  return null;
}
function CodeDiff({ rows }: { rows: DiffRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const pieces = expanded ? rows : withContext(rows, 3);
  const pageSize = 500;
  const lastPage = Math.max(0, Math.ceil(pieces.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = pieces.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  if (!pieces.length) return <p className="detail-note">코드 변경 없음</p>;
  return (
    <div className="code-diff">
      {lastPage > 0 && (
        <nav aria-label="코드 비교 페이지" className="row between">
          <button
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            이전 코드 비교
          </button>
          <span>
            {currentPage + 1} / {lastPage + 1} · 최대 {pageSize}줄씩 표시
          </span>
          <button
            disabled={currentPage === lastPage}
            onClick={() => setPage(currentPage + 1)}
          >
            다음 코드 비교
          </button>
        </nav>
      )}
      <table>
        <tbody>
          {visible.map((piece, index) =>
            piece.type === "gap" ? (
              <tr key={index} className="gap">
                <td colSpan={3}>
                  <button
                    onClick={() => {
                      setExpanded(true);
                      setPage(0);
                    }}
                  >
                    변경 없는 {piece.hidden}줄 펼치기
                  </button>
                </td>
              </tr>
            ) : (
              <tr key={index} className={piece.type}>
                <td className="ln">{piece.oldNo ?? ""}</td>
                <td className="ln">{piece.newNo ?? ""}</td>
                <td className="src">
                  <span
                    className="sign"
                    aria-label={
                      piece.type === "add"
                        ? "추가"
                        : piece.type === "del"
                          ? "삭제"
                          : undefined
                    }
                  >
                    {piece.type === "add"
                      ? "+"
                      : piece.type === "del"
                        ? "−"
                        : " "}
                  </span>
                  {piece.text || " "}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
export function EventDetail({
  event,
  events = [],
}: {
  event: RecordEvent;
  events?: RecordEvent[];
}) {
  const data = event.data;
  const rows = useMemo(() => codeChange(event, events), [event, events]);
  if (event.type === "run") {
    const snapshot = events.find((e) => e.id === data.snapshotId);
    return (
      <div className="event-detail">
        <div className="run-meta">
          <RunStatus status={String(data.status || "unknown")} />
          <span>종료 코드 {safe(data.exitCode) || "없음"}</span>
          <span>{Number(data.durationMs || 0).toLocaleString()}ms</span>
        </div>
        <pre className="command">$ {safe(data.command)}</pre>
        <pre className="code output">{safe(data.output) || "출력 없음"}</pre>
        <p className="detail-note">
          정상 종료는 정답 여부를 의미하지 않습니다.
        </p>
        {data.inputSnapshot != null && (
          <details>
            <summary>리다이렉션 입력</summary>
            <pre className="code">{safe(data.inputSnapshot)}</pre>
          </details>
        )}
        {snapshot ? (
          <details>
            <summary>이 실행에 연결된 코드 버전</summary>
            <pre className="code">{safe(snapshot.data.content)}</pre>
          </details>
        ) : (
          <p className="detail-note">연결된 코드 버전 정보 없음</p>
        )}
      </div>
    );
  }
  if (event.type === "snapshot") {
    const before = rows && previous(event, events);
    return (
      <div className="event-detail">
        {rows && before ? (
          <>
            <p className="detail-note first">
              이전 저장({time(before.occurredAt)}) 이후 바뀐 부분
            </p>
            <CodeDiff key={event.id} rows={rows} />
            <details>
              <summary>이 시점의 전체 코드</summary>
              <pre className="code">{safe(data.content)}</pre>
            </details>
          </>
        ) : (
          <>
            <p className="detail-note first">이 파일의 첫 저장입니다.</p>
            <pre className="code">{safe(data.content)}</pre>
          </>
        )}
      </div>
    );
  }
  if (event.type === "edit")
    return (
      <div className="event-detail">
        {rows ? (
          <CodeDiff key={event.id} rows={rows} />
        ) : (
          <pre className="code raw-diff">
            {safe(data.diff)
              .split("\n")
              .map((line, i) => (
                <span
                  key={i}
                  className={
                    line.startsWith("+")
                      ? "add"
                      : line.startsWith("-")
                        ? "del"
                        : undefined
                  }
                >
                  {line + "\n"}
                </span>
              ))}
          </pre>
        )}
        {data.source === "unknown" && (
          <p className="detail-note">
            <Badge>출처 미확인</Badge> 편집기 밖에서 바뀐 내용일 수 있습니다.
          </p>
        )}
      </div>
    );
  if (event.type === "memo")
    return (
      <blockquote className="memo-text">
        {safe(data.text)}
        {data.line != null && <small>{safe(data.line)}행</small>}
      </blockquote>
    );
  return (
    <p className="muted">
      {event.type === "session_start"
        ? "이 세션의 기록을 시작했습니다."
        : "이 세션의 기록을 종료했습니다."}
    </p>
  );
}
const citation = /^\[[0-9a-f\-,\s]+\]$/i,
  uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function SummaryText({
  text,
  events,
  onCite,
}: {
  text: string;
  events: RecordEvent[];
  onCite: (id: string) => void;
}) {
  return (
    <>
      {text.split(/(\[[0-9a-f\-,\s]+\])/gi).map((part, index) => {
        const ids = citation.test(part) ? part.match(uuid) : null;
        if (!ids) return <Fragment key={index}>{part}</Fragment>;
        return (
          <span key={index} className="cites">
            {ids.map((id) => {
              const event = events.find((e) => e.id === id);
              return event ? (
                <button
                  key={id}
                  className="cite"
                  onClick={() => onCite(id)}
                  title={`${eventName(event)} · ${date(event.occurredAt)}`}
                >
                  {eventName(event)} {time(event.occurredAt).slice(0, 5)}
                </button>
              ) : null;
            })}
          </span>
        );
      })}
    </>
  );
}
export interface Usage {
  day: number;
  dayLimit: number;
  month: number;
  monthLimit: number;
}
export default function Timeline({
  detail,
  title,
  backLabel,
  initialFile = "",
  articles,
  usage,
  onBack,
  onGenerate,
  onOpenArticle,
  onDelete,
  onRefresh,
  notify,
}: {
  detail: SessionDetail;
  title: string;
  backLabel: string;
  initialFile?: string;
  articles: Article[];
  usage: Usage;
  onBack: () => void;
  onGenerate: (fileId?: string) => void;
  onOpenArticle: (id: string) => void;
  onDelete: () => void;
  onRefresh: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [file, setFile] = useState(
      detail.files.some((f) => f.id === initialFile) ? initialFile : "all",
    ),
    [selected, setSelected] = useState(""),
    [preparing, setPreparing] = useState(false),
    [problemOpen, setProblemOpen] = useState(false),
    [allSummaries, setAllSummaries] = useState(false),
    [statements, setStatements] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        detail.files.map((f) => [f.id, f.problemStatement || ""]),
      ),
    );
  const wide = useMediaQuery("(min-width: 1000px)");
  const events = detail.events || [];
  const insights = useInsights(events);
  const files = useMemo(
    () =>
      Array.from(
        new Map(
          events
            .filter((e) => e.fileId || e.filePath)
            .map((e) => [
              e.fileId || e.filePath!,
              {
                id: e.fileId || e.filePath!,
                path:
                  e.filePath ||
                  detail.files?.find((f) => f.id === e.fileId)?.path ||
                  e.fileId!,
              },
            ]),
        ).values(),
      ),
    [events, detail.files],
  );
  const visible = events.filter(
    (e) => file === "all" || e.fileId === file || e.filePath === file,
  );
  const runs = visible.filter((e) => e.type === "run");
  const current =
    visible.find((e) => e.id === selected) || (wide ? visible[0] : undefined);
  const sourceFile =
    detail.files.find((f) => f.id === file) ||
    (detail.files.length === 1 ? detail.files[0] : undefined);
  const summaries = (detail.summaries || []).slice(-3).reverse();
  const counts = {
    runs: events.filter((e) => e.type === "run").length,
    memos: events.filter((e) => e.type === "memo").length,
  };
  const written = [...articles].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  function select(id: string) {
    const target = events.find((e) => e.id === id);
    if (!target) return;
    if (!visible.includes(target)) setFile("all");
    setSelected(id);
    requestAnimationFrame(() =>
      document
        .getElementById(`event-${id}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  }
  function onRowKey(event: React.KeyboardEvent, index: number) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = visible[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    setSelected(next.id);
    const row = document.getElementById(`event-${next.id}`);
    row?.focus();
    row?.scrollIntoView({ block: "nearest" });
  }
  async function stop() {
    try {
      await patch(`/sessions/${detail.session.id}`, {
        recording: false,
        endedAt: new Date().toISOString(),
      });
      onRefresh();
      notify("기록을 중지했습니다.");
    } catch (e) {
      notify(String(e), true);
    }
  }
  async function exportRecord() {
    try {
      download(
        `session-${detail.session.id}.json`,
        await api(`/sessions/${detail.session.id}/export`),
      );
    } catch (e) {
      notify(String(e), true);
    }
  }
  async function remove() {
    if (!confirm("이 세션의 원본 기록과 연결된 파생 데이터를 삭제할까요?"))
      return;
    try {
      await api(`/sessions/${detail.session.id}`, { method: "DELETE" });
      onDelete();
      notify("세션을 삭제했습니다.");
    } catch (e) {
      notify(String(e), true);
    }
  }
  const pane = current && (
    <div className="event-pane" id="event-pane" aria-live="polite">
      <header>
        <strong>{eventName(current)}</strong>
        {current.filePath && <span className="mono">{current.filePath}</span>}
        <time dateTime={current.occurredAt}>{date(current.occurredAt)}</time>
      </header>
      <EventDetail event={current} events={events} />
    </div>
  );
  return (
    <section className="timeline-section">
      <PageHead
        back={{ label: backLabel, onClick: onBack }}
        title={
          <>
            {title}
            <Badge tone={detail.session.endedAt ? "neutral" : "green"}>
              {detail.session.endedAt ? "기록 종료" : "기록 중"}
            </Badge>
          </>
        }
        actions={
          <>
            <button className="button subtle" onClick={exportRecord}>
              <FileDown size={15} />
              JSON
            </button>
            {!detail.session.endedAt && (
              <button className="button subtle" onClick={stop}>
                <Square size={13} />
                기록 중지
              </button>
            )}
            <button
              className="button primary"
              onClick={() => setPreparing(true)}
            >
              <Sparkles size={15} />
              초안 만들기
            </button>
            <button
              className="icon-button danger"
              onClick={remove}
              aria-label="세션 삭제"
            >
              <Trash2 size={16} />
            </button>
          </>
        }
      >
        <div className="meta-row">
          <span>
            <Clock3 size={14} />
            {date(detail.session.startedAt)} 시작
          </span>
          <span>
            <FileCode2 size={14} />
            파일 {files.length}
          </span>
          <span>
            <Terminal size={14} />
            실행 {counts.runs}
          </span>
          <span>
            <MessageSquare size={14} />
            메모 {counts.memos}
          </span>
          {!!written.length && (
            <button
              className="meta-link"
              onClick={() => onOpenArticle(written[0].id)}
              title={written[0].title}
            >
              <FileText size={14} />
              작성한 글 {written.length}편 · 이어서 편집
            </button>
          )}
        </div>
      </PageHead>
      {!!detail.gaps?.length && (
        <div className="notice warning">
          아직 동기화되지 않은 구간이 있습니다. 순번: {detail.gaps.join(", ")}
        </div>
      )}
      {!!summaries.length && (
        <div className="summary-strip">
          <Sparkles size={15} />
          <div>
            <strong>타임라인 요약</strong>
            {(allSummaries ? summaries : summaries.slice(0, 1)).map((s, i) => (
              <p key={s.id || i}>
                <SummaryText
                  text={s.summary || s.text || "요약 준비 중"}
                  events={events}
                  onCite={select}
                />
              </p>
            ))}
          </div>
          {summaries.length > 1 && (
            <button
              className="text-button"
              onClick={() => setAllSummaries(!allSummaries)}
              aria-expanded={allSummaries}
            >
              {allSummaries ? "접기" : `이전 요약 ${summaries.length - 1}개`}
            </button>
          )}
        </div>
      )}
      <div className="timeline-toolbar">
        <div className="file-tabs">
          <button
            className={file === "all" ? "active" : ""}
            onClick={() => setFile("all")}
          >
            전체 흐름
          </button>
          {files.map((f) => (
            <button
              key={f.id}
              className={file === f.id ? "active" : ""}
              onClick={() => setFile(f.id)}
              title={f.path}
            >
              <FileCode2 size={13} />
              {f.path.split(/[\\/]/).pop()}
            </button>
          ))}
        </div>
        {sourceFile && (
          <button
            className={`problem-toggle ${problemOpen ? "open" : ""}`}
            onClick={() => setProblemOpen(!problemOpen)}
            aria-expanded={problemOpen}
          >
            <NotebookPen size={14} />
            문제와 제약
            <span className={statements[sourceFile.id] ? "dot on" : "dot"}>
              {statements[sourceFile.id] ? "입력됨" : "미입력"}
            </span>
            <ChevronDown size={14} />
          </button>
        )}
      </div>
      {sourceFile && problemOpen && (
        <ProblemStatement
          key={sourceFile.id}
          fileId={sourceFile.id}
          initial={statements[sourceFile.id] || ""}
          onSaved={(value) =>
            setStatements((prev) => ({ ...prev, [sourceFile.id]: value }))
          }
          notify={notify}
        />
      )}
      {runs.length ? (
        <div className="run-flow">
          <span>실행 흐름</span>
          <ol>
            {runs.map((run, index) => {
              const status = String(run.data.status || "unknown");
              return (
                <li key={run.id}>
                  <button
                    className={`run-dot ${runTone(status)} ${insights.get(run.id)?.resultChanged ? "changed" : ""} ${current?.id === run.id ? "on" : ""}`}
                    onClick={() => select(run.id)}
                    aria-label={`실행 ${index + 1}: ${runStatuses[status] || status}${insights.get(run.id)?.resultChanged ? ", 결과 변화" : ""}, ${time(run.occurredAt)}`}
                    title={`${runStatuses[status] || status} · ${firstLine(run.data.output) || "출력 없음"}`}
                  >
                    {index + 1}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <p className="inline-hint">
          실행 정보 없음 · VS Code 통합 터미널에서 실행하면 기록에 연결됩니다.
        </p>
      )}
      {visible.length ? (
        <div className={`timeline-layout ${wide ? "split" : ""}`}>
          <ol className="event-list" aria-label="풀이 사건">
            {visible.map((event, index) => {
              const Icon = eventIcon(event);
              const active = current?.id === event.id;
              const tone =
                event.type === "run"
                  ? runTone(String(event.data.status || "unknown"))
                  : "";
              return (
                <li
                  key={event.id}
                  className={`event-item ${event.type} ${tone}`}
                >
                  <button
                    id={`event-${event.id}`}
                    className={`event-row ${active ? "selected" : ""}`}
                    onClick={() => setSelected(!wide && active ? "" : event.id)}
                    onKeyDown={(e) => onRowKey(e, index)}
                    {...(wide
                      ? {
                          "aria-current": active
                            ? ("true" as const)
                            : undefined,
                          "aria-controls": "event-pane",
                        }
                      : { "aria-expanded": active })}
                  >
                    <time
                      className="event-time"
                      dateTime={event.occurredAt}
                      title={date(event.occurredAt)}
                    >
                      {time(event.occurredAt)}
                    </time>
                    <span className="event-mark">
                      <Icon size={13} />
                    </span>
                    <span className="event-name">{eventName(event)}</span>
                    <span className="event-summary">
                      <EventSummary
                        event={event}
                        insight={insights.get(event.id)}
                      />
                    </span>
                    {file === "all" && files.length > 1 && event.filePath && (
                      <span className="event-file">
                        {event.filePath.split(/[\\/]/).pop()}
                      </span>
                    )}
                    {!wide &&
                      (active ? (
                        <ChevronDown size={15} className="event-chevron" />
                      ) : (
                        <ChevronRight size={15} className="event-chevron" />
                      ))}
                  </button>
                  {!wide && active && pane}
                </li>
              );
            })}
          </ol>
          {wide && pane}
        </div>
      ) : (
        <Empty title="아직 기록이 없어요" compact>
          확장에서 기록을 시작하고 파일을 저장해 보세요.
        </Empty>
      )}
      {preparing && (
        <DraftSheet
          files={files}
          events={events}
          knownFiles={detail.files.map((f) => f.id)}
          initialFile={file !== "all" ? file : files[0]?.id || ""}
          statements={statements}
          articles={written}
          usage={usage}
          onStatementSaved={(id, value) =>
            setStatements((prev) => ({ ...prev, [id]: value }))
          }
          onConfirm={onGenerate}
          onOpenArticle={onOpenArticle}
          onClose={() => setPreparing(false)}
          notify={notify}
        />
      )}
    </section>
  );
}
function DraftSheet({
  files,
  events,
  knownFiles,
  initialFile,
  statements,
  articles,
  usage,
  onStatementSaved,
  onConfirm,
  onOpenArticle,
  onClose,
  notify,
}: {
  files: Array<{ id: string; path: string }>;
  events: RecordEvent[];
  knownFiles: string[];
  initialFile: string;
  statements: Record<string, string>;
  articles: Article[];
  usage: Usage;
  onStatementSaved: (id: string, value: string) => void;
  onConfirm: (fileId?: string) => void;
  onOpenArticle: (id: string) => void;
  onClose: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [target, setTarget] = useState(initialFile),
    [problem, setProblem] = useState(statements[initialFile] || ""),
    [busy, setBusy] = useState(false);
  // Mirrors the API: a file draft receives that file's events only.
  const scoped = events.filter(
    (e) => !target || e.fileId === target || e.filePath === target,
  );
  const count = (type: string) => scoped.filter((e) => e.type === type).length;
  const changes = count("edit") + count("snapshot"),
    memos = count("memo"),
    runs = count("run");
  const size = new Blob([JSON.stringify(scoped.map((e) => e.data))]).size;
  const existing = articles.filter((a) => !target || a.fileId === target);
  const editable = knownFiles.includes(target);
  const blocked =
    usage.month >= usage.monthLimit
      ? "이번 달 AI 한도에 도달했습니다."
      : usage.day >= usage.dayLimit
        ? "오늘의 AI 한도에 도달했습니다."
        : "";
  async function start() {
    setBusy(true);
    try {
      if (editable && problem !== (statements[target] || "")) {
        await patch(`/files/${target}`, { problemStatement: problem });
        onStatementSaved(target, problem);
      }
      onConfirm(target || undefined);
      onClose();
    } catch (e) {
      notify(String(e), true);
      setBusy(false);
    }
  }
  return (
    <Modal title="초안 만들기" onClose={onClose}>
      <div className="draft-sheet">
        {files.length > 1 && (
          <fieldset className="file-choice">
            <legend>글로 만들 파일</legend>
            {files.map((f) => (
              <label key={f.id}>
                <input
                  type="radio"
                  name="draft-file"
                  checked={target === f.id}
                  onChange={() => {
                    setTarget(f.id);
                    setProblem(statements[f.id] || "");
                  }}
                />
                <span className="mono">{f.path}</span>
              </label>
            ))}
          </fieldset>
        )}
        <section className="sheet-block">
          <h3>AI에 보낼 기록</h3>
          <p>
            사건 {scoped.length}개 · 코드 변경 {changes} · 실행 {runs} · 메모{" "}
            {memos} · 약{" "}
            {size < 1024 ? `${size}B` : `${(size / 1024).toFixed(1)}KB`}
          </p>
          <p className="field-hint">
            {files.length > 1 || target
              ? "선택한 파일의 기록 전체를 시간순으로 보냅니다."
              : "이 세션의 기록 전체를 시간순으로 보냅니다."}{" "}
            원본 기록은 바뀌지 않습니다.
          </p>
        </section>
        {editable && (
          <label className="sheet-block">
            문제와 제약 <span className="field-hint">선택 사항</span>
            <textarea
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              rows={3}
              placeholder="문제 설명, 입력 범위, 시간·메모리 제한"
            />
            <span className="field-hint below">
              비워 두면 글의 문제 조건은 ‘확인 필요’로 남습니다. 문제 번호로
              조건을 추정하지 않습니다.
            </span>
          </label>
        )}
        {(!memos || !runs) && (
          <div className="notice warning">
            {!memos &&
              "메모가 없으면 당시의 판단을 1인칭으로 쓰지 않습니다. VS Code에서 메모를 남기면 글에 반영됩니다. "}
            {!runs && "실행 기록이 없어 결과는 서술하지 않습니다."}
          </div>
        )}
        {!!existing.length && (
          <div className="notice">
            <span>
              이 파일로 만든 글이 {existing.length}편 있습니다(최근:{" "}
              {existing[0].title || "제목 없는 글"},{" "}
              {articleStatusLabel(existing[0].status)}). 새 초안은 별도 글로
              저장됩니다.
            </span>
            <button
              onClick={() => {
                onClose();
                onOpenArticle(existing[0].id);
              }}
            >
              기존 글 열기
            </button>
          </div>
        )}
        <footer className="sheet-footer">
          <span className={blocked ? "danger" : ""}>
            {blocked ||
              `이번 달 AI 사용 ${money(usage.month)} / $${usage.monthLimit}`}
          </span>
          <div className="actions">
            <button className="button subtle" onClick={onClose}>
              취소
            </button>
            <button
              className="button primary"
              disabled={busy || !!blocked}
              onClick={start}
            >
              <Sparkles size={15} />
              초안 생성 시작
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
function ProblemStatement({
  fileId,
  initial,
  onSaved,
  notify,
}: {
  fileId: string;
  initial: string;
  onSaved: (value: string) => void;
  notify: (s: string, e?: boolean) => void;
}) {
  const [value, setValue] = useState(initial),
    [saved, setSaved] = useState(initial);
  async function save() {
    if (value === saved) return;
    try {
      await patch(`/files/${fileId}`, { problemStatement: value });
      setSaved(value);
      onSaved(value);
      notify("직접 입력한 문제와 제약을 저장했습니다.");
    } catch (e) {
      notify(String(e), true);
    }
  }
  return (
    <div className="problem-statement">
      <textarea
        aria-label="문제와 제약"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={4}
        placeholder="직접 문제 설명과 입력 범위를 적어 주세요."
      />
      <div className="problem-footer">
        <p>
          문제 지문은 자동 수집하지 않습니다. 입력하지 않은 조건은 AI가 추정하지
          않습니다.
        </p>
        <button
          className="button secondary"
          onClick={save}
          disabled={saved === value}
        >
          문제와 제약 저장
        </button>
      </div>
    </div>
  );
}
