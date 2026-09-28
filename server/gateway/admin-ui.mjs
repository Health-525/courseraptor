/**
 * 多用户网关的网页版管理后台（挂在网关的 /admin 路径，与同学入口同端口）。
 *
 * 启用方式：环境变量 GATEWAY_ADMIN_PASSWORD（至少 8 位）；未设置时 /admin
 * 显示「未启用」说明页，管理动作一律 404，只能继续用 admin.mjs 命令行。
 *
 * 鉴权：独立的管理会话 Cookie（raptor_admin，HMAC 签名与同学会话不同名
 * 不同签名域，互不通用）；登录失败同样 5 次锁 15 分钟。页面与 /admin/api/*
 * 与登录/注册页同一套「红头档案」设计令牌。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const ADMIN_COOKIE = "raptor_admin";
const ADMIN_TTL_MS = 12 * 3600_000;
const MAX_JSON_BODY = 16 * 1024;
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

/** 与 app.mjs 同族的红头档案设计令牌（管理台多一套表格/统计卡样式） */
const CSS = `
:root{color-scheme:light;
--paper:#F6F4ED;--paper-deep:#F0EDE4;--card:#FCFBF7;--shade:#ECE8DD;
--ink:#25221C;--ink-2:#5A554A;--ink-3:#6E6656;
--rule:#E1DCCF;--rule-2:#C9C1AF;
--accent:#AD392C;--accent-deep:#852B22;--accent-soft:#F3E3DE;--accent-line:#E4C4BB;
--ok:#3D6B4F;--ok-soft:#E4EEE7;
--shadow-sm:0 8px 24px rgba(50,42,31,.055);
--serif:Georgia,"Times New Roman","Songti SC",SimSun,serif;
--kai:"KaiTi","STKaiti","Kaiti SC",var(--serif);
--sans:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
--mono:ui-monospace,"Cascadia Mono",Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}
::selection{background:var(--accent-soft)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
body{margin:0;min-height:100vh;display:grid;place-items:start center;
padding:34px 18px 60px;background:var(--paper);color:var(--ink);
font-family:var(--sans);font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased}
.sheet{width:min(860px,100%)}
.mast{text-align:center;padding-bottom:20px;position:relative;border-bottom:1px solid var(--rule-2)}
.mast::after{content:"";position:absolute;left:12%;right:12%;bottom:3px;height:2px;background:var(--accent)}
.mast img{width:60px;height:60px;object-fit:contain;display:block;margin:0 auto 8px}
.wordmark{margin:0;font-size:21px;line-height:1.2;letter-spacing:-.035em;font-weight:500}
.wordmark .course{color:var(--ink-2)}
.wordmark .raptor{color:var(--accent);font-weight:750}
.wordmark .badge{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.14em;
color:var(--accent-deep);background:var(--accent-soft);border:1px solid var(--accent-line);
border-radius:2px;padding:2px 8px;margin-left:10px;vertical-align:3px}
.tagline{margin:5px 0 0;font-family:var(--kai);font-size:13.5px;color:var(--ink-3);letter-spacing:.06em}
h2{display:flex;justify-content:space-between;align-items:baseline;margin:26px 0 14px;
padding-bottom:8px;font-family:var(--mono);font-size:12.5px;font-weight:600;
letter-spacing:.18em;color:var(--ink-2);border-bottom:1px solid var(--rule)}
h2 .en{font-weight:400;font-size:11px;letter-spacing:.08em;color:var(--ink-3)}
h2 .act{font-weight:400;letter-spacing:.04em}
h2 .act a{color:var(--accent);text-decoration:none;border-bottom:1px solid var(--accent-line);cursor:pointer}
/* 统计卡 */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.stat{background:var(--card);border:1px solid var(--rule);border-radius:3px;
box-shadow:var(--shadow-sm);padding:14px 16px 11px;text-align:center}
.stat .n{font-family:var(--mono);font-size:26px;font-weight:600;letter-spacing:-.02em;color:var(--ink)}
.stat .n.hot{color:var(--accent)}
.stat .t{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;color:var(--ink-3);margin-top:2px}
/* 表格 */
table{width:100%;border-collapse:collapse;background:var(--card);
border:1px solid var(--rule);box-shadow:var(--shadow-sm)}
th{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.12em;
color:var(--ink-3);text-align:left;padding:10px 12px;background:var(--paper-deep);
border-bottom:1px solid var(--rule-2)}
td{padding:9px 12px;border-bottom:1px solid var(--rule);vertical-align:middle}
tr:last-child td{border-bottom:0}
tr:hover td{background:var(--paper-deep)}
.mono{font-family:var(--mono);font-size:13px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok);
margin-right:6px;vertical-align:1px}
.dot.off{background:var(--rule-2)}
.pill{font-family:var(--mono);font-size:11px;letter-spacing:.08em;border-radius:2px;
padding:1px 8px;border:1px solid var(--ok-soft);background:var(--ok-soft);color:var(--ok)}
.pill.bad{border-color:var(--accent-line);background:var(--accent-soft);color:var(--accent-deep)}
button.act,button.primary{border-radius:2px;cursor:pointer;font-family:var(--sans);
transition:background .15s ease,color .15s ease,border-color .15s ease}
button.act{background:none;border:1px solid var(--rule-2);color:var(--ink-2);
font-size:12px;padding:4px 10px;margin-right:6px}
button.act:hover{border-color:var(--accent);color:var(--accent)}
button.act.danger:hover{border-color:var(--accent-deep);background:var(--accent-soft);color:var(--accent-deep)}
button.primary{display:block;width:100%;margin-top:22px;padding:12px;background:var(--accent);
color:var(--card);border:1px solid var(--accent);font-size:15px;font-weight:600;letter-spacing:.14em}
button.primary:hover{background:var(--accent-deep);border-color:var(--accent-deep);color:#fff}
input{width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--rule-2);
border-radius:2px;font-family:var(--sans);font-size:15px;color:var(--ink);
transition:border-color .15s ease,box-shadow .15s ease}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
label{display:block;margin:14px 0 6px;font-family:var(--mono);font-size:11px;
font-weight:600;letter-spacing:.12em;color:var(--ink-3)}
.card{background:var(--card);border:1px solid var(--rule);border-radius:3px;
box-shadow:var(--shadow-sm);padding:24px 26px 22px}
.notice{margin:0 0 4px;padding:9px 12px;background:var(--accent-soft);border:1px solid var(--accent-line);
border-radius:2px;color:var(--accent-deep);font-size:13.5px;line-height:1.6}
.inv-row{display:flex;gap:10px;flex-wrap:wrap}
.inv-row input{flex:1;min-width:120px}
.inv-row .num{max-width:90px;text-align:center}
.empty{padding:26px 0;text-align:center;color:var(--ink-3);font-size:13.5px}
.copy-ok{color:var(--ok);font-family:var(--mono);font-size:11px;margin-left:8px}
/* ── 管理台应用壳：全高侧栏（主流 admin 结构）+ 滚动内容区，红头档案皮肤 ── */
body.app{display:grid;grid-template-columns:236px 1fr;place-items:stretch;
height:100vh;height:100dvh;overflow:hidden;padding:0}
aside.side{display:flex;flex-direction:column;min-height:0;
background:var(--paper-deep);border-right:1px solid var(--rule-2)}
.side-brand{padding:20px 16px 15px;text-align:center;border-bottom:1px solid var(--rule-2);
position:relative}
.side-brand::after{content:"";position:absolute;left:14%;right:14%;bottom:3px;height:2px;
background:var(--accent)}
.side-brand img{width:42px;height:42px;object-fit:contain;display:block;margin:0 auto 6px}
.side-brand .wordmark{margin:0;font-size:17px;line-height:1.2;letter-spacing:-.03em;font-weight:500}
.side-brand .badge{display:inline-block;margin-top:7px;font-family:var(--mono);font-size:9.5px;
font-weight:600;letter-spacing:.16em;color:var(--accent-deep);background:var(--accent-soft);
border:1px solid var(--accent-line);border-radius:2px;padding:2px 8px}
nav.groups{flex:1;min-height:0;overflow-y:auto;padding:16px 12px 10px;
display:flex;flex-direction:column;gap:20px}
.g-label{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.18em;
color:var(--ink-3);padding:0 10px;margin:0 0 6px}
.nav-item{display:flex;align-items:center;gap:11px;width:100%;text-align:left;
background:none;border:0;border-left:2px solid transparent;border-radius:2px;
padding:8px 10px;font-family:var(--sans);font-size:13.5px;color:var(--ink-2);
cursor:pointer;transition:background .12s ease,color .12s ease}
.nav-item svg{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;
stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.nav-item:hover{background:var(--shade);color:var(--ink)}
.nav-item.on{background:var(--accent-soft);color:var(--accent-deep);
border-left-color:var(--accent);font-weight:600}
.side-uptime{padding:8px 16px;font-family:var(--mono);font-size:10px;
letter-spacing:.06em;color:var(--ink-3);border-top:1px solid var(--rule)}
.side-foot{display:flex;gap:8px;padding:10px 12px 14px}
.side-foot button{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;
background:none;border:1px solid var(--rule-2);border-radius:2px;padding:7px 0;
font-family:var(--sans);font-size:12px;color:var(--ink-2);cursor:pointer;
transition:border-color .12s ease,color .12s ease}
.side-foot button svg{width:13px;height:13px;stroke:currentColor;fill:none;
stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.side-foot button:hover{border-color:var(--accent);color:var(--accent)}
main.content{min-width:0;overflow-y:auto;padding:26px 30px 64px}
.content-inner{max-width:960px}
section.pane .panel{display:none}
section.pane .panel.on{display:block}
@media (max-width:840px){
body.app{grid-template-columns:1fr;grid-template-rows:auto 1fr}
aside.side{border-right:0;border-bottom:1px solid var(--rule-2)}
.side-brand{padding:12px 16px 10px}
.side-brand img{width:28px;height:28px;display:inline-block;vertical-align:-8px;margin:0 6px 0 0}
nav.groups{flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:6px;padding:8px 12px}
.g-label{display:none}
.nav-item{border-left:0;border:1px solid var(--rule-2);padding:6px 12px;white-space:nowrap}
.nav-item.on{border-color:var(--accent-line)}
.side-uptime{display:none}
}
@media (max-width:720px){.stats{grid-template-columns:repeat(2,1fr)}}
`;

