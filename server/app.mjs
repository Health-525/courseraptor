import { createHash } from "node:crypto";
import http from "node:http";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_PACKAGE_BODY = 200 * 1024 * 1024;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest();
}

function tokenOk(actual, expected) {
  return hashToken(actual).equals(hashToken(expected));
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content);
  await rename(temp, file);
}

function requireAdmin(req, res, adminToken) {
  const token = req.headers["x-admin-token"];
  if (typeof token !== "string" || !tokenOk(token, adminToken)) {
    sendJson(res, 401, { error: "管理员密钥无效" });
    return false;
  }
  return true;
}

const landingHtml = (meta) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CourseRaptor 下载</title><style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.7;color:#222}
code{background:#f2f2f2;padding:1px 6px;border-radius:4px}.ver{color:#666}
</style></head><body><h1>🦖 CourseRaptor</h1>
<p>NJTECH 教务对话式 Agent：课表 · 成绩 · 考试 · 选课，一句话搞定。</p>
${meta ? `<p class="ver">当前版本：v${meta.version} · 发布于 ${meta.publishedAt}</p>${meta.notes ? `<p>更新说明：${meta.notes.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>` : ""}` : "<p>后台已启动，还没发布过版本。</p>"}
<h3>安装</h3><ol><li>下载并解压安装包。</li><li>双击 <code>start.bat</code>。</li><li>按提示配置自己的 API Key 与教务账号。</li></ol>
<p>启动后会自动检查新版本；对话中输入 <code>/update</code> 可下载并安装更新。</p>
</body></html>`;

/** 创建可测试、可嵌入的更新 HTTP 服务。 */
export function createUpdateServer({
  dataDir = path.join(ROOT, "..", "update-data"),
  adminToken,
} = {}) {
  if (!adminToken) throw new Error("缺少 UPDATE_ADMIN_TOKEN");
  mkdirSync(dataDir, { recursive: true });
  const metaFile = path.join(dataDir, "meta.json");
  const zipPath = (version) => path.join(dataDir, `courseraptor-v${version}.zip`);

  async function readMeta() {
    try {
      return JSON.parse(await readFile(metaFile, "utf8"));
    } catch {
      return null;
    }
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    try {
      if (req.method === "POST" && url.pathname === "/publish") {
        if (!requireAdmin(req, res, adminToken)) return;
        const version = String(req.headers["x-version"] ?? "");
        if (!SEMVER_RE.test(version)) return sendJson(res, 400, { error: "x-version 必须是 x.y.z" });
        let notes = "";
        try {
          notes = decodeURIComponent(String(req.headers["x-notes"] ?? ""));
        } catch {
          return sendJson(res, 400, { error: "x-notes 编码不正确" });
        }
        if (notes.length > 2000) return sendJson(res, 400, { error: "更新说明不能超过 2000 个字符" });
        const body = await readBody(req, MAX_PACKAGE_BODY);
        if (!body.length) return sendJson(res, 400, { error: "zip 包体为空" });
        await writeAtomic(zipPath(version), body);
        const meta = { version, notes, publishedAt: new Date().toISOString() };
        await writeAtomic(metaFile, JSON.stringify(meta, null, 2));
        return sendJson(res, 200, { ok: true, ...meta });
      }

      if (req.method === "GET" && url.pathname === "/latest") {
        const meta = await readMeta();
        if (!meta) return sendJson(res, 404, { error: "还没有发布过版本" });
        return sendJson(res, 200, { ...meta, download: "/download" });
      }

      if (req.method === "GET" && url.pathname === "/download") {
        const meta = await readMeta();
        if (!meta || !existsSync(zipPath(meta.version))) return sendJson(res, 404, { error: "还没有发布过版本" });
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
        return res.end(landingHtml(await readMeta()));
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error("[server]", error);
      return sendJson(res, 500, { error: "服务器内部错误" });
    }
  });
}
