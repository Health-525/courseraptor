/**
 * 多用户网关的网页版管理后台（挂在网关的 /admin 路径，与同学入口同端口）。
 *
 * 启用方式：环境变量 GATEWAY_ADMIN_PASSWORD（至少 8 位）；未设置时 /admin
 * 显示「未启用」说明页，管理动作一律 404，只能继续用 admin.mjs 命令行。
 *
 * 鉴权：独立的管理会话 Cookie（raptor_admin，HMAC 签名与同学会话不同名
 * 不同签名域，互不通用）；登录失败同样 5 次锁 15 分钟。页面与 /admin/api/*
 * 与登录/注册页同一套「红头档案」设计令牌。
 *
 * 两步验证（TOTP）：在「安全设置」扫码绑定手机验证器后，登录需管理密码
 * + 6 位动态码（附 10 枚一次性恢复码）。启用/关闭会递增 sessionEpoch，
 * 令既有管理会话立即失效；手机与恢复码全丢时 SSH 上机执行
 * `admin.mjs totp off` 兜底。未绑定则维持仅密码登录，行为与从前一致。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import {
  generateTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "./totp.mjs";

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
b.hot,.hot{color:var(--accent-deep)}
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
a.goto{color:var(--accent);text-decoration:none;border-bottom:1px solid var(--accent-line);
font-weight:600;cursor:pointer}
a.goto:hover{border-bottom-color:var(--accent)}
/* ── 安全设置：扫码绑定 ── */
.qr{background:#fff;border:1px solid var(--rule);border-radius:3px;
width:fit-content;padding:10px;margin:12px 0 10px}
.qr svg{display:block;width:184px;height:184px}
.codes{font-family:var(--mono);font-size:15px;letter-spacing:.08em;line-height:2.1;
margin:10px 0 0;color:var(--ink)}
/* ── 版本发布：上传发版 ── */
textarea{width:100%;padding:10px 12px;background:var(--card);border:1px solid var(--rule-2);
border-radius:2px;font-family:var(--sans);font-size:14px;color:var(--ink);resize:vertical;
transition:border-color .15s ease,box-shadow .15s ease}
textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;
margin-top:8px;padding:22px 16px;border:1.5px dashed var(--rule-2);border-radius:3px;
background:var(--paper-deep);color:var(--ink-3);font-size:12px;text-align:center;cursor:pointer;
transition:border-color .15s ease,color .15s ease,background .15s ease}
.drop svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.6;
stroke-linecap:round;stroke-linejoin:round;opacity:.75}
.drop .b{font-size:13.5px;color:var(--ink-2)}
.drop:hover,.drop:focus-visible,.drop.on{border-color:var(--accent);color:var(--accent-deep);
background:var(--accent-soft);outline:none}
.file-chip{display:flex;align-items:center;gap:10px;margin-top:10px;padding:10px 12px;
background:var(--card);border:1px solid var(--rule);border-radius:3px}
.file-chip svg{width:18px;height:18px;flex:none;stroke:var(--accent);fill:none;stroke-width:1.7;
stroke-linecap:round;stroke-linejoin:round}
.file-chip .name{flex:1;min-width:0;font-size:13.5px;color:var(--ink);
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-chip .size{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);white-space:nowrap}
.pbar{height:8px;background:var(--paper-deep);border:1px solid var(--rule);
border-radius:2px;overflow:hidden}
.pbar i{display:block;height:100%;width:0;background:var(--accent);transition:width .25s ease}
.upd-meta{display:flex;justify-content:space-between;font-family:var(--mono);
font-size:11px;letter-spacing:.06em;color:var(--ink-3)}
.hint{margin:10px 0 0;font-size:12.5px;color:var(--ink-3);line-height:1.7}
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

