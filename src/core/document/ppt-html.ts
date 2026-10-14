/**
 * PPT 文本内容的 HTML 面：迷你解析器 + pptxgenjs runs 映射 + 表格纯文本 +
 * 网页预览用的白名单净化器。
 *
 * 文本元素的 content 是 HTML 字符串（照抄 OpenMAIC 的 slide DSL，MIT /
 * THU-MAIC）：页面上每个 `<p>` 是一行，字号/颜色走内联 style。渲染管线
 * （pptx-slides.ts）与预览管线（web-ppt-preview.ts 校验闸）共用这一个
 * 解析器，保证「预览所见 = 成品所得」。
 *
 * 三条硬约束：
 * - 解析器永不抛错：模型产出什么奇怪东西都退化成「透明容器 + 文本」；
 * - 支持的标签是闭集（p/span/strong/b/em/i/u/br/sup/sub/a），其余按
 *   透明容器处理——与 OpenMAIC 页面渲染器的 CSS reset 语义一致；
 * - 净化器（sanitizeHtml）只走「重建」不走「过滤」：按白名单重新
 *   序列化，脚本/事件属性/危险 URL 在结构上就不可能存活。
 */

// ── HTML 实体 ───────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** 解码字符引用（命名 + 十进制 + 十六进制）；不认识的原样返回 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      return code === 0xa0 ? " " : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** 反转义（净化器重新序列化文本节点用） */
function encodeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── AST ─────────────────────────────────────────────────────

export interface HtmlAttr {
  key: string;
  value: string;
}

export type HtmlNode =
  | { type: "text"; content: string }
  | { type: "comment"; content: string }
  | { type: "element"; tag: string; attrs: HtmlAttr[]; children: HtmlNode[] };

export function attrOf(node: HtmlNode, key: string): string | null {
  if (node.type !== "element") return null;
  return node.attrs.find((a) => a.key === key)?.value ?? null;
}

// ── 迷你解析器 ───────────────────────────────────────────────

const VOID_TAGS = new Set(["br", "img", "hr", "input", "meta", "link"]);
/** <p>/<li> 遇到同类开标签自动闭合（浏览器同款规则，防模型漏写闭标签） */
const SELF_CLOSING_PAIRS: Record<string, string> = { p: "p", li: "li" };
const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*/;

/**
 * 解析 HTML 字符串为 AST。设计目标是「永不抛错」：任何畸形输入都得到
 * 一棵可遍历的树（未闭合标签在 EOF 处收尾，野闭合标签被忽略）。文本
 * 节点里的换行符直接剥掉（与 OpenMAIC 导出器同款处理——HTML 里换行
 * 不是断行，断行只认 <p>/<br>）。
 */
