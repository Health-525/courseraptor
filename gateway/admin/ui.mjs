/**
 * 多用户网关的网页版管理后台（挂在网关的 /admin 路径，与同学入口同端口）。
 *
 * 启用方式：环境变量 GATEWAY_ADMIN_PASSWORD（至少 8 位）；未设置时 /admin
 * 显示「未启用」说明页，管理动作一律 404，只能继续用 admin.mjs 命令行。
 *
 * 鉴权：独立的管理会话 Cookie（raptor_admin，HMAC 签名与同学会话不同名
 * 不同签名域，互不通用）；登录失败同样 5 次锁 15 分钟。
 *
 * 界面基于 Tabler（MIT，vendor 在 assets/vendor/，主流管理后台模板），
 * 前端应用在 assets/admin-app.js（vanilla JS，无构建，服务时内联进页面）。
 * 模板静态文件经 /admin/assets/<白名单文件> 下发（公共资源，无鉴权）。
 *
 * 管理能力：总览 / 用户（增删改停踢）/ 邀请码（生成删）/ 重置审批 /
 * 站点设置 / 安全设置（TOTP）/ 版本发布 / 密钥管理 / 操作日志。
 * 全部变更动作写 admin-log.json（环形 500 条，经 bootstrap 带出）。
 *
 * 两步验证（TOTP）：在「安全设置」扫码绑定后登录需密码 + 6 位动态码；
 * 启用/关闭递增 sessionEpoch 令既有管理会话立即失效；手机与恢复码全丢
 * 时 SSH 上机执行 `admin.mjs totp off` 兜底。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import {
  generateTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "./totp.mjs";

const ADMIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_JS_PATH = path.join(ADMIN_DIR, "assets", "admin-app.js");
let appJsCache = null;

/** 读入前端应用并缓存（改 admin-app.js 后需重启网关生效） */
function appJs() {
  if (appJsCache === null) {
    try {
      appJsCache = fs.readFileSync(APP_JS_PATH, "utf8");
    } catch {
      appJsCache = 'console.error("前端脚本缺失：gateway/admin/assets/admin-app.js 不可读");';
    }
  }
  return appJsCache;
}

/** 模板静态文件白名单（公共资源，不含任何秘密，直接下发可缓存） */
const ASSET_FILES = new Map([
  ["tabler.min.css", { file: path.join(ADMIN_DIR, "assets", "vendor", "tabler.min.css"), type: "text/css; charset=utf-8" }],
  ["tabler.min.js", { file: path.join(ADMIN_DIR, "assets", "vendor", "tabler.min.js"), type: "application/javascript; charset=utf-8" }],
]);

const ADMIN_COOKIE = "raptor_admin";
const ADMIN_TTL_MS = 12 * 3600_000;
const MAX_JSON_BODY = 16 * 1024;
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
const FAILURES_TO_LOCK = 5;
const LOCK_DURATION_MS = 15 * 60_000;
const FAILURE_IDLE_MS = 30 * 60_000;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 管理台少量自有样式（其余全部交给 Tabler） */
const OWN_CSS = `
body{font-family:var(--tblr-font-sans-serif,inherit)}
.pane-page{display:none}
.pane-page.on{display:block}
.qr-box{background:#fff;border:1px solid var(--tblr-border-color);border-radius:4px;
width:fit-content;padding:8px;margin:4px 0}
.qr-box svg{display:block;width:200px;height:200px}
.recovery-codes{font-family:var(--tblr-font-monospace,monospace);font-size:15px;
letter-spacing:.08em;line-height:2}
.drop-zone{border:1.5px dashed var(--tblr-border-color);border-radius:4px;
padding:22px 16px;text-align:center;color:var(--tblr-secondary);cursor:pointer;
background:var(--tblr-bg-surface-secondary);transition:border-color .15s ease,background .15s ease}
.drop-zone:hover,.drop-zone.drag-on{border-color:var(--tblr-primary);color:var(--tblr-primary-fg);background:var(--tblr-active-bg)}
.mono{font-family:var(--tblr-font-monospace,monospace);font-size:.875em}
.copy-ok{color:var(--tblr-success);font-size:.75rem}
.log-empty{color:var(--tblr-secondary)}
`;

const loginHtml = (error = "", mfa = false) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f8f9fa">
<title>管理登录 · CourseRaptor</title>
<link rel="stylesheet" href="/admin/assets/tabler.min.css">
<style>${OWN_CSS}</style>
</head>
<body>
<div class="page page-center">
<div class="container container-tight py-4">
  <div class="text-center mb-4">
    <span class="navbar-brand navbar-brand-autodark" style="font-size:1.1rem;font-weight:600">
      CourseRaptor <span class="badge bg-warning-lt ms-2">ADMIN</span>
    </span>
  </div>
  <div class="card card-md">
    <div class="card-body">
      <h2 class="h2 text-center mb-4">管理后台登录</h2>
      ${error ? `<div class="alert alert-danger" role="alert">${escapeHtml(error)}</div>` : ""}
      <form method="post" action="/admin/login" autocomplete="on">
        <div class="mb-3">
          <label class="form-label">管理密码</label>
          <input type="password" class="form-control" name="password"
                 autocomplete="current-password" required${mfa ? "" : " autofocus"}
                 placeholder="请输入管理密码">
        </div>
        ${mfa
          ? `<div class="mb-3">
          <label class="form-label">动态码（2FA）</label>
          <input type="text" class="form-control" name="code" inputmode="numeric"
                 autocomplete="one-time-code" required autofocus
                 placeholder="验证器 6 位数字（或恢复码）">
        </div>`
          : ""}
        <div class="form-footer">
          <button type="submit" class="btn btn-primary w-100">进入管理后台</button>
        </div>
      </form>
    </div>
  </div>
  <div class="text-center text-secondary mt-3">班级互助服务 · CourseRaptor</div>
</div>
</div>
</body>
</html>`;

const disabledHtml = () => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>未启用 · CourseRaptor 管理</title>
<link rel="stylesheet" href="/admin/assets/tabler.min.css">
</head>
<body>
<div class="page page-center">
<div class="container container-tight py-4">
  <div class="card card-md">
    <div class="card-body">
      <h2 class="h2 text-center mb-4">管理后台未启用</h2>
      <div class="alert alert-warning">服务器未设置 <span class="mono">GATEWAY_ADMIN_PASSWORD</span></div>
      <p class="text-secondary">在 <span class="mono">/etc/raptor-gateway.env</span> 加入该变量并
      <span class="mono">systemctl restart raptor-gateway</span> 即可开启；期间可继续用
      <span class="mono">admin.mjs</span> 命令行管理。</p>
    </div>
  </div>
</div>
</div>
</body>
</html>`;

