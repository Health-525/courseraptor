/**
 * HEBAU 通知列表解析单测：夹具按 jiaowu.hebau.edu.cn 真实页面结构采样
 * （webplus CMS：li > a.flex > div.mtdate(span 日 + p 年月) + div.mt-r > h2.l1 标题 + p.l2 摘要）
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { parseNewsList } = await import("../src/adapters/hebau/news");

const BASE = "https://jiaowu.hebau.edu.cn/index/tzgg.htm";

/** 真实页面结构采样：mtdate 日期块 + h2.l1 标题 + p.l2 摘要 */
const REAL_LI = `<li data-aos="fade-up" id="line_u15_0">
<a href="../info/1010/2001.htm" class="flex">
    <div class="mtdate flex">
        <span>20</span>
        <p>2026.09</p>
    </div>
    <div class="mt-r flex">
        <h2 class="l1">教务处关于2025级本科生第三学期转专业名单公示</h2>
        <p class="l2">根据《河北农业大学普通本科学生学籍管理规定》……名单详见附件。</p>
    </div>
</a>
</li>`;

test("真实结构：mtdate 日期块归一为 YYYY-MM-DD，标题取自 h2 元素", () => {
  const items = parseNewsList(REAL_LI, BASE);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "教务处关于2025级本科生第三学期转专业名单公示");
  assert.equal(items[0].date, "2026-09-20");
  assert.equal(items[0].url, "https://jiaowu.hebau.edu.cn/info/1010/2001.htm");
  // 摘要不得混进标题
  assert.doesNotMatch(items[0].title, /名单详见附件/);
});

test("退化路径：无标题元素时取锚文本并剥离开头混入的日期片段", () => {
  const legacy = `<li>
<a href="/info/1011/1234.htm" class="flex">5 2026.09 关于召开教学工作会议的通知</a>
</li>`;
  const items = parseNewsList(legacy, BASE);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "关于召开教学工作会议的通知");
  assert.equal(items[0].date, "2026-09-05");
});

test("过滤：栏目/导航链接与过短标题不入列，同 URL 去重", () => {
  const html = `<ul class="my-list">
<li><a href="/index/jwdt.htm" class="flex"><h2 class="l1">教务动态栏目页</h2></a></li>
<li><a href="/info/1010/1111.htm" class="flex"><h2 class="l1">公示</h2></a></li>
<li><a href="/info/1010/2222.htm" class="flex"><h2 class="l1">关于开展2026年教学质量评估工作的通知</h2></a></li>
<li><a href="/info/1010/2222.htm" class="flex"><h2 class="l1">关于开展2026年教学质量评估工作的通知（重复条目）</h2></a></li>
</ul>`;
  const items = parseNewsList(html, BASE);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "关于开展2026年教学质量评估工作的通知");
});

test("受限文章：article.jsp 动态入口标记 restricted", () => {
  const html = `<li><a href="/article.jsp?urltype=news.NewsContentUrl&wbnewsid=999" class="flex">
<h2 class="l1">某篇设置了浏览权限的通知公告</h2></a></li>`;
  const items = parseNewsList(html, BASE);
  assert.equal(items.length, 1);
  assert.equal(items[0].restricted, true);
});
