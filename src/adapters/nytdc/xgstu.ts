/**
 * NYTDC 学工系统（奥蓝学生管理信息系统 · 学生版）只读接入
 *
 * 与正方教务、教务处官网都不是一套：这是学工口用的「奥蓝系统」，
 * 站点 http://xgstu.nytdc.edu.cn，ASP.NET WebForms（__VIEWSTATE 表单状态）。
 *
 * 只接「信息汇总」与「资料下载」两个页面的原因：学生版其余菜单项
 * （学生请假、困难生认定、勤助申请、单项奖学金申请、辅导员考核、网上投票、
 * 预约咨询…）全部是**提交类入口**——点开就是填表提交，不是查看数据。
 * 按本项目一律只读的原则，这些不接；要办事请用户自己去系统里点。
 *
 * 登录的两个坑（均实机验证）：
 * 1. 密码是前端 faultylabs.MD5(明文) 后放进 pas2s 提交；
 * 2. **必须填图片验证码**（4 位数字 + 轻微干扰）。tesseract 对这套验证码识别
 *    不准（实测把 4637 认成 "Eg 7"），所以不做 OCR，改成「程序取图 → 用户看图
 *    报数 → 提交」两步式登录；登录成功后会话 cookie 落盘，在校期间不必反复登录。
 *
 * 账号：复用已存的教务账号（本院三套系统同号同密码，实机验证通过）；
 * 若学工密码与教务不同，登录会报「用户名或密码不正确」，需单独配置。
 */

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../../core/config";
import { generatedDir, recordDeliverable, uniquePath } from "../../core/document/save";
import { RaptorError } from "../../core/errors";
import { createClient, fetchUrlBuffer } from "../../core/http";
import { readJsonCache, writeJsonCache } from "../../core/json-cache";
import { logger } from "../../core/logger";
import { decodeTextBuffer } from "../../core/text-decode";

export const XG_BASE = "http://xgstu.nytdc.edu.cn";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const SESSION_FILE = "xgstu-session-nytdc.json";

interface SessionEnvelope {
  tag: "xgstu-session-nytdc";
  cookie: string;
  savedAt: number;
}

function isSessionEnvelope(v: unknown): v is SessionEnvelope {
  const e = v as SessionEnvelope;
  return e?.tag === "xgstu-session-nytdc" && typeof e.cookie === "string";
}

/** 待提交的登录态（取图与提交验证码之间共享） */
export interface PendingLogin {
  cookie: string;
  viewState: string;
  viewStateGen: string;
  yxdm: string;
}

/**
 * @internal 仅供测试与两段式联调：导出/恢复待提交的登录态。
 * 正式运行时取图与提交都在同一个进程内，用不到这两个钩子。
 */
export function _pendingLoginForTest(): PendingLogin | null {
  return pending;
}

/** @internal 见上 */
export function _setPendingLoginForTest(next: PendingLogin | null): void {
  pending = next;
}

let pending: PendingLogin | null = null;
let sessionCookie: string | null = null;
let sessionLoaded = false;

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");

/**
 * 取页面：按字节拿再交给 UTF-8 → GBK 兜底解码。
 * 奥蓝页面 meta 里写的是 gb2312，实测部分页面发的是 UTF-8，两种都要兼容。
 */
