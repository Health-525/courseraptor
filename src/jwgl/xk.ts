/**
 * NJTECH 选课模块 - 课程搜索 / 余量查询 / 提交选课
 *
 * 复用 jwgl.ts 的登录与 HTTP 客户端基础设施。
 * 接口路径与字段名集中在下方常量区，选课轮次开放后可通过
 * `scripts/xk.ts inspect` dump 原始响应进行校准，只需调整常量。
 */

import { BASE, loginJwgl } from "./auth";
import type { HttpClient } from "./http";
import { createClient } from "./http";

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
  /** 课程所在轮次的参数（提交必须同源，由 searchCourses 回填） */
  kklxdm?: string;
  xkkzId?: string;
  xkkzXh?: string;
  /** 课程归属（kzmc，如创新创业类/自然类） */
  category?: string;
  /** 不限容量（网课/通识课无容量字段时 true，始终视为有余量） */
  unlimited?: boolean;
}

/**
 * 轮次凭证三元组。
 *
 * 查询和提交必须同源——拿主修轮的凭证去问通识选修轮的课，服务端要么返回空
 * 要么报错。这三个字段对 fetchJxbList / submitCourse 其实是**必需**的，
 * 所以单独抽成必填类型：不让 optional 帮着把 bug 藏过去（搜索结果回填之前的
 * XkCourse 才允许缺省，回填之后必须走 roundRefOf 变成 XkRoundRef）。
 */
export interface XkRoundRef {
  kklxdm: string;
  xkkzId: string;
  /** 加密串；缺此参数服务端报「加密串错误」 */
  xkkzXh: string;
}

/** 从入口页轮次对象取凭证 */
export function refOfRound(r: XkRound): XkRoundRef {
  return { kklxdm: r.kklxdm, xkkzId: r.xkkzId, xkkzXh: r.xh };
}

/**
 * 取课程的轮次凭证。课程自带的最可靠（与查询同源），缺失时退回会话首轮——
 * 这是降级路径，跨轮次大概率拿不到数据。
 */
export function roundRefOf(
  course: Pick<XkCourse, "kklxdm" | "xkkzId" | "xkkzXh">,
  session: XkSession,
): XkRoundRef {
  return {
    kklxdm: course.kklxdm ?? "",
    xkkzId: course.xkkzId || session.xkkzId,
    xkkzXh: course.xkkzXh || session.xkkzXh,
  };
}

/** 选课轮次（入口页每个 tab 一个：主修课程/通识选修/其他课程…） */
export interface XkRound {
  /** 开课类型代码（tab 维度 key） */
  kklxdm: string;
  /** tab 显示名（如「主修课程」） */
  tabName: string;
  xkkzId: string;
  njdm: string;
  zyh: string;
  /** 该轮次的加密串（与 xkkzId 配对，查询/提交必须同源） */
  xh: string;
  /**
   * Display 页（queryCourse 后 load 出来的）返回的隐藏字段。
   * PartDisplay 查询必须携带这些（rwlx/xklc/kklxpx/sfkxk/isinxksj 等
   * 几十个开关），缺失会导致服务端过滤返回空列表（flag=1 但 tmpList 空）。
   */
  displayParams?: Record<string, string>;
}

export interface XkSession {
  client: HttpClient;
  cookie: string;
  /** 选课控制 ID（第一个轮次，兼容旧逻辑） */
  xkkzId: string;
  /**
   * 选课轮次校验串（入口页 firstXkkzXh，256 位 hex）。
   * 正方 V9 的「加密串错误」即缺此参数：查询/提交都必须携带 xkkz_xh。
   */
  xkkzXh: string;
  /** 入口页解析出的全部轮次 tab（通识选修轮可能选课时段才出现） */
  rounds: XkRound[];
  /** 入口页学生维度字段（xqh_id/jg_id/xz/ccdm 等，PartDisplay 查询携带） */
  studentParams: Record<string, string>;
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
      if (!Number.isNaN(n)) return n;
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
    const obj = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const jxb = (obj.jxb && typeof obj.jxb === "object" ? obj.jxb : {}) as Record<string, unknown>;
    const kkxx = (obj.kkxx && typeof obj.kkxx === "object" ? obj.kkxx : {}) as Record<
      string,
      unknown
    >;
    const merged: Record<string, unknown> = { ...kkxx, ...obj, ...jxb };

