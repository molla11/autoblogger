"use client";
import { Fragment, useMemo, useState } from "react";
import {
  FileCode2,
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
import { api, patch, download, date, time } from "@/lib/api";
import type { RecordEvent, SessionDetail } from "@/lib/types";
import { Badge, Empty, Modal, PageHead, useMediaQuery } from "./ui";
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
function RunStatus({ status }: { status: string }) {
  return (
    <Badge
      tone={
        status === "success" || status === "normal_exit"
          ? "green"
          : status.includes("error")
            ? "red"
            : "neutral"
      }
    >
      {runStatuses[status] || status}
    </Badge>
  );
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
const lineCount = (value: unknown) =>
  safe(value).replace(/\n$/, "").split("\n").length;
function diffStat(data: Record<string, unknown>) {
  if (typeof data.diff === "string" && data.diff) {
    const lines = data.diff.split("\n");
    return {
      added: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .length,
      removed: lines.filter((l) => l.startsWith("-") && !l.startsWith("---"))
        .length,
    };
  }
  const before = safe(data.before).split("\n"),
    after = safe(data.after).split("\n");
  const remaining = new Map<string, number>();
  for (const line of before) remaining.set(line, (remaining.get(line) || 0) + 1);
  let added = 0;
  for (const line of after) {
    const count = remaining.get(line) || 0;
    if (count) remaining.set(line, count - 1);
    else added++;
  }
  return {
    added,
    removed: [...remaining.values()].reduce((sum, n) => sum + n, 0),
  };
}
function EventSummary({ event }: { event: RecordEvent }) {
  const data = event.data;
  if (event.type === "run")
    return (
      <>
        <RunStatus status={String(data.status || "unknown")} />
        <code>{safe(data.command)}</code>
        {data.durationMs != null && (
          <span className="event-aside">
            {Number(data.durationMs).toLocaleString()}ms
          </span>
        )}
      </>
    );
  if (event.type === "memo")
    return <span className="event-quote">{safe(data.text).split("\n")[0]}</span>;
  if (event.type === "edit") {
    const stat = diffStat(data);
    return (
      <span className="diffstat">
        <ins>+{stat.added}</ins>
        <del>−{stat.removed}</del>
        {data.source === "unknown" && <Badge>출처 미확인</Badge>}
      </span>
    );
  }
  if (event.type === "snapshot")
    return <span className="event-aside">{lineCount(data.content)}줄</span>;
  return null;
}
export function EventDetail({
  event,
  events = [],
}: {
  event: RecordEvent;
  events?: RecordEvent[];
}) {
  const data = event.data;
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
        <p className="detail-note">정상 종료는 정답 여부를 의미하지 않습니다.</p>
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
  if (event.type === "snapshot")
    return <pre className="code">{safe(data.content)}</pre>;
  if (event.type === "edit")
    return (
      <div className="diff">
        <div className="diff-heading">
          <span>수정 전</span>
          <span>수정 후</span>
        </div>
        <div className="diff-columns">
          <pre>{safe(data.before) || "이전 코드 없음"}</pre>
          <pre>{safe(data.after) || safe(data.diff)}</pre>
        </div>
        {data.source === "unknown" && <Badge>출처 미확인</Badge>}
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
export default function Timeline({
  detail,
  title,
  backLabel,
  initialFile = "",
  onBack,
  onGenerate,
  onDelete,
  onRefresh,
  notify,
}: {
  detail: SessionDetail;
  title: string;
  backLabel: string;
  initialFile?: string;
  onBack: () => void;
  onGenerate: (fileId?: string) => void;
  onDelete: () => void;
  onRefresh: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [file, setFile] = useState(
      detail.files.some((f) => f.id === initialFile) ? initialFile : "all",
    ),
    [selected, setSelected] = useState(""),
    [chooseFile, setChooseFile] = useState(false),
    [problemOpen, setProblemOpen] = useState(false),
    [allSummaries, setAllSummaries] = useState(false),
    [statements, setStatements] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        detail.files.map((f) => [f.id, f.problemStatement || ""]),
      ),
    );
  const wide = useMediaQuery("(min-width: 1000px)");
  const events = detail.events || [];
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
  const generate = () => {
    if (file !== "all") onGenerate(file);
    else if (files.length === 1) onGenerate(files[0].id);
    else if (files.length > 1) setChooseFile(true);
    else onGenerate();
  };
  function cite(id: string) {
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
            <button className="button primary" onClick={generate}>
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
                  onCite={cite}
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
              {statements[sourceFile.id] ? "입력됨" : "선택"}
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
      {!counts.runs && (
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
              return (
                <li key={event.id} className={`event-item ${event.type}`}>
                  <button
                    id={`event-${event.id}`}
                    className={`event-row ${active ? "selected" : ""}`}
                    onClick={() =>
                      setSelected(!wide && active ? "" : event.id)
                    }
                    onKeyDown={(e) => onRowKey(e, index)}
                    {...(wide
                      ? {
                          "aria-current": active ? ("true" as const) : undefined,
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
                      <EventSummary event={event} />
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
      {chooseFile && (
        <Modal title="글로 만들 파일 선택" onClose={() => setChooseFile(false)}>
          <p className="muted">한 파일의 풀이를 한 편의 글로 만듭니다.</p>
          <div className="choice-list">
            {files.map((f) => (
              <button
                key={f.id}
                className="button subtle"
                onClick={() => {
                  setChooseFile(false);
                  onGenerate(f.id);
                }}
              >
                <FileCode2 size={16} />
                {f.path}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </section>
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
          문제 지문은 자동 수집하지 않습니다. 입력하지 않은 조건은 AI가
          추정하지 않습니다.
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