export function parseHtml(html: string): HtmlNode[] {
  const root: Extract<HtmlNode, { type: "element" }> = {
    type: "element",
    tag: "#root",
    attrs: [],
    children: [],
  };
  const stack: Array<Extract<HtmlNode, { type: "element" }>> = [root];
  const top = (): Extract<HtmlNode, { type: "element" }> => stack[stack.length - 1] ?? root;
  let i = 0;

  const pushText = (text: string) => {
    const flat = text.replace(/\n/g, "");
    if (!flat) return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === "text") last.content += flat;
    else parent.children.push({ type: "text", content: flat });
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end < 0 ? html.length : end + 3;
      top().children.push({
        type: "comment",
        content: html.slice(lt + 4, end < 0 ? html.length : end),
      });
      i = stop;
      continue;
    }
    // 不是标签开头的裸 '<'：按文本
    if (!/[a-zA-Z/!]/.test(html[lt + 1] ?? "")) {
      pushText("<");
      i = lt + 1;
      continue;
    }

    const closeTag = html[lt + 1] === "/";
    const nameStart = closeTag ? lt + 2 : lt + 1;
    const nameMatch = TAG_NAME_RE.exec(html.slice(nameStart));
    if (!nameMatch) {
      pushText("<");
      i = lt + 1;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();
    let j = nameStart + nameMatch[0].length;

    if (closeTag) {
      const gt = html.indexOf(">", j);
      i = gt < 0 ? html.length : gt + 1;
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]?.tag === tag) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const attrs: HtmlAttr[] = [];
    let selfClose = false;
    while (j < html.length) {
      const ch = html[j] ?? "";
      if (ch === ">") {
        j++;
        break;
      }
      if (/\s/.test(ch)) {
        j++;
        continue;
      }
      if (ch === "/") {
        selfClose = true;
        j++;
        continue;
      }
      const attrMatch = /^([^\s=/>]+)(\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]*))?/.exec(html.slice(j));
      if (!attrMatch) {
        j++;
        continue;
      }
      const key = (attrMatch[1] ?? "").toLowerCase();
      const value = attrMatch[4] ?? attrMatch[5] ?? attrMatch[2]?.replace(/^\s*=\s*/, "") ?? "";
      if (key !== "/") attrs.push({ key, value: decodeHtmlEntities(value) });
      j += attrMatch[0].length;
    }
    i = j;

    const closer = SELF_CLOSING_PAIRS[tag];
    if (closer) {
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]?.tag === closer) {
          stack.length = s;
          break;
        }
      }
    }

    const node: Extract<HtmlNode, { type: "element" }> = {
      type: "element",
      tag,
      attrs,
      children: [],
    };
    top().children.push(node);
    const isVoid = selfClose || VOID_TAGS.has(tag);
    if (!isVoid) stack.push(node);
  }
  return root.children;
}

/** 取元素内联 style 为样式对象（继承自父级） */
function styleObjOf(node: Extract<HtmlNode, { type: "element" }>, base: Record<string, string>) {
  const out = { ...base };
  const style = attrOf(node, "style");
  if (style) {
    for (const item of style.split(";")) {
      const m = /([^:]+):\s*(.+)/.exec(item);
      if (m) {
        const key = (m[1] ?? "").trim().toLowerCase();
        const value = (m[2] ?? "").trim();
        if (key && value) out[key] = value;
      }
    }
  }
  return out;
}

// ── pptxgenjs runs（渲染面） ─────────────────────────────────

export interface PptTextRun {
  text: string;
  /** 这个 run 之后强制换行（段落边界） */
  breakLine?: boolean;
  fontSize?: number; // pt
  color?: string; // RRGGBB（无 #）
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  align?: "left" | "center" | "right" | "justify";
  fontFace?: string;
  /** 背景高亮色（RRGGBB） */
  highlight?: string;
  hyperlink?: string;
  charSpacing?: number; // pt
}

/** 1px = 0.75pt（1000px 画布 = 10 英寸 = 720pt） */
export const PT_PER_PX = 0.75;

/** 块级标签：其后的 run 要断行（与 OpenMAIC 导出器同款规则） */
const BLOCK_TAGS = new Set(["p", "div", "li"]);

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 宽松取十六进制色（#RGB/#RRGGBB/#RRGGBBAA → RRGGBB；取不到返回 undefined） */
function normalizeHexLocal(value: string): string | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!m) return undefined;
  const h = (m[1] ?? "").toUpperCase();
  if (h.length === 3) return h.replace(/./g, (c) => c + c);
  return h.slice(0, 6);
}

/**
 * HTML → pptxgenjs text runs。照抄 OpenMAIC 导出器的 formatHTML：
 * 标签语义（strong/em/sup/sub）+ 内联 style 逐级继承，段落边界落
 * breakLine。列表标记不自动生成——页面渲染器同样不渲染 <ul>/<ol>
 * 标记（见 slide-craft 法则），要点行首的 bullet 字符由内容自己写。
 */
