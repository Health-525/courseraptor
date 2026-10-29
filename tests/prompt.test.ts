/**
 * 校历提示词段渲染：运行时真值（term-dates/term-holidays）能进提示词。
 * 提示词不再硬编码校历——过去对话里修正过的开学日期只进了记忆没进代码，
 * 两份真相漂移过一整个学期；现在只认 data/ 下的落盘数据。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HAS_NJTECH } from "./_util/njtech-probe";

// 必须在导入被测模块前设好数据目录（term-dates/holidays 首次 load 即缓存；
// 每个测试文件是独立进程，不会污染其他用例）
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-prompt-"));
process.env.RAPTOR_DATA_DIR = dataDir;
// 本文件钉的是南工大校历/教学周语义：默认学校已改为 custom（不接入任何学校），显式选校。
// njtech 是本地可选插件、不进公开仓库；缺失时退回默认 custom 让装配点通过，
// 依赖 njtech 校历的用例由 t=test.skip 跳过（与学校无关的通用准则用例照常跑）。
if (HAS_NJTECH) {
  process.env.RAPTOR_SCHOOL = "njtech";
} else {
  delete process.env.RAPTOR_SCHOOL;
}

await import("../src/adapters");
const { writeFileAtomicSync } = await import("../src/core/atomic-write");

writeFileAtomicSync(
  path.join(dataDir, "term-dates.json"),
  JSON.stringify({
    "2026-1": {
      week1Monday: "2026-08-31",
      source: "recorded",
      evidence: "南工教〔2026〕91号",
    },
  }),
);
writeFileAtomicSync(
  path.join(dataDir, "term-holidays.json"),
  JSON.stringify({
    days: {
      "2026-10-01": { type: "holiday", name: "国庆节" },
      "2026-09-27": { type: "makeup", follows: 4 },
    },
  }),
);

const { calendarSection } = await import("../src/core/prompt");

/** njtech 校历专属用例：插件缺失（公开仓库 / CI）时跳过 */
const t = HAS_NJTECH ? test : test.skip;

t("校历段：开学日期与放假/调休从运行时真值渲染进提示词", () => {
  const s = calendarSection();
  assert.match(s, /2026-1 学期：第 1 周 2026-08-31（周一）/);
  assert.match(s, /南工教〔2026〕91号/, "recorded 来源要带证据（通知文号）");
  assert.match(s, /2026-10-01 放假（国庆节）/);
  assert.match(s, /2026-09-27 调休补课（按周4课表）/);
  assert.match(s, /以工具返回为准/, "永远声明运行时真值优先级");
});

const { basePrompt } = await import("../src/core/prompt");

test("行为准则：今日简报规则要求日程与待办结合分析", () => {
  const s = basePrompt();
  assert.match(s, /今日简报/, "应有今日简报规则");
  assert.match(s, /manage_todos list 看未完成待办/, "应要求结合待办");
  assert.match(s, /不要分两张清单各念各的/, "应要求交叉分析而非两张清单");
});

test("事实纪律段：先筛后查、时效事实先联网核实、不覆盖用户给定事实、报告三组格式", () => {
  const s = basePrompt();
  assert.match(s, /## 事实纪律/, "应有独立的事实纪律段");
  assert.match(s, /先筛后查，不要逐句自查/, "高信号风险优先，不逐句自查");
  assert.match(s, /时效性事实先联网核实/, "时效性断言应先走 web_search 搜证");
  assert.match(s, /不许拿训练数据里的印象充当事实/, "搜不到也要标待核实，不许编");
  assert.match(s, /不打断主流程/, "生成类任务的核查是收尾步，不索要批准");
  assert.match(s, /不改用户给定的事实/, "用户材料/口述是既定输入，不擅自替换");
  assert.match(s, /A\. 明确错误/, "核查报告要有 A/B/C 分组");
  assert.match(s, /B\. 表述不严谨/);
  assert.match(s, /C\. 需核实/);
  assert.match(s, /不写分数、置信度百分比/, "报告不写分数与置信度");
});

test("联网搜索段：时效问题先搜再答、按次计费约束、专用工具优先", () => {
  const s = basePrompt();
  assert.match(s, /web_search/, "应有联网搜索能力段");
  assert.match(s, /先搜再答/, "时效性问题先搜再答");
  assert.match(s, /搜索按次计费/, "要有计费节制约束（不为同一问题反复搜）");
  assert.match(s, /换关键词重搜至多一次/, "重搜次数有上限");
  assert.match(s, /web_fetch/, "应有网页读取工具");
  assert.match(s, /教务通知走 get_news/, "教务通知不绕去联网搜索");
  assert.doesNotMatch(s, /你没有联网检索工具/, "旧「无联网」表述应随功能移除");
});

test("学习辅导段：按需 read_skill，多步计划先签核", () => {
  const s = basePrompt();
  assert.match(s, /read_skill/, "学习类请求应先读 skill");
  assert.match(s, /一次只取当前需要的一篇/, "按需一篇");
  assert.match(s, /先给方案请用户确认再展开/, "多步计划先签核");
  assert.match(s, /直接给.*可跳过/, "用户明确要求时可跳过签核");
  assert.doesNotMatch(s, /read_learning_reference|diagnostic-drill/, "旧 meta-learning 引用应清除");
});

test("知识库段：入库要附来源行，依据不明写待核实", () => {
  const s = basePrompt();
  assert.match(s, /末尾附一行「来源：/, "知识入库要带来源行");
  assert.match(s, /来源：待核实/, "依据不明时标待核实");
});

test("知识库段：答知识类问题先检索知识库，命中以其为依据", () => {
  const s = basePrompt();
  assert.match(s, /答知识类问题先查知识库/, "应确立答前检索规则");
  assert.match(s, /回答前先调 list 传 keyword 检索/, "检索走 manage_knowledge list");
  assert.match(s, /来自你记过的知识/, "命中要标明来自用户记录");
  assert.match(s, /用户记过的口径优先于你自己的讲法/, "记录口径优先");
  assert.match(s, /才按常规方式回答/, "知识库没有才走常规回答路径");
  assert.match(s, /教务查询、闲聊不用查/, "划定不检索的范围");
});