const shell = (title, body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/logo.png">
<title>${escapeHtml(title)} · CourseRaptor 管理</title><style>${CSS}</style></head><body>
<main class="sheet">
<header class="mast">
<img src="/logo.png" alt="">
<h1 class="wordmark"><span class="course">Course</span><span class="raptor">Raptor</span><span class="badge">ADMIN 管理台</span></h1>
<p class="tagline">班级互助服务 · 多用户网关</p>
</header>
${body}
</main></body></html>`;

const loginHtml = (error = "") =>
  shell(
    "管理登录",
    `<section style="width:min(400px,100%);margin:26px auto 0" class="card">
${error ? `<div class="notice">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/admin/login">
<label>管理密码 PASSWORD</label>
<input name="password" type="password" autocomplete="current-password" required autofocus placeholder="请输入管理密码">
<button type="submit" class="primary">进入管理台</button>
</form></section>`,
  );

const disabledHtml = () =>
  shell(
    "未启用",
    `<section style="width:min(460px,100%);margin:26px auto 0" class="card">
<div class="notice">管理后台未启用：服务器未设置 <span class="mono">GATEWAY_ADMIN_PASSWORD</span>。</div>
<p style="color:var(--ink-2)">在 <span class="mono">/etc/raptor-gateway.env</span> 加入该变量并
<span class="mono">systemctl restart raptor-gateway</span> 即可开启；期间可继续用
<span class="mono">admin.mjs</span> 命令行管理。</p></section>`,
  );

const dashboardHtml = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/logo.png">
<title>管理台 · CourseRaptor</title><style>${CSS}</style></head><body class="app">
<aside class="side">
<div class="side-brand">
<img src="/logo.png" alt="">
<h1 class="wordmark"><span class="course">Course</span><span class="raptor">Raptor</span></h1>
<div><span class="badge">ADMIN 管理台</span></div>
</div>
<nav class="groups">
<div class="nav-group">
<div class="g-label">日 常 · DAILY</div>
<button type="button" class="nav-item on" data-nav="overview">
<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
总览</button>
<button type="button" class="nav-item" data-nav="users">
<svg viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7"/><path d="M16 3.5a4 4 0 0 1 0 7"/><path d="M17 14c2.8.5 5 3 5 6.2"/></svg>
同学账号</button>
</div>
<div class="nav-group">
<div class="g-label">发 版 · RELEASES</div>
<button type="button" class="nav-item" data-nav="release">
<svg viewBox="0 0 24 24"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>
版本发布</button>
</div>
</nav>
<div class="side-uptime" id="uptimeLine">网关运行中…</div>
<div class="side-foot">
<button type="button" id="refresh">
<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
刷新</button>
<button type="button" id="logout">
<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
退出</button>
</div>
</aside>
<main class="content"><div class="content-inner">
<section class="pane">
<div class="panel on" id="pane-overview">
<h2>总览<span class="en">OVERVIEW</span></h2>
<div class="stats" id="stats"></div>
<h2>运行状态<span class="en">STATUS</span></h2>
<div class="card" id="statusCard"><p class="empty">加载中…</p></div>
</div>

<div class="panel" id="pane-users">
<h2>同学账号<span class="en">USERS</span></h2>
<table><thead><tr><th>用户名</th><th>状态</th><th>在线</th><th>注册于</th><th>今日轮数</th><th>操作</th></tr></thead>
<tbody id="users"><tr><td colspan="6" class="empty">加载中…</td></tr></tbody></table>

<h2>邀请码<span class="en">INVITES</span><span class="act mono" style="font-size:11px">发给同学，凭码注册</span></h2>
<div class="card">
<div class="inv-row">
<input class="num" id="invCount" type="number" min="1" max="50" value="5" title="数量">
<input id="invNote" placeholder="备注（如：班级群）">
<input class="num" id="invDays" type="number" min="0" max="365" value="0" title="有效天数，0=永久">
<button class="act" id="invGen" type="button" style="margin:0;padding:8px 18px">生成</button>
</div>
<table style="margin-top:14px;box-shadow:none"><thead><tr><th>邀请码</th><th>备注</th><th>状态</th><th></th></tr></thead>
<tbody id="invites"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody></table>
</div>
</div>

<div class="panel" id="pane-release">
<h2>版本发布<span class="en">RELEASES</span><span class="act mono" style="font-size:11px" id="updCur"></span></h2>
<div class="card" id="updCard"><p class="empty">加载中…</p></div>
</div>
</section>
</div></main>

<script>
(function () {
"use strict";
var tabs = document.querySelectorAll("nav.groups .nav-item");
for (var i = 0; i < tabs.length; i++) {
tabs[i].addEventListener("click", function () {
for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove("on");
this.classList.add("on");
var panels = document.querySelectorAll(".pane .panel");
for (var k = 0; k < panels.length; k++) panels[k].classList.remove("on");
var target = document.getElementById("pane-" + this.getAttribute("data-nav"));
if (target) target.classList.add("on");
});
}
function api(path, body) {
var opts = body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {};
return fetch(path, opts).then(function (r) {
if (r.status === 401) { location.href = "/admin"; return null; }
return r.json();
});
}
function esc(s) { var d = document.createElement("div"); d.textContent = String(s == null ? "" : s); return d.innerHTML; }
function fmtDate(iso) { return String(iso || "").slice(0, 10); }
function renderOverview(o) {
if (!o) return;
document.getElementById("stats").innerHTML =
'<div class="stat"><div class="n">' + o.users + '</div><div class="t">注册同学</div></div>' +
'<div class="stat"><div class="n hot">' + o.online + "/" + o.capacity + '</div><div class="t">在线/并发上限</div></div>' +
'<div class="stat"><div class="n">' + o.invitesLeft + '</div><div class="t">可用邀请码</div></div>' +
'<div class="stat"><div class="n hot">' + o.turnsToday + '</div><div class="t">今日对话轮数</div></div>';
var up = o.uptimeSec || 0;
var upText = up >= 86400 ? Math.floor(up / 86400) + " 天 " + Math.floor((up % 86400) / 3600) + " 小时"
: up >= 3600 ? Math.floor(up / 3600) + " 小时 " + Math.floor((up % 3600) / 60) + " 分"
: Math.floor(up / 60) + " 分钟";
document.getElementById("uptimeLine").textContent =
"运行 " + upText + " · " + o.online + "/" + o.capacity + " 在线";
document.getElementById("statusCard").innerHTML =
'<p class="lead" style="margin-top:2px"><span class="dot' + (o.online > 0 ? "" : " off") + '"></span>网关已连续运行 ' + esc(upText) +
'，当前 ' + o.online + ' 个实例在线' + (o.online > 0 ? "" : "（空闲时不占内存）") + '。</p>' +
'<p style="color:var(--ink-3);font-size:13px;margin:4px 0 0">实例按需拉起、空闲 30 分钟自动回收；每日每人对话限额可在服务器 env 调整（GATEWAY_DAILY_TURNS）。</p>';
}
function renderUsers(list) {
if (!list) return;
var el = document.getElementById("users");
if (!list.length) { el.innerHTML = '<tr><td colspan="6" class="empty">还没有同学注册</td></tr>'; return; }
el.innerHTML = list.map(function (u) {
var status = u.disabled ? '<span class="pill bad">已停用</span>' : '<span class="pill">正常</span>';
var online = u.online ? '<span class="dot"></span>在线' : '<span class="dot off"></span>—';
var acts = '';
if (u.disabled) { acts += '<button class="act" data-do="enable" data-u="' + esc(u.username) + '">启用</button>'; }
else { acts += '<button class="act danger" data-do="disable" data-u="' + esc(u.username) + '">停用</button>'; }
if (u.online) { acts += '<button class="act" data-do="kick" data-u="' + esc(u.username) + '">踢下线</button>'; }
acts += '<button class="act" data-do="reset-pass" data-u="' + esc(u.username) + '">重置密码</button>';
return '<tr><td class="mono">' + esc(u.username) + '</td><td>' + status + '</td><td>' + online +
'</td><td class="mono">' + fmtDate(u.createdAt) + '</td><td class="mono">' + u.turns.count +
'</td><td>' + acts + '</td></tr>';
}).join("");
}
function renderInvites(list) {
if (!list) return;
var el = document.getElementById("invites");
if (!list.length) { el.innerHTML = '<tr><td colspan="4" class="empty">暂无邀请码，用上方表单生成</td></tr>'; return; }
el.innerHTML = list.map(function (i) {
var used = (i.usedBy || []).length >= (i.maxUses || 1);
var status = used ? '<span class="pill">已被 ' + esc((i.usedBy || [])[0] || "") + ' 使用</span>'
: (i.expiresAt ? '<span class="pill bad">' + fmtDate(i.expiresAt) + ' 前有效</span>' : '<span class="pill">未使用</span>');
var copy = used ? "" : '<button class="act" data-copy="' + esc(i.code) + '" type="button">复制</button>';
return '<tr><td class="mono">' + esc(i.code) + '</td><td>' + esc(i.note || "—") +
'</td><td>' + status + '</td><td>' + copy + '</td></tr>';
}).join("");
}
function renderUpdate(o, v) {
var cur = document.getElementById("updCur");
var card = document.getElementById("updCard");
if (!o) return;
if (o.unavailable || o.error) {
cur.textContent = "";
card.innerHTML = '<div class="notice">' + esc(o.error || "更新后台未接入") + '</div>' +
'<p style="color:var(--ink-2);font-size:13px">在网关环境变量配置 GATEWAY_UPDATE_URL 与 GATEWAY_UPDATE_TOKEN，并部署更新后台（server/update-server.mjs）后，这里会显示版本列表与回滚操作。</p>';
return;
}
var c = o.data && o.data.current;
cur.textContent = c ? ("当前 v" + c.version + " · " + fmtDate(c.publishedAt)) : "尚未发布过版本";
if (!v || v.error || v.unavailable) { card.innerHTML = '<p class="empty">' + esc((v && (v.error || "无版本")) || "无版本") + '</p>'; return; }
var list = v.data.versions || [];
if (!list.length) { card.innerHTML = '<p class="empty">还没有发布过版本；在维护者机器上 npm run publish 即可发版</p>'; return; }
var mb = function (n) { return (n / 1048576).toFixed(1) + " MB"; };
card.innerHTML = '<table style="box-shadow:none"><thead><tr><th>版本</th><th>说明</th><th>发布时间</th><th>大小</th><th>操作</th></tr></thead><tbody>' +
list.map(function (r) {
var tag = r.isCurrent ? ' <span class="pill">分发中</span>' : (r.rolledBackAt ? ' <span class="pill bad">已回滚</span>' : "");
var acts = r.isCurrent ? "" :
'<button class="act" data-udo="rollback" data-ver="' + esc(r.version) + '">设为分发</button>' +
'<button class="act danger" data-udo="delete" data-ver="' + esc(r.version) + '">删除</button>';
return '<tr><td class="mono">v' + esc(r.version) + tag + '</td><td>' + esc(r.notes || "—") +
'</td><td class="mono">' + fmtDate(r.publishedAt) + '</td><td class="mono">' + mb(r.sizeBytes || 0) +
'</td><td>' + acts + '</td></tr>';
}).join("") + '</tbody></table>';
}
function load() {
api("/admin/api/bootstrap").then(function (b) {
if (!b) return;
renderOverview(b.overview);
renderUsers(b.users);
renderInvites(b.invites);
renderUpdate(b.update.overview, b.update.versions);
});
}
document.addEventListener("click", function (e) {
var t = e.target.closest ? e.target.closest("button,a") : null;
if (!t) return;
if (t.id === "refresh") { load(); return; }
if (t.id === "logout") { api("/admin/logout", {}).then(function () { location.href = "/admin"; }); return; }
if (t.id === "invGen") {
api("/admin/api/invite", {
count: Number(document.getElementById("invCount").value) || 1,
note: document.getElementById("invNote").value,
days: Number(document.getElementById("invDays").value) || 0,
}).then(load);
return;
}
if (t.hasAttribute("data-copy")) {
var code = t.getAttribute("data-copy");
navigator.clipboard.writeText(code).then(function () {
t.textContent = "已复制"; t.className = "copy-ok";
});
return;
}
var doWhat = t.getAttribute("data-do");
var user = t.getAttribute("data-u");
var updWhat = t.getAttribute("data-udo");
var version = t.getAttribute("data-ver");
if (updWhat && version) {
var vt = updWhat === "rollback" ? "把 v" + version + " 设为当前分发版本（同学端将收到它），确认？"
: "删除 v" + version + " 的安装包（不可恢复，当前分发版本不能删），确认？";
if (!confirm(vt)) return;
api("/admin/api/update/" + updWhat, { version: version }).then(function (r) {
if (r && (r.error || r.unavailable)) { alert(r.error || "更新后台不可达"); return; }
load();
});
return;
}
if (!doWhat || !user) return;
if (doWhat === "reset-pass") {
var pw = prompt("给 " + user + " 设置新密码（至少 8 位）：");
if (!pw) return;
api("/admin/api/user/reset-pass", { user: user, password: pw }).then(function (r) {
alert(r && r.ok ? "已重置" : (r && r.error) || "失败"); load();
});
return;
}
var confirmText = doWhat === "disable" ? "停用后该同学将立即无法登录，确认？" : "踢下线后该同学的实例立即回收，确认？";
if (!confirm(confirmText)) return;
api("/admin/api/user/" + doWhat, { user: user }).then(load);
});
load();
})();
</script>
</body></html>`;

export function createAdminUi({
  registry,
  spawner,
  secret,
  password,
  capacity = 0,
  updateServerUrl = "",
  updateAdminToken = "",
}) {
  const enabled = typeof password === "string" && password.length >= 8;
  const failures = new Map();

  /**
   * 代理访问同机部署的更新分发后台（server/update-server.mjs，回环端口）。
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

  function sign(expiresAt) {
    return createHmac("sha256", secret).update(`admin.${expiresAt}`).digest("hex");
  }

  function sessionFrom(req) {
    const raw = req.headers.cookie;
    if (typeof raw !== "string") return null;
    const match = /(?:^|;\s*)raptor_admin=([^;]+)/.exec(raw);
    if (!match) return null;
    const [expiresAt, mac] = match[1].split(".");
    if (!expiresAt || !mac) return null;
    const expected = sign(expiresAt);
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

  function send(res, status, body, type = "text/html; charset=utf-8", extra = {}) {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
    res.end(body);
  }

  const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

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

    if (req.method === "GET" && pathname === "/admin") {
      send(res, 200, sessionFrom(req) ? dashboardHtml() : loginHtml());
      return true;
    }

    if (req.method === "POST" && pathname === "/admin/login") {
      const lockSec = checkThrottle(ip);
      if (lockSec) {
        send(res, 429, loginHtml(`尝试次数过多，请 ${lockSec} 秒后再试`));
        return true;
      }
      const body = await readJsonOrForm(req);
      const pass = String(body.password ?? "");
      if (!passwordOk(pass)) {
        const now = Date.now();
        const record = failures.get(ip);
        const count = (record?.count ?? 0) + 1;
        const lockedUntil = count >= FAILURES_TO_LOCK ? now + LOCK_DURATION_MS : 0;
        failures.set(ip, { count, lockedUntil, lastAt: now });
        send(res, 401, loginHtml(lockedUntil ? `密码错误次数过多，已锁定 ${LOCK_DURATION_MS / 60000} 分钟` : "管理密码不正确"));
        return true;
      }
      failures.delete(ip);
      const expiresAt = Date.now() + ADMIN_TTL_MS;
      send(res, 303, "", "text/html; charset=utf-8", {
        location: "/admin",
        "set-cookie": `${ADMIN_COOKIE}=${expiresAt}.${sign(expiresAt)}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_TTL_MS / 1000}`,
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/admin/logout") {
      if (!sessionFrom(req)) return false;
      send(res, 303, "", "text/html; charset=utf-8", {
        location: "/admin",
        "set-cookie": `${ADMIN_COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
      return true;
    }

    if (pathname.startsWith("/admin/api/")) {
      if (!sessionFrom(req)) {
        sendJson(res, 401, { error: "未登录或会话过期" });
        return true;
      }
      if (pathname.startsWith("/admin/api/update/")) {
        return await handleUpdateApi(req, res, pathname);
      }
      return await handleApi(req, res, pathname);
    }

    send(res, 404, "not found");
    return true;
  }

  async function ownOverview() {
    const users = await registry.listUsers();
    const today = new Date().toISOString().slice(0, 10);
    const invites = await registry.listInvites();
    return {
      users: users.length,
      online: spawner.runningCount(),
      capacity,
      invitesLeft: invites.filter((i) => (i.usedBy?.length ?? 0) < (i.maxUses ?? 1)).length,
      turnsToday: users.reduce((sum, u) => sum + (u.turns?.date === today ? u.turns.count : 0), 0),
      uptimeSec: Math.round(process.uptime()),
    };
  }

  async function handleApi(req, res, pathname) {
    // 一次往返带回全部面板数据：跨公网链路 RTT 大，5 个串行请求是「卡」的主因
    if (req.method === "GET" && pathname === "/admin/api/bootstrap") {
      const [overview, users, invites, updOverview, updVersions] = await Promise.all([
        ownOverview(),
        registry.listUsers(),
        registry.listInvites(),
        callUpdateApi("GET", "/admin/api/overview"),
        callUpdateApi("GET", "/admin/api/versions"),
      ]);
      sendJson(res, 200, {
        overview,
        users: users.map((u) => ({ ...u, online: spawner.isRunning(u.id) })),
        invites,
        update: { overview: updOverview, versions: updVersions },
      });
      return true;
    }
    if (req.method === "GET" && pathname === "/admin/api/overview") {
      sendJson(res, 200, await ownOverview());
      return true;
    }
    if (req.method === "GET" && pathname === "/admin/api/users") {
      const users = await registry.listUsers();
      sendJson(res, 200, users.map((u) => ({ ...u, online: spawner.isRunning(u.id) })));
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
      sendJson(res, 200, { ok: true, created });
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
      if (action === "disable" || action === "enable") {
        await registry.setDisabled(user.id, action === "disable");
        console.log(`[gw-admin] ${action} ${user.username}`);
      } else if (action === "kick") {
        spawner.kick(user.id);
        console.log(`[gw-admin] kick ${user.username}`);
      } else if (action === "reset-pass") {
        try {
          await registry.setPassword(user.id, String(body.password ?? ""));
          console.log(`[gw-admin] reset-pass ${user.username}`);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          return true;
        }
      } else {
        sendJson(res, 404, { error: "未知操作" });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  }

  /** 版本发布段：全部代理到更新后台，鉴权由网关管理会话承担 */
  async function handleUpdateApi(req, res, pathname) {
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
    if (req.method === "POST" && pathname === "/admin/api/update/rollback") {
      const body = await readJsonBody(req);
      const result = await callUpdateApi("POST", "/admin/api/rollback", {
        version: String(body.version ?? ""),
      });
      console.log(`[gw-admin] 版本回滚请求 v${body.version}: ${result.error ?? "ok"}`);
      sendJson(res, result.error ? 400 : 200, result);
      return true;
    }
    if (req.method === "POST" && pathname === "/admin/api/update/delete") {
      const body = await readJsonBody(req);
      const result = await callUpdateApi("POST", "/admin/api/delete", {
        version: String(body.version ?? ""),
      });
      console.log(`[gw-admin] 版本删除请求 v${body.version}: ${result.error ?? "ok"}`);
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
