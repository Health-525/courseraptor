/**
 * 表格引擎：xlsx / xls / csv / tsv 的结构化读取与查询
 *
 * 为什么不再「整本转 CSV 文本一把吐给模型」：教务处附件动辄上千行
 * （网课目录、考场安排、成绩清单），12000 字符的文本上限必然读不完，
 * 读完也记不住。这里改成数据库式用法——加载成行列结构，模型拿概览，
 * 具体行靠 关键词检索 / 多条件筛选 / 排序 / 去重统计 / 分页 按需取。
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const TABLE_EXT = ["xlsx", "xls", "csv", "tsv"] as const;

const require2 = require as unknown as (id: string) => unknown;

export function isTableFilename(filename: string): boolean {
  return new RegExp(`\\.(${TABLE_EXT.join("|")})$`, "i").test(filename);
}

export interface TableSheet {
  name: string;
  /** 第一非空行当表头；空白表头补成「列N」 */
  headers: string[];
  /** 数据行（不含表头），长度对齐 headers */
  rows: string[][];
}

function cellText(v: unknown): string {
  if (v == null) return "";
  return String(v)
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** 解析工作簿（buffer 版，下载附件与本地文件共用） */
export function loadWorkbook(buf: Buffer, filename: string): TableSheet[] | null {
  if (!isTableFilename(filename)) return null;
  try {
    const XLSX = require2("xlsx") as typeof import("xlsx");
    // csv/tsv 是纯文本：SheetJS 对 buffer 默认按 latin1 解码，中文必挂，
    // 先自己按 utf8 解开再喂给 string 模式
    const isText = /\.(csv|tsv)$/i.test(filename);
    if (!isText) {
      // SheetJS 对垃圾字节会宽容解析成单格表（测试实测），先验格式魔数：
      // xlsx = zip（PK），xls = OLE2（D0 CF 11 E0）
      const zip = buf[0] === 0x50 && buf[1] === 0x4b;
      const ole =
        buf.length > 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
      if (!zip && !ole) return null;
    }
    const wb = isText
      ? XLSX.read(buf.toString("utf8").replace(/^\uFEFF/, ""), { type: "string" })
      : XLSX.read(buf, { type: "buffer" });
    const sheets: TableSheet[] = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      // raw:false 取「格式化后」的显示值：日期列才不会变成 Excel 序列号
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
        header: 1,
        raw: false,
        defval: "",
      });
      const grid = aoa.map((r) => r.map(cellText));
      // 表头识别：教务处导出常见「首行大标题（合并单元格）+ 空行 + 真表头」，
      // 所以取第一个「≥2 个非空单元格」的行为表头；纯单列表退回首行非空
      const nonEmpty = (r: string[]) => r.filter((c) => c !== "").length;
      let firstData = grid.findIndex((r) => nonEmpty(r) >= 2);
      if (firstData === -1) firstData = grid.findIndex((r) => nonEmpty(r) >= 1);
      if (firstData === -1) {
        sheets.push({ name, headers: [], rows: [] });
        continue;
      }
      const cols = Math.max(...grid.slice(firstData).map((r) => r.length));
      const pad = (r: string[]) => {
        const c = [...r];
        while (c.length < cols) c.push("");
        return c;
      };
      const headers = pad(grid[firstData]).map((h, i) => h || `列${i + 1}`);
      const rows = grid
        .slice(firstData + 1)
        .filter((r) => r.some((c) => c !== ""))
        .map(pad);
      sheets.push({ name, headers, rows });
    }
    return sheets.length ? sheets : null;
  } catch {
    return null;
  }
}

/** sheet 概览：规模 + 表头 + 前 n 行渲染（给模型的默认视图） */
export function sheetOverview(
  sheet: TableSheet,
  previewRows = 20,
): {
  name: string;
  dataRows: number;
  cols: number;
  headers: string[];
  preview: string[];
  moreRows: number;
} {
  const head = sheet.rows.slice(0, previewRows);
  return {
    name: sheet.name,
    dataRows: sheet.rows.length,
    cols: sheet.headers.length,
    headers: sheet.headers,
    preview: [sheet.headers.join(" | "), ...head.map((r) => r.join(" | "))],
    moreRows: Math.max(0, sheet.rows.length - head.length),
  };
}

// ── 列定位 ────────────────────────────────────────────────────

/** 表头引用 → 列下标：精确（忽略大小写）→ 唯一包含 → 1-based 序号 */
export function resolveColumn(headers: string[], ref: string): number {
  const q = ref.trim().toLowerCase();
  if (!q) throw new Error(`列名不能为空（现有列：${headers.slice(0, 15).join("、")}）`);
  const exact = headers.findIndex((h) => h.toLowerCase() === q);
  if (exact >= 0) return exact;
  const partial = headers
    .map((h, i) => [h.toLowerCase().includes(q), i] as const)
    .filter(([ok]) => ok)
    .map(([, i]) => i);
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    // 「教师」同时命中「教师」「教师工号」这类情况不算错，但要让用户看见歧义
    throw new Error(
      `列名「${ref}」同时匹配多列：${partial.map((i) => headers[i]).join("、")}，请写全列名`,
    );
  }
  const num = Number(q);
  if (Number.isInteger(num) && num >= 1 && num <= headers.length) return num - 1;
  throw new Error(
    `找不到列「${ref}」（现有列：${headers.slice(0, 15).join("、")}${headers.length > 15 ? `… 共 ${headers.length} 列` : ""}）`,
  );
}

