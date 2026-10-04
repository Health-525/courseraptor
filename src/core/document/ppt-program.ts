/**
 * PPT 构建代码沙箱：模型「写代码排版」，取代在 generate_document 里填 slides 大 JSON
 *
 * 与 run_js（sandbox-js.ts）同一套安全哲学：
 * - node:vm 裸上下文 + codeGeneration:{strings:false}，BANNED 黑名单先静态拦一道；
 * - context 里零宿主对象：pptx 录音 API 与 console 全部由引导脚本在沙箱 realm
 *   内创建，只做参数校验并把调用记录成 op 数组，宿主经 __raptorTakeProgram
 *   取回 JSON 字符串——「拿宿主函数 constructor 链导航宿主 realm」整类路径
 *   没有起点。不把 pptxgenjs 直接注入沙箱正是为了守住这条不变式；
 * - 取回的 op 程序在宿主侧再用 zod 校验一遍（纵深防御），交给 pptx-theme
 *   的 renderPptxProgram 解释渲染（同款品牌母版/印章/媒体去重）。
 *
 * 模型侧仍是真代码：变量/循环/条件/计算随意用，pptx.theme 色板与 W/H 画布
 * 常量在 realm 内可用；参数错误抛中文消息（面向「改代码」迭代），软性问题
 * （越界/超限/截断）记 warnings 原样返回。
 */

import vm from "node:vm";
import { z } from "zod";

import { BANNED } from "../sandbox-js";
import { PPT_THEME } from "./pptx-theme";

const TIMEOUT_MS = 5000;
const MAX_CODE = 20000;

/** 体量上限（沙箱内硬约束，宿主侧 zod 同款收口） */
export const PPT_LIMITS = {
  slides: 60,
  bullets: 40,
  bulletLen: 300,
  rows: 100,
  cols: 12,
  cellLen: 120,
  elements: 60,
  textLen: 500,
  titleLen: 80,
} as const;

// ── op 程序模型（沙箱录音产物 = 渲染输入） ─────────────────────
export type PptAlign = "left" | "center" | "right";
export type PptValign = "top" | "middle" | "bottom";

export interface PptTextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PptTextEl extends PptTextBox {
  kind: "text";
  text: string;
  size?: number;
  color?: string;
  bold?: true;
  align?: PptAlign;
  valign?: PptValign;
  /** 封面主标题同款楷体 */
  font?: "kai";
  wrap?: false;
}

export interface PptShapeEl extends PptTextBox {
  kind: "rect" | "ellipse" | "line";
  fill?: string;
  line?: string;
  lineW?: number;
  rotate?: number;
}

export interface PptLogoEl extends PptTextBox {
  kind: "logo";
}

export type PptFreeElement = PptTextEl | PptShapeEl | PptLogoEl;

export type PptOp =
  | { op: "cover"; title: string; author?: string; notes?: string }
  | { op: "section"; title: string; notes?: string }
  | {
      op: "bullets";
      title: string;
      subtitle?: string;
      points: string[];
      notes?: string;
    }
  | {
      op: "table";
      title: string;
      subtitle?: string;
      headers?: string[];
      rows: (string | number)[][];
      notes?: string;
    }
  | { op: "blank"; title?: string; elements: PptFreeElement[]; notes?: string };

export interface PptProgram {
  ops: PptOp[];
}

// ── 宿主侧 zod（纵深防御：录音已在 realm 校验过，这里挡篡改/畸形透传） ──
const box = {
  x: z.number().finite().min(0).max(10),
  y: z.number().finite().min(0).max(5.625),
  w: z.number().finite().min(0).max(10),
  h: z.number().finite().min(0).max(5.625),
};
const hex = z.string().regex(/^[0-9A-F]{6}$/);

const TextElSchema = z.object({
  kind: z.literal("text"),
  ...box,
  text: z.string().max(PPT_LIMITS.textLen + 100),
  size: z.number().finite().min(5).max(100).optional(),
  color: hex.optional(),
  bold: z.literal(true).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  valign: z.enum(["top", "middle", "bottom"]).optional(),
  font: z.literal("kai").optional(),
  wrap: z.literal(false).optional(),
});
const ShapeElSchema = z.object({
  kind: z.enum(["rect", "ellipse", "line"]),
  ...box,
  fill: hex.optional(),
  line: hex.optional(),
  lineW: z.number().finite().min(0.2).max(14).optional(),
  rotate: z.number().finite().min(-180).max(180).optional(),
});
const LogoElSchema = z.object({ kind: z.literal("logo"), ...box });
const ElementSchema = z.union([TextElSchema, ShapeElSchema, LogoElSchema]);

const OpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("cover"),
    title: z
      .string()
      .min(1)
      .max(PPT_LIMITS.titleLen + 40),
    author: z.string().max(80).optional(),
    notes: z.string().max(1200).optional(),
  }),
  z.object({
    op: z.literal("section"),
    title: z
      .string()
      .min(1)
      .max(PPT_LIMITS.titleLen + 40),
    notes: z.string().max(1200).optional(),
  }),
  z.object({
    op: z.literal("bullets"),
    title: z.string().max(PPT_LIMITS.titleLen + 40),
    subtitle: z.string().max(160).optional(),
    points: z.array(z.string().max(PPT_LIMITS.bulletLen + 100)).max(PPT_LIMITS.bullets + 10),
    notes: z.string().max(1200).optional(),
  }),
  z.object({
    op: z.literal("table"),
    title: z.string().max(PPT_LIMITS.titleLen + 40),
    subtitle: z.string().max(160).optional(),
    headers: z
      .array(z.string().max(PPT_LIMITS.cellLen))
      .max(PPT_LIMITS.cols + 4)
      .optional(),
    rows: z
      .array(z.array(z.union([z.string(), z.number()])).max(PPT_LIMITS.cols + 4))
      .max(PPT_LIMITS.rows + 20),
    notes: z.string().max(1200).optional(),
  }),
  z.object({
    op: z.literal("blank"),
    title: z
      .string()
      .max(PPT_LIMITS.titleLen + 40)
      .optional(),
    elements: z.array(ElementSchema).max(PPT_LIMITS.elements),
    notes: z.string().max(1200).optional(),
  }),
]);

export function validateProgram(
  raw: unknown,
): { ok: true; program: PptProgram } | { ok: false; error: string } {
  const parsed = z
    .object({ ops: z.array(OpSchema).max(PPT_LIMITS.slides) })
    .passthrough()
    .safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue.path.length ? `（${issue.path.join(".")}）` : "";
    return { ok: false, error: `op 程序不合法${at}：${issue.message}` };
  }
  return { ok: true, program: { ops: parsed.data.ops as PptOp[] } };
}

