/**
 * 天气模块测试
 *
 * 全程离线：fetchWeather 的 fetch 是注入的，坏网/超次数/查无此城这些分支
 * 不该靠真联网来验证。钉住的行为有五条——
 * 1. WMO 码必须翻成中文，未知码不许瞎猜；
 * 2. 同名地点要挑行政中心（实测查「南京」会带出云南的南京村）；
 * 3. 任何一步拿不到数据都是 { ok:false, error }，绝不降级成空预报，
 *    否则模型会把「没查到」说成「近期无降水」；
 * 4. 带伞/穿衣建议由降水概率和温差算出来，凑不出来就不硬给；
 * 5. 结果缓存 2 分钟：挡住一次提问里连续调用把免费接口打爆。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  weatherText,
  isWetCode,
  weekdayOf,
  defaultWeatherCity,
  parseGeoResponse,
  pickCandidate,
  isMajorCity,
  labelOf,
  parseForecast,
  buildAdvice,
  fetchWeather,
  resetWeatherCache,
} = await import("../src/weather");

const GEO = {
  name: "南京",
  admin1: "江苏",
  country: "中国",
  countryCode: "CN",
  latitude: 32.06167,
  longitude: 118.77778,
  featureCode: "PPLA",
  population: 9314685,
};

/** 真实响应裁剪而来的 fixture（字段与线上一致） */
const FORECAST_FIXTURE = JSON.stringify({
  timezone: "Asia/Shanghai",
  current: {
    time: "2026-08-30T15:15",
    temperature_2m: 29.1,
    apparent_temperature: 33.7,
    relative_humidity_2m: 82,
    weather_code: 51,
    wind_speed_10m: 17.0,
    precipitation: 0.1,
    is_day: 1,
  },
  daily: {
    time: ["2026-08-30", "2026-08-31", "2026-09-01"],
    weather_code: [95, 96, 95],
    temperature_2m_max: [30.4, 25.4, 27.0],
    temperature_2m_min: [25.4, 22.0, 22.6],
    precipitation_probability_max: [96, 95, 78],
  },
});

/** 假 fetch：按 URL 前缀路由，并记下每次被请求的地址 */
function stubFetch(
  routes: Array<{ match: string; body?: string; status?: number; throw?: Error }>,
) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`未预置的请求：${url}`);
    if (route.throw) throw route.throw;
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => route.body ?? "",
    };
  };
  return { impl: impl as never, calls };
}

/**
 * 地理编码路由。必须带上尾部 &：搜「海口市」的 URL 里同样含有「海口」的
 * 编码前缀，不带 & 两条路由会互相误命中，两轮重试的测试就白写了。
 */
function geoRoute(query: string, results: unknown[]) {
  return {
    match: `name=${encodeURIComponent(query)}&`,
    body: JSON.stringify({ results }),
  };
}

/** 断言里要读到的那几个字段，够就行，不重复整套 WeatherReport */
type WeatherLike = {
  city: string;
  latitude: number;
  days: unknown[];
  advice: string[];
};

// ── 天气码与日期 ──────────────────────────────────────────────

test("WMO 码翻成中文，未知码如实标出而不猜", () => {
  assert.equal(weatherText(0), "晴");
  assert.equal(weatherText(3), "阴");
  assert.equal(weatherText(95), "雷阵雨");
  assert.equal(weatherText(61), "小雨");
  assert.match(weatherText(42), /未知天气（码 42）/);
});

test("降水类码判定：雨/雪/雷暴算湿，雾和阴不算", () => {
  assert.equal(isWetCode(61), true);
  assert.equal(isWetCode(73), true); // 中雪照样要带伞/穿防滑
  assert.equal(isWetCode(95), true);
  assert.equal(isWetCode(45), false); // 雾是能见度问题，不是降水
  assert.equal(isWetCode(3), false);
});

