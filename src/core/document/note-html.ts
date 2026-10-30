/**
 * 学习笔记 HTML 渲染器：DocumentSpec → 单文件网页
 *
 * 约束（别悄悄破坏）：
 * - 单文件、零外链、零脚本：样式内嵌，字体走系统栈，图片不引入——
 *   同源伺服（/files/）下打开不产生任何二次请求；
 * - meta CSP 双保险：default-src 'none' 只放行内联样式，即便内容混入
 *   <script>/<img onerror> 也不执行（内容本就全量转义，这是第二道闸）；
 * - 所有文本（标题/正文/表格/来源）经 escapeHtml，模型输出不当 HTML 用；
 * - 深浅色自适应（prefers-color-scheme）与打印样式（@media print），
 *   手机竖屏与打印成讲义都可用；
 * - 色板与 pptx-theme 的「纸墨朱砂」同源（PPT_THEME）。
 */

import { CALLOUT_LABEL, type CalloutTone, type DocumentSpec } from "./types";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 章节锚点 id：不拿标题文本做 id（中文 id 各端兼容性差），按序号编 */
function headingIds(spec: DocumentSpec): string[] {
  let n = 0;
  return (spec.blocks ?? []).filter((b) => b.type === "heading").map(() => `s${++n}`);
}

const TONE_CLASS: Record<CalloutTone, string> = {
  key: "tone-key",
  warn: "tone-warn",
  exam: "tone-exam",
};

function renderToc(spec: DocumentSpec, ids: string[]): string {
  const items: string[] = [];
  let i = 0;
  for (const b of spec.blocks ?? []) {
    if (b.type !== "heading") continue;
    const id = ids[i++] ?? "";
    // 块 level 1 是章、2 是节、3 是小节；目录按层级缩进
    const depth = b.level === 1 ? 1 : b.level === 3 ? 3 : 2;
    items.push(`        <li class="d${depth}"><a href="#${id}">${escapeHtml(b.text)}</a></li>`);
  }
  if (!items.length) return "";
  return `\n  <nav class="toc" aria-label="目录">\n    <h2>目录</h2>\n    <ol>\n${items.join("\n")}\n    </ol>\n  </nav>`;
}

function renderBlocks(spec: DocumentSpec, ids: string[]): string {
  const out: string[] = [];
  let i = 0;
  for (const b of spec.blocks ?? []) {
    switch (b.type) {
      case "heading": {
        // 块 level 1 映射 h2（h1 留给文档主标题），依此类推
        const tag = b.level === 1 ? "h2" : b.level === 3 ? "h4" : "h3";
        out.push(`    <${tag} id="${ids[i++] ?? ""}">${escapeHtml(b.text)}</${tag}>`);
        break;
      }
      case "paragraph":
        out.push(`    <p>${escapeHtml(b.text)}</p>`);
        break;
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const items = b.items.map((it) => `      <li>${escapeHtml(it)}</li>`).join("\n");
        out.push(`    <${tag}>\n${items}\n    </${tag}>`);
        break;
      }
      case "table": {
        const caption = b.caption ? `      <caption>${escapeHtml(b.caption)}</caption>\n` : "";
        const head = b.table.headers?.length
          ? `      <thead><tr>${b.table.headers
              .map((h) => `<th>${escapeHtml(String(h))}</th>`)
              .join("")}</tr></thead>\n`
          : "";
        const rows = b.table.rows
          .map(
            (r) => `      <tr>${r.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`,
          )
          .join("\n");
        out.push(
          `    <div class="table-wrap">\n      <table>\n${caption}${head}    <tbody>\n${rows}\n      </tbody></table>\n    </div>`,
        );
        break;
      }
      case "callout": {
        const tone = b.tone ?? "key";
        out.push(
          `    <aside class="callout ${TONE_CLASS[tone]}"><strong>${CALLOUT_LABEL[tone]}</strong>${escapeHtml(b.text)}</aside>`,
        );
        break;
      }
      case "pagebreak":
        out.push('    <div class="pagebreak" aria-hidden="true"></div>');
        break;
    }
  }
  return out.join("\n");
}

function renderHeader(spec: DocumentSpec, date: string): string {
  const kicker = spec.course
    ? `    <p class="kicker">${escapeHtml(spec.course)} · 学习笔记</p>`
    : '    <p class="kicker">学习笔记</p>';
  const metaBits = [
    spec.sources?.length ? `来源：${spec.sources.map(escapeHtml).join("、")}` : "",
    spec.author ? `整理：${escapeHtml(spec.author)}` : "",
    date,
  ].filter(Boolean);
  return `\n  <header class="cover">\n${kicker}\n    <h1>${escapeHtml(spec.title ?? "学习笔记")}</h1>\n${
    metaBits.length ? `    <p class="meta">${metaBits.join(" · ")}</p>\n` : ""
  }  </header>`;
}

