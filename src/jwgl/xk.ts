/**
 * NJTECH 选课模块 - 课程搜索 / 余量查询 / 提交选课
 *
 * 复用 jwgl.ts 的登录与 HTTP 客户端基础设施。
 * 接口路径与字段名集中在下方常量区，选课轮次开放后可通过
 * `scripts/xk.ts inspect` dump 原始响应进行校准，只需调整常量。
 */

import { loginJwgl, BASE } from "./auth";
import { createClientWithCookie } from "./http";
import type { HttpClient } from "./http";

// ── 接口路径常量（已从官方前端 zzxkYzb.js 逆向确认）──────────────
/**
 * 选课模块：自主选课（预选）zzxkyzb 族，由官方 JS
 * /js/comp/jwglxt/xkgl/xsxk/zzxkYzb.js 确认以下接口与参数。
 * 入口页 hidden input `iskxk=0` 表示当前不在选课阶段。
 */
/** 选课入口页（含 iskxk/xkkz_id 等状态字段） */
const XK_ENTRY = "/xsxk/zzxkyzb_cxZzxkYzbIndex.html?gnmkdm=N253512&layout=default";
/** 选课主页面（浏览器时序预热用） */
const XK_DISPLAY = "/xsxk/zzxkyzb_cxZzxkYzbDisplay.html";
/** 课程分页列表查询（PartDisplay，kspage/jspage 分页） */
const XK_COURSE_LIST = "/xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html";
/** 某门课程的教学班列表（含余量，jxb 展开时调用） */
const XK_JXB_LIST = "/xsxk/zzxkyzbjk_cxJxbWithKchZzxkYzb.html";
/** 提交选课（zzxkyzb 主 action；单班提交由前端组件调用，开放后用 inspect 校准） */
const XK_ADD_COURSE = "/xsxk/zzxkyzb_xkZzxkyzbQuickly.html";

// ── 类型 ──────────────────────────────────────────────────────

export interface XkCourse {
  /** 教学班 ID（提交选课的 key） */
  jxbId: string;
  courseCode: string;
  courseName: string;
  teacher: string;
  credit: string;
  /** 课堂容量 */
  capacity: number;
  /** 已选人数 */
  selected: number;
  /** 剩余名额 */
  remain: number;
  /** 原始数据（字段校准用） */
  raw: Record<string, unknown>;
}

export interface XkSession {
  client: HttpClient;
  cookie: string;
  /** 选课控制 ID（选课轮次 key，未开放时为空） */
  xkkzId: string;
  /** 是否处于选课时间（入口页 iskxk，1=开放） */
  isXkOpen: boolean;
  /** 入口页 csrftoken（正方 V9 部分接口需要） */
  csrftoken: string;
  username: string;
}

export interface XkTarget {
  /** 课程名关键词（模糊匹配，包含即命中） */
  courseName: string;
  /** 教师名（可选，模糊匹配） */
  teacher?: string;
}

export interface XkSubmitResult {
  ok: boolean;
  message: string;
}

// ── 纯解析函数（可单测）────────────────────────────────────────

/**
 * 数字字段多 key fallback：正方各校字段命名有差异
 * （如 jg0xxrs/jg0mxrs、yxjxrs/yxbrs、jxbrl/kxrs 等）
 */
function pickNumber(raw: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = raw[k];
    if (v !== undefined && v !== null && v !== "") {
      const n = typeof v === "number" ? v : parseInt(String(v), 10);
      if (!isNaN(n)) return n;
    }
  }
  return 0;
}

function pickString(raw: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = raw[k];
    if (v !== undefined && v !== null && String(v).length > 0) {
      return String(v);
    }
  }
  return "";
}

/**
 * 解析课程列表 JSON。
 * zzxkyzb 族 PartDisplay 响应为 HTML 分页渲染接口，
 * 教学班 JSON（zzxkyzbjk_cxJxbWithKchZzxkYzb）字段（官方 JS 确认）：
 * jxb_id/do_jxb_id/yxzrs(已选)/jxbrl(容量)/jsxx(教师)/sksj(时间)/jxdd(地点)
 * 同时保留旧 fallback 字段（tmpList/kbList 平铺）。
 */