const loginHtml = (error = "", mfa = false) =>
  shell(
    "管理登录",
    `<section style="width:min(400px,100%);margin:26px auto 0" class="card">
${error ? `<div class="notice">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/admin/login">
<label>管理密码 PASSWORD</label>
<input name="password" type="password" autocomplete="current-password" required${mfa ? "" : " autofocus"} placeholder="请输入管理密码">
${mfa ? `<label>动态码 2FA CODE</label>
<input name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus placeholder="验证器 6 位数字（或恢复码）" style="letter-spacing:.3em">` : ""}
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
<button type="button" class="nav-item" data-nav="site">
<svg viewBox="0 0 24 24"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/></svg>
站点设置</button>
<button type="button" class="nav-item" data-nav="security">
<svg viewBox="0 0 24 24"><path d="M12 22s8-3.6 8-10V5.5L12 2 4 5.5V12c0 6.4 8 10 8 10z"/><path d="M9 11.5l2 2 4-4.5"/></svg>
安全设置</button>
</div>
<div class="nav-group">
<div class="g-label">发 版 · RELEASES</div>
<button type="button" class="nav-item" data-nav="release">
<svg viewBox="0 0 24 24"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>
版本发布</button>
<button type="button" class="nav-item" data-nav="keys">
<svg viewBox="0 0 24 24"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>
密钥管理</button>
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
<table><thead><tr><th>用户名</th><th>状态</th><th>Key 来源</th><th>在线</th><th>注册于</th><th>今日轮数</th><th>操作</th></tr></thead>
<tbody id="users"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody></table>

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

<h2>密码重置申请<span class="en">RESET REQUESTS</span><span class="act mono" style="font-size:11px">同意后把码发给同学，新密码由同学自己设</span></h2>
<div id="resetBox"><p class="empty">加载中…</p></div>
</div>

<div class="panel" id="pane-release">
<h2>上传新版本<span class="en">PUBLISH</span></h2>
<div class="card">
<div class="inv-row">
<input id="updVer" class="mono" placeholder="x.y.z" autocomplete="off" spellcheck="false" style="max-width:130px;text-align:center">
<input id="updNotes" placeholder="更新说明（可选），如：修复课表周次显示错误" maxlength="2000" autocomplete="off">
</div>
<div class="drop" id="updDrop" tabindex="0" role="button" aria-label="选择或拖入 zip 安装包">
<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>
<span class="b" id="updDropMain">点击选择，或拖入 zip 安装包</span>
<span>最大 200 MB · 与 npm run publish 共用接口</span>
</div>
<input type="file" id="updFile" accept=".zip,application/zip" hidden>
<div id="updFileBox"></div>
<div id="updProg" hidden style="margin-top:14px">
<div class="upd-meta"><span id="updPhase">上传中</span><span id="updPct">0%</span></div>
<div class="pbar" style="margin-top:6px"><i id="updBar"></i></div>
<div style="text-align:right;margin-top:8px"><button class="act" id="updCancel" type="button">取消上传</button></div>
</div>
<button class="primary" id="updGo" type="button">发布新版本</button>
<p class="hint">发布后学生端下次启动 raptor 时提示更新；版本号需大于当前分发版本，否则不会触发更新。</p>
</div>

<h2>历史版本<span class="en">HISTORY</span><span class="act mono" style="font-size:11px" id="updCur"></span></h2>
<div class="card" id="updCard"><p class="empty">加载中…</p></div>
</div>

<div class="panel" id="pane-keys">
<h2>更新后台密钥<span class="en">ADMIN KEYS</span><span class="act mono" style="font-size:11px">用于命令行发版与后台登录，与主密钥同权</span></h2>
<div class="card">
<div class="inv-row">
<input id="keyName" placeholder="名称（可选），如：发布机 / 值班同学" maxlength="64" autocomplete="off">
<button class="act" id="keyGen" type="button" style="margin:0;padding:8px 18px">新建密钥</button>
</div>
<div id="keyCreated" hidden></div>
<table style="margin-top:14px;box-shadow:none"><thead><tr><th>名称</th><th>类型</th><th>创建时间</th><th>最后使用</th><th></th></tr></thead>
<tbody id="keys"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody></table>
<p class="hint">主密钥来自服务器环境变量 UPDATE_ADMIN_TOKEN，始终可用且不能在这里删除；面板密钥删除后立即失效。明文只在创建时展示一次，之后仅存哈希。</p>
</div>
</div>

<div class="panel" id="pane-site">
<h2>站点设置<span class="en">SITE</span></h2>
<div class="card">
<label>统一 DEEPSEEK KEY（未设置则同学须自带）</label>
<p class="mono" id="siteKeyState" style="margin:0 0 10px;font-size:12.5px;color:var(--ink-3)">加载中…</p>
<div class="inv-row">
<input id="siteKeyInput" placeholder="粘贴新的 sk- 开头 Key" autocomplete="off">
<button class="act" id="siteKeySave" type="button" style="margin:0;padding:8px 18px">保存</button>
</div>
<p style="color:var(--ink-3);font-size:12.5px;margin:12px 0 0">保存后新拉起的实例立即使用新 Key；在线实例下次拉起时切换。同学在网页「设置」里保存自己的 Key 后，优先用自己的，不消耗站点额度。</p>
<h2>对话限额<span class="en">QUOTA</span></h2>
<p class="lead" style="margin:4px 0 0">站点默认每人每日 <b class="mono" id="siteDefaultTurns">—</b> 轮；在「同学账号」里可按人单独设限额（0 = 用默认）。同学自带 Key 的同样计数，规则透明。</p>
<p style="color:var(--ink-3);font-size:12.5px;margin:10px 0 0" id="dsModeLine">加载中…</p>
</div>
</div>

<div class="panel" id="pane-security">
<h2>两步验证<span class="en">2FA · TOTP</span><span class="act mono" style="font-size:11px">登录需密码 + 手机验证器动态码</span></h2>
<div class="card" id="mfaCard"><p class="empty">加载中…</p></div>
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
function fmtTime(iso) { return iso ? String(iso).replace("T", " ").slice(0, 16) : "—"; }
function renderOverview(o, site) {
if (!o) return;
var own = o.ownTurnsToday || 0;
document.getElementById("stats").innerHTML =
'<div class="stat"><div class="n">' + o.users + '</div><div class="t">注册同学</div></div>' +
'<div class="stat"><div class="n hot">' + o.online + "/" + o.capacity + '</div><div class="t">在线/并发上限</div></div>' +
'<div class="stat"><div class="n">' + o.invitesLeft + '</div><div class="t">可用邀请码</div></div>' +
'<div class="stat"><div class="n hot">' + o.turnsToday + (own > 0 ? '<span style="font-size:13px;color:var(--ink-3)"> +' + own + "</span>" : "") +
'</div><div class="t">今日对话轮数' + (own > 0 ? "（另自有 Key +" + own + "）" : "") + "</div></div>";
var up = o.uptimeSec || 0;
var upText = up >= 86400 ? Math.floor(up / 86400) + " 天 " + Math.floor((up % 86400) / 3600) + " 小时"
: up >= 3600 ? Math.floor(up / 3600) + " 小时 " + Math.floor((up % 3600) / 60) + " 分"
: Math.floor(up / 60) + " 分钟";
document.getElementById("uptimeLine").textContent =
(o.version ? "v" + o.version + " · " : "") + "运行 " + upText + " · " + o.online + "/" + o.capacity + " 在线";
var keyLine = !site
? ""
: site.deepseekKeySet
? "站点统一 Key：面板已设置（<span class=\\"mono\\">" + esc(site.deepseekKeyMasked) + "</span>），新拉起实例即用"
: site.envDeepseekKeySet
? "站点统一 Key：面板未设置，回退服务器 env（GATEWAY_DEEPSEEK_KEY）"
: '站点统一 Key：<b class="hot">未设置</b>——同学须在设置里填自己的 Key';
var todo = (o.pendingResets || 0) > 0
? '<p style="margin:10px 0 0"><a href="#" class="goto" data-nav="users">' + o.pendingResets +
" 条密码重置申请待审批，点击前往处理 →</a></p>"
: "";
document.getElementById("statusCard").innerHTML =
'<p class="lead" style="margin-top:2px"><span class="dot' + (o.online > 0 ? "" : " off") + '"></span>网关已连续运行 ' + esc(upText) +
"，当前 " + o.online + " 个实例在线" + (o.online > 0 ? "" : "（空闲时不占内存）") +
(o.version ? '，网关 <span class="mono">v' + esc(o.version) + "</span>（升级后在此核对）" : "") + "。</p>" +
'<p style="color:var(--ink-3);font-size:13px;margin:4px 0 0">' + keyLine + "</p>" +
'<p style="color:var(--ink-3);font-size:13px;margin:4px 0 0">实例按需拉起、空闲 30 分钟自动回收；每人每日限额默认 ' +
esc(site ? site.defaultDailyTurns : "—") + " 轮，可在「同学账号」按人单独设置。</p>" + todo;
}
function renderUsers(list, defaultTurns) {
if (!list) return;
var el = document.getElementById("users");
if (!list.length) { el.innerHTML = '<tr><td colspan="7" class="empty">还没有同学注册</td></tr>'; return; }
var defLimit = Number(defaultTurns) || 0;
el.innerHTML = list.map(function (u) {
var status = u.disabled ? '<span class="pill bad">已停用</span>' : '<span class="pill">正常</span>';
var keySrc = u.dsMode === "site"
? '<span class="pill bad" title="钉在站点免费额度：自己保存的 Key 保留不用">站点额度</span>'
: '<span class="pill" title="有自己保存的 Key 就用自己的，否则用站点 Key">自有优先</span>';
var online = '<span class="dot off"></span>—';
if (u.online) {
var tip = "实例启动 " + fmtTime(u.startedAt) + " · 最近活跃 " + fmtTime(u.lastRequestAt) +
(u.restarts > 0 ? " · 曾自动重启 " + u.restarts + " 次" : "");
online = '<span class="dot" title="' + esc(tip) + '"></span>在线';
}
var limit = u.dailyTurns > 0 ? u.dailyTurns : defLimit;
var quota = u.turns.count + (u.dailyTurns > 0
? '<b class="hot" title="个人限额，覆盖站点默认 ' + defLimit + ' 轮">/' + limit + "</b>"
: '<span style="color:var(--ink-3)">/' + limit + "</span>");
var ownUsed = (u.ownTurns && u.ownTurns.count) ? ' <span title="自己 Key 的轮数（不限额）" style="color:var(--ok)">+自' + u.ownTurns.count + "</span>" : "";
quota += ownUsed;
var quotaBtn = '<button class="act" data-do="quota" data-u="' + esc(u.username) + '" data-cur="' + (u.dailyTurns || 0) + '">限额</button>';
var acts = quotaBtn;
if (u.disabled) { acts += '<button class="act" data-do="enable" data-u="' + esc(u.username) + '">启用</button>'; }
else { acts += '<button class="act danger" data-do="disable" data-u="' + esc(u.username) + '">停用</button>'; }
if (u.online) { acts += '<button class="act" data-do="kick" data-u="' + esc(u.username) + '">踢下线</button>'; }
return '<tr><td class="mono">' + esc(u.username) + "</td><td>" + status + "</td><td>" + keySrc + "</td><td>" + online +
'</td><td class="mono">' + fmtDate(u.createdAt) + '</td><td class="mono">' + quota +
"</td><td>" + acts + "</td></tr>";
}).join("");
}
function renderResets(r) {
if (!r) return;
var box = document.getElementById("resetBox");
var pend = r.pending || [];
var codes = r.codes || [];
var html = "";
if (!pend.length && !codes.length) { box.innerHTML = '<p class="empty">暂无申请。同学在登录页点「忘记密码」提交后出现在这里。</p>'; return; }
if (pend.length) {
html += '<table style="box-shadow:none"><thead><tr><th>用户名</th><th>申请时间</th><th>操作</th></tr></thead><tbody>' +
pend.map(function (q) {
return '<tr><td class="mono">' + esc(q.username) + '</td><td class="mono">' + esc(String(q.requestedAt).replace("T", " ").slice(0, 16)) +
'</td><td><button class="act" data-approve="' + esc(q.id) + '">同意并生成码</button>' +
'<button class="act danger" data-reject="' + esc(q.id) + '">拒绝</button></td></tr>';
}).join("") + '</tbody></table>';
}
if (codes.length) {
html += '<h2 style="margin-top:16px">有效重置码<span class="en">ACTIVE CODES</span></h2>' +
'<table style="box-shadow:none"><thead><tr><th>用户名</th><th>重置码</th><th>过期时间</th><th></th></tr></thead><tbody>' +
codes.map(function (c) {
var expired = new Date(c.expiresAt) < new Date();
return '<tr><td class="mono">' + esc(c.username) + '</td><td class="mono"><b class="hot">' + esc(c.code) + "</b></td>" +
'<td class="mono">' + esc(String(c.expiresAt).replace("T", " ").slice(0, 16)) + "</td>" +
"<td>" + (expired ? '<span class="pill bad">已过期</span>'
: '<button class="act" data-copy="' + esc(c.code) + '" type="button">复制</button>') + "</td></tr>";
}).join("") + "</tbody></table>";
}
box.innerHTML = html;
}
function renderSite(s, users) {
if (!s) return;
document.getElementById("siteKeyState").textContent = s.deepseekKeySet
? "当前：面板已设置 " + s.deepseekKeyMasked
: s.envDeepseekKeySet
? "面板未设置，回退服务器 env 的 GATEWAY_DEEPSEEK_KEY"
: "未设置（同学须在设置里填自己的 Key）";
document.getElementById("siteDefaultTurns").textContent = s.defaultDailyTurns;
var list = users || [];
var pinned = list.filter(function (u) { return u.dsMode === "site"; }).length;
var today = new Date().toISOString().slice(0, 10);
var ownActive = list.filter(function (u) {
return u.ownTurns && u.ownTurns.date === today && u.ownTurns.count > 0;
}).length;
document.getElementById("dsModeLine").textContent =
"共 " + list.length + " 位同学：钉在站点额度 " + pinned + " 人，其余「自有优先」（有自己的 Key 就用自己的）；今日用自己 Key 对话过的 " + ownActive + " 人。";
}
function showRecoveryCodes(codes, needRelogin) {
var el = document.getElementById("mfaCodesBox") || document.getElementById("mfaSetupBox");
if (!el) return;
var html = '<div class="notice">恢复码仅此一次展示，请立即抄写或截图保存——手机不在身边时，每枚可替代动态码登录一次：</div>' +
'<p class="codes">' + codes.map(esc).join(" &nbsp;·&nbsp; ") + "</p>" +
'<div style="margin-top:8px"><button class="act" data-copy="' + esc(codes.join("\\n")) + '" type="button">复制全部</button>' +
(needRelogin ? ' <button class="act" id="mfaRelogin" type="button">已保存，去重新登录</button>' : "") +
"</div>";
el.innerHTML = html;
el.hidden = false;
}
function renderSecurity(sec) {
if (!sec) return;
var el = document.getElementById("mfaCard");
if (!sec.mfaEnabled) {
el.innerHTML =
'<p class="lead" style="margin-top:2px">当前登录仅需管理密码。<b>建议启用两步验证</b>：之后登录还需输入手机验证器（Google / Microsoft Authenticator、1Password 等）的 6 位动态码，密码泄露也进不来。</p>' +
'<div style="margin-top:12px"><button class="act" id="mfaSetup" type="button" style="padding:8px 18px">启用两步验证</button></div>' +
'<div id="mfaSetupBox" style="margin-top:14px"></div>';
return;
}
el.innerHTML =
'<p class="lead" style="margin-top:2px"><span class="dot"></span>已启用（' + esc(fmtDate(sec.enabledAt)) + ' 起）——登录需管理密码 + 6 位动态码。恢复码剩余 <b class="mono">' + sec.recoveryLeft + "</b> 枚。</p>" +
'<div id="mfaCodesBox" style="margin-top:12px"></div>' +
'<div class="inv-row" style="margin-top:14px"><input id="mfaCodeInput" placeholder="当前动态码（或恢复码）" autocomplete="off" inputmode="numeric">' +
'<button class="act" id="mfaRegen" type="button" style="margin:0;padding:8px 18px">重新生成恢复码</button>' +
'<button class="act danger" id="mfaOff" type="button" style="margin:0;padding:8px 18px">关闭两步验证</button></div>' +
'<p class="hint" style="margin-top:10px">关闭与重生成都要再验一次动态码，防止会话被劫持后降级安全。手机与恢复码全部丢失时，需 SSH 上机执行 admin.mjs totp off 兜底。</p>';
}
function renderInvites(list) {
if (!list) return;
var el = document.getElementById("invites");
if (!list.length) { el.innerHTML = '<tr><td colspan="4" class="empty">暂无邀请码，用上方表单生成</td></tr>'; return; }
el.innerHTML = list.map(function (i) {
var used = (i.usedBy || []).length >= (i.maxUses || 1);
var expired = !used && i.expiresAt && new Date(i.expiresAt) < new Date();
var status = used ? '<span class="pill">已被 ' + esc((i.usedBy || [])[0] || "") + " 使用</span>"
: expired ? '<span class="pill bad">已过期</span>'
: (i.expiresAt ? '<span class="pill bad">' + fmtDate(i.expiresAt) + " 前有效</span>" : '<span class="pill">未使用</span>');
var copy = used || expired ? "" : '<button class="act" data-copy="' + esc(i.code) + '" type="button">复制</button>';
return '<tr><td class="mono">' + esc(i.code) + '</td><td>' + esc(i.note || "—") +
"</td><td>" + status + "</td><td>" + copy + "</td></tr>";
}).join("");
}
var updState = { file: null, xhr: null, versionTouched: false };
function nextPatch(v) {
var p = String(v || "").split(".");
var a = Number(p[0]), b = Number(p[1]), c = Number(p[2]);
if (![a, b, c].every(Number.isFinite)) return "";
return a + "." + b + "." + (c + 1);
}
function prefillVersion(curVer) {
if (updState.versionTouched) return;
var el = document.getElementById("updVer");
var next = curVer ? nextPatch(curVer) : "";
el.value = next;
el.placeholder = curVer ? next : "1.0.0";
}
function updPickFile(f) {
if (!f) return;
if (!/\\.zip$/i.test(f.name)) { alert("只支持 zip 格式的安装包"); return; }
if (f.size > 200 * 1048576) { alert("安装包超过 200 MB 上限（当前 " + (f.size / 1048576).toFixed(1) + " MB）"); return; }
updState.file = f;
document.getElementById("updFileBox").innerHTML = '<div class="file-chip">' +
'<svg viewBox="0 0 24 24"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>' +
'<span class="name">' + esc(f.name) + '</span><span class="size">' + (f.size / 1048576).toFixed(1) + ' MB</span>' +
'<button class="act" id="updClear" type="button">移除</button></div>';
}
function updPublish() {
if (updState.xhr) return;
var ver = document.getElementById("updVer").value.trim();
var notes = document.getElementById("updNotes").value.trim();
if (!/^\\d+\\.\\d+\\.\\d+$/.test(ver)) { alert("版本号必须是 x.y.z 格式，例如 1.2.3"); return; }
if (!updState.file) { alert("请先选择 zip 安装包"); return; }
var xhr = new XMLHttpRequest();
updState.xhr = xhr;
var prog = document.getElementById("updProg");
var bar = document.getElementById("updBar");
var pct = document.getElementById("updPct");
var phase = document.getElementById("updPhase");
prog.hidden = false;
function setPct(p) {
bar.style.width = p + "%";
pct.textContent = p + "%";
phase.textContent = p >= 100 ? "服务器处理中…" : "上传中";
}
setPct(0);
xhr.open("POST", "/admin/api/update/publish");
xhr.setRequestHeader("x-version", ver);
xhr.setRequestHeader("x-notes", encodeURIComponent(notes));
xhr.setRequestHeader("content-type", "application/zip");
xhr.upload.onprogress = function (e) { if (e.lengthComputable) setPct(Math.round(e.loaded / e.total * 100)); };
xhr.onload = function () {
updState.xhr = null;
prog.hidden = true;
var data = {};
try { data = JSON.parse(xhr.responseText); } catch (err) {}
if (xhr.status >= 200 && xhr.status < 300) {
alert("v" + ver + " 已发布，学生端下次启动 raptor 时提示更新。");
document.getElementById("updNotes").value = "";
document.getElementById("updFileBox").innerHTML = "";
updState.file = null;
updState.versionTouched = false;
load();
} else {
alert((data && data.error) || ("发布失败（HTTP " + xhr.status + "）"));
}
};
xhr.onerror = function () { updState.xhr = null; prog.hidden = true; alert("网络错误，请检查与网关的连接"); };
xhr.onabort = function () { updState.xhr = null; prog.hidden = true; };
xhr.send(updState.file);
}
function renderUpdate(o, v) {
var cur = document.getElementById("updCur");
var card = document.getElementById("updCard");
if (!o) return;
if (o.unavailable || o.error) {
cur.textContent = "";
card.innerHTML = '<div class="notice">' + esc(o.error || "更新后台未接入") + '</div>' +
'<p style="color:var(--ink-2);font-size:13px">在网关环境变量配置 GATEWAY_UPDATE_URL 与 GATEWAY_UPDATE_TOKEN，并部署更新后台（update/update-server.mjs）后，这里会显示版本列表与回滚操作。</p>' +
'<div style="margin-top:10px"><button class="act" id="updRetry" type="button">重试</button></div>';
return;
}
var c = o.data && o.data.current;
cur.textContent = c ? ("当前 v" + c.version + " · " + fmtDate(c.publishedAt)) : "尚未发布过版本";
prefillVersion(c ? c.version : "");
if (!v || v.error || v.unavailable) { card.innerHTML = '<p class="empty">' + esc((v && (v.error || "无版本")) || "无版本") + '</p>'; return; }
var list = v.data.versions || [];
if (!list.length) { card.innerHTML = '<p class="empty">还没有发布过版本；在上方上传第一个安装包，或在维护者机器上 npm run publish</p>'; return; }
var mb = function (n) { return (n / 1048576).toFixed(1) + " MB"; };
var total = list.reduce(function (s, r) { return s + (r.sizeBytes || 0); }, 0);
card.innerHTML = '<div class="upd-meta" style="margin:0 0 12px"><span>共 ' + list.length + ' 个版本 · ' + mb(total) + '</span><span>设为分发＝学生端下次启动即下载该版本</span></div>' +
'<table style="box-shadow:none"><thead><tr><th>版本</th><th>说明</th><th>发布时间</th><th>大小</th><th>操作</th></tr></thead><tbody>' +
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
function renderKeys(r) {
var el = document.getElementById("keys");
if (!r) return;
if (r.unavailable || r.error) {
el.innerHTML = '<tr><td colspan="5" class="empty">' + esc(r.error || "更新后台未接入") + '</td></tr>';
return;
}
var list = (r.data && r.data.keys) || [];
if (!list.length) { el.innerHTML = '<tr><td colspan="5" class="empty">没有可用密钥</td></tr>'; return; }
el.innerHTML = list.map(function (k) {
var type = k.isEnv ? '<span class="pill">主密钥</span>' : '<span class="pill">面板密钥</span>';
var del = k.isEnv ? "" :
'<button class="act danger" data-keydel="' + esc(k.id) + '" data-name="' + esc(k.name) + '">删除</button>';
return '<tr><td class="mono">' + esc(k.name) + '</td><td>' + type +
'</td><td class="mono">' + fmtTime(k.createdAt) + '</td><td class="mono">' + fmtTime(k.lastUsedAt) +
'</td><td>' + del + '</td></tr>';
}).join("");
}
function load() {
api("/admin/api/bootstrap").then(function (b) {
if (!b) return;
renderOverview(b.overview, b.site);
renderUsers(b.users, b.site ? b.site.defaultDailyTurns : 0);
renderInvites(b.invites);
renderResets(b.resets);
renderUpdate(b.update.overview, b.update.versions);
renderKeys(b.update.keys);
renderSite(b.site, b.users);
renderSecurity(b.security);
});
}
document.addEventListener("click", function (e) {
var t = e.target.closest ? e.target.closest("button,a") : null;
if (!t) return;
if (t.id === "refresh") { load(); return; }
if (t.id === "logout") { api("/admin/logout", {}).then(function () { location.href = "/admin"; }); return; }
if (t.classList.contains("goto")) {
e.preventDefault();
var navBtn = document.querySelector('.nav-item[data-nav="' + t.getAttribute("data-nav") + '"]');
if (navBtn) navBtn.click();
return;
}
if (t.id === "updGo") { updPublish(); return; }
if (t.id === "updCancel") { if (updState.xhr) updState.xhr.abort(); return; }
if (t.id === "updClear") {
updState.file = null;
document.getElementById("updFileBox").innerHTML = "";
return;
}
	if (t.id === "updRetry") { load(); return; }
	if (t.id === "keyGen") {
	api("/admin/api/update/keys", { name: document.getElementById("keyName").value }).then(function (r) {
	document.getElementById("keyName").value = "";
	if (!r || r.error || r.unavailable) { alert((r && (r.error || "更新后台不可达")) || "创建失败"); return; }
	var token = r.data && r.data.token;
	var k = r.data && r.data.key;
	var box = document.getElementById("keyCreated");
	box.hidden = false;
	box.innerHTML = '<div class="notice">密钥「' + esc(k.name) + '」已创建——明文仅此一次展示，之后无法再查看，请立即复制保存：</div>' +
	'<div class="inv-row" style="margin-top:10px"><input class="mono" readonly value="' + esc(token) + '" onfocus="this.select()">' +
	'<button class="act" data-copy="' + esc(token) + '" type="button" style="margin:0;padding:8px 18px">复制</button></div>';
	load();
	});
	return;
	}
	if (t.id === "siteKeySave") {
	var nk = document.getElementById("siteKeyInput").value.trim();
	if (nk && !confirm(nk ? "保存站点统一 DeepSeek Key（新拉起的实例生效），确认？" : "")) return;
	api("/admin/api/site", { deepseekKey: nk }).then(function (r) {
	if (r && r.error) { alert(r.error); return; }
	document.getElementById("siteKeyInput").value = "";
	load();
	});
	return;
	}
	if (t.id === "mfaSetup") {
	api("/admin/api/totp/setup", {}).then(function (r) {
	if (!r || r.error) { alert((r && r.error) || "生成二维码失败"); return; }
	var grouped = r.secret.replace(/(.{4})/g, "$1 ").trim();
	document.getElementById("mfaSetupBox").innerHTML =
	'<div class="qr">' + r.qrSvg + "</div>" +
	'<p style="font-size:13px;color:var(--ink-2)">用手机验证器扫描二维码（或手输密钥 <b class="mono">' + esc(grouped) + "</b>），然后输入验证器上当前的 6 位动态码完成绑定：</p>" +
	'<div class="inv-row" style="margin-top:10px"><input id="mfaVerifyCode" placeholder="6 位动态码" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="max-width:160px;letter-spacing:.3em;text-align:center">' +
	'<button class="act" id="mfaEnable" type="button" style="margin:0;padding:8px 18px">验证并启用</button></div>';
	});
	return;
	}
	if (t.id === "mfaEnable") {
	var vcode = document.getElementById("mfaVerifyCode").value.trim();
	if (!vcode) { alert("请输入验证器上当前的 6 位动态码"); return; }
	api("/admin/api/totp/enable", { code: vcode }).then(function (r) {
	if (!r || r.error) { alert((r && r.error) || "启用失败"); return; }
	showRecoveryCodes(r.recoveryCodes, true);
	});
	return;
	}
	if (t.id === "mfaRelogin") { location.href = "/admin"; return; }
	if (t.id === "mfaRegen" || t.id === "mfaOff") {
	var ccode = document.getElementById("mfaCodeInput").value.trim();
	if (!ccode) { alert("请先在左侧输入当前动态码（或恢复码）"); return; }
	if (t.id === "mfaOff" && !confirm("关闭后登录仅需管理密码，确认关闭两步验证？")) return;
	api("/admin/api/totp/" + (t.id === "mfaOff" ? "disable" : "recovery"), { code: ccode }).then(function (r) {
	if (!r || r.error) { alert((r && r.error) || "操作失败"); return; }
	if (t.id === "mfaOff") {
	alert("两步验证已关闭。当前会话已一并注销，请用管理密码重新登录。");
	location.href = "/admin";
	return;
	}
	showRecoveryCodes(r.recoveryCodes, false);
	});
	return;
	}
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
var approveId = t.getAttribute("data-approve");
var rejectId = t.getAttribute("data-reject");
if (approveId || rejectId) {
if (approveId) {
if (!confirm("同意该同学的重置申请并生成一次性码（24 小时有效）？新密码将由同学自己设置。")) return;
api("/admin/api/reset/approve", { id: approveId }).then(function (r) {
if (!r || r.error) { alert((r && r.error) || "失败"); return; }
alert("重置码：" + r.code + "（24 小时内有效）——请发给 " + r.username + "，ta 在登录页用它自设新密码。");
load();
});
} else {
if (!confirm("拒绝该申请？")) return;
api("/admin/api/reset/reject", { id: rejectId }).then(load);
}
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
	var keyId = t.getAttribute("data-keydel");
	if (keyId) {
	if (!confirm("删除密钥「" + (t.getAttribute("data-name") || "") + "」？用它发版或登录的地方会立即失效，确认？")) return;
	api("/admin/api/update/keys/delete", { id: keyId }).then(function (r) {
	if (!r || r.error || r.unavailable) { alert((r && (r.error || "更新后台不可达")) || "删除失败"); return; }
	load();
	});
	return;
	}
if (!doWhat || !user) return;
if (doWhat === "quota") {
var q = prompt("给 " + user + " 设每日对话轮数限额（0 = 用站点默认）：", t.getAttribute("data-cur") || "0");
if (q === null) return;
api("/admin/api/user/" + doWhat, { user: user, turns: Number(q) }).then(function (r) {
if (r && r.error) { alert(r.error); return; }
load();
});
return;
}
var confirmText = doWhat === "disable" ? "停用后该同学将立即无法登录，确认？" : "踢下线后该同学的实例立即回收，确认？";
if (!confirm(confirmText)) return;
api("/admin/api/user/" + doWhat, { user: user }).then(load);
});
(function () {
var drop = document.getElementById("updDrop");
var fileInput = document.getElementById("updFile");
if (drop && fileInput) {
drop.addEventListener("click", function () { fileInput.click(); });
drop.addEventListener("keydown", function (e) {
if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("on"); });
drop.addEventListener("dragleave", function () { drop.classList.remove("on"); });
drop.addEventListener("drop", function (e) {
e.preventDefault();
drop.classList.remove("on");
updPickFile(e.dataTransfer.files && e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", function () {
updPickFile(fileInput.files && fileInput.files[0]);
fileInput.value = "";
});
}
var verInput = document.getElementById("updVer");
if (verInput) verInput.addEventListener("input", function () { updState.versionTouched = true; });
})();
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
  defaultDailyTurns = 100,
  updateServerUrl = "",
  updateAdminToken = "",
  version = "",
  envDeepseekKeySet = false,
}) {
  const enabled = typeof password === "string" && password.length >= 8;
  const failures = new Map();
  // 扫码绑定流程的中间态：只存内存，未走完「验证并启用」就丢弃（重启作废重来）
  let pendingSetup = null;
  const PENDING_SETUP_TTL_MS = 10 * 60_000;

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
      const expiresAt = Date.now() + ADMIN_TTL_MS;
      send(res, 303, "", "text/html; charset=utf-8", {
        location: "/admin",
        "set-cookie": `${ADMIN_COOKIE}=${expiresAt}.${sign(expiresAt, epoch)}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_TTL_MS / 1000}`,
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/admin/logout") {
      if (!sessionFrom(req, epoch)) return false;
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
        return await handleUpdateApi(req, res, pathname);
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
      sendJson(res, 200, { ok: true, recoveryCodes: plainCodes });
      return true;
    }

    // 一次往返带回全部面板数据：跨公网链路 RTT 大，5 个串行请求是「卡」的主因
    if (req.method === "GET" && pathname === "/admin/api/bootstrap") {
      const [overview, users, invites, site, resets, totp, updOverview, updVersions, updKeys] =
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
      });
      return true;
    }

    // 密码重置审批：同意即生成一次性码——管理员只经手码，不知道新密码
    if (req.method === "POST" && pathname === "/admin/api/reset/approve") {
      const body = await readJsonBody(req);
      try {
        const result = await registry.approveResetRequest(String(body.id ?? ""));
        console.log(`[gw-admin] 同意 ${result.username} 的重置申请，一次性码已生成（24h 有效）`);
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
      if (action === "quota") {
        try {
          await registry.setDailyTurns(user.id, body.turns);
          console.log(`[gw-admin] ${user.username} 每日限额 → ${Number(body.turns) || 0}`);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          return true;
        }
      } else if (action === "disable" || action === "enable") {
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
