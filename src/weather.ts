/**
 * 天气获取 —— Open-Meteo（免 API Key）
 *
 * 为什么用它：不用注册、没有密钥要管，纯 JSON，国内可直连。代价是
 * 「城市名 → 坐标」要自己问一次它的 geocoding 接口（同样免密钥），
 * 以及天气状况是 WMO 数字码，得翻成中文——两件事都收在本文件里。
 *
 * 三条约束（对齐 jwgl/http.ts 的契约）：
 *
 * 1. 「拿不到」≠「没数据」。超时、HTTP 错误、results 为空一律走
 *    { ok:false, error }，绝不返回空的 days[]——否则模型会把它说成
 *    「近期没有降水」，跟课表那边踩过的坑一模一样。
 * 2. 城市坐标按进程缓存。坐标不会变，而 geocoding 有日配额，每次查天气
 *    都问一遍纯属浪费；整份结果另外缓存 2 分钟，挡住模型一次提问里的
 *    连续调用。
 * 3. 解析函数与网络函数分开：前者是纯函数可离线单测，后者的 fetch 可以
 *    注入，坏网/超时/查无此城的分支都不用联网也能测。
 */

import { BASE as JWGL_BASE } from "./jwgl/auth";
import type { FetchResult } from "./jwgl/http";

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 15_000;
/** 整份天气结果的有效期：2 分钟足够挡住重复调用，又不至于报过期天气 */
const RESULT_TTL_MS = 2 * 60_000;
/** 城市坐标基本不变，缓存一周 */
const GEO_TTL_MS = 7 * 24 * 60 * 60_000;

