/**
 * QQ 消息格式化：Markdown -> QQ 纯文本（QQ 不渲染 Markdown）
 */

export function mdToPlain(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // 表格分隔行
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim())
        .filter(Boolean);
      // 兜底格式：表头行压成【标题】，数据行用 • 开头 + · 连接（模型已按
      // QQ 规则输出，这里只处理漏网的 Markdown 表格）
      if (!inTable && cells.length > 1) {
        out.push("");
        out.push(`【${cells.join(" ")}】`);
      } else {
        out.push(`• ${cells.join(" · ")}`);
      }
      inTable = true;
      continue;
    }
    inTable = false;
    const converted = line
      .replace(/^#{1,4}\s*(.+)$/, "【$1】")
      // 粗斜体（***x*** / ___x___）先转，避免被下面的粗体/斜体规则各吃掉一半星号
      .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)(.+?)\1/g, "$2")
      .replace(/`([^`]+)`/g, "$1")
      // [文字](链接) -> 文字：链接（QQ 纯文本环境，链接单独换行更易点开）
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1：$2")
      .replace(/^[-*]\s+/, "• ")
      .replace(/^>\s?/, "");
    // 【小标题】前补空行，段落感
    if (/^【.+】$/.test(converted.trim()) && out.length && out[out.length - 1]?.trim()) {
      out.push("");
    }
    out.push(converted);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 按行边界分段；单行自身超长时硬切（QQ 长消息保险） */
export function splitMessage(text: string, max = 1500): string[] {
  if (text.length <= max) return [text];
  const segments: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > max) {
      if (current) {
        segments.push(current.trim());
        current = "";
      }
      segments.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    if (!rest) continue;
    if (`${current}\n${rest}`.length > max && current) {
      segments.push(current.trim());
      current = rest;
    } else {
      current = current ? `${current}\n${rest}` : rest;
    }
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

// ── 入站附件 → 文本 ─────────────────────────────────────────────
// QQ 官方机器人推送的文件/图片/语音消息正文（content）通常为空，附件信息
// 全在 attachments 数组里。以前桥只看 content，纯附件消息被当空消息静默
// 丢弃——用户发文件机器毫无反应。这里把附件转成模型可读的文本标记。

/** 入站附件的结构子集（与 SDK InboundMessage.attachments 元素结构兼容，不硬依赖 SDK 类型） */
export interface QqAttachmentLike {
  content_type: string;
  url?: string;
  filename?: string;
  size?: number;
  /** 语音消息：QQ 服务端转出的 WAV 链接与识别文本 */
  voice_wav_url?: string;
  asr_refer_text?: string;
  /** 桥已把该附件下载入附件缓存（attachment-store）时回填：本机存储路径与缓存 id */
  localPath?: string;
  cacheId?: string;
}

/** 未落地（下载失败/未尝试）附件的提示：链接时效 + 能力边界 */
const ATTACHMENT_HINT_REMOTE =
  "（以上附件来自 QQ 消息，链接有时效：需要内容时可用 web_fetch 读文本类文件，读不了的格式如实说明已收到即可）";

/** 已落地附件的提示：直接用本地工具读，别再碰会失效的 QQ 链接 */
const ATTACHMENT_HINT_LOCAL =
  "（以上附件已自动下载到本机：表格用 query_table 按缓存 id 查内容（支持按姓名/学号等关键词筛行），文档用 read_local_file 按路径读取；QQ 原链接有时效，不必再访问）";

function humanSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 落地标记：`已下载：<路径>（缓存 id=<id>）`；QQ 原链接会失效，落地后不再展示 */
function storedMark(a: QqAttachmentLike): string {
  const p = (a.localPath ?? "").trim();
  if (p === "") return "";
  const id = (a.cacheId ?? "").trim();
  return `，已下载：${p}${id ? `（缓存 id=${id}）` : ""}`;
}

/** 把附件数组渲染成 `[文件 名字 · 大小：链接]` 式文本标记；无附件或全不可识别返回空串 */
export function describeAttachments(attachments: readonly QqAttachmentLike[] | undefined): string {
  if (!attachments || attachments.length === 0) return "";
  const lines: string[] = [];
  for (const a of attachments) {
    const type = (a.content_type ?? "").trim();
    const name = (a.filename ?? "").trim();
    const url = (a.url ?? "").trim();
    const size = humanSize(a.size);
    const stored = storedMark(a);
    if (type === "voice") {
      const asr = (a.asr_refer_text ?? "").trim();
      lines.push(`[语音${asr ? `：${asr}` : url ? `（语音文件）${url}` : ""}]`);
    } else if (type.startsWith("image/")) {
      lines.push(`[图片${name ? ` ${name}` : ""}${stored || (url ? `：${url}` : "")}]`);
    } else if (type === "file" || type.startsWith("video/")) {
      lines.push(
        `[文件${name ? ` ${name}` : ""}${size ? ` · ${size}` : ""}${stored || (url ? `：${url}` : "")}]`,
      );
    } else if (url) {
      lines.push(`[附件${name ? ` ${name}` : ""}${size ? ` · ${size}` : ""}：${url}]`);
    }
  }
  return lines.join("\n");
}

/**
 * 组装发给模型的用户问题：正文 + 附件标记 + 行为提示。
 * 纯文件消息（正文为空）也能得到非空问题——这正是「发文件没反应」的回归钉。
 * 有任一附件已落地本机时提示改指本地工具（query_table / read_local_file）。
 * 返回空串表示这条消息既无正文也无可用附件，调用方照旧跳过。
 */
export function composeInboundQuestion(
  content: string,
  attachments?: readonly QqAttachmentLike[],
): string {
  const text = content.trim();
  const described = describeAttachments(attachments);
  if (described === "") return text;
  const landed = (attachments ?? []).some((a) => (a.localPath ?? "").trim() !== "");
  const hint = landed ? ATTACHMENT_HINT_LOCAL : ATTACHMENT_HINT_REMOTE;
  const block = `${described}\n${hint}`;
  if (text === "") return block;
  return `${text}\n${block}`;
}