const CSS = `
:root {
  --paper: #fdfcf9; --paper-deep: #f0ede4;
  --ink: #25221c; --ink-2: #5a554a; --ink-3: #6e6656;
  --accent: #ad392c; --accent-deep: #852b22; --rule: #e1dccf;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #191713; --paper-deep: #211e19;
    --ink: #e8e2d5; --ink-2: #b3ab9a; --ink-3: #8f887a;
    --accent: #d2604f; --accent-deep: #e07a6a; --rule: #3a352c;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--paper-deep); color: var(--ink);
  font-family: "Source Han Serif SC", "Noto Serif SC", "Songti SC", SimSun, serif;
  font-size: 17px; line-height: 1.95;
}
main, header, footer, nav { max-width: 780px; margin: 0 auto; padding: 0 24px; }
header.cover {
  background: var(--paper); padding-top: 56px; padding-bottom: 32px;
  border-bottom: 3px solid var(--accent);
}
header.cover .kicker {
  color: var(--accent); font-size: 14px; letter-spacing: 0.35em; margin: 0 0 6px;
}
header.cover h1 {
  margin: 0 0 14px; font-size: 34px; line-height: 1.4;
  border: none; padding: 0;
}
header.cover .meta { color: var(--ink-3); font-size: 13px; margin: 0; }
main { background: var(--paper); padding-top: 12px; padding-bottom: 56px; }
h2, h3, h4 {
  font-weight: 700; line-height: 1.5; margin: 1.6em 0 0.6em;
  scroll-margin-top: 16px;
}
h2 { font-size: 24px; border-left: 5px solid var(--accent); padding-left: 12px; margin-top: 2em; }
h3 { font-size: 20px; color: var(--accent-deep); }
h4 { font-size: 17px; color: var(--ink-2); }
p { margin: 0.7em 0; text-align: justify; }
ul, ol { margin: 0.6em 0; padding-left: 1.6em; }
li { margin: 0.25em 0; }
a { color: var(--accent); text-decoration: none; }
nav.toc {
  background: var(--paper); margin-top: 16px; margin-bottom: 0;
  padding-top: 20px; padding-bottom: 20px; border-bottom: 1px dashed var(--rule);
}
nav.toc h2 { font-size: 16px; margin: 0 0 8px; border: none; padding: 0; color: var(--ink-2); letter-spacing: 0.2em; }
nav.toc ol { margin: 0; padding-left: 0; list-style: none; }
nav.toc li { margin: 0.15em 0; font-size: 15px; }
nav.toc li.d2 { padding-left: 1.5em; }
nav.toc li.d3 { padding-left: 3em; color: var(--ink-3); font-size: 14px; }
.table-wrap { overflow-x: auto; margin: 1em 0; }
table { border-collapse: collapse; width: 100%; font-size: 15px; line-height: 1.7; }
caption { caption-side: top; text-align: left; color: var(--ink-3); font-size: 13px; padding-bottom: 6px; }
th, td { border: 1px solid var(--rule); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--paper-deep); color: var(--ink-2); font-weight: 700; white-space: nowrap; }
tbody tr:nth-child(even) { background: color-mix(in srgb, var(--paper-deep) 55%, var(--paper)); }
aside.callout {
  margin: 1em 0; padding: 10px 14px; background: var(--paper-deep);
  border-left: 4px solid var(--ink-3); border-radius: 0 6px 6px 0; font-size: 15.5px;
}
aside.callout strong {
  display: inline-block; margin-right: 10px; color: var(--paper);
  font-size: 13px; padding: 1px 8px; border-radius: 3px; vertical-align: 1px;
  letter-spacing: 0.15em;
}
aside.tone-key { border-left-color: var(--accent); }
aside.tone-key strong { background: var(--accent); }
aside.tone-warn { border-left-color: #b07a1e; }
aside.tone-warn strong { background: #b07a1e; }
aside.tone-exam { border-left-color: #2e6e4e; }
aside.tone-exam strong { background: #2e6e4e; }
.pagebreak { page-break-after: always; height: 0; }
footer {
  background: var(--paper); padding-top: 20px; padding-bottom: 40px;
  border-top: 1px dashed var(--rule); color: var(--ink-3); font-size: 13px;
}
footer p { margin: 0.3em 0; text-align: left; }
@media (max-width: 480px) {
  body { font-size: 16px; }
  header.cover { padding-top: 36px; }
  header.cover h1 { font-size: 26px; }
  main, header, footer, nav { padding-left: 18px; padding-right: 18px; }
  h2 { font-size: 21px; }
  th, td { padding: 5px 7px; }
}
@media print {
  body { background: #fff; font-size: 12pt; }
  header.cover { border-bottom-width: 2pt; }
  main, header, footer, nav { max-width: none; padding: 0; }
  nav.toc { border-bottom: 1pt solid #999; }
  h2 { page-break-after: avoid; }
  table, aside.callout { page-break-inside: avoid; }
  a { color: inherit; }
}
`;

/** DocumentSpec → 单文件 HTML 字符串（落盘由 save.ts 统一处理） */
export function renderNoteHtml(spec: DocumentSpec): string {
  const ids = headingIds(spec);
  const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(new Date());
  const sourceLine = spec.sources?.length
    ? `    <p>来源课件：${spec.sources.map(escapeHtml).join("、")}</p>\n`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(spec.title ?? "学习笔记")}</title>
<style>${CSS}</style>
</head>
<body>
${renderHeader(spec, date)}${renderToc(spec, ids)}
  <main>
${renderBlocks(spec, ids)}
  </main>
  <footer>
${sourceLine}    <p>由 CourseRaptor 整理生成 · ${date}${spec.author ? ` · ${escapeHtml(spec.author)}` : ""}</p>
  </footer>
</body>
</html>
`;
}
