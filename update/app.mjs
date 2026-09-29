import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_PACKAGE_BODY = 200 * 1024 * 1024;
const MAX_ADMIN_BODY = 64 * 1024;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ZIP_RE = /^courseraptor-v(\d+\.\d+\.\d+)\.zip$/;
const FAILURES_TO_LOCK = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const FAILURE_IDLE_MS = 30 * 60 * 1000;
const ENV_KEY_ID = "__env__";
const ENV_KEY_NAME = "主密钥（环境变量）";
const KEY_NAME_DEFAULT = "未命名密钥";
const KEY_NAME_MAX = 64;
/** 面板密钥令牌前缀 + 24 字节 base64url（恰 32 字符，字母表 A-Za-z0-9_-） */
const KEY_TOKEN_PREFIX = "crak_";

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

function semverRank(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
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

/** 创建可测试、可嵌入的更新 HTTP 服务（admin API 供网关管理台代理调用）。 */
export function createUpdateServer({
  dataDir = path.join(ROOT, "..", "update-data"),
  adminToken,
} = {}) {
  if (!adminToken) throw new Error("缺少 UPDATE_ADMIN_TOKEN");
  mkdirSync(dataDir, { recursive: true });
  const metaFile = path.join(dataDir, "meta.json");
  const versionsFile = path.join(dataDir, "versions.json");
  const keysFile = path.join(dataDir, "admin-keys.json");
  const zipPath = (version) => path.join(dataDir, `courseraptor-v${version}.zip`);

  // 面板密钥启动时读一次，之后内存为准（创建/删除/使用都会同步落盘）。
  // 落盘只存 sha256 哈希，明文令牌仅创建响应里出现一次。
  let panelKeys = [];
  try {
    const parsed = JSON.parse(readFileSync(keysFile, "utf8"));
    if (Array.isArray(parsed?.keys)) {
      panelKeys = parsed.keys.filter(
        (k) =>
          k && typeof k.id === "string" && typeof k.name === "string" && typeof k.tokenHash === "string",
      );
    }
  } catch {
    // 首次使用或历史文件损坏：当作没有面板密钥，首次创建时重建
  }

  const writeKeys = () => writeAtomic(keysFile, JSON.stringify({ keys: panelKeys }, null, 2));

  /** 面板密钥对外只暴露元信息，绝不带 tokenHash。 */
  const publicKeyView = (k) => ({
    id: k.id,
    name: k.name,
    isEnv: false,
    createdAt: k.createdAt ?? null,
    lastUsedAt: k.lastUsedAt ?? null,
  });

  const envKeyView = () => ({
    id: ENV_KEY_ID,
    name: ENV_KEY_NAME,
    isEnv: true,
    createdAt: null,
    lastUsedAt: null,
  });

  function normalizeKeyName(name) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    return trimmed ? trimmed.slice(0, KEY_NAME_MAX) : KEY_NAME_DEFAULT;
  }

  /** 按令牌原文匹配面板密钥（等长哈希 + 恒时比较），命中返回该密钥。 */
  function findPanelKey(token) {
    if (typeof token !== "string" || !token.startsWith(KEY_TOKEN_PREFIX)) return null;
    const hashed = createHash("sha256").update(token).digest();
    return (
      panelKeys.find((k) => {
        const stored = Buffer.from(k.tokenHash, "hex");
        return stored.length === hashed.length && timingSafeEqual(stored, hashed);
      }) ?? null
    );
  }

  // 连续鉴权失败锁定：按客户端 IP 计数，5 次失败锁 15 分钟，成功后清零。
  const failedLogins = new Map();

  function clientKey(req) {
    const remote = req.socket.remoteAddress || "unknown";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const realIp = req.headers["x-real-ip"];
    // Node 服务只监听回环地址；经 nginx 反代时 X-Real-IP 由我们自己的 nginx 设置，可信。
    return loopback && typeof realIp === "string" && realIp ? realIp : remote;
  }

  /** 校验管理员令牌（环境变量主密钥或面板密钥）并执行防爆破锁定；失败时响应已写出，返回 false。 */
  async function checkAdmin(req, res) {
    const key = clientKey(req);
    const now = Date.now();
    if (failedLogins.size > 500) {
      for (const [k, v] of failedLogins) {
        if (now - v.lastAt > FAILURE_IDLE_MS) failedLogins.delete(k);
      }
    }
    const record = failedLogins.get(key);
    if (record?.lockedUntil && record.lockedUntil > now) {
      const waitSec = Math.ceil((record.lockedUntil - now) / 1000);
      sendJson(res, 429, { error: `连续失败次数过多，请 ${waitSec} 秒后再试` });
      return false;
    }
    const token = req.headers["x-admin-token"];
    if (typeof token === "string" && tokenOk(token, adminToken)) {
      failedLogins.delete(key);
      return true;
    }
    const panelKey = findPanelKey(token);
    if (panelKey) {
      failedLogins.delete(key);
      panelKey.lastUsedAt = new Date().toISOString();
      try {
        await writeKeys();
      } catch (error) {
        console.error("[server] 密钥使用记录写入失败", error);
      }
      return true;
    }
    const count = (record?.count ?? 0) + 1;
    const lockedUntil = count >= FAILURES_TO_LOCK ? now + LOCK_DURATION_MS : 0;
    failedLogins.set(key, { count, lockedUntil, lastAt: now });
    if (lockedUntil) {
      sendJson(res, 429, { error: "连续失败次数过多，已锁定 15 分钟" });
    } else {
      sendJson(res, 401, { error: "管理员密钥无效" });
    }
    return false;
  }

  async function readMeta() {
    try {
      return JSON.parse(await readFile(metaFile, "utf8"));
    } catch {
      return null;
    }
  }

  async function readVersions() {
    try {
      const parsed = JSON.parse(await readFile(versionsFile, "utf8"));
      if (Array.isArray(parsed?.versions)) {
        return parsed.versions.filter((v) => v && typeof v.version === "string");
      }
    } catch {
      // 首次使用或历史文件损坏：当作空历史，下写一次写入时重建
    }
    return [];
  }

  const writeVersions = (versions) =>
    writeAtomic(versionsFile, JSON.stringify({ versions }, null, 2));

  async function upsertVersion(entry) {
    const versions = await readVersions();
    const index = versions.findIndex((v) => v.version === entry.version);
    if (index >= 0) versions[index] = { ...versions[index], ...entry };
    else versions.push(entry);
    await writeVersions(versions);
  }

  /** 合并 versions.json 索引与磁盘上的 zip（手动放置的包也能列出），按版本倒序。 */
  async function listVersions() {
    const byVersion = new Map((await readVersions()).map((v) => [v.version, { ...v }]));
    try {
      for (const name of readdirSync(dataDir)) {
        const match = ZIP_RE.exec(name);
        if (!match) continue;
        const version = match[1];
        let info;
        try {
          info = statSync(path.join(dataDir, name));
        } catch {
          continue;
        }
        const existing = byVersion.get(version);
        if (existing) {
          existing.sizeBytes = info.size;
        } else {
          byVersion.set(version, {
            version,
            notes: "",
            publishedAt: info.mtime.toISOString(),
            sizeBytes: info.size,
          });
        }
      }
    } catch {
      // dataDir 读取失败时退回纯索引视图
    }
    const meta = await readMeta();
    return [...byVersion.values()]
      .map((v) => ({ ...v, sizeBytes: v.sizeBytes ?? 0, isCurrent: v.version === meta?.version }))
      .sort((a, b) => semverRank(b.version) - semverRank(a.version));
  }

  async function rollbackTo(res, version, notes) {
    if (!existsSync(zipPath(version))) {
      return sendJson(res, 404, { error: `v${version} 的安装包不存在，无法回滚` });
    }
    const entry = (await readVersions()).find((v) => v.version === version);
    const finalNotes =
      typeof notes === "string" && notes.trim()
        ? notes.trim().slice(0, 2000)
        : typeof entry?.notes === "string"
          ? entry.notes
          : "";
    const meta = { version, notes: finalNotes, publishedAt: new Date().toISOString() };
    await writeAtomic(metaFile, JSON.stringify(meta, null, 2));
    await upsertVersion({
      version,
      notes: finalNotes,
      publishedAt: meta.publishedAt,
      rolledBackAt: meta.publishedAt,
    });
    return sendJson(res, 200, { ok: true, ...meta });
  }

  async function deleteVersion(res, version) {
    const meta = await readMeta();
    if (meta?.version === version) {
      return sendJson(res, 400, { error: "不能删除当前分发中的版本，请先发布或回滚到其他版本" });
    }
    const history = await readVersions();
    let removed = false;
    if (existsSync(zipPath(version))) {
      unlinkSync(zipPath(version));
      removed = true;
    }
    const remaining = history.filter((v) => v.version !== version);
    if (remaining.length !== history.length) {
      await writeVersions(remaining);
      removed = true;
    }
    if (!removed) return sendJson(res, 404, { error: `v${version} 不存在` });
    return sendJson(res, 200, { ok: true, version });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    try {
      // ── admin API（与 /publish 共用令牌与防爆破锁定）──
      if (req.method === "GET" && pathname === "/admin/api/overview") {
        if (!(await checkAdmin(req, res))) return;
        const versions = await listVersions();
        const meta = await readMeta();
        return sendJson(res, 200, {
          current: meta
            ? { version: meta.version, notes: meta.notes ?? "", publishedAt: meta.publishedAt }
            : null,
          stats: {
            versionCount: versions.length,
            diskBytes: versions.reduce((sum, v) => sum + (v.sizeBytes || 0), 0),
            nodeVersion: process.version,
            uptimeSec: Math.round(process.uptime()),
            dataDir,
          },
        });
      }

      if (req.method === "GET" && pathname === "/admin/api/versions") {
        if (!(await checkAdmin(req, res))) return;
        return sendJson(res, 200, { versions: await listVersions() });
      }

      if (
        req.method === "POST" &&
        (pathname === "/admin/api/rollback" || pathname === "/admin/api/delete")
      ) {
        if (!(await checkAdmin(req, res))) return;
        let body;
        try {
          body = JSON.parse((await readBody(req, MAX_ADMIN_BODY)).toString("utf8") || "{}");
        } catch {
          return sendJson(res, 400, { error: "请求体必须是 JSON" });
        }
        const version = String(body?.version ?? "");
        if (!SEMVER_RE.test(version)) return sendJson(res, 400, { error: "version 必须是 x.y.z" });
        if (pathname === "/admin/api/rollback") return await rollbackTo(res, version, body?.notes);
        return await deleteVersion(res, version);
      }

      // ── 面板管理员密钥：列表 / 新建 / 删除（权限与主密钥完全相同，经 checkAdmin 校验）──
      if (req.method === "GET" && pathname === "/admin/api/keys") {
        if (!(await checkAdmin(req, res))) return;
        return sendJson(res, 200, { keys: [envKeyView(), ...panelKeys.map(publicKeyView)] });
      }

      if (req.method === "POST" && pathname === "/admin/api/keys") {
        if (!(await checkAdmin(req, res))) return;
        let body;
        try {
          body = JSON.parse((await readBody(req, MAX_ADMIN_BODY)).toString("utf8") || "{}");
        } catch {
          return sendJson(res, 400, { error: "请求体必须是 JSON" });
        }
        const token = `${KEY_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
        const key = {
          id: randomUUID(),
          name: normalizeKeyName(body?.name),
          tokenHash: createHash("sha256").update(token).digest("hex"),
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        };
        panelKeys.push(key);
        await writeKeys();
        // 明文令牌只在创建响应里出现这一次，之后仅存哈希
        return sendJson(res, 200, { token, key: publicKeyView(key) });
      }

      if (req.method === "POST" && pathname === "/admin/api/keys/delete") {
        if (!(await checkAdmin(req, res))) return;
        let body;
        try {
          body = JSON.parse((await readBody(req, MAX_ADMIN_BODY)).toString("utf8") || "{}");
        } catch {
          return sendJson(res, 400, { error: "请求体必须是 JSON" });
        }
        const id = String(body?.id ?? "");
        if (id === ENV_KEY_ID) {
          return sendJson(res, 400, { error: "主密钥来自服务器环境变量,不能在面板删除" });
        }
        const index = panelKeys.findIndex((k) => k.id === id);
        if (index < 0) return sendJson(res, 404, { error: "密钥不存在" });
        panelKeys.splice(index, 1);
        await writeKeys();
        return sendJson(res, 200, { ok: true });
      }

      // ── 发布（原有命令行链路与面板上传共用）──
      if (req.method === "POST" && pathname === "/publish") {
        if (!(await checkAdmin(req, res))) return;
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
        await upsertVersion({ version, notes, publishedAt: meta.publishedAt });
        return sendJson(res, 200, { ok: true, ...meta });
      }

      // ── 学生端 ──
      if (req.method === "GET" && pathname === "/latest") {
        const meta = await readMeta();
        if (!meta) return sendJson(res, 404, { error: "还没有发布过版本" });
        return sendJson(res, 200, { ...meta, download: "/download" });
      }

      if (req.method === "GET" && pathname === "/download") {
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

      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
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
