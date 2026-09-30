/**
 * 多用户网关的网页版管理后台（挂在网关的 /admin 路径，与同学入口同端口）。
 *
 * 启用方式：环境变量 GATEWAY_ADMIN_PASSWORD（至少 8 位）；未设置时 /admin
 * 显示「未启用」说明页，管理动作一律 404，只能继续用 admin.mjs 命令行。
 *
 * 鉴权：独立的管理会话 Cookie（raptor_admin，HMAC 签名与同学会话不同名
 * 不同签名域，互不通用）；登录失败同样 5 次锁 15 分钟。
 *
 * 页面架构与同学端网页（src/channels/web/chat-page.ts）同一套交付模式：
 * 前端应用代码在 assets/admin-app.js（独立 JS 资产，编辑器可直接解析、
 * 静态检查有测试兜底），此处读入后内联进页面——单文件交付，浏览器不多
 * 发一个请求。应用壳对齐同学端「红头档案」设计：左侧 284px 档头栏 +
 * 右侧滚动内容区，窄屏退回 ☰ 左抽屉（豆包式），全部颜色只在 :root 令牌。
 *
 * 两步验证（TOTP）：在「安全设置」扫码绑定手机验证器后，登录需管理密码
 * + 6 位动态码（附 10 枚一次性恢复码）。启用/关闭会递增 sessionEpoch，
 * 令既有管理会话立即失效；手机与恢复码全丢时 SSH 上机执行
 * `admin.mjs totp off` 兜底。未绑定则维持仅密码登录，行为与从前一致。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
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

const APP_JS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "assets",
  "admin-app.js",
);
let appJsCache = null;

/** 读入前端应用并缓存（与 chat-page.ts 的 appJs() 同一模式） */
function appJs() {
  if (appJsCache === null) {
    try {
      appJsCache = fs.readFileSync(APP_JS_PATH, "utf8");
    } catch {
      // 资产读不到时页面仍可打开，但在控制台明确报因，不渲染一个死页面
      appJsCache = 'console.error("前端脚本缺失：gateway/admin/assets/admin-app.js 不可读");';
    }
  }
  return appJsCache;
}

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

/** 与 chat-page.ts 同源的红头档案设计令牌（管理台在此之上补表格/统计卡等后台件） */
const TOKENS_CSS = `
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
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
::selection{background:var(--accent-soft)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button,input,textarea{font-family:inherit}
button{touch-action:manipulation;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--paper);color:var(--ink);
font-family:var(--sans);font-size:15px;line-height:1.7;
-webkit-font-smoothing:antialiased}
`;

