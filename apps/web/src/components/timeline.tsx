"use client";
import { useState, useMemo } from "react";
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
} from "lucide-react";
import { api, patch, download, date } from "@/lib/api";
import type { RecordEvent, SessionDetail } from "@/lib/types";
import { Badge, Empty, Modal } from "./ui";
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
    const status = String(data.status || "unknown");
    return (
      <div className="event-detail">
        <div className="run-meta">
          <Badge
            tone={
              status === "success" || status === "normal_exit"
                ? "green"
                : status.includes("error")
                  ? "red"
                  : "neutral"
            }
          >
            {(
              {
                success: "정상 종료",
                normal_exit: "정상 종료",
                compile_error: "컴파일 에러",
                runtime_error: "런타임 에러",
                unknown: "판단 불가",
              } as Record<string, string>
            )[status] || status}
          </Badge>
          <span>종료 코드 {safe(data.exitCode) || "없음"}</span>
          <span>{Number(data.durationMs || 0).toLocaleString()}ms</span>
        </div>
        <pre className="command">$ {safe(data.command)}</pre>
        <pre className="code output">{safe(data.output) || "출력 없음"}</pre>
        <p className="muted">정상 종료는 정답 여부를 의미하지 않습니다.</p>
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
          <p className="muted">연결된 코드 버전 정보 없음</p>
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
export default function Timeline({
  detail,
  initialFile = "",
  onGenerate,
  onDelete,
  onRefresh,
  notify,
}: {
  detail: SessionDetail;
  initialFile?: string;
  onGenerate: (fileId?: string) => void;
  onDelete: () => void;
  onRefresh: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [file, setFile] = useState(detail.files.some(f => f.id === initialFile) ? initialFile : "all"),
    [expanded, setExpanded] = useState<Record<string, boolean>>({}),
    [chooseFile, setChooseFile] = useState(false);
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
  const sourceFile =
    detail.files.find((f) => f.id === file) ||
    (detail.files.length === 1 ? detail.files[0] : undefined);
  const generate = () => {
    if (file !== "all") onGenerate(file);
    else if (files.length === 1) onGenerate(files[0].id);
    else if (files.length > 1) setChooseFile(true);
    else onGenerate();
  };
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
  return (
    <section className="timeline-section">
      <div className="section-heading">
        <div>
          <div className="eyebrow">
            SESSION / {date(detail.session.startedAt)}
          </div>
          <h2>풀이의 흐름</h2>
          <p className="muted">
            변경과 실행, 그 순간의 메모를 시간순으로 살펴보세요.
          </p>
        </div>
        <div className="actions">
          <button className="button subtle" onClick={exportRecord}>
            <FileDown size={16} />
            JSON
          </button>
          {!detail.session.endedAt && (
            <button className="button subtle" onClick={stop}>
              <Square size={14} />
              기록 중지
            </button>
          )}
          <button className="button primary" onClick={generate}>
            <Sparkles size={16} />
            초안 만들기
          </button>
          <button
            className="icon-button danger"
            onClick={remove}
            aria-label="세션 삭제"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      <div className="session-summary">
        <span>
          <FileCode2 size={16} />
          {files.length}개 파일
        </span>
        <span>
          <Terminal size={16} />
          {events.filter((e) => e.type === "run").length}번 실행
        </span>
        <span>
          <MessageSquare size={16} />
          {events.filter((e) => e.type === "memo").length}개 메모
        </span>
        <span>
          <Clock3 size={16} />
          {detail.session.endedAt ? "기록 종료" : "기록 중"}
        </span>
      </div>
      {!!detail.gaps?.length && (
        <div className="notice warning">
          아직 동기화되지 않은 구간이 있습니다. 순번: {detail.gaps.join(", ")}
        </div>
      )}
      {!!detail.summaries?.length && (
        <div className="summary-card">
          <Sparkles size={20} />
          <div>
            <strong>타임라인 요약</strong>
            {detail.summaries.slice(-3).map((s, i) => (
              <p key={s.id || i}>{s.summary || s.text || "요약 준비 중"}</p>
            ))}
          </div>
        </div>
      )}
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
          >
            <FileCode2 size={14} />
            {f.path.split(/[\\/]/).pop()}
          </button>
        ))}
      </div>
      {sourceFile && (
        <ProblemStatement
          key={sourceFile.id}
          fileId={sourceFile.id}
          initial={sourceFile.problemStatement || ""}
          notify={notify}
        />
      )}
      {!events.some((e) => e.type === "run") && (
        <div className="notice">
          실행 정보 없음 · VS Code 통합 터미널에서 실행하면 기록에 연결됩니다.
        </div>
      )}
      {visible.length ? (
        <div className="timeline">
          {visible.map((event, i) => {
            const open =
              expanded[event.id] ??
              (event.type === "run" || event.type === "memo");
            const Icon =
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
            return (
              <article
                className={`timeline-event ${event.type}`}
                key={event.id}
              >
                <div className="timeline-dot">
                  <Icon size={16} />
                </div>
                <button
                  className="event-title"
                  onClick={() =>
                    setExpanded((prev) => ({ ...prev, [event.id]: !open }))
                  }
                  aria-expanded={open}
                >
                  <span>
                    <strong>{eventName(event)}</strong>
                    <small>{event.filePath || ""}</small>
                  </span>
                  <span className="event-time">
                    {date(event.occurredAt)}
                    {open ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )}
                  </span>
                </button>
                {open && <EventDetail event={event} events={events} />}
              </article>
            );
          })}
        </div>
      ) : (
        <Empty title="아직 기록이 없어요">
          확장에서 기록을 시작하고 파일을 저장해 보세요.
        </Empty>
      )}
      {chooseFile && (
        <Modal title="글로 만들 파일 선택" onClose={() => setChooseFile(false)}>
          <p className="muted">한 파일의 풀이를 한 편의 글로 만듭니다.</p>
          <div className="session-list">
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
  notify,
}: {
  fileId: string;
  initial: string;
  notify: (s: string, e?: boolean) => void;
}) {
  const [value, setValue] = useState(initial),
    [saved, setSaved] = useState(initial);
  async function save() {
    if (value === saved) return;
    try {
      await patch(`/files/${fileId}`, { problemStatement: value });
      setSaved(value);
      notify("직접 입력한 문제와 제약을 저장했습니다.");
    } catch (e) {
      notify(String(e), true);
    }
  }
  return (
    <details className="problem-statement">
      <summary>
        문제와 제약 직접 입력 {saved ? "· 저장된 지문 있음" : "· 선택"}
      </summary>
      <p className="muted">
        문제 지문은 자동 수집하지 않습니다. 입력하지 않은 조건은 AI가 추정하지
        않습니다.
      </p>
      <textarea
        aria-label="문제와 제약"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={5}
        placeholder="직접 문제 설명과 입력 범위를 적어 주세요."
      />
      <button
        className="button secondary"
        onClick={save}
        disabled={saved === value}
      >
        문제와 제약 저장
      </button>
    </details>
  );
}