// ── 沙箱引导脚本：在 realm 内部署 pptx 录音 API ─────────────────
/** 引导脚本不随用户代码变化（色板/上限以内联 JSON 注入），预编译一次复用 */
const BOOTSTRAP = `
"use strict";
(function () {
  var W = 10, H = 5.625;
  var THEME = ${JSON.stringify(PPT_THEME)};
  var L = ${JSON.stringify(PPT_LIMITS)};
  var MAX_WARNINGS = 50, MAX_LOGS = 100;
  var ops = [], warnings = [], logs = [];

  function warn(m) { if (warnings.length < MAX_WARNINGS) warnings.push(m); }
  function fail(m) { throw new Error(m); }
  function isStr(v) { return typeof v === "string"; }

  function optStr(v, name, max) {
    if (v === undefined || v === null) return undefined;
    if (!isStr(v)) fail(name + " 必须是字符串");
    if (max && v.length > max) { warn(name + " 超 " + max + " 字已截断"); v = v.slice(0, max); }
    return v;
  }
  function reqTitle(v, what) {
    if (!isStr(v) || !v.trim()) fail(what + " 的 title 不能为空");
    if (v.length > L.titleLen) { warn("标题超 " + L.titleLen + " 字已截断"); v = v.slice(0, L.titleLen); }
    return v;
  }
  function optTitle(v) {
    var s = optStr(v, "title", L.titleLen);
    return s === undefined ? "" : s;
  }
  function optNotes(v) { return optStr(v, "notes", 1000); }

  function asPoints(v) {
    if (!Array.isArray(v)) fail("points 必须是字符串数组");
    var out = [];
    for (var i = 0; i < v.length; i++) {
      var s = typeof v[i] === "number" ? String(v[i]) : v[i];
      if (!isStr(s)) fail("points[" + i + "] 必须是字符串");
      if (s.length > L.bulletLen) { warn("要点超 " + L.bulletLen + " 字已截断"); s = s.slice(0, L.bulletLen); }
      out.push(s);
    }
    if (out.length > L.bullets) { warn("要点超过 " + L.bullets + " 条，多余的已被忽略"); out.length = L.bullets; }
    return out;
  }
  function asCell(v, name) {
    if (typeof v === "number") v = String(v);
    if (!isStr(v)) fail(name + " 必须是字符串或数字");
    if (v.length > L.cellLen) { warn("单元格超 " + L.cellLen + " 字已截断"); v = v.slice(0, L.cellLen); }
    return v;
  }
  function asTable(o) {
    var headers;
    if (o.headers !== undefined && o.headers !== null) {
      if (!Array.isArray(o.headers)) fail("headers 必须是字符串数组");
      headers = [];
      for (var i = 0; i < Math.min(o.headers.length, L.cols); i++)
        headers.push(asCell(o.headers[i], "headers[" + i + "]"));
      if (o.headers.length > L.cols) warn("表头超过 " + L.cols + " 列，多余的已被忽略");
    }
    if (!Array.isArray(o.rows)) fail("rows 必须是二维数组（每行是单元格数组）");
    var rows = [];
    var n = Math.min(o.rows.length, L.rows);
    if (o.rows.length > L.rows) warn("表格超过 " + L.rows + " 行，多余的已被忽略");
    for (var r = 0; r < n; r++) {
      var row = o.rows[r];
      if (!Array.isArray(row)) fail("rows[" + r + "] 必须是数组");
      var cells = [];
      for (var c = 0; c < Math.min(row.length, L.cols); c++) cells.push(asCell(row[c], "rows[" + r + "][" + c + "]"));
      if (row.length > L.cols) warn("第 " + (r + 1) + " 行超过 " + L.cols + " 列，多余的已被忽略");
      rows.push(cells);
    }
    return { headers: headers, rows: rows };
  }
  function asNum(v, name) {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !isFinite(v)) fail(name + " 必须是数字");
    return v;
  }
  function asColor(v, name) {
    if (v === undefined || v === null) return undefined;
    if (!isStr(v)) fail(name + ' 必须是 "RRGGBB" 十六进制或主题色名（pptx.theme）');
    if (/^[0-9a-fA-F]{6}$/.test(v)) return v.toUpperCase();
    if (v.charAt(0) === "#" && /^[0-9a-fA-F]{6}$/.test(v.slice(1))) return v.slice(1).toUpperCase();
    var t = THEME[v];
    if (t) return t;
    fail(name + " 颜色不合法：用 6 位十六进制（如 25221C）或主题色名（如 accent）");
  }
  function asAlign(v) {
    if (v === undefined || v === null) return undefined;
    if (v === "left" || v === "center" || v === "right") return v;
    fail('align 只能是 "left"/"center"/"right"');
  }
  function asValign(v) {
    if (v === undefined || v === null) return undefined;
    if (v === "top" || v === "middle" || v === "bottom") return v;
    fail('valign 只能是 "top"/"middle"/"bottom"');
  }
  function asBox(o, what) {
    var x = asNum(o.x, what + ".x"), y = asNum(o.y, what + ".y");
    var w = asNum(o.w, what + ".w"), h = asNum(o.h, what + ".h");
    x = x === undefined ? 0 : x; y = y === undefined ? 0 : y;
    w = w === undefined ? 0 : w; h = h === undefined ? 0 : h;
    if (w < 0 || h < 0) fail(what + " 宽高不能为负");
    var x2 = Math.min(Math.max(x, 0), W), y2 = Math.min(Math.max(y, 0), H);
    var w2 = Math.min(w, W - x2), h2 = Math.min(h, H - y2);
    if (x2 !== x || y2 !== y || w2 !== w || h2 !== h)
      warn(what + " 超出画布 10 × 5.625 英寸，已裁回（原点在左上角）");
    return { x: x2, y: y2, w: w2, h: h2 };
  }

  function pushOp(o) {
    if (ops.length >= L.slides) { warn("页数超过 " + L.slides + " 上限，之后的页被忽略"); return null; }
    ops.push(o);
    return o;
  }
  function dummy() {
    return {
      text: function () { return dummy(); }, shape: function () { return dummy(); },
      logo: function () { return dummy(); }, notes: function () { return dummy(); },
    };
  }
  function makeHandle(op) {
    function pushEl(el) {
      if (op.elements.length >= L.elements) { warn("自由页元素超过 " + L.elements + " 个，之后的被忽略"); return false; }
      op.elements.push(el);
      return true;
    }
    return {
      text: function (t, o) {
        o = o || {};
        var text = typeof t === "number" ? String(t) : t;
        if (!isStr(text)) fail("s.text 第一个参数必须是字符串");
        if (text.length > L.textLen) { warn("文本超 " + L.textLen + " 字已截断"); text = text.slice(0, L.textLen); }
        var box = asBox(o, "s.text");
        var size = asNum(o.size, "s.text.size");
        if (size !== undefined && (size < 6 || size > 96)) { warn("字号应在 6-96，已收敛"); size = Math.min(96, Math.max(6, size)); }
        pushEl({
          kind: "text", x: box.x, y: box.y, w: box.w, h: box.h, text: text,
          size: size, color: asColor(o.color, "s.text.color"),
          bold: o.bold === true ? true : undefined,
          align: asAlign(o.align), valign: asValign(o.valign),
          font: o.font === "kai" ? "kai" : undefined,
          wrap: o.wrap === false ? false : undefined,
        });
        return makeHandle(op);
      },
      shape: function (kind, o) {
        if (kind !== "rect" && kind !== "ellipse" && kind !== "line")
          fail('s.shape 第一个参数只能是 "rect"/"ellipse"/"line"');
        o = o || {};
        var box = asBox(o, "s.shape");
        var lineW = asNum(o.lineW, "s.shape.lineW");
        if (lineW !== undefined && (lineW < 0.25 || lineW > 12)) { warn("线宽应在 0.25-12pt，已收敛"); lineW = Math.min(12, Math.max(0.25, lineW)); }
        var rotate = asNum(o.rotate, "s.shape.rotate");
        if (rotate !== undefined && (rotate < -180 || rotate > 180)) { warn("rotate 应在 -180~180 度，忽略"); rotate = undefined; }
        if (kind !== "line" && o.fill === undefined && o.line === undefined)
          warn("shape 建议至少给 fill 或 line 之一，否则看不见");
        pushEl({
          kind: kind, x: box.x, y: box.y, w: box.w, h: box.h,
          fill: asColor(o.fill, "s.shape.fill"), line: asColor(o.line, "s.shape.line"),
          lineW: lineW, rotate: rotate,
        });
        return makeHandle(op);
      },
      logo: function (o) {
        o = o || {};
        var box = asBox(o, "s.logo");
        pushEl({ kind: "logo", x: box.x, y: box.y, w: box.w, h: box.h });
        return makeHandle(op);
      },
      notes: function (t) { op.notes = optNotes(t); return makeHandle(op); },
    };
  }

  globalThis.pptx = {
    W: W, H: H, theme: THEME,
    cover: function (o) {
      o = o || {};
      pushOp({ op: "cover", title: reqTitle(o.title, "pptx.cover"), author: optStr(o.author, "author", 60), notes: optNotes(o.notes) });
    },
    section: function (title, notes) {
      var o = isStr(title) ? { title: title, notes: notes } : (title || {});
      pushOp({ op: "section", title: reqTitle(o.title, "pptx.section"), notes: optNotes(o.notes) });
    },
    bullets: function (o) {
      o = o || {};
      if (!o.title || !String(o.title).trim()) warn("bullets 页建议给 title（页面无标题）");
      pushOp({ op: "bullets", title: optTitle(o.title), subtitle: optStr(o.subtitle, "subtitle", 120), points: asPoints(o.points), notes: optNotes(o.notes) });
    },
    table: function (o) {
      o = o || {};
      if (!o.title || !String(o.title).trim()) warn("table 页建议给 title（页面无标题）");
      var t = asTable(o);
      pushOp({ op: "table", title: optTitle(o.title), subtitle: optStr(o.subtitle, "subtitle", 120), headers: t.headers, rows: t.rows, notes: optNotes(o.notes) });
    },
    blank: function (title) {
      var o = isStr(title) ? { title: title } : (title || {});
      var op = pushOp({ op: "blank", title: optStr(o.title, "title", L.titleLen), elements: [], notes: optNotes(o.notes) });
      return op ? makeHandle(op) : dummy();
    },
  };

  function safeJson(v) {
    if (isStr(v)) return v;
    try { var s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
  }
  globalThis.console = {
    log: function () {
      if (logs.length >= MAX_LOGS) return;
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(safeJson(arguments[i]));
      logs.push(parts.join(" ").slice(0, 300));
    },
  };
  globalThis.__raptorTakeProgram = function () {
    return JSON.stringify({ ops: ops, warnings: warnings, logs: logs });
  };
})();
`;
const BOOTSTRAP_SCRIPT = new vm.Script(BOOTSTRAP, { filename: "ppt-program-bootstrap" });

