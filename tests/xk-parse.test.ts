/**
 * 选课解析测试 —— 用 fixture 钉住线上行为
 *
 * 这组测试存在的直接原因：项目曾经零测试，导致「PartDisplay 到底走 JSON
 * 还是 HTML 路径」「网课 unlimited 判定两条路径是否一致」这类问题没人能回答。
 * 解析函数是纯函数，钉住它们之后，教务系统改版时测试先挂、而不是用户拿到空列表。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCourseListForm,
  isSessionExpired,
  matchTargets,
  parseCourseList,
  parseCoursePage,
  parseCourseRowsFromHtml,
  parseXkStatus,
  type XkRound,
  type XkSession,
} from "../src/jwgl/xk";

// ── parseCourseList（JSON 路径）──────────────────────────────

test("parseCourseList: 标准教学班字段（yxzrs/jxbrl/syrl）", () => {
  const fixture = {
    tmpList: [
      {
        jxb_id: "JXB001",
        kch: "080101X",
        kcmc: "操作系统原理",
        jsxx: "张涵",
        jxbxf: "4",
        yxzrs: "118",
        jxbrl: "120",
        jg0xxrs: "2",
      },
    ],
  };
  const [c] = parseCourseList(fixture);
  assert.equal(c.jxbId, "JXB001");
  assert.equal(c.courseCode, "080101X");
  assert.equal(c.courseName, "操作系统原理");
  assert.equal(c.teacher, "张涵");
  assert.equal(c.credit, "4");
  assert.equal(c.capacity, 120);
  assert.equal(c.selected, 118);
  assert.equal(c.remain, 2);
  assert.equal(c.unlimited, false);
});

test("parseCourseList: 无容量字段的网课 → unlimited，remain 恒为正", () => {
  // 真实线上结构（PartDisplay 平铺）：只有 jxb_id/kcmc/kch/jxbxf/kzmc
  const fixture = {
    tmpList: [
      {
        jxb_id: "JXB_NET_1",
        kch: "T901001",
        kcmc: "创造性思维与创新方法(Triz版)",
        jxbxf: "2",
        kzmc: "创新创业类",
      },
    ],
  };
  const [c] = parseCourseList(fixture);
  assert.equal(c.unlimited, true);
  assert.equal(c.remain, 9999);
  assert.equal(c.category, "创新创业类");
});

test("parseCourseList: 嵌套结构（jxb/kkxx）合并取值", () => {
  const fixture = {
    tmpList: [
      {
        kkxx: { kcmc: "大学体育一", kch: "PE101" },
        jxb: { jxb_id: "JXB_PE", jxbxf: "1", jxbrl: "40", yxzrs: "10" },
      },
    ],
  };
  const [c] = parseCourseList(fixture);
  assert.equal(c.courseName, "大学体育一");
  assert.equal(c.jxbId, "JXB_PE");
  assert.equal(c.remain, 30);
});

test("parseCourseList: 容量已选都有但缺 remain 字段 → 容量-已选兜底", () => {
  const fixture = {
    tmpList: [{ jxb_id: "A", kcmc: "X", jxbrl: "50", yxzrs: "50" }],
  };
  const [c] = parseCourseList(fixture);
  assert.equal(c.remain, 0);
  assert.equal(c.unlimited, false);
});

test("parseCourseList: 非对象/空列表返回空数组", () => {
  assert.deepEqual(parseCourseList(null), []);
  assert.deepEqual(parseCourseList({}), []);
  assert.deepEqual(parseCourseList({ tmpList: [] }), []);
});

// ── parseCourseRowsFromHtml（HTML 路径）──────────────────────

const HTML_FIXTURE = `
<div>noise before first panel</div>
<div class="panel-info">
  <span title="中国人文经典（中华诗词之美）" class="kcmc">课程名</span>
  <td class="kch_id" style="display:none">T802001</td>
  <a class="btn-xk-ABC123DEF">选课</a>
  <font class="jxbrs">35</font> / <font class="jxbrl">40</font>
</div>
<div class="panel-info">
  <span title="尔雅网课·无容量" class="kcmc">x</span>
  <td class="kch_id">T802002</td>
  <a class="btn-xk-XYZ789">选课</a>
</div>
`;

test("parseCourseRowsFromHtml: 有容量字段的教学班正常解析", () => {
  const courses = parseCourseRowsFromHtml(HTML_FIXTURE);
  assert.equal(courses.length, 2);
  const [first] = courses;
  assert.equal(first.courseCode, "T802001");
  assert.equal(first.courseName, "中国人文经典（中华诗词之美）");
  assert.equal(first.jxbId, "ABC123DEF");
  assert.equal(first.capacity, 40);
  assert.equal(first.selected, 35);
  assert.equal(first.remain, 5);
  assert.equal(first.unlimited, false);
});

test("parseCourseRowsFromHtml: 网课与 JSON 路径同一套 unlimited 判定（曾经的语义分裂）", () => {
  // 回归：这条路径之前漏了 unlimited，网课 capacity=0 → remain=0 → 永远抢不到。
  // 两条路径不一致且无人知道哪条在跑，是零 fixture 时期的真实代价。
  const courses = parseCourseRowsFromHtml(HTML_FIXTURE);
  const netCourse = courses[1];
  assert.equal(netCourse.courseCode, "T802002");
  assert.equal(netCourse.unlimited, true);
  assert.equal(netCourse.remain, 9999);
});

// ── parseCoursePage：路径判定 ─────────────────────────────────

test("parseCoursePage: JSON 响应走 json 路径", () => {
  const { via, courses } = parseCoursePage('{"tmpList":[{"jxb_id":"A","kcmc":"课"}]}');
  assert.equal(via, "json");
  assert.equal(courses.length, 1);
});

test("parseCoursePage: 非 JSON 响应回退 html 路径", () => {
  const { via } = parseCoursePage(HTML_FIXTURE);
  assert.equal(via, "html");
});

// ── check_selection_status 探针回归（P0）─────────────────────

function fakeSession(round: Partial<XkRound>): XkSession {
  return {
    client: {} as XkSession["client"],
    cookie: "",
    xkkzId: "R1_ID",
    xkkzXh: "R1_XH",
    rounds: [
      {
        kklxdm: "01",
        tabName: "主修课程",
        xkkzId: "R1_ID",
        njdm: "2023",
        zyh: "0811",
        xh: "R1_XH",
        ...round,
      },
    ],
    studentParams: { jg_id: "123" },
    isXkOpen: true,
    csrftoken: "CSRF",
    username: "202321144057",
  };
}

test("探针回归: 课程查询表单必须携带 xkkz_xh 加密串", () => {
  // P0 复现：check_selection_status 的探针曾长期缺 xkkz_xh，导致服务端
  // 必然回「加密串错误」，courseQueryBlocked 恒为 true——自检工具系统性说谎。
  // 表单构造收敛到 buildCourseListForm 一处后，这条测试钉住它不再漂移。
  const form = buildCourseListForm(fakeSession({}), fakeSession({}).rounds[0]);
  assert.equal(form.xkkz_xh, "R1_XH");
  assert.equal(form.xkkz_id, "R1_ID");
  assert.equal(form.csrftoken, "CSRF");
});

test("探针回归: 表单携带 Display 隐藏字段与学生维度字段", () => {
  const session = fakeSession({
    displayParams: { rwlx: "01", sfkxk: "1" },
  });
  const form = buildCourseListForm(session, session.rounds[0], "羽毛球");
  assert.equal(form.rwlx, "01");
  assert.equal(form.sfkxk, "1");
  assert.equal(form.jg_id, "123");
  assert.equal(form.kcmc, "羽毛球");
  // 分页默认首屏 100 行
  assert.equal(form.kspage, "1");
  assert.equal(form.jspage, "100");
});

// ── parseXkStatus / isSessionExpired / matchTargets ──────────

test("parseXkStatus: iskxk=1 且下发 firstXkkzId", () => {
  const html = `<input id="iskxk" type="hidden" value="1"/>
                <input id="firstXkkzId" type="hidden" value="ABC"/>`;
  assert.deepEqual(parseXkStatus(html), { isXkOpen: true, xkkzId: "ABC" });
});

test("parseXkStatus: 选课未开放时 xkkzId 为 null", () => {
  const html = `<input id="iskxk" type="hidden" value="0"/>`;
  assert.deepEqual(parseXkStatus(html), { isXkOpen: false, xkkzId: null });
  assert.deepEqual(parseXkStatus(""), { isXkOpen: false, xkkzId: null });
});

test("isSessionExpired: 登录页特征识别", () => {
  assert.equal(isSessionExpired("/xtgl/login_slogin.html"), true);
  assert.equal(isSessionExpired("请登录 用户登录"), true);
  assert.equal(isSessionExpired('{"flag":1,"tmpList":[]}'), false);
  assert.equal(isSessionExpired(""), false);
});

test("matchTargets: 课程名包含即命中，教师名可选过滤", () => {
  const c = { courseName: "创造性思维与创新方法(Triz版)", teacher: "李四" } as never;
  assert.equal(matchTargets(c, [{ courseName: "创新方法" }]), true);
  assert.equal(matchTargets(c, [{ courseName: "创新方法", teacher: "张三" }]), false);
  assert.equal(matchTargets(c, [{ courseName: "不存在" }]), false);
  assert.equal(matchTargets(c, [{ courseName: "" }]), false);
});
