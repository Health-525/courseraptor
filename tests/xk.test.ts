/**
 * 选课模块纯函数测试
 *
 * 背景：早期协议实测确认的响应形状此前没有 fixture 钉住——parseCourseList
 * 不认 jxbmc（教学班名称），旧版平铺行的课程名会解析成空串、目标匹配全部
 * 落空。这里用实测形状 + 本项目校准过的形状双轨钉住。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { parseCourseList, parseChoosedList } = await import("../src/adapters/njtech/xk");

test("parseCourseList：jxbmc 平铺行（协议实测的 PartDisplay 形状）", () => {
  const courses = parseCourseList({
    tmpList: [
      {
        jxbmc: "大学物理(上)-2024级化工1班",
        kzmc: "自然类",
        xf: "3",
        yxzrs: "95",
        kch_id: "WLGX1001",
        do_jxb_id: "JXB2024001",
      },
    ],
  });
  assert.equal(courses.length, 1);
  const c = courses[0];
  // jxbmc 兜底之前这里会是空串，课程名匹配全落空
  assert.equal(c.courseName, "大学物理(上)-2024级化工1班");
  assert.equal(c.courseCode, "WLGX1001");
  assert.equal(c.jxbId, "JXB2024001");
  assert.equal(c.selected, 95);
  assert.equal(c.category, "自然类");
  assert.equal(c.credit, "3");
});

test("parseCourseList：kcmc 优先于 jxbmc（新版嵌套结构两者并存时取纯课程名）", () => {
  const courses = parseCourseList({
    tmpList: [
      {
        jxb: { jxb_id: "JXB1", jxbmc: "操作系统-01班" },
        kkxx: { kch: "CS100", kcmc: "操作系统" },
      },
    ],
  });
  assert.equal(courses[0].courseName, "操作系统");
});

test("parseChoosedList：裸数组 + do_jxb_id（退课 key 直接可用）", () => {
  const list = parseChoosedList([
    { jxbmc: "羽毛球-周三班", kch_id: "TY1002", do_jxb_id: "JXB009" },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].courseName, "羽毛球-周三班");
  assert.equal(list[0].courseCode, "TY1002");
  assert.equal(list[0].jxbId, "JXB009");
});

test("parseChoosedList：tmpList 包装 + 无教学班 ID（需教学班列表补齐）", () => {
  const list = parseChoosedList({
    tmpList: [{ jxbmc: "创新思维", kch_id: "CX101" }],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].courseName, "创新思维");
  assert.equal(list[0].jxbId, "");
});

test("parseChoosedList：非列表输入返回空", () => {
  assert.deepEqual(parseChoosedList(null), []);
  assert.deepEqual(parseChoosedList("nope"), []);
  assert.deepEqual(parseChoosedList({ foo: 1 }), []);
});
