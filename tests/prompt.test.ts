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

test("事实纪律段：先筛后查、时效事实标待核实、不覆盖用户给定事实、报告三组格式", () => {
  const s = basePrompt();
  assert.match(s, /## 事实纪律/, "应有独立的事实纪律段");
  assert.match(s, /先筛后查，不要逐句自查/, "高信号风险优先，不逐句自查");
  assert.match(s, /时效性事实默认「待核实」/, "时效性断言无工具支撑时要标待核实");
  assert.match(s, /不打断主流程/, "生成类任务的核查是收尾步，不索要批准");
  assert.match(s, /不改用户给定的事实/, "用户材料/口述是既定输入，不擅自替换");
  assert.match(s, /A\. 明确错误/, "核查报告要有 A/B/C 分组");
  assert.match(s, /B\. 表述不严谨/);
  assert.match(s, /C\. 需核实/);
  assert.match(s, /不写分数、置信度百分比/, "报告不写分数与置信度");
});

test("学习教练段：计划先签核后执行、讲习题先诊断再补差", () => {
  const s = basePrompt();
  assert.match(s, /计划先签核后执行/, "多步计划要先给方案等确认");
  assert.match(s, /等用户确认或调整后再展开执行/, "签核后才执行");
  assert.match(s, /不用问.*可跳过|直接给.*可跳过/, "用户明确要求时可跳过签核");
  assert.match(s, /讲习题先诊断再补差/, "习题类请求走诊断补差流程");
  assert.match(s, /diagnostic-drill/, "指向新增的第七篇参考");
  assert.match(s, /表面特征不同的题独立复检/, "复检必须换题");
  assert.match(s, /用户只要单道题的讲解就直接讲/, "单题请求不启动整套循环");
});

test("知识库段：入库要附来源行，依据不明写待核实", () => {
  const s = basePrompt();
  assert.match(s, /末尾附一行「来源：/, "知识入库要带来源行");
  assert.match(s, /来源：待核实/, "依据不明时标待核实");
});