test("星期按 UTC 解析，不受本机时区影响", () => {
  assert.equal(weekdayOf("2026-08-30"), "周日");
  assert.equal(weekdayOf("2026-08-31"), "周一");
});

// ── 默认城市按学校判断 ────────────────────────────────────────

test("默认城市跟着教务系统主机名走", () => {
  assert.equal(defaultWeatherCity("https://jwgl.njtech.edu.cn"), "南京");
  // 未登记的学校仍退回南京（当前只有 NJTECH 一套教务），但不能默默猜错：
  // 这里钉住现状，将来多接一所学校时必须显式加映射
  assert.equal(defaultWeatherCity("https://jwgl.example.edu.cn"), "南京");
});

// ── 地理编码 ──────────────────────────────────────────────────

test("geocoding 响应能解析，坏 JSON 与无结果返回空列表", () => {
  const body = JSON.stringify({
    results: [
      {
        name: "南京",
        latitude: 32.06,
        longitude: 118.77,
        admin1: "江苏",
        country: "中国",
        country_code: "CN",
        feature_code: "PPLA",
        population: 9314685,
      },
      { name: "南京", latitude: 23.4, longitude: 99.77, admin1: "云南" },
    ],
  });
  const list = parseGeoResponse(body);
  assert.equal(list.length, 2);
  assert.equal(list[0].population, 9314685);
  assert.equal(list[1].population, undefined); // 缺字段不能变成 NaN 参与排序
  assert.deepEqual(parseGeoResponse("not json"), []);
  assert.deepEqual(parseGeoResponse('{"results":[]}'), []);
});

test("同名地点按人口挑大的，人口缺失时比行政级别", () => {
  const village = { ...GEO, featureCode: "PPL", admin1: "云南", population: undefined };
  const county = { ...GEO, featureCode: "PPLA4", admin1: "云南", population: 112644 };
  const city = { ...GEO };
  assert.equal(pickCandidate([village, city]), city);
  assert.equal(pickCandidate([county, village]), county); // 都没人口 → PPLA4 胜过 PPL
  assert.equal(pickCandidate([city, village]), city);
  assert.equal(pickCandidate([]), null);
});

test("百万人口或一二级政区驻地才算可信城市", () => {
  assert.equal(isMajorCity(GEO), true); // 9314685
  assert.equal(isMajorCity({ ...GEO, population: undefined }), true); // PPLA 本身即驻地
  assert.equal(isMajorCity({ ...GEO, featureCode: "PPLA4", population: 112644 }), false);
  assert.equal(isMajorCity(null), false);
});

test("展示名带省市，让模型有机会发现查错了地方", () => {
  assert.equal(labelOf(GEO), "南京（江苏·中国）");
  assert.equal(labelOf({ ...GEO, admin1: undefined, country: undefined }), "南京");
});

// ── 预报解析 ──────────────────────────────────────────────────

test("forecast 解析出实况与逐日预报", () => {
  const r = parseForecast(FORECAST_FIXTURE, GEO);
  assert.equal(r.city, "南京（江苏·中国）");
  assert.equal(r.now.tempC, 29.1);
  assert.equal(r.now.text, "小毛毛雨");
  assert.equal(r.now.isDay, true);
  assert.equal(r.days.length, 3);
  assert.equal(r.days[1].weekday, "周一");
  assert.equal(r.days[1].text, "雷阵雨伴冰雹");
  assert.equal(r.days[0].rainChance, 96);
  assert.equal(r.localTime, "2026-08-30T15:15");
});

test("is_day 为 0 或缺失时都不许说成白天", () => {
  // NaN !== 0 为真，字段缺失若按「不等于 0 就是白天」处理会在夜里报「白天」
  assert.equal(
    parseForecast(FORECAST_FIXTURE.replace('"is_day":1', '"is_day":0'), GEO).now.isDay,
    false,
  );
  assert.equal(parseForecast(FORECAST_FIXTURE.replace(',"is_day":1', ""), GEO).now.isDay, false);
});

