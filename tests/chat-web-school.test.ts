/**
 * 学校选择 + 手动课表导入的网页接口链路：
 * /api/settings 的 school 块、运行期切换、/api/news 未适配态、
 * /api/schedule/import（文本与上传文件两条路）与 commit 落盘。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-import-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");
delete process.env.RAPTOR_SCHOOL;

await import("../src/adapters");
const { startChatWeb } = await import("../src/channels/web/chat-web");
const { setScheduleParser } = await import("../src/core/schedule-import");
const { loadScheduleCache } = await import("../src/core/schedule-cache");
const { loadCredentialsStore } = await import("../src/core/credentials");
const { manualTermStarts } = await import("../src/core/manual-terms");

/** 页面签发的 CSRF token（写请求必须带） */
let pageToken: string | null = null;
async function csrfToken(): Promise<string> {
  pageToken ??=
    (await (await fetch((await startChatWeb())!)).text()).match(
      /<meta name="csrf-token" content="([0-9a-f]{64})">/,
    )?.[1] ?? null;
  assert.ok(pageToken, "页面必须注入 csrf-token meta");
  return pageToken;
}

async function wfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("content-type", "application/json");
  headers.set("x-csrf-token", await csrfToken());
  return fetch(url, { ...init, headers });
}

/** 固定输出的解析器替身：一门课 + 一个追问 */
const FAKE_MODEL_OUTPUT = JSON.stringify({
  courses: [
    {
      title: "高等数学",
      weekday: 1,
      periods: [3, 4],
      weeks: "1-16",
      location: "教一101",
      teacher: "张老师",
    },
  ],
  questions: [{ question: "本学期一共上到第几周？", options: "16/18/20" }],
  termHint: "2026-2027-1",
});
setScheduleParser(async () => FAKE_MODEL_OUTPUT);

const base = async () => (await startChatWeb())!;

test("GET /api/settings：school 块带清单与手动课表标记，默认 njtech", async () => {
  const r = await (await fetch(`${await base()}/api/settings`)).json();
  assert.equal(r.school.current, "njtech");
  assert.equal(r.school.manual, false);
  assert.deepEqual(
    r.school.options.map((o: { id: string }) => o.id),
    ["njtech", "hebau", "custom"],
  );
  assert.equal(r.school.options[2].manual, true);
});