export function parseCourseList(json: unknown): XkCourse[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;

  let list: unknown[] = [];
  for (const key of ["tmpList", "jxbrys", "kbList", "items"]) {
    const v = root[key];
    if (Array.isArray(v)) {
      list = v;
      break;
    }
  }
  if (list.length === 0) return [];

  return list.map((item) => {
    // 新版嵌套结构：jxb（教学班）/ kkxx（开课信息）
    const obj = (item && typeof item === "object" ? item : {}) as Record<
      string,
      unknown
    >;
    const jxb = (obj.jxb && typeof obj.jxb === "object" ? obj.jxb : {}) as Record<
      string,
      unknown
    >;
    const kkxx = (obj.kkxx && typeof obj.kkxx === "object"
      ? obj.kkxx
      : {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...kkxx, ...obj, ...jxb };

    const capacity = pickNumber(merged, [
      "jxbrl",
      "jxb_rl",
      "rl",
      "capacity",
    ]);
    const selected = pickNumber(merged, [
      "yxzrs",
      "yxjxrs",
      "xkrs",
      "yxbrs",
      "jxbrs",
    ]);
    const remain = pickNumber(merged, [
      "syrl",
      "jg0xxrs",
      "kxrs",
      "remain",
    ]);

    return {
      jxbId: pickString(merged, [
        "jxb_id",
        "jxbid",
        "do_jxb_id",
        "do_jxbid",
      ]),
      courseCode: pickString(merged, ["kch_id", "kch", "courseCode"]),
      courseName: pickString(merged, ["kcmc", "kcm", "courseName"]),
      teacher: pickString(merged, ["jsxx", "jgxm", "teacher"]),
      credit: pickString(merged, ["xf", "credit"]),
      capacity,
      selected,
      // 部分学校不返回 remain 字段，用容量-已选兜底
      remain: remain > 0 ? remain : Math.max(0, capacity - selected),
      raw: obj,
    };
  });
}

/**
 * 从选课入口页 HTML 解析选课状态
 * 官方字段（zzxkYzb.js + 入口页 hidden input 确认）：
 * - iskxk: 1=当前处于选课时间，0=未开放
 * - firstXkkzId: 选课控制 ID（仅开放时下发）
 */
export function parseXkStatus(html: string): {
  isXkOpen: boolean;
  xkkzId: string | null;
} {
  if (!html) return { isXkOpen: false, xkkzId: null };
  const iskxk = html.match(/id="iskxk"[^>]*value="([^"]*)"/);
  const xkkz = html.match(/id="firstXkkzId"[^>]*value="([^"]*)"/);
  return {
    isXkOpen: iskxk?.[1] === "1",
    xkkzId: xkkz && xkkz[1] ? xkkz[1] : null,
  };
}

/**
 * 检测响应是否为会话失效（正方失效时常 302 回登录页或返回登录 HTML）
 */
export function isSessionExpired(body: string): boolean {
  if (!body) return false;
  return (
    body.includes("login_slogin") ||
    body.includes('id="csrftoken"') ||
    body.includes("用户登录")
  );
}

/**
 * 目标课程匹配：课程名包含关键词，且（若指定）教师名包含关键词
 */
export function matchTargets(course: XkCourse, targets: XkTarget[]): boolean {
  return targets.some((t) => {
    if (!t.courseName) return false;
    if (!course.courseName.includes(t.courseName)) return false;
    if (t.teacher && !course.teacher.includes(t.teacher)) return false;
    return true;
  });
}

// ── HTTP 函数 ─────────────────────────────────────────────────

/**
 * 登录并进入选课，返回选课会话（含选课控制 ID 与开放状态）
 * 复刻浏览器时序：登录 -> 入口页（取 iskxk/xkkz_id/csrftoken）-> Display 预热
 */