/** 登录页 / 未启用页：与同学端登录注册同一副「居中一页纸」骨架 */
const AUTH_CSS = `
${TOKENS_CSS}
body{min-height:100vh;min-height:100dvh;display:grid;place-items:center;
padding:34px 18px;font-size:16px;overscroll-behavior:none}
.sheet{width:min(400px,100%)}
.mast{text-align:center;padding-bottom:20px;position:relative;border-bottom:1px solid var(--rule-2)}
.mast::after{content:"";position:absolute;left:12%;right:12%;bottom:3px;height:2px;background:var(--accent)}
.mast img{width:76px;height:76px;object-fit:contain;display:block;margin:0 auto 10px}
.wordmark{margin:0;font-size:24px;line-height:1.2;letter-spacing:-.035em;font-weight:500}
.wordmark .course{color:var(--ink-2)}
.wordmark .raptor{color:var(--accent);font-weight:750}
.wordmark .badge{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.14em;
color:var(--accent-deep);background:var(--accent-soft);border:1px solid var(--accent-line);
border-radius:2px;padding:2px 8px;margin-left:10px;vertical-align:3px}
.tagline{margin:6px 0 0;font-family:var(--kai);font-size:14.5px;color:var(--ink-3);letter-spacing:.06em}
.card{margin-top:26px;background:var(--card);border:1px solid var(--rule);
border-radius:3px;box-shadow:var(--shadow-sm);padding:24px 26px 22px}
.card h2{display:flex;justify-content:space-between;align-items:baseline;
margin:0 0 18px;padding-bottom:9px;font-family:var(--mono);font-size:12.5px;
font-weight:600;letter-spacing:.18em;color:var(--ink-2);border-bottom:1px solid var(--rule)}
.card h2 .en{font-weight:400;font-size:11px;letter-spacing:.08em;color:var(--ink-3)}
label{display:block;margin:14px 0 6px;font-family:var(--mono);font-size:11px;
font-weight:600;letter-spacing:.12em;color:var(--ink-3)}
input{width:100%;padding:10px 12px;background:var(--card);
border:1px solid var(--rule-2);border-radius:2px;font-size:15px;color:var(--ink);
transition:border-color .15s ease,box-shadow .15s ease}
input:hover{border-color:var(--ink-3)}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input:-webkit-autofill{-webkit-box-shadow:0 0 0 40px var(--card) inset;-webkit-text-fill-color:var(--ink)}
button.primary{display:block;width:100%;margin-top:22px;padding:12px;
background:var(--accent);color:var(--card);border:1px solid var(--accent);
border-radius:2px;font-size:15px;font-weight:600;letter-spacing:.14em;cursor:pointer;
transition:background .15s ease}
button.primary:hover{background:var(--accent-deep);border-color:var(--accent-deep);color:#fff}
button.primary:active{transform:translateY(1px)}
.notice{margin:0 0 4px;padding:9px 12px;background:var(--accent-soft);
border:1px solid var(--accent-line);border-radius:2px;color:var(--accent-deep);
font-size:13.5px;line-height:1.6}
.mono{font-family:var(--mono)}
@media (max-width:420px){.mast img{width:64px;height:64px}.card{padding:20px 18px 18px}}
@media (hover:none){input{font-size:16px}}
`;