    const capacity = pickNumber(merged, ["jxbrl", "jxb_rl", "rl", "capacity"]);
    const selected = pickNumber(merged, ["yxzrs", "yxjxrs", "xkrs", "yxbrs", "jxbrs"]);
    const remain = pickNumber(merged, ["syrl", "jg0xxrs", "kxrs", "remain"]);
    // 通识课/网课无容量字段（PartDisplay 平铺结构只有 jxb_id/kcmc/kch/jxbxf/kzmc），
    // 此时 capacity=selected=0，判定为不限容量
    const unlimited =
      !("jxbrl" in merged) &&
      !("yxzrs" in merged) &&
      !("jxbrs" in merged) &&
      !("yxjxrs" in merged) &&
      capacity === 0 &&
      selected === 0;

    return {
      jxbId: pickString(merged, ["jxb_id", "jxbid", "do_jxb_id", "do_jxbid"]),
      courseCode: pickString(merged, ["kch", "kch_id", "courseCode"]),
      courseName: pickString(merged, ["kcmc", "kcm", "courseName"]),
      teacher: pickString(merged, ["jsxx", "jgxm", "teacher"]),
      credit: pickString(merged, ["jxbxf", "xf", "credit"]),
      category: pickString(merged, ["kzmc", "kcgsmc"]),
      capacity,
      selected,
      // 部分学校不返回 remain 字段，用容量-已选兜底；不限容量课恒为正
      remain: unlimited ? 9999 : remain > 0 ? remain : Math.max(0, capacity - selected),
      unlimited,
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
    xkkzId: xkkz?.[1] ? xkkz[1] : null,
  };
}

/**
 * 检测响应是否为会话失效（正方失效时常 302 回登录页或返回登录 HTML）
 */
