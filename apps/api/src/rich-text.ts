import type { ArticleBlock } from "@autoblogger/shared";
import { escapeHtml } from "@autoblogger/shared";
type Node = {
  type: string;
  attrs?: Record<string, any>;
  content?: Node[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, any> }[];
};
export function blockNode(block: ArticleBlock): Node {
  const attrs = { id: block.id },
    inline: Node[] = block.text ? [{ type: "text", text: block.text }] : [];
  if (block.type === "heading")
    return { type: "heading", attrs: { ...attrs, level: 2 }, content: inline };
  if (block.type === "code")
    return {
      type: "codeBlock",
      attrs: { ...attrs, language: block.language || "text" },
      content: inline,
    };
  if (block.type === "quote")
    return {
      type: "blockquote",
      attrs,
      content: [{ type: "paragraph", content: inline }],
    };
  if (block.type === "list")
    return {
      type: "bulletList",
      attrs,
      content: block.text
        .split("\n")
        .map((text) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        })),
    };
  if (block.type === "image")
    return {
      type: "image",
      attrs: { ...attrs, src: block.url || "", alt: block.text },
    };
  return { type: "paragraph", attrs, content: inline };
}
function url(value: unknown) {
  const s = String(value || "");
  return /^(https?:\/\/|mailto:|\/api\/uploads\/)/.test(s) ? escapeHtml(s) : "";
}
export function renderEditor(node: Node): string {
  const children = () => node.content?.map(renderEditor).join("") || "";
  if (node.type === "text") {
    let result = escapeHtml(node.text || "");
    for (const mark of node.marks || []) {
      const tag = (
        {
          bold: "strong",
          italic: "em",
          strike: "s",
          code: "code",
          underline: "u",
        } as any
      )[mark.type];
      if (tag) result = `<${tag}>${result}</${tag}>`;
      else if (mark.type === "link") {
        const href = url(mark.attrs?.href);
        if (href) result = `<a href="${href}">${result}</a>`;
      }
    }
    return result;
  }
  if (node.type === "doc") return children();
  if (node.type === "heading") {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 2));
    return `<h${level}>${children()}</h${level}>`;
  }
  if (node.type === "paragraph") return `<p>${children()}</p>`;
  if (node.type === "blockquote")
    return `<blockquote>${children()}</blockquote>`;
  if (node.type === "bulletList") return `<ul>${children()}</ul>`;
  if (node.type === "orderedList")
    return `<ol start="${Math.max(1, Number(node.attrs?.start) || 1)}">${children()}</ol>`;
  if (node.type === "listItem") return `<li>${children()}</li>`;
  if (node.type === "codeBlock") {
    const plain = (n: Node): string =>
      n.text || n.content?.map(plain).join("") || "";
    const language = String(node.attrs?.language || "text").replace(
      /[^\w+-]/g,
      "",
    );
    return `<pre><code class="language-${language}">${escapeHtml(plain(node))}</code></pre>`;
  }
  if (node.type === "image") {
    const src = url(node.attrs?.src);
    return src
      ? `<img src="${src}" alt="${escapeHtml(String(node.attrs?.alt || ""))}">`
      : "";
  }
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "horizontalRule") return "<hr>";
  return children();
}
export function replaceEditorBlock(
  lexical: any,
  blocks: ArticleBlock[],
  replacement: ArticleBlock,
) {
  const old = lexical?.autobloggerEditor;
  const document: Node =
    old?.type === "doc"
      ? structuredClone(old)
      : { type: "doc", content: blocks.map(blockNode) };
  document.content = document.content?.map((node) =>
    node.attrs?.id === replacement.id ? blockNode(replacement) : node,
  );
  return {
    root: {
      type: "root",
      version: 1,
      children: [{ type: "html", version: 1, html: renderEditor(document) }],
      direction: null,
      format: "",
      indent: 0,
    },
    autobloggerEditor: document,
  };
}
