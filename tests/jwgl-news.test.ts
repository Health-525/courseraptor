/**
 * 教务处通知爬虫测试（jwgl/news）
 *
 * 钉住 2026-09 实测发现的一类真实链接：官网对部分通知（违纪通报、推免
 * 名单公示）设置了浏览权限，列表里只给 article.jsp 动态入口，匿名打开
 * 原文一律 302 到 auth.htm「您无权访问此页面」。此前前端点「原文」直接
 * 撞鉴权页被当成故障上报，read_notice 还会把鉴权提示当正文转述。
 * global fetch 进程内替身（直连统一走 core/http 的 fetchUrlText），不联网。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fetchJwcArticle, fetchJwcNews } from "../src/adapters/njtech/news";

function installFetch(respond: (url: string) => string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const body = respond(typeof url === "string" ? url : String(url));
    return { status: 200, ok: true, text: async () => body };
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const LIST_HTML = `<ul class="my-list">
<li><a href="../info/1157/6912.htm">关于2026年下半年全国大学英语四、六级考试报名的通知</a><span class="date">2026-09-16</span></li>
<li><a href="../article.jsp?urltype=news.NewsContentUrl&wbtreeid=1157&wbnewsid=6928">2026-2027学年第1学期学生考试违规情况通报(第2号)</a><span class="date">2026-09-15</span></li>
</ul>`;

test("article.jsp 动态链接标 restricted，静态 info 链接不标", async () => {
  const restore = installFetch(() => LIST_HTML);
  try {
    const items = await fetchJwcNews([], 30);
    assert.ok(items.length >= 2, `应当解析出列表条目，实际 ${items.length}`);
    const restricted = items.find((i) => i.url.includes("article.jsp"));
    assert.ok(restricted, "article.jsp 条目必须在列表里");
    assert.equal(restricted.restricted, true, "article.jsp 条目必须标 restricted");
    assert.equal(
      restricted.url,
      "https://jwc.njtech.edu.cn/article.jsp?urltype=news.NewsContentUrl&wbtreeid=1157&wbnewsid=6928",
      "相对链接要按列表页地址拼全",
    );
    const normal = items.find((i) => i.url.endsWith("/info/1157/6912.htm"));
    assert.ok(normal, "静态 info 条目必须在列表里");
    assert.notEqual(normal.restricted, true, "静态条目不应被误标");
  } finally {
    restore();
  }
});

test("鉴权提示页不再伪装成正文：fetchJwcArticle 抛出明确的权限错误", async () => {
  const restore = installFetch(
    () => "<html><body>系统提示 抱歉 可能是由下列问题导致的： 您无权访问此页面</body></html>",
  );
  try {
    await assert.rejects(
      fetchJwcArticle("https://jwc.njtech.edu.cn/article.jsp?urltype=news.NewsContentUrl"),
      /访问权限/,
    );
  } finally {
    restore();
  }
});

test("正常文章页照常解析：标题截尾、正文提取、附件识别", async () => {
  const ARTICLE_HTML = `<html><head><title>关于开展选课的通知-南京工业大学教务处</title></head><body>
<div class="v_news_content"><p>2026-2027学年第一学期选课分两轮进行，请各位同学在规定时间内完成选课操作。</p></div>
<li>附件【<a href="/system/_content/download.jsp?uuid=abc">选课时间表.xlsx</a>】</li>
</body></html>`;
  const restore = installFetch(() => ARTICLE_HTML);
  try {
    const article = await fetchJwcArticle("https://jwc.njtech.edu.cn/info/1157/6912.htm");
    assert.equal(article.title, "关于开展选课的通知");
    assert.match(article.text, /选课分两轮/);
    assert.equal(article.attachments.length, 1);
    assert.equal(article.attachments[0].name, "选课时间表.xlsx");
  } finally {
    restore();
  }
});

// 数据目录无关紧要，但保持与其他测试一致的隔离姿势
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-jwgl-news-"));