export async function openXkSession(
  username: string,
  password: string
): Promise<XkSession> {
  // 1. 登录教务系统
  const { cookie } = await loginJwgl(username, password);

  // 2. 进入选课入口页，解析选课状态
  const client = createClientWithCookie(BASE, cookie);
  const entry = await client.req(XK_ENTRY);
  const status = parseXkStatus(entry.body);

  // 3. 提取 csrftoken（正方 V9 选课数据接口可能校验）
  const csrfMatch = entry.body.match(/id="csrftoken"[^>]*value="([^"]+)"/);
  const csrftoken = csrfMatch ? csrfMatch[1].split(",")[0] : "";

  // 4. Display 预热（建立服务端选课上下文，浏览器时序）
  await client.req(`${XK_DISPLAY}?gnmkdm=N253512`, {
    method: "POST",
    body: `csrftoken=${encodeURIComponent(csrftoken)}&xkkz_id=${encodeURIComponent(
      status.xkkzId || ""
    )}&kklxdm=&xszxzt=&njdm_id=&zyh_id=&kspage=0&jspage=0`,
  });

  return {
    client,
    cookie,
    xkkzId: status.xkkzId || "",
    isXkOpen: status.isXkOpen,
    csrftoken,
    username,
  };
}

/**
 * 查询课程分页列表（zzxkyzb_cxZzxkYzbPartDisplay，官方 JS 确认的参数）
 * 响应为分页课程列表；教学班明细（含余量）需再调 jxb 接口
 * @param keyword - 课程名关键词（可选）
 */
export async function searchCourses(
  session: XkSession,
  keyword?: string
): Promise<XkCourse[]> {
  const form: Record<string, string> = {
    csrftoken: session.csrftoken,
    xkkz_id: session.xkkzId,
    kklxdm: "",
    njdm_id: "",
    zyh_id: "",
    // searchBox 筛选条件（getConditions）
    kch: "",
    kcmc: keyword || "",
    skls: "",
    skxq: "",
    skjc: "",
    // 分页（loadCoursesByPaged）
    kspage: "0",
    jspage: "100",
    _: String(Date.now()),
  };

  const resp = await session.client.req(`${XK_COURSE_LIST}?gnmkdm=N253512`, {
    method: "POST",
    body: Object.entries(form)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&"),
  });

  if (isSessionExpired(resp.body)) {
    throw new Error("SESSION_EXPIRED");
  }

  // PartDisplay 返回 HTML 分页结构，其中嵌有课程数据；
  // 尝试 JSON 解析失败时提取 HTML 中的课程行
  try {
    return parseCourseList(JSON.parse(resp.body));
  } catch {
    return parseCourseRowsFromHtml(resp.body);
  }
}

/**
 * 从 PartDisplay HTML 响应中提取课程行数据
 * （官方 JS 以 s_html 拼接渲染，数据字段以 hidden input / class 标注）
 */