/** 从沙箱取回程序 JSON：__raptorTakeProgram 是 realm 内函数，宿主只调用不读属性 */
function takeProgram(sandboxObj: Record<string, unknown>): string | null {
  const take = sandboxObj.__raptorTakeProgram;
  if (typeof take !== "function") return null;
  try {
    const raw = (take as () => unknown)();
    return typeof raw === "string" ? raw : null;
  } catch {
    return null;
  }
}

export interface PptCodeResult {
  ok: boolean;
  /** 成功（或报错前已录到）的 op 程序；一条页都没有时不给 */
  program?: PptProgram;
  warnings?: string[];
  logs?: string[];
  error?: string;
}

/** 执行模型写的 PPT 构建代码，产出 op 程序（不渲染、不落盘） */
export function runPptCode(code: string): PptCodeResult {
  const src = code.trim();
  if (!src)
    return {
      ok: false,
      error: "代码为空：用 pptx.cover()/section()/bullets()/table()/blank() 构建课件",
    };
  if (src.length > MAX_CODE) {
    return {
      ok: false,
      error: `代码超过 ${MAX_CODE} 字符，请精简（正文的组织思路放进变量与循环）`,
    };
  }
  const hit = BANNED.find(([re]) => re.test(src));
  if (hit) {
    return {
      ok: false,
      error: `沙箱禁用「${hit[1]}」：这里只做课件排版记录，无网络无磁盘。数据先算好，色板用 pptx.theme，图片用 s.logo()。`,
    };
  }

  const sandboxObj: Record<string, unknown> = {};
  try {
    const ctx = vm.createContext(sandboxObj, {
      codeGeneration: { strings: false, wasm: false },
    });
    BOOTSTRAP_SCRIPT.runInContext(ctx);
    new vm.Script(src, { filename: "ppt-code" }).runInContext(ctx, { timeout: TIMEOUT_MS });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const friendly = /timed?\s*out|Script execution timed out/i.test(msg)
      ? `执行超过 ${TIMEOUT_MS / 1000} 秒被掐断（死循环？把数据先算小再排版）`
      : msg.slice(0, 300);
    // 报错前已录到的页保留给 ppt_preview 定位问题（ppt_save 拒绝半成品）
    return { ok: false, error: friendly, ...takePartial(sandboxObj) };
  }

  const taken = takePartial(sandboxObj);
  if (!taken.program) {
    return {
      ok: false,
      error:
        "代码没有构建任何一页：至少调用一次 pptx.cover() / section() / bullets() / table() / blank()",
      warnings: taken.warnings,
      logs: taken.logs,
    };
  }
  return { ok: true, ...taken };
}

/** 取回并校验沙箱录音（成功与失败路径共用；校验失败按无程序处理） */
function takePartial(
  sandboxObj: Record<string, unknown>,
): Pick<PptCodeResult, "program" | "warnings" | "logs"> {
  const raw = takeProgram(sandboxObj);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const logs = Array.isArray(o.logs) ? (o.logs as unknown[]).slice(0, 50).map(String) : undefined;
  const warnings = Array.isArray(o.warnings)
    ? (o.warnings as unknown[]).slice(0, 50).map(String)
    : undefined;
  const ops = Array.isArray(o.ops) ? o.ops : [];
  if (ops.length === 0) return { warnings, logs };
  const checked = validateProgram({ ops });
  if (!checked.ok) return { warnings: [...(warnings ?? []), checked.error], logs };
  return { program: checked.program, warnings, logs };
}
