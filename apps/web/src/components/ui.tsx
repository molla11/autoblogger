"use client";
import {
  X,
  Loader2,
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
export function Spinner() {
  return <Loader2 size={16} className="spin" aria-label="진행 중" />;
}
export function Empty({
  icon,
  title,
  children,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? "compact" : ""}`}>
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function PageHead({
  title,
  description,
  actions,
  back,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { label: string; onClick: () => void };
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      {back && (
        <button className="back-link" onClick={back.onClick}>
          <ArrowLeft size={14} />
          {back.label}
        </button>
      )}
      <div className="page-head-row">
        <div className="page-head-text">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
          {children}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </div>
    </header>
  );
}
export function StatStrip({
  items,
}: {
  items: Array<{
    label: string;
    value: ReactNode;
    unit?: string;
    hint?: ReactNode;
    meter?: number;
  }>;
}) {
  return (
    <dl className="stat-strip">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>
            <strong>{item.value}</strong>
            {item.unit && <span className="unit">{item.unit}</span>}
            {item.hint && <small>{item.hint}</small>}
            {item.meter !== undefined && (
              <span className="meter" aria-hidden="true">
                <i style={{ width: `${Math.min(100, item.meter * 100)}%` }} />
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function ShowMore({
  total,
  limit,
  expanded,
  onToggle,
}: {
  total: number;
  limit: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (total <= limit) return null;
  return (
    <button className="show-more" onClick={onToggle} aria-expanded={expanded}>
      {expanded ? "접기" : `${total - limit}개 더 보기`}
    </button>
  );
}
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement>(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),textarea,select,[tabindex="0"]',
        ) || [],
      );
    focusable()[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const items = focusable(),
          first = items[0],
          last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="닫기">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Toast({
  message,
  onClose,
  error = false,
}: {
  message: string;
  onClose: () => void;
  error?: boolean;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={`toast ${error ? "error" : ""}`}
    >
      {error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
      <span>{message}</span>
      <button onClick={onClose} aria-label="알림 닫기">
        <X size={16} />
      </button>
    </div>
  );
}
export function LinkOut({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={/^https?:\/\//.test(href) ? href : "#"}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ArrowUpRight size={14} />
    </a>
  );
}
export const articleStatusLabel = (status: string) =>
  status === "published"
    ? "공개"
    : status === "draft"
      ? "Ghost 초안"
      : "내 보관함";
export const reviewLabels: Record<string, string> = {
  needs_review: "확인 필요",
  supported: "기록이 뒷받침함",
  insufficient: "근거 부족",
  conflict: "기록과 충돌",
  unknown: "판단 불가",
};
export const jobLabels: Record<string, string> = {
  generate: "초안 작성",
  summarize: "타임라인 요약",
  suggest: "AI 수정 제안",
  verify: "근거 검토",
  publish: "Ghost 동기화",
};
export const statusLabels: Record<string, string> = {
  queued: "대기 중",
  running: "진행 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨",
  draft: "Ghost 초안",
  published: "공개",
  local: "내 보관함",
};