function parseNum(v: string): number | null {
  const s = v.replace(/[,%％\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── 筛选 / 排序 / 检索 ────────────────────────────────────────

export type FilterOp =
  | "contains"
  | "notContains"
  | "eq"
  | "ne"
  | "gt"
  | "ge"
  | "lt"
  | "le"
  | "regex"
  | "empty"
  | "notEmpty";

export interface FilterCond {
  /** 列名（支持模糊/序号） */
  col: string;
  op: FilterOp;
  /** empty/notEmpty 可省略 */
  value?: string;
}

export interface QueryOpts {
  /** 全列（或 keywordCols 指定列）不区分大小写包含 */
  keyword?: string;
  keywordCols?: string[];
  /** 多条件 AND */
  where?: FilterCond[];
  /** 投影列（省略 = 全部列） */
  columns?: string[];
  sortBy?: string;
  sortDesc?: boolean;
  offset?: number;
  limit?: number;
}

function matchCond(row: string[], idx: number, c: FilterCond): boolean {
  const cell = (row[idx] ?? "").toString();
  const v = (c.value ?? "").trim();
  const cellLc = cell.toLowerCase();
  const vLc = v.toLowerCase();
  switch (c.op) {
    case "contains":
      return vLc !== "" && cellLc.includes(vLc);
    case "notContains":
      return vLc === "" || !cellLc.includes(vLc);
    case "eq": {
      if (cellLc === vLc) return true;
      const a = parseNum(cell);
      const b = parseNum(v);
      return a != null && b != null && a === b;
    }
    case "ne": {
      if (cellLc !== vLc) return true;
      const a = parseNum(cell);
      const b = parseNum(v);
      return a != null && b != null && a !== b;
    }
    case "gt":
    case "ge":
    case "lt":
    case "le": {
      const a = parseNum(cell);
      const b = parseNum(v);
      if (a == null || b == null) return false;
      if (c.op === "gt") return a > b;
      if (c.op === "ge") return a >= b;
      if (c.op === "lt") return a < b;
      return a <= b;
    }
    case "regex":
      try {
        return new RegExp(v, "i").test(cell);
      } catch (e) {
        throw new Error(`正则无效（col=${c.col}）：${(e as Error).message}`);
      }
    case "empty":
      return cell === "";
    case "notEmpty":
      return cell !== "";
  }
}

export interface QueryResult {
  matched: number;
  offset: number;
  returned: number;
  headers: string[];
  rows: string[][];
  truncated: boolean;
}

export function querySheet(sheet: TableSheet, opts: QueryOpts = {}): QueryResult {
  let rows = sheet.rows;

  if (opts.keyword?.trim()) {
    const kw = opts.keyword.trim().toLowerCase();
    const cols = opts.keywordCols?.length
      ? opts.keywordCols.map((c) => resolveColumn(sheet.headers, c))
      : sheet.headers.map((_, i) => i);
    rows = rows.filter((r) => cols.some((i) => (r[i] ?? "").toLowerCase().includes(kw)));
  }

  for (const c of opts.where ?? []) {
    const idx = resolveColumn(sheet.headers, c.col);
    rows = rows.filter((r) => matchCond(r, idx, c));
  }

  if (opts.sortBy?.trim()) {
    const idx = resolveColumn(sheet.headers, opts.sortBy);
    const dir = opts.sortDesc ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const x = a[idx] ?? "";
      const y = b[idx] ?? "";
      const nx = parseNum(x);
      const ny = parseNum(y);
      if (nx != null && ny != null) return (nx - ny) * dir;
      if (nx != null) return -1; // 数字排在文本前面（升序时）
      if (ny != null) return 1;
      return x.localeCompare(y, "zh") * dir;
    });
  }

  const matched = rows.length;
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 200));
  const page = rows.slice(offset, offset + limit);

  const keepIdx = opts.columns?.length
    ? opts.columns.map((c) => resolveColumn(sheet.headers, c))
    : sheet.headers.map((_, i) => i);

  return {
    matched,
    offset,
    returned: page.length,
    headers: keepIdx.map((i) => sheet.headers[i]),
    rows: page.map((r) => keepIdx.map((i) => r[i] ?? "")),
    truncated: offset + page.length < matched,
  };
}

/** 去重计数（「这个表里有哪些学院/老师，各多少门课」） */
export function distinctValues(
  sheet: TableSheet,
  col: string,
  top = 50,
): Array<{ value: string; count: number }> {
  const idx = resolveColumn(sheet.headers, col);
  const m = new Map<string, number>();
  for (const r of sheet.rows) {
    const v = r[idx] ?? "";
    if (v === "") continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}