async function getPage(urlPath: string, cookie = ""): Promise<string> {
  const { status, buf } = await fetchUrlBuffer(`${XG_BASE}${urlPath}`, {
    timeoutMs: 25_000,
    headers: {
      ...HEADERS,
      Referer: `${XG_BASE}/default.aspx`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (status >= 400) throw new RaptorError("UPSTREAM", `学工系统返回 HTTP ${status}`);
  return decodeTextBuffer(buf);
}

/** 从 HTML 取隐藏域值 */
export function hiddenValue(html: string, name: string): string {
  return html.match(new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`, "i"))?.[1] ?? "";
}

/** 页面是不是未登录（登录页特征） */
export function isLoginPage(html: string): boolean {
  return /name="userbh"/i.test(html) || /无效验证码|请重新登录系统/.test(html);
}

// ── 登录 ────────────────────────────────────────────────────

export interface CaptchaChallenge {
  file: { filename: string; filePath: string; bytes: number };
  usage: string;
}

/** 把验证码图片落盘成可直接下载查看的文件 */
async function saveCaptcha(buf: Buffer): Promise<CaptchaChallenge["file"]> {
  const dir = generatedDir();
  await fsp.mkdir(dir, { recursive: true });
  const filePath = uniquePath(dir, "学工系统-验证码", ".png");
  await fsp.writeFile(filePath, buf);
  const file = { filename: path.basename(filePath), filePath, bytes: buf.length };
  recordDeliverable(file);
  return file;
}

const CAPTCHA_USAGE =
  "请打开这张验证码图片，把图上的 4 位数字告诉用户/读给助手，再用 xgstu_login 提交。" +
  "验证码与本次会话绑定，中间不要重新取图。";

/** 第一步：取登录页（含会话 cookie）与验证码图 */
export async function beginLogin(): Promise<CaptchaChallenge> {
  if (!config.jwglUsername || !config.jwglPassword) {
    throw new RaptorError(
      "AUTH_MISSING",
      "尚未配置账号：学工系统复用教务账号，请先在设置里填好学号与密码",
    );
  }
  // 登录页用内核客户端取：它带 Cookie jar，能接住 ASP.NET 发的 SessionId
  const client = createClient(XG_BASE);
  const page = await client.req("/login.aspx");
  const viewState = hiddenValue(page.body, "__VIEWSTATE");
  const viewStateGen = hiddenValue(page.body, "__VIEWSTATEGENERATOR");
  const yxdm = hiddenValue(page.body, "yxdm") || "13989";
  if (!viewState) throw new RaptorError("PARSE", "学工系统登录页结构变化：未取到 __VIEWSTATE");

  const cookie = client.getCookie();
  const img = await fetchUrlBuffer(`${XG_BASE}/Vcode.ASPX?r=${Date.now()}`, {
    timeoutMs: 20_000,
    headers: {
      ...HEADERS,
      Referer: `${XG_BASE}/login.aspx`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });

  const file = await saveCaptcha(img.buf);
  pending = { cookie, viewState, viewStateGen, yxdm };
  return { file, usage: CAPTCHA_USAGE };
}

export type LoginResult = { ok: true } | { ok: false; error: string; challenge?: CaptchaChallenge };

/** 第二步：提交验证码完成登录（成功后会话 cookie 落盘） */
export async function submitLoginCode(code: string): Promise<LoginResult> {
  if (!pending) {
    const challenge = await beginLogin().catch(() => undefined);
    return { ok: false, error: "登录流程已失效，已换一张新验证码", challenge };
  }
  const clean = code.replace(/\D/g, "");
  if (!clean) return { ok: false, error: "验证码应为 4 位数字" };

  const client = createClient(XG_BASE, pending.cookie);
  const body =
    `__VIEWSTATE=${encodeURIComponent(pending.viewState)}` +
    `&__VIEWSTATEGENERATOR=${encodeURIComponent(pending.viewStateGen)}` +
    `&__VIEWSTATEENCRYPTED=` +
    `&userbh=${encodeURIComponent(config.jwglUsername)}` +
    `&pas2s=${md5(config.jwglPassword)}` +
    `&vcode=${encodeURIComponent(clean)}` +
    `&cw=&xzbz=1&yxdm=${encodeURIComponent(pending.yxdm)}`;
  const res = await client.req("/login.aspx", { method: "POST", body });
  const html = res.body;

  if (isLoginPage(html) || /无效验证码|用户名或密码不正确|密码错误/.test(html)) {
    const hint = /无效验证码/.test(html)
      ? "验证码不对"
      : /用户名或密码/.test(html)
        ? "学工系统的账号密码与教务不同（或密码已改），需要单独配置"
        : "登录未通过";
    pending = null;
    const challenge = await beginLogin().catch(() => undefined);
    return { ok: false, error: hint, challenge };
  }

  pending = null;
  sessionCookie = client.getCookie();
  sessionLoaded = true;
  writeJsonCache(
    SESSION_FILE,
    {
      tag: "xgstu-session-nytdc",
      cookie: sessionCookie,
      savedAt: Date.now(),
    } satisfies SessionEnvelope,
    "xgstu-session",
  );
  logger.info("[xgstu] 登录成功，会话已保存");
  return { ok: true };
}

// ── 会话 ────────────────────────────────────────────────────

/** 已保存的会话 cookie（进程内优先，其次读落盘） */
export function currentCookie(): string | null {
  if (sessionCookie) return sessionCookie;
  if (!sessionLoaded) {
    sessionLoaded = true;
    const saved = readJsonCache(SESSION_FILE, isSessionEnvelope);
    if (saved) sessionCookie = saved.cookie;
  }
  return sessionCookie;
}

/** 会话是否还有效：拿一次首页看会不会被踢回登录页 */
export async function checkSession(): Promise<boolean> {
  const cookie = currentCookie();
  if (!cookie) return false;
  try {
    const html = await getPage("/default.aspx", cookie);
    if (isLoginPage(html)) {
      sessionCookie = null;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── 数据：信息汇总 / 资料下载 ────────────────────────────────

export interface XgstuMessage {
  title: string;
  date?: string;
}

export interface XgstuFile {
  name: string;
  date?: string;
  /** 下载地址（需已登录会话） */
  url: string;
}

/** 取出指定 id 的表格内容（table 配对计数，避免被嵌套表格截断） */
export function extractTableById(html: string, id: string): string | null {
  const openRe = new RegExp(`<table[^>]*id="${id}"[^>]*>`, "i");
  const m = openRe.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const tokenRe = /<table\b|<\/table\s*>/gi;
  tokenRe.lastIndex = start;
  let depth = 1;
  for (let t = tokenRe.exec(html); t !== null; t = tokenRe.exec(html)) {
    depth += t[0].toLowerCase().startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return null;
}

/** 拆一行里的链接文本与日期 */
function rowParts(row: string): { text: string; date?: string } | null {
  const a = row.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
  if (!a) return null;
  const text = a[1]
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const date = row
    .match(/<a[^>]*class=['"]time['"][^>]*>([\s\S]*?)<\/a>/i)?.[1]
    ?.replace(/<[^>]+>/g, "")
    .trim();
  return { text, date: date || undefined };
}

/** 信息汇总：学校发给本人的消息（服务端渲染在 #MyDataGrid 里） */
/** 解析 #MyDataGrid 里的消息行（纯函数，便于离线测试） */
export function parseMessagesGrid(grid: string): XgstuMessage[] {
  const out: XgstuMessage[] = [];
  for (const row of grid.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    // 空表时奥蓝会渲染一行纯序号（<span>1</span>），没有 <a>，这里自然跳过
    const parts = rowParts(row[1]);
    if (parts) out.push({ title: parts.text, date: parts.date });
  }
  return out;
}

/** 信息汇总：学校发给本人的消息（服务端渲染在 #MyDataGrid 里） */
export async function fetchMessages(): Promise<XgstuMessage[]> {
  const cookie = currentCookie();
  if (!cookie) throw new RaptorError("AUTH_MISSING", "学工系统尚未登录");
  const html = await getPage("/message/default.aspx", cookie);
  if (isLoginPage(html)) {
    sessionCookie = null;
    throw new RaptorError("SESSION_EXPIRED", "学工系统会话已失效，需要重新登录");
  }
  const grid = extractTableById(html, "MyDataGrid");
  return grid ? parseMessagesGrid(grid) : [];
}

/** 解析 #MyDataGrid 里的资料行（纯函数，便于离线测试） */
export function parseFilesGrid(grid: string): XgstuFile[] {
  const out: XgstuFile[] = [];
  for (const row of grid.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const seg = row[1];
    // 文档行：<a onclick="down2('public%5c...doc')">名称</a> + <a class="time">日期</a>
    const m = seg.match(/<a[^>]*onclick="down2\('([^']+)'\)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const name = m[2]
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!name) continue;
    const date = seg
      .match(/<a[^>]*class=['"]time['"][^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?.replace(/<[^>]+>/g, "")
      .trim();
    out.push({
      name,
      date: date || undefined,
      // down2() 的原样逻辑：/aldfdnf.aspx?lx=1&file=<已 urlencode 的路径>
      url: `${XG_BASE}/aldfdnf.aspx?lx=1&file=${m[1]}`,
    });
  }
  return out;
}

/** 资料下载：学校放的表格/文档（同样在 #MyDataGrid 里） */
export async function fetchFiles(): Promise<XgstuFile[]> {
  const cookie = currentCookie();
  if (!cookie) throw new RaptorError("AUTH_MISSING", "学工系统尚未登录");
  const html = await getPage("/wdzl/DEFAULT.aspx", cookie);
  if (isLoginPage(html)) {
    sessionCookie = null;
    throw new RaptorError("SESSION_EXPIRED", "学工系统会话已失效，需要重新登录");
  }
  const grid = extractTableById(html, "MyDataGrid");
  return grid ? parseFilesGrid(grid) : [];
}
