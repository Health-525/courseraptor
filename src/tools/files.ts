/**
 * 文件与数据工具：read_local_file / query_table / run_js / manage_attachments
 */

import { tool } from "ai";
import { z } from "zod";
import {
  attachmentStats,
  clearAttachments,
  deleteAttachment,
  getMeta,
  listAttachments,
  readStoredBuffer,
} from "../attachment-store";
import { openLocalFile } from "../attachments";
import { runSandboxedJs } from "../sandbox-js";
import { distinctValues, loadWorkbook, querySheet, sheetOverview } from "../spreadsheet";

export const filesTools = {
  /** 读取本机文件（用户给路径） */
  read_local_file: tool({
    description:
      "读取用户电脑上的文件（用户告诉你路径时用，如「我下载了网课目录，在 D:\\\\Downloads\\\\xx.xlsx」）。docx/pdf/txt/md 回全文分页（offset 续读、keyword 定位），xlsx/xls/csv 回表格概览（后续用 query_table 筛选）。只读入缓存副本，绝不修改用户文件。路径必须是用户明确给出的，不要自行扫描猜测。",
    inputSchema: z.object({
      path: z.string().describe("本机文件绝对路径（用户提供的）"),
      offset: z.number().int().min(0).optional().describe("长文本续读起点"),
      limit: z
        .number()
        .int()
        .min(500)
        .max(20000)
        .optional()
        .describe("长文本单页长度（默认 6000）"),
      keyword: z.string().optional().describe("长文本关键词定位（返回上下文片段）"),
      refresh: z.boolean().optional().describe("文件内容变了？忽略缓存重读"),
    }),
    execute: async ({ path: p, offset, limit, keyword, refresh }) => {
      try {
        return await openLocalFile(p, { offset, limit, keyword, refresh });
      } catch (e) {
        return { error: (e as Error).message.slice(0, 200) };
      }
    },
  }),

  /** 表格筛选查询（大表按需取行） */
  query_table: tool({
    description:
      "对已缓存的表格（id 来自 fetch_attachment / read_local_file 返回的 id 字段）做结构化查询，替代「通读整个 Excel」。action：sheets=看所有 sheet 的表头与行数（默认 sheet 不确定时先这个）；rows=按分页/排序读行；filter=关键词（keyword 全列模糊匹配）+ 多条件（where，col/op/value，AND 关系，op 支持 contains/eq/ne/gt/ge/lt/le/regex/empty/notEmpty，数值条件自动按数字比较）+ 排序（sortBy/sortDesc）+ 分页（offset/limit）；values=某列去重计数（如「表里有哪些学院」）。典型用法：学生问「网课目录里我们专业大三要上哪门」→ filter 用 where 专业列 contains + keyword 年级。结果行用「 | 」拼接，表头在 headers。",
    inputSchema: z.object({
      id: z.string().describe("附件缓存 id"),
      action: z.enum(["sheets", "rows", "filter", "values"]).default("sheets").describe("查询类型"),
      sheet: z.string().optional().describe("sheet 名（可模糊；省略用第一个）"),
      keyword: z.string().optional().describe("filter：任意列（或 keywordCols）包含，不分大小写"),
      keywordCols: z.array(z.string()).optional().describe("限定关键词检索的列"),
      where: z
        .array(
          z.object({
            col: z.string().describe("列名（支持精确/模糊/1-based 序号）"),
            op: z.enum([
              "contains",
              "notContains",
              "eq",
              "ne",
              "gt",
              "ge",
              "lt",
              "le",
              "regex",
              "empty",
              "notEmpty",
            ]),
            value: z.string().optional().describe("比较值（empty/notEmpty 省略）"),
          }),
        )
        .optional()
        .describe("filter：多条件 AND"),
      col: z.string().optional().describe("values：目标列"),
      columns: z.array(z.string()).optional().describe("只返回这些列（省 token）"),
      sortBy: z.string().optional().describe("按列排序（数字列按数值）"),
      sortDesc: z.boolean().optional().describe("降序"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(40).describe("本次最多返回行数"),
    }),
    execute: async (input) => {
      const meta = getMeta(input.id);
      if (!meta) {
        return {
          error: `缓存中不存在 id=${input.id} 的表格（可能已清理）。先 fetch_attachment 或 read_local_file 重新获取。`,
        };
      }
      const buf = readStoredBuffer(meta.id);
      const sheets = buf ? loadWorkbook(buf, meta.filename) : null;
      if (!sheets) {
        return { error: `「${meta.filename}」不是可解析的表格文件（支持 xlsx/xls/csv/tsv）` };
      }
      let sheet;
      if (input.sheet?.trim()) {
        const q = input.sheet.trim().toLowerCase();
        sheet =
          sheets.find((s) => s.name.toLowerCase() === q) ??
          sheets.find((s) => s.name.toLowerCase().includes(q));
        if (!sheet) {
          return {
            error: `无 sheet「${input.sheet}」（现有：${sheets.map((s) => s.name).join("、")}）`,
          };
        }
      } else if (sheets.length === 1) {
        sheet = sheets[0];
      } else if (input.action === "sheets") {
        // 多 sheet 不指定：直接给全部概览
        return {
          id: meta.id,
          filename: meta.filename,
          sheets: sheets.map((s) => sheetOverview(s, 5)),
          note: "多 sheet 表格：确认目标后带 sheet 参数再查。",
        };
      } else {
        sheet = sheets[0];
      }
      const sheetNote =
        sheets.length > 1
          ? `当前 sheet=「${sheet.name}」（全部：${sheets.map((s) => s.name).join("、")}）`
          : undefined;
      try {
        if (input.action === "sheets") {
          return {
            id: meta.id,
            filename: meta.filename,
            sheets: sheets.map((s) => sheetOverview(s, 5)),
            sheetNote,
          };
        }
        if (input.action === "values") {
          if (!input.col?.trim()) return { error: "values 需要 col（目标列名）" };
          const values = distinctValues(sheet, input.col);
          return {
            id: meta.id,
            sheet: sheet.name,
            col: sheet.headers[0] !== undefined && input.col ? input.col : undefined,
            distinct: values.length,
            values,
            totalRows: sheet.rows.length,
            sheetNote,
          };
        }
        if (input.action === "filter" && !input.keyword?.trim() && !input.where?.length) {
          return {
            error: "filter 至少要给 keyword 或 where 一个条件（全表读取用 action=rows 分页）",
          };
        }
        const r = querySheet(sheet, {
          keyword: input.keyword,
          keywordCols: input.keywordCols,
          where: input.where,
          columns: input.columns,
          sortBy: input.sortBy,
          sortDesc: input.sortDesc,
          offset: input.offset,
          limit: input.limit,
        });
        return {
          id: meta.id,
          sheet: sheet.name,
          totalRows: sheet.rows.length,
          matched: r.matched,
          offset: r.offset,
          returned: r.returned,
          headers: r.headers,
          rows: r.rows.map((x) => x.join(" | ")),
          nextOffset: r.truncated ? r.offset + r.returned : undefined,
          note: r.truncated
            ? `还有 ${r.matched - r.offset - r.returned} 行未返回，用 offset=${r.offset + r.returned} 续取`
            : undefined,
          sheetNote,
        };
      } catch (e) {
        return { error: (e as Error).message.slice(0, 300) };
      }
    },
  }),

  /** 沙箱 JS 计算台 */
  run_js: tool({
    description:
      "沙箱 JavaScript：对已经拿到的数据做去重、计数、分组求和、正则摘取、排序、JSON/文本转换等小计算。约束：无网络无磁盘（禁用 require/process/fetch），3 秒超时，输出截断；最后一条表达式的值就是结果，多行逻辑用 console.log 输出。数据先用 query_table 筛小，再把数组/JSON 贴进代码——别把千行大表整个塞进来。",
    inputSchema: z.object({
      code: z.string().describe("要执行的 JS 代码（纯计算与文本处理）"),
    }),
    execute: async ({ code }) => runSandboxedJs(code),
  }),

  /** 附件缓存管理（可删自己下载的） */
  manage_attachments: tool({
    description:
      "管理附件缓存（data/attachments/，只存 agent 自己下载/读入的副本）：list=列出全部缓存（id/文件名/大小/来源）；delete=按 id 删除一条；delete_all=清空。附件任务答完、用户不再需要追问明细时可主动清理省磁盘。安全边界：只认缓存索引，用户本机原文件（read_local_file 也只是读副本）永远不会被删。",
    inputSchema: z.object({
      action: z.enum(["list", "delete", "delete_all"]),
      id: z.string().optional().describe("delete 必填：缓存 id"),
    }),
    execute: async ({ action, id }) => {
      if (action === "list") {
        const stats = attachmentStats();
        return {
          count: stats.count,
          totalSizeMB: (stats.totalBytes / 1024 / 1024).toFixed(1),
          files: listAttachments().map((m) => ({
            id: m.id,
            filename: m.filename,
            kind: m.kind,
            format: m.format,
            sizeKB: (m.size / 1024).toFixed(0),
            fetchedAt: m.fetchedAt.slice(0, 10),
            source: m.source === "url" ? m.url : m.originPath,
            sheets: m.sheetNames?.length ? m.sheetNames.join("、") : undefined,
            textLength: m.textLength,
          })),
          note: stats.count ? "追问附件内容前先 list，别重新下载。" : undefined,
        };
      }
      if (action === "delete") {
        if (!id?.trim()) return { error: "delete 需要 id（来自 list）" };
        const ok = await deleteAttachment(id);
        return ok
          ? { ok: true, deletedId: id.trim(), note: "已删除缓存副本" }
          : { error: `未找到缓存 id=${id}（可能已删过；list 确认）` };
      }
      const removed = await clearAttachments();
      return { ok: true, removed, note: "已清空附件缓存（不涉及用户本机原文件）" };
    },
  }),
};
