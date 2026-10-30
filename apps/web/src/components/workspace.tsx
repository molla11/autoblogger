"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Braces,
  ChevronRight,
  FileText,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Menu,
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
} from "lucide-react";
import {
  api,
  post,
  patch,
  getToken,
  setToken,
  ago,
  date,
  money,
  watchEvents,
  errorMessage,
  ApiError,
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
  PageHead,
  Spinner,
  StatStrip,
  Toast,
  articleStatusLabel,
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
    [articleFilter, setArticleFilter] = useState("all"),
    [mobileNav, setMobileNav] = useState(false),
    [busy, setBusy] = useState(false),
    [connectParams, setConnectParams] = useState<URLSearchParams | null>(null),
    [jobDrawer, setJobDrawer] = useState(false);
  const activeArticleId = useRef("");
  const [linkedFile, setLinkedFile] = useState("");
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
    let mounted = true;
    const initialization = new AbortController();
    async function init() {
      const params = new URLSearchParams(location.search);
      if (params.has("session") || params.get("view") === "settings") {
        const target = new URLSearchParams();
        for (const key of ["session", "file", "view"]) {
          const value = params.get(key);
          if (value && /^[a-zA-Z0-9_-]{1,100}$/.test(value)) target.set(key, value);
        }
        sessionStorage.setItem("autoblogger.open", target.toString());
      }
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
      const initialToken = getToken();
      if (initialToken) {
        try {
          const current = await api<User>("/me", {
            signal: initialization.signal,
          });
          if (mounted) setUser(current);
        } catch (error) {
          if (!mounted) return;
          if (
            error instanceof ApiError &&
            error.status === 401 &&
            getToken() === initialToken
          )
            setToken("");
          else
            notify(
              "연결을 확인한 뒤 새로고침해 주세요. 로그인 정보는 보존했습니다.",
              true,
            );
        }
      }
      if (mounted) setReady(true);
    }
    void init();
    return () => {
      mounted = false;
      initialization.abort();
      streams.current.forEach((controller) => controller.abort());
    };
  }, [notify]);
  useEffect(() => {
    if (user) void refresh();
  }, [user?.id, refresh]);
  useEffect(() => {
    if (!user) return;
    const raw = sessionStorage.getItem("autoblogger.open");
    if (!raw) return;
    const target = new URLSearchParams(raw);
    let cancelled = false;
    void (async () => {
      try {
        if (target.get("view") === "settings") setView("settings");
        else if (target.get("session")) {
          const value = await api<SessionDetail>(`/sessions/${encodeURIComponent(target.get("session")!)}`);
          const available = await api<Project[]>("/projects");
          if (cancelled) return;
          const parent = available.find(p => p.id === value.session.projectId);
          if (!parent) throw new Error("세션의 프로젝트를 찾을 수 없습니다.");
          const list = await api<Session[]>(`/projects/${parent.id}/sessions`);
          if (cancelled) return;
          const file = target.get("file") || "";
          if (file && !value.files.some(f => f.id === file)) throw new Error("선택한 파일이 삭제되었거나 접근할 수 없습니다.");
          setProject(parent); setSessions(list); setDetail(value); setLinkedFile(file); setArticle(null); setView("projects");
        }
        if (cancelled) return;
        sessionStorage.removeItem("autoblogger.open");
        const url = new URL(location.href);
        for (const key of ["session", "file", "view"]) url.searchParams.delete(key);
        history.replaceState(null, "", url);
      } catch (error) {
        if (!cancelled) {
          notify(error instanceof ApiError && [403,404].includes(error.status) ? "세션이 삭제되었거나 현재 계정으로 접근할 수 없습니다." : errorMessage(error), true);
          if (error instanceof ApiError && [403,404].includes(error.status)) sessionStorage.removeItem("autoblogger.open");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, notify]);
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
    setArticleFilter("all");
    setMobileNav(false);
  };
  const activeJobs = jobs.filter((j) =>
    ["running", "queued"].includes(j.status),
  );
  useEffect(() => {
    if (!mobileNav) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNav(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [mobileNav]);
  const deleteArticle = async (target: Article) => {
    if (!confirm("보관함에서 이 글을 삭제할까요?")) return;
    try {
      await api(`/articles/${target.id}`, { method: "DELETE" });
      await refresh();
    } catch (e) {
      notify(errorMessage(e), true);
    }
  };
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
  const usedThisMonth = Number(user.usage?.month || 0),
    monthlyLimit = user.monthlyLimit || 15;
  const query = search.trim().toLowerCase();
  const articleFilters = [
    { id: "all", label: "전체", match: () => true },
    {
      id: "local",
      label: "내 보관함",
      match: (a: Article) => !["draft", "published"].includes(a.status),
    },
    {
      id: "draft",
      label: "Ghost 초안",
      match: (a: Article) => a.status === "draft",
    },
    {
      id: "published",
      label: "공개",
      match: (a: Article) => a.status === "published",
    },
    {
      id: "completed",
      label: "편집 완료",
      match: (a: Article) => !!a.editingCompletedAt,
    },
  ];
  const activeFilter =
    articleFilters.find((f) => f.id === articleFilter) || articleFilters[0];
  const visibleArticles = articles.filter(
    (a) =>
      activeFilter.match(a) && (a.title || "").toLowerCase().includes(query),
  );
  const sessionIndex = detail
    ? sessions.findIndex((s) => s.id === detail.session.id)
    : -1;
  const newProjectButton = (
    <button className="button primary" onClick={() => setNewProject(true)}>
      <Plus size={15} />새 프로젝트
    </button>
  );
  return (
    <div className={`app-shell ${article ? "editing" : ""}`}>
      <header className="topbar">
        <button
          className="icon-button mobile-menu"
          onClick={() => setMobileNav(!mobileNav)}
          aria-label="메뉴 열기"
          aria-expanded={mobileNav}
        >
          <Menu size={19} />
        </button>
        <button className="brand" onClick={() => navigate("home")}>
          <span className="brand-mark">
            <Braces size={15} />
          </span>
          <span className="brand-name">풀이의 기록</span>
        </button>
        <nav className={`topnav ${mobileNav ? "open" : ""}`} aria-label="주 메뉴">
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
              className={view === item.id && !article ? "active" : ""}
              aria-current={view === item.id && !article ? "page" : undefined}
              key={item.id}
              onClick={() => navigate(item.id as View)}
            >
              <item.icon size={15} />
              {item.label}
              {item.id === "articles" && <small>{articles.length}</small>}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <button
            className={`job-indicator ${activeJobs.length ? "busy" : ""}`}
            onClick={() => setJobDrawer(true)}
          >
            {activeJobs.length ? <Spinner /> : <ActivityIcon />}
            <span className="job-label">
              {activeJobs.length
                ? `${jobLabels[activeJobs[0].kind] || "작업"} 진행 중${activeJobs.length > 1 ? ` 외 ${activeJobs.length - 1}개` : ""}`
                : "작업 내역"}
            </span>
          </button>
          <ProfileMenu
            user={user}
            used={usedThisMonth}
            limit={monthlyLimit}
            onSettings={() => navigate("settings")}
            onLogout={logout}
          />
        </div>
      </header>
      {mobileNav && (
        <div
          className="nav-scrim"
          aria-hidden="true"
          onClick={() => setMobileNav(false)}
        />
      )}
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
              <PageHead
                title="오늘의 풀이가, 내일의 기록이 되도록."
                description="코드에 남지 않은 생각과 시도를 한 편의 글로 이어보세요."
                actions={
                  <>
                    <button
                      className="button subtle"
                      onClick={sample}
                      disabled={busy}
                    >
                      {busy ? <Spinner /> : <Play size={14} />}샘플로 둘러보기
                    </button>
                    {newProjectButton}
                  </>
                }
              />
              <StatStrip
                items={[
                  { label: "프로젝트", value: projects.length, unit: "개" },
                  {
                    label: "보관함의 글",
                    value: articles.length,
                    unit: "편",
                    hint: `편집 완료 ${articles.filter((a) => a.editingCompletedAt).length}편`,
                  },
                  {
                    label: "공개한 글",
                    value: articles.filter((a) => a.status === "published")
                      .length,
                    unit: "편",
                    hint: "Ghost에 발행",
                  },
                  {
                    label: "이번 달 AI 사용량",
                    value: money(usedThisMonth),
                    hint: `/ $${monthlyLimit}`,
                    meter: usedThisMonth / monthlyLimit,
                  },
                ]}
              />
              <div className="dash-grid">
                <section className="panel">
                  <header className="panel-head">
                    <h2>최근 프로젝트</h2>
                    <button
                      className="text-button"
                      onClick={() => navigate("projects")}
                    >
                      모두 보기 <ArrowRight size={14} />
                    </button>
                  </header>
                  {projects.length ? (
                    <ProjectList
                      projects={projects.slice(0, 5)}
                      onOpen={loadProject}
                    />
                  ) : (
                    <Empty compact title="아직 프로젝트가 없어요">
                      기록할 작업 폴더마다 프로젝트를 하나씩 만드세요.
                    </Empty>
                  )}
                </section>
                <section className="panel">
                  <header className="panel-head">
                    <h2>최근 글</h2>
                    <button
                      className="text-button"
                      onClick={() => navigate("articles")}
                    >
                      모두 보기 <ArrowRight size={14} />
                    </button>
                  </header>
                  {articles.length ? (
                    <ArticleList
                      articles={articles.slice(0, 5)}
                      onOpen={(id) => void openArticle(id)}
                    />
                  ) : (
                    <Empty compact title="아직 글이 없어요">
                      풀이 세션에서 ‘초안 만들기’를 누르면 여기에 글이
                      생깁니다.
                    </Empty>
                  )}
                </section>
              </div>
              {!articles.length && (
                <section className="steps" aria-label="VS Code에서 기록하는 순서">
                  <Terminal size={18} />
                  <strong>VS Code에서 풀이를 기록하세요</strong>
                  <ol>
                    <li>확장 연결</li>
                    <li>기록 시작</li>
                    <li>통합 터미널에서 실행</li>
                    <li>초안 만들기</li>
                  </ol>
                  <button
                    className="text-button"
                    onClick={() => navigate("settings")}
                  >
                    연결 안내 <ArrowUpRight size={14} />
                  </button>
                </section>
              )}
            </>
          )}
          {view === "projects" &&
            (detail ? (
              <Timeline
                key={detail.session.id}
                detail={detail}
                title={
                  sessionIndex >= 0
                    ? `풀이 세션 ${sessions.length - sessionIndex}`
                    : "풀이 세션"
                }
                backLabel={project?.name || "세션 목록"}
                initialFile={linkedFile}
                articles={articles.filter(
                  (a) => a.sessionId === detail.session.id,
                )}
                usage={{
                  day: Number(user.usage?.day || 0),
                  dayLimit: user.dailyLimit ?? 3,
                  month: usedThisMonth,
                  monthLimit: monthlyLimit,
                }}
                onOpenArticle={(id) => void openArticle(id)}
                onBack={() => setDetail(null)}
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
            ) : project ? (
              <>
                <PageHead
                  back={{ label: "풀이 기록", onClick: () => setProject(null) }}
                  title={
                    <>
                      {project.name}
                      {project.excluded && (
                        <Badge tone="amber">수집 제외</Badge>
                      )}
                    </>
                  }
                  actions={
                    <>
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
                        <Trash2 size={16} />
                      </button>
                    </>
                  }
                >
                  <p className="mono path">
                    {project.rootPath || "확장에서 작업 폴더를 연결해 주세요."}
                  </p>
                </PageHead>
                <details className="disclosure">
                  <summary>
                    수집 제외 패턴
                    <Badge>{(project.excludePatterns || []).length}</Badge>
                    <span className="field-hint">
                      일치하는 파일은 기록하지 않습니다
                    </span>
                  </summary>
                  <label>
                    제외할 경로 패턴{" "}
                    <span className="field-hint">한 줄에 하나씩 입력</span>
                    <textarea
                      key={project.id}
                      defaultValue={(project.excludePatterns || []).join("\n")}
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
                      placeholder={"private/**\n**/secret.cpp"}
                      rows={3}
                    />
                  </label>
                </details>
                <section className="panel">
                  <header className="panel-head">
                    <h2>
                      풀이 세션 <Badge>{sessions.length}</Badge>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => void loadProject(project)}
                    >
                      <RefreshCw size={13} />
                      새로고침
                    </button>
                  </header>
                  {sessions.length ? (
                    <ul className="row-list">
                      {sessions.map((session, index) => (
                        <li key={session.id}>
                          <button
                            className="row"
                            onClick={() => void loadSession(session.id)}
                          >
                            <span className="row-icon">
                              <Terminal size={15} />
                            </span>
                            <span className="row-main">
                              <strong>풀이 세션 {sessions.length - index}</strong>
                              <small>{date(session.startedAt)} 시작</small>
                            </span>
                            <Badge tone={session.endedAt ? "neutral" : "green"}>
                              {session.endedAt ? "기록 종료" : "기록 중"}
                            </Badge>
                            <ChevronRight size={16} className="row-chevron" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty compact icon={<Terminal />} title="첫 풀이를 기다리고 있어요">
                      VS Code 확장에서 이 프로젝트를 선택하고 기록을 시작해
                      주세요.
                    </Empty>
                  )}
                </section>
              </>
            ) : (
              <>
                <PageHead
                  title="풀이 기록"
                  description="프로젝트를 열어 코드가 바뀌어 온 과정을 살펴보세요."
                  actions={newProjectButton}
                />
                {projects.length ? (
                  <section className="panel">
                    <ProjectList projects={projects} onOpen={loadProject} />
                  </section>
                ) : (
                  <Empty
                    icon={<FolderOpen />}
                    title="아직 프로젝트가 없어요"
                    action={
                      <div className="actions">
                        {newProjectButton}
                        <button
                          className="button subtle"
                          onClick={sample}
                          disabled={busy}
                        >
                          샘플로 둘러보기
                        </button>
                      </div>
                    }
                  >
                    기록할 작업 폴더마다 프로젝트를 하나씩 만드세요.
                  </Empty>
                )}
              </>
            ))}
          {view === "articles" && (
            <>
              <PageHead
                title="글 보관함"
                description="기록에서 시작해, 내 언어로 완성한 이야기들."
              />
              {articles.length ? (
                <>
                  <div className="list-toolbar">
                    <div className="chips" role="group" aria-label="글 상태">
                      {articleFilters.map((f) => (
                        <button
                          key={f.id}
                          className={activeFilter.id === f.id ? "active" : ""}
                          aria-pressed={activeFilter.id === f.id}
                          onClick={() => setArticleFilter(f.id)}
                        >
                          {f.label}
                          <small>{articles.filter(f.match).length}</small>
                        </button>
                      ))}
                    </div>
                    <div className="search">
                      <Search size={15} />
                      <input
                        aria-label="글 검색"
                        placeholder="글 제목 검색"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                  </div>
                  {visibleArticles.length ? (
                    <section className="panel">
                      <ArticleList
                        articles={visibleArticles}
                        onOpen={(id) => void openArticle(id)}
                        onDelete={(a) => void deleteArticle(a)}
                      />
                    </section>
                  ) : (
                    <Empty compact title="조건에 맞는 글이 없어요">
                      다른 상태를 고르거나 검색어를 바꿔 보세요.
                    </Empty>
                  )}
                </>
              ) : (
                <Empty
                  icon={<BookOpen size={26} />}
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
              <Plus size={15} />
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
                  <div className="job-main">
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
                  {["queued", "running"].includes(job.status) && (
                    <div className="job-progress">
                      <i
                        style={{
                          width: `${job.progress <= 1 ? job.progress * 100 : job.progress}%`,
                        }}
                      />
                    </div>
                  )}
                  {job.error && <p className="danger">{job.error}</p>}
                  {job.kind === "generate" && job.stream?.text && (
                    <LiveDraft job={job} />
                  )}
                </div>
              ))
            ) : (
              <Empty compact title="아직 진행한 작업이 없어요" />
            )}
          </div>
        </Modal>
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
    <span className="activity-icon" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
function ProfileMenu({
  user,
  used,
  limit,
  onSettings,
  onLogout,
}: {
  user: User;
  used: number;
  limit: number;
  onSettings: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="profile" ref={ref}>
      <button
        className="avatar-button"
        aria-label="계정 메뉴"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="avatar">{user.email[0].toUpperCase()}</span>
      </button>
      {open && (
        <div className="profile-menu">
          <div className="profile-id">
            <strong>{user.email}</strong>
            <small>{user.role === "admin" ? "관리자 계정" : "개인 계정"}</small>
          </div>
          <div className="usage">
            <span>이번 달 AI 사용량</span>
            <strong>
              {money(used)} <small>/ ${limit}</small>
            </strong>
            <div className="usage-track">
              <i style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
            </div>
          </div>
          <button
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            <Settings2 size={15} />
            연결과 데이터
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <LogOut size={15} />
            로그아웃
          </button>
        </div>
      )}
    </div>
  );
}
function ProjectList({
  projects,
  onOpen,
}: {
  projects: Project[];
  onOpen: (p: Project) => void;
}) {
  return (
    <ul className="row-list">
      {projects.map((p) => (
        <li key={p.id}>
          <button className="row" onClick={() => onOpen(p)}>
            <span className="row-icon">
              <FolderOpen size={15} />
            </span>
            <span className="row-main">
              <strong>{p.name}</strong>
              <small className="mono">
                {p.rootPath || "작업 폴더 미연결"}
              </small>
            </span>
            {p.excluded ? (
              <Badge tone="amber">수집 제외</Badge>
            ) : (
              p.createdAt && (
                <span className="row-meta" title={date(p.createdAt)}>
                  {ago(p.createdAt)} 생성
                </span>
              )
            )}
            <ChevronRight size={16} className="row-chevron" />
          </button>
        </li>
      ))}
    </ul>
  );
}
function ArticleList({
  articles,
  onOpen,
  onDelete,
}: {
  articles: Article[];
  onOpen: (id: string) => void;
  onDelete?: (article: Article) => void;
}) {
  return (
    <ul className="row-list">
      {articles.map((a) => (
        <li key={a.id} className="row article-row">
          <span className="row-icon">
            <FileText size={15} />
          </span>
          <div className="row-main">
            <h3>
              <button className="row-link" onClick={() => onOpen(a.id)}>
                {a.title || "제목 없는 글"}
              </button>
            </h3>
            <small>
              {(a.blocks || [])
                .find((b) => b.type === "paragraph")
                ?.text.slice(0, 120) ||
                "원본 기록을 보며 나의 풀이를 정리해 보세요."}
            </small>
          </div>
          <span className="row-badges">
            <Badge tone={a.status === "published" ? "green" : "neutral"}>
              {articleStatusLabel(a.status)}
            </Badge>
            {a.editingCompletedAt && <Badge tone="green">편집 완료</Badge>}
          </span>
          <span className="row-meta" title={date(a.updatedAt)}>
            {ago(a.updatedAt)} 수정
          </span>
          {onDelete && (
            <button
              className="icon-button danger row-action"
              aria-label={`${a.title} 삭제`}
              onClick={() => onDelete(a)}
            >
              <Trash2 size={15} />
            </button>
          )}
        </li>
      ))}
    </ul>
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
            <Braces size={17} />
          </span>
          <span className="brand-name">풀이의 기록</span>
        </div>
        <div className="login-headline">
          <h1>
            코드는 답을 남기고,
            <br />
            기록은 과정을 남깁니다.
          </h1>
          <p>
            실패한 실행도, 작은 수정도. 나만의 배움으로 이어지는 한 편의 풀이
            기록.
          </p>
          <ol className="login-path">
            <li>
              <Terminal size={17} />
              <span>
                <strong>기록</strong>
                <small>VS Code에서 저장·실행·메모</small>
              </span>
            </li>
            <li>
              <Sparkles size={17} />
              <span>
                <strong>초안</strong>
                <small>근거가 연결된 글 생성</small>
              </span>
            </li>
            <li>
              <BookOpen size={17} />
              <span>
                <strong>발행</strong>
                <small>편집 후 Ghost로 전송</small>
              </span>
            </li>
          </ol>
        </div>
      </section>
      <section className="login-form">
        <h2>나의 기록을 시작하세요</h2>
        <p className="muted">한 번의 풀이에서 한 편의 글까지.</p>
        {isLocal ? (
          <form onSubmit={local}>
            <div className="notice">
              <ShieldCheck size={16} />
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
                  작업 공간 열기 <ArrowRight size={16} />
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
            GitHub 계정으로 로그인 <ArrowRight size={16} />
          </button>
        )}
        <p className="login-policy">
          사용하는 데이터는 직접 관리할 수 있습니다.{" "}
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
      <Link2 size={20} />
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
      <div className="live-draft-label">
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