export function isSessionExpired(body: string): boolean {
  if (!body) return false;
  return (
    body.includes("login_slogin") || body.includes('id="csrftoken"') || body.includes("用户登录")
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
export async function openXkSession(username: string, password: string): Promise<XkSession> {
  // 1. 登录教务系统
  const { cookie } = await loginJwgl(username, password);

  // 2. 进入选课入口页，解析选课状态
  const client = createClient(BASE, cookie);
  const entry = await client.req(XK_ENTRY);
  const status = parseXkStatus(entry.body);

  // 3. 提取 csrftoken（正方 V9 选课数据接口可能校验）
  const csrfMatch = entry.body.match(/id="csrftoken"[^>]*value="([^"]+)"/);
  const csrftoken = csrfMatch ? csrfMatch[1].split(",")[0] : "";

  // 3.5 提取加密串（firstXkkzXh）——「加密串错误」拦截的关键参数
  const xhMatch =
    entry.body.match(/id="firstXkkzXh"[^>]*value="([^"]+)"/) ??
    entry.body.match(/value="([^"]+)"[^>]*id="firstXkkzXh"/);
  const xkkzXh = xhMatch ? xhMatch[1] : "";

  // 3.6 解析全部轮次 tab：queryCourse(this,'kklxdm','xkkz_id','njdm','zyh','xh')
  // 每个轮次参数独立（通识选修轮 ≠ 首轮），提交必须用课程所在轮次的参数
  const rounds: XkRound[] = [];
  for (const t of entry.body.matchAll(
    /queryCourse\(this,'(\w+)','(\w+)','(\w*)','(\w*)','(\w+)'\)/g,
  )) {
    const tabName =
      entry.body.match(new RegExp(`id="tab_kklx_${t[1]}_[^"]*"[^>]*>([^<]*)<`))?.[1]?.trim() ?? "";
    rounds.push({
      kklxdm: t[1],
      tabName,
      xkkzId: t[2],
      njdm: t[3],
      zyh: t[4],
      xh: t[5],
    });
  }

  // 3.7 提取入口页学生维度字段（PartDisplay 查询必须携带）
  const studentParams: Record<string, string> = {};
  for (const [id, key] of [
    ["xqh_id", "xqh_id"],
    ["jg_id_1", "jg_id"],
    ["xz", "xz"],
    ["ccdm", "ccdm"],
    ["xslbdm", "xslbdm"],
    ["bh_id", "bh_id"],
    ["xbm", "xbm"],
    ["mzm", "mzm"],
    ["xsbj", "xsbj"],
    ["njdm_id_1", "njdm_id_1"],
    ["zyh_id_1", "zyh_id_1"],
    ["zyfx_id", "zyfx_id"],
    ["xkxnm", "xkxnm"],
    ["xkxqm", "xkxqm"],
  ] as const) {
    const m = entry.body.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`));
    if (m) studentParams[key] = m[1];
  }

  // 4. 每个轮次 load Display，提取其隐藏字段（PartDisplay 查询必须携带，
  // 否则服务端过滤返回空列表——这是「flag=1 但 tmpList 空」的根因）
  for (const round of rounds) {
    const dispBody =
      `csrftoken=${encodeURIComponent(csrftoken)}&xkkz_id=${encodeURIComponent(round.xkkzId)}` +
      `&xkkz_xh=${encodeURIComponent(round.xh)}&kklxdm=${round.kklxdm}` +
      `&xszxzt=&njdm_id=${round.njdm}&zyh_id=${round.zyh}&kspage=0&jspage=0`;
    try {
      const disp = await client.req(`${XK_DISPLAY}?gnmkdm=N253512`, {
        method: "POST",
        body: dispBody,
      });
      const params: Record<string, string> = {};
      for (const m of (disp.body ?? "").matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
        const id = m[0].match(/id="([^"]*)"/)?.[1] ?? "";
        const val = m[0].match(/value="([^"]*)"/)?.[1] ?? "";
        if (id) params[id] = val;
      }
      round.displayParams = params;
    } catch {
      round.displayParams = undefined;
    }
  }

  return {
    client,
    cookie,
    xkkzId: status.xkkzId || "",
    xkkzXh,
    rounds,
    studentParams,
    isXkOpen: status.isXkOpen,
    csrftoken,
    username,
  };
}

/** 会话里可用于查询的轮次；未开放时退化为会话首轮凭证 */
export function queryRounds(session: XkSession): XkRound[] {
  if (session.rounds.length) return session.rounds;
  return [
    {
      kklxdm: "",
      tabName: "",
      xkkzId: session.xkkzId,
      njdm: "",
      zyh: "",
      xh: session.xkkzXh,
    },
  ];
}

/**
 * 构造 PartDisplay 课程查询表单。
 *
 * 单独抽出来是因为这里曾经出过事：commit 94e6d35 查明「缺 xkkz_xh 服务端就报
 * 加密串错误」，修复只落到了 searchCourses，而 inspectXk 的探针是另一个调用点，
 * 仍然裸奔不带加密串——于是 check_selection_status 恒为 true，稳定地告诉模型
 * 「接口被防爬拦截」。表单构造只留一份，同类调用点就不可能再各自漂移。
 */
export function buildCourseListForm(
  session: XkSession,
  round: XkRound,
  keyword?: string,
  page = { kspage: "1", jspage: "100" },
): Record<string, string> {
  return {
    csrftoken: session.csrftoken,
    xkkz_id: round.xkkzId,
    xkkz_xh: round.xh, // 加密串：缺此参数服务端报「加密串错误」
    kklxdm: round.kklxdm,
    njdm_id: round.njdm,
    zyh_id: round.zyh,
    // Display 页隐藏字段 + 入口页学生维度字段（缺则服务端过滤返回空）
    ...(round.displayParams ?? {}),
    ...session.studentParams,
    // searchBox 筛选条件（getConditions）
    kch: "",
    kcmc: keyword || "",
    skls: "",
    skxq: "",
    skjc: "",
    // 分页（loadCoursesByPaged）：行号范围 1 起，首屏取前 100 行
    ...page,
    _: String(Date.now()),
  };
}

/**
 * 解析 PartDisplay 响应体。
 * 响应可能是 JSON（主路径）也可能是 HTML 分页渲染（旧版），两条路径都保留，
 * 但必须记录实际走了哪条——否则永远不知道线上跑的是哪一半代码。
 */
export function parseCoursePage(body: string): { courses: XkCourse[]; via: "json" | "html" } {
  try {
    return { courses: parseCourseList(JSON.parse(body)), via: "json" };
  } catch {
    return { courses: parseCourseRowsFromHtml(body), via: "html" };
  }
}

/**
 * 查询课程分页列表（zzxkyzb_cxZzxkYzbPartDisplay，官方 JS 确认的参数）
 * 遍历入口页解析到的全部轮次 tab（每个轮次独立 xkkz_id/加密串），
 * 合并结果；每门课回填其所在轮次的参数供提交使用。
 * @param keyword - 课程名关键词（可选）
 * @param round   - 指定轮次（可选，默认全部轮次）
 */
export async function searchCourses(
  session: XkSession,
  keyword?: string,
  round?: XkRound,
): Promise<XkCourse[]> {
  const targets: XkRound[] = round ? [round] : queryRounds(session);

  const all: XkCourse[] = [];
  for (const r of targets) {
    const form = buildCourseListForm(session, r, keyword);

    const resp = await session.client.req(`${XK_COURSE_LIST}?gnmkdm=N253512`, {
      method: "POST",
      body: Object.entries(form)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&"),
    });

    if (isSessionExpired(resp.body)) {
      throw new Error("SESSION_EXPIRED");
    }

    const { courses, via } = parseCoursePage(resp.body);
    // 回填轮次参数（提交选课必须与查询同源）
    for (const c of courses) {
      c.kklxdm = r.kklxdm;
      c.xkkzId = r.xkkzId;
      c.xkkzXh = r.xh;
      // 记录实际走的解析路径：线上跑的是 JSON 还是 HTML，
      // 靠这个字段积累一次真实响应就能定论，不用再猜
      c.raw = { ...c.raw, _roundTab: r.tabName, _parsedVia: via };
    }
    all.push(...courses);
  }
  return all;
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
    const kchMatch = block.match(/<td class="kch_id"[^>]*>([^<]+)<\/td>/);
    const jxbIdMatch = block.match(/btn-xk-([^"']+)"/);
    const remainMatch = block.match(
      /class="jxbrs"[^>]*>([^<]*)<\/font>\s*\/\s*<font class="jxbrl"[^>]*>([^<]*)/,
    );
    if (nameMatch || kchMatch) {
      // 无容量字段的网课与 JSON 路径同一套判定：视为不限容量。
      // 之前这条路径漏了 unlimited，网课 capacity=0 → remain=0 → 永远抢不到，
      // 两条路径语义不一致还没人知道哪条在跑（零 fixture 的真实代价）。
      const unlimited = !remainMatch;
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
        remain: unlimited ? 9999 : Math.max(0, capacity - selected),
        unlimited,
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
  course: XkRoundRef & { courseCode: string },
): Promise<XkCourse[]> {
  const form: Record<string, string> = {
    csrftoken: session.csrftoken,
    // 轮次凭证必填（与查询同源），由类型保证不会漏传
    xkkz_id: course.xkkzId,
    xkkz_xh: course.xkkzXh,
    kklxdm: course.kklxdm,
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
    const data = JSON.parse(resp.body) as
      | Array<Record<string, unknown>>
      | { tmpList?: Array<Record<string, unknown>> };
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
  course: XkCourse,
  round?: XkRoundRef,
): Promise<XkSubmitResult> {
  // 跨轮次提交会失败，所以默认取课程自带的凭证（与查询同源）
  const ref = round ?? roundRefOf(course, session);
  if (!ref.xkkzXh) {
    return { ok: false, message: "缺少加密串（xkkz_xh），无法提交——请先重新建立选课会话" };
  }

  const form: Record<string, string> = {
    csrftoken: session.csrftoken,
    xkkz_id: ref.xkkzId,
    xkkz_xh: ref.xkkzXh,
    kklxdm: ref.kklxdm,
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
    const msg = (data?.msg as string) || (data?.message as string) || "未知响应";
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

export interface XkProbeResult {
  kklxdm: string;
  tabName: string;
  /** 本次请求是否携带了加密串（探针曾经长期缺这个参数） */
  sentXkkzXh: boolean;
  /**
   * ok=正常拿到列表 / blocked=服务端报加密串错误 / empty=通了但没数据
   * / error=请求本身失败
   */
  status: "ok" | "blocked" | "empty" | "error";
  /** 实际走的是哪条解析路径——用来判定另一条是不是死代码 */
  parsedVia: "json" | "html" | null;
  courseCount: number;
  message?: string;
  rawHead: string;
}

function classifyProbe(
  body: string,
  hasXh: boolean,
): Omit<XkProbeResult, "kklxdm" | "tabName" | "rawHead"> {
  if (!body) {
    return {
      sentXkkzXh: hasXh,
      status: "error",
      parsedVia: null,
      courseCount: 0,
      message: "空响应",
    };
  }
  if (body.includes("加密串")) {
    return {
      sentXkkzXh: hasXh,
      status: "blocked",
      parsedVia: null,
      courseCount: 0,
      message: "服务端报「加密串错误」",
    };
  }
  if (isSessionExpired(body)) {
    return {
      sentXkkzXh: hasXh,
      status: "error",
      parsedVia: null,
      courseCount: 0,
      message: "会话已失效",
    };
  }
  const { courses, via } = parseCoursePage(body);
  return {
    sentXkkzXh: hasXh,
    status: courses.length > 0 ? "ok" : "empty",
    parsedVia: via,
    courseCount: courses.length,
  };
}

/**
 * 选课自检：逐个轮次用**与主查询完全相同的表单**探测一次。
 *
 * 之前这里自己拼了一个只带 csrftoken/xkkz_id 的裸请求，缺 xkkz_xh，
 * 于是服务端必然回「加密串错误」，而工具层据此把 courseQueryBlocked 恒定为
 * true——一个专门用来自检的工具在系统性地撒谎，agent 会照着它给用户错误结论。
 * 现在表单走 buildCourseListForm，和 searchCourses 同源，不可能再漂移。
 */
export async function inspectXk(
  username: string,
  password: string,
): Promise<{
  isXkOpen: boolean;
  xkkzId: string | null;
  csrftoken: string;
  hasXkkzXh: boolean;
  rounds: XkProbeResult[];
  /** 只要还有轮次被加密串拦截就为 true（而不是恒为 true） */
  courseQueryBlocked: boolean;
}> {
  const session = await openXkSession(username, password);
  const rounds = queryRounds(session);

  const probes: XkProbeResult[] = [];
  for (const r of rounds) {
    // 探测取小页，够判断连通性即可
    const form = buildCourseListForm(session, r, "", { kspage: "1", jspage: "10" });
    const resp = await session.client.req(`${XK_COURSE_LIST}?gnmkdm=N253512`, {
      method: "POST",
      body: Object.entries(form)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&"),
    });
    const classified = classifyProbe(resp.body, Boolean(r.xh));
    probes.push({
      ...classified,
      kklxdm: r.kklxdm,
      tabName: r.tabName || r.kklxdm,
      rawHead: resp.body.slice(0, 200),
    });
  }

  return {
    isXkOpen: session.isXkOpen,
    xkkzId: session.xkkzId || null,
    csrftoken: session.csrftoken,
    hasXkkzXh: Boolean(session.xkkzXh),
    rounds: probes,
    courseQueryBlocked: probes.some((p) => p.status === "blocked"),
  };
}