test("切学校教务账号跟着切：旧校存回名下、新校空则清空待填、切回自动恢复", async () => {
  // ① njtech 下保存教务账号 → 入 njtech 槽位
  const save = await wfetch(`${await base()}/api/settings`, {
    method: "POST",
    body: JSON.stringify({ jwglUsername: "202321144057", jwglPassword: "fake-pass-1" }),
  });
  assert.equal(save.status, 200);
  assert.equal(loadCredentialsStore()?.jwglAccounts?.njtech?.username, "202321144057");

  // ② 切到河北农大：没有该校账号 → 当前账号清空，提示填写；南工大账号留在槽里不删
  const r = await wfetch(`${await base()}/api/settings`, {
    method: "POST",
    body: JSON.stringify({ schoolId: "hebau" }),
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  const line = d.results.find((x: { field: string }) => x.field === "school");
  assert.match(line.message, /已切换为「河北农业大学」/);
  assert.match(line.message, /还没有保存教务账号.*填写河北农业大学的学号与密码/s);
  assert.equal(d.status.school.current, "hebau");
  assert.equal(d.status.jwgl.configured, false);
  assert.equal(d.status.jwgl.username, "");
  const store1 = loadCredentialsStore();
  assert.equal(store1?.username, "");
  assert.equal(store1?.jwglAccounts?.njtech?.username, "202321144057", "旧校账号必须还在槽里");

  // ③ 切回 njtech：自动恢复南工大账号，不用重填
  const back = await wfetch(`${await base()}/api/settings`, {
    method: "POST",
    body: JSON.stringify({ schoolId: "njtech" }),
  });
  const bd = await back.json();
  assert.match(
    bd.results.find((x: { field: string }) => x.field === "school").message,
    /已载入本校保存的教务账号（学号 2023\*\*\*\*）/,
  );
  assert.equal(bd.status.jwgl.configured, true);
  assert.equal(bd.status.jwgl.username, "202321144057");

  // ④ 两校各存各的：hebau 存自己的账号后互切，各用各的
  await wfetch(`${await base()}/api/settings`, {
    method: "POST",
    body: JSON.stringify({ schoolId: "hebau" }),
  });
  const resave = await wfetch(`${await base()}/api/settings`, {
    method: "POST",
    body: JSON.stringify({ jwglUsername: "202501010203", jwglPassword: "fake-pass-2" }),
  });
  assert.equal(resave.status, 200);
  const store2 = loadCredentialsStore();
  assert.equal(store2?.jwglAccounts?.hebau?.username, "202501010203");
  assert.equal(store2?.jwglAccounts?.njtech?.username, "202321144057");
  const toN = await (
    await wfetch(`${await base()}/api/settings`, {
      method: "POST",
      body: JSON.stringify({ schoolId: "njtech" }),
    })
  ).json();
  assert.equal(toN.status.jwgl.username, "202321144057");
  const toH = await (
    await wfetch(`${await base()}/api/settings`, {
      method: "POST",
      body: JSON.stringify({ schoolId: "hebau" }),
    })
  ).json();
  assert.equal(toH.status.jwgl.username, "202501010203");

  // ⑤ 能力说明按学校 capabilities 生成：hebau 没接通知就不能写通知
  const opts = toH.status.school.options as Array<{ id: string; note?: string }>;
  const hebauNote = opts.find((o) => o.id === "hebau")?.note ?? "";
  assert.match(hebauNote, /课表 \/ 成绩 \/ 考试/);
  assert.doesNotMatch(hebauNote, /通知/);
  assert.match(opts.find((o) => o.id === "njtech")?.note ?? "", /通知/);
  assert.equal(opts.find((o) => o.id === "custom")?.note, undefined);
});

test("POST /api/settings 切换学校：运行期生效并落凭证", async () => {
  const r = await wfetch(`${await base()}/api/settings`, {
    method: "POST",
    body: JSON.stringify({ schoolId: "custom", customSchoolName: "某某大学", customCity: "杭州" }),
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.status.school.current, "custom");
  assert.equal(d.status.school.manual, true);
  assert.match(d.results.find((x: { field: string }) => x.field === "school").message, /已切换/);
  const creds = loadCredentialsStore();
  assert.equal(creds?.schoolId, "custom");
  assert.equal(creds?.customSchoolName, "某某大学");
  assert.equal(creds?.customCity, "杭州");
  // 再切一遍同一学校：提示无需切换，不算失败
  const again = await wfetch(`${await base()}/api/settings`, {
    method: "POST",
    body: JSON.stringify({ schoolId: "custom" }),
  });
  assert.equal(again.status, 200);
});

test("自定义学校：/api/news 给未适配态", async () => {
  const r = await (await fetch(`${await base()}/api/news`)).json();
  assert.deepEqual(r.items, []);
  assert.equal(r.unsupported, true);
});

test("POST /api/schedule/import：文本解析 + 追问透传；空内容报错", async () => {
  const r = await wfetch(`${await base()}/api/schedule/import`, {
    method: "POST",
    body: JSON.stringify({ text: "周一 3-4节 高等数学 1-16周 教一101 张老师" }),
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.courses.length, 1);
  assert.equal(d.courses[0].title, "高等数学");
  assert.deepEqual(d.courses[0].periods, [3, 4]);
  assert.equal(d.questions.length, 1);
  assert.match(d.questions[0].question, /第几周/);

  const empty = await wfetch(`${await base()}/api/schedule/import`, {
    method: "POST",
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(empty.status, 400);
});

test("POST /api/schedule/import：上传文件走同一条解析（uploadId）", async () => {
  const up = await wfetch(`${await base()}/api/uploads`, {
    method: "POST",
    body: JSON.stringify({
      name: "课表.txt",
      type: "text/plain",
      data: Buffer.from("周一 3-4节 高等数学 1-16周", "utf8").toString("base64"),
    }),
  });
  const upload = await up.json();
  assert.ok(upload.upload?.id);
  const r = await wfetch(`${await base()}/api/schedule/import`, {
    method: "POST",
    body: JSON.stringify({ uploadId: upload.upload.id }),
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.fileName, "课表.txt");
  assert.equal(d.courses.length, 1);
  // 不存在的上传：明确报错
  const gone = await wfetch(`${await base()}/api/schedule/import`, {
    method: "POST",
    body: JSON.stringify({ uploadId: "no-such" }),
  });
  assert.equal(gone.status, 400);
});

test("POST /api/schedule/import：上传 Excel 全部课程行都进解析（不截前 15 行）", async () => {
  const require = createRequire(import.meta.url);
  const XLSX = require("xlsx") as typeof import("xlsx");
  // 30 门课的课表：默认每 sheet 预览 15 行会把第 16 门起全部静默丢掉
  const rows: unknown[][] = [["课程", "星期", "节次", "周次"]];
  for (let i = 1; i <= 30; i++)
    rows.push([`课程${String(i).padStart(2, "0")}`, "周一", "3-4", "1-16"]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "课表");
  const up = await wfetch(`${await base()}/api/uploads`, {
    method: "POST",
    body: JSON.stringify({
      name: "课表.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: XLSX.write(wb, { bookType: "xlsx", type: "base64" }),
    }),
  });
  const upload = (await up.json()).upload;

  let seenPrompt = "";
  setScheduleParser(async (prompt) => {
    seenPrompt = prompt;
    return FAKE_MODEL_OUTPUT;
  });
  try {
    const r = await wfetch(`${await base()}/api/schedule/import`, {
      method: "POST",
      body: JSON.stringify({ uploadId: upload.id }),
    });
    assert.equal(r.status, 200);
    assert.match(seenPrompt, /课程25/, "第 25 行课程必须进入解析（默认 15 行预览会丢）");
    assert.match(seenPrompt, /课程30/, "最后一行课程必须进入解析");
  } finally {
    setScheduleParser(async () => FAKE_MODEL_OUTPUT);
  }
});

test("POST /api/schedule/import/commit：落盘课表缓存与开学日期（校验周一）", async () => {
  const courses = [
    {
      title: "高等数学",
      weekday: 1,
      periods: [3, 4],
      weeks: "1-16",
      location: "教一101",
      teacher: "张老师",
    },
    { title: "大学英语", weekday: 3, periods: [5, 6], weeks: "1-16", location: "", teacher: "" },
    { title: "坏行", weekday: 0, periods: [] },
  ];
  const ok = await wfetch(`${await base()}/api/schedule/import/commit`, {
    method: "POST",
    body: JSON.stringify({ courses, year: 2026, semester: 3, termStart: "2026-09-07" }),
  });
  assert.equal(ok.status, 200);
  const d = await ok.json();
  assert.equal(d.count, 2);
  assert.equal(d.rejected.length, 1);
  const cached = loadScheduleCache();
  assert.equal(cached?.schedule.year, 2026);
  assert.equal(cached?.schedule.label, "2026-2027学年第一学期");
  assert.equal(cached?.schedule.courses.length, 2);
  assert.equal(manualTermStarts()["2026-2027-1"], "2026-09-07");
  // 非周一的开学日期拒收
  const bad = await wfetch(`${await base()}/api/schedule/import/commit`, {
    method: "POST",
    body: JSON.stringify({ courses: courses.slice(0, 1), termStart: "2026-09-08" }),
  });
  assert.equal(bad.status, 400);
  // 全空清单拒收
  const none = await wfetch(`${await base()}/api/schedule/import/commit`, {
    method: "POST",
    body: JSON.stringify({ courses: [] }),
  });
  assert.equal(none.status, 400);
});
