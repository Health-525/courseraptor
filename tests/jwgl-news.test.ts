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
import {
  _setPdfTextParserForTest,
  clearNewsMemo,
  fetchJwcArticle,
  fetchJwcNews,
  fetchJwcNewsDetailed,
  fetchJwcNewsMemo,
} from "../src/adapters/njtech/news";
import { deleteJsonCache, writeJsonCache } from "../src/core/json-cache";

function installFetch(respond: (url: string) => string | Buffer) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const body = respond(typeof url === "string" ? url : String(url));
    return {
      status: 200,
      ok: true,
      text: async () => (typeof body === "string" ? body : body.toString("utf8")),
      arrayBuffer: async () =>
        typeof body === "string"
          ? new TextEncoder().encode(body).buffer
          : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
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

// ── 正文内嵌 PDF（2026-09-29 发现：放假教学安排等通知正文整篇是 PDF）──
// 官网把这类通知的 v_news_content 做成 pdf.js <iframe>，HTML 里只有导航壳；
// 此前 read_notice 会把整页菜单当正文转述。钉住：下载 PDF 抽全文 + PDF 进附件。

const PDF_ARTICLE_HTML = `<html><head><title>关于2026年中秋节、国庆节放假本科教学安排的通知-南京工业大学教务处（教学评估中心）</title></head><body>
<div id="vsb_content" class="txt"><div class="v_news_content">
<p style="text-align: center;"><iframe width="1000" height="600" src="/system/resource/pdfjs/viewer.html?file=/__local/B/56/8D/68470E61DC419A135965286BD06_FD7C9A42_12F48.pdf" style="border:1px solid #DDDDDD"></iframe></p><p><br></p>
</div></div>
<div>网站地图 帮助中心 旧版入口 联系我们 教育部 江苏省教育厅</div>
</body></html>`;

test("正文内嵌 PDF 的通知：直连下载抽全文，不再把导航壳当正文", async () => {
  _setPdfTextParserForTest(async (buf) => {
    assert.equal(
      buf.subarray(0, 4).toString("latin1"),
      "%PDF",
      "传给解析器的必须是下载到的 PDF 二进制",
    );
    // 模拟 pdf-parse 真实输出：中文软换行 + 制表符 + 页标记
    return (
      "关于2026年中秋节、国庆节放假本科教学安排的通知\n" +
      "（南工教运〔2026〕02号）\n" +
      "2026年9月25日至10月7日放假\n" +
      "调休，共13天。\n\n" +
      "特此通知。\n\n-- 1 of 1 --"
    );
  });
  const restore = installFetch((url) =>
    url.includes("/__local/") ? Buffer.from("%PDF-1.7 fake-pdf-bytes") : PDF_ARTICLE_HTML,
  );
  try {
    const article = await fetchJwcArticle("https://jwc.njtech.edu.cn/info/1158/6925.htm");
    assert.match(article.title, /中秋节、国庆节放假/);
    assert.match(article.text, /9月25日至10月7日放假调休，共13天/, "软换行必须拼回连贯正文");
    assert.match(article.text, /放假调休，共13天。\n\n特此通知。/, "段落空行要保留");
    assert.doesNotMatch(article.text, /-- 1 of 1 --/, "pdf.js 页标记要清掉");
    assert.doesNotMatch(article.text, /网站地图|帮助中心/, "导航壳不能混进正文");
    const pdf = article.attachments.find((a) => a.url.includes("/__local/"));
    assert.ok(pdf, "内嵌 PDF 必须登记进附件列表");
    assert.match(pdf.name, /\.pdf$/);
    assert.equal(
      pdf.url,
      "https://jwc.njtech.edu.cn/__local/B/56/8D/68470E61DC419A135965286BD06_FD7C9A42_12F48.pdf",
      "附件 URL 必须是公网直链",
    );
  } finally {
    restore();
    _setPdfTextParserForTest(null);
  }
});

test("PDF 直连被校外拦截：附件照常登记，正文降级为页面壳文本", async () => {
  const restore = installFetch((url) =>
    url.includes("/__local/")
      ? "<html><body>本网站只能被校内IP地址访问，校外地址无法访问该网站</body></html>"
      : PDF_ARTICLE_HTML,
  );
  try {
    const article = await fetchJwcArticle("https://jwc.njtech.edu.cn/info/1158/6925.htm");
    // 直连拿不到 PDF：正文只能是页面壳（导航文本），绝不能是 PDF 内容
    assert.doesNotMatch(article.text, /放假安排正文/, "拿不到 PDF 时正文不能是 PDF 内容");
    assert.match(article.text, /网站地图/, "正文降级为页面壳文本");
    const pdf = article.attachments.find((a) => a.url.includes("/__local/"));
    assert.ok(pdf, "内嵌 PDF 仍要登记进附件列表（回校园网后可用 fetch_attachment 再取）");
  } finally {
    restore();
  }
});

// 数据目录无关紧要，但保持与其他测试一致的隔离姿势
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-jwgl-news-"));

// ── 进程内 5 分钟快照：面板与 get_news 工具共享，不双抓 ──────────
test("fetchJwcNewsMemo：TTL 内重复调用共享同一份快照（面板+工具不双抓三页）", async () => {
  clearNewsMemo();
  // 前置测试（fetchJwcArticle 系列）会顺带写盘；这里清掉，让第一次调用真联网
  deleteJsonCache("jwc-news-cache.json", "test");
  let fetches = 0;
  const restore = installFetch(() => {
    fetches += 1;
    return LIST_HTML;
  });
  try {
    const a = await fetchJwcNewsMemo(30);
    const b = await fetchJwcNewsMemo(30);
    assert.ok(a.items.length > 0);
    assert.equal(a.staleAt, undefined, "首次联网成功的新鲜结果不携带 staleAt");
    assert.equal(b.items.length, a.items.length);
    assert.equal(b.staleAt, undefined, "memo 命中同一份新鲜快照，仍不带 staleAt");
    assert.equal(fetches, 3, "三个板块只抓一轮；第二次调用应命中进程内快照");
  } finally {
    restore();
    clearNewsMemo();
    deleteJsonCache("jwc-news-cache.json", "test");
  }
});

// ── tools-cache-first 语义（2026-10）：默认走磁盘缓存不联网 ─────
// 用户明确表态「教务通知不要一直获取，有风险」。默认路径先读磁盘快照，
// 只有 forceRefresh=true 或磁盘缺失时才联网。

test("fetchJwcNewsMemo：磁盘缓存命中时零直连官网（默认路径）", async () => {
  clearNewsMemo();
  deleteJsonCache("jwc-news-cache.json", "test");
  writeJsonCache(
    "jwc-news-cache.json",
    {
      tag: "jwc-news",
      items: [
        {
          title: "磁盘上的旧通知标题",
          url: "https://jwc.njtech.edu.cn/info/1/1.htm",
          date: "2026-09-01",
        },
      ],
      fetchedAt: Date.now() - 3600_000,
    },
    "test",
  );
  let fetches = 0;
  const restore = installFetch(() => {
    fetches += 1;
    return LIST_HTML;
  });
  try {
    const r = await fetchJwcNewsMemo(30);
    assert.equal(fetches, 0, "磁盘命中路径不得发起任何 fetch");
    assert.ok(r.staleAt, "必须携带 staleAt 标记磁盘快照身份");
    assert.equal(r.items[0].title, "磁盘上的旧通知标题");
  } finally {
    restore();
    clearNewsMemo();
    deleteJsonCache("jwc-news-cache.json", "test");
  }
});

test("fetchJwcNewsMemo：forceRefresh=true 强制联网重抓三板块并覆盖磁盘", async () => {
  clearNewsMemo();
  deleteJsonCache("jwc-news-cache.json", "test");
  writeJsonCache(
    "jwc-news-cache.json",
    {
      tag: "jwc-news",
      items: [
        {
          title: "磁盘上的旧通知标题",
          url: "https://jwc.njtech.edu.cn/info/1/1.htm",
          date: "2026-09-01",
        },
      ],
      fetchedAt: Date.now() - 3600_000,
    },
    "test",
  );
  let fetches = 0;
  const restore = installFetch(() => {
    fetches += 1;
    return LIST_HTML;
  });
  try {
    const r = await fetchJwcNewsMemo(30, true);
    assert.ok(fetches >= 3, `forceRefresh 必须联网抓三板块，实际 fetches=${fetches}`);
    assert.equal(r.staleAt, undefined, "联网成功后返回新鲜结果，不带 staleAt");
    assert.ok(
      r.items.some((i) => i.title.includes("英语")),
      "抓到的新条目（LIST_HTML 里的四六级报名通知）应替换磁盘旧内容",
    );
    assert.ok(
      !r.items.some((i) => i.title === "磁盘上的旧通知标题"),
      "磁盘旧条目不该出现在联网成功后的结果里",
    );
  } finally {
    restore();
    clearNewsMemo();
    deleteJsonCache("jwc-news-cache.json", "test");
  }
});

test("fetchJwcNewsMemo：磁盘缺失时默认路径也会联网一次（首次运行）", async () => {
  clearNewsMemo();
  deleteJsonCache("jwc-news-cache.json", "test");
  let fetches = 0;
  const restore = installFetch(() => {
    fetches += 1;
    return LIST_HTML;
  });
  try {
    const r = await fetchJwcNewsMemo(30);
    assert.ok(fetches >= 3, `磁盘缺失时必须联网，实际 fetches=${fetches}`);
    assert.equal(r.staleAt, undefined, "联网成功后不带 staleAt");
  } finally {
    restore();
    clearNewsMemo();
    deleteJsonCache("jwc-news-cache.json", "test");
  }
});

// ── 直连失败 → 回退落盘缓存快照（两级阶梯的兜底）─────────────────
test("直连全部失败时回退缓存快照并带 staleAt", async () => {
  clearNewsMemo();
  writeJsonCache(
    "jwc-news-cache.json",
    {
      tag: "jwc-news",
      items: [
        {
          title: "缓存的旧通知标题",
          url: "https://jwc.njtech.edu.cn/info/1/1.htm",
          date: "2026-09-01",
        },
      ],
      fetchedAt: Date.now() - 3600_000,
    },
    "test",
  );
  const restore = installFetch(
    () => "<html><body>本网站只能被校内IP地址访问，校外地址无法访问该网站</body></html>",
  );
  try {
    const result = await fetchJwcNewsDetailed([], 30);
    assert.ok(result.staleAt, "必须带 staleAt 标记缓存快照身份");
    assert.equal(result.items[0].title, "缓存的旧通知标题");
    // 兼容契约：fetchJwcNews 失败也不抛错
    const items = await fetchJwcNews([], 30);
    assert.equal(items[0].title, "缓存的旧通知标题");
  } finally {
    restore();
    clearNewsMemo();
    deleteJsonCache("jwc-news-cache.json", "test");
  }
});

test("直连被校外拦截且无缓存可用时，如实抛出 CAMPUS_ONLY 错误", async () => {
  clearNewsMemo();
  deleteJsonCache("jwc-news-cache.json", "test");
  const restore = installFetch(
    () => "<html><body>本网站只能被校内IP地址访问，校外地址无法访问该网站</body></html>",
  );
  try {
    await assert.rejects(fetchJwcNewsDetailed([], 30), /限制校外 IP/);
  } finally {
    restore();
    clearNewsMemo();
  }
});