/** 侧栏图标：Tabler Icons 描线 SVG（24 viewBox，stroke 1.5） */
const I = {
  home: '<path d="M5 12l-2 0l9 -9l9 9l-2 0"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"/><path d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"/>',
  users:
    '<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>',
  ticket:
    '<path d="M15 5l0 2"/><path d="M15 11l0 2"/><path d="M15 17l0 2"/><path d="M5 5a2 2 0 0 0 -2 2v3a2 2 0 0 1 0 4v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2 -2v-3a2 2 0 0 1 0 -4v-3a2 2 0 0 0 -2 -2h-14z"/>',
  key: '<path d="M10.3 13.7l-.3 .3l-4 4l-2.5 .5l.5 -2.5l4 -4l.3 -.3"/><path d="M21 14a5 5 0 1 0 -8.54 -3.54l-9 9l1.5 1.5l3 3l2 -2l-2 -2l2 -2l2 2l2 -2"/>',
  shield:
    '<path d="M12 3l8 4v5c0 5.5 -3.8 9.74 -8 11c-4.2 -1.26 -8 -5.5 -8 -11v-5l8 -4"/><path d="M9 12l2 2l4 -4"/>',
  rocket:
    '<path d="M7 12a5 5 0 0 1 5 -5a5 5 0 0 1 5 5a5 5 0 0 1 -5 5a5 5 0 0 1 -5 -5"/><path d="M12 17v7"/><path d="M9 21h6"/>',
  adjustments:
    '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="14" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  history:
    '<path d="M12 8v4l3 3"/><path d="M3.05 11a9 9 0 1 1 .5 4"/><path d="M3 15l-2 -4l4 1"/>',
  clipboard:
    '<path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2"/><path d="M9 3h6v4h-6z"/>',
};
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name]}</svg>`;

const NAV = [
  { group: "总览", items: [["home", "概览", "home"]] },
  {
    group: "管理",
    items: [
      ["users", "用户", "users"],
      ["invites", "邀请码", "ticket"],
      ["resets", "重置审批", "key"],
    ],
  },
  {
    group: "配置",
    items: [
      ["site", "站点设置", "adjustments"],
      ["security", "安全设置", "shield"],
    ],
  },
  {
    group: "发布",
    items: [
      ["release", "版本发布", "rocket"],
      ["keys", "密钥管理", "key"],
    ],
  },
  { group: "系统", items: [["log", "操作日志", "history"]] },
];

const navHtml = NAV.map((group) => {
  const items = group.items
    .map(
      ([id, label, ic]) => `<li class="nav-item" data-nav-item="${id}">
      <a class="nav-link" href="#/${id}" data-nav="${id}">
        <span class="nav-link-icon d-md-none d-lg-inline-block">${icon(ic)}</span>
        <span class="nav-link-title">${label}</span>${id === "resets" ? '<span class="badge bg-danger ms-auto" id="navResetBadge" hidden></span>' : ""}
      </a>
    </li>`,
    )
    .join("");
  return `<li class="nav-header">${group.group}</li>${items}`;
}).join("");

const dashboardHtml = () => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f8f9fa">
<title>管理后台 · CourseRaptor</title>
<link rel="stylesheet" href="/admin/assets/tabler.min.css">
<style>${OWN_CSS}</style>
</head>
<body>
<div class="page">
  <aside class="navbar navbar-vertical navbar-expand-lg">
    <div class="container-fluid">
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#sidebar-menu"
              aria-controls="sidebar-menu" aria-expanded="false" aria-label="展开 / 收起菜单">
        <span class="navbar-toggler-icon"></span>
      </button>
      <h1 class="navbar-brand navbar-brand-autodark">
        <a href="#/home" class="text-decoration-none">Course<span class="text-primary fw-bold">Raptor</span>
          <span class="badge bg-warning-lt ms-1">ADMIN</span></a>
      </h1>
      <div class="collapse navbar-collapse" id="sidebar-menu">
        <ul class="navbar-nav pt-lg-3">
          ${navHtml}
        </ul>
      </div>
    </div>
  </aside>

  <div class="page-wrapper">
    <header class="navbar navbar-expand-md d-none d-lg-flex d-print-none">
      <div class="container-xl">
        <div class="navbar-nav flex-row order-md-last">
          <div class="d-none d-md-flex me-2 text-secondary small" id="headerMeta"></div>
          <button type="button" class="btn btn-sm btn-outline-secondary me-2" id="refresh">
            ${icon("history")} 刷新
          </button>
          <button type="button" class="btn btn-sm btn-outline-danger" id="logout">退出</button>
        </div>
      </div>
    </header>

    <div class="page-wrapper">
      <div class="page-header d-print-none">
        <div class="container-xl">
          <div class="row g-2 align-items-center">
            <div class="col">
              <div class="page-pretitle" id="pagePretitle">ADMIN</div>
              <h2 class="page-title" id="pageTitle">概览</h2>
            </div>
          </div>
        </div>
      </div>
      <div class="page-body">
        <div class="container-xl">

          <div class="pane-page on" id="pane-home">
            <div class="row row-deck row-cards" id="homeStats"></div>
            <div class="row row-deck row-cards mt-3" id="homeAlerts"></div>
            <div class="row row-deck row-cards mt-3">
              <div class="col-lg-6">
                <div class="card">
                  <div class="card-header"><h3 class="card-title">快捷操作</h3></div>
                  <div class="card-body">
                    <div class="d-flex flex-wrap gap-2">
                      <a href="#/invites" class="btn btn-outline-primary">${icon("ticket")} 生成邀请码</a>
                      <button type="button" class="btn btn-outline-primary" data-open-modal="modalUserCreate">${icon("users")} 新增用户</button>
                      <a href="#/release" class="btn btn-outline-primary">${icon("rocket")} 上传版本</a>
                      <a href="#/site" class="btn btn-outline-primary">${icon("adjustments")} 站点 Key</a>
                      <a href="#/security" class="btn btn-outline-primary">${icon("shield")} 两步验证</a>
                    </div>
                  </div>
                </div>
              </div>
              <div class="col-lg-6">
                <div class="card">
                  <div class="card-header"><h3 class="card-title">最近操作</h3>
                    <div class="card-actions"><a href="#/log" class="btn btn-link">全部 →</a></div></div>
                  <div class="card-body p-0">
                    <ul class="list-group list-group-flush" id="homeLog"><li class="list-group-item text-secondary">读取中…</li></ul>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="pane-page" id="pane-users">
            <div class="card">
              <div class="card-header">
                <h3 class="card-title">用户列表</h3>
                <div class="card-actions">
                  <div class="input-icon input-icon-sm me-2">
                    <input type="search" class="form-control form-control-sm" id="userSearch" placeholder="搜索用户名…">
                  </div>
                  <select class="form-select form-select-sm w-auto me-2" id="userFilter">
                    <option value="">全部状态</option>
                    <option value="active">正常</option>
                    <option value="disabled">已停用</option>
                    <option value="online">在线</option>
                  </select>
                  <button type="button" class="btn btn-primary btn-sm" data-open-modal="modalUserCreate">
                    ${icon("users")} 新增用户
                  </button>
                </div>
              </div>
              <div class="table-responsive">
                <table class="table table-vcenter card-table">
                  <thead><tr>
                    <th>用户名</th><th>状态</th><th>Key 来源</th><th>在线</th>
                    <th>来源</th><th>注册于</th><th>今日轮数</th><th class="w-1"></th>
                  </tr></thead>
                  <tbody id="userRows"><tr><td colspan="8" class="text-secondary">读取中…</td></tr></tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="pane-page" id="pane-invites">
            <div class="card mb-3">
              <div class="card-header"><h3 class="card-title">生成邀请码</h3></div>
              <div class="card-body">
                <form class="row g-2 align-items-end" id="inviteForm">
                  <div class="col-auto"><label class="form-label text-secondary">数量</label>
                    <input type="number" class="form-control" id="invCount" min="1" max="50" value="5" style="width:90px"></div>
                  <div class="col"><label class="form-label text-secondary">备注（如：班级群）</label>
                    <input type="text" class="form-control" id="invNote" maxlength="100"></div>
                  <div class="col-auto"><label class="form-label text-secondary">有效天数（0=永久）</label>
                    <input type="number" class="form-control" id="invDays" min="0" max="365" value="0" style="width:130px"></div>
                  <div class="col-auto"><button type="submit" class="btn btn-primary">生成</button></div>
                </form>
              </div>
            </div>
            <div class="card">
              <div class="card-header"><h3 class="card-title">邀请码列表</h3></div>
              <div class="table-responsive">
                <table class="table table-vcenter card-table">
                  <thead><tr><th>邀请码</th><th>备注</th><th>使用者</th><th>状态</th><th class="w-1"></th></tr></thead>
                  <tbody id="inviteRows"><tr><td colspan="5" class="text-secondary">读取中…</td></tr></tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="pane-page" id="pane-resets">
            <div class="card mb-3">
              <div class="card-header"><h3 class="card-title">待审批申请</h3>
                <div class="card-actions text-secondary">同意后把一次性码发给同学，新密码由同学自己设</div></div>
              <div class="table-responsive">
                <table class="table table-vcenter card-table">
                  <thead><tr><th>用户名</th><th>申请时间</th><th class="w-1"></th></tr></thead>
                  <tbody id="resetRows"><tr><td colspan="3" class="text-secondary">读取中…</td></tr></tbody>
                </table>
              </div>
            </div>
            <div class="card">
              <div class="card-header"><h3 class="card-title">有效重置码</h3>
                <div class="card-actions text-secondary">24 小时内有效 · 用后即焚</div></div>
              <div class="table-responsive">
                <table class="table table-vcenter card-table">
                  <thead><tr><th>用户名</th><th>重置码</th><th>过期时间</th><th class="w-1"></th></tr></thead>
                  <tbody id="codeRows"><tr><td colspan="4" class="text-secondary">读取中…</td></tr></tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="pane-page" id="pane-site">
            <div class="card mb-3">
              <div class="card-header"><h3 class="card-title">站点统一 DeepSeek Key</h3>
                <div class="card-actions text-secondary">同学端「设置 → AI 模型」的统一 Key</div></div>
              <div class="card-body">
                <div class="mb-2 text-secondary" id="keyState">读取中…</div>
                <form class="d-flex gap-2" id="siteKeyForm">
                  <input type="text" class="form-control" id="siteKeyInput" placeholder="粘贴新的 sk- 开头 Key" autocomplete="off">
                  <button type="submit" class="btn btn-primary flex-shrink-0">保存</button>
                </form>
                <div class="text-secondary small mt-2">保存后新拉起的实例立即使用新 Key；在线实例下次拉起时切换。同学保存自己的 Key 后优先用自己的，不消耗站点额度。</div>
              </div>
            </div>
            <div class="card">
              <div class="card-header"><h3 class="card-title">对话限额与分账</h3></div>
              <div class="card-body" id="quotaStats"><div class="text-secondary">读取中…</div></div>
            </div>
          </div>

          <div class="pane-page" id="pane-security">
            <div class="card">
              <div class="card-header"><h3 class="card-title">两步验证（TOTP）</h3>
                <div class="card-actions text-secondary">登录需密码 + 手机验证器动态码</div></div>
              <div class="card-body" id="mfaCard"><div class="text-secondary">读取中…</div></div>
            </div>
          </div>

          <div class="pane-page" id="pane-release">
            <div class="card mb-3">
              <div class="card-header"><h3 class="card-title">上传新版本</h3>
                <div class="card-actions text-secondary">同学端安装包 · 与 npm run publish 共用接口</div></div>
              <div class="card-body">
                <div class="row g-2 mb-2">
                  <div class="col-auto"><input type="text" class="form-control mono" id="updVer" placeholder="x.y.z" style="width:130px;text-align:center" autocomplete="off" spellcheck="false"></div>
                  <div class="col"><input type="text" class="form-control" id="updNotes" placeholder="更新说明（可选），如：修复课表周次显示错误" maxlength="2000" autocomplete="off"></div>
                </div>
                <div class="drop-zone" id="updDrop" tabindex="0" role="button" aria-label="选择或拖入 zip 安装包">
                  <div>点击选择，或拖入 zip 安装包（最大 200 MB）</div>
                </div>
                <input type="file" id="updFile" accept=".zip,application/zip" hidden>
                <div id="updFileBox"></div>
                <div id="updProg" hidden class="mt-2">
                  <div class="d-flex justify-content-between small text-secondary"><span id="updPhase">上传中</span><span id="updPct">0%</span></div>
                  <div class="progress progress-sm mt-1"><div class="progress-bar" id="updBar" style="width:0%"></div></div>
                  <div class="text-end mt-1"><button type="button" class="btn btn-sm btn-outline-secondary" id="updCancel">取消上传</button></div>
                </div>
                <button type="button" class="btn btn-primary mt-2" id="updGo">发布新版本</button>
                <div class="text-secondary small mt-2">发布后学生端下次启动 raptor 时提示更新；版本号需大于当前分发版本，否则不触发更新。</div>
              </div>
            </div>
            <div class="card">
              <div class="card-header"><h3 class="card-title">历史版本</h3>
                <div class="card-actions text-secondary" id="updCur"></div></div>
              <div class="card-body" id="updCard"><div class="text-secondary">读取中…</div></div>
            </div>
          </div>

          <div class="pane-page" id="pane-keys">
            <div class="card">
              <div class="card-header"><h3 class="card-title">更新后台密钥</h3>
                <div class="card-actions text-secondary">命令行发版与后台登录用，与主密钥同权</div></div>
              <div class="card-body">
                <form class="d-flex gap-2 mb-2" id="keyForm">
                  <input type="text" class="form-control" id="keyName" placeholder="名称（可选），如：发布机 / 值班同学" maxlength="64" autocomplete="off">
                  <button type="submit" class="btn btn-primary flex-shrink-0">新建密钥</button>
                </form>
                <div id="keyCreated" hidden></div>
                <div class="table-responsive mt-2">
                  <table class="table table-vcenter card-table">
                    <thead><tr><th>名称</th><th>类型</th><th>创建时间</th><th>最后使用</th><th class="w-1"></th></tr></thead>
                    <tbody id="keyRows"><tr><td colspan="5" class="text-secondary">读取中…</td></tr></tbody>
                  </table>
                </div>
                <div class="text-secondary small mt-2">主密钥来自服务器环境变量 UPDATE_ADMIN_TOKEN，始终可用且不能在这里删除；面板密钥删除后立即失效。明文只在创建时展示一次。</div>
              </div>
            </div>
          </div>

          <div class="pane-page" id="pane-log">
            <div class="card">
              <div class="card-header"><h3 class="card-title">操作日志</h3>
                <div class="card-actions text-secondary">最近 200 条管理动作</div></div>
              <div class="table-responsive">
                <table class="table table-vcenter card-table">
                  <thead><tr><th style="width:170px">时间</th><th>操作</th></tr></thead>
                  <tbody id="logRows"><tr><td colspan="2" class="text-secondary">读取中…</td></tr></tbody>
                </table>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  </div>
</div>

<!-- 新增用户 -->
<div class="modal modal-blur" id="modalUserCreate" tabindex="-1" style="display:none" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">新增用户</h5>
        <button type="button" class="btn-close" data-close-modal aria-label="关闭"></button></div>
      <div class="modal-body">
        <div class="mb-3"><label class="form-label">用户名</label>
          <input type="text" class="form-control" id="newUsername" placeholder="字母 / 数字 / _ / -，2-32 位" autocomplete="off"></div>
        <div class="mb-3"><label class="form-label">初始密码（至少 8 位）</label>
          <input type="text" class="form-control mono" id="newPassword" placeholder="同学登录后可自行修改" autocomplete="off"></div>
        <div class="text-secondary small">不走邀请码直接建号；账号建好即可登录。</div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-link link-secondary" data-close-modal>取消</button>
        <button type="button" class="btn btn-primary" id="userCreateGo">创建</button>
      </div>
    </div>
  </div>
</div>

<!-- 设限额 -->
<div class="modal modal-blur" id="modalQuota" tabindex="-1" style="display:none" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">设置每日限额</h5>
        <button type="button" class="btn-close" data-close-modal aria-label="关闭"></button></div>
      <div class="modal-body">
        <div class="mb-2 text-secondary" id="quotaUser"></div>
        <input type="number" class="form-control" id="quotaValue" min="0" max="100000" placeholder="0 = 用站点默认">
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-link link-secondary" data-close-modal>取消</button>
        <button type="button" class="btn btn-primary" id="quotaGo">保存</button>
      </div>
    </div>
  </div>
</div>

<!-- 用户详情 -->
<div class="modal modal-blur" id="modalUserDetail" tabindex="-1" style="display:none" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">用户详情</h5>
        <button type="button" class="btn-close" data-close-modal aria-label="关闭"></button></div>
      <div class="modal-body" id="userDetailBody"></div>
    </div>
  </div>
</div>

<script src="/admin/assets/tabler.min.js"></script>
<script>
${appJs()}
</script>
</body>
</html>`;

