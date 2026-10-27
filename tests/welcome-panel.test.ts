/**
 * 欢迎面板纯排版层的回归：宽度口径（中文/emoji 2 列）决定外框右边线
 * 是否对齐，徽标右对齐与窄终端页脚换行是布局的显式行为，都钉住。
 * 测试进程无 TTY，color.ts 降级为空串，量宽即量渲染结果。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWelcomeLines,
  type ScheduleRow,
  type SectionRows,
  type TodoRow,
  textWidth,
  truncateTo,
  type WelcomeState,
} from "../local/cli/tui/welcome-panel";

// biome-ignore lint/suspicious/noControlCharactersInRegex: 量宽前必须剥掉面板行里的 ANSI 颜色序列
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const STAR_URL = "https://github.com/Health-525/courseraptor";

function state(partial?: Partial<WelcomeState>): WelcomeState {
  return {
    now: new Date("2026-10-27T20:00:00"),
    dateLabel: "10月27日 周二",
    webUrl: "http://127.0.0.1:8787",
    blank: false,
    schedule: {
      kind: "rows",
      rows: [
        { time: "10:00-11:40", title: "操作系统原理", location: "同和楼212(多)" },
        {
          time: "14:00-15:40",
          title: "习近平新时代中国特色社会主义思想概论",
          location: "仁智楼301(多)",
        },
      ],
      more: 0,
    },
    todos: {
      kind: "rows",
      rows: [
        { title: "完成网课最后的考试（智慧树 Triz版 / 尔雅 中华诗词之美）", days: 6 },
        { title: "提交大创结题报告", days: 0 },
      ],
      more: 2,
    },
    ...partial,
  };
}

test("textWidth：中文与常用 emoji 按 2 列，ASCII 按 1 列", () => {
  assert.equal(textWidth("abc"), 3);
  assert.equal(textWidth("操作系统"), 8);
  assert.equal(textWidth("📅📋"), 4);
  assert.equal(textWidth("10:00-11:40"), 11);
});

test("truncateTo：超长中文标题截断后仍不超预算且以 ... 结尾", () => {
  const out = truncateTo("习近平新时代中国特色社会主义思想概论", 20);
  assert.ok(textWidth(out) <= 20, `截断后 ${textWidth(out)} 列`);
  assert.ok(out.endsWith("..."));
  assert.equal(truncateTo("短标题", 20), "短标题");
});

test("任何行都不超过给定宽度，外框右边线不会被顶歪", () => {
  // 60 列已覆盖窄文案与无后缀网页行的自适应路径；再窄（短页脚本身 52 列）
  // 超出设计范围，交给库截断
  for (const columns of [100, 80, 60]) {
    const width = columns - 4;
    for (const line of buildWelcomeLines(state(), width)) {
      assert.ok(
        textWidth(strip(line)) <= width,
        `${columns} 列终端下超宽：${strip(line)}（${textWidth(strip(line))} > ${width}）`,
      );
    }
  }
});

test("待办徽标右对齐成一列，列位置随宽度收紧", () => {
  for (const width of [96, 76, 56]) {
    const lines = buildWelcomeLines(state(), width);
    const badges = lines.filter(
      (l) => /(还有 \d+ 天|今天|已逾期)/.test(strip(l)) && !strip(l).startsWith("  ..."),
    );
    const ends = badges.map((l) => textWidth(strip(l)));
    assert.equal(new Set(ends).size, 1, `宽度 ${width} 下徽标未对齐：${ends}`);
  }
});

test("未选学校：只渲染栏目题头与网页地址，不出现任何教务内容", () => {
  const lines = buildWelcomeLines(state({ blank: true, week: undefined }), 96).map(strip);
  assert.ok(lines.some((l) => l.includes("今日课表")));
  assert.ok(lines.some((l) => l.includes("一周内待办")));
  assert.ok(lines.some((l) => l.includes("网页对话")));
  for (const l of lines) {
    assert.ok(!l.includes("操作系统"), `空面板泄露课表：${l}`);
    assert.ok(!l.includes("大创"), `空面板泄露待办：${l}`);
    assert.ok(!l.includes("第"), `空面板不该有教学周：${l}`);
  }
});

test("hint 栏目渲染单行提示，more 条数落在「还有 N」行", () => {
  const hint: SectionRows<ScheduleRow> = { kind: "hint", text: "今天没有课" };
  const todos: SectionRows<TodoRow> = { kind: "hint", text: "暂无一周内到期待办" };
  const lines = buildWelcomeLines(state({ schedule: hint, todos }), 96).map(strip);
  assert.ok(lines.includes("  今天没有课"));
  assert.ok(lines.includes("  暂无一周内到期待办"));
  const rows = buildWelcomeLines(state(), 96).map(strip);
  assert.ok(rows.some((l) => l.includes("...还有 2 条，问我看全部")));
});

test("页脚：宽终端用完整文案，窄终端自动换短文案且 Star URL 完整", () => {
  const wide = buildWelcomeLines(state({ webUrl: null }), 96).map(strip);
  assert.ok(wide.some((l) => l.includes("唤出命令菜单")));
  assert.ok(wide.some((l) => l.endsWith(STAR_URL)));

  const narrow = buildWelcomeLines(state({ webUrl: null }), 56).map(strip);
  assert.ok(narrow.some((l) => l.includes("/ 唤出菜单")));
  for (const l of narrow) {
    if (l.includes(STAR_URL)) assert.ok(l.endsWith(STAR_URL), "窄终端 Star URL 被截断");
  }
});

test("课表行时间列定宽，无时间的课也保持对齐", () => {
  const schedule: SectionRows<ScheduleRow> = {
    kind: "rows",
    rows: [
      { time: "10:00-11:40", title: "操作系统原理", location: "同和楼212" },
      { time: "", title: "无时间课", location: "待定" },
    ],
    more: 0,
  };
  const lines = buildWelcomeLines(state({ schedule }), 96)
    .map(strip)
    .filter((l) => l.startsWith("  ") && (l.includes("操作系统") || l.includes("无时间课")));
  // 时间列固定 13 列（11 时间 + 2 间隔）：课名一律从第 15 列起，空时间用占位空格
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.ok(lines[0]?.slice(15).startsWith("操作系统"), `课名未对齐：${JSON.stringify(lines)}`);
  assert.ok(lines[1]?.slice(15).startsWith("无时间课"), `空时间未占位：${JSON.stringify(lines)}`);
});