test("结构不对的响应抛错，由上层转成失败（不返回半个报告）", () => {
  assert.throws(() => parseForecast('{"foo":1}', GEO));
});

// ── 建议 ──────────────────────────────────────────────────────

type Now = Parameters<typeof buildAdvice>[0];
type DayArg = Parameters<typeof buildAdvice>[1][number];

function makeNow(over: Partial<Now> = {}): Now {
  return {
    tempC: 30,
    feelsLikeC: 33,
    humidity: 80,
    windKmh: 10,
    precipMm: 0,
    code: 1,
    text: "晴间多云",
    isDay: true,
    ...over,
  };
}

function makeDay(over: Partial<DayArg>): DayArg {
  return {
    date: "2026-08-30",
    weekday: "周日",
    code: 0,
    text: "晴",
    maxC: 30,
    minC: 26,
    rainChance: 5,
    ...over,
  };
}

test("近三天降水概率高 → 建议带伞并给出概率", () => {
  const days: DayArg[] = [
    makeDay({ rainChance: 96 }),
    makeDay({ date: "2026-08-31", weekday: "周一", maxC: 29, minC: 24, rainChance: 10 }),
  ];
  const advice = buildAdvice(makeNow(), days);
  assert.match(advice[0], /今天 96% 降水概率高，出门带伞/);
});

test("第 4 天以后的雨不催带伞", () => {
  const days: DayArg[] = Array.from({ length: 6 }, (_, i) =>
    makeDay({ date: `2026-09-0${i + 1}`, rainChance: i >= 3 ? 90 : 5 }),
  );
  const advice = buildAdvice(makeNow(), days);
  assert.equal(
    advice.some((a) => a.includes("带伞")),
    false,
  );
});

test("正在下雨时先说当前带伞", () => {
  const advice = buildAdvice(makeNow({ code: 61, text: "小雨" }), [makeDay({})]);
  assert.equal(advice[0], "当前正在降水，出门带伞");
});

test("昼夜温差大要提醒加衣，温差小就不啰嗦", () => {
  const big = [makeDay({ date: "2026-11-02", weekday: "周一", maxC: 20, minC: 9, rainChance: 0 })];
  const small = [
    makeDay({ date: "2026-11-02", weekday: "周一", maxC: 18, minC: 14, rainChance: 0 }),
  ];
  assert.match(buildAdvice(makeNow(), big)[0], /温差/);
  assert.equal(
    buildAdvice(makeNow(), small).some((a) => a.includes("温差")),
    false,
  );
});

test("干净的好天气不硬凑带伞建议", () => {
  const days = [
    makeDay({ date: "2026-10-01", weekday: "周四", maxC: 24, minC: 15, rainChance: 3 }),
  ];
  const advice = buildAdvice({ ...makeNow(), feelsLikeC: 23, code: 0 }, days);
  assert.equal(advice.length, 1);
  assert.match(advice[0], /穿长袖或薄外套/);
});

// ── fetchWeather：失败契约与缓存 ──────────────────────────────

test("查无此城返回失败，而不是空预报", async () => {
  resetWeatherCache();
  const { impl } = stubFetch([{ match: "geocoding", body: '{"results":[]}' }]);
  const r = await fetchWeather("南工大", 3, impl, () => Date.now());
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /城市库里没找到「南工大」/);
});

test("预报接口 5xx 返回失败并带上状态码", async () => {
  resetWeatherCache();
  const { impl } = stubFetch([
    {
      match: "geocoding",
      body: JSON.stringify({
        results: [{ name: "南京", latitude: 32.06, longitude: 118.77, feature_code: "PPLA" }],
      }),
    },
    { match: "forecast", body: "boom", status: 503 },
  ]);
  const r = await fetchWeather("南京", 3, impl, () => Date.now());
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /HTTP 503/);
});