export function parseCourseRowsFromHtml(html: string): XkCourse[] {
  if (!html || html.length < 50) return [];
  const courses: XkCourse[] = [];

  // 课程行 pattern：<td class="kch_id" style="display:none">XXX</td>
  // 课程名在 panel-heading 中，容量/人数在 jxbrs/jxbrl font 标签
  const blocks = html.split(/<div[^>]*class="[^"]*panel-info[^"]*"/).slice(1);
  for (const block of blocks) {
    const nameMatch = block.match(/title="([^"]+)"[^>]*class="[^"]*kcmc/);
    const kchMatch = block.match(
      /<td class="kch_id"[^>]*>([^<]+)<\/td>/
    );
    const jxbIdMatch = block.match(
      /btn-xk-([^"']+)"/
    );
    const remainMatch = block.match(
      /class="jxbrs"[^>]*>([^<]*)<\/font>\s*\/\s*<font class="jxbrl"[^>]*>([^<]*)/
    );
    if (nameMatch || kchMatch) {
      const selected = remainMatch ? parseInt(remainMatch[1], 10) || 0 : 0;
      const capacity = remainMatch ? parseInt(remainMatch[2], 10) || 0 : 0;
      courses.push({
        jxbId: jxbIdMatch ? jxbIdMatch[1] : "",
        courseCode: kchMatch ? kchMatch[1].trim() : "",
        courseName: nameMatch ? nameMatch[1].trim() : "",
        teacher: "",
        credit: "",
        capacity,
        selected,
        remain: Math.max(0, capacity - selected),
        raw: { htmlBlock: block.slice(0, 2000) },
      });
    }
  }
  return courses;
}

/**
 * 查询某门课程下的教学班列表（含各班余量）
 * 官方 JS loadJxbxxZzxk 确认：POST zzxkyzbjk_cxJxbWithKchZzxkYzb.html，
 * 响应 data[i] 字段：jxb_id/do_jxb_id/yxzrs(已选)/jxbrl(容量)/jsxx(教师)/sksj/jxdd
 */
export async function fetchJxbList(
  session: XkSession,
  course: Pick<XkCourse, "courseCode">
): Promise<XkCourse[]> {
  const form: Record<string, string> = {
    csrftoken: session.csrftoken,
    xkkz_id: session.xkkzId,
    kch_id: course.courseCode,
    cxbj: "0",
    _: String(Date.now()),
  };

  const resp = await session.client.req(`${XK_JXB_LIST}?gnmkdm=N253512`, {
    method: "POST",
    body: Object.entries(form)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&"),
  });

  if (isSessionExpired(resp.body)) {
    throw new Error("SESSION_EXPIRED");
  }

  try {
    const data = JSON.parse(resp.body);
    // 官方 JS 中响应直接是数组（data[i].xxx 遍历）
    const list = Array.isArray(data) ? data : (data?.tmpList ?? []);
    return parseCourseList({ tmpList: list });
  } catch {
    return [];
  }
}

/**
 * 提交选课（选一门教学班）
 * 官方 JS 确认 chooseCourseZzxk(jxb_id, do_jxb_id, kch_id, jxbzls)，
 * 单班提交的 action 未在本 JS 中（由通用组件发起）；
 * 先按 zzxkyzb 主 action 提交，开放后用 inspect 校准实际 URL。
 */
export async function submitCourse(
  session: XkSession,
  course: XkCourse
): Promise<XkSubmitResult> {
  const form: Record<string, string> = {
    csrftoken: session.csrftoken,
    xkkz_id: session.xkkzId,
    jxb_id: course.jxbId,
    kch_id: course.courseCode,
    do_jxb_id: course.jxbId,
    jxbzls: "",
    _: String(Date.now()),
  };

  const resp = await session.client.req(`${XK_ADD_COURSE}?gnmkdm=N253512`, {
    method: "POST",
    body: Object.entries(form)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&"),
  });

  if (isSessionExpired(resp.body)) {
    return { ok: false, message: "SESSION_EXPIRED" };
  }

  try {
    const data = JSON.parse(resp.body);
    const flag = data?.flag ?? data?.success;
    const msg =
      (data?.msg as string) || (data?.message as string) || "未知响应";
    if (flag === "1" || flag === 1 || flag === true) {
      return { ok: true, message: msg };
    }
    return { ok: false, message: msg };
  } catch {
    return {
      ok: false,
      message: `响应解析失败（HTTP ${resp.status}），请用 inspect 校准接口`,
    };
  }
}

/**
 * 供 inspect 使用的原始请求：返回入口页与查询接口的原始响应
 */
export async function inspectXk(
  username: string,
  password: string
): Promise<{
  entryHtml: string;
  isXkOpen: boolean;
  xkkzId: string | null;
  csrftoken: string;
  courseListRaw: string;
}> {
  const session = await openXkSession(username, password);

  const probe = await session.client.req(`${XK_COURSE_LIST}?gnmkdm=N253512`, {
    method: "POST",
    body: `csrftoken=${encodeURIComponent(session.csrftoken)}&xkkz_id=${encodeURIComponent(
      session.xkkzId
    )}&kcmc=&kspage=0&jspage=10&_=${Date.now()}`,
  });

  return {
    entryHtml: "",
    isXkOpen: session.isXkOpen,
    xkkzId: session.xkkzId || null,
    csrftoken: session.csrftoken,
    courseListRaw: probe.body.slice(0, 100000),
  };
}