export function htmlToRuns(html: string): PptTextRun[] {
  const runs: PptTextRun[] = [];
  if (!html) return runs;

  const push = (text: string, style: Record<string, string>) => {
    if (!text) return;
    const run: PptTextRun = { text };
    const size = Number.parseFloat(style["font-size"] ?? "");
    if (Number.isFinite(size) && size > 0) run.fontSize = round2(size * PT_PER_PX);
    if (style.color) {
      const hex = normalizeHexLocal(style.color);
      if (hex) run.color = hex;
    }
    if (style["background-color"]) {
      const hex = normalizeHexLocal(style["background-color"]);
      if (hex) run.highlight = hex;
    }
    const deco = style["text-decoration-line"] ?? style["text-decoration"] ?? "";
    if (deco.includes("underline")) run.underline = true;
    if (deco.includes("line-through")) run.strike = true;
    const va = style["vertical-align"];
    if (va === "super") run.superscript = true;
    if (va === "sub") run.subscript = true;
    if (style["text-align"]) {
      const a = style["text-align"];
      if (a === "left" || a === "center" || a === "right" || a === "justify") run.align = a;
    }
    if (style["font-weight"] === "bold" || Number(style["font-weight"]) >= 600) run.bold = true;
    if (style["font-style"] === "italic") run.italic = true;
    if (style["font-family"]) run.fontFace = style["font-family"];
    if (style["letter-spacing"]) {
      const ls = Number.parseFloat(style["letter-spacing"]);
      if (Number.isFinite(ls)) run.charSpacing = round2(ls * PT_PER_PX);
    }
    runs.push(run);
  };

  const walk = (nodes: HtmlNode[], base: Record<string, string>, ordered = false) => {
    let liCount = 0;
    for (const node of nodes) {
      if (node.type === "comment") continue;
      if (node.type === "text") {
        push(node.content, base);
        continue;
      }
      const style = styleObjOf(node, base);
      if (node.tag === "br") {
        runs.push({ text: "", breakLine: true });
        continue;
      }
      if (BLOCK_TAGS.has(node.tag)) {
        const last = runs.at(-1);
        if (last) last.breakLine = true;
      }
      if (node.tag === "strong" || node.tag === "b") style["font-weight"] = "bold";
      if (node.tag === "em" || node.tag === "i") style["font-style"] = "italic";
      if (node.tag === "sup") style["vertical-align"] = "super";
      if (node.tag === "sub") style["vertical-align"] = "sub";

      if (node.children.length === 0) {
        // 空块级标签也占一行（与 OpenMAIC 一致：空 <p> 的高度照算）
        if (BLOCK_TAGS.has(node.tag)) {
          const last = runs.at(-1);
          if (last) last.breakLine = true;
          runs.push({ text: "", breakLine: false });
        }
        continue;
      }
      if (node.tag === "li") {
        // 列表记号：无序 "• "、有序按同级序号（pptx 的 runs 是扁平文本，
        // 没有原生列表对象，记号必须落在文本里；网页预览走 ul/ol 原生渲染）
        liCount += 1;
        push(ordered ? `${liCount}. ` : "• ", style);
      }
      if (node.tag === "ul" || node.tag === "ol") {
        walk(node.children, style, node.tag === "ol");
        continue;
      }
      walk(node.children, style);
    }
  };
  walk(parseHtml(html), {});
  return runs;
}

// ── 表格单元格纯文本（渲染面） ───────────────────────────────

/** 表格单元格 → 纯文本：丢标签、解码实体、块级标签换行（pptx 表格只吃字符串） */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  if (!/<[a-zA-Z/!]/.test(html)) return decodeHtmlEntities(html);
  const lines: string[] = [];
  let line = "";
  const breakLine = () => {
    lines.push(line);
    line = "";
  };
  const walk = (nodes: HtmlNode[]) => {
    for (const node of nodes) {
      if (node.type === "comment") continue;
      if (node.type === "text") {
        const parts = node.content.split("\n");
        line += parts[0];
        for (const next of parts.slice(1)) {
          breakLine();
          line += next;
        }
        continue;
      }
      if (node.tag === "br") {
        breakLine();
        continue;
      }
      if (!BLOCK_TAGS.has(node.tag)) {
        walk(node.children);
        continue;
      }
      if (line) breakLine();
      const before = lines.length;
      walk(node.children);
      if (line) breakLine();
      else if (lines.length === before) lines.push("");
    }
  };
  walk(parseHtml(html));
  if (line) lines.push(line);
  return lines.join("\n");
}

