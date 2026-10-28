"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Braces,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
  RefreshCw,
  Trash2,
  Link2,
  Play,
  Square,
} from "lucide-react";
import {
  api,
  post,
  patch,
  getToken,
  setToken,
  date,
  money,
  watchEvents,
  errorMessage,
} from "@/lib/api";
import type {
  User,
  Project,
  Session,
  SessionDetail,
  Article,
  Job,
} from "@/lib/types";
import { draftPreview } from "@/lib/stream-preview";
import {
  Badge,
  Empty,
  Modal,
  Spinner,
  Toast,
  jobLabels,
  statusLabels,
} from "./ui";
import Timeline from "./timeline";
import Settings from "./settings";
import Admin from "./admin";
const ArticleEditor = dynamic(() => import("./article-editor"), {
  ssr: false,
  loading: () => (
    <div className="loading">
      <Spinner />
      에디터를 여는 중…
    </div>
  ),
});
type View = "home" | "projects" | "articles" | "settings" | "admin";
export default function Workspace() {
  const [user, setUser] = useState<User | null>(null),
    [ready, setReady] = useState(false),
    [view, setView] = useState<View>("home"),
    [projects, setProjects] = useState<Project[]>([]),
    [articles, setArticles] = useState<Article[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [project, setProject] = useState<Project | null>(null),
    [sessions, setSessions] = useState<Session[]>([]),
    [detail, setDetail] = useState<SessionDetail | null>(null),
    [article, setArticle] = useState<Article | null>(null),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [newProject, setNewProject] = useState(false),
    [projectName, setProjectName] = useState(""),
    [rootPath, setRootPath] = useState(""),
    [search, setSearch] = useState(""),
    [mobileNav, setMobileNav] = useState(false),
    [busy, setBusy] = useState(false),
    [connectParams, setConnectParams] = useState<URLSearchParams | null>(null),
    [jobDrawer, setJobDrawer] = useState(false);
  const activeArticleId = useRef("");
  activeArticleId.current = article?.id || "";
  const jobsRef = useRef<Job[]>([]),
    jobPayloads = useRef(new Map<string, Record<string, unknown>>()),
    toastedJobs = useRef(new Set<string>()),
    streams = useRef(new Map<string, AbortController>());
  const notify = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 7500);
    return () => clearTimeout(timer);
  }, [toast]);
  const refresh = useCallback(async () => {
    try {
      const [p, a, j, u] = await Promise.all([
        api<Project[]>("/projects"),
        api<Article[]>("/articles"),
        api<Job[]>("/jobs"),
        api<User>("/me"),
      ]);
      setProjects(p);
      setArticles(a);
      setJobs(j);
      jobsRef.current = j;
      setUser(u);
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }, [notify]);
  useEffect(() => {
    async function init() {
      const params = new URLSearchParams(location.search);
      if (location.pathname === "/connect" || params.has("challenge")) {
        sessionStorage.setItem("autoblogger.connect", params.toString());
        setConnectParams(params);
      } else {
        const pending = sessionStorage.getItem("autoblogger.connect");
        if (pending) setConnectParams(new URLSearchParams(pending));
      }
      if (
        location.pathname === "/auth/callback" &&
        process.env.NEXT_PUBLIC_SUPABASE_URL &&
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      ) {
        try {
          const { createClient } = await import("@supabase/supabase-js");
          const client = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
          );
          const { data, error } = await client.auth.getSession();
          if (error) throw error;
          if (data.session) setToken(data.session.access_token);
        } catch (e) {
          notify(errorMessage(e), true);
        }
      }
      if (getToken()) {
        try {
          setUser(await api<User>("/me"));
        } catch {
          setToken("");
        }
      }
      setReady(true);
    }
    void init();
    return () => streams.current.forEach((controller) => controller.abort());
  }, [notify]);
  useEffect(() => {
    if (user) void refresh();
  }, [user?.id, refresh]);
  const openArticle = useCallback(
    async (id: string) => {
      try {
        const value = await api<Article>(`/articles/${id}`);
        setArticle(value);
        setView("articles");
        setDetail(null);
      } catch (e) {
        notify(errorMessage(e), true);
      }
    },
    [notify],
  );
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(async () => {
      try {
        const incoming = await api<Job[]>("/jobs");
        const previous = jobsRef.current;
        setJobs(incoming);
        jobsRef.current = incoming;
        for (const job of incoming) {
          if (
            job.status === "completed" &&
            job.articleId === activeArticleId.current &&
            previous.find((j) => j.id === job.id)?.status !== "completed"
          ) {
            const latest = await api<Article>(`/articles/${job.articleId}`);
            setArticle(latest);
          }
          if (
            ["completed", "failed", "cancelled"].includes(job.status) &&
            jobPayloads.current.has(job.id) &&
            !toastedJobs.current.has(job.id)
          ) {
            toastedJobs.current.add(job.id);
            streams.current.get(job.id)?.abort();
            streams.current.delete(job.id);
            const payload = jobPayloads.current.get(job.id)!;
            if (job.status === "completed") {
              notify(`${jobLabels[job.kind] || "작업"}을 마쳤습니다.`);
              await refresh();
              const generated =
                job.result?.articleId ||
                (job.result?.article as Article | undefined)?.id ||
                payload.articleId;
              if (generated) {
                if (job.kind === "generate") setJobDrawer(false);
                await openArticle(String(generated));
              }
              if (detail && payload.sessionId === detail.session.id)
                await loadSession(detail.session.id);
            } else if (job.status === "failed")
              notify(
                job.error ||
                  "작업에 실패했습니다. 원본과 편집 내용은 보존됩니다.",
                true,
              );
          }
        }
      } catch {
        /* transient network failure, keep current job state */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [user?.id, notify, refresh, openArticle, detail?.session.id]);
  async function loadProject(value: Project) {
    setProject(value);
    setDetail(null);
    setArticle(null);
    setView("projects");
    try {
      setSessions(await api<Session[]>(`/projects/${value.id}/sessions`));
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function loadSession(id: string) {
    try {
      setDetail(await api<SessionDetail>(`/sessions/${id}`));
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  useEffect(() => {
    if (!detail?.session.id) return;
    const controller = new AbortController();
    const id = detail.session.id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void watchEvents(
      `/sessions/${id}/events/stream`,
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => void loadSession(id), 400);
      },
      controller.signal,
    ).catch(() => {});
    const poll = setInterval(() => void loadSession(id), 10000);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, [detail?.session.id]);
  const startJob = useCallback(
    async (payload: Record<string, unknown>) => {
      try {
        const job = await post<Job>("/jobs", payload);
        jobPayloads.current.set(job.id, payload);
        if (job.kind === "generate") setJobDrawer(true);
        setJobs((current) => [job, ...current.filter((j) => j.id !== job.id)]);
        notify(`${jobLabels[job.kind] || "작업"}을 시작했습니다.`);
        const controller = new AbortController();
        streams.current.set(job.id, controller);
        void watchEvents(
          `/jobs/${job.id}/events`,
          (value) => {
            const event = value as Record<string, unknown>;
            const candidate = (event.job || event) as Job;
            if (candidate.id === job.id && candidate.status)
              setJobs((current) =>
                current.map((j) =>
                  j.id === job.id ? { ...j, ...candidate } : j,
                ),
              );
          },
          controller.signal,
        ).catch(() => {});
        return job;
      } catch (e) {
        notify(errorMessage(e), true);
        return undefined;
      }
    },
    [notify],
  );
  async function sample() {
    setBusy(true);
    try {
      const result = await post<{ project: Project; session: Session }>(
        "/samples",
      );
      await refresh();
      await loadProject(result.project);
      await loadSession(result.session.id);
      notify(
        "기능 체험용 샘플 기록을 만들었습니다. 실제 평가 데이터가 아닙니다.",
      );
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    try {
      const created = await post<Project>("/projects", {
        name: projectName,
        rootPath,
      });
      await refresh();
      setNewProject(false);
      setProjectName("");
      setRootPath("");
      await loadProject(created);
      notify("프로젝트를 만들었습니다. 확장에서 이 프로젝트를 선택해 주세요.");
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function deleteProject() {
    if (!project || !confirm("이 프로젝트와 연결된 기록을 삭제할까요?")) return;
    try {
      await api(`/projects/${project.id}`, { method: "DELETE" });
      setProject(null);
      setDetail(null);
      await refresh();
      notify("프로젝트를 삭제했습니다.");
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  function logout() {
    setToken("");
    streams.current.forEach((c) => c.abort());
    streams.current.clear();
    setUser(null);
    setProjects([]);
    setArticles([]);
    setJobs([]);
    setProject(null);
    setDetail(null);
    setArticle(null);
  }
  const onArticleSaved = useCallback((saved: Article) => {
    setArticle(saved);
    setArticles((current) =>
      current.map((a) => (a.id === saved.id ? saved : a)),
    );
  }, []);
  const navigate = (target: View) => {
    setView(target);
    setArticle(null);
    setDetail(null);
    setProject(null);
    setSearch("");
    setMobileNav(false);
  };
  const activeJobs = jobs.filter((j) =>
    ["running", "queued"].includes(j.status),
  );
  if (!ready)
    return (
      <div className="loading full">
        <Spinner />
        작업 공간을 준비하고 있습니다.
      </div>
    );
  if (!user)
    return (
      <>
        <Login
          onLogin={(value) => {
            setUser(value);
            setReady(true);
          }}
          notify={notify}
        />
        {toast && (
          <Toast
            message={toast.text}
            error={toast.error}
            onClose={() => setToast(null)}
          />
        )}
      </>
    );
  return (
    <div className={`app-shell ${article ? "editing" : ""}`}>
      <aside className={`app-sidebar ${mobileNav ? "open" : ""}`}>
        <button className="brand" onClick={() => navigate("home")}>
          <span className="brand-mark">
            <Braces size={23} />
          </span>
          <span>
            풀이의 기록<small>AUTOBLOGGER</small>
          </span>
        </button>
        <div className="workspace-label">
          개인 작업 공간 <Badge>LOCAL</Badge>
        </div>
        <nav>
          {(
            [
              { id: "home", label: "대시보드", icon: LayoutDashboard },
              { id: "projects", label: "풀이 기록", icon: FolderOpen },
              { id: "articles", label: "글 보관함", icon: BookOpen },
              { id: "settings", label: "연결과 데이터", icon: Settings2 },
              ...(user.role === "admin"
                ? [{ id: "admin", label: "관리자", icon: ShieldCheck }]
                : []),
            ] as const
          ).map((item) => (
            <button
              className={view === item.id ? "active" : ""}
              key={item.id}
              onClick={() => navigate(item.id as View)}
            >
              <item.icon size={18} />
              {item.label}
              {item.id === "articles" && <small>{articles.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="note-symbol">✳</div>
          <strong>
            정답까지의 과정도,
            <br />
            하나의 이야기니까.
          </strong>
          <p>
            작은 수정과 실패를
            <br />
            의미 있는 기록으로 남겨요.
          </p>
          <button onClick={sample} disabled={busy}>
            샘플 기록 체험 <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="usage">
            <span>이번 달 AI 사용량</span>
            <strong>
              {money(user.usage?.month)}{" "}
              <small>/ ${user.monthlyLimit ?? 15}</small>
            </strong>
            <div className="usage-track">
              <i
                style={{
                  width: `${Math.min(100, (Number(user.usage?.month || 0) / (user.monthlyLimit || 15)) * 100)}%`,
                }}
              />
            </div>
          </div>
          <button className="profile" onClick={() => navigate("settings")}>
            <span className="avatar">{user.email[0].toUpperCase()}</span>
            <span>
              <strong>{user.email.split("@")[0]}</strong>
              <small>{user.role === "admin" ? "관리자" : "개인 계정"}</small>
            </span>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-header">
          <button
            className="icon-button mobile-menu"
            onClick={() => setMobileNav(!mobileNav)}
            aria-label="메뉴 열기"
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>작업 공간</span>
            <ChevronRight size={14} />
            <strong>
              {
                {
                  home: "대시보드",
                  projects: "풀이 기록",
                  articles: "글 보관함",
                  settings: "연결과 데이터",
                  admin: "관리자",
                }[view]
              }
            </strong>
            {project && (
              <>
                <ChevronRight size={14} />
                <span>{project.name}</span>
              </>
            )}
          </div>
          <div className="header-right">
            <span className="connection-status">
              <i />
              로컬 작업 공간
            </span>
            <button
              className="button subtle"
              onClick={() => setJobDrawer(true)}
            >
              <ActivityIcon />
              {activeJobs.length
                ? `${activeJobs.length}개 작업 진행 중`
                : "작업 내역"}
            </button>
          </div>
        </header>
        {article ? (
          <ArticleEditor
            key={article.id}
            article={article}
            onBack={() => {
              setArticle(null);
              void refresh();
            }}
            onSaved={onArticleSaved}
            notify={notify}
            startJob={startJob}
          />
        ) : (
          <main className="main-content">
            {connectParams && (
              <ConnectBanner
                params={connectParams}
                notify={notify}
                onClose={() => {
                  setConnectParams(null);
                  sessionStorage.removeItem("autoblogger.connect");
                }}
              />
            )}
            {view === "home" && (
              <>
                <div className="page-heading">
                  <div className="eyebrow">A LITTLE PROGRESS, EVERY DAY</div>
                  <h1>
                    오늘의 풀이가,
                    <br />
                    <span>내일의 기록이 되도록.</span>
                  </h1>
                  <p>코드에 남지 않은 생각과 시도를 한 편의 글로 이어보세요.</p>
                </div>
                <div className="dashboard-hero">
                  <div>
                    <Badge tone="green">기록에서 글까지</Badge>
                    <h2>
                      완성된 코드 너머의
                      <br />
                      이야기를 남겨보세요.
                    </h2>
                    <p>
                      저장한 코드, 실행 결과, 메모를 모아
                      <br />
                      근거가 연결된 나만의 풀이 글을 만듭니다.
                    </p>
                    <div className="actions">
                      <button
                        className="button primary"
                        onClick={() => setNewProject(true)}
                      >
                        <Plus size={16} />새 프로젝트
                      </button>
                      <button
                        className="button subtle"
                        onClick={sample}
                        disabled={busy}
                      >
                        {busy ? <Spinner /> : <Play size={15} />}샘플로 둘러보기
                      </button>
                    </div>
                  </div>
                  <div className="hero-illustration" aria-hidden="true">
                    <div className="paper-card back">
                      <span />
                      <span />
                      <span />
                    </div>
                    <div className="code-card">
                      <span className="terminal-dots">
                        <i />
                        <i />
                        <i />
                      </span>
                      <code>
                        <em>while</em> (trying) {"{"}
                        <br />
                        &nbsp;&nbsp;learn();
                        <br />
                        &nbsp;&nbsp;<b>record</b>();
                        <br />
                        {"}"}
                      </code>
                    </div>
                    <div className="paper-card front">
                      <div className="tiny-label">SOLUTION NOTE</div>
                      <strong>
                        한 번의 실패,
                        <br />
                        다음의 실마리.
                      </strong>
                      <span />
                      <span />
                      <div className="evidence-mini">
                        <Check size={12} />
                        근거가 연결된 문장
                      </div>
                    </div>
                    <div className="floating-star">✳</div>
                  </div>
                </div>
                <div className="stat-grid">
                  <div className="stat-card">
                    <FolderOpen />
                    <span>기록 중인 프로젝트</span>
                    <strong>
                      {projects.length}
                      <small>개</small>
                    </strong>
                    <small>나의 풀이 작업 공간</small>
                  </div>
                  <div className="stat-card">
                    <FileText />
                    <span>보관함의 글</span>
                    <strong>
                      {articles.length}
                      <small>편</small>
                    </strong>
                    <small>
                      편집 완료{" "}
                      {articles.filter((a) => a.editingCompletedAt).length}편
                    </small>
                  </div>
                  <div className="stat-card">
                    <CloudIcon />
                    <span>공개한 글</span>
                    <strong>
                      {articles.filter((a) => a.status === "published").length}
                      <small>편</small>
                    </strong>
                    <small>Ghost에 발행한 기록</small>
                  </div>
                </div>
                <div className="section-heading">
                  <h2>최근 프로젝트</h2>
                  <button
                    className="text-button"
                    onClick={() => navigate("projects")}
                  >
                    모두 보기 <ArrowRight size={15} />
                  </button>
                </div>
                <ProjectGrid
                  projects={projects.slice(0, 3)}
                  onOpen={loadProject}
                  onNew={() => setNewProject(true)}
                />
                <div className="onboarding-strip">
                  <Terminal size={24} />
                  <div>
                    <strong>VS Code에서 풀이를 기록하세요</strong>
                    <p>
                      확장 연결 → 기록 시작 → 통합 터미널에서 실행 → 초안 만들기
                    </p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => navigate("settings")}
                  >
                    연결 안내 <ArrowUpRight size={15} />
                  </button>
                </div>
              </>
            )}
            {view === "projects" &&
              (detail ? (
                <>
                  <button
                    className="text-button back-link"
                    onClick={() => setDetail(null)}
                  >
                    ← 세션 목록
                  </button>
                  <Timeline
                    detail={detail}
                    onGenerate={(fileId) =>
                      void startJob({
                        kind: "generate",
                        sessionId: detail.session.id,
                        ...(fileId ? { fileId } : {}),
                      })
                    }
                    onRefresh={() => void loadSession(detail.session.id)}
                    onDelete={() => {
                      setDetail(null);
                      if (project) void loadProject(project);
                    }}
                    notify={notify}
                  />
                </>
              ) : project ? (
                <>
                  <div className="page-heading heading-row">
                    <div>
                      <button
                        className="text-button back-link"
                        onClick={() => setProject(null)}
                      >
                        ← 모든 프로젝트
                      </button>
                      <h1>{project.name}</h1>
                      <p className="mono muted">
                        {project.rootPath ||
                          "확장에서 작업 폴더를 연결해 주세요."}
                      </p>
                    </div>
                    <div className="actions">
                      <button
                        className="button subtle"
                        onClick={async () => {
                          try {
                            const updated = await patch<Project>(
                              `/projects/${project.id}`,
                              { excluded: !project.excluded },
                            );
                            setProject(updated);
                            void refresh();
                          } catch (e) {
                            notify(errorMessage(e), true);
                          }
                        }}
                      >
                        {project.excluded
                          ? "기록 다시 허용"
                          : "프로젝트 기록 제외"}
                      </button>
                      <button
                        className="icon-button danger"
                        aria-label="프로젝트 삭제"
                        onClick={deleteProject}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </div>
                  <div className="card exclude-settings">
                    <label>
                      수집 제외 패턴{" "}
                      <span className="field-hint">한 줄에 하나씩 입력</span>
                      <textarea
                        defaultValue={(project.excludePatterns || []).join(
                          "\n",
                        )}
                        onBlur={async (e) => {
                          try {
                            const updated = await patch<Project>(
                              `/projects/${project.id}`,
                              {
                                excludePatterns: e.target.value
                                  .split("\n")
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              },
                            );
                            setProject(updated);
                          } catch (error) {
                            notify(errorMessage(error), true);
                          }
                        }}
                        placeholder="private/**&#10;**/secret.cpp"
                        rows={2}
                      />
                    </label>
                  </div>
                  <div className="section-heading">
                    <h2>
                      풀이 세션 <Badge>{sessions.length}</Badge>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => void loadProject(project)}
                    >
                      <RefreshCw size={14} />
                      새로고침
                    </button>
                  </div>
                  {sessions.length ? (
                    <div className="session-list">
                      {sessions.map((session, index) => (
                        <button
                          key={session.id}
                          className="card session-row"
                          onClick={() => void loadSession(session.id)}
                        >
                          <span className="session-icon">
                            <Terminal size={20} />
                          </span>
                          <span>
                            <strong>풀이 세션 {sessions.length - index}</strong>
                            <small>{date(session.startedAt)}</small>
                          </span>
                          <Badge tone={session.endedAt ? "neutral" : "green"}>
                            {session.endedAt ? "기록 종료" : "기록 중"}
                          </Badge>
                          <ChevronRight size={18} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={<Terminal />}
                      title="첫 풀이를 기다리고 있어요"
                    >
                      VS Code 확장에서 이 프로젝트를 선택하고 기록을 시작해
                      주세요.
                    </Empty>
                  )}
                </>
              ) : (
                <>
                  <div className="page-heading heading-row">
                    <div>
                      <div className="eyebrow">YOUR CODING JOURNEY</div>
                      <h1>풀이 기록</h1>
                      <p>프로젝트를 열어 코드가 바뀌어 온 과정을 살펴보세요.</p>
                    </div>
                    <button
                      className="button primary"
                      onClick={() => setNewProject(true)}
                    >
                      <Plus size={16} />새 프로젝트
                    </button>
                  </div>
                  <ProjectGrid
                    projects={projects}
                    onOpen={loadProject}
                    onNew={() => setNewProject(true)}
                  />
                </>
              ))}
            {view === "articles" && (
              <>
                <div className="page-heading heading-row">
                  <div>
                    <div className="eyebrow">COLLECTED STORIES</div>
                    <h1>글 보관함</h1>
                    <p>기록에서 시작해, 내 언어로 완성한 이야기들.</p>
                  </div>
                  <div className="search">
                    <Search size={17} />
                    <input
                      aria-label="글 검색"
                      placeholder="글 제목 검색"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                </div>
                {articles.filter((a) =>
                  a.title.toLowerCase().includes(search.toLowerCase()),
                ).length ? (
                  <div className="article-grid">
                    {articles
                      .filter((a) =>
                        a.title.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((a, index) => (
                        <article key={a.id} className="card article-card">
                          <button
                            className="article-open"
                            onClick={() => void openArticle(a.id)}
                          >
                            <div className={`article-cover cover-${index % 3}`}>
                              <Code2 size={32} />
                              <span>{String(index + 1).padStart(2, "0")}</span>
                            </div>
                            <div className="article-card-body">
                              <Badge
                                tone={
                                  a.status === "published" ? "green" : "neutral"
                                }
                              >
                                {a.status === "published"
                                  ? "공개"
                                  : a.status === "draft"
                                    ? "Ghost 초안"
                                    : "내 보관함"}
                              </Badge>
                              {a.editingCompletedAt && (
                                <Badge tone="green">편집 완료</Badge>
                              )}
                              <h2>{a.title || "제목 없는 글"}</h2>
                              <p>
                                {(a.blocks || [])
                                  .find((b) => b.type === "paragraph")
                                  ?.text.slice(0, 100) ||
                                  "원본 기록을 보며 나의 풀이를 정리해 보세요."}
                              </p>
                              <footer>
                                <span>{date(a.updatedAt)}</span>
                                <ArrowUpRight size={16} />
                              </footer>
                            </div>
                          </button>
                          <button
                            className="article-delete icon-button danger"
                            aria-label={`${a.title} 삭제`}
                            onClick={async () => {
                              if (!confirm("보관함에서 이 글을 삭제할까요?"))
                                return;
                              try {
                                await api(`/articles/${a.id}`, {
                                  method: "DELETE",
                                });
                                await refresh();
                              } catch (e) {
                                notify(errorMessage(e), true);
                              }
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </article>
                      ))}
                  </div>
                ) : (
                  <Empty
                    icon={<BookOpen size={30} />}
                    title="첫 번째 이야기를 만들어 볼까요?"
                    action={
                      <button
                        className="button primary"
                        onClick={() => navigate("projects")}
                      >
                        풀이 기록 열기 <ArrowRight size={15} />
                      </button>
                    }
                  >
                    풀이 세션에서 ‘초안 만들기’를 누르면 여기에 글이 생깁니다.
                  </Empty>
                )}
              </>
            )}
            {view === "settings" && (
              <Settings user={user} notify={notify} onLogout={logout} />
            )}
            {view === "admin" && user.role === "admin" && (
              <Admin notify={notify} />
            )}
            <footer className="page-footer">
              <span>풀이의 기록 · 과정에 의미를 더하다</span>
              <a href="/privacy" target="_blank">
                데이터와 개인정보
              </a>
            </footer>
          </main>
        )}
      </div>
      {newProject && (
        <Modal title="새 프로젝트" onClose={() => setNewProject(false)}>
          <form onSubmit={createProject}>
            <label>
              프로젝트 이름
              <input
                autoFocus
                required
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="예: 알고리즘 연습"
              />
            </label>
            <label>
              작업 폴더 경로 <span className="field-hint">선택</span>
              <input
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="/home/me/solutions"
              />
            </label>
            <p className="muted">
              .c, .cpp, .py 파일을 기록합니다. 실제 폴더 접근은 VS Code 확장에서
              수행합니다.
            </p>
            <button className="button primary">
              <Plus size={16} />
              프로젝트 만들기
            </button>
          </form>
        </Modal>
      )}
      {jobDrawer && (
        <Modal title="작업 내역" onClose={() => setJobDrawer(false)} wide>
          <div className="job-list">
            {jobs.length ? (
              jobs.map((job) => (
                <div key={job.id} className="job-row">
                  <div>
                    <strong>{jobLabels[job.kind] || job.kind}</strong>
                    <small>{date(job.createdAt)}</small>
                  </div>
                  <Badge
                    tone={
                      job.status === "failed"
                        ? "red"
                        : job.status === "completed"
                          ? "green"
                          : "neutral"
                    }
                  >
                    {statusLabels[job.status] || job.status}
                  </Badge>
                  <div className="job-progress">
                    <i
                      style={{
                        width: `${job.progress <= 1 ? job.progress * 100 : job.progress}%`,
                      }}
                    />
                  </div>
                  {job.error && <p className="danger">{job.error}</p>}
                  {job.kind === "generate" && job.stream?.text && (
                    <LiveDraft job={job} />
                  )}
                  <div className="actions">
                    {["queued", "running"].includes(job.status) && (
                      <button
                        className="button subtle"
                        onClick={async () => {
                          try {
                            await post(`/jobs/${job.id}/cancel`);
                            await refresh();
                          } catch (e) {
                            notify(errorMessage(e), true);
                          }
                        }}
                      >
                        취소
                      </button>
                    )}
                    {job.status === "failed" && (
                      <button
                        className="button subtle"
                        onClick={async () => {
                          try {
                            const retried = await post<Job>(
                              `/jobs/${job.id}/retry`,
                            );
                            jobPayloads.current.set(
                              retried.id,
                              jobPayloads.current.get(job.id) || {},
                            );
                            await refresh();
                          } catch (e) {
                            notify(errorMessage(e), true);
                          }
                        }}
                      >
                        재시도
                      </button>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <Empty title="아직 진행한 작업이 없어요" />
            )}
          </div>
        </Modal>
      )}
      {!!activeJobs.length && !jobDrawer && (
        <button className="active-job" onClick={() => setJobDrawer(true)}>
          <Spinner />
          <span>
            {jobLabels[activeJobs[0].kind] || "작업"} 진행 중{" "}
            <small>
              {activeJobs.length > 1 ? `외 ${activeJobs.length - 1}개` : ""}
            </small>
          </span>
          <ChevronRight size={16} />
        </button>
      )}
      {toast && (
        <Toast
          message={toast.text}
          error={toast.error}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
function ActivityIcon() {
  return (
    <span className="activity-icon">
      <i />
      <i />
      <i />
    </span>
  );
}
function CloudIcon() {
  return <ArrowUpRight />;
}
function ProjectGrid({
  projects,
  onOpen,
  onNew,
}: {
  projects: Project[];
  onOpen: (p: Project) => void;
  onNew: () => void;
}) {
  return (
    <div className="project-grid">
      {projects.map((p, index) => (
        <button
          key={p.id}
          className="card project-card"
          onClick={() => onOpen(p)}
        >
          <span className={`project-icon color-${index % 3}`}>
            <FolderOpen size={23} />
          </span>
          <div>
            <h3>{p.name}</h3>
            <p>{p.rootPath || "코드와 시도를 모으는 공간"}</p>
          </div>
          <footer>
            <span>{p.excluded ? "수집 제외" : ".c · .cpp · .py"}</span>
            <ArrowUpRight size={16} />
          </footer>
        </button>
      ))}
      <button className="project-create" onClick={onNew}>
        <span>
          <Plus size={22} />
        </span>
        <strong>새 프로젝트 만들기</strong>
        <small>다음 풀이를 담을 공간</small>
      </button>
    </div>
  );
}
function Login({
  onLogin,
  notify,
}: {
  onLogin: (user: User) => void;
  notify: (s: string, e?: boolean) => void;
}) {
  const [email, setEmail] = useState("admin@local.test"),
    [busy, setBusy] = useState(false);
  const isLocal = process.env.NEXT_PUBLIC_AUTH_MODE !== "supabase";
  async function local(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await post<{ token: string; user: User }>("/auth/local", {
        email,
      });
      setToken(result.token);
      onLogin(await api<User>("/me"));
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      setBusy(false);
    }
  }
  async function oauth() {
    setBusy(true);
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
        key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !key)
        throw new Error("Supabase 공개 URL과 anon 키 설정이 필요합니다.");
      const { createClient } = await import("@supabase/supabase-js");
      const { error } = await createClient(url, key).auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo: `${location.origin}/auth/callback` },
      });
      if (error) throw error;
    } catch (e) {
      notify(errorMessage(e), true);
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-story">
        <div className="brand">
          <span className="brand-mark">
            <Braces size={25} />
          </span>
          <span>
            풀이의 기록<small>AUTOBLOGGER</small>
          </span>
        </div>
        <div className="login-headline">
          <div className="eyebrow">EVERY ATTEMPT TELLS A STORY</div>
          <h1>
            코드는 답을 남기고,
            <br />
            기록은 <em>과정</em>을 남깁니다.
          </h1>
          <p>
            실패한 실행도, 작은 수정도.
            <br />
            나만의 배움으로 이어지는 한 편의 풀이 기록.
          </p>
          <div className="login-path">
            <span>
              <Terminal size={20} />
              기록
            </span>
            <i />
            <span>
              <Sparkles size={20} />
              초안
            </span>
            <i />
            <span>
              <BookOpen size={20} />
              발행
            </span>
          </div>
        </div>
        <p className="login-bottom">일상의 풀이를, 오래 남을 이야기로.</p>
      </section>
      <section className="login-form">
        <div className="eyebrow">WELCOME TO YOUR WORKSPACE</div>
        <h2>나의 기록을 시작하세요</h2>
        <p className="muted">한 번의 풀이에서 한 편의 글까지.</p>
        {isLocal ? (
          <form onSubmit={local}>
            <div className="notice">
              <ShieldCheck size={17} />
              <span>
                로컬 개발 모드입니다. 실제 계정의 비밀번호는 입력하지 않습니다.
              </span>
            </div>
            <label>
              테스트 계정 이메일
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <button className="button primary full-width" disabled={busy}>
              {busy ? (
                <Spinner />
              ) : (
                <>
                  작업 공간 열기 <ArrowRight size={17} />
                </>
              )}
            </button>
            <div className="test-accounts">
              <button
                type="button"
                onClick={() => setEmail("admin@local.test")}
              >
                관리자 계정
              </button>
              <button
                type="button"
                onClick={() => setEmail("tester@local.test")}
              >
                일반 사용자 계정
              </button>
            </div>
          </form>
        ) : (
          <button
            className="button primary full-width"
            disabled={busy}
            onClick={oauth}
          >
            GitHub 계정으로 로그인 <ArrowRight size={17} />
          </button>
        )}
        <p className="login-policy">
          사용하는 데이터는 직접 관리할 수 있습니다.
          <br />
          <a href="/privacy">데이터 수집 및 보관 안내</a>
        </p>
      </section>
    </main>
  );
}
function ConnectBanner({
  params,
  notify,
  onClose,
}: {
  params: URLSearchParams;
  notify: (s: string, e?: boolean) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function pair() {
    try {
      const callback =
          params.get("callback") ||
          "vscode://molla11.autoblogger-recorder/auth",
        url = new URL(callback);
      if (
        url.protocol !== "vscode:" ||
        url.hostname !== "molla11.autoblogger-recorder" ||
        url.pathname !== "/auth"
      )
        throw new Error("허용되지 않은 확장 콜백 주소입니다.");
      const challenge = params.get("challenge");
      if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
        throw new Error(
          "올바른 기기 연결 요청이 아닙니다. 확장에서 로그인을 다시 시작해 주세요.",
        );
      setBusy(true);
      const { code } = await post<{ code: string }>("/devices/pair", {
        challenge,
        name: params.get("name") || "VS Code",
      });
      url.searchParams.set("code", code);
      url.searchParams.set("state", params.get("state") || "");
      window.location.assign(url.toString());
      onClose();
      notify("VS Code로 돌아가 연결을 완료해 주세요.");
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="connect-banner">
      <Link2 size={24} />
      <div>
        <strong>VS Code 확장을 이 계정에 연결할까요?</strong>
        <p>
          {params.get("name") || "VS Code"} · 연결 후 설정에서 언제든 기기
          인증을 폐기할 수 있습니다.
        </p>
      </div>
      <button className="button primary" disabled={busy} onClick={pair}>
        {busy ? "연결 중…" : "확장 연결"}
      </button>
      <button className="icon-button" aria-label="연결 취소" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}

function LiveDraft({ job }: { job: Job }) {
  const draft = draftPreview(job.stream?.text || "");
  return (
    <section className="live-draft" aria-label="작성 중인 초안">
      <div className="eyebrow">
        {job.status === "completed" ? "생성된 초안" : "작성 중인 초안"} · 근거
        검토 전
      </div>
      {draft.title && <h3>{draft.title}</h3>}
      {draft.paragraphs.length ? (
        draft.paragraphs.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))
      ) : (
        <p className="muted">본문을 작성하고 있습니다…</p>
      )}
    </section>
  );
}
