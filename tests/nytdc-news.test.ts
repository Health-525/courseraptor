/**
 * NYTDC 教务处通知解析纯函数单测（离线，用实机抓取的版式片段做样本）
 *
 * 版式样本取自 jwc.nytdc.edu.cn 的真实页面（2026-10 抓取）：
 * 列表页 li.news 结构、文章页 arti_title / wp_articlecontent / _upload 附件。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { parseNewsList, htmlToText, extractDivBlock, extractAttachments, isJwcUrl } = await import(
  "../src/adapters/nytdc/news"
);

const LIST_HTML = `
<ul class="news_list list2">
  <li class="news n1 clearfix">
    <span class="news_title"><a href='/2026/0923/c308a51277/page.htm' target='_blank' title='南京邮电大学通达学院关于做好2026-2027-1学期普通话水平等级测试正式报名工作的通知'>南京邮电大学通达学院关于做好2026-2027-1学期普通话水平等级测试正式报名工作的通知</a></span>
    <span class="news_meta">2026-09-23</span>
  </li>
  <li class="news n2 clearfix">
    <span class="news_title"><a href='/2026/0916/c308a51229/page.htm' target='_blank' title='关于2026年9月申请毕（结）业的通知'>关于2026年9月申请毕（结）业的通知</a></span>
    <span class="news_meta">2026-09-16</span>
  </li>
  <li class="news n3 clearfix">
    <span class="news_title"><a href='https://jwc.nytdc.edu.cn/2026/0914/c308a51214/page.htm'>外链形态也认</a></span>
    <span class="news_meta">2026-09-14</span>
  </li>
  <li class="news n4 clearfix">
    <span class="news_title"><a href='https://www.baidu.com/evil.htm' title='站外链接必须丢弃'>站外</a></span>
    <span class="news_meta">2026-09-01</span>
  </li>
</ul>`;

test("parseNewsList：抽标题/链接/日期，站外链接丢弃", () => {
  const items = parseNewsList(LIST_HTML, "通知公告");
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    title: "南京邮电大学通达学院关于做好2026-2027-1学期普通话水平等级测试正式报名工作的通知",
    url: "https://jwc.nytdc.edu.cn/2026/0923/c308a51277/page.htm",
    date: "2026-09-23",
    category: "通知公告",
  });
  // 绝对 URL 形态同样规范成绝对地址
  assert.equal(items[2].url, "https://jwc.nytdc.edu.cn/2026/0914/c308a51214/page.htm");
  // 站外域名被过滤
  assert.ok(!items.some((i) => i.url.includes("baidu.com")));
});

test("parseNewsList：空页/无关 HTML 返回空数组，不抛错", () => {
  assert.deepEqual(parseNewsList("", "通知公告"), []);
  assert.deepEqual(parseNewsList("<html><body>没有列表</body></html>", "通知公告"), []);
});

test("htmlToText：剥 script/style，段落换行，实体解码", () => {
  const html =
    '<style type="text/css">p{color:red}</style><p>各教学单位：</p><p>放假&nbsp;13&nbsp;天</p><script>var a=1;</script>';
  const text = htmlToText(html);
  assert.ok(!text.includes("color:red"));
  assert.ok(!text.includes("var a=1"));
  assert.match(text, /各教学单位：/);
  assert.match(text, /放假 13 天/);
  assert.ok(text.includes("\n"));
});

test("extractDivBlock：嵌套 div 配对计数，不在第一个 </div> 截断", () => {
  const html =
    '<div class="wp_articlecontent"><p>外层</p><div><p>内层</p></div><p>结尾</p></div><div>之后的</div>';
  const inner = extractDivBlock(html, /<div[^>]*class="[^"]*wp_articlecontent[^"]*"[^>]*>/i);
  assert.ok(inner);
  assert.match(inner, /外层/);
  assert.match(inner, /内层/);
  assert.match(inner, /结尾/);
  assert.ok(!inner.includes("之后的"));
});

test("extractAttachments：抓 _upload 附件、按链接去重、保留文件名", () => {
  const html = `
    <div class="wp_articlecontent">
      <p><a href="/_upload/article/files/c8/38/9135c0ba45a5894e5e13dc6bc91d/33965844-06ee-4fea-8f5c-e4eb5541dc31.xlsx">附件1普通话预报名成功名单.xlsx</a></p>
      <p><a href="/_upload/article/files/c8/38/9135c0ba45a5894e5e13dc6bc91d/b4c641ca-44a5-4175-af09-966055c3fee0.docx">附件2普通话等级测试报名及缴费流程.docx</a></p>
      <p><a href="/_upload/article/files/c8/38/9135c0ba45a5894e5e13dc6bc91d/33965844-06ee-4fea-8f5c-e4eb5541dc31.xlsx">附件1普通话预报名成功名单.xlsx</a></p>
      <p><a href="/_upload/tpl/00/0a/10/template10/style.css">样式</a></p>
      <p><a href="https://www.nytdc.edu.cn/jwc.htm">普通链接</a></p>
    </div>`;
  const files = extractAttachments(html);
  assert.equal(files.length, 2);
  assert.equal(files[0].name, "附件1普通话预报名成功名单.xlsx");
  assert.equal(
    files[0].url,
    "https://jwc.nytdc.edu.cn/_upload/article/files/c8/38/9135c0ba45a5894e5e13dc6bc91d/33965844-06ee-4fea-8f5c-e4eb5541dc31.xlsx",
  );
  assert.ok(files[1].name.endsWith(".docx"));
});

test("isJwcUrl：只认 nytdc.edu.cn 及其子域", () => {
  assert.equal(isJwcUrl("https://jwc.nytdc.edu.cn/2026/0923/c308a51277/page.htm"), true);
  assert.equal(isJwcUrl("https://www.nytdc.edu.cn/jcjxb/1234/list.htm"), true);
  assert.equal(isJwcUrl("https://nytdc.edu.cn/x.htm"), true);
  // 后缀相似但不同域名的必须拒掉（防钓鱼站）
  assert.equal(isJwcUrl("https://nytdc.edu.cn.evil.com/x.htm"), false);
  assert.equal(isJwcUrl("http://127.0.0.1/x.htm"), false);
  assert.equal(isJwcUrl("不是链接"), false);
});