test("网络异常返回失败（不是空数据）", async () => {
  resetWeatherCache();
  const { impl } = stubFetch([
    { match: "geocoding", throw: new Error("getaddrinfo ENOTFOUND api.open-meteo.com") },
  ]);
  const r = await fetchWeather("南京", 3, impl, () => Date.now());
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /天气服务连不上/);
});

test("响应解析失败时如实报错，不猜天气", async () => {
  resetWeatherCache();
  const { impl } = stubFetch([
    {
      match: "geocoding",
      body: JSON.stringify({
        results: [{ name: "南京", latitude: 32.06, longitude: 118.77, feature_code: "PPLA" }],
      }),
    },
    { match: "forecast", body: "<html>限流页面</html>" },
  ]);
  const r = await fetchWeather("南京", 3, impl, () => Date.now());
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /天气响应解析失败/);
});

test("海口这种同名小地名会自动补查「海口市」，挑中海南省会", async () => {
  resetWeatherCache();
  const { impl, calls } = stubFetch([
    // 第一轮：接口只给云南的海口镇（实测如此，海南省会压根不在前十）
    geoRoute("海口", [
      {
        name: "海口",
        admin1: "云南",
        country: "中国",
        feature_code: "PPLA4",
        population: 112644,
        latitude: 24.77985,
        longitude: 102.57548,
      },
    ]),
    // 第二轮：带「市」才出得来省会
    geoRoute("海口市", [
      {
        name: "海口市",
        admin1: "海南",
        country: "中国",
        feature_code: "PPLA",
        population: 2873358,
        latitude: 20.03421,
        longitude: 110.34651,
      },
    ]),
    { match: "forecast", body: FORECAST_FIXTURE },
  ]);
  const r = await fetchWeather("海口", 3, impl, () => Date.now());
  assert.equal(r.ok, true);
  const w = (r as { data: WeatherLike }).data;
  assert.equal(w.city, "海口市（海南·中国）");
  assert.equal(w.latitude, 20.03421); // 落在海南，不是云南
  assert.equal(
    calls.filter((u) => u.includes("geocoding")).length,
    2,
    "只在第一轮不够可信时补查一次",
  );
});

test("成功路径跑通，且 2 分钟内重复查询不再请求接口", async () => {
  resetWeatherCache();
  const t0 = Date.now();
  const { impl, calls } = stubFetch([
    {
      match: "geocoding",
      body: JSON.stringify({
        results: [{ name: "南京", latitude: 32.06, longitude: 118.77, feature_code: "PPLA" }],
      }),
    },
    { match: "forecast", body: FORECAST_FIXTURE },
  ]);
  const first = await fetchWeather("南京", 3, impl, () => t0);
  assert.equal(first.ok, true);
  const report = (first as { data: { days: unknown[]; advice: string[] } }).data;
  assert.equal(report.days.length, 3);
  assert.ok(report.advice.length > 0);
  assert.equal(calls.length, 2); // 地理编码 + 预报

  await fetchWeather("南京", 3, impl, () => t0 + 60_000);
  assert.equal(calls.length, 2, "1 分钟内的重复查询必须命中结果缓存");

  await fetchWeather("南京", 3, impl, () => t0 + 3 * 60_000);
  assert.equal(calls.length, 3, "超过 2 分钟要重新取预报");
});

test("城市名两边空白不影响缓存", async () => {
  resetWeatherCache();
  const { impl, calls } = stubFetch([
    {
      match: "geocoding",
      body: JSON.stringify({
        results: [{ name: "三亚", latitude: 18.25, longitude: 109.5, feature_code: "PPLA" }],
      }),
    },
    { match: "forecast", body: FORECAST_FIXTURE },
  ]);
  await fetchWeather("  三亚  ", 3, impl, () => Date.now());
  await fetchWeather("三亚", 3, impl, () => Date.now());
  assert.equal(calls.length, 2);
});