/** 管理台应用壳：对齐 chat-page.ts 的三段式（档头栏 / 滚动正文 / 窄屏抽屉） */
const APP_CSS = `
${TOKENS_CSS}
body{display:grid;grid-template-columns:284px 1fr;height:100vh;height:100dvh;
overflow:hidden;overscroll-behavior:none}
.wordmark{display:inline-flex;align-items:baseline;font-weight:500;
letter-spacing:-.035em;white-space:nowrap}
.wordmark .course{color:var(--ink-2)}
.wordmark .raptor{color:var(--accent);font-weight:750}
/* ── 左栏：档头（同学端 aside 的管理台变体）── */
aside{display:flex;flex-direction:column;min-height:0;overflow:hidden;
padding:24px 18px max(16px,env(safe-area-inset-bottom));
border-right:1px solid var(--rule);background:var(--paper-deep)}
.mast{flex:none;text-align:center;padding-bottom:16px;position:relative;
border-bottom:1px solid var(--rule-2)}
.mast::after{content:"";position:absolute;left:14%;right:14%;bottom:3px;
height:2px;background:var(--accent)}
.mast img{width:44px;height:44px;object-fit:contain;display:block;margin:0 auto 7px}
.mast h1{margin:0;font-size:19px;line-height:1.2}
.mast .badge{display:inline-block;margin-top:8px;font-family:var(--mono);
font-size:9.5px;font-weight:600;letter-spacing:.16em;color:var(--accent-deep);
background:var(--accent-soft);border:1px solid var(--accent-line);
border-radius:2px;padding:2px 8px}
nav.groups{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
display:flex;flex-direction:column;gap:22px;padding:18px 2px 8px 0;
scrollbar-width:thin;scrollbar-color:transparent transparent}
nav.groups:hover,nav.groups:focus-within{scrollbar-color:var(--rule-2) transparent}
nav.groups::-webkit-scrollbar{width:8px}
nav.groups::-webkit-scrollbar-thumb{background:transparent;border:2px solid transparent;
background-clip:content-box;border-radius:4px}
nav.groups:hover::-webkit-scrollbar-thumb{background:var(--rule-2);background-clip:content-box}
.sec h2{display:flex;justify-content:space-between;align-items:baseline;
margin:0 0 7px;padding:0 10px 7px;font-family:var(--mono);font-size:11px;
font-weight:600;letter-spacing:.16em;color:var(--ink-3);
border-bottom:1px solid var(--rule)}
.sec h2 span:last-child{font-weight:400;letter-spacing:.06em}
/* 导航条目：会话列表同款语言——悬停浅朱砂竖线，选中实朱砂 + 纸卡 */
.nav-item{position:relative;display:flex;align-items:center;gap:11px;width:100%;
text-align:left;background:none;border:0;border-left:2px solid transparent;
border-radius:0 4px 4px 0;padding:8px 10px;font-size:13.5px;color:var(--ink-2);
cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}
.nav-item svg{width:15px;height:15px;flex:none;stroke:currentColor;fill:none;
stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.nav-item:hover{background:var(--card);border-left-color:var(--accent-soft);color:var(--ink)}
.nav-item.on{background:var(--card);border-left-color:var(--accent);color:var(--ink);
font-weight:600;box-shadow:var(--shadow-sm)}
.nav-item .ndot{position:absolute;top:50%;right:10px;transform:translateY(-50%);
width:8px;height:8px;border-radius:50%;background:var(--accent);
box-shadow:0 0 0 2px var(--paper-deep)}
.side-foot{flex:none;padding-top:12px;border-top:1px solid var(--rule-2)}
.side-uptime{padding:0 2px 9px;font-family:var(--mono);font-size:10px;
letter-spacing:.04em;color:var(--ink-3)}
.side-foot .foot-btns{display:flex;gap:8px}
/* ── 通用控件（tbtn / 表格 / 卡片：与同学端同一手感）── */
.tbtn{background:none;border:1px solid var(--rule-2);color:var(--ink-2);
border-radius:2px;padding:5px 12px;font-size:12.5px;cursor:pointer;
display:inline-flex;align-items:center;justify-content:center;gap:6px;
transition:border-color .15s ease,color .15s ease,background .15s ease}
.tbtn:hover{border-color:var(--accent);color:var(--accent)}
.tbtn:active{transform:translateY(1px)}
.tbtn.danger:hover{border-color:var(--accent-deep);background:var(--accent-soft);
color:var(--accent-deep)}
.tbtn svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.8;
stroke-linecap:round;stroke-linejoin:round}
.foot-btns .tbtn{flex:1}
main.content{display:flex;flex-direction:column;min-width:0;min-height:0}
.topbar{display:none}
.pagewrap{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
padding:36px 40px 64px}
.inner{width:min(100%,880px);margin:0 auto}
h2{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
margin:30px 0 12px;padding-bottom:8px;font-family:var(--mono);font-size:12.5px;
font-weight:600;letter-spacing:.18em;color:var(--ink-2);border-bottom:1px solid var(--rule)}
h2:first-child{margin-top:0}
h2 .en{font-weight:400;font-size:11px;letter-spacing:.08em;color:var(--ink-3)}
h2 .act{font-weight:400;letter-spacing:.04em;font-family:var(--mono);
font-size:11px;color:var(--ink-3)}
.card{background:var(--card);border:1px solid var(--rule);border-radius:3px;
box-shadow:var(--shadow-sm);padding:20px 22px 18px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.stat{background:var(--card);border:1px solid var(--rule);border-radius:3px;
box-shadow:var(--shadow-sm);padding:14px 16px 11px;text-align:center}
.stat .n{font-family:var(--mono);font-size:26px;font-weight:600;
letter-spacing:-.02em;color:var(--ink)}
.stat .n.hot{color:var(--accent)}
.stat .t{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;
color:var(--ink-3);margin-top:2px}
table{width:100%;border-collapse:collapse;background:var(--card);
border:1px solid var(--rule);box-shadow:var(--shadow-sm)}
table.plain{border:0;box-shadow:none}
th{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.12em;
color:var(--ink-3);text-align:left;padding:10px 12px;background:var(--paper-deep);
border-bottom:1px solid var(--rule-2)}
td{padding:9px 12px;border-bottom:1px solid var(--rule);vertical-align:middle}
table.plain td{border-bottom:1px dashed var(--rule)}
tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--paper-deep)}
.mono{font-family:var(--mono);font-size:13px}
b.hot,.hot{color:var(--accent-deep)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;
background:var(--ok);margin-right:6px;vertical-align:1px}
.dot.off{background:var(--rule-2)}
.pill{font-family:var(--mono);font-size:11px;letter-spacing:.08em;border-radius:2px;
padding:1px 8px;border:1px solid var(--ok-soft);background:var(--ok-soft);color:var(--ok);
white-space:nowrap}
.pill.bad{border-color:var(--accent-line);background:var(--accent-soft);color:var(--accent-deep)}
.row{display:flex;gap:10px;flex-wrap:wrap}
.row input{flex:1;min-width:120px}
.row .num{max-width:90px;text-align:center}
input,textarea{width:100%;padding:9px 12px;background:var(--card);
border:1px solid var(--rule-2);border-radius:2px;font-size:14.5px;color:var(--ink);
transition:border-color .15s ease,box-shadow .15s ease}
input:hover,textarea:hover{border-color:var(--ink-3)}
input:focus,textarea:focus{outline:none;border-color:var(--accent);
box-shadow:0 0 0 3px var(--accent-soft)}
textarea{resize:vertical;font-size:14px}
.empty{padding:26px 0;text-align:center;color:var(--ink-3);font-size:13.5px}
.copy-ok{color:var(--ok);font-family:var(--mono);font-size:11px;cursor:default;
border:0;background:none;padding:3px 0}
.notice{margin:0 0 4px;padding:9px 12px;background:var(--accent-soft);
border:1px solid var(--accent-line);border-radius:2px;color:var(--accent-deep);
font-size:13.5px;line-height:1.6}
p.lead{margin:4px 0 6px;font-size:15px;color:var(--ink-2)}
a.goto{color:var(--accent);text-decoration:none;border-bottom:1px solid var(--accent-line);
font-weight:600}
a.goto:hover{border-bottom-color:var(--accent)}
.hint{margin:10px 0 0;font-size:12.5px;color:var(--ink-3);line-height:1.7}
/* ── 安全设置：扫码绑定 ── */
.qr{background:#fff;border:1px solid var(--rule);border-radius:3px;
width:fit-content;padding:10px;margin:12px 0 10px}
.qr svg{display:block;width:184px;height:184px}
.codes{font-family:var(--mono);font-size:15px;letter-spacing:.08em;line-height:2.1;
margin:10px 0 0;color:var(--ink)}
/* ── 版本发布：上传发版 ── */
.drop{display:flex;flex-direction:column;align-items:center;justify-content:center;
gap:5px;margin-top:8px;padding:22px 16px;border:1.5px dashed var(--rule-2);
border-radius:3px;background:var(--paper-deep);color:var(--ink-3);font-size:12px;
text-align:center;cursor:pointer;
transition:border-color .15s ease,color .15s ease,background .15s ease}
.drop svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.6;
stroke-linecap:round;stroke-linejoin:round;opacity:.75}
.drop .b{font-size:13.5px;color:var(--ink-2)}
.drop:hover,.drop:focus-visible,.drop.on{border-color:var(--accent);
color:var(--accent-deep);background:var(--accent-soft);outline:none}
.file-chip{display:flex;align-items:center;gap:10px;margin-top:10px;padding:10px 12px;
background:var(--card);border:1px solid var(--rule);border-radius:3px}
.file-chip svg{width:18px;height:18px;flex:none;stroke:var(--accent);fill:none;
stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.file-chip .name{flex:1;min-width:0;font-size:13.5px;color:var(--ink);
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-chip .size{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);white-space:nowrap}
.pbar{height:8px;background:var(--paper-deep);border:1px solid var(--rule);
border-radius:2px;overflow:hidden}
.pbar i{display:block;height:100%;width:0;background:var(--accent);
transition:width .25s ease}
.meta{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
font-family:var(--mono);font-size:11px;letter-spacing:.06em;color:var(--ink-3)}
button.primary{display:block;width:100%;margin-top:22px;padding:12px;
background:var(--accent);color:var(--card);border:1px solid var(--accent);
border-radius:2px;font-size:15px;font-weight:600;letter-spacing:.14em;cursor:pointer;
transition:background .15s ease}
button.primary:hover{background:var(--accent-deep);border-color:var(--accent-deep);color:#fff}
button.primary:active{transform:translateY(1px)}
.drawer-backdrop{display:none;position:fixed;inset:0;z-index:39;
background:rgba(38,35,29,.35)}
/* ── 窄屏：aside 退回左抽屉（豆包式），顶栏带 ☰ ── */
@media (max-width:960px){
body{grid-template-columns:1fr}
aside{position:fixed;inset:0 auto 0 0;z-index:40;width:min(320px,88vw);
transform:translateX(-102%);transition:transform .2s ease;
box-shadow:14px 0 36px rgba(38,35,29,.2)}
body.drawer-open aside{transform:translateX(0)}
body.drawer-open .drawer-backdrop{display:block}
.topbar{display:flex;flex:none;align-items:center;gap:8px;padding:9px 14px;
border-bottom:1px solid var(--rule);background:var(--paper-deep)}
.topbar .tb-title{flex:1;justify-content:center;font-size:17px}
.topbar .iconbtn{width:44px;min-width:44px;min-height:44px;padding:0;
border-color:transparent;background:none}
.topbar .iconbtn svg{width:20px;height:20px}
.topbar .iconbtn:active{background:var(--accent-soft)}
.pagewrap{padding:24px 16px 56px}
.stats{grid-template-columns:repeat(2,1fr)}
}
@media (hover:none){input,textarea{font-size:16px}}
`;