export function createAdminUi({
  registry,
  spawner,
  secret,
  password,
  capacity = 0,
  defaultDailyTurns = 100,
  updateServerUrl = "",
  updateAdminToken = "",
  version = "",
  envDeepseekKeySet = false,
  usersDir = "",
}) {
  const enabled = typeof password === "string" && password.length >= 8;
  const failures = new Map();
  // 扫码绑定流程的中间态：只存内存，未走完「验证并启用」就丢弃（重启作废重来）
  let pendingSetup = null;
  const PENDING_SETUP_TTL_MS = 10 * 60_000;

  /** 管理动作落一笔日志：等落盘再响应（失败不影响主流程） */
  const audit = async (ip, text) => {
    try {
      await registry.appendAdminLog(text, ip);
    } catch {
      /* 日志失败不阻断管理动作 */
    }
  };

  /**
   * 代理访问同机部署的更新分发后台（update/update-server.mjs，回环端口）。
   * 未配置 / 连不上时返回 {unavailable}，管理台显示「未接入」而不是报错。
   */
  async function callUpdateApi(method, path, body) {
    if (!updateServerUrl || !updateAdminToken) {
      return { unavailable: true, error: "更新后台未接入（网关未配置 GATEWAY_UPDATE_URL / GATEWAY_UPDATE_TOKEN）" };
    }
    try {
      const res = await fetch(`${updateServerUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          "x-admin-token": updateAdminToken,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return { error: "更新后台拒绝了令牌（检查两边的 token 是否一致）" };
      if (!res.ok) return { error: data?.error ?? `更新后台返回 ${res.status}` };
      return { data };
    } catch (error) {
      return { unavailable: true, error: `更新后台不可达：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  function sign(expiresAt, epoch = 0) {
    return createHmac("sha256", secret).update(`admin.${epoch}.${expiresAt}`).digest("hex");
  }

  function sessionFrom(req, epoch = 0) {
    const raw = req.headers.cookie;
    if (typeof raw !== "string") return null;
    const match = /(?:^|;\s*)raptor_admin=([^;]+)/.exec(raw);
    if (!match) return null;
    const [expiresAt, mac] = match[1].split(".");
    if (!expiresAt || !mac) return null;
    const expected = sign(expiresAt, epoch);
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (Number(expiresAt) < Date.now()) return null;
    return Number(expiresAt);
  }

  function checkThrottle(ip) {
    const record = failures.get(ip);
    if (record?.lockedUntil && record.lockedUntil > Date.now()) {
      return Math.ceil((record.lockedUntil - Date.now()) / 1000);
    }
    return 0;
  }

  function passwordOk(candidate) {
    const a = Buffer.from(String(candidate ?? ""));
    const b = Buffer.from(password);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function recordFailure(ip) {
    const now = Date.now();
    const record = failures.get(ip);
    const count = (record?.count ?? 0) + 1;
    const lockedUntil = count >= FAILURES_TO_LOCK ? now + LOCK_DURATION_MS : 0;
    failures.set(ip, { count, lockedUntil, lastAt: now });
  }

  /**
   * 高危动作（登录、关闭两步验证、重生成恢复码）的动态码校验：
   * TOTP 命中则推进防重放水位，未命中再试恢复码（命中即消耗一枚）。
   * 返回 { ok, replay?, doc }，doc 为校验副作用后的最新落盘文档。
   */
  async function verifyAdminCode(doc, candidate) {
    const verdict = verifyTotp(doc.secret, String(candidate ?? "").trim(), {
      lastUsedCounter: doc.lastUsedCounter ?? -1,
    });
    if (verdict.ok) {
      return {
        ok: true,
        recoveryUsed: false,
        doc: { ...doc, lastUsedCounter: Math.max(doc.lastUsedCounter ?? -1, verdict.counter) },
      };
    }
    const index = (doc.recovery ?? []).indexOf(hashRecoveryCode(String(candidate ?? "")));
    if (index >= 0) {
      const recovery = [...doc.recovery];
      recovery.splice(index, 1);
      return { ok: true, recoveryUsed: true, doc: { ...doc, recovery } };
    }
    return {
      ok: false,
      replay: Boolean(verdict.replay),
    };
  }

  function send(res, status, body, type = "text/html; charset=utf-8", extra = {}) {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
    res.end(body);
  }

  const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

  /** 模板静态文件（白名单）：公共资源，长缓存 */
  async function handleAsset(req, res, pathname) {
    if (req.method !== "GET") return false;
    const name = pathname.slice("/admin/assets/".length);
    const asset = ASSET_FILES.get(name);
    if (!asset) return false;
    try {
      const body = await fs.promises.readFile(asset.file);
      res.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "public, max-age=86400",
        "content-length": body.length,
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return true;
  }

  /** 返回 true 表示已处理该请求 */
  async function handle(req, res, pathname) {
    const ip = req.socket.remoteAddress || "unknown";

    if (!enabled) {
      if (req.method === "GET" && pathname === "/admin") {
        send(res, 200, disabledHtml());
        return true;
      }
      sendJson(res, 404, { error: "管理后台未启用" });
      return true;
    }

    if (await handleAsset(req, res, pathname)) return true;

    // 两步验证状态每次请求现读：启用/关闭后无需重启即生效；
    // sessionEpoch 参与会话签名，状态一变所有旧管理会话立即失效
    const totpDoc = await registry.getAdminTotp();
    const epoch = totpDoc?.sessionEpoch ?? 0;
    const mfaOn = Boolean(totpDoc);

    if (req.method === "GET" && pathname === "/admin") {
      send(res, 200, sessionFrom(req, epoch) ? dashboardHtml() : loginHtml("", mfaOn));
      return true;
    }

    if (req.method === "POST" && pathname === "/admin/login") {
      const lockSec = checkThrottle(ip);
      if (lockSec) {
        send(res, 429, loginHtml(`尝试次数过多，请 ${lockSec} 秒后再试`, mfaOn));
        return true;
      }
      const body = await readJsonOrForm(req);
      const pass = String(body.password ?? "");
      const fail = (message) => {
        recordFailure(ip);
        const locked = Boolean(failures.get(ip)?.lockedUntil);
        send(
          res,
          401,
          loginHtml(
            locked ? `密码或动态码错误次数过多，已锁定 ${LOCK_DURATION_MS / 60000} 分钟` : message,
            mfaOn,
          ),
        );
        return true;
      };
      if (!passwordOk(pass)) return fail("管理密码不正确");
      if (totpDoc) {
        const verdict = await verifyAdminCode(totpDoc, body.code);
        if (!verdict.ok) {
          return fail(
            verdict.replay ? "这枚动态码刚用过，请等验证器出下一枚（30 秒内）" : "动态码不正确或已过期",
          );
        }
        await registry.setAdminTotp(verdict.doc);
        if (verdict.recoveryUsed) {
          console.log("[gw-admin] 管理台以恢复码登录（已消耗一枚，剩 %d 枚）", verdict.doc.recovery.length);
        }
      }
      failures.delete(ip);
      await audit(ip, "登录管理台");
      const expiresAt = Date.now() + ADMIN_TTL_MS;
      send(res, 303, "", "text/html; charset=utf-8", {
        location: "/admin",
        "set-cookie": `${ADMIN_COOKIE}=${expiresAt}.${sign(expiresAt, epoch)}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_TTL_MS / 1000}`,
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/admin/logout") {
      if (!sessionFrom(req, epoch)) return false;
      await audit(ip, "退出管理台");
      send(res, 303, "", "text/html; charset=utf-8", {
        location: "/admin",
        "set-cookie": `${ADMIN_COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
      return true;
    }

    if (pathname.startsWith("/admin/api/")) {
      if (!sessionFrom(req, epoch)) {
        sendJson(res, 401, { error: "未登录或会话过期" });
        return true;
      }
      if (pathname.startsWith("/admin/api/update/")) {
        return await handleUpdateApi(req, res, pathname, ip);
      }
      if (pathname === "/admin/api/site") {
        if (req.method === "GET") {
          const site = await registry.getSiteSettings();
          sendJson(res, 200, {
            deepseekKeySet: Boolean(site.deepseekKey),
            deepseekKeyMasked: site.deepseekKey
              ? `${site.deepseekKey.slice(0, 3)}${"•".repeat(8)}${site.deepseekKey.slice(-4)}`
              : "",
            envDeepseekKeySet,
            defaultDailyTurns: defaultDailyTurns,
          });
          return true;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const key = String(body.deepseekKey ?? "").trim();
          if (body.deepseekKey !== undefined && key !== "" && (!key.startsWith("sk-") || key.length < 20)) {
            sendJson(res, 400, { error: "DeepSeek Key 应以 sk- 开头且长度足够" });
            return true;
          }
          await registry.setSiteSettings({ deepseekKey: key });
          console.log(`[gw-admin] 站点 DeepSeek Key 已${key ? "更新" : "清空"}（新拉起的实例生效）`);
          await audit(ip, `站点 DeepSeek Key ${key ? "更新" : "清空"}`);
          sendJson(res, 200, { ok: true });
          return true;
        }
      }
      return await handleApi(req, res, pathname, ip);
    }

    send(res, 404, "not found");
    return true;
  }

  /** 用户条目叠加在线状态与实例详情（在线时带启动/最近活跃/重启次数） */
  function decorateUser(userId) {
    const online = spawner.isRunning(userId);
    if (!online) return { online };
    const running =
      typeof spawner.listRunning === "function"
        ? (spawner.listRunning() ?? []).find((it) => it.userId === userId)
        : undefined;
    if (!running) return { online };
    return {
      online,
      startedAt: new Date(running.startedAt).toISOString(),
      lastRequestAt: new Date(running.lastRequestAt).toISOString(),
      restarts: running.restarts,
    };
  }

  async function ownOverview() {
    const users = await registry.listUsers();
    const today = new Date().toISOString().slice(0, 10);
    const invites = await registry.listInvites();
    const resets = await registry.listResetRequests();
    const usable = (i) =>
      (i.usedBy?.length ?? 0) < (i.maxUses ?? 1) &&
      !(i.expiresAt && new Date(i.expiresAt) < new Date());
    return {
      users: users.length,
      online: spawner.runningCount(),
      capacity,
      invitesLeft: invites.filter(usable).length,
      turnsToday: users.reduce((sum, u) => sum + (u.turns?.date === today ? u.turns.count : 0), 0),
      ownTurnsToday: users.reduce(
        (sum, u) => sum + (u.ownTurns?.date === today ? u.ownTurns.count : 0),
        0,
      ),
      pendingResets: resets.pending.length,
      uptimeSec: Math.round(process.uptime()),
      version,
    };
  }

  async function handleApi(req, res, pathname, ip = "unknown") {
    // ── 两步验证（TOTP）管理：绑定 / 启用 / 关闭 / 恢复码 ─────────
    // 高危动作（关闭、重生成）都要求再验一次动态码：即便会话 Cookie 被劫持，
    // 没有 Authenticator 也降不了安全等级、拿不到新恢复码。
    if (req.method === "POST" && pathname === "/admin/api/totp/setup") {
      if (await registry.getAdminTotp()) {
        sendJson(res, 400, { error: "两步验证已启用，无需重复绑定" });
        return true;
      }
      const secret = generateTotpSecret();
      pendingSetup = { secret, createdAt: Date.now() };
      const uri = otpauthUri({ secret });
      sendJson(res, 200, { secret, uri, qrSvg: await QRCode.toString(uri, { type: "svg", margin: 1 }) });
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/totp/enable") {
      if (await registry.getAdminTotp()) {
        sendJson(res, 400, { error: "两步验证已启用，无需重复绑定" });
        return true;
      }
      if (!pendingSetup || Date.now() - pendingSetup.createdAt > PENDING_SETUP_TTL_MS) {
        pendingSetup = null;
        sendJson(res, 400, { error: "绑定会话已过期，请重新生成二维码" });
        return true;
      }
      const body = await readJsonBody(req);
      const verdict = verifyTotp(pendingSetup.secret, String(body.code ?? "").trim());
      if (!verdict.ok) {
        sendJson(res, 400, { error: "动态码不正确，请确认验证器已添加 CourseRaptor 且手机时间正常" });
        return true;
      }
      const plainCodes = generateRecoveryCodes(10);
      await registry.setAdminTotp({
        secret: pendingSetup.secret,
        enabledAt: new Date().toISOString(),
        recovery: plainCodes.map(hashRecoveryCode),
        // 防重放水位从 -1 起：绑定用的这枚码在跳去登录时还能用（30 秒窗口），
        // 首次登录消耗后防重放才收紧——避免「刚启用就被拒」的困惑
        lastUsedCounter: -1,
        // 0 → 1：即刻注销启用前签发的所有管理会话（含当前这个）
        sessionEpoch: 1,
      });
      pendingSetup = null;
      console.log("[gw-admin] 管理台两步验证已启用（TOTP），恢复码已生成");
      await audit(ip, "启用两步验证（TOTP）");
      sendJson(res, 200, { ok: true, recoveryCodes: plainCodes });
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/totp/disable") {
      const doc = await registry.getAdminTotp();
      if (!doc) {
        sendJson(res, 400, { error: "两步验证未启用" });
        return true;
      }
      const body = await readJsonBody(req);
      const verdict = await verifyAdminCode(doc, body.code);
      if (!verdict.ok) {
        recordFailure(ip);
        sendJson(res, 401, {
          error: verdict.replay ? "这枚动态码刚用过，请等验证器出下一枚（30 秒内）" : "动态码不正确或已过期",
        });
        return true;
      }
      await registry.clearAdminTotp();
      pendingSetup = null;
      console.log("[gw-admin] 管理台两步验证已关闭（恢复仅密码登录）");
      await audit(ip, "关闭两步验证");
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/totp/recovery") {
      const doc = await registry.getAdminTotp();
      if (!doc) {
        sendJson(res, 400, { error: "两步验证未启用" });
        return true;
      }
      const body = await readJsonBody(req);
      const verdict = await verifyAdminCode(doc, body.code);
      if (!verdict.ok) {
        recordFailure(ip);
        sendJson(res, 401, {
          error: verdict.replay ? "这枚动态码刚用过，请等验证器出下一枚（30 秒内）" : "动态码不正确或已过期",
        });
        return true;
      }
      const plainCodes = generateRecoveryCodes(10);
      await registry.setAdminTotp({ ...verdict.doc, recovery: plainCodes.map(hashRecoveryCode) });
      console.log("[gw-admin] 管理台恢复码已重新生成（旧恢复码全部作废）");
      await audit(ip, "重新生成恢复码");
      sendJson(res, 200, { ok: true, recoveryCodes: plainCodes });
      return true;
    }

    // 一次往返带回全部面板数据：跨公网链路 RTT 大，串行请求是「卡」的主因
    if (req.method === "GET" && pathname === "/admin/api/bootstrap") {
      const [overview, users, invites, site, resets, totp, updOverview, updVersions, updKeys, log] =
        await Promise.all([
          ownOverview(),
          registry.listUsers(),
          registry.listInvites(),
          registry.getSiteSettings(),
          registry.listResetRequests(),
          registry.getAdminTotp(),
          callUpdateApi("GET", "/admin/api/overview"),
          callUpdateApi("GET", "/admin/api/versions"),
          callUpdateApi("GET", "/admin/api/keys"),
          registry.listAdminLog(),
        ]);
      sendJson(res, 200, {
        overview,
        users: users.map((u) => ({ ...u, ...decorateUser(u.id) })),
        invites,
        resets,
        security: {
          mfaEnabled: Boolean(totp),
          enabledAt: totp?.enabledAt ?? "",
          recoveryLeft: totp?.recovery?.length ?? 0,
        },
        site: {
          deepseekKeySet: Boolean(site.deepseekKey),
          deepseekKeyMasked: site.deepseekKey
            ? `${site.deepseekKey.slice(0, 3)}${"•".repeat(8)}${site.deepseekKey.slice(-4)}`
            : "",
          envDeepseekKeySet,
          defaultDailyTurns,
        },
        update: { overview: updOverview, versions: updVersions, keys: updKeys },
        log,
      });
      return true;
    }

    // 密码重置审批：同意即生成一次性码——管理员只经手码，不知道新密码
    if (req.method === "POST" && pathname === "/admin/api/reset/approve") {
      const body = await readJsonBody(req);
      try {
        const result = await registry.approveResetRequest(String(body.id ?? ""));
        console.log(`[gw-admin] 同意 ${result.username} 的重置申请，一次性码已生成（24h 有效）`);
        await audit(ip, `同意 ${result.username} 的密码重置申请`);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/reset/reject") {
      const body = await readJsonBody(req);
      try {
        await registry.rejectResetRequest(String(body.id ?? ""));
        await audit(ip, `拒绝密码重置申请 ${String(body.id ?? "")}`);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (req.method === "GET" && pathname === "/admin/api/overview") {
      sendJson(res, 200, await ownOverview());
      return true;
    }
    if (req.method === "GET" && pathname === "/admin/api/users") {
      const users = await registry.listUsers();
      sendJson(res, 200, users.map((u) => ({ ...u, ...decorateUser(u.id) })));
      return true;
    }
    if (req.method === "GET" && pathname === "/admin/api/invites") {
      sendJson(res, 200, await registry.listInvites());
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/invite") {
      const body = await readJsonBody(req);
      const created = await registry.createInvites({
        count: Math.max(1, Math.min(Number(body.count) || 1, 50)),
        note: String(body.note ?? "").slice(0, 100),
        expiresDays: Math.max(0, Math.min(Number(body.days) || 0, 365)),
      });
      console.log(`[gw-admin] 生成 ${created.length} 个邀请码${body.note ? `（${body.note}）` : ""}`);
      await audit(ip, `生成 ${created.length} 个邀请码${body.note ? `（${body.note}）` : ""}`);
      sendJson(res, 200, { ok: true, created });
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/invite/delete") {
      const body = await readJsonBody(req);
      try {
        await registry.deleteInvite(String(body.code ?? ""));
        console.log(`[gw-admin] 删除邀请码 ${String(body.code ?? "")}`);
        await audit(ip, `删除邀请码 ${String(body.code ?? "")}`);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/user/create") {
      const body = await readJsonBody(req);
      try {
        const user = await registry.createUser({
          username: String(body.username ?? "").trim(),
          password: String(body.password ?? ""),
        });
        console.log(`[gw-admin] 新建用户 ${user.username}（${user.id}）`);
        await audit(ip, `新建用户 ${user.username}`);
        sendJson(res, 200, { ok: true, user });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (req.method === "POST" && pathname.startsWith("/admin/api/user/")) {
      const action = pathname.slice("/admin/api/user/".length);
      const body = await readJsonBody(req);
      const target = String(body.user ?? "");
      const user = (await registry.findUserById(target)) ?? (await registry.findUserByName(target));
      if (!user) {
        sendJson(res, 404, { error: "用户不存在" });
        return true;
      }
      if (action === "quota") {
        try {
          await registry.setDailyTurns(user.id, body.turns);
          console.log(`[gw-admin] ${user.username} 每日限额 → ${Number(body.turns) || 0}`);
          await audit(ip, `${user.username} 每日限额 → ${Number(body.turns) || 0}`);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          return true;
        }
      } else if (action === "disable" || action === "enable") {
        await registry.setDisabled(user.id, action === "disable");
        console.log(`[gw-admin] ${action} ${user.username}`);
        await audit(ip, `${action === "disable" ? "停用" : "启用"} ${user.username}`);
      } else if (action === "kick") {
        spawner.kick(user.id);
        console.log(`[gw-admin] kick ${user.username}`);
        await audit(ip, `回收 ${user.username} 的实例`);
      } else if (action === "reset-pass") {
        try {
          await registry.setPassword(user.id, String(body.password ?? ""));
          console.log(`[gw-admin] reset-pass ${user.username}`);
          await audit(ip, `重置 ${user.username} 的密码`);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          return true;
        }
      } else if (action === "delete") {
        // 顺序：先回收实例，再除名，最后清数据目录（含加密凭证）
        spawner.kick(user.id);
        try {
          await registry.deleteUser(user.id);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          return true;
        }
        if (usersDir) {
          await rm(path.join(usersDir, user.id), { recursive: true, force: true }).catch(() => {});
        }
        console.log(`[gw-admin] 删除用户 ${user.username}（${user.id}）及其数据目录`);
        await audit(ip, `删除用户 ${user.username}（含数据目录）`);
      } else {
        sendJson(res, 404, { error: "未知操作" });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === "GET" && pathname === "/admin/api/log") {
      sendJson(res, 200, await registry.listAdminLog());
      return true;
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  }

  /** 版本发布段：全部代理到更新后台，鉴权由网关管理会话承担 */
  async function handleUpdateApi(req, res, pathname, ip = "unknown") {
    if (req.method !== "GET" && req.method !== "POST") {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
    if (pathname === "/admin/api/update/overview") {
      sendJson(res, 200, await callUpdateApi("GET", "/admin/api/overview"));
      return true;
    }
    if (pathname === "/admin/api/update/versions") {
      sendJson(res, 200, await callUpdateApi("GET", "/admin/api/versions"));
      return true;
    }
    // 上传发版：浏览器请求体原样流式转发到更新后台 /publish，不在网关落盘。
    // 200 MB 与更新后台 MAX_PACKAGE_BODY 一致；大包上传远超 callUpdateApi 的 5s 超时，单独放宽。
    if (req.method === "POST" && pathname === "/admin/api/update/publish") {
      const version = String(req.headers["x-version"] ?? "");
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        sendJson(res, 400, { error: "x-version 必须是 x.y.z" });
        return true;
      }
      if (!updateServerUrl || !updateAdminToken) {
        sendJson(res, 400, { error: "更新后台未接入（网关未配置 GATEWAY_UPDATE_URL / GATEWAY_UPDATE_TOKEN）" });
        return true;
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_PACKAGE_BYTES) {
        sendJson(res, 413, { error: "安装包超过 200 MB 上限" });
        return true;
      }
      try {
        const upstream = await fetch(`${updateServerUrl.replace(/\/$/, "")}/publish`, {
          method: "POST",
          headers: {
            "x-admin-token": updateAdminToken,
            "x-version": version,
            // 更新后台期望「URI 编码后的 x-notes」再自行解码；浏览器侧已编码，这里原样透传，不二次编码
            "x-notes": String(req.headers["x-notes"] ?? ""),
            "content-type": "application/zip",
          },
          body: req,
          duplex: "half",
          signal: AbortSignal.timeout(30 * 60_000),
        });
        const data = await upstream.json().catch(() => ({}));
        console.log(`[gw-admin] 发版 v${version}: ${upstream.ok ? "ok" : data?.error ?? upstream.status}`);
        await audit(ip, `发版 v${version}${upstream.ok ? "" : "（失败）"}`);
        if (!upstream.ok) {
          sendJson(res, upstream.status === 401 ? 502 : upstream.status, {
            error: data?.error ?? `更新后台返回 ${upstream.status}`,
          });
          return true;
        }
        sendJson(res, 200, data);
      } catch (error) {
        // 浏览器中途取消时 req 流出错，同样落在这里；响应无人接收，安全
        sendJson(res, 502, { error: `更新后台不可达：${error instanceof Error ? error.message : String(error)}` });
      }
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/update/rollback") {
      const body = await readJsonBody(req);
      const result = await callUpdateApi("POST", "/admin/api/rollback", {
        version: String(body.version ?? ""),
      });
      console.log(`[gw-admin] 版本回滚请求 v${body.version}: ${result.error ?? "ok"}`);
      await audit(ip, `版本回滚 → v${body.version}${result.error ? "（失败）" : ""}`);
      sendJson(res, result.error ? 400 : 200, result);
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/update/delete") {
      const body = await readJsonBody(req);
      const result = await callUpdateApi("POST", "/admin/api/delete", {
        version: String(body.version ?? ""),
      });
      console.log(`[gw-admin] 版本删除请求 v${body.version}: ${result.error ?? "ok"}`);
      await audit(ip, `删除版本 v${body.version}${result.error ? "（失败）" : ""}`);
      sendJson(res, result.error ? 400 : 200, result);
      return true;
    }
    // 密钥管理：同样全部代理到更新后台，明文令牌只在创建响应里出现一次
    if (pathname === "/admin/api/update/keys") {
      if (req.method === "GET") {
        sendJson(res, 200, await callUpdateApi("GET", "/admin/api/keys"));
        return true;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await callUpdateApi("POST", "/admin/api/keys", {
          name: String(body.name ?? ""),
        });
        console.log(`[gw-admin] 新建更新后台密钥「${result.data?.key?.name ?? ""}」: ${result.error ?? "ok"}`);
        await audit(ip, `新建更新后台密钥「${result.data?.key?.name ?? ""}」${result.error ? "（失败）" : ""}`);
        sendJson(res, result.error ? 400 : 200, result);
        return true;
      }
    }
    if (req.method === "POST" && pathname === "/admin/api/update/keys/delete") {
      const body = await readJsonBody(req);
      const result = await callUpdateApi("POST", "/admin/api/keys/delete", {
        id: String(body.id ?? ""),
      });
      console.log(`[gw-admin] 删除更新后台密钥 ${String(body.id ?? "")}: ${result.error ?? "ok"}`);
      await audit(ip, `删除更新后台密钥 ${String(body.id ?? "")}${result.error ? "（失败）" : ""}`);
      sendJson(res, result.error ? 400 : 200, result);
      return true;
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  }

  /** 登录表单是 application/x-www-form-urlencoded，其余是 JSON */
  async function readJsonOrForm(req) {
    if (String(req.headers["content-type"] ?? "").includes("application/json")) {
      return readJsonBody(req);
    }
    const chunks = [];
    let size = 0;
    return new Promise((resolve, reject) => {
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_JSON_BODY) {
          reject(new Error("请求体过大"));
          req.destroy();
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const out = {};
        for (const [k, v] of params) out[k] = v;
        resolve(out);
      });
      req.on("error", reject);
    });
  }

  return { handle };
}
