/**
 * NYTDC 学工系统（奥蓝）工具：xgstu_messages / xgstu_files / xgstu_download / xgstu_login
 *
 * 设计要点：
 * - 一律只读：学生版里那些「提交类」入口（请假、困难生认定、奖学金申请、
 *   辅导员测评、投票…）不提供任何工具，用户要办这些事自己去系统里点。
 * - 登录需要图片验证码：工具发现没登录时会自动取一张验证码图并返回给对话，
 *   由用户读图报数，再调 xgstu_login 提交；成功后会话落盘，一段时间内免登录。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import {
  generatedDir,
  recordDeliverable,
  sanitizeFileBase,
  uniquePath,
} from "../../../core/document/save";
import { fetchUrlBuffer } from "../../../core/http";
import {
  beginLogin,
  checkSession,
  currentCookie,
  fetchFiles,
  fetchMessages,
  submitLoginCode,
} from "../xgstu";

/** 未登录时统一的返回形状：带上一张验证码图与用法说明 */
async function needLogin(): Promise<Record<string, unknown>> {
  const challenge = await beginLogin();
  return {
    needLogin: true,
    captchaFile: challenge.file,
    usage:
      "学工系统需要登录：请把 captchaFile 这张验证码图片给用户看（对话里可以直接下载打开），" +
      "让用户读出 4 位数字，然后用 xgstu_login 提交。提交成功后再重新调用本工具。",
  };
}

export const xgstuTools = {
  /** 学工系统：信息汇总（学校发给本人的消息） */
  xgstu_messages: tool({
    description:
      "查看学工系统（奥蓝）「信息汇总」里学校发给本人的消息（教育管理/助困贷补/奖学金/心理健康/学院公告/年级提示等分类）。需要先登录：若返回 needLogin=true，说明还没登录，按返回里的 captchaFile 与 usage 走登录流程（让用户读验证码，再用 xgstu_login 提交），登录后再调用本工具。用户问「学工系统有什么消息」「学校有没有通知我」时调用。",
    inputSchema: z.object({}),
    execute: async () => {
      if (!(await checkSession())) return await needLogin();
      try {
        const items = await fetchMessages();
        return {
          total: items.length,
          items,
          note:
            items.length === 0
              ? "信息汇总里当前没有消息（学校还没往你名下发消息，不是抓取失败）"
              : undefined,
        };
      } catch {
        // 会话中途失效：换一张验证码重新登录
        return await needLogin();
      }
    },
  }),

  /** 学工系统：资料下载列表 */
  xgstu_files: tool({
    description:
      "查看学工系统（奥蓝）「资料下载」里的文件列表（学校放的表格、模板、通知附件）。同样需要登录，未登录时返回 needLogin。拿到列表后用 xgstu_download 把某个文件下载到本机。",
    inputSchema: z.object({}),
    execute: async () => {
      if (!(await checkSession())) return await needLogin();
      try {
        const items = await fetchFiles();
        return {
          total: items.length,
          items,
          note: items.length === 0 ? "资料下载里当前没有文件" : undefined,
        };
      } catch {
        return await needLogin();
      }
    },
  }),

  /** 学工系统：下载某个资料（带登录会话） */
  xgstu_download: tool({
    description:
      "把学工系统「资料下载」里的文件下载到本机（需要已登录；url 用 xgstu_files 返回的 url）。下载后文件会出现在对话里，可直接点开。",
    inputSchema: z.object({
      url: z.string().describe("xgstu_files 返回的下载地址（xgstu.nytdc.edu.cn 域名）"),
      name: z.string().optional().describe("文件名（xgstu_files 返回的 name，用于确定扩展名）"),
    }),
    execute: async ({ url, name }) => {
      if (!/^https?:\/\/xgstu\.nytdc\.edu\.cn\//i.test(url)) {
        return { error: "仅支持 xgstu.nytdc.edu.cn 域名下的下载地址" };
      }
      const cookie = currentCookie();
      if (!cookie) return { error: "尚未登录学工系统，请先按 xgstu_messages 的提示完成登录" };
      try {
        const { status, buf } = await fetchUrlBuffer(url, {
          timeoutMs: 60_000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Referer: "http://xgstu.nytdc.edu.cn/wdzl/DEFAULT.aspx",
            Cookie: cookie,
          },
        });
        if (status >= 400) return { error: `下载失败：HTTP ${status}` };
        const dir = generatedDir();
        await fsp.mkdir(dir, { recursive: true });
        const rawName = (name ?? "").trim() || "学工系统资料";
        const ext = path.extname(rawName) || ".bin";
        const base = sanitizeFileBase(path.basename(rawName, ext));
        const filePath = uniquePath(dir, base, ext);
        await fsp.writeFile(filePath, buf);
        const file = { filename: path.basename(filePath), filePath, bytes: buf.length };
        recordDeliverable(file);
        return { file, note: "已下载到本机，点对话里的文件即可打开。" };
      } catch (e) {
        return { error: `下载失败：${(e as Error).message.slice(0, 120)}` };
      }
    },
  }),

  /** 学工系统：提交验证码完成登录 */
  xgstu_login: tool({
    description:
      "提交学工系统登录验证码完成登录。用法：先调用 xgstu_messages（或 xgstu_files），它会返回一张验证码图片；请用户看图读出 4 位数字，把数字传给本工具。成功后会话会保存，一段时间内不用再登录；失败会返回一张新的验证码图，让用户重新读。",
    inputSchema: z.object({
      code: z.string().describe("用户读出来的 4 位数字验证码"),
    }),
    execute: async ({ code }) => {
      const r = await submitLoginCode(code);
      if (r.ok) {
        return {
          ok: true,
          note: "登录成功。现在可以重新调用 xgstu_messages / xgstu_files 取数据。",
        };
      }
      return {
        ok: false,
        error: r.error,
        captchaFile: r.challenge?.file,
        usage: r.challenge
          ? "这是一张新的验证码图，请用户重新读 4 位数字后再调 xgstu_login。"
          : "请重新调用 xgstu_messages 取得新的验证码图。",
      };
    },
  }),
};
