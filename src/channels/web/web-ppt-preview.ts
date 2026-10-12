/**
 * 预览载荷的校验闸：从工具结果里挑出合法的 ppt 预览载荷，SSE 透传前过一道。
 *
 * 为什么住在 channels：职责是「保护浏览器端渲染器不被模型伪造/畸形的
 * ppt 字段坑到」，唯一消费者是本层的 chat-stream。载荷本身（类型与构建）
 * 仍在 core——core 造数据、本层验数据，依赖方向不反向。
 */
import {
  type PptPreview,
  type PptPreviewElement,
  type PptPreviewKind,
  type PptPreviewSlide,
  PREVIEW_BULLET_CAP,
  PREVIEW_ELEM_CAP,
  PREVIEW_ELEM_TEXT_CAP,
  PREVIEW_ROW_CAP,
  PREVIEW_SLIDE_CAP,
} from "../../core/document/pptx-theme";

const ELEM_KINDS = new Set(["text", "rect", "ellipse", "line", "logo"]);
const HEX = /^[0-9A-F]{6}$/;

/** free 页元素逐个校验：形状不对整份载荷拒绝（与幻灯片同款严格闸） */
function previewElemOf(raw: unknown): PptPreviewElement | null {
  if (typeof raw !== "object" || raw == null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.kind !== "string" || !ELEM_KINDS.has(e.kind)) return null;
  for (const k of ["x", "y", "w", "h"] as const) {
    const v = e[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < -0.01 || v > 10.01) return null;
  }
  const out: PptPreviewElement = {
    kind: e.kind as PptPreviewElement["kind"],
    x: e.x as number,
    y: e.y as number,
    w: e.w as number,
    h: e.h as number,
  };
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.length <= max ? v : undefined;
  const hexOf = (v: unknown) => (typeof v === "string" && HEX.test(v) ? v : undefined);
  if (e.kind === "text") {
    const text = str(e.text, PREVIEW_ELEM_TEXT_CAP);
    if (!text) return null;
    out.text = text;
    if (typeof e.size === "number" && e.size > 0 && e.size <= 100) out.size = e.size;
    const color = hexOf(e.color);
    if (color) out.color = color;
    if (e.bold === true) out.bold = true;
    const align = str(e.align, 10);
    if (align === "left" || align === "center" || align === "right") out.align = align;
    const valign = str(e.valign, 10);
    if (valign === "top" || valign === "middle" || valign === "bottom") out.valign = valign;
    if (e.font === "kai") out.font = "kai";
  } else if (e.kind !== "logo") {
    const fill = hexOf(e.fill);
    if (fill) out.fill = fill;
    const line = hexOf(e.line);
    if (line) out.line = line;
    if (typeof e.lineW === "number" && Number.isFinite(e.lineW)) out.lineW = e.lineW;
    if (typeof e.rotate === "number" && Number.isFinite(e.rotate)) out.rotate = e.rotate;
  }
  return out;
}

/**
 * 从工具结果里提取合法的预览载荷。形状不对就返回 null，绝不把模型
 * 伪造/畸形的 ppt 字段透到前端渲染（与 pomodoroOfToolOutput 同款职责）。
 */
export function pptPreviewOfToolOutput(output: unknown): PptPreview | null {
  if (typeof output !== "object" || output == null || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  if (typeof o.ppt !== "object" || o.ppt == null || Array.isArray(o.ppt)) return null;
  const p = o.ppt as Record<string, unknown>;
  if (!Array.isArray(p.slides) || p.slides.length === 0) return null;
  const KINDS = new Set(["cover", "section", "content", "free"]);
  const slides: PptPreviewSlide[] = [];
  for (const raw of p.slides.slice(0, PREVIEW_SLIDE_CAP)) {
    if (typeof raw !== "object" || raw == null) return null;
    const s = raw as Record<string, unknown>;
    if (!KINDS.has(String(s.kind))) return null;
    const isFree = s.kind === "free";
    // free 页标题可选，其余版式页必须有标题
    if (!isFree && typeof s.title !== "string") return null;
    if (s.title !== undefined && typeof s.title !== "string") return null;
    const slide: PptPreviewSlide = { kind: s.kind as PptPreviewKind };
    if (typeof s.title === "string" && s.title) slide.title = s.title;
    if (typeof s.subtitle === "string") slide.subtitle = s.subtitle;
    if (typeof s.author === "string") slide.author = s.author;
    if (typeof s.notes === "string") slide.notes = s.notes;
    if (Array.isArray(s.bullets)) {
      const bullets = s.bullets.filter((b): b is string => typeof b === "string");
      if (bullets.length) slide.bullets = bullets.slice(0, PREVIEW_BULLET_CAP);
    }
    if (typeof s.table === "object" && s.table != null && !Array.isArray(s.table)) {
      const t = s.table as Record<string, unknown>;
      if (Array.isArray(t.rows)) {
        const rows = t.rows
          .filter((r): r is (string | number)[] => Array.isArray(r))
          .slice(0, PREVIEW_ROW_CAP)
          .map((r) => r.slice(0, 8));
        slide.table = {
          ...(Array.isArray(t.headers)
            ? {
                headers: t.headers.filter((h): h is string => typeof h === "string").slice(0, 8),
              }
            : {}),
          rows,
        };
      }
    }
    if (Array.isArray(s.elements)) {
      const elements: PptPreviewElement[] = [];
      for (const rawEl of s.elements.slice(0, PREVIEW_ELEM_CAP)) {
        const el = previewElemOf(rawEl);
        if (!el) return null;
        elements.push(el);
      }
      if (elements.length) slide.elements = elements;
    }
    slides.push(slide);
  }
  const count = typeof p.count === "number" && p.count >= slides.length ? p.count : slides.length;
  return { count, slides };
}
