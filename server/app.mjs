import http from "node:http";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LicenseStoreError, createLicenseStore } from "./license-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_PACKAGE_BODY = 200 * 1024 * 1024;
const MAX_JSON_BODY = 16 * 1024;
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

async function readJson(req) {
  const body = await readBody(req, MAX_JSON_BODY);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new LicenseStoreError("invalid_request", "请求 JSON 格式不正确");
  }
}

async function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content);
  await rename(temp, file);
}

function apiError(res, error) {
  if (error instanceof LicenseStoreError) {
    const status =
      error.code === "unauthorized"
        ? 401
        : error.code === "device_mismatch"
          ? 409
          : error.code === "invalid_key" || error.code === "invalid_device" || error.code === "invalid_request"
            ? 400
            : 403;
    return sendJson(res, status, { error: error.message, code: error.code });
  }
  console.error("[server]", error);
  return sendJson(res, 500, { error: "服务器内部错误" });
}

function requireAdmin(req, res, adminToken) {
  const token = req.headers["x-admin-token"];
  if (typeof token !== "string" || !tokenOk(token, adminToken)) {
    sendJson(res, 401, { error: "管理员密钥无效" });
    return false;
  }
  return true;
}

function requireLicense(req, store) {
  const licenseKey = req.headers["x-license-key"];
  const deviceId = req.headers["x-device-id"];
  if (typeof licenseKey !== "string" || typeof deviceId !== "string") {
    throw new LicenseStoreError("unauthorized", "下载需要激活密钥和设备标识");
  }
  return store.check({ licenseKey, deviceId });
}

