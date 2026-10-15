/**
 * 课表图片导出：export_schedule_image
 *
 * 读本地课表缓存渲染 PNG/SVG（与网页 /api/schedule/image、skills/export-schedule
 * CLI 同一套 renderScheduleImage）。零登录零网络；缺缓存时明确报错让用户先导入。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";

import { loadLogoDataUri } from "../brand";
import { generatedDir, recordDeliverable, sanitizeFileBase, uniquePath } from "../document/save";
import { loadScheduleCache } from "../schedule-cache";
import { scheduleSvgToPng } from "../schedule-png";
import { renderScheduleImage, type ScheduleStyle } from "../schedule-svg";

export const scheduleImageTools = {
  export_schedule_image: tool({
    description:
      "把本地课表缓存导出为课表图片（默认 PNG）。classic 红头档案风（默认，与 /schedule 网页同款）或 color 彩色课格；mode=week 单周（可指定周次，默认本周）/ term 整学期汇总。用户说「导出课表图」「本周课表卡片」「整学期课表壁纸」时调用。缺缓存时不要编造课表。",
    inputSchema: z.object({
      mode: z
        .enum(["week", "term"])
        .default("week")
        .describe("week=某一教学周实际课表（默认）；term=整学期汇总"),
      format: z.enum(["png", "svg"]).default("png").describe("png=位图（默认）；svg=矢量"),
      style: z
        .enum(["classic", "color"])
        .default("classic")
        .describe("classic=红头档案（默认）；color=彩色课格"),
      filename: z
        .string()
        .optional()
        .describe("不含扩展名的文件名，按用户说法拟定；不填则用 schedule-weekN / schedule-term"),
      week: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe("week 模式的教学周次；不填则本周。term 模式忽略"),
    }),
    execute: async ({ mode, format, style, filename, week }) => {
      const cached = loadScheduleCache();
      if (!cached) {
        return {
          error:
            "还没有课表缓存：请先在 设置 → 学校 → 导入课表，或先查询一次课表让缓存落盘。不要编造课表内容。",
        };
      }
      const schedule = cached.schedule;
      const logo = loadLogoDataUri() ?? undefined;
      const out = renderScheduleImage({
        courses: schedule.courses,
        termLabel: schedule.label,
        year: schedule.year,
        semester: schedule.semester,
        mode,
        week: week ?? null,
        style: style as ScheduleStyle,
        ...(logo ? { logoDataUri: logo } : {}),
      });
      if (!out.ok) {
        const why =
          out.reason === "out-of-term"
            ? "当前不在教学周内，请指定 week 周次"
            : `周次越界（有效范围 1-${out.maxWeek}）`;
        return { error: `课表图导出失败：${why}` };
      }

      const semPart = `${schedule.year}-${schedule.semester === 3 ? 1 : 2}`;
      const styleSuffix = style === "color" ? "-color" : "";
      const defaultBase =
        mode === "week"
          ? `schedule-week${out.week}-${semPart}${styleSuffix}`
          : `schedule-term-${semPart}${styleSuffix}`;
      const base = filename?.trim() ? sanitizeFileBase(filename.trim()) : defaultBase;
      const ext = format === "svg" ? ".svg" : ".png";
      const dir = generatedDir();
      await fsp.mkdir(dir, { recursive: true });
      const filePath = uniquePath(dir, base, ext);

      let bytes: number;
      if (format === "svg") {
        await fsp.writeFile(filePath, out.result.svg, "utf8");
        bytes = Buffer.byteLength(out.result.svg, "utf8");
      } else {
        const png = scheduleSvgToPng(out.result.svg, out.result.width * 2);
        await fsp.writeFile(filePath, png);
        bytes = png.length;
      }

      const file = { filename: path.basename(filePath), filePath, bytes };
      recordDeliverable(file);
      return {
        file,
        filename: file.filename,
        path: file.filePath,
        bytes,
        format,
        mode,
        week: out.week,
        term: schedule.label,
        style,
        summary: `已导出课表图：${file.filename}`,
        note: `已生成课表图，保存于本机 ${file.filePath}`,
      };
    },
  }),
};