/** 只用到 ok/status/text 三件套，测试里塞个假响应就够 */
export interface WeatherFetch {
  (url: string, init?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

const httpFetch: WeatherFetch = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

// ── 默认城市：按学校判断 ──────────────────────────────────────
// 本 agent 服务哪所学校，默认就查哪座城市。键是教务系统主机名，
// 以后多接一所学校（如 ScholarFlow 侧的 HEBau）在这里加一行。

const SCHOOL_CITY: Record<string, string> = {
  "jwgl.njtech.edu.cn": "南京", // 南京工业大学浦口校区
};

/** 学校所在城市。主机名没登记时仍退回南京——当前只有 NJTECH 一套教务 */
export function defaultWeatherCity(jwglBase: string = JWGL_BASE): string {
  const host = jwglBase.replace(/^https?:\/\//, "").split("/")[0];
  return SCHOOL_CITY[host] ?? "南京";
}

// ── WMO 天气码 → 中文 ─────────────────────────────────────────
// Open-Meteo 只给数字。0-3 云量，4x 雾，5x 毛毛雨，6x 雨，7x 雪/米雪，
// 8x 阵雨/阵雪，9x 雷暴。表里没有的码走兜底分支，不猜。

const WMO_TEXT: Record<number, string> = {
  0: "晴",
  1: "晴间多云",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "冻雾",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "米雪",
  80: "小阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "大阵雪",
  95: "雷阵雨",
  96: "雷阵雨伴冰雹",
  99: "强雷阵雨伴冰雹",
};

/** 降水类码（雨/毛毛雨/阵雨/雪/阵雪/雷暴）：带伞建议看这个 */
export function isWetCode(code: number): boolean {
  return (code >= 51 && code <= 67) || (code >= 71 && code <= 86) || code >= 95;
}

export function weatherText(code: number): string {
  return WMO_TEXT[code] ?? `未知天气（码 ${code}）`;
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 日期串 "2026-08-30" → 中文星期。
 * 按 UTC 解析：负时区的机器上 new Date("2026-08-30") 会落到前一天，
 * weekday 整体错位，「周六有没有课/哪天降温」就全错了。
 */
export function weekdayOf(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return WEEKDAY_CN[d.getUTCDay()] ?? "";
}

// ── 类型 ──────────────────────────────────────────────────────

export interface GeoCandidate {
  name: string;
  admin1?: string;
  country?: string;
  countryCode?: string;
  latitude: number;
  longitude: number;
  /** Open-Meteo 的 feature_code，PPLA* 表示行政中心，用来消歧同名地点 */
  featureCode?: string;
  /** 部分条目没有这个字段（村庄/乡镇类），此时按 0 参与排序 */
  population?: number;
}

export interface WeatherNow {
  tempC: number;
  feelsLikeC: number;
  humidity: number;
  windKmh: number;
  precipMm: number;
  code: number;
  text: string;
  isDay: boolean;
}

export interface WeatherDay {
  date: string;
  weekday: string;
  code: number;
  text: string;
  maxC: number;
  minC: number;
  /** 当天最大降水概率（%）；接口没给时为 undefined（境外部分地区） */
  rainChance?: number;
}

export interface WeatherReport {
  /** 解析后的城市，如「南京（江苏·中国）」——查错了模型能看出来 */
  city: string;
  latitude: number;
  longitude: number;
  timezone: string;
  /** 该地当地时间：跨时区问天气时，这比本机时间有意义 */
  localTime: string;
  now: WeatherNow;
  days: WeatherDay[];
  advice: string[];
}

// ── 纯解析函数 ────────────────────────────────────────────────

/** geocoding 响应 → 候选列表。坏 JSON / 无结果一律空列表（调用方负责报错） */
export function parseGeoResponse(body: string): GeoCandidate[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const list: GeoCandidate[] = [];
  for (const item of results) {
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : "";
    const latitude = Number(o.latitude);
    const longitude = Number(o.longitude);
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const population = Number(o.population);
    list.push({
      name,
      admin1: typeof o.admin1 === "string" ? o.admin1 : undefined,
      country: typeof o.country === "string" ? o.country : undefined,
      countryCode:
        typeof o.country_code === "string" ? o.country_code : undefined,
      latitude,
      longitude,
      featureCode:
        typeof o.feature_code === "string" ? o.feature_code : undefined,
      population: Number.isFinite(population) ? population : undefined,
    });
  }
  return list;
}

/**
 * 同名地点消歧。
 *
 * 实测两个坑：查「南京」第一条之后跟着云南的南京村；查「海口」接口干脆
 * 不把海南省会排进前十（它只在搜「海口市」时出现），前十全是云南/浙江/
 * 福建/台湾的海口镇。所以排序主轴用人口——用户口中的城市名，几乎总是
 * 那个大的；人口缺失时再比行政级别。
 */
const ADMIN_RANK: Record<string, number> = {
  PPLA: 0, // 一级政区驻地（省会/直辖市）
  PPLA2: 1,
  PPLA3: 2, // 地区级驻地
  PPLA4: 3, // 县级驻地：云南那个「海口」就是这一档
  PPLA5: 4,
  PPL: 5, // 普通聚落
};

export function pickCandidate(list: GeoCandidate[]): GeoCandidate | null {
  if (list.length === 0) return null;
  let best = list[0];
  let bestPop = best.population ?? 0;
  let bestRank = ADMIN_RANK[best.featureCode ?? ""] ?? 9;
  for (const c of list.slice(1)) {
    const pop = c.population ?? 0;
    const rank = ADMIN_RANK[c.featureCode ?? ""] ?? 9;
    // 严格大于才换：人口与级别都一样时保持接口原顺序
    if (pop > bestPop || (pop === bestPop && rank < bestRank)) {
      best = c;
      bestPop = pop;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * 够不够可信到可以直接用：百万级人口，或本身就是一二级政区驻地。
 * 不够的（如 11 万人的海口镇）就值得再补一次带「市」的查询。
 */
export function isMajorCity(c: GeoCandidate | null): boolean {
  if (!c) return false;
  if ((c.population ?? 0) >= 1_000_000) return true;
  return c.featureCode === "PPLA" || c.featureCode === "PPLA2";
}

/** 候选 → 展示名，带上省/国，让模型有机会发现「查的不是那个城市」 */
export function labelOf(c: GeoCandidate): string {
  const parts = [c.admin1, c.country].filter(
    (p): p is string => !!p && p !== c.name
  );
  return parts.length ? `${c.name}（${parts.join("·")}）` : c.name;
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * forecast 响应 → WeatherReport。结构不对就抛，由 fetchWeather 转成
 * { ok:false }：这里返回半个报告，等于把残缺数据当天气说出去。
 */
export function parseForecast(body: string, geo: GeoCandidate): WeatherReport {
  const json = JSON.parse(body) as Record<string, unknown>;
  const cur = json.current as Record<string, unknown> | undefined;
  const daily = json.daily as Record<string, unknown> | undefined;
  if (!cur || !daily || !Array.isArray(daily.time)) {
    throw new Error("响应缺少 current/daily 字段");
  }
  const times = daily.time as string[];
  const codes = (daily.weather_code ?? []) as unknown[];
  const maxs = (daily.temperature_2m_max ?? []) as unknown[];
  const mins = (daily.temperature_2m_min ?? []) as unknown[];
  const chances = (daily.precipitation_probability_max ?? []) as (
    | number
    | null
    | unknown
  )[];

  const code = toNum(cur.weather_code);
  const now: WeatherNow = {
    tempC: toNum(cur.temperature_2m),
    feelsLikeC: toNum(cur.apparent_temperature),
    humidity: toNum(cur.relative_humidity_2m),
    windKmh: toNum(cur.wind_speed_10m),
    precipMm: toNum(cur.precipitation),
    code,
    text: weatherText(code),
    // 只有明确等于 1 才算白天：字段缺失时 NaN !== 0 会误报成「白天」
    isDay: Number(cur.is_day) === 1,
  };

  const days: WeatherDay[] = times.map((date, i) => {
    const c = toNum(codes[i]);
    const chance = chances[i];
    return {
      date,
      weekday: weekdayOf(date),
      code: c,
      text: weatherText(c),
      maxC: toNum(maxs[i]),
      minC: toNum(mins[i]),
      rainChance: chance == null ? undefined : toNum(chance),
    };
  });

  return {
    city: labelOf(geo),
    latitude: geo.latitude,
    longitude: geo.longitude,
    timezone: String(json.timezone ?? ""),
    localTime: String(cur.time ?? ""),
    now,
    days,
    advice: buildAdvice(now, days),
  };
}

// ── 建议 ──────────────────────────────────────────────────────

/** 降水概率到这条线就提带伞 */
const UMBRELLA_CHANCE = 50;
/** 昼夜温差到这条线就提醒加衣 */
const DIURNAL_SPAN = 8;

function dayLabel(d: WeatherDay, today?: WeatherDay): string {
  return today && d.date === today.date ? "今天" : d.weekday;
}

/**
 * 只出两句实话：带不带伞、穿什么。
 * 刻意不做「穿衣指数/紫外线指数」那套花活——温度和降水概率给到模型，
 * 它自己会往下聊；这里省掉的是它不该自己解析的 WMO 码。
 * 未来 3 天内都没雨、温差也不大时返回空数组，不硬凑。
 */
export function buildAdvice(now: WeatherNow, days: WeatherDay[]): string[] {
  const out: string[] = [];
  const today = days[0];
  const soon = days.slice(0, 3);

  const wetNow = isWetCode(now.code) || now.precipMm > 0.1;
  const wetDays = soon.filter(
    (d) => isWetCode(d.code) || (d.rainChance ?? 0) >= UMBRELLA_CHANCE
  );

  if (wetNow) {
    out.push("当前正在降水，出门带伞");
  } else if (wetDays.length > 0) {
    const detail = wetDays
      .map((d) =>
        d.rainChance != null
          ? `${dayLabel(d, today)} ${d.rainChance}%`
          : dayLabel(d, today)
      )
      .join("、");
    out.push(`${detail} 降水概率高，出门带伞`);
  }

  if (today && Number.isFinite(today.maxC) && Number.isFinite(today.minC)) {
    const clothes =
      today.maxC >= 28
        ? "短袖"
        : today.maxC >= 20
          ? "长袖或薄外套"
          : today.maxC >= 10
            ? "外套"
            : today.maxC >= 3
              ? "厚外套"
              : "羽绒服";
    const bits = [`今天 ${today.minC}~${today.maxC}℃，穿${clothes}`];
    const span = today.maxC - today.minC;
    if (span >= DIURNAL_SPAN) bits.push(`昼夜温差 ${Math.round(span)}℃，早晚加衣`);
    if (Number.isFinite(now.feelsLikeC) && now.feelsLikeC - now.tempC >= 4) {
      bits.push("湿度大体感比实际温度热");
    }
    if (Number.isFinite(now.feelsLikeC) && now.tempC - now.feelsLikeC >= 4) {
      bits.push("风大体感比实际温度冷");
    }
    out.push(bits.join("，"));
  }

  return out;
}

// ── 缓存 ──────────────────────────────────────────────────────

const geoCache = new Map<string, { at: number; value: GeoCandidate }>();
const resultCache = new Map<string, { at: number; value: WeatherReport }>();

/** 清空进程内缓存（测试用；常驻桥接进程里想立刻反映新数据时也可调） */
export function resetWeatherCache(): void {
  geoCache.clear();
  resultCache.clear();
}

// ── 网络 ──────────────────────────────────────────────────────

async function requestText(
  url: string,
  fetchImpl: WeatherFetch
): Promise<FetchResult<string>> {
  let res: Awaited<ReturnType<WeatherFetch>>;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    const err = e as Error;
    const msg =
      err?.name === "TimeoutError" || err?.name === "AbortError"
        ? `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`
        : err?.message ?? String(e);
    return { ok: false, error: `天气服务连不上：${msg.slice(0, 100)}` };
  }
  if (!res.ok) return { ok: false, error: `天气服务返回 HTTP ${res.status}` };
  return { ok: true, data: await res.text() };
}

async function geoSearch(query: string, fetchImpl: WeatherFetch) {
  const url = `${GEO_URL}?name=${encodeURIComponent(query)}&count=10&language=zh&format=json`;
  const resp = await requestText(url, fetchImpl);
  if (!resp.ok) return resp;
  return { ok: true as const, data: parseGeoResponse(resp.data) };
}

/**
 * 城市名 → 坐标。
 *
 * 两轮查询是实测逼出来的：「海口」单查拿不到海南省会（接口只在搜「海口市」
 * 时返回它），只会给云南那个 11 万人的海口镇。所以第一轮的结果不够可信时
 * （isMajorCity 判 false），补查一次「××市」再合并重挑。名字本来就带「市」
 * 的不重复查。多一次请求只发生在每个新城市的第一次，之后走缓存。
 */
async function resolveCity(
  city: string,
  fetchImpl: WeatherFetch
): Promise<FetchResult<GeoCandidate>> {
  const hit = geoCache.get(city);
  if (hit && Date.now() - hit.at < GEO_TTL_MS) return { ok: true, data: hit.value };

  const first = await geoSearch(city, fetchImpl);
  if (!first.ok) return first;
  let candidates = first.data;
  let picked = pickCandidate(candidates);

  if (!isMajorCity(picked) && !city.endsWith("市")) {
    const second = await geoSearch(`${city}市`, fetchImpl);
    if (second.ok) {
      const seen = new Set(candidates.map((c) => `${c.latitude},${c.longitude}`));
      candidates = [
        ...candidates,
        ...second.data.filter((c) => !seen.has(`${c.latitude},${c.longitude}`)),
      ];
      picked = pickCandidate(candidates);
    }
  }

  if (!picked) {
    return {
      ok: false,
      error: `城市库里没找到「${city}」。换标准地名试试（如「南京」而不是「南工大」）`,
    };
  }
  geoCache.set(city, { at: Date.now(), value: picked });
  return { ok: true, data: picked };
}

/**
 * 查一座城市的实况 + 未来预报。失败一律 { ok:false, error }，不降级成空数据。
 * @param city - 中文城市名即可（「南京」「三亚」）
 * @param days - 预报天数，1-14
 * @param fetchImpl - 注入用，默认走真实 HTTP
 * @param now - 注入用，默认当前时间
 */
export async function fetchWeather(
  city: string,
  days = 7,
  fetchImpl: WeatherFetch = httpFetch,
  now = () => Date.now()
): Promise<FetchResult<WeatherReport>> {
  const trimmed = city.trim();
  if (!trimmed) return { ok: false, error: "城市名为空" };

  const span = Math.max(1, Math.min(14, Math.round(days)));
  const cacheKey = `${trimmed}|${span}`;
  const cached = resultCache.get(cacheKey);
  if (cached && now() - cached.at < RESULT_TTL_MS) {
    return { ok: true, data: cached.value };
  }

  const geo = await resolveCity(trimmed, fetchImpl);
  if (!geo.ok) return geo;

  const params = new URLSearchParams({
    latitude: String(geo.data.latitude),
    longitude: String(geo.data.longitude),
    current:
      "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation,is_day",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    forecast_days: String(span),
    timezone: "auto",
  });
  const resp = await requestText(`${FORECAST_URL}?${params}`, fetchImpl);
  if (!resp.ok) return resp;

  try {
    const report = parseForecast(resp.data, geo.data);
    resultCache.set(cacheKey, { at: now(), value: report });
    return { ok: true, data: report };
  } catch (e) {
    return {
      ok: false,
      error: `天气响应解析失败：${(e as Error).message.slice(0, 100)}（响应 ${resp.data.length} 字节）`,
    };
  }
}
