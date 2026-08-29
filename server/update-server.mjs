#!/usr/bin/env node
/**
 * CourseRaptor 更新分发后台 —— 零依赖单文件，node 直接跑。
 *
 *   UPDATE_ADMIN_TOKEN=你的发布密钥 PORT=8787 node server/update-server.mjs
 *   （建议配 pm2 常驻：pm2 start server/update-server.mjs --name raptor-update）
 *
 * 接口：
 *   POST /publish   发布新版：raw zip 包体 + 头 x-admin-token / x-version /
 *                   x-notes（encodeURIComponent 过的更新说明）。覆盖旧版。
 *   GET  /latest    {"version","notes","publishedAt","download"}
 *   GET  /download  最新版 zip 包（客户端 /update 和浏览器下载共用）
 *   GET  /          同学侧落地页：下载链接 + 安装三步说明
 *
 * 数据落盘在 update-data/（meta.json + 版本 zip），记得进 .gitignore、
 * 备份好这个目录——丢了同学端就查不到更新了。
 */

import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "..", "update-data");
const META_FILE = path.join(DATA_DIR, "meta.json");
const MAX_BODY = 200 * 1024 * 1024; // 200MB，防手滑传错东西撑爆磁盘

const PORT = Number(process.env.PORT) || 8787;
const ADMIN_TOKEN = process.env.UPDATE_ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  console.error("缺少 UPDATE_ADMIN_TOKEN 环境变量（发布接口的密钥）。");
  console.error("用法：UPDATE_ADMIN_TOKEN=xxx node server/update-server.mjs");
  process.exit(1);
}
mkdirSync(DATA_DIR, { recursive: true });

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const zipPath = (version) => path.join(DATA_DIR, `courseraptor-v${version}.zip`);

async function readMeta() {
  try {
    return JSON.parse(await readFile(META_FILE, "utf8"));
  } catch {
    return null; // 还没发过版
  }
}

function tokenOk(token) {
  const a = createHash("sha256").update(String(token)).digest();
  const b = createHash("sha256").update(ADMIN_TOKEN).digest();
  return a.equals(b);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const LANDING_HTML = (meta) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CourseRaptor 下载</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.7;color:#222}
  .btn{display:inline-block;background:#2563eb;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-size:16px}
  code{background:#f2f2f2;padding:1px 6px;border-radius:4px}
  .ver{color:#666}
</style></head><body>
<h1>🦖 CourseRaptor</h1>
<p>NJTECH 教务对话式 Agent：课表 · 成绩 · 考试 · 选课，一句话搞定。</p>
${
  meta
    ? `<p><a class="btn" href="/download">⬇️ 下载最新版 v${meta.version}</a></p>
<p class="ver">发布于 ${meta.publishedAt}${meta.notes ? ` · 更新说明：${meta.notes}` : ""}</p>
<h3>安装（三步）</h3>
<ol>
  <li>先装 <a href="https://nodejs.org/zh-cn">Node.js</a>（LTS 版，装过可跳过）</li>
  <li>解压下载的 zip，双击里面的 <code>start.bat</code>（首次会自动装依赖）</li>
  <li>按提示登录教务账号、填 DeepSeek Key，开聊</li>
</ol>
<h3>更新</h3>
<p>程序启动时自动提示新版本，对话里输入 <code>/update</code> 一键更新；本页也可随时重新下载。</p>`
    : `<p>后台已启动，还没发布过版本。</p>`
}
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "POST" && url.pathname === "/publish") {
      const token = req.headers["x-admin-token"] ?? url.searchParams.get("token") ?? "";
      if (!tokenOk(token)) return sendJson(res, 401, { error: "token 无效" });
      const version = String(req.headers["x-version"] ?? "");
      if (!SEMVER_RE.test(version)) return sendJson(res, 400, { error: "x-version 必须是 x.y.z" });
      const notes = decodeURIComponent(String(req.headers["x-notes"] ?? ""));
      const body = await readBody(req);
      if (!body.length) return sendJson(res, 400, { error: "zip 包体为空" });

      // 先落临时文件再原子改名，发布中断不会留下半包
      const tmp = `${zipPath(version)}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, zipPath(version));
      const meta = { version, notes, publishedAt: new Date().toISOString() };
      await writeFile(META_FILE, JSON.stringify(meta, null, 2));
      return sendJson(res, 200, { ok: true, ...meta });
    }

    if (req.method === "GET" && url.pathname === "/latest") {
      const meta = await readMeta();
      if (!meta) return sendJson(res, 404, { error: "还没有发布过版本" });
      return sendJson(res, 200, { ...meta, download: "/download" });
    }

    if (req.method === "GET" && url.pathname === "/download") {
      const meta = await readMeta();
      if (!meta || !existsSync(zipPath(meta.version))) {
        return sendJson(res, 404, { error: "还没有发布过版本" });
      }
      const size = (await stat(zipPath(meta.version))).size;
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-length": size,
        "content-disposition": `attachment; filename="courseraptor-v${meta.version}.zip"`,
      });
      return createReadStream(zipPath(meta.version)).pipe(res);
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(LANDING_HTML(await readMeta()));
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`✅ 更新后台已启动：http://localhost:${PORT}`);
  console.log(`   落地页   GET  /`);
  console.log(`   查版本   GET  /latest`);
  console.log(`   下载包   GET  /download`);
  console.log(`   发新版   POST /publish  （x-admin-token + x-version + zip 包体）`);
});