const authShell = (title, body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#F0EDE4">
<link rel="icon" href="/logo.png">
<title>${escapeHtml(title)} · CourseRaptor 管理</title><style>${AUTH_CSS}</style></head><body>
<main class="sheet">
<header class="mast">
<img src="/logo.png" alt="CourseRaptor 印章">
<h1 class="wordmark"><span class="course">Course</span><span class="raptor">Raptor</span><span class="badge">ADMIN</span></h1>
<p class="tagline">班级互助服务 · 管理台</p>
</header>
${body}
</main></body></html>`;

const loginHtml = (error = "", mfa = false) =>
  authShell(
    "管理登录",
    `<section class="card">
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
  authShell(
    "未启用",
    `<section class="card" style="width:min(460px,100%)">
<div class="notice">管理后台未启用：服务器未设置 <span class="mono">GATEWAY_ADMIN_PASSWORD</span>。</div>
<p style="color:var(--ink-2)">在 <span class="mono">/etc/raptor-gateway.env</span> 加入该变量并
<span class="mono">systemctl restart raptor-gateway</span> 即可开启；期间可继续用
<span class="mono">admin.mjs</span> 命令行管理。</p></section>`,
  );

const NAV_ICON = {
  overview:
    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  users:
    '<svg viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7"/><path d="M16 3.5a4 4 0 0 1 0 7"/><path d="M17 14c2.8.5 5 3 5 6.2"/></svg>',
  invites:
    '<svg viewBox="0 0 24 24"><path d="M4 22h16c1.1 0 2-.9 2-2v-4H2v4c0 1.1.9 2 2 2z"/><path d="M6 13V4c0-1.1.9-2 2-2h8c1.1 0 2 .9 2 2v9"/><path d="M10 6h4"/></svg>',
  resets:
    '<svg viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.3 12.7 21 2"/><path d="m15 7 3 3"/><path d="m18 4 3 3"/></svg>',
  site:
    '<svg viewBox="0 0 24 24"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/></svg>',
  security:
    '<svg viewBox="0 0 24 24"><path d="M12 22s8-3.6 8-10V5.5L12 2 4 5.5V12c0 6.4 8 10 8 10z"/><path d="M9 11.5l2 2 4-4.5"/></svg>',
  release:
    '<svg viewBox="0 0 24 24"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
  keys:
    '<svg viewBox="0 0 24 24"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>',
};

const navItem = (id, label, dot = false) =>
  `<button type="button" class="nav-item" data-nav="${id}">${NAV_ICON[id]}${label}${dot ? '<span class="ndot" id="resetsDot" hidden></span>' : ""}</button>`;

const dashboardHtml = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#F0EDE4">
<link rel="icon" href="/logo.png">
<title>管理台 · CourseRaptor</title><style>${APP_CSS}</style></head><body>
<aside>
  <div class="mast">
    <img src="/logo.png" alt="CourseRaptor 印章">
    <h1 class="wordmark"><span class="course">Course</span><span class="raptor">Raptor</span></h1>
    <div><span class="badge">ADMIN 管理台</span></div>
  </div>
  <nav class="groups">
    <section class="sec">
      <h2><span>日 常</span><span>DAILY</span></h2>
      ${navItem("overview", "总览")}
      ${navItem("users", "同学账号")}
      ${navItem("invites", "邀请码")}
      ${navItem("resets", "重置审批", true)}
    </section>
    <section class="sec">
      <h2><span>站 点</span><span>SITE</span></h2>
      ${navItem("site", "站点设置")}
      ${navItem("security", "安全设置")}
    </section>
    <section class="sec">
      <h2><span>发 版</span><span>RELEASES</span></h2>
      ${navItem("release", "版本发布")}
      ${navItem("keys", "密钥管理")}
    </section>
  </nav>
  <div class="side-foot">
    <div class="side-uptime" id="uptimeLine">网关运行中…</div>
    <div class="foot-btns">
      <button type="button" class="tbtn" id="refresh">
        <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>刷新</button>
      <button type="button" class="tbtn" id="logout">
        <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>退出</button>
    </div>
  </div>
</aside>
<main class="content">
  <div class="topbar">
    <button type="button" class="tbtn iconbtn" id="openDrawerM" aria-label="打开菜单">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
    <span class="tb-title wordmark"><span class="course">Course</span><span class="raptor">Raptor</span></span>
    <button type="button" class="tbtn iconbtn" id="refreshM" aria-label="刷新数据">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>
  </div>
  <div class="pagewrap"><div class="inner">
  <section class="pane">

  <div class="panel on" id="pane-overview">
    <h2>总览<span class="en">OVERVIEW</span></h2>
    <div class="stats" id="stats"></div>
    <h2>运行状态<span class="en">STATUS</span></h2>
    <div class="card" id="statusCard"><p class="empty">加载中…</p></div>
  </div>

  <div class="panel" id="pane-users">
    <h2>同学账号<span class="en">USERS</span></h2>
    <table><thead><tr><th>用户名</th><th>状态</th><th>Key 来源</th><th>在线</th><th>来源</th><th>注册于</th><th>今日轮数</th><th>操作</th></tr></thead>
    <tbody id="users"><tr><td colspan="8" class="empty">加载中…</td></tr></tbody></table>
    <p class="hint">「Key 来源」显示分账模式：站点额度＝统一 Key 计费；自有优先＝同学保存了自己的 DeepSeek Key 时不占站点额度。悬停在线圆点可看实例启动 / 最近活跃时间。</p>
  </div>

  <div class="panel" id="pane-invites">
    <h2>生成邀请码<span class="en">INVITES</span><span class="act">发给同学，凭码注册</span></h2>
    <div class="card">
      <div class="row">
        <input class="num" id="invCount" type="number" min="1" max="50" value="5" title="数量">
        <input id="invNote" placeholder="备注（如：班级群）">
        <input class="num" id="invDays" type="number" min="0" max="365" value="0" title="有效天数，0=永久">
        <button class="tbtn" id="invGen" type="button" style="margin:0;padding:8px 18px">生成</button>
      </div>
    </div>
    <h2>邀请码档案<span class="en">HISTORY</span></h2>
    <table><thead><tr><th>邀请码</th><th>备注</th><th>使用者</th><th>状态</th><th></th></tr></thead>
    <tbody id="invites"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody></table>
  </div>

  <div class="panel" id="pane-resets">
    <h2>密码重置申请<span class="en">RESET REQUESTS</span><span class="act">同意后把码发给同学，新密码由同学自己设</span></h2>
    <div id="resetBox"><p class="empty">加载中…</p></div>
  </div>

  <div class="panel" id="pane-site">
    <h2>站点设置<span class="en">SITE</span></h2>
    <div class="card">
      <label>统一 DEEPSEEK KEY（未设置则同学须自带）</label>
      <p class="mono" id="siteKeyState" style="margin:0 0 10px;font-size:12.5px;color:var(--ink-3)">加载中…</p>
      <div class="row">
        <input id="siteKeyInput" placeholder="粘贴新的 sk- 开头 Key" autocomplete="off">
        <button class="tbtn" id="siteKeySave" type="button" style="margin:0;padding:8px 18px">保存</button>
      </div>
      <p style="color:var(--ink-3);font-size:12.5px;margin:12px 0 0">保存后新拉起的实例立即使用新 Key；在线实例下次拉起时切换。同学在网页「设置」里保存自己的 Key 后，优先用自己的，不消耗站点额度。</p>
      <h2 style="margin-top:22px">对话限额<span class="en">QUOTA</span></h2>
      <p class="lead" style="margin:4px 0 0">站点默认每人每日 <b class="mono" id="siteDefaultTurns">—</b> 轮；在「同学账号」里可按人单独设限额（0 = 用默认）。同学自带 Key 的同样计数，规则透明。</p>
      <p style="color:var(--ink-3);font-size:12.5px;margin:10px 0 0" id="dsModeLine">加载中…</p>
    </div>
  </div>

  <div class="panel" id="pane-security">
    <h2>两步验证<span class="en">2FA · TOTP</span><span class="act">登录需密码 + 手机验证器动态码</span></h2>
    <div class="card" id="mfaCard"><p class="empty">加载中…</p></div>
  </div>

  <div class="panel" id="pane-release">
    <h2>上传新版本<span class="en">PUBLISH</span></h2>
    <div class="card">
      <div class="row">
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
        <div class="meta"><span id="updPhase">上传中</span><span id="updPct">0%</span></div>
        <div class="pbar" style="margin-top:6px"><i id="updBar"></i></div>
        <div style="text-align:right;margin-top:8px"><button class="tbtn" id="updCancel" type="button">取消上传</button></div>
      </div>
      <button class="primary" id="updGo" type="button">发布新版本</button>
      <p class="hint">发布后学生端下次启动 raptor 时提示更新；版本号需大于当前分发版本，否则不会触发更新。</p>
    </div>
    <h2>历史版本<span class="en">HISTORY</span><span class="act" id="updCur"></span></h2>
    <div class="card" id="updCard"><p class="empty">加载中…</p></div>
  </div>

  <div class="panel" id="pane-keys">
    <h2>更新后台密钥<span class="en">ADMIN KEYS</span><span class="act">用于命令行发版与后台登录，与主密钥同权</span></h2>
    <div class="card">
      <div class="row">
        <input id="keyName" placeholder="名称（可选），如：发布机 / 值班同学" maxlength="64" autocomplete="off">
        <button class="tbtn" id="keyGen" type="button" style="margin:0;padding:8px 18px">新建密钥</button>
      </div>
      <div id="keyCreated" hidden></div>
      <table class="plain" style="margin-top:14px"><thead><tr><th>名称</th><th>类型</th><th>创建时间</th><th>最后使用</th><th></th></tr></thead>
      <tbody id="keys"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody></table>
      <p class="hint">主密钥来自服务器环境变量 UPDATE_ADMIN_TOKEN，始终可用且不能在这里删除；面板密钥删除后立即失效。明文只在创建时展示一次，之后仅存哈希。</p>
    </div>
  </div>

  </section>
  </div></div>
</main>
<div class="drawer-backdrop"></div>
<script>
${appJs()}
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
