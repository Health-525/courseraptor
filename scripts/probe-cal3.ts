import https from "https";
import { getCookie } from "../src/tools/session";
import { createClientWithCookie } from "../src/jwgl/http";
import { BASE } from "../src/jwgl/auth";
import { fetchJwcNews } from "../src/jwgl/news";

function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 && res.headers.location) {
        return get(new URL(res.headers.location, url).href).then(resolve).catch(reject);
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}
const strip = (h: string) =>
  h.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
   .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

// 1. 学校主页搜校历
try {
  const home = await get("https://www.njtech.edu.cn/");
  const hits = [...home.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]*校历[^<]*)<\/a>/gi)];
  console.log(`学校主页校历链接 ${hits.length} 个`);
  for (const h of hits) console.log(`  ${h[2].trim()} -> ${new URL(h[1], "https://www.njtech.edu.cn/").href}`);
} catch (e) { console.log("学校主页失败:", (e as Error).message); }

// 2. 选课总纲通知正文
const items = await fetchJwcNews([], 30);
const main = items.find((i) => /本科生选课通知|选课通知（|选课工作/.test(i.title));
if (main) {
  console.log(`\n通知：${main.title}`);
  const text = strip(await get(main.url));
  const sents = text.split(/(?<=[。；;])/).filter((s) => /开学|注册|报到|9月\d+日|上课时间/.test(s));
  for (const s of sents.slice(0, 10)) console.log(`  · ${s.trim().slice(0, 110)}`);
}

// 3. 教务系统登录后主页菜单搜「校历」
const cookie = await getCookie();
const client = createClientWithCookie(BASE, cookie);
for (const path of ["/index.jsp", "/framework/xsMainIndex.html", "/main.html"]) {
  try {
    const r = await client.req(path, { method: "GET" });
    if (r.body && /校历/.test(r.body)) {
      console.log(`\n${path} 含「校历」，上下文：`);
      const idx = r.body.indexOf("校历");
      console.log("  " + strip(r.body.slice(Math.max(0, idx - 400), idx + 200)).slice(0, 300));
    } else {
      console.log(`\n${path}: ${r.body?.length ?? 0} 字节，无「校历」`);
    }
  } catch (e) { console.log(`${path} 失败: ${(e as Error).message.slice(0, 60)}`); }
}