const landingHtml = (meta) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CourseRaptor 下载</title><style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.7;color:#222}
code{background:#f2f2f2;padding:1px 6px;border-radius:4px}.ver{color:#666}
</style></head><body><h1>🦖 CourseRaptor</h1>
<p>NJTECH 教务对话式 Agent：课表 · 成绩 · 考试 · 选课，一句话搞定。</p>
${meta ? `<p class="ver">当前版本：v${meta.version} · 发布于 ${meta.publishedAt}</p>${meta.notes ? `<p>更新说明：${meta.notes.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>` : ""}` : "<p>后台已启动，还没发布过版本。</p>"}
<h3>安装与激活</h3><ol><li>向维护者获取安装包和个人激活密钥。</li><li>解压并双击 <code>start.bat</code>。</li><li>首次启动输入密钥；密钥会绑定这台电脑。</li></ol>
<p>已激活的客户端会自动检查新版本；对话中输入 <code>/update</code> 可下载并安装更新。</p>
</body></html>`;

const adminHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CourseRaptor 授权管理</title><style>
body{font-family:system-ui,sans-serif;max-width:1080px;margin:32px auto;padding:0 16px;color:#222}input,button{font:inherit;padding:8px;margin:4px}button{cursor:pointer}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left;word-break:break-all}.error{color:#b91c1c}.key{font-family:ui-monospace,monospace;font-weight:700;color:#166534}
</style></head><body><h1>🦖 CourseRaptor 授权管理</h1><p>管理员密钥仅保存在当前浏览器标签页，刷新后需要重新输入。</p>
<input id="token" type="password" placeholder="UPDATE_ADMIN_TOKEN"><button id="load">加载密钥列表</button><span id="message"></span>
<section><h2>新建密钥</h2><input id="note" placeholder="备注（例如：同学 A）" maxlength="200"><input id="expiry" type="datetime-local"><button id="create">生成</button><p id="new-key" class="key"></p></section>
<table><thead><tr><th>ID</th><th>末 5 位</th><th>状态</th><th>设备</th><th>激活时间</th><th>备注</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table>
<script>
const $ = (id) => document.getElementById(id); let licenses = [];
function headers(json = false) { const h = { 'x-admin-token': $('token').value.trim() }; if (json) h['content-type'] = 'application/json'; return h; }
function message(text, error = false) { $('message').textContent = text; $('message').className = error ? 'error' : ''; }
async function api(url, init = {}) { const response = await fetch(url, { ...init, headers: { ...headers(Boolean(init.body)), ...(init.headers || {}) } }); const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败'); return data; }
function cell(row, text) { const td = document.createElement('td'); td.textContent = text || '—'; row.append(td); }
function render() { const body = $('rows'); body.replaceChildren(); for (const item of licenses) { const row = document.createElement('tr'); cell(row, String(item.id)); cell(row, item.keyHint); cell(row, item.status); cell(row, item.deviceBound ? '已绑定' : '未绑定'); cell(row, item.activatedAt ? new Date(item.activatedAt).toLocaleString() : '未激活'); cell(row, item.note); const actions = document.createElement('td'); for (const [label, action] of [[item.status === 'active' ? '禁用' : '启用', item.status === 'active' ? 'disable' : 'enable'], ['重置设备', 'reset-device']]) { const button = document.createElement('button'); button.textContent = label; button.onclick = async () => { try { await api('/admin/licenses/' + item.id + '/' + action, { method: 'POST' }); await load(); } catch (error) { message(error.message, true); } }; actions.append(button); } row.append(actions); body.append(row); } }
async function load() { try { const data = await api('/admin/licenses'); licenses = data.licenses; render(); message('已加载 ' + licenses.length + ' 把密钥'); } catch (error) { message(error.message, true); } }
$('load').onclick = load;
$('create').onclick = async () => { try { const expiry = $('expiry').value ? new Date($('expiry').value).toISOString() : undefined; const data = await api('/admin/licenses', { method: 'POST', body: JSON.stringify({ note: $('note').value, expiresAt: expiry }) }); $('new-key').textContent = '请立即复制并私发给同学：' + data.licenseKey; await load(); } catch (error) { message(error.message, true); } };
</script></body></html>`;

/** 创建可测试、可嵌入的更新与授权 HTTP 服务。 */
export function createUpdateServer({
  dataDir = path.join(ROOT, "..", "update-data"),
  adminToken,
  licenseSecret,
} = {}) {
  if (!adminToken) throw new Error("缺少 UPDATE_ADMIN_TOKEN");
  if (!licenseSecret) throw new Error("缺少 LICENSE_SECRET");
  mkdirSync(dataDir, { recursive: true });
  const metaFile = path.join(dataDir, "meta.json");
  const zipPath = (version) => path.join(dataDir, `courseraptor-v${version}.zip`);
  const licenses = createLicenseStore({
    databasePath: path.join(dataDir, "licenses.sqlite"),
    secret: licenseSecret,
  });

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
        try { notes = decodeURIComponent(String(req.headers["x-notes"] ?? "")); } catch { return sendJson(res, 400, { error: "x-notes 编码不正确" }); }
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
        requireLicense(req, licenses);
        const meta = await readMeta();
        if (!meta || !existsSync(zipPath(meta.version))) return sendJson(res, 404, { error: "还没有发布过版本" });
        const size = (await stat(zipPath(meta.version))).size;
        res.writeHead(200, { "content-type": "application/zip", "content-length": size, "content-disposition": `attachment; filename="courseraptor-v${meta.version}.zip"` });
        return createReadStream(zipPath(meta.version)).pipe(res);
      }

      if (req.method === "POST" && (url.pathname === "/license/activate" || url.pathname === "/license/check")) {
        const body = await readJson(req);
        const result = url.pathname.endsWith("/activate") ? licenses.activate(body) : licenses.check(body);
        return sendJson(res, 200, { ok: true, license: result });
      }

      if (req.method === "POST" && url.pathname === "/admin/licenses") {
        if (!requireAdmin(req, res, adminToken)) return;
        const license = licenses.createLicense(await readJson(req));
        // 明文密钥只在这个创建响应出现一次，管理列表永远不返回它。
        return sendJson(res, 201, license);
      }

      if (req.method === "GET" && url.pathname === "/admin/licenses") {
        if (!requireAdmin(req, res, adminToken)) return;
        return sendJson(res, 200, { licenses: licenses.listLicenses() });
      }

      const licenseAction = url.pathname.match(/^\/admin\/licenses\/(\d+)\/(disable|enable|reset-device)$/);
      if (req.method === "POST" && licenseAction) {
        if (!requireAdmin(req, res, adminToken)) return;
        const id = Number(licenseAction[1]);
        const action = licenseAction[2];
        const license = action === "disable" ? licenses.disableLicense(id) : action === "enable" ? licenses.enableLicense(id) : licenses.resetDevice(id);
        return sendJson(res, 200, { license });
      }

      if (req.method === "GET" && url.pathname === "/admin") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(adminHtml);
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(landingHtml(await readMeta()));
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      return apiError(res, error);
    }
  });
}
