"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import UniqueID from "@tiptap/extension-unique-id";
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Bold,
  Italic,
  Heading2,
  List,
  Quote,
  Code2,
  ImagePlus,
  Undo2,
  Redo2,
  Link2,
  Check,
  FileDown,
  Eye,
  History,
  CloudUpload,
  Sparkles,
  PanelLeftClose,
  PanelRightClose,
  GripVertical,
  Plus,
  X,
  RefreshCw,
  AlertTriangle,
  Trash2,
} from "lucide-react";
import {
  api,
  post,
  download,
  date,
  ApiError,
  errorMessage,
  API_URL,
} from "@/lib/api";
import {
  articleDocument,
  documentBlocks,
  editorPayload,
  blocksToDocument,
  reorderBlocks,
  newId,
} from "@/lib/editor-model";
import type {
  Article,
  ArticleBlock,
  RecordEvent,
  Revision,
  Suggestion,
  SessionDetail,
  Job,
} from "@/lib/types";
import { Badge, Modal, Empty, Spinner, reviewLabels } from "./ui";
import { EventDetail, eventName } from "./timeline";
interface Props {
  article: Article;
  onBack: () => void;
  onSaved: (article: Article) => void;
  notify: (s: string, error?: boolean) => void;
  startJob: (payload: Record<string, unknown>) => Promise<Job | undefined>;
}
export default function ArticleEditor({
  article: initial,
  onBack,
  onSaved,
  notify,
  startJob,
}: Props) {
  const [article, setArticle] = useState(initial),
    [title, setTitle] = useState(initial.title),
    [blocks, setBlocks] = useState(initial.blocks || []),
    [events, setEvents] = useState<RecordEvent[]>([]),
    [selected, setSelected] = useState(""),
    [dirty, setDirty] = useState(false),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState(""),
    [conflict, setConflict] = useState(false),
    [modal, setModal] = useState<"preview" | "versions" | "remote" | null>(
      null,
    ),
    [preview, setPreview] = useState(""),
    [versions, setVersions] = useState<Revision[]>([]),
    [suggestions, setSuggestions] = useState<Suggestion[]>([]),
    [remote, setRemote] = useState<unknown>(null),
    [remoteChanged, setRemoteChanged] = useState(false),
    [remoteTarget, setRemoteTarget] = useState<"draft" | "published" | null>(
      null,
    ),
    [left, setLeft] = useState(true),
    [right, setRight] = useState(true),
    [slash, setSlash] = useState(false),
    [instruction, setInstruction] = useState("더 짧게"),
    [dragIndex, setDragIndex] = useState<number | null>(null);
  const articleRef = useRef(article),
    blocksRef = useRef(blocks),
    titleRef = useRef(title),
    savingRef = useRef(false),
    dirtyRef = useRef(false),
    lastSaved = useRef(""),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    saveRef = useRef<() => Promise<boolean>>(async () => false),
    inflightSave = useRef<Promise<boolean> | null>(null),
    fileRef = useRef<HTMLInputElement>(null);
  articleRef.current = article;
  blocksRef.current = blocks;
  titleRef.current = title;
  const markDirty = () => {
    dirtyRef.current = true;
    setDirty(true);
    setSaveError("");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveRef.current(), 1100);
  };
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: { HTMLAttributes: { class: "code-block" } },
      }),
      Image.configure({ allowBase64: false }),
      Placeholder.configure({
        placeholder: "기록에서 시작해, 당신의 말로 이어 쓰세요. / 로 블록 추가",
      }),
      UniqueID.configure({
        types: [
          "heading",
          "paragraph",
          "blockquote",
          "codeBlock",
          "bulletList",
          "orderedList",
          "image",
        ],
        attributeName: "id",
      }),
    ],
    content: articleDocument(initial),
    editorProps: {
      attributes: {
        class: "prose-editor",
        "aria-label": "글 본문",
        role: "textbox",
        "aria-multiline": "true",
      },
      handleKeyDown(_view, event) {
        if (
          event.key === "/" &&
          _view.state.selection.empty &&
          _view.state.selection.$from.parent.textContent === ""
        ) {
          event.preventDefault();
          setSlash(true);
          return true;
        }
        return false;
      },
    },
    onUpdate({ editor }) {
      setBlocks(documentBlocks(editor.getJSON(), blocksRef.current));
      markDirty();
    },
    onSelectionUpdate({ editor }) {
      const { $from } = editor.state.selection;
      if ($from.depth >= 1) setSelected(String($from.node(1).attrs.id || ""));
    },
  });
  useEffect(() => {
    api<SessionDetail>(`/sessions/${article.sessionId}`)
      .then((d) => setEvents(d.events || []))
      .catch((e) => notify(errorMessage(e), true));
  }, [article.sessionId, notify]);
  useEffect(() => {
    const load = () =>
      api<Suggestion[]>(`/articles/${article.id}/suggestions`)
        .then(setSuggestions)
        .catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [article.id]);
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    const origin = new URL(API_URL).origin;
    const sources: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "image" && node.attrs.src)
        sources.push(String(node.attrs.src));
    });
    for (const src of sources) {
      let url: URL;
      try {
        url = new URL(src, API_URL);
      } catch {
        continue;
      }
      const match = /^\/api\/uploads\/([^/]+)$/.exec(url.pathname);
      if (
        url.origin !== origin ||
        !match ||
        Number(url.searchParams.get("expires") || 0) > Date.now() + 60000
      )
        continue;
      api<{ url: string }>(`/uploads/${encodeURIComponent(match[1])}/url`)
        .then((value) => {
          if (cancelled || editor.isDestroyed) return;
          editor.commands.command(({ tr }) => {
            tr.doc.descendants((node, position) => {
              if (node.type.name === "image" && node.attrs.src === src)
                tr.setNodeMarkup(position, undefined, {
                  ...node.attrs,
                  src: new URL(value.url, API_URL).href,
                });
            });
            return true;
          });
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [editor, initial.id]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  useEffect(() => {
    if (window.matchMedia("(max-width: 780px)").matches) {
      setLeft(false);
      setRight(false);
    }
  }, []);
  useEffect(() => {
    if (!initial.publication?.remoteId) return;
    api<{ remote: unknown; conflict: boolean }>(
      `/articles/${initial.id}/remote`,
    )
      .then((value) => {
        setRemote(value);
        setRemoteChanged(value.conflict);
      })
      .catch(() => {});
  }, [initial.id, initial.publication?.updatedAt]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
  useEffect(() => {
    const current = articleRef.current;
    if (
      initial.version > current.version &&
      !dirtyRef.current &&
      !savingRef.current
    ) {
      setArticle(initial);
      setTitle(initial.title);
      setBlocks(initial.blocks);
      editor?.commands.setContent(articleDocument(initial), {
        emitUpdate: false,
      });
    } else if (initial.version === current.version) {
      const reviewed = new Map(
        initial.blocks.map((block) => [block.id, block]),
      );
      const merged = blocksRef.current.map((block) => {
        const remote = reviewed.get(block.id);
        return remote &&
          remote.text === block.text &&
          remote.type === block.type &&
          remote.language === block.language &&
          remote.url === block.url &&
          JSON.stringify(remote.evidenceIds) ===
            JSON.stringify(block.evidenceIds)
          ? { ...block, review: remote.review }
          : block;
      });
      if (JSON.stringify(merged) !== JSON.stringify(blocksRef.current)) {
        blocksRef.current = merged;
        setBlocks(merged);
      }
      if (
        current.status !== initial.status ||
        JSON.stringify(current.publication) !==
          JSON.stringify(initial.publication) ||
        current.editingCompletedAt !== initial.editingCompletedAt
      )
        setArticle((value) => ({
          ...value,
          status: initial.status,
          publication: initial.publication,
          editingCompletedAt: initial.editingCompletedAt,
        }));
    }
  }, [initial, editor]);
  const save = useCallback(async (): Promise<boolean> => {
    if (!editor || conflict) return false;
    // An explicit action (preview, export, publish) during autosave waits for
    // that request and then saves anything typed meanwhile.
    if (savingRef.current) {
      await inflightSave.current;
      return saveRef.current();
    }
    if (!dirtyRef.current) return true;
    savingRef.current = true;
    setSaving(true);
    let settle: (value: boolean) => void = () => {};
    inflightSave.current = new Promise((resolve) => (settle = resolve));
    const document = editor.getJSON();
    const snapshot = JSON.stringify({
      document,
      title: titleRef.current,
      blocks: blocksRef.current,
    });
    try {
      const result = await api<Article>(`/articles/${articleRef.current.id}`, {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: articleRef.current.version,
          title: titleRef.current,
          lexical: editorPayload(document, editor.getHTML()),
          blocks: documentBlocks(document, blocksRef.current),
          kind: "auto",
        }),
      });
      setArticle(result);
      articleRef.current = result;
      onSaved(result);
      lastSaved.current = snapshot;
      setSaveError("");
      const current = JSON.stringify({
        document: editor.getJSON(),
        title: titleRef.current,
        blocks: blocksRef.current,
      });
      if (current === snapshot) {
        dirtyRef.current = false;
        setDirty(false);
        setBlocks(result.blocks);
      }
      settle(current === snapshot);
      return current === snapshot;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      setSaveError(errorMessage(error));
      settle(false);
      return false;
    } finally {
      savingRef.current = false;
      inflightSave.current = null;
      setSaving(false);
      if (dirtyRef.current && !conflict)
        saveTimer.current = setTimeout(() => void saveRef.current(), 2500);
    }
  }, [editor, conflict, onSaved]);
  saveRef.current = save;
  const currentBlock = blocks.find((b) => b.id === selected) || blocks[0];
  async function reload() {
    const latest = await api<Article>(`/articles/${article.id}`);
    editor?.commands.setContent(articleDocument(latest), { emitUpdate: false });
    setArticle(latest);
    setBlocks(latest.blocks);
    setTitle(latest.title);
    dirtyRef.current = false;
    setDirty(false);
    setConflict(false);
    setSaveError("");
    onSaved(latest);
  }
  function addEvidence(event: RecordEvent) {
    if (!editor) return;
    const text =
      event.type === "memo"
        ? String(event.data.text || "")
        : event.type === "run"
          ? `${String(event.data.command || "실행")} — ${String(event.data.status || "판단 불가")} (종료 코드 ${event.data.exitCode ?? "없음"})`
          : event.type === "snapshot"
            ? String(event.data.content || "")
            : String(event.data.diff || event.data.after || "");
    const block: ArticleBlock = {
      id: newId(),
      type:
        event.type === "snapshot" || event.type === "edit"
          ? "code"
          : "paragraph",
      text,
      language: event.filePath?.endsWith(".py") ? "python" : "cpp",
      evidenceIds: [event.id],
      review: "needs_review",
    };
    blocksRef.current = [...blocksRef.current, block];
    editor
      .chain()
      .focus()
      .insertContent(blocksToDocument([block]).content!)
      .run();
    setSelected(block.id);
    markDirty();
  }
  function toggleEvidence(id: string) {
    if (!currentBlock) return;
    const next = blocksRef.current.map((b) =>
      b.id === currentBlock.id
        ? {
            ...b,
            evidenceIds: b.evidenceIds.includes(id)
              ? b.evidenceIds.filter((e) => e !== id)
              : [...b.evidenceIds, id],
            review: "needs_review" as const,
          }
        : b,
    );
    blocksRef.current = next;
    setBlocks(next);
    markDirty();
  }
  async function upload(file?: File) {
    if (!file || !editor) return;
    try {
      const form = new FormData();
      form.set("file", file);
      const result = await api<{ url: string }>("/uploads", {
        method: "POST",
        body: form,
      });
      editor
        .chain()
        .focus()
        .setImage({ src: new URL(result.url, API_URL).href, alt: file.name })
        .run();
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function showPreview() {
    if (!(await save())) return;
    try {
      const result = await api<{ html: string }>(
        `/articles/${article.id}/preview`,
      );
      setPreview(result.html);
      setModal("preview");
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function showVersions() {
    try {
      setVersions(await api<Revision[]>(`/articles/${article.id}/revisions`));
      setModal("versions");
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function restore(revisionId: string) {
    if (
      dirtyRef.current &&
      !confirm("저장하지 않은 편집 내용을 대신해 이 버전을 복원할까요?")
    )
      return;
    try {
      const result = await post<Article>(`/articles/${article.id}/restore`, {
        revisionId,
        expectedVersion: articleRef.current.version,
      });
      editor?.commands.setContent(articleDocument(result), {
        emitUpdate: false,
      });
      setArticle(result);
      setTitle(result.title);
      setBlocks(result.blocks);
      dirtyRef.current = false;
      setDirty(false);
      onSaved(result);
      setModal(null);
      notify("선택한 버전을 복원했습니다.");
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function exportMarkdown() {
    if (!(await save())) return;
    try {
      const result = await api<{ markdown: string }>(
        `/articles/${article.id}/markdown`,
      );
      download(`${title || "풀이 기록"}.md`, result.markdown, "text/markdown");
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function suggest() {
    if (!(await save()) || !currentBlock) return;
    await startJob({
      kind: "suggest",
      articleId: article.id,
      blockId: currentBlock.id,
      instruction,
    });
  }
  async function resolveSuggestion(s: Suggestion, action: "accept" | "reject") {
    if (!(await save())) return;
    if (
      action === "accept" &&
      s.baseVersion !== undefined &&
      s.baseVersion !== articleRef.current.version
    ) {
      notify(
        "제안을 만든 뒤 글이 바뀌었습니다. 아래 비교 내용을 확인하고 새 제안을 요청해 주세요.",
        true,
      );
      return;
    }
    try {
      await post(`/suggestions/${s.id}/resolve`, {
        action,
        expectedVersion: articleRef.current.version,
      });
      setSuggestions(await api(`/articles/${article.id}/suggestions`));
      if (action === "accept") await reload();
      notify(
        action === "accept" ? "제안을 적용했습니다." : "제안을 거절했습니다.",
      );
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function publish(targetStatus: "draft" | "published") {
    if (!(await save())) return;
    try {
      const state = await api<{
        remote: Record<string, unknown> | null;
        conflict: boolean;
        fingerprint?: string;
      }>(`/articles/${article.id}/remote`);
      if (state.conflict) {
        setRemote(state);
        setRemoteChanged(true);
        setRemoteTarget(targetStatus);
        setModal("remote");
        return;
      }
      await startJob({
        kind: "publish",
        articleId: article.id,
        targetStatus,
        expectedRemoteUpdatedAt: state.remote?.updated_at,
        expectedRemoteFingerprint: state.fingerprint,
      });
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function completeEditing() {
    if (!(await save())) return;
    try {
      const result = await post<Article>(`/articles/${article.id}/complete`, {
        expectedVersion: articleRef.current.version,
      });
      setArticle(result);
      onSaved(result);
      notify("편집을 완료했습니다. 보관함의 글도 완료 기록에 포함됩니다.");
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function applyComparedRemote() {
    if (!(await save())) return;
    const post = (remote as { remote?: Record<string, unknown> } | null)
      ?.remote;
    if (!post?.updated_at) {
      notify("원격 수정 시각을 확인할 수 없습니다. 다시 비교해 주세요.", true);
      return;
    }
    const job = await startJob({
      kind: "publish",
      articleId: article.id,
      targetStatus:
        remoteTarget || (post.status === "published" ? "published" : "draft"),
      expectedRemoteUpdatedAt: post.updated_at,
      expectedRemoteFingerprint: (remote as { fingerprint?: string })
        ?.fingerprint,
    });
    if (job) {
      setModal(null);
      setRemoteChanged(false);
    }
  }
  const toolbarItem = (
    label: string,
    icon: React.ReactNode,
    fn: () => void,
    active = false,
  ) => (
    <button
      title={label}
      aria-label={label}
      className={`tool ${active ? "active" : ""}`}
      onClick={fn}
    >
      {icon}
    </button>
  );
  function move(index: number, direction: -1 | 1) {
    if (!editor) return;
    editor.commands.setContent(
      reorderBlocks(editor.getJSON(), index, direction),
    );
  }
  const insert = (type: string) => {
    if (!editor) return;
    const chain = editor.chain().focus();
    if (type === "heading") chain.toggleHeading({ level: 2 }).run();
    else if (type === "code") chain.toggleCodeBlock().run();
    else if (type === "list") chain.toggleBulletList().run();
    else if (type === "quote") chain.toggleBlockquote().run();
    else if (type === "image") fileRef.current?.click();
    else chain.setParagraph().run();
    setSlash(false);
  };
  return (
    <section className="editor-workspace">
      <div className="editor-topbar">
        <button
          className="button subtle"
          onClick={() => {
            if (
              !dirtyRef.current ||
              confirm(
                "저장하지 않은 편집 내용이 있습니다. 작업 공간으로 나갈까요?",
              )
            )
              onBack();
          }}
        >
          <ArrowLeft size={16} />
          보관함
        </button>
        <span className={`save-state ${saveError ? "danger" : ""}`}>
          {saving ? (
            <>
              <Spinner />
              저장 중
            </>
          ) : conflict ? (
            <>
              <AlertTriangle size={14} />
              저장 충돌
            </>
          ) : dirty ? (
            "저장하지 않은 변경"
          ) : (
            <>
              <Check size={14} />
              저장됨 · v{article.version}
            </>
          )}
        </span>
        <div className="actions">
          <button
            className="button secondary"
            disabled={saving || (!!article.editingCompletedAt && !dirty)}
            onClick={completeEditing}
          >
            <Check size={16} />
            {article.editingCompletedAt && !dirty ? "편집 완료됨" : "편집 완료"}
          </button>
          <button className="button subtle" onClick={showVersions}>
            <History size={16} />
            버전
          </button>
          <button
            className="button subtle"
            aria-label="Markdown"
            onClick={exportMarkdown}
          >
            <FileDown size={16} />
            <span className="hide-small">Markdown</span>
          </button>
          <button className="button subtle" onClick={showPreview}>
            <Eye size={16} />
            미리보기
          </button>
          <button
            className="button secondary"
            onClick={() => void publish("draft")}
          >
            <CloudUpload size={16} />
            Ghost 초안
          </button>
          <button
            className="button primary"
            onClick={() => void publish("published")}
          >
            공개{article.status === "published" ? "본 업데이트" : "하기"}
          </button>
        </div>
      </div>
      {saveError && (
        <div className="notice warning">
          <span>
            {conflict
              ? "다른 탭에서 문서가 수정되었습니다. 현재 편집 내용은 유지됩니다."
              : saveError}
          </span>
          <button
            onClick={() =>
              download("unsaved-article.json", {
                title,
                blocks,
                document: editor?.getJSON(),
              })
            }
          >
            현재 편집 내려받기
          </button>
          {conflict ? (
            <button
              onClick={() => {
                if (confirm("현재 편집 내용을 최신 서버 버전으로 바꿀까요?"))
                  void reload();
              }}
            >
              서버 버전 불러오기
            </button>
          ) : (
            <button onClick={() => void save()}>저장 재시도</button>
          )}
        </div>
      )}
      {remoteChanged && (
        <div className="notice warning">
          Ghost에서 글이 변경되었습니다.
          <button onClick={() => setModal("remote")}>원격 변경 비교</button>
        </div>
      )}
      <div
        className={`editor-columns ${!left ? "left-closed" : ""} ${!right ? "right-closed" : ""}`}
      >
        <aside className="editor-sidebar left">
          <div className="panel-heading">
            <span>목차와 사건</span>
            <button
              className="icon-button"
              onClick={() => setLeft(false)}
              aria-label="왼쪽 패널 접기"
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
          <div className="outline">
            {blocks.map((block, index) => (
              <div
                key={block.id}
                className={`outline-item ${currentBlock?.id === block.id ? "active" : ""}`}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex === null || !editor) return;
                  const json = editor.getJSON(),
                    content = [...(json.content || [])];
                  const [moved] = content.splice(dragIndex, 1);
                  content.splice(index, 0, moved);
                  editor.commands.setContent({ ...json, content });
                  setDragIndex(null);
                }}
              >
                <GripVertical size={12} />
                <button
                  onClick={() => {
                    setSelected(block.id);
                    document
                      .querySelector(`[data-id="${CSS.escape(block.id)}"]`)
                      ?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
                >
                  {block.text.slice(0, 35) || "빈 블록"}
                </button>
                <div className="reorder">
                  <button
                    onClick={() => move(index, -1)}
                    aria-label="블록 위로 이동"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    onClick={() => move(index, 1)}
                    aria-label="블록 아래로 이동"
                  >
                    <ArrowDown size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="panel-subheading">
            원본 사건 <Badge>{events.length}</Badge>
          </div>
          <p className="panel-hint">
            사건을 눌러 본문에 근거와 함께 삽입하세요.
          </p>
          <div className="source-events">
            {events
              .filter((e) => !e.type.startsWith("session_"))
              .map((event, index) => (
                <button key={event.id} onClick={() => addEvidence(event)}>
                  <span>
                    {eventName(event)} <small>{index + 1}</small>
                  </span>
                  <small>
                    {event.filePath?.split(/[\\/]/).pop() ||
                      date(event.occurredAt)}
                  </small>
                  <Plus size={14} />
                </button>
              ))}
          </div>
        </aside>
        <div className="editor-center">
          <div className="editor-toolbar">
            {!left &&
              toolbarItem("왼쪽 패널 열기", <PanelLeftClose size={17} />, () =>
                setLeft(true),
              )}
            {toolbarItem(
              "굵게",
              <Bold size={16} />,
              () => {
                editor?.chain().focus().toggleBold().run();
              },
              editor?.isActive("bold"),
            )}
            {toolbarItem(
              "기울임",
              <Italic size={16} />,
              () => {
                editor?.chain().focus().toggleItalic().run();
              },
              editor?.isActive("italic"),
            )}
            <span className="toolbar-divider" />
            {toolbarItem(
              "제목",
              <Heading2 size={17} />,
              () => insert("heading"),
              editor?.isActive("heading"),
            )}
            {toolbarItem(
              "목록",
              <List size={17} />,
              () => insert("list"),
              editor?.isActive("bulletList"),
            )}
            {toolbarItem(
              "인용",
              <Quote size={16} />,
              () => insert("quote"),
              editor?.isActive("blockquote"),
            )}
            {toolbarItem(
              "코드",
              <Code2 size={17} />,
              () => insert("code"),
              editor?.isActive("codeBlock"),
            )}
            {toolbarItem("이미지", <ImagePlus size={17} />, () =>
              fileRef.current?.click(),
            )}
            {editor?.isActive("codeBlock") && (
              <select
                aria-label="코드 언어"
                value={editor.getAttributes("codeBlock").language || "text"}
                onChange={(e) =>
                  editor
                    .chain()
                    .focus()
                    .updateAttributes("codeBlock", { language: e.target.value })
                    .run()
                }
              >
                {["text", "cpp", "c", "python", "diff", "json", "bash"].map(
                  (v) => (
                    <option key={v}>{v}</option>
                  ),
                )}
              </select>
            )}
            <span className="toolbar-divider" />
            {toolbarItem("실행 취소", <Undo2 size={16} />, () => {
              editor?.chain().focus().undo().run();
            })}
            {toolbarItem("다시 실행", <Redo2 size={16} />, () => {
              editor?.chain().focus().redo().run();
            })}
            {!right &&
              toolbarItem("근거 패널 열기", <PanelRightClose size={17} />, () =>
                setRight(true),
              )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(e) => void upload(e.target.files?.[0])}
            />
          </div>
          <div className="article-paper">
            <div className="eyebrow">
              MY SOLUTION NOTE <span>·</span>{" "}
              <Badge
                tone={article.status === "published" ? "green" : "neutral"}
              >
                {article.status === "published"
                  ? "공개"
                  : article.status === "draft"
                    ? "Ghost 초안"
                    : "내 보관함"}
              </Badge>
            </div>
            <input
              className="article-title"
              aria-label="글 제목"
              value={title}
              placeholder="제목을 입력하세요"
              onChange={(e) => {
                setTitle(e.target.value);
                titleRef.current = e.target.value;
                markDirty();
              }}
            />
            <div className="article-meta">
              {date(article.createdAt)}
              <span>·</span>
              {blocks.length}개 블록<span>·</span>원본 기록에 연결된 글
            </div>
            <EditorContent editor={editor} />
            {slash && (
              <div className="slash-menu">
                <header>
                  블록 추가
                  <button
                    onClick={() => setSlash(false)}
                    aria-label="블록 메뉴 닫기"
                  >
                    <X size={14} />
                  </button>
                </header>
                {[
                  ["paragraph", "본문"],
                  ["heading", "제목"],
                  ["code", "코드 / diff"],
                  ["list", "목록"],
                  ["quote", "인용"],
                  ["image", "이미지"],
                ].map(([type, label]) => (
                  <button key={type} onClick={() => insert(type)}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="paper-footer">
              <span>기록된 행동과 나의 해석을 구분해 주세요.</span>
              <button onClick={() => setSlash(!slash)}>
                <Plus size={14} />
                블록 추가
              </button>
            </div>
          </div>
        </div>
        <aside className="editor-sidebar right">
          <div className="panel-heading">
            <span>근거와 AI 제안</span>
            <button
              className="icon-button"
              onClick={() => setRight(false)}
              aria-label="근거 패널 접기"
            >
              <PanelRightClose size={16} />
            </button>
          </div>
          {currentBlock ? (
            <>
              <div className="selected-block">
                <div className="eyebrow">선택한 블록</div>
                <p>{currentBlock.text.slice(0, 160) || "빈 블록"}</p>
                <Badge
                  tone={currentBlock.review === "supported" ? "green" : "amber"}
                >
                  {reviewLabels[currentBlock.review]}
                </Badge>
                <small>
                  검토 결과는 정답 판정이 아닙니다. 원본을 직접 확인하세요.
                </small>
              </div>
              <div className="panel-subheading">
                <Link2 size={15} />
                연결된 근거
              </div>
              {currentBlock.evidenceIds.length ? (
                currentBlock.evidenceIds.map((id) => {
                  const event = events.find((e) => e.id === id);
                  return event ? (
                    <details key={id} className="evidence-card">
                      <summary>
                        {eventName(event)} · {date(event.occurredAt)}
                      </summary>
                      <EventDetail event={event} events={events} />
                      <button
                        className="text-button danger"
                        onClick={() => toggleEvidence(id)}
                      >
                        연결 해제
                      </button>
                    </details>
                  ) : (
                    <div key={id} className="notice warning">
                      원본 기록이 삭제되었거나 보관 기간이 지났습니다.
                    </div>
                  );
                })
              ) : (
                <p className="panel-hint">
                  연결된 근거가 없습니다. 아래에서 원본 사건을 선택하세요.
                </p>
              )}
              <details className="link-evidence">
                <summary>근거 연결하기</summary>
                {events
                  .filter((e) => !e.type.startsWith("session_"))
                  .map((event) => (
                    <label key={event.id}>
                      <input
                        type="checkbox"
                        checked={currentBlock.evidenceIds.includes(event.id)}
                        onChange={() => toggleEvidence(event.id)}
                      />
                      {eventName(event)} · {date(event.occurredAt)}
                    </label>
                  ))}
              </details>
              <div className="panel-subheading">
                <Sparkles size={16} />
                블록 AI
              </div>
              <div className="ai-controls">
                <select
                  aria-label="AI 수정 작업"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                >
                  {[
                    "더 짧게",
                    "이 코드 설명",
                    "근거 추가",
                    "검증 내용 정리",
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
                <button className="button secondary" onClick={suggest}>
                  <Sparkles size={14} />
                  수정 제안 받기
                </button>
                <button
                  className="text-button"
                  onClick={async () => {
                    if (await save())
                      await startJob({ kind: "verify", articleId: article.id });
                  }}
                >
                  문서 근거 다시 검토
                </button>
              </div>
              {suggestions
                .filter(
                  (s) =>
                    s.blockId === currentBlock.id &&
                    s.status !== "rejected" &&
                    s.status !== "accepted",
                )
                .map((s) => {
                  const proposed = s.proposedBlock || s.block;
                  const proposedText =
                    proposed?.text ||
                    s.text ||
                    s.content ||
                    String(s.suggestion || "");
                  const stale =
                    s.baseVersion !== undefined &&
                    s.baseVersion !== article.version;
                  return (
                    <div className="suggestion" key={s.id}>
                      <strong>
                        수정 제안{" "}
                        {stale && <Badge tone="amber">버전 변경됨</Badge>}
                      </strong>
                      <div className="compare-before">
                        <small>현재 내용</small>
                        <p>{currentBlock.text}</p>
                      </div>
                      <div className="compare-after">
                        <small>제안 내용</small>
                        <p>{proposedText}</p>
                      </div>
                      {stale && (
                        <p className="muted">
                          기준 v{s.baseVersion} → 현재 v{article.version}. 최신
                          내용으로 새 제안을 요청하세요.
                        </p>
                      )}
                      <div className="actions">
                        <button
                          className="button primary"
                          disabled={stale}
                          onClick={() => void resolveSuggestion(s, "accept")}
                        >
                          수락
                        </button>
                        <button
                          className="button subtle"
                          onClick={() => void resolveSuggestion(s, "reject")}
                        >
                          거절
                        </button>
                      </div>
                    </div>
                  );
                })}
            </>
          ) : (
            <Empty title="본문 블록을 선택하세요">
              근거와 수정 제안이 여기에 표시됩니다.
            </Empty>
          )}
          {article.status === "published" && (
            <button
              className="text-button danger unpublish"
              onClick={() => {
                if (confirm("Ghost 글의 공개를 취소하고 초안으로 전환할까요?"))
                  void publish("draft");
              }}
            >
              공개 취소
            </button>
          )}
        </aside>
      </div>
      {modal === "preview" && (
        <Modal title="발행 미리보기" onClose={() => setModal(null)} wide>
          <p className="muted">
            연결된 Ghost 테마와 정적 사이트에 따라 표시가 달라질 수 있습니다.
          </p>
          <iframe
            title="글 발행 미리보기"
            sandbox=""
            srcDoc={`<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>body{font:17px/1.9 system-ui;max-width:720px;padding:30px;margin:auto;color:#263b35}img{max-width:100%}pre{white-space:pre-wrap;background:#f2f5f1;padding:20px;overflow:auto}blockquote{border-left:3px solid #849c8f;padding-left:20px}</style></head><body>${preview}</body></html>`}
            className="preview-frame"
          />
        </Modal>
      )}
      {modal === "versions" && (
        <Modal title="문서 버전" onClose={() => setModal(null)}>
          <p className="muted">
            자동 저장은 최근 50개, 생성·AI 적용·발행 버전은 계속 보관합니다.
          </p>
          <div className="version-list">
            {versions.length ? (
              versions.map((v) => (
                <div key={v.id}>
                  <span>
                    <strong>버전 {v.version}</strong>
                    <small>
                      {date(v.createdAt)} · {v.kind}
                    </small>
                  </span>
                  <button
                    className="button subtle"
                    onClick={() => void restore(v.id)}
                  >
                    복원
                  </button>
                </div>
              ))
            ) : (
              <Empty title="저장된 버전이 없습니다" />
            )}
          </div>
        </Modal>
      )}
      {modal === "remote" && (
        <Modal title="Ghost 원격 변경 확인" onClose={() => setModal(null)} wide>
          <div className="notice warning">
            Ghost에서 글이 변경되었습니다. 원격 변경 내용을 비교하고 유지할
            내용을 먼저 결정해 주세요. 자동으로 덮어쓰지 않습니다.
          </div>
          <div className="diff-columns">
            <div>
              <h3>현재 편집본</h3>
              <h4>{title}</h4>
              <pre>{blocks.map((b) => b.text).join("\n\n")}</pre>
            </div>
            <RemoteDocument value={remote} />
          </div>
          <div className="actions">
            <button className="button primary" onClick={applyComparedRemote}>
              비교한 편집본으로{" "}
              {remoteTarget === "draft" ? "초안 저장" : "업데이트"}
            </button>
            <button className="button subtle" onClick={() => setModal(null)}>
              돌아가서 검토
            </button>
          </div>
          <p className="field-hint">
            비교 이후 원격 글이 다시 변경되면 전송을 중단하고 다시 비교합니다.
          </p>
        </Modal>
      )}
    </section>
  );
}

function RemoteDocument({ value }: { value: unknown }) {
  const post = (value as { remote?: Record<string, unknown> } | null)?.remote;
  if (!post)
    return (
      <div>
        <h3>Ghost 원격본</h3>
        <p>원격 글 정보를 읽을 수 없습니다.</p>
      </div>
    );
  let html = typeof post.html === "string" ? post.html : "",
    plain = "";
  if (!html && typeof post.lexical === "string") {
    try {
      const document = JSON.parse(post.lexical);
      const walk = (node: any) => {
        if (node.type === "html") html += String(node.html || "");
        if (node.text) plain += String(node.text) + "\n";
        for (const child of node.children || []) walk(child);
      };
      walk(document.root);
    } catch {
      plain =
        "원격 본문 형식을 표시할 수 없습니다. Ghost에서 원본을 확인해 주세요.";
    }
  }
  return (
    <div>
      <h3>Ghost 원격본</h3>
      <h4>{String(post.title || "제목 없음")}</h4>
      <p className="muted">마지막 수정 {date(String(post.updated_at || ""))}</p>
      {html ? (
        <iframe
          className="remote-frame"
          title="Ghost 원격 본문"
          sandbox=""
          srcDoc={
            '<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px/1.8 system-ui;color:#39503b}img{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>' +
            html +
            "</body></html>"
          }
        />
      ) : (
        <pre>{plain || "본문 없음"}</pre>
      )}
    </div>
  );
}