// ── 网页预览净化器（web 校验闸用） ───────────────────────────

const SANITIZE_TAGS = new Set([
  "p",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "br",
  "sup",
  "sub",
  "a",
  "ul",
  "ol",
  "li",
]);
/** 连内容一起丢的标签：script/style 的文本不该以任何形式留在页面上 */
const RAW_DROP_TAGS = new Set(["script", "style"]);
const SANITIZE_STYLE_PROPS = new Set([
  "font-size",
  "color",
  "background-color",
  "text-align",
  "line-height",
  "font-weight",
  "font-family",
  "text-decoration",
  "text-decoration-line",
]);
const SANITIZE_ALIGNS = new Set(["left", "center", "right", "justify"]);
const SANITIZE_FONTS = new Set([
  "Microsoft YaHei",
  "KaiTi",
  "SimSun",
  "Consolas",
  "monospace",
  "sans-serif",
  "serif",
]);
const SIZE_RE = /^\d{1,3}(\.\d{1,2})?px$/;
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** style 值白名单：字号 px、颜色 hex、对齐枚举、行高数字、字重、字体名 */
function sanitizeStyle(value: string): string {
  const out: string[] = [];
  for (const item of value.split(";")) {
    const m = /([^:]+):\s*(.+)/.exec(item);
    if (!m) continue;
    const key = (m[1] ?? "").trim().toLowerCase();
    const val = (m[2] ?? "").trim();
    if (!SANITIZE_STYLE_PROPS.has(key)) continue;
    if (key === "font-size" && !SIZE_RE.test(val)) continue;
    if ((key === "color" || key === "background-color") && !HEX_RE.test(val)) continue;
    if (key === "text-align" && !SANITIZE_ALIGNS.has(val)) continue;
    if (key === "line-height" && !/^\d{1,2}(\.\d{1,2})?$/.test(val)) continue;
    if (key === "font-weight" && !["normal", "bold"].includes(val)) continue;
    if (key === "font-family" && !SANITIZE_FONTS.has(val)) continue;
    if (
      (key === "text-decoration" || key === "text-decoration-line") &&
      !["underline", "line-through", "none"].includes(val)
    )
      continue;
    out.push(`${key}: ${val}`);
  }
  return out.join("; ");
}

/** 只放行 http(s) 外链；其余 href 一律丢弃 */
function sanitizeHref(value: string): string | null {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return v;
  return null;
}

/**
 * HTML 白名单净化（重建式）：按 SANITIZE_TAGS/SANITIZE_STYLE_PROPS 重新
 * 序列化，未知标签脱壳保留子节点（script/style 连内容一起丢）。脚本、
 * 事件属性、javascript: URL 在结构上无法存活——这是网页预览渲染器敢用
 * innerHTML 的前提。
 */
export function sanitizeHtml(html: string): string {
  const out: string[] = [];
  const walk = (nodes: HtmlNode[]) => {
    for (const node of nodes) {
      if (node.type === "comment") continue;
      if (node.type === "text") {
        out.push(encodeText(node.content));
        continue;
      }
      if (!SANITIZE_TAGS.has(node.tag)) {
        // script/style 连内容一起丢；其余未知标签脱壳，子节点保留
        if (RAW_DROP_TAGS.has(node.tag)) continue;
        walk(node.children);
        continue;
      }
      out.push(`<${node.tag}`);
      if (node.tag === "a") {
        const href = sanitizeHref(attrOf(node, "href") ?? "");
        if (href) out.push(` href="${encodeText(href)}"`);
      }
      const style = sanitizeStyle(attrOf(node, "style") ?? "");
      if (style) out.push(` style="${encodeText(style)}"`);
      out.push(">");
      if (node.tag !== "br") walk(node.children);
      out.push(`</${node.tag}>`);
    }
  };
  walk(parseHtml(html));
  return out.join("");
}
