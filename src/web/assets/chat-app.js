const logScroll = document.getElementById("log");
const inner = document.getElementById("inner");
const hero = document.getElementById("hero");
const input = document.getElementById("i");
const btn = document.getElementById("b");
let busy = false;
let controller = null;
/* 最近一轮的用户消息：失败重试用 */
let lastPrompt = "";

/* ── 多会话状态：正文以服务端存档为准，本地只记当前会话 id ── */
const ACTIVE_KEY = document.body.dataset.demo === "true" ? "raptor-demo-active-session" : "raptor-web-active-session";
/* 每次打开网页都从一个空白新会话开始；历史仍可在侧栏主动打开。 */
let activeId = "";
let msgs = [];
let lastSessions = [];
let viewingArchived = false;
let sessionActionsId = "";
/* 会话删除的两步确认态：armed 的那条 3 秒内再点才执行（对齐待办/知识页） */
let delArmId = "";
let delArmTimer = 0;
let editingSessionId = "";
let pendingUploads = [];
function lsSet(k, v) {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {}
}
/* uuid 客户端先生成：第一条消息发出时服务端才建档，不留空壳会话 */
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : "s" + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
}

/* ── 小工具 ── */
function el(cls) {
  const div = document.createElement("div");
  div.className = cls;
  return div;
}
function el2(cls, text) {
  const n = el(cls);
  n.textContent = text;
  return n;
}
/* 工具卡片行首的描线齿轮：状态不再换字形，靠行尾文字表达，所以图标是常量。
   内容是这里写死的字符串（不掺模型输出），innerHTML 赋值不构成注入面 */
const GEAR = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" '
  + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0'
  + 'l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51'
  + 'a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08'
  + 'a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18'
  + 'a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39'
  + 'a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09'
  + 'a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25'
  + 'a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
function iconSpan(cls, svg) {
  const n = el(cls);
  n.innerHTML = svg;
  return n;
}
function pad(x) { return (x < 10 ? "0" : "") + x; }
function clock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function fmtWhen(ts) {
  const d = new Date(ts), n = new Date();
  return d.toDateString() === n.toDateString()
    ? clock(ts) : (d.getMonth() + 1) + "月" + d.getDate() + "日";
}
/* 档案行悬停时间戳：不做「今天/昨天」换算，一律全量标准格式，
   等宽字体定宽——悬停浮现时行内布局不跳 */
function fmtStamp(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + clock(ts);
}

/* ── 首屏问候：按当下时段换招呼语，配 mono 日期戳（TODAY · 9月22日 周二）。
   startFresh 恢复首屏时重算，隔午后再回来不穿帮 ── */
function heroGreeting() {
  const greet = document.getElementById("heroGreet");
  const kick = document.getElementById("heroKicker");
  const n = new Date();
  if (greet) {
    const h = n.getHours();
    const word = h < 6 ? "夜深了" : h < 11 ? "早上好"
      : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
    greet.textContent = "同学，" + word + "。";
  }
  if (kick) {
    const wd = ["日", "一", "二", "三", "四", "五", "六"][n.getDay()];
    kick.textContent = "TODAY · " + (n.getMonth() + 1) + "月" + n.getDate() + "日 周" + wd;
  }
}
heroGreeting();

/* ── 快速提问：常驻在输入框上方。默认清单先渲染（页面秒开），启动后再用
   服务端保存的自定义清单（/api/settings.quickQuestions）刷新一遍 ── */
const DEFAULT_QUESTIONS = ["今天有什么安排", "这周课表", "教务处最近有什么通知", "我的成绩和 GPA", "最近的考试安排", "通识学分还缺哪些", "导出课表到手机日历"];
let quickQuestions = DEFAULT_QUESTIONS.slice();
const qchips = document.getElementById("qchips");
function renderQchips() {
  qchips.innerHTML = "";
  quickQuestions.forEach((q) => {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "chip";
    c.dataset.q = q;
    c.textContent = q;
    qchips.appendChild(c);
  });
}
renderQchips();
qchips.addEventListener("click", (e) => {
  const c = e.target.closest("button[data-q]");
  if (c && !busy) send(c.dataset.q);
});

/* ── 智能滚动：用户上翻（离底 > 60px）就不再自动拽底 ── */
const toBottom = document.getElementById("toBottom");
let pinned = true;
logScroll.addEventListener("scroll", () => {
  pinned = logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 60;
  toBottom.hidden = pinned;
});
toBottom.addEventListener("click", () => scroll(true));

const HAS_MARKED = typeof marked !== "undefined";
/* 只转义 & 和 <：堵住 HTML 标签注入面（标签必须以 < 开头），同时保留
   Markdown 自己的语法字符——> 若被转义成 &gt;，块引用就失效了 */
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function renderMd(text) {
  if (!HAS_MARKED) return null;
  try {
    return marked.parse(escHtml(text), { gfm: true, breaks: true, async: false });
  } catch { return null; }
}

/* 流式期间每个 delta 都整段重渲 Markdown 会卡：合并到下一帧 */
let raf = 0;
let pending = null;
function renderStreaming(node, raw) {
  pending = { node, raw };
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!pending) return;
    const html = renderMd(pending.raw);
    if (html != null) pending.node.innerHTML = html;
    else pending.node.textContent = pending.raw;
    scroll(false);
  });
}

function scroll(force) {
  if (force || pinned) logScroll.scrollTop = logScroll.scrollHeight;
}

function clearTurns() {
  [...inner.querySelectorAll(".turn")].forEach((n) => n.remove());
}

/* ── 消息渲染：一行题注（谁 · 时间 · 耗时）+ 正文 ── */
function addTurn(cls) {
  const sec = el("turn " + cls);
  const cap = el("cap");
  cap.appendChild(el2("who", cls === "user" ? "你" : "助手"));
  const tm = el2("tm", "");
  const dur = el2("dur", "");
  cap.appendChild(tm);
  cap.appendChild(dur);
  sec.appendChild(cap);
  return { sec, cap, tm, dur };
}

function addUser(text, ts, attachments) {
  const { sec, tm } = addTurn("user");
  tm.textContent = clock(ts || Date.now());
  sec.appendChild(el2("msg", text));
  if (attachments && attachments.length) {
    const row = el("upload-tray");
    attachments.forEach((a) => row.appendChild(el2("upchip", "附件 · " + a.name)));
    sec.appendChild(row);
  }
  inner.appendChild(sec);
  scroll(true);
}

/** 助手一轮：题注 + 时间线区（思考卡片 + 工具卡片）+ 回答正文 + 操作行 */
function addBotShell() {
  const { sec, tm, dur } = addTurn("bot");
  const tl = el("tl");
  const msg = el("msg md");
  const acts = el("acts");
  sec.appendChild(tl);
  sec.appendChild(msg);
  sec.appendChild(acts);
  inner.appendChild(sec);
  scroll(true);
  /* 工具卡片索引：id 精确配对为主，同名排队兜底；think 是当前展开中的思考卡片 */
  return { sec, tm, dur, tl, msg, acts, tools: new Map(), queue: {}, think: null };
}

function addCopyButton(acts, raw) {
  if (!raw.trim()) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tbtn";
  b.textContent = "复制";
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(raw);
      b.textContent = "已复制";
      setTimeout(() => (b.textContent = "复制"), 1200);
    } catch { /* 剪贴板不可用就静默 */ }
  });
  acts.appendChild(b);
}

/** 定格一条完整助手消息（openSession 重绘历史用）；thinkText 是历史里的思考 */
function addBotMessage(raw, ts, thinkText) {
  const shell = addBotShell();
  shell.tm.textContent = clock(ts);
  if (thinkText) {
    /* 历史里的思考不计时（重开时算出的耗时是假的），建卡即定格为折叠态 */
    const item = thinkNew(shell.tl);
    item.body.textContent = thinkText;
    item.st.textContent = "已完成";
    item.det.open = false;
  }
  const html = renderMd(raw);
  if (html != null) shell.msg.innerHTML = html;
  else shell.msg.textContent = raw;
  addCopyButton(shell.acts, raw);
  scroll(false);
  return shell;
}

/* ── 思考卡片：一段 reasoning 一张卡，流式期间展开、段落收尾自动折叠 ── */
function thinkNew(tl) {
  const det = document.createElement("details");
  det.className = "think";
  det.open = true;
  const sum = document.createElement("summary");
  sum.appendChild(el2("tk", "思考"));
  const st = el2("tstat", "进行中");
  const dur = el2("tdur", "");
  sum.appendChild(st);
  sum.appendChild(dur);
  det.appendChild(sum);
  const body = el("thbody");
  det.appendChild(body);
  const item = { det, st, dur, body, buf: "", at: Date.now(), manual: false };
  /* 监听器挂在 open=true 之后：程序化的首次展开不算用户手动开合 */
  det.addEventListener("toggle", () => { item.manual = true; });
  tl.appendChild(det);
  return item;
}

function thinkDelta(shell, text) {
  if (!shell.think) shell.think = thinkNew(shell.tl);
  const item = shell.think;
  item.buf += text;
  item.body.textContent = item.buf;
  scroll(false);
}

/** 本段思考结束：定格状态字与耗时，用户没手动开过就折叠起来 */
function thinkClose(shell, stat) {
  const item = shell.think;
  if (!item) return;
  shell.think = null;
  item.st.textContent = stat || "已完成";
  item.dur.textContent = ((Date.now() - item.at) / 1000).toFixed(1) + "s";
  if (!item.manual) item.det.open = false;
}

/* ── 工具卡片：行首齿轮恒定，状态用等宽小字写「执行中 / 完成 / 失败」 ── */
function appendPre(body, label, text) {
  const w = el("psec");
  w.appendChild(el2("plabel", label));
  const pre = document.createElement("pre");
  pre.textContent = text;
  w.appendChild(pre);
  body.appendChild(w);
}

function toolCard(shell, ev) {
  const det = document.createElement("details");
  det.className = "tool run";
  const sum = document.createElement("summary");
  sum.appendChild(iconSpan("tw", GEAR));
  sum.appendChild(el2("tname", ev.name || "tool"));
  sum.appendChild(el2("tsum", ""));
  sum.appendChild(el2("tstat", "执行中"));
  sum.appendChild(el2("tdur", ""));
  det.appendChild(sum);
  const body = el("tbody");
  if (ev.args) appendPre(body, "参数", ev.args);
  det.appendChild(body);
  shell.tl.appendChild(det);
  const item = { det, body };
  if (ev.id) shell.tools.set("id:" + ev.id, item);
  const name = ev.name || "tool";
  (shell.queue[name] = shell.queue[name] || []).push(item);
  scroll(false);
  return item;
}

function toolTake(shell, ev) {
  let item = ev.id ? shell.tools.get("id:" + ev.id) : null;
  if (item) shell.tools.delete("id:" + ev.id);
  if (!item) {
    const q = shell.queue[ev.name] || [];
    item = q.shift() || null;
  }
  /* start 事件丢失等兜底：直接补一张已建好的卡再定格 */
  if (!item) item = toolCard(shell, { id: "", name: ev.name, args: "" });
  return item;
}

function toolDone(shell, ev, ok) {
  const item = toolTake(shell, ev);
  item.det.className = "tool " + (ok ? "ok" : "bad");
  item.det.querySelector(".tstat").textContent = ok ? "完成" : "失败";
  item.det.querySelector(".tsum").textContent = String(ev.brief || "");
  item.det.querySelector(".tdur").textContent =
    ev.dur != null ? (ev.dur / 1000).toFixed(1) + "s" : "";
  if (ev.out) appendPre(item.body, "结果", ev.out);
  scroll(false);
}

/** 非工具错误（网络失败 / 中断 / agent err）：仍是等宽一行 */
function lineBad(tl, text, mark) {
  const p = el("tline bad");
  p.appendChild(el2("mark", mark || "✗"));
  p.appendChild(el2("st", text));
  tl.appendChild(p);
  scroll(false);
}

/* ── 成品文件下载行：工具结果带 files 时渲染在工具卡下方 ── */
function fmtSize(n) {
  if (!n) return "";
  return n >= 1048576
    ? (n / 1048576).toFixed(1) + " MB"
    : Math.max(1, Math.round(n / 1024)) + " KB";
}
function fileRows(tl, files) {
  files.forEach((f) => {
    const row = el("frow");
    row.appendChild(el2("fmark", "📎"));
    const nm = el2("fname", f.name + (f.size ? "（" + fmtSize(f.size) + "）" : ""));
    row.appendChild(nm);
    const a = document.createElement("a");
    a.className = "tbtn";
    a.href = "/files/" + encodeURIComponent(f.name);
    a.setAttribute("download", f.name);
    a.textContent = "下载";
    row.appendChild(a);
    tl.appendChild(row);
  });
  scroll(false);
}

/* ── 番茄钟卡片：新建计时随工具事件落到时间线里，每秒自跳 ── */
function pomoFmt(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
}
/* 到点三声提示音：WebAudio 现场合成，不依赖任何音频文件 */
function pomoBeep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    [0, 0.35, 0.7].forEach((off, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = i === 2 ? 660 : 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + off);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + off + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + off + 0.3);
      o.start(ctx.currentTime + off); o.stop(ctx.currentTime + off + 0.32);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch { /* 没声音就只靠视觉 */ }
}
function pomoCard(tl, p) {
  if (!p || !p.endsAt) return;
  const total = p.totalSec || Math.max(1, Math.round((p.endsAt - (p.startsAt || Date.now())) / 1000));
  const card = el("pomo");
  card.dataset.ends = String(p.endsAt);
  card.dataset.total = String(total);
  card.dataset.id = String(p.id || "");
  card.dataset.label = String(p.label || "专注");
  const row = el("prow");
  row.appendChild(el2("pmark", "🍅"));
  row.appendChild(el2("plabel", (p.label || "专注") + " · " + (p.focusMinutes || Math.round(total / 60)) + "分钟"));
  row.appendChild(el2("pmeta", "至 " + clock(p.endsAt) + " 结束"));
  card.appendChild(row);
  card.appendChild(el2("pclock", pomoFmt((p.endsAt - Date.now()) / 1000)));
  const bar = el("pbar");
  bar.appendChild(document.createElement("i"));
  card.appendChild(bar);
  const foot = el("pfoot");
  foot.appendChild(el2("pstate", "专注进行中"));
  if (p.status === "running") {
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "tbtn"; cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      /* 等服务端落盘再置灰，失败回滚按钮（对齐大厅面板的取消） */
      cancel.disabled = true;
      cancel.textContent = "取消中…";
      fetch("/api/pomodoro/cancel", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: card.dataset.id }),
      }).then((r) => { if (!r.ok) throw new Error("cancel failed"); })
        .then(() => {
          pomoCancelCard(card);
          /* 顶部恢复卡、别处的同 id 卡也一并收掉 */
          pomoSync();
        })
        .catch(() => {
          cancel.disabled = false;
          cancel.textContent = "取消";
          const st = card.querySelector(".pstate");
          if (st && !card.dataset.finished) {
            st.textContent = "取消失败，请重试";
            setTimeout(() => {
              if (st.isConnected && !card.dataset.finished && !card.classList.contains("cancelled"))
                st.textContent = "专注进行中";
            }, 2000);
          }
        });
    });
    foot.appendChild(cancel);
  }
  card.appendChild(foot);
  tl.appendChild(card);
  pomoTick();
  scroll(false);
}
/* 到点收尾：翻朱砂底 + 提示音 + 标题闪灯（切回页面自动复位）+ 一键接龙 */
function pomoFinish(card) {
  if (card.dataset.finished) return;
  delete card.dataset.confirming;
  card.dataset.finished = "1";
  card.classList.add("done");
  const clockEl = card.querySelector(".pclock"), fill = card.querySelector(".pbar i");
  if (clockEl) clockEl.textContent = "00:00";
  if (fill) fill.style.width = "100%";
  const st = card.querySelector(".pstate");
  if (st) st.textContent = "⏰ 时间到！休息一下吧";
  const btn = card.querySelector(".pfoot .tbtn");
  if (btn) btn.remove();
  /* 后续动作一键接龙：话术走正常对话，agent 建新计时后原链路再出一卡片 */
  const foot = card.querySelector(".pfoot");
  if (foot) {
    const mins = Math.max(1, Math.round((Number(card.dataset.total) || 1) / 60));
    const followup = (text, label) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "tbtn"; b.textContent = label;
      b.addEventListener("click", () => {
        if (busy) return;
        foot.querySelectorAll(".tbtn").forEach((x) => { x.disabled = true; });
        send(text);
      });
      return b;
    };
    foot.appendChild(followup("再来一个 " + mins + " 分钟番茄钟", "再来 " + mins + " 分钟"));
    foot.appendChild(followup("来一个 5 分钟番茄钟，休息一下", "休息 5 分钟"));
  }
  pomoBeep();
  document.title = "⏰ 番茄钟时间到 · CourseRaptor";
  try {
    if (window.Notification && Notification.permission === "granted") {
      new Notification("⏰ 番茄钟时间到", { body: (card.dataset.label || "专注") + "结束，休息一下吧" });
    }
  } catch { /* 通知发不出就只靠页面 */ }
}
/* 取消收尾：对话内的卡留档盖「已取消」章；恢复容器只是计时器的另一张脸，整张收走 */
function pomoCancelCard(card) {
  const restore = card.closest(".pomo-restore");
  if (restore) { restore.remove(); return; }
  card.classList.add("cancelled");
  const st = card.querySelector(".pstate");
  if (st) st.textContent = "已取消";
  const btn = card.querySelector(".pfoot .tbtn");
  if (btn) btn.remove();
}
/* 每秒刷全页进行中的卡片；到点先跟服务端对一次表——别处已取消的
   不再翻「时间到」、不响铃 */
function pomoTick() {
  const now = Date.now();
  document.querySelectorAll(".pomo").forEach((card) => {
    if (card.dataset.finished || card.classList.contains("cancelled")) return;
    const ends = Number(card.dataset.ends), total = Number(card.dataset.total) || 1;
    const left = Math.max(0, Math.ceil((ends - now) / 1000));
    const clockEl = card.querySelector(".pclock"), fill = card.querySelector(".pbar i");
    if (left > 0) {
      if (clockEl) clockEl.textContent = pomoFmt(left);
      if (fill) fill.style.width = (100 * (total - left) / total).toFixed(1) + "%";
      return;
    }
    if (clockEl) clockEl.textContent = "00:00";
    if (fill) fill.style.width = "100%";
    if (card.dataset.confirming) return;
    card.dataset.confirming = "1";
    pomoSync();
  });
}
/* 跟服务端对表：取消可能发生在本页按钮之外（agent 对话、大厅面板、别的
   标签页），已画的卡不会自己知道——查一次，cancelled 的收掉，等确认的
   到点卡按结果翻卡。start 画新卡走 fresh 事件，这里只兜状态变化 */
let pomoSyncing = false;
function pomoSync() {
  if (document.body.dataset.demo === "true" || pomoSyncing) return;
  pomoSyncing = true;
  fetch("/api/pomodoro").then((r) => r.json()).then((d) => {
    pomoSyncing = false;
    const activeId = d.active && d.active.id ? String(d.active.id) : "";
    const rec = {};
    (d.recent || []).forEach((p) => { if (p && p.id) rec[String(p.id)] = p; });
    document.querySelectorAll(".pomo").forEach((card) => {
      if (card.dataset.finished || card.classList.contains("cancelled")) return;
      const id = card.dataset.id || "";
      if (id && id === activeId) { delete card.dataset.confirming; return; }
      const remote = id ? rec[id] : null;
      if (remote && remote.status === "cancelled") { pomoCancelCard(card); return; }
      if (card.dataset.confirming && (!remote || remote.status !== "running")) pomoFinish(card);
    });
  }).catch(() => {
    pomoSyncing = false;
    /* 服务端联系不上：等确认的卡按本地 endsAt 兜底翻「时间到」，别卡死 */
    document.querySelectorAll(".pomo[data-confirming]").forEach((card) => {
      if (!card.dataset.finished && !card.classList.contains("cancelled")) pomoFinish(card);
    });
  });
}
setInterval(() => {
  pomoTick();
  try { if (typeof hallPomoTick === "function") hallPomoTick(); } catch { /* 大厅没开就跳过 */ }
}, 1000);
/* 低频对表：别处取消后，页面上的卡最多 10 秒内收掉 */
setInterval(pomoSync, 10000);

/* 刷新/重开页面后，后台还在走的番茄钟在时间线顶部恢复一张实时卡片。
   容器不挂 .turn：切会话清屏时留着——计时是全局的，不跟某段对话走 */
function restorePomoCard() {
  if (document.body.dataset.demo === "true") return;
  fetch("/api/pomodoro").then((r) => r.json()).then((d) => {
    const p = d.active;
    if (!p || p.status !== "running") return;
    const id = String(p.id || "");
    if (id && inner.querySelector('.pomo[data-id="' + id + '"]')) return;
    const wrap = el("pomo-restore");
    pomoCard(wrap, p);
    inner.prepend(wrap);
  }).catch(() => { /* 查不到就当没有：卡片本就只是计时器的另一张脸 */ });
}

/* ── 会话档案：列表 / 打开 / 删除 / 新会话 ── */
const sessList = document.getElementById("sessList");
/* 描线小图标：置顶图钉与空态档案盒（与齿轮、大厅宫格图标同一族） */
const PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24'
  + 'V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15'
  + ' 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>';
const ARCHIVE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<rect x="2" y="3" width="20" height="5" rx="1"/>'
  + '<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>'
  + '<path d="M10 12h4"/></svg>';

function renderSessList() {
  /* 菜单挂在 body 上，sessList.innerHTML 清不到它：每次重绘先摘掉旧菜单，
     本轮仍要显示的话循环里会重建并重新定位 */
  const staleMenu = document.querySelector("body > .smenu");
  if (staleMenu) staleMenu.remove();
  sessList.innerHTML = "";
  const archivedCount = lastSessions.filter((s) => s.archived).length;
  /* 兜底：归档视图里把最后一条也恢复/删掉时，自动切回主列表 */
  if (viewingArchived && !archivedCount) viewingArchived = false;
  const shownCount = viewingArchived ? archivedCount : lastSessions.length - archivedCount;
  document.getElementById("sessTitle").textContent = viewingArchived ? "已归档" : "会话档案";
  document.getElementById("sessCount").textContent = shownCount ? shownCount + " 个" : "";
  /* 主列表里有归档过才给入口；进了归档视图常驻「返回」 */
  const toggle = document.getElementById("sessArchiveToggle");
  toggle.hidden = !viewingArchived && !archivedCount;
  toggle.textContent = viewingArchived ? "返回" : "归档 " + archivedCount;
  const visible = lastSessions.filter((s) => !!s.archived === viewingArchived);
  if (!visible.length) {
    const li = document.createElement("li");
    li.className = "snone";
    const ico = el("");
    ico.innerHTML = ARCHIVE_SVG;
    li.appendChild(ico);
    li.appendChild(el2("snone-t", "档案室还空着"));
    li.appendChild(el2("snone-hint", archivedCount
      ? "会话都归档了，点右上「归档 " + archivedCount + "」可以找回。"
      : "在右侧开问一句，这轮对话就会归档到这里，重启也不丢。"));
    sessList.appendChild(li);
    return;
  }
  /* 不再按时间分组题注：服务端已按置顶 + 最近活跃排好序，直接平铺；
     置顶靠行内图钉徽标区分 */
  visible.forEach((s) => {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    if (s.archived) li.dataset.arch = "1";
    if (s.id === activeId) li.className = "on";
    /* tooltip 只给完整标题：悬停时时间戳在行内浮现，标题过长被渐隐，
       完整名称靠原生 tooltip 兜底 */
    li.title = s.title || "新会话";
    if (editingSessionId === s.id) {
      const edit = document.createElement("input");
      edit.className = "sedit"; edit.value = s.title || "新会话"; edit.maxLength = 60;
      edit.addEventListener("click", (e) => e.stopPropagation());
      edit.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveSessionTitle(s.id, edit.value); }
        if (e.key === "Escape") { editingSessionId = ""; renderSessList(); }
      });
      li.appendChild(edit);
      setTimeout(() => { edit.focus(); edit.select(); }, 0);
    } else {
      const title = el("st");
      if (s.pinned && !viewingArchived) {
        const pin = el("spin");
        pin.innerHTML = PIN_SVG;
        pin.appendChild(document.createTextNode("置顶"));
        title.appendChild(pin);
      }
      title.appendChild(document.createTextNode(s.title || "新会话"));
      li.appendChild(title);
      /* 标准时间戳：绝对定位浮在 ⋯ 左侧，悬停才淡入；与标题撞车时
         标题右侧渐隐让位（见 chat-page.ts 里 .sess li:hover .st 的 mask） */
      li.appendChild(el2("stime", fmtStamp(s.updatedAt)));
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "sx";
    x.dataset.actions = s.id;
    x.title = "会话操作";
    x.setAttribute("aria-label", "会话操作");
    x.setAttribute("aria-haspopup", "menu");
    x.setAttribute("aria-expanded", sessionActionsId === s.id ? "true" : "false");
    x.textContent = "⋯";
    li.appendChild(x);
    let menu = null;
    if (sessionActionsId === s.id && editingSessionId !== s.id) {
      menu = el("smenu");
      menu.setAttribute("role", "menu");
      const action = (label, key, danger) => {
        const button = document.createElement("button");
        button.type = "button"; button.dataset[key] = s.id; button.textContent = label;
        button.setAttribute("role", "menuitem");
        if (danger) button.className = "danger";
        menu.appendChild(button);
        return button;
      };
      /* 归档视图只留恢复与删除；主列表给全套人工动作 */
      if (viewingArchived) {
        action("取消归档", "unarchive");
      } else {
        action(s.pinned ? "取消置顶" : "置顶", "pin");
        action("改名", "rename");
        action("归档", "archive");
      }
      menu.appendChild(el("ssep"));
      const delBtn = action("删除", "del", true);
      /* 两步确认：已 armed 的那条直接渲染成确认态 */
      if (delArmId === s.id) {
        delBtn.dataset.armed = "1";
        delBtn.textContent = "确认删除";
        delBtn.classList.add("armed");
      }
    }
    sessList.appendChild(li);
    if (menu) {
      /* 菜单挂 body 走 fixed：侧栏列表是滚动容器，藏在 li 里会被裁剪；
         贴着 ⋯ 按钮右侧弹出。须等 li 入文档后才有真实 rect */
      document.body.appendChild(menu);
      const r = x.getBoundingClientRect();
      let left = r.right + 6;
      if (left + menu.offsetWidth > window.innerWidth - 8)
        left = window.innerWidth - menu.offsetWidth - 8;
      /* 窄屏抽屉收起时按钮整个在屏幕外（rect 为负）：夹回左缘兜底 */
      if (left < 8) left = 8;
      let top = r.top;
      if (top + menu.offsetHeight > window.innerHeight - 8)
        top = Math.max(8, window.innerHeight - menu.offsetHeight - 8);
      menu.style.left = left + "px";
      menu.style.top = top + "px";
    }
  });
}

function patchSession(id, body) {
  return fetch("/api/sessions/" + encodeURIComponent(id), {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.ok ? r.json() : Promise.reject(new Error("更新会话失败")));
}
function saveSessionTitle(id, title) {
  const value = String(title || "").trim();
  if (!value) return;
  patchSession(id, { title: value }).then(() => {
    editingSessionId = ""; sessionActionsId = ""; return refreshSessions();
  }).catch(() => {});
}

function refreshSessions() {
  return fetch("/api/sessions").then((r) => r.json()).then((d) => {
    lastSessions = d.sessions || [];
    renderSessList();
  }).catch(() => {});
}

function openSession(id) {
  activeId = id;
  lsSet(ACTIVE_KEY, id);
  return fetch("/api/sessions/" + encodeURIComponent(id))
    .then((r) => (r.ok ? r.json() : null)).then((d) => {
      msgs = (d && d.messages) || [];
      clearTurns();
      if (!msgs.length) { hero.style.display = ""; renderSessList(); closeDrawer(); return; }
      hero.style.display = "none";
      /* 重绘历史：渲染函数不写 msgs（它已是服务端数据的镜像） */
      msgs.forEach((m) => {
        if (m.role === "user") addUser(m.text, m.ts, m.attachments);
        else addBotMessage(m.text, m.ts, m.think);
      });
      scroll(true);
      renderSessList();
      closeDrawer();
    }).catch(() => {});
}

function delSession(id) {
  if (busy) return;
  /* 调用方已做两步确认（菜单 armed），这里不再弹 confirm */
  fetch("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" })
    .then(() => refreshSessions())
    .then(() => {
      if (id !== activeId) return;
      if (lastSessions.length) return openSession(lastSessions[0].id);
      activeId = "";
      lsSet(ACTIVE_KEY, "");
      startFresh();
    }).catch(() => {});
}

function startFresh() {
  activeId = uuid();
  lsSet(ACTIVE_KEY, activeId);
  msgs = [];
  clearTurns();
  hero.style.display = "";
  heroGreeting();
  renderSessList();
  input.focus();
}

/* 会话菜单挂 body 走 fixed，菜单按钮点不到 sessList 的委托：委托挂 document，
   li 分支限定 .sess 内的条目，免得大厅里的节点被误认成会话 */
document.addEventListener("click", (e) => {
  const del = e.target.closest("button[data-del]");
  if (del) {
    const id = del.dataset.del;
    /* 第一次点变身「确认删除」，3 秒内再点才执行，超时还原（对齐待办/知识页） */
    if (delArmId === id) {
      clearTimeout(delArmTimer);
      delArmId = "";
      sessionActionsId = "";
      delSession(id);
    } else {
      delArmId = id;
      renderSessList();
      clearTimeout(delArmTimer);
      delArmTimer = setTimeout(() => {
        if (delArmId === id) { delArmId = ""; renderSessList(); }
      }, 3000);
    }
    return;
  }
  const pin = e.target.closest("button[data-pin]");
  if (pin) {
    const current = lastSessions.find((s) => s.id === pin.dataset.pin);
    sessionActionsId = "";
    if (current) patchSession(current.id, { pinned: !current.pinned }).then(refreshSessions).catch(() => {});
    return;
  }
  const rename = e.target.closest("button[data-rename]");
  if (rename) { editingSessionId = rename.dataset.rename; sessionActionsId = ""; renderSessList(); return; }
  const archive = e.target.closest("button[data-archive]");
  if (archive) {
    sessionActionsId = "";
    patchSession(archive.dataset.archive, { archived: true }).then(refreshSessions).catch(() => {});
    return;
  }
  const unarchive = e.target.closest("button[data-unarchive]");
  if (unarchive) {
    sessionActionsId = "";
    patchSession(unarchive.dataset.unarchive, { archived: false }).then(refreshSessions).catch(() => {});
    return;
  }
  const actions = e.target.closest("button[data-actions]");
  if (actions) {
    sessionActionsId = sessionActionsId === actions.dataset.actions ? "" : actions.dataset.actions;
    renderSessList(); return;
  }
  const li = e.target.closest(".sess li[data-id]");
  if (li && !busy) { sessionActionsId = ""; openSession(li.dataset.id); }
});

/* 菜单 fixed 挂 body，不跟列表滚动/窗口缩放走：与其让它悬在半空错位，直接收起 */
function dismissSessionMenu() {
  if (sessionActionsId) { sessionActionsId = ""; renderSessList(); }
}
sessList.addEventListener("scroll", dismissSessionMenu, { passive: true });
window.addEventListener("resize", dismissSessionMenu);

/* 浮层菜单点外面任意处收起（菜单自身与 ⋯ 按钮在上面各自处理） */
document.addEventListener("click", (e) => {
  if (!sessionActionsId) return;
  if (e.target.closest(".smenu") || e.target.closest("button[data-actions]")) return;
  sessionActionsId = "";
  renderSessList();
});

/* 归档视图切换：标题、计数与菜单动作整套跟着换（renderSessList 内取景） */
document.getElementById("sessArchiveToggle").addEventListener("click", () => {
  viewingArchived = !viewingArchived;
  sessionActionsId = "";
  renderSessList();
});

function openDrawer() { document.body.classList.add("drawer-open"); }
function closeDrawer() { document.body.classList.remove("drawer-open"); }
document.getElementById("openDrawerM").addEventListener("click", openDrawer);
document.getElementById("drawerBackdrop").addEventListener("click", closeDrawer);

/* ── 功能大厅：右侧 push 抽屉。宫格是主页，各面板按需取数；
    对话过程中 agent 调到对应工具（TOOL_PANEL）时自动推出该面板。 ── */
/* 宫格图标：与工具卡齿轮同一族的 1.8px 描线 SVG（24 viewBox）。
    emoji 是彩色卡通，在墨色纸面上跳戏——单一朱砂让整套界面更像一份竖排卷宗 */
const HALL_ICONS = {
  today: '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<rect x="3" y="4" width="18" height="18" rx="2"/>'
    + '<path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  schedule: '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<rect x="3" y="4" width="18" height="18" rx="2"/>'
    + '<path d="M16 2v4M8 2v4M3 10h18"/>'
    + '<path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/></svg>',
  exams: '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/>'
    + '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>'
    + '<path d="M10 9H8M16 13H8M16 17H8"/></svg>',
  grades: '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M3 3v18h18"/>'
    + '<path d="M18 17V9M13 17V5M8 17v-3"/></svg>',
  news: '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="m3 11 18-5v12L3 14v-3z"/>'
    + '<path d="M11.6 16.8a3 3 0 0 1-3.5-1.5L3 14v3l5.1 1.4a3 3 0 0 0 3.5-1.6z"/></svg>',
  todos: '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>'
    + '<path d="M13 6h8M13 12h8M13 18h8"/></svg>',
  knowledge: '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>'
    + '<path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  pomodoro: '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<line x1="10" y1="2" x2="14" y2="2"/>'
    + '<line x1="12" y1="14" x2="15" y2="11"/>'
    + '<circle cx="12" cy="14" r="8"/></svg>',
  settings: GEAR,
};
const HALL_CARDS = [
  { id: "today", t: "今日日程", d: "下一节课、今日安排与本周概览", group: "学习安排" },
  { id: "schedule", t: "课表", d: "本周每天的课与调休安排", group: "学习安排" },
  { id: "exams", t: "考试", d: "临近考试的时间、地点与座位", group: "学习安排" },
  { id: "grades", t: "成绩", d: "GPA、学分与最近学期成绩速览", group: "学习安排" },
  { id: "news", t: "教务通知", d: "教务处官网最新通知，标记需要行动的", group: "学习安排" },
  { id: "todos", t: "待办", d: "逾期置顶，按今天 / 明天分组", group: "效率工具" },
  { id: "knowledge", t: "知识库", d: "按课程归类，可搜可展开全文", group: "效率工具" },
  /* 大厅入口按需求下架（2026-09-22）：宫格不再展示番茄钟；对话里说「来一个番茄钟」
     照常可用——manage_pomodoro 工具、SSE 事件、对话内 .pomo 倒计时卡与
     buildPomodoro 面板逻辑全部保留，恢复展示只需去掉 hidden 标记 */
  { id: "pomodoro", t: "番茄钟", d: "进行中实时倒计时与最近记录", group: "效率工具", hidden: true },
  { id: "settings", t: "设置", d: "教务账号、AI 模型、QQ、常用问题与本地数据", group: "系统" },
];
const HALL_GROUPS = ["学习安排", "效率工具", "系统"];
const HALL_TITLES = Object.fromEntries(HALL_CARDS.map((c) => [c.id, c.t]));
const HALL_DEMO = document.body.dataset.demo === "true";
const hallBody = document.getElementById("hallBody");
const hallTitle = document.getElementById("hallTitle");
const hallBack = document.getElementById("hallBack");
let hallPanel = "";        // 当前面板 id；空 = 宫格主页
let hallBrief = null;      // /api/today 一次取数，日程/课表/考试/待办/知识五个面板共享
let hallAutoMuted = false; // 本轮对话里用户手动关过抽屉：这轮不再自动弹

function briefOf() {
  if (hallBrief) return Promise.resolve(hallBrief);
  /* 演示模式同样走 /api/today（demo 服务给虚构简报），五个面板共用 */
  return fetch("/api/today").then((r) => r.json()).then((d) => { hallBrief = d; return d; });
}

function hallItem(title, meta, hot) {
  const item = el("hall-item" + (hot ? " hot" : ""));
  item.appendChild(el2("ht", title));
  if (meta) item.appendChild(el2("hm", meta));
  return item;
}
/* 带动作按钮的条目：标题/说明在 main 区，右侧「原文」等按钮独立点击不与条目冲突 */
function hallItemAct(title, meta, action, actLabel) {
  const item = el("hall-item has-act");
  const main = el("hall-item-main");
  main.appendChild(el2("ht", title));
  if (meta) main.appendChild(el2("hm", meta));
  item.appendChild(main);
  const b = document.createElement("button");
  b.type = "button"; b.className = "hall-del"; b.textContent = actLabel || "打开";
  b.addEventListener("click", (e) => { e.stopPropagation(); action(); });
  item.appendChild(b);
  return item;
}
function hallNote(text) { return el2("hall-note", text); }
/* 空态引导：一键回到输入框并预填话术（纯前端，不调后端） */
function hallFocusChat(preset) {
  try {
    closeHall();
    if (typeof preset === "string" && preset) {
      input.value = preset;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.focus();
  } catch { /* 输入框不在就只关抽屉 */ }
}
/* 知识日期：今天显示 HH:MM，其余显示 M月d日（与 fmtWhen 同口径，知识页用日精度） */
function hallKDate(ts) {
  if (!ts) return "";
  const d = new Date(ts), n = new Date();
  if (d.toDateString() === n.toDateString()) return pad(d.getHours()) + ":" + pad(d.getMinutes());
  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
}
/* 知识分类筛选中态：搜索框是文本维，这个是分类维，两者叠加 */
let hallKnowCat = "";
/* 知识条目：标题 + 分类·日期·摘要，可展开看全文（main 区是热区，删除按钮在外不冲突），
   删除乐观更新（先移除节点，失败重刷恢复） */
function hallKnowledgeItem(k) {
  const full = String(k.content || "").replace(/\s+/g, " ").trim();
  const snippet = full.slice(0, 60);
  const date = hallKDate(k.updatedAt);
  const head = (k.category || "未分类") + (date ? " · " + date + " · " : " · ");
  const item = el("hall-item has-act know");
  item.dataset.category = k.category || "未分类";
  const main = el("hall-item-main");
  main.appendChild(el2("ht", k.title));
  const meta = el2("hm", head + snippet + (full.length > snippet.length ? "…" : ""));
  if (k.source) meta.title = "来源：" + k.source;
  main.appendChild(meta);
  item.appendChild(main);
  if (!HALL_DEMO) item.appendChild(hallDelBtn("删除", () => {
    item.remove();
    hallRecount("knowledge");
    fetch("/api/knowledge/" + encodeURIComponent(k.id), { method: "DELETE" })
      .then((r) => { if (!r.ok) throw new Error("delete failed"); })
      .catch(() => renderHall(true));
  }));
  /* 全文比摘要长才可展开；监听器挂 main 上，删除按钮点不进来 */
  if (full.length > snippet.length) {
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-expanded", "false");
    item.title = "点击展开全文";
    const toggle = () => {
      const open = item.classList.toggle("open");
      meta.textContent = head + (open ? full : snippet);
      meta.classList.toggle("more", open);
      item.setAttribute("aria-expanded", open ? "true" : "false");
    };
    main.addEventListener("click", toggle);
    item.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !e.target.closest("button")) {
        e.preventDefault();
        toggle();
      }
    });
  }
  return item;
}
/* 两步删除防误删：第一击变「确认删除」，3 秒内再击才执行，超时还原 */
function hallDelBtn(label, onConfirm) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "hall-del"; b.textContent = label;
  let armed = false, timer = 0;
  b.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      b.textContent = "确认删除";
      b.classList.add("armed");
      timer = window.setTimeout(() => {
        armed = false; b.textContent = label; b.classList.remove("armed");
      }, 3000);
      return;
    }
    window.clearTimeout(timer);
    onConfirm();
  });
  return b;
}
/* 空态：虚线框纸片 + 标题 + 等宽小字说明，与档案空态同一语言 */
function hallEmpty(icon, title, hint, actionLabel, onAction) {
  const box = el("hall-empty");
  box.appendChild(el2("he-ico", icon));
  box.appendChild(el2("he-t", title));
  if (hint) box.appendChild(el2("he-s", hint));
  if (actionLabel && onAction) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "tbtn"; btn.textContent = actionLabel;
    btn.addEventListener("click", onAction);
    box.appendChild(btn);
  }
  return box;
}
/* 骨架屏：先占位再补画，避免取数时布局跳动；aria-busy 交给调用方 */
function hallSkel() {
  const sk = el("hall-skel");
  sk.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) sk.appendChild(document.createElement("i"));
  return sk;
}
function hallFullPage(panel) {
  if (panel === "knowledge") return "/knowledge";
  /* 番茄钟/成绩/通知没有独立完整页：工具条不挂「完整页」链接 */
  if (panel === "pomodoro" || panel === "grades" || panel === "news") return "";
  return "/today";
}
function hallMore(panel) {
  const a = document.createElement("a");
  a.className = "hall-more"; a.href = hallFullPage(panel);
  a.textContent = "完整页 →";
  a.setAttribute("aria-label", "在完整页打开" + (HALL_TITLES[panel] || panel));
  return a;
}
/* 面板工具条：左侧条数，右侧刷新 + 完整页；刷新清掉 brief 缓存重取 */
function hallToolbar(panel, countText) {
  const bar = el("hall-toolbar");
  const count = el2("hall-count", countText || "");
  bar.appendChild(count);
  const refresh = document.createElement("button");
  refresh.type = "button"; refresh.className = "hall-refresh"; refresh.textContent = "↻ 刷新";
  refresh.setAttribute("aria-label", "刷新" + (HALL_TITLES[panel] || panel));
  refresh.addEventListener("click", () => {
    /* 即时 disabled + 文案，避免重复点击；新工具条重建时自然恢复 */
    refresh.disabled = true;
    refresh.textContent = "刷新中…";
    renderHall(true);
  });
  bar.appendChild(refresh);
  const more = hallFullPage(panel);
  if (more) bar.appendChild(hallMore(panel));
  return bar;
}

/* 各面板的构建函数：入参是 /api/today 的 Brief（番茄钟除外，走自己的接口）。
   只返回列表内容；工具条（条数 + 刷新 + 完整页）由 renderHall 统一补。 */
function buildToday(b) {
  const wrap = el("");
  wrap.appendChild(hallItem(b.dateLabel + " · " + (b.term.weekLabel || "未在教学周"), "", true));
  /* 今日日程只看今天：brief.next 会向后看到最多 14 天，跨天的（明天及以后）不进这个面板 */
  const todayNext = b.next && b.next.dateLabel === "今天" ? b.next : null;
  if (todayNext) {
    wrap.appendChild(hallItem("下一节 · " + todayNext.course.title,
      (todayNext.course.time || todayNext.course.periods || "")
      + (todayNext.course.location ? " @" + todayNext.course.location : ""),
      todayNext.startsInMin <= 60));
  }
  /* 放假 / 调休补课的当日说明（如「今天是调休补课日，按被换周几的课表上课」） */
  if (b.schedule.note) wrap.appendChild(hallNote(b.schedule.note));
  const list = b.schedule.courses || [];
  list.forEach((c) => {
    wrap.appendChild(hallItem(c.title,
      [c.periods, c.time, c.location ? "@" + c.location : "",
       c.status === "done" ? "已下课" : c.status === "current" ? "进行中" : ""].filter(Boolean).join(" · "),
      c.status === "current"));
  });
  if (!list.length && !todayNext) {
    wrap.appendChild(hallEmpty("🍃", "今天没有课", "在对话框里问「这周课表」查看整周安排。"));
  }
  return wrap;
}
function buildSchedule(b) {
  const wrap = el("");
  if (!b.schedule.available) {
    wrap.appendChild(hallEmpty("🗓️", "还没有课表", "在对话框里说「课表」，查询后这里就会显示。"));
    return wrap;
  }
  ((b.week && b.week.days) || []).forEach((d) => {
    if (d.holiday) {
      wrap.appendChild(hallItem(d.label + " " + d.dateShort, d.holiday + (d.makeup ? " · 调休补课日" : "")));
      return;
    }
    d.courses.forEach((c) => {
      wrap.appendChild(hallItem(d.label + " " + c.title,
        [c.time, c.location ? "@" + c.location : "", c.teacher].filter(Boolean).join(" · "), d.isToday));
    });
  });
  return wrap;
}
function buildExams(b) {
  const wrap = el("");
  const list = (b.exams && b.exams.upcoming) || [];
  if (!list.length) {
    wrap.appendChild(hallEmpty("📝", "近 14 天没有考试", "有新安排时，这里会标出时间、地点与座位。"));
    return wrap;
  }
  list.forEach((x) => {
    wrap.appendChild(hallItem(x.subject,
      [x.date, x.time, x.location, x.seatNumber ? "座位 " + x.seatNumber : ""].filter(Boolean).join(" · "),
      x.isToday || x.inDays <= 3));
  });
  return wrap;
}
/* 分组题注计数同步：条目被就地移除/恢复后改写「组名 · N」，组空时连同题注一起收掉 */
function hallRetitleGroup(group) {
  if (!group || !group.classList.contains("hall-todo-group")) return;
  const head = group.previousElementSibling;
  const kids = group.querySelectorAll(".hall-item").length;
  if (!kids) {
    if (head && head.classList.contains("hall-group")) head.remove();
    group.remove();
    return;
  }
  if (head && head.classList.contains("hall-group")) {
    const name = head.dataset.hallGroup || head.textContent.split(" ·")[0];
    if (name) head.textContent = name + " · " + kids;
  }
}
/* 待办条目行：勾选完成 + 删除都是乐观更新；逾期朱砂高亮，备注悬停可见，附 .ics 导出 */
function todoHallItem(t) {
  const item = el("hall-item has-act" + (t.overdue ? " hot" : ""));
  /* 勾选即完成：乐观更新——先变灰，落盘成功直接移除节点（未完成列表里自然消失），
     失败才回滚；整面板不重刷，焦点与滚动都不丢 */
  const pick = document.createElement("input");
  pick.type = "checkbox"; pick.className = "hall-done"; pick.title = "标记完成";
  pick.setAttribute("aria-label", "标记完成：" + t.title);
  pick.disabled = HALL_DEMO;
  if (!HALL_DEMO) pick.addEventListener("change", () => {
    const done = pick.checked;
    item.classList.toggle("done", done);
    pick.disabled = true;
    fetch("/api/reminders/" + encodeURIComponent(t.id), {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ done }),
    }).then((r) => {
      if (!r.ok) throw new Error("save failed");
      /* 落盘后整面板重排：刚完成的条目立即进「已完成」折叠区，勾错就地能撤销。
         数据说话，分组/计数/搜索态都由重建逻辑统一接管 */
      renderHall(true);
    }).catch(() => {
      pick.checked = !done;
      item.classList.toggle("done", !done);
      pick.disabled = false;
    });
  });
  item.appendChild(pick);
  const main = el("hall-item-main");
  const ht = el2("ht", t.title);
  if (t.notes) ht.title = t.notes;
  main.appendChild(ht);
  const metaText = t.dueLabel
    + (t.overdue ? " · 已逾期" : t.isToday ? " · 今天到期" : "")
    + (t.source ? " · 来自" + t.source : "");
  const hm = el2("hm", metaText);
  if (t.overdue) {
    hm.innerHTML = "";
    hm.appendChild(document.createTextNode(t.dueLabel + " · "));
    const tag = document.createElement("span");
    tag.className = "overdue-tag";
    tag.textContent = "⚠ 已逾期";
    hm.appendChild(tag);
    if (t.source) hm.appendChild(document.createTextNode(" · 来自" + t.source));
  }
  if (t.notes) hm.title = t.notes;
  main.appendChild(hm);
  item.appendChild(main);
  if (!HALL_DEMO && t.id) {
    const ics = document.createElement("a");
    ics.className = "hall-ics";
    ics.href = "/api/reminders/" + encodeURIComponent(t.id) + ".ics";
    ics.textContent = ".ics";
    ics.title = "导出到手机日历";
    ics.setAttribute("aria-label", "导出待办到日历：" + t.title);
    item.appendChild(ics);
  }
  if (!HALL_DEMO) item.appendChild(hallDelBtn("删除", () => {
    /* 删除同样乐观：先移除节点，失败整面板重刷恢复 */
    const group = item.parentElement;
    item.remove();
    hallRetitleGroup(group);
    hallRecount("todos");
    fetch("/api/reminders/" + encodeURIComponent(t.id), { method: "DELETE" })
      .then((r) => { if (!r.ok) throw new Error("delete failed"); })
      .catch(() => renderHall(true));
  }));
  return item;
}
/* 已完成条目：取消勾选即恢复为未完成（乐观标记后重排），删除同两步确认 */
function todoDoneItem(t) {
  const item = el("hall-item has-act done");
  const pick = document.createElement("input");
  pick.type = "checkbox"; pick.className = "hall-done"; pick.checked = true;
  pick.title = "取消勾选就恢复为未完成";
  pick.setAttribute("aria-label", "恢复未完成：" + t.title);
  if (HALL_DEMO) {
    pick.disabled = true;
  } else {
    pick.addEventListener("change", () => {
      pick.checked = true;
      /* 恢复要重新落进未完成分组，就地重排不如让数据说话；失败回滚无需处理（勾选态始终勾着） */
      pick.disabled = true;
      fetch("/api/reminders/" + encodeURIComponent(t.id), {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: false }),
      }).then((r) => {
        if (!r.ok) throw new Error("save failed");
        renderHall(true);
      }).catch(() => { pick.disabled = false; });
    });
  }
  item.appendChild(pick);
  const main = el("hall-item-main");
  main.appendChild(el2("ht", t.title));
  main.appendChild(el2("hm", (t.doneAt ? "完成于 " + fmtWhen(t.doneAt) + " · " : "") + "原截止 " + t.dueLabel));
  item.appendChild(main);
  if (!HALL_DEMO) item.appendChild(hallDelBtn("删除", () => {
    const group = item.parentElement;
    item.remove();
    hallRetitleGroup(group);
    hallRecount("todos");
    fetch("/api/reminders/" + encodeURIComponent(t.id), { method: "DELETE" })
      .then((r) => { if (!r.ok) throw new Error("delete failed"); })
      .catch(() => renderHall(true));
  }));
  return item;
}
/* 已完成区的折叠开关：状态只记在内存里，切面板回来保持上次的展开偏好 */
let todoDoneOpen = false;
function buildTodoList(data) {
  const wrap = el("");
  data = data || {};
  const list = data.items || [];
  const doneList = data.done || [];
  if (!list.length) {
    wrap.appendChild(hallEmpty("✅", "暂无待办", "在对话框里说「提醒我……」，我会帮你记录并排进分组。",
      HALL_DEMO ? "" : "去记第一条",
      HALL_DEMO ? null : () => hallFocusChat("提醒我：")));
  }
  /* 分组：逾期 / 今天 / 明天 / 以后（与 /today 页同口径，逾期自然置顶） */
  const groups = [
    { name: "逾期", overdue: true, items: [] },
    { name: "今天", overdue: false, items: [] },
    { name: "明天", overdue: false, items: [] },
    { name: "以后", overdue: false, items: [] },
  ];
  list.forEach((t) => {
    if (t.overdue) groups[0].items.push(t);
    else if (t.isToday) groups[1].items.push(t);
    else if ((t.dueLabel || "").indexOf("明天") === 0) groups[2].items.push(t);
    else groups[3].items.push(t);
  });
  groups.forEach((g) => {
    if (!g.items.length) return;
    const head = el("hall-group" + (g.overdue ? " overdue" : ""));
    head.textContent = g.name + " · " + g.items.length;
    head.dataset.hallGroup = g.name;
    wrap.appendChild(head);
    const box = el("hall-todo-group");
    box.dataset.hallGroup = g.name;
    g.items.forEach((t) => { box.appendChild(todoHallItem(t)); });
    wrap.appendChild(box);
  });
  /* 已完成折叠区：默认收起不抢注意力，点题注就地展开（不重拉数据） */
  if (doneList.length) {
    const head = document.createElement("button");
    head.type = "button"; head.className = "hall-group toggle";
    head.dataset.hallGroup = "已完成";
    head.textContent = "已完成 · " + doneList.length + (todoDoneOpen ? " ▾" : " ▸");
    head.setAttribute("aria-expanded", todoDoneOpen ? "true" : "false");
    head.title = todoDoneOpen ? "收起已完成待办" : "展开已完成待办";
    const box = el("hall-todo-group");
    box.dataset.hallGroup = "已完成";
    box.hidden = !todoDoneOpen;
    doneList.forEach((t) => { box.appendChild(todoDoneItem(t)); });
    head.addEventListener("click", () => {
      todoDoneOpen = !todoDoneOpen;
      box.hidden = !todoDoneOpen;
      head.textContent = "已完成 · " + box.querySelectorAll(".hall-item").length
        + (todoDoneOpen ? " ▾" : " ▸");
      head.setAttribute("aria-expanded", todoDoneOpen ? "true" : "false");
      head.title = todoDoneOpen ? "收起已完成待办" : "展开已完成待办";
      if (todoDoneOpen) {
        const first = box.querySelector(".hall-item .hall-done");
        hallRecount("todos");
        if (first) first.focus();
      } else {
        head.focus();
      }
    });
    wrap.appendChild(head);
    wrap.appendChild(box);
  }
  return wrap;
}
/* 知识分类条：全部分类 chip，点选过滤（与搜索框叠加）；只在条目多于 1 类时出现 */
function hallKnowCats(entries) {
  const cats = [];
  const seen = {};
  (entries || []).forEach((k) => {
    const c = k.category || "未分类";
    if (!seen[c]) { seen[c] = 1; cats.push(c); }
  });
  if (cats.length < 2) return null;
  cats.sort((a, b) => a.localeCompare(b, "zh-CN"));
  const bar = el("hall-cats");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "按分类筛选知识");
  const all = document.createElement("button");
  all.type = "button"; all.className = "hall-cat" + (!hallKnowCat ? " on" : "");
  all.textContent = "全部 " + entries.length;
  all.addEventListener("click", () => { hallKnowCat = ""; renderHall(true); });
  bar.appendChild(all);
  cats.forEach((c) => {
    const n = entries.filter((k) => (k.category || "未分类") === c).length;
    const b = document.createElement("button");
    b.type = "button"; b.className = "hall-cat" + (hallKnowCat === c ? " on" : "");
    b.textContent = c + " " + n;
    b.setAttribute("aria-pressed", hallKnowCat === c ? "true" : "false");
    b.addEventListener("click", () => { hallKnowCat = (hallKnowCat === c ? "" : c); renderHall(true); });
    bar.appendChild(b);
  });
  return bar;
}
function hallKnowEmpty() {
  return hallEmpty("📚", "知识库还是空的",
    "在对话框里分享知识点（或说「记住：……」），我会按课程归类记进来。",
    HALL_DEMO ? "" : "去记第一条",
    HALL_DEMO ? null : () => hallFocusChat("记住："));
}
function buildKnowledge(b) {
  /* 演示环境没有 /api/knowledge 接口：保持 brief 速览（只读，带日期） */
  if (HALL_DEMO) {
    const wrap = el("");
    const recent = (b.knowledge && b.knowledge.recent) || [];
    if (!recent.length) {
      wrap.appendChild(hallEmpty("📚", "知识库还是空的", "对话中沉淀的知识点会自动收录到这里。"));
      return wrap;
    }
    wrap.dataset.total = String((b.knowledge && b.knowledge.total) || recent.length);
    recent.forEach((k) => {
      const date = hallKDate(k.updatedAt);
      wrap.appendChild(hallItem(k.title,
        (k.category || "未分类") + (date ? " · " + date : "") + " · "
        + String(k.content || "").replace(/\s+/g, " ").slice(0, 60)));
    });
    return wrap;
  }
  /* 正式环境：全量列表 + 分类筛 + 两步删除（与 /knowledge 页同一防误删口径）；
     条目多时厅内只展前 30 条，余下走完整页，避免抽屉过长 */
  return fetch("/api/knowledge").then((r) => r.json()).then((d) => {
    const wrap = el("");
    let entries = d.entries || [];
    wrap.dataset.total = String(entries.length);
    if (!entries.length) {
      wrap.appendChild(hallKnowEmpty());
      return wrap;
    }
    if (hallKnowCat) entries = entries.filter((k) => (k.category || "未分类") === hallKnowCat);
    const cats = hallKnowCats(d.entries || []);
    if (cats) wrap.appendChild(cats);
    if (!entries.length) {
      wrap.appendChild(hallEmpty("📚", "该分类下暂无条目", "换个分类或清空搜索试试。"));
      return wrap;
    }
    const LIMIT = 30;
    const shown = entries.slice(0, LIMIT);
    const box = el("hall-know-list");
    shown.forEach((k) => { box.appendChild(hallKnowledgeItem(k)); });
    wrap.appendChild(box);
    if (entries.length > LIMIT) {
      wrap.appendChild(hallNote("仅显示前 " + LIMIT + " 条，共 " + entries.length + " 条；完整检索去知识库完整页。"));
    }
    return wrap;
  });
}
/* 番茄钟日期：M月d日 HH:MM（最近记录用，日精度不够看） */
function hallPomoDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 "
    + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function buildPomodoro() {
  const wrap = el("");
  if (HALL_DEMO) {
    wrap.appendChild(hallEmpty("🍅", "没有进行中的番茄钟", "演示模式不计时；正式运行后这里显示实时倒计时与最近记录。",
      "去开始一个 25 分钟", () => hallFocusChat("来一个 25 分钟番茄钟")));
    return wrap;
  }
  return fetch("/api/pomodoro").then((r) => r.json()).then((d) => {
    if (d.active) {
      const p = d.active;
      const total = p.totalSec || Math.max(1, (p.focusMinutes || 25) * 60);
      const card = el("hall-item hot hall-pomo-active");
      card.appendChild(el2("ht", (p.label || "专注") + " · 进行中"));
      const clk = el2("hall-pomo-clock", pomoFmt((p.remainingSec != null ? p.remainingSec : Math.max(0, (p.endsAt - Date.now()) / 1000))));
      clk.dataset.ends = String(p.endsAt || "");
      card.appendChild(clk);
      card.appendChild(el2("hm", "共 " + (p.focusMinutes || Math.round(total / 60)) + " 分钟 · 至 " + clock(p.endsAt) + " 结束"));
      const bar = el("hall-pomo-bar");
      const fill = document.createElement("i");
      fill.dataset.ends = String(p.endsAt || "");
      fill.dataset.total = String(total);
      bar.appendChild(fill);
      card.appendChild(bar);
      const row = el("hall-pomo-row");
      row.appendChild(el2("hall-count", "时间到会响铃 + 标题闪灯，切页也能结算"));
      const cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "hall-pomo-cancel"; cancel.textContent = "取消";
      cancel.setAttribute("aria-label", "取消番茄钟：" + (p.label || "专注"));
      cancel.addEventListener("click", () => {
        cancel.disabled = true;
        cancel.textContent = "取消中…";
        fetch("/api/pomodoro/cancel", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(p.id ? { id: p.id } : {}),
        }).then(() => renderHall(true)).catch(() => {
          cancel.disabled = false;
          cancel.textContent = "取消";
        });
      });
      row.appendChild(cancel);
      card.appendChild(row);
      wrap.appendChild(card);
      hallPomoTick();
    } else {
      wrap.appendChild(hallEmpty("🍅", "没有进行中的番茄钟", "厅里只看进度；开始还是在对话框里说一声。",
        "去开始一个 25 分钟", () => hallFocusChat("来一个 25 分钟番茄钟")));
    }
    const stateName = { running: "进行中", done: "已完成", cancelled: "已取消" };
    const recent = (d.recent || []).slice(0, 5);
    if (recent.length) {
      const head = el("hall-group");
      head.textContent = "最近 · " + recent.length;
      wrap.appendChild(head);
      recent.forEach((p) => {
        wrap.appendChild(hallItem(p.label,
          (stateName[p.status] || p.status) + " · " + p.focusMinutes + " 分钟"
          + (p.startsAt ? " · " + hallPomoDate(p.startsAt) : ""),
          p.status === "running"));
      });
    }
    if (!d.active) wrap.appendChild(hallNote("提示：在对话框说「来一个 25 分钟番茄钟」，这里会自动倒计时。"));
    return wrap;
  });
}
/* 大厅番茄钟每秒自跳：时钟 + 进度条（与对话内 .pomo 卡的 pomoTick 同频，互不干扰） */
function hallPomoTick() {
  const now = Date.now();
  document.querySelectorAll(".hall-pomo-clock[data-ends]").forEach((clk) => {
    const ends = Number(clk.dataset.ends);
    if (!ends) return;
    const left = Math.max(0, Math.ceil((ends - now) / 1000));
    clk.textContent = pomoFmt(left);
  });
  document.querySelectorAll(".hall-pomo-bar i[data-ends]").forEach((fill) => {
    const ends = Number(fill.dataset.ends), total = Number(fill.dataset.total) || 1;
    const left = Math.max(0, Math.ceil((ends - now) / 1000));
    fill.style.width = (100 * (total - left) / total).toFixed(1) + "%";
  });
}
/* 成绩面板：纯缓存（get_grades 查通一次即落盘），零登录零模型 */
function gradesRender(g, wrap) {
  if (g.savedAt == null) {
    wrap.appendChild(hallEmpty("📊", "还没有成绩缓存", "在对话框里说「我的成绩」，查询后这里就会显示。"));
    return wrap;
  }
  wrap.dataset.total = String(g.courseCount || 0);
  wrap.appendChild(hallItem("GPA " + g.gpa + (g.gpaBasis ? "（" + g.gpaBasis + "）" : ""),
    "必修学分 " + g.requiredCredits + " · 共 " + g.courseCount + " 门课", true));
  if (g.recentSemester) {
    wrap.appendChild(hallNote("最近学期 " + g.recentSemester + "："));
    (g.recentCourses || []).slice(0, 8).forEach((c) => {
      wrap.appendChild(hallItem(c.course, "成绩 " + c.score + " · " + c.credit + " 学分" + (c.type ? " · " + c.type : "")));
    });
  }
  wrap.appendChild(hallNote("缓存于 " + new Date(g.savedAt).toLocaleString("zh-CN", { hour12: false }) + "；在对话框里再问一次成绩即刷新。"));
  return wrap;
}
function buildGrades() {
  const wrap = el("");
  /* 演示给一份虚构成绩单，让面板形态可见；其余环境读真实缓存 */
  if (HALL_DEMO) {
    return Promise.resolve(gradesRender({
      savedAt: Date.now() - 26 * 3600_000,
      gpa: "3.61", gpaBasis: "4.0 制（示例）",
      requiredCredits: "42.5", courseCount: 36,
      recentSemester: "2025-2026-2（示例）",
      recentCourses: [
        { course: "示例高等数学", score: "92", credit: "5", type: "必修" },
        { course: "示例大学英语", score: "88", credit: "3", type: "必修" },
        { course: "示例程序设计", score: "95", credit: "4", type: "必修" },
        { course: "示例体育课", score: "85", credit: "1", type: "选修" },
      ],
    }, wrap));
  }
  return fetch("/api/grades").then((r) => r.json()).then((g) => gradesRender(g, wrap));
}
/* 教务通知面板：现场抓官网公开页（无需登录，可能要几秒） */
function buildNews() {
  const wrap = el("");
  if (HALL_DEMO) { wrap.appendChild(hallEmpty("📣", "演示模式不抓取官网", "教务通知需要联网；正式运行后这里显示最新通知，需行动的置顶。")); return wrap; }
  return fetch("/api/news").then((r) => r.json()).then((d) => {
    const items = d.items || [];
    wrap.dataset.total = String(items.length);
    if (d.error) wrap.appendChild(hallNote("抓取失败：" + d.error));
    if (!items.length) {
      if (!d.error) wrap.appendChild(hallEmpty("📣", "没抓到通知", "教务处官网结构可能变化，或当前网络异常。"));
      return wrap;
    }
    if (d.gradeBasis) wrap.appendChild(hallNote("已按你所在「" + d.gradeBasis + " 级」标记相关性，需行动的置顶。"));
    /* 稳定排序把 high 挪到最前（组内保持日期新旧序），兑现提示里的「置顶」 */
    items.slice().sort((a, b) => (b.relevance === "high" ? 1 : 0) - (a.relevance === "high" ? 1 : 0)).forEach((n) => {
      wrap.appendChild(hallItemAct(n.title,
        [n.category, n.date, n.relevance === "high" ? "需本人行动" : n.relevance === "medium" ? "视个人情况" : "", n.restricted ? "原文限校内权限访问" : ""].filter(Boolean).join(" · "),
        () => { window.open(n.url, "_blank", "noopener"); }, "原文"));
      const item = wrap.lastChild;
      if (n.relevance === "high") item.classList.add("hot");
    });
    return wrap;
  });
}
const HALL_PANELS = {
  today: () => briefOf().then(buildToday),
  schedule: () => briefOf().then(buildSchedule),
  exams: () => briefOf().then(buildExams),
  grades: buildGrades,
  news: buildNews,
  todos: () => briefOf().then((b) => buildTodoList(b.todos)),
  knowledge: () => briefOf().then(buildKnowledge),
  pomodoro: buildPomodoro,
};

/* 大厅焦点归还：记住抽屉外的打开者，关闭时还回去（键盘用户不丢位置） */
let hallReturnFocus = null;
function hallSyncExpanded() {
  const open = document.body.classList.contains("hall-open");
  for (const id of ["openHall", "openHallM"]) {
    const btn = document.getElementById(id);
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
}
/* 面板内搜索：切面板清空，刷新保留（勾选/删除后搜索态不丢） */
let hallSearch = { panel: "", q: "" };
const HALL_SEARCHABLE = ["schedule", "exams", "todos", "knowledge"];
function hallListTotal(node, panel) {
  const items = node.querySelectorAll ? node.querySelectorAll(".hall-item").length : 0;
  if (panel === "knowledge" && node.dataset && node.dataset.total && !hallKnowCat) {
    return Number(node.dataset.total) || items;
  }
  return items;
}
/* 面板装配：工具条（条数 + 刷新 + 完整页）+ 搜索框 + 列表内容 */
function hallMountPanel(dyn, panel, node) {
  const total = hallListTotal(node, panel);
  dyn.innerHTML = "";
  dyn.appendChild(hallToolbar(panel, total ? "共 " + total + " 条" : ""));
  if (HALL_SEARCHABLE.includes(panel)) dyn.appendChild(hallSearchBox(panel));
  node.classList.add("hall-dyn-in");
  node.dataset.hallList = "1";
  dyn.appendChild(node);
  dyn.setAttribute("aria-busy", "false");
  hallApplySearch(dyn, panel);
}
function hallSearchBox(panel) {
  const box = el("hall-search");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "搜索" + (HALL_TITLES[panel] || "本面板") + "…";
  input.setAttribute("aria-label", "在" + (HALL_TITLES[panel] || "本面板") + "中搜索");
  input.value = hallSearch.panel === panel ? hallSearch.q : "";
  input.addEventListener("input", () => {
    hallSearch = { panel, q: input.value };
    hallApplySearch(document.getElementById("hallDyn"), panel);
  });
  /* 有内容时 Esc 只清空搜索（吞掉，不冒泡去关抽屉）；无内容才放行 */
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      e.stopPropagation();
      input.value = "";
      hallSearch = { panel, q: "" };
      hallApplySearch(document.getElementById("hallDyn"), panel);
    }
  });
  box.appendChild(input);
  return box;
}
/* 按标题 + 说明过滤条目，计数联动成「可见 / 全部」；分组题注随之显隐，避免光杆标题 */
function hallApplySearch(dyn, panel) {
  const node = dyn.querySelector("[data-hall-list]");
  if (!node) return;
  const q = (hallSearch.panel === panel ? hallSearch.q : "").trim().toLowerCase();
  const items = [...node.querySelectorAll(".hall-item")];
  let visible = 0;
  items.forEach((it) => {
    const hit = !q || it.textContent.toLowerCase().includes(q);
    it.style.display = hit ? "" : "none";
    if (hit) visible++;
  });
  /* 待办/番茄钟的分组头：组内全被滤掉就一起藏，组内有可见才留 */
  node.querySelectorAll(".hall-group").forEach((head) => {
    const key = head.dataset.hallGroup;
    /* 番茄钟「最近」头没有 dataset key：看它后面直到下一个头的条目即可 */
    let box = null;
    if (key) {
      box = node.querySelector('[data-hall-group="' + key + '"].hall-todo-group')
        || head.nextElementSibling;
    } else {
      box = head.nextElementSibling;
    }
    if (!box) return;
    const kids = [...box.querySelectorAll(".hall-item")];
    /* 只有待办分组盒才按组藏；知识列表没有分组头（分类走 chip），番茄钟最近头同理按可见收。
       已完成区默认折叠：搜索命中它的条目时临时展开，无搜索词时回到折叠偏好 */
    const anyVisible = kids.some((k) => k.style.display !== "none");
    head.style.display = (!q || anyVisible) ? "" : "none";
    if (box.classList && box.classList.contains("hall-todo-group")) {
      const doneFolded = box.dataset.hallGroup === "已完成" && !todoDoneOpen;
      box.style.display = doneFolded && !q ? "none" : (!q || anyVisible) ? "" : "none";
    }
  });
  let nosearch = dyn.querySelector("[data-hall-nosearch]");
  if (!nosearch) {
    nosearch = hallEmpty("🔍", "没有匹配条目", "换个关键词试试。");
    nosearch.dataset.hallNosearch = "1";
    dyn.appendChild(nosearch);
  }
  nosearch.hidden = !q || visible > 0;
  const count = dyn.querySelector(".hall-count");
  if (count) {
    const total = hallListTotal(node, panel);
    count.textContent = q ? visible + " / " + total + " 条"
      : (total ? "共 " + total + " 条" : "");
  }
}
/* 乐观更新后只重算计数（不整面板重刷，焦点与滚动都不丢） */
function hallRecount(panel) {
  const dyn = document.getElementById("hallDyn");
  if (dyn && hallPanel === panel) hallApplySearch(dyn, panel);
}
function hallShowError(dyn, panel) {
  dyn.setAttribute("aria-busy", "false");
  dyn.innerHTML = "";
  dyn.appendChild(hallToolbar(panel, ""));
  dyn.appendChild(hallEmpty("⚠️", HALL_DEMO ? "演示环境没有该数据" : "取数失败",
    HALL_DEMO ? "正式运行 npm start 后可用。" : "检查本地服务后重试。",
    "重新加载", () => renderHall(true)));
}
/* 主页徽标：不用点进去就知道有没有事；失败静默（就当没这功能）。
   顺手预热 brief 缓存，进面板时几乎瞬间装配 */
function hallBadges(dyn) {
  if (HALL_DEMO) return;
  briefOf().then((b) => {
    if (hallPanel !== "" || !document.body.classList.contains("hall-open")) return;
    const put = (id, text) => {
      if (!text) return;
      const card = dyn.querySelector('[data-panel="' + id + '"]');
      if (card && !card.querySelector(".hall-badge")) {
        const badge = el2("hall-badge", text);
        if (text.trim().startsWith("⚠")) badge.classList.add("warn");
        /* 放标题行右端、箭头左边：状态和入口同一行，扫一眼就知道哪个面板有事 */
        const go = card.querySelector(".hall-go");
        if (go && go.parentNode) go.parentNode.insertBefore(badge, go);
        else card.appendChild(badge);
      }
    };
    const sched = b.schedule || {};
    if (sched.available) {
      const courses = sched.courses || [];
      put("today", courses.length ? "今日 " + courses.length + " 节"
        : (b.next ? "下节" + b.next.dateLabel : "今日无课"));
    }
    const days = (b.week && b.week.days) || [];
    let weekN = 0;
    days.forEach((d) => { weekN += ((d && d.courses) || []).length; });
    put("schedule", weekN ? "本周 " + weekN + " 节" : "");
    const ex = (b.exams && b.exams.upcoming) || [];
    put("exams", ex.length ? ex.length + " 场临近" : "");
    const td = (b.todos && b.todos.items) || [];
    const overdueN = td.filter((t) => t.overdue).length;
    put("todos", overdueN ? "⚠ " + overdueN + " 逾期" : (td.length ? td.length + " 条待办" : ""));
    put("knowledge", b.knowledge && b.knowledge.total ? "共 " + b.knowledge.total + " 条" : "");
  }).catch(() => {});
  /* 设置卡徽标：缺关键凭证才亮（与自动推出设置的口径一致：教务 > 模型；QQ 选配不打扰）。
     缺配置是要行动的事，与逾期同档用朱砂实底跳出 */
  fetch("/api/settings").then((r) => r.json()).then((d) => {
    if (hallPanel !== "" || !document.body.classList.contains("hall-open")) return;
    const card = dyn.querySelector('[data-panel="settings"]');
    if (!card || card.querySelector(".hall-badge")) return;
    const miss = !d.jwgl || !d.jwgl.configured ? "教务未配"
      : !d.deepseek || !d.deepseek.configured ? "模型未配" : "";
    if (!miss) return;
    const badge = el2("hall-badge", miss);
    badge.classList.add("warn");
    const go = card.querySelector(".hall-go");
    if (go && go.parentNode) go.parentNode.insertBefore(badge, go);
    else card.appendChild(badge);
  }).catch(() => {});
}
function renderHall(force) {
  const dyn = document.getElementById("hallDyn");
  const staticSettings = document.getElementById("hallSettings");
  /* 滚动管理：刷新保持位置（clamp 防内容变短），切面板/回主页复位顶部 */
  const keepScroll = !!force;
  const lastTop = hallBody.scrollTop;
  const settle = () => {
    hallBody.scrollTop = keepScroll ? Math.min(lastTop, hallBody.scrollHeight) : 0;
  };
  if (force) hallBrief = null;
  /* 切面板时清空搜索与知识分类筛；刷新保留两者（勾选/删除/换分类后态不丢） */
  if (!force && hallSearch.panel !== hallPanel) hallSearch = { panel: hallPanel, q: "" };
  if (!force && hallPanel !== "knowledge") hallKnowCat = "";
  dyn.innerHTML = "";
  dyn.setAttribute("aria-busy", "false");
  hallBack.hidden = !hallPanel;
  const isSettings = hallPanel === "settings";
  staticSettings.hidden = !isSettings;
  if (isSettings) {
    /* 设置是常驻 DOM（字段/栏目不重建），进入时只做状态复位与取数 */
    hallTitle.textContent = "设置";
    showSettings();
    settle();
    return;
  }
  if (!hallPanel) {
    hallTitle.textContent = "功能大厅";
    /* 主页按分组排布：学习安排 / 效率工具 / 系统，扫一眼就能定位 */
    HALL_GROUPS.forEach((g) => {
      const cards = HALL_CARDS.filter((c) => c.group === g && !c.hidden);
      if (!cards.length) return;
      const sec = el("hall-sec");
      sec.appendChild(el2("", g));
      dyn.appendChild(sec);
      const grid = el("hall-grid");
      cards.forEach((c) => {
        const card = document.createElement("button");
        card.type = "button"; card.className = "hall-card"; card.dataset.panel = c.id;
        card.setAttribute("aria-label", c.t + "：" + c.d);
        const top = el("hall-card-top");
        top.appendChild(iconSpan("hall-ico", HALL_ICONS[c.id] || GEAR));
        const t = document.createElement("b"); t.textContent = c.t; top.appendChild(t);
        top.appendChild(el2("hall-go", "→"));
        card.appendChild(top);
        const s = document.createElement("span"); s.textContent = c.d; card.appendChild(s);
        grid.appendChild(card);
      });
      dyn.appendChild(grid);
    });
    dyn.appendChild(hallNote(HALL_DEMO
      ? "离线演示：面板里是虚构示例数据；正式运行后显示你的真实数据。"
      : "提示：点卡片进对应面板；在对话框里说「打开课表/考试/待办」也会为你推出。"));
    settle();
    hallBadges(dyn);
    return;
  }
  hallTitle.textContent = HALL_TITLES[hallPanel] || hallPanel;
  const build = HALL_PANELS[hallPanel];
  if (!build) { dyn.appendChild(hallNote("该功能暂无面板。")); settle(); return; }
  /* 先给骨架屏占位，避免取数时闪空；同步面板直接装配 */
  let body = null;
  try { body = build(); } catch { hallShowError(dyn, hallPanel); settle(); return; }
  if (body && typeof body.then === "function") {
    dyn.setAttribute("aria-busy", "true");
    dyn.appendChild(hallSkel());
    settle();
    const want = hallPanel;
    body.then((node) => {
      /* 取数期间用户可能已关掉或切走：只往还开着的同一面板里补画 */
      if (document.body.classList.contains("hall-open") && hallPanel === want && dyn) {
        hallMountPanel(dyn, want, node);
      }
    }).catch(() => {
      if (document.body.classList.contains("hall-open") && hallPanel === want) {
        hallShowError(dyn, want);
      }
    });
  } else {
    hallMountPanel(dyn, hallPanel, body);
    settle();
  }
}
function openHall(panel, opts) {
  if (panel) hallPanel = panel;
  /* 记住抽屉外的打开者：关闭时焦点归还；抽屉内卡片跳转不需要 */
  const active = document.activeElement;
  if (active && !document.getElementById("hall").contains(active)) {
    hallReturnFocus = active;
    if (!settingsReturnFocus) settingsReturnFocus = active;
  }
  document.body.classList.add("hall-open");
  /* 收起态宽度为 0：inert 挡住不可见内容的键盘焦点，打开时解除 */
  document.getElementById("hall").inert = false;
  hallSyncExpanded();
  renderHall();
  syncHallHash();
  /* push 进来时不抢焦点：对话联动自动打开的场合，用户可能正在打字 */
  if (!opts || opts.focus !== false) document.getElementById("closeHall").focus();
}

/* ── hash 深链：#hall=面板名。刷新还原、可收藏直达、浏览器后退关抽屉。
   hallHashSync 防本文件写 hash 触发 hashchange 的回环 ── */
let hallHashSync = false;
function hallPanelFromHash() {
  const m = /^#hall=([a-z]+)$/.exec(location.hash || "");
  const id = m && m[1];
  return id && (HALL_TITLES[id] || id === "settings") ? id : "";
}
function syncHallHash() {
  if (hallHashSync) return;
  hallHashSync = true;
  try {
    if (hallPanel) {
      if (location.hash !== "#hall=" + hallPanel) location.hash = "hall=" + hallPanel;
    } else if (location.hash) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  } finally { hallHashSync = false; }
}
window.addEventListener("hashchange", () => {
  if (hallHashSync) return;
  const id = hallPanelFromHash();
  const open = document.body.classList.contains("hall-open");
  if (!id) { if (open) closeHall(); return; }
  if (!open || hallPanel !== id) {
    hallPanel = id;
    document.body.classList.add("hall-open");
    document.getElementById("hall").inert = false;
    hallSyncExpanded();
    renderHall();
  }
});
/* 带 #hall=xx 打开页面：直接还原到对应面板（不抢焦点）。
   必须推迟到整个初始化脚本走完再执行——openHall 触达的
   settingsReturnFocus 等 let 声明在更后面，同步调用会踩 TDZ */
const hallInitial = hallPanelFromHash();
if (hallInitial) {
  setTimeout(() => {
    try { openHall(hallInitial, { focus: false }); }
    catch (e) { window.__hallInitErr = String((e && e.stack) || e); }
  }, 0);
}
function closeHall() {
  if (!document.body.classList.contains("hall-open")) return;
  /* 设置面板里有未保存的凭证：第一次关先拦下（✕/遮罩/Esc/后退统一走这里），
     武装「关闭」按钮为二次确认；3 秒内再关才放行——防手滑丢掉刚填的密码/Key */
  if (hallPanel === "settings" && settingsDirty()) {
    if (!settingsCloseArmed) {
      armSettingsClose();
      setMsg.className = "setmsg";
      setMsg.textContent = "有未保存的修改：再关闭一次将丢弃，或先点「保存设置」。";
      /* 浏览器后退被拦下时把 #hall=settings 写回去，hash 与界面保持一致 */
      syncHallHash();
      return;
    }
    disarmSettingsClose();
    /* 常用问题的编辑随二次确认一并丢弃：下次打开回到已保存基线，
       不因残留编辑一直卡在「未保存修改」的拦截里 */
    quickDraft = quickSaved.slice();
    renderQuickList();
  }
  document.body.classList.remove("hall-open");
  document.getElementById("hall").inert = true;
  hallSyncExpanded();
  /* 对话进行中手动关掉：这一轮不再因工具调用自动弹出 */
  if (busy) hallAutoMuted = true;
  /* 焦点归还：优先还给抽屉外的打开者（键盘用户不丢位置） */
  const target = hallReturnFocus || settingsReturnFocus;
  hallReturnFocus = null;
  settingsReturnFocus = null;
  if (target && typeof target.focus === "function" && document.contains(target)) {
    target.focus();
  }
}
/* 返回主页时焦点给来源卡片：只记手动点卡进入的，对话自动弹出的不记 */
let hallFromCard = "";
document.getElementById("openHall").addEventListener("click", () => { hallPanel = ""; hallFromCard = ""; openHall(); });
document.getElementById("openHallM").addEventListener("click", () => { hallPanel = ""; hallFromCard = ""; openHall(); });
document.getElementById("closeHall").addEventListener("click", closeHall);
document.getElementById("hallBackdrop").addEventListener("click", closeHall);
hallBack.addEventListener("click", () => {
  const from = hallFromCard;
  hallPanel = "";
  hallFromCard = "";
  renderHall();
  syncHallHash();
  const card = from && hallBody.querySelector('[data-panel="' + from + '"]');
  (card || document.getElementById("closeHall")).focus();
});
hallBody.addEventListener("click", (e) => {
  const card = e.target.closest("[data-panel]");
  if (card) { hallFromCard = card.dataset.panel; hallPanel = card.dataset.panel; renderHall(); syncHallHash(); hallBack.focus(); }
});
/* 目录行内方向键移动焦点：单列列表上下移动，左右留给原生滚动 */
hallBody.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const cards = [...hallBody.querySelectorAll(".hall-card")];
  if (cards.length < 2 || !cards.includes(document.activeElement)) return;
  e.preventDefault();
  const i = cards.indexOf(document.activeElement);
  const next = e.key === "ArrowDown" ? (i + 1) % cards.length : (i - 1 + cards.length) % cards.length;
  cards[next].focus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeHall();
});

/* ── 大厅角标：今天有到期的待办，或 30 分钟内有课，侧栏/顶栏按钮亮小红点。
   演示环境没有 /api/today，不打扰；每 5 分钟与每轮对话结束后各刷一次 ── */
function refreshHallBadge() {
  if (HALL_DEMO) return;
  fetch("/api/today").then((r) => r.json()).then((b) => {
    const urgent = ((b.todos && b.todos.items) || []).filter((t) => t.overdue || t.isToday).length;
    const soonClass = !!(b.next && b.next.dateLabel === "今天" && b.next.startsInMin <= 30);
    const show = urgent > 0 || soonClass;
    const why = [];
    if (soonClass) why.push("30 分钟内有课");
    if (urgent) why.push(urgent + " 条待办今天到期");
    for (const id of ["openHall", "openHallM"]) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      let dot = btn.querySelector(".hall-dot");
      if (show && !dot) {
        dot = document.createElement("i");
        dot.className = "hall-dot";
        btn.appendChild(dot);
      }
      if (!show && dot) dot.remove();
      btn.title = show ? "功能大厅（" + why.join("，") + "）" : "今日日程、课表、考试、待办、知识库、番茄钟";
    }
  }).catch(() => {});
}
refreshHallBadge();
setInterval(refreshHallBadge, 5 * 60 * 1000);

/* 工具名 → 功能大厅面板：仅做「开着就刷新、没开就作废缓存」的刷新映射。
   自动推出只允许显式意图（open_settings）与服务端点名的阻塞场景（ev.panel），
   数据查询工具绝不自动推——用户点开才看。 */
const TOOL_PANEL = {
  get_schedule: "schedule",
  export_calendar: "schedule",
  get_exams: "exams",
  manage_todos: "todos",
  manage_knowledge: "knowledge",
  manage_pomodoro: "pomodoro",
  get_grades: "grades",
  get_news: "news",
  read_notice: "news",
  /* agent 自己请求打开设置（用户说「打开设置/我要配账号」） */
  open_settings: "settings",
};


async function doNewSession() {
  if (busy) return;
  /* 当前会话还没说过话：不重复建档，光标归位即可 */
  if (!msgs.length) { input.focus(); closeDrawer(); return; }
  startFresh();
  closeDrawer();
}
document.getElementById("newSession").addEventListener("click", doNewSession);
document.getElementById("newSessionM").addEventListener("click", doNewSession);

/* ── 设置：常驻在功能大厅抽屉里（见 #hallSettings），教务账号 / DeepSeek API Key
   等凭证仍走后端 /api/settings 同一套加密热生效 ── */
const sUser = document.getElementById("sUser");
const sPass = document.getElementById("sPass");
const sKey = document.getElementById("sKey");
const sModel = document.getElementById("sModel");
const sQQAppId = document.getElementById("sQQAppId");
const sQQSecret = document.getElementById("sQQSecret");
const sQQPass = document.getElementById("sQQPass");
const curModel = document.getElementById("curModel");
const setMsg = document.getElementById("setMsg");
let setStatus = null;
/* 设置弹窗关闭后焦点回到触发按钮（键盘用户不丢位置） */
let settingsReturnFocus = null;

/* ── 常用问题栏目：编辑的是副本 quickDraft，点「保存设置」才随 /api/settings
   落库；quickSaved 是最近一次服务端返回的基线，dirty 判断与丢弃复位都靠它 ── */
const quickList = document.getElementById("quickList");
const quickNewInput = document.getElementById("quickNewInput");
let quickSaved = DEFAULT_QUESTIONS.slice();
let quickDraft = quickSaved.slice();
function quickChanged() {
  return JSON.stringify(quickDraft) !== JSON.stringify(quickSaved);
}
function renderQuickList() {
  quickList.innerHTML = "";
  if (!quickDraft.length) {
    const empty = el("qq-empty");
    empty.textContent = "清单为空：保存后输入框上方将恢复默认快捷问题";
    quickList.appendChild(empty);
    return;
  }
  quickDraft.forEach((q) => {
    const item = el("qq-item");
    const span = document.createElement("span");
    span.textContent = q;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "✕";
    del.title = "删除该问题";
    del.setAttribute("aria-label", "删除：" + q);
    del.addEventListener("click", () => {
      quickDraft = quickDraft.filter((x) => x !== q);
      renderQuickList();
    });
    item.appendChild(span);
    item.appendChild(del);
    quickList.appendChild(item);
  });
}
function quickAddFromInput() {
  const q = quickNewInput.value.trim().slice(0, 60);
  quickNewInput.value = "";
  if (!q || quickDraft.includes(q) || quickDraft.length >= 12) return;
  quickDraft.push(q);
  renderQuickList();
  quickNewInput.focus();
}
document.getElementById("quickAdd").addEventListener("click", quickAddFromInput);
quickNewInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); quickAddFromInput(); }
});
document.getElementById("resetQuick").addEventListener("click", () => {
  quickDraft = DEFAULT_QUESTIONS.slice();
  renderQuickList();
});
/* 服务端清单到位（启动拉取 / 打开设置 / 保存成功）的统一落点：
   基线与编辑副本同步，主界面 chips 一并刷新 */
function applyQuickQuestions(list) {
  quickSaved = Array.isArray(list) && list.length ? list.slice() : DEFAULT_QUESTIONS.slice();
  quickDraft = quickSaved.slice();
  renderQuickList();
  quickQuestions = quickSaved.slice();
  renderQchips();
}
renderQuickList();

/* ── 未保存修改保护：凭证类字段填了内容（未保存）就是 dirty。
    closeHall 拦一次 + 「关闭」按钮武装二次确认，与清理按钮的两步删除同一语言 ── */
let settingsCloseArmed = false;
let settingsCloseTimer = 0;
function settingsDirty() {
  if (document.body.dataset.demo === "true") return false;
  return !!(sUser.value.trim() || sPass.value || sKey.value.trim() || sModel.value ||
    sQQAppId.value.trim() || sQQSecret.value || sQQPass.value.trim()) || quickChanged();
}
function armSettingsClose() {
  settingsCloseArmed = true;
  const cancel = document.getElementById("cancelSettings");
  if (cancel) {
    cancel.classList.add("armed");
    cancel.textContent = "确认关闭？";
  }
  window.clearTimeout(settingsCloseTimer);
  settingsCloseTimer = window.setTimeout(disarmSettingsClose, 3000);
}
function disarmSettingsClose() {
  settingsCloseArmed = false;
  window.clearTimeout(settingsCloseTimer);
  const cancel = document.getElementById("cancelSettings");
  if (cancel) {
    cancel.classList.remove("armed");
    cancel.textContent = "关闭";
  }
}

/* ── 密码可见性：教务密码 / API Key / AppSecret 右侧「显示/隐藏」。
    只切 input.type，值不额外落任何地方；点按钮时拦下 label 的默认聚焦转发 ── */
for (const eye of document.querySelectorAll(".fld-eye")) {
  const input = eye.parentElement ? eye.parentElement.querySelector("input") : null;
  if (!input) continue;
  eye.addEventListener("click", (e) => {
    if (eye.disabled || input.disabled) return;
    e.preventDefault();
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    eye.textContent = show ? "隐藏" : "显示";
    eye.setAttribute("aria-pressed", show ? "true" : "false");
    eye.title = show ? "隐藏已输入的内容" : "明文显示已输入的内容";
  });
}



function refreshData() {
  return fetch("/api/data").then((r) => r.json()).then((d) => {
    const cells = [
      ["会话", d.sessions.count + " 个 · " + d.sessions.messages + " 条"],
      ["已读附件", d.attachments.count + " 个 · " + fmtSize(d.attachments.bytes)],
      ["网页上传", d.uploads.count + " 个 · " + fmtSize(d.uploads.bytes)],
      ["生成文件", d.generated.count + " 个 · " + fmtSize(d.generated.bytes)],
      ["未完成待办", d.reminders.open + " 条"],
    ];
    const host = document.getElementById("dataGrid"); host.innerHTML = "";
    cells.forEach(([label, value]) => {
      const cell = el("data-cell"); cell.appendChild(el2("", label));
      const strong = document.createElement("strong"); strong.textContent = value; cell.appendChild(strong);
      host.appendChild(cell);
    });
  }).catch(() => {
    /* 取数失败给一行看得见的提示，不静默留空 */
    const host = document.getElementById("dataGrid"); host.innerHTML = "";
    const cell = el("data-cell err");
    cell.textContent = "读取失败，检查本地服务后重进";
    host.appendChild(cell);
  });
}


function runDiagnostic(target, buttonId, stateId) {
  const button = document.getElementById(buttonId), state = document.getElementById(stateId);
  button.disabled = true; state.textContent = "检测中…";
  fetch("/api/diagnostics", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }),
  }).then((r) => r.json()).then((d) => {
    button.disabled = false; state.textContent = d.result ? d.result.message : (d.error || "检测失败");
  }).catch(() => { button.disabled = false; state.textContent = "检测失败，请确认本地服务正在运行。"; });
}
document.getElementById("testJwgl").addEventListener("click", () => runDiagnostic("jwgl", "testJwgl", "diagJwgl"));
document.getElementById("testDeepseek").addEventListener("click", () => runDiagnostic("deepseek", "testDeepseek", "diagDeepseek"));

/* ── 型号卡片：候选由后端给（该 Key 实际可用的型号），拉不到时是内置兜底清单。
   sModel 仍是值的唯一载体（hidden input），保存逻辑读 sModel.value 不变 ── */
function pickModel(id) {
  sModel.value = id || "";
  for (const card of document.querySelectorAll("#modelCards .model-card")) {
    const on = card.dataset.modelId === id;
    card.classList.toggle("picked", on);
    card.setAttribute("aria-checked", on ? "true" : "false");
  }
}
function fillModels(options, current, message) {
  const list = Array.isArray(options) ? options : [];
  const keep = sModel.value;
  const host = document.getElementById("modelCards");
  host.textContent = "";
  if (!list.length) {
    host.appendChild(el2("model-empty", message || "型号清单读取中…"));
  } else {
    for (const m of list) {
      if (!m || typeof m.id !== "string") continue;
      const card = el("model-card");
      card.dataset.modelId = m.id;
      card.setAttribute("role", "radio");
      card.tabIndex = 0;
      card.appendChild(el2("mc-name", m.label || m.id));
      if (m.id === current) card.appendChild(el2("mc-badge", "当前"));
      card.appendChild(el2("mc-id", m.id));
      if (m.note) card.appendChild(el2("mc-note", m.note));
      card.addEventListener("click", () => {
        if (document.body.dataset.demo === "true") return;
        /* 再点一次已选卡片＝取消更换，回到「不修改」 */
        pickModel(card.dataset.modelId === sModel.value ? "" : card.dataset.modelId);
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); card.click(); }
      });
      host.appendChild(card);
    }
  }
  pickModel(keep && list.some((m) => m && m.id === keep) ? keep : "");
  const picked = list.filter((m) => m && m.id === current)[0];
  let note = "当前：" + ((picked && picked.label) || current || "未设置");
  if (picked && picked.note) note += " · " + picked.note;
  if (message && list.length) note += " · " + message;
  curModel.textContent = note;
}
/* 方向键在卡片间移动焦点（承接原生下拉的键盘习惯）；空格/回车才做选择 */
document.getElementById("modelCards").addEventListener("keydown", (e) => {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const cards = [...document.querySelectorAll("#modelCards .model-card")];
  if (cards.length < 2) return;
  const step = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1;
  const next = cards[(cards.indexOf(document.activeElement) + step + cards.length) % cards.length];
  if (next) { e.preventDefault(); next.focus(); }
});

/* ── 设置栏目切换：点左列目录，右列换内容。「保存设置」只属于
   凭证类栏目（教务 / 模型 / QQ）；本地数据即改即存，不亮保存 ── */
const setTabs = [...document.querySelectorAll(".set-tab")];
let setLastTab = "account"; // 记住上次停留的栏目，进设置直达上次位置
function setTab(name) {
  if (!setTabs.some((t) => t.dataset.pane === name)) name = "account";
  setLastTab = name;
  for (const tab of setTabs) {
    const on = tab.dataset.pane === name;
    tab.classList.toggle("on", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  }
  for (const pane of document.querySelectorAll(".set-pane")) {
    pane.classList.toggle("on", pane.dataset.pane === name);
  }
  document.getElementById("saveSettings").hidden = !["account", "model", "qq", "quick"].includes(name);
}
for (const tab of setTabs) tab.addEventListener("click", () => setTab(tab.dataset.pane));
/* 方向键在栏目间移动焦点：大厅里目录是横排（左右）+ 窄屏也是横排，竖排同样支持上下 */
document.getElementById("setTabs").addEventListener("keydown", (e) => {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const i = setTabs.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const step = (e.key === "ArrowDown" || e.key === "ArrowRight") ? 1 : -1;
  setTabs[(i + step + setTabs.length) % setTabs.length].focus();
});
/* 状态总览：各栏配置一眼看完，点 chip 直达栏目（数据来自 showSettings 那次 /api/settings） */
function renderSetStatus(d) {
  const host = document.getElementById("setStatus");
  if (!host || !d) return;
  host.innerHTML = "";
  const quickCount = Array.isArray(d.quickQuestions) ? d.quickQuestions.length : 0;
  const chips = [
    { pane: "account", label: "教务", ok: !!(d.jwgl && d.jwgl.configured), warn: true },
    { pane: "model", label: "模型", ok: !!(d.deepseek && d.deepseek.configured), warn: true },
    { pane: "qq", label: "QQ", ok: !!(d.qq && d.qq.configured), warn: false },
    { pane: "quick", label: "常用", ok: true, warn: false, note: quickCount + " 条" },
    { pane: "data", label: "数据", ok: true, warn: false },
  ];
  chips.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "set-chip" + (c.ok ? " ok" : "") + (!c.ok && c.warn ? " warn" : "");
    b.dataset.pane = c.pane;
    const dot = document.createElement("i");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");
    b.appendChild(dot);
    const state = c.pane === "data" ? "本地"
      : c.pane === "quick" ? c.note
      : (c.ok ? "已配" : "未配");
    b.appendChild(document.createTextNode(c.label + " · " + state));
    const hint = c.pane === "data" ? "本地数据，点此查看与清理"
      : c.pane === "quick" ? "常用快捷问题，点此增删"
      : (c.ok ? "已配置，点此查看或修改" : "尚未配置，点此去填写");
    b.title = c.label + "：" + hint;
    b.setAttribute("aria-label", c.label + "栏目：" + state + "，点击直达");
    b.addEventListener("click", () => setTab(c.pane));
    host.appendChild(b);
  });
}

function qqStatusText(q) {
  return q && q.configured
    ? "已配置：AppID " + (q.appIdMasked || "已保存") + " · " + q.sourceLabel + (q.passcodeSet ? " · 暗号已设" : " · 未设暗号")
    : "未配置；到 q.qq.com 创建机器人后填入，保存后即可在 QQ 里使用";
}
function qqApplyStatus(q) {
  document.getElementById("curQQ").textContent = qqStatusText(q);
  sQQSecret.placeholder = q && q.configured ? "已保存；留空不修改" : "q.qq.com 机器人的 AppSecret";
  sQQPass.placeholder = q && q.passcodeSet ? "已设暗号；留空不修改" : "首次激活用的暗号（自定）";
}

function showSettings() {
  /* #21 的焦点归还：记下抽屉外的打开者（宫格卡片在抽屉里，归还无意义），
     关掉大厅时还给 */
  const hall = document.getElementById("hall");
  if (!hall.contains(document.activeElement)) settingsReturnFocus = document.activeElement;
  /* 表单里还有未保存的凭证：从「← 大厅」绕一圈回来的场合不清空、不复位，
     保住用户刚填的内容（关闭抽屉的丢弃路径由 closeHall 的两步确认把守） */
  if (settingsDirty()) {
    setTab(setLastTab);
    setMsg.className = "setmsg";
    setMsg.textContent = "表单里仍有未保存的修改，改完记得点「保存设置」。";
    return;
  }
  disarmSettingsClose();
  setTab(setLastTab);
  setMsg.className = "setmsg";
  setMsg.textContent = "";
  document.getElementById("setStatus").innerHTML = "";
  sPass.value = ""; sKey.value = ""; pickModel("");
  sQQAppId.value = ""; sQQSecret.value = ""; sQQPass.value = "";
  document.getElementById("diagJwgl").textContent = "";
  document.getElementById("diagDeepseek").textContent = "";
  refreshData();
  fetch("/api/settings").then((r) => r.json()).then((d) => {
    setStatus = d;
    renderSetStatus(d);
    sUser.value = "";
    sUser.placeholder = d.jwgl.username || "请输入教务系统学号";
    sPass.placeholder = d.jwgl.configured ? "已保存；留空不修改" : "请输入教务系统密码";
    document.getElementById("curJwgl").textContent = d.jwgl.configured
      ? "已保存：学号 " + d.jwgl.username + " · " + d.jwgl.sourceLabel
      : "尚未配置教务账号";
    document.getElementById("curKey").textContent = d.deepseek.configured
      ? "已保存：" + (d.deepseek.masked || "API Key") + " · " + d.deepseek.sourceLabel + " · " + d.model
      : "尚未配置 API Key · 当前模型 " + d.model;
    sKey.placeholder = "sk-…；留空不修改";
    qqApplyStatus(d.qq);
    fillModels(d.models, d.model, "");
    applyQuickQuestions(d.quickQuestions);
  }).catch(() => { setMsg.textContent = "无法读取设置，请确认本地服务正在运行。"; });
  // 清单以该 Key 实际可用的型号为准；服务端 10 分钟内走缓存，不重复联网
  fetch("/api/models").then((r) => r.json()).then((m) => {
    if (!m || !Array.isArray(m.options)) return;
    fillModels(m.options, m.current, m.source === "live" ? "" : m.message);
  }).catch(() => {});
}
/* 「取消」= 关掉大厅抽屉；设置面板是常驻 DOM，下次进入重新复位取数 */
document.getElementById("cancelSettings").addEventListener("click", closeHall);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (sessionActionsId) { sessionActionsId = ""; renderSessList(); return; }
  /* 大厅（含设置）是更上层的容器：窄屏下它是浮层+遮罩，Esc 应先关它 */
  if (document.body.classList.contains("hall-open")) { closeHall(); return; }
  closeDrawer();
});

/* 本地数据清理：两步确认（与待办/知识的两步删除同一语言），替代原生 confirm。
   第一击变身「确认清理/清空」，3 秒内再击才执行，超时还原；演示环境按钮本就 disabled */
function armClearData(btn, scopes, confirmLabel) {
  if (!btn || btn.disabled) return;
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.dataset.label = btn.textContent;
    btn.textContent = confirmLabel;
    btn.classList.add("armed");
    window.clearTimeout(btn.dataset.timer);
    btn.dataset.timer = String(window.setTimeout(() => {
      btn.dataset.armed = "";
      btn.textContent = btn.dataset.label || confirmLabel;
      btn.classList.remove("armed");
    }, 3000));
    return;
  }
  window.clearTimeout(Number(btn.dataset.timer));
  btn.dataset.armed = "";
  btn.classList.remove("armed");
  btn.disabled = true;
  btn.textContent = "清理中…";
  fetch("/api/data/clear", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopes }),
  }).then((r) => r.json()).then(() => {
    refreshData(); refreshSessions();
    if (scopes.includes("sessions")) startFresh();
  }).catch(() => {}).finally(() => {
    btn.disabled = document.body.dataset.demo === "true";
    btn.textContent = btn.dataset.label || confirmLabel;
  });
}
document.getElementById("clearFiles").addEventListener("click", (e) => armClearData(
  e.currentTarget, ["attachments", "uploads", "generated"], "确认清理文件？",
));
document.getElementById("clearAllData").addEventListener("click", (e) => armClearData(
  e.currentTarget, ["sessions", "attachments", "uploads", "generated", "reminders"], "确认清空全部？",
));
/* 危险按钮的作用范围收进 title（悬停可见），常态文案保持短 */
document.getElementById("clearFiles").title = "清理已读附件副本、网页上传和生成文件；聊天记录与待办保留";
document.getElementById("clearAllData").title = "清空全部本地会话、附件、生成文件和待办；不可恢复";
document.getElementById("saveSettings").addEventListener("click", () => {
  const body = {};
  const u = sUser.value.trim(), pw = sPass.value, k = sKey.value.trim();
  if (pw) {
    /* 只改密码时自动带上现有学号，免得来回填 */
    body.jwglPassword = pw;
    body.jwglUsername = u || (setStatus && setStatus.jwgl.username) || "";
  } else if (u) {
    setMsg.className = "setmsg";
    setMsg.textContent = "修改学号时，请同时填写新的登录密码。";
    return;
  }
  if (k) body.apiKey = k;
  const qa = sQQAppId.value.trim(), qs = sQQSecret.value, qp = sQQPass.value.trim();
  if (qa || qs) {
    if (!qa || !qs) {
      setMsg.className = "setmsg";
      setMsg.textContent = "QQ 的 AppID 与 AppSecret 需要一起填写（q.qq.com 机器人详情页可查）。";
      return;
    }
    body.qqAppId = qa; body.qqAppSecret = qs;
  }
  if (qp) body.qqPasscode = qp;
  if (quickChanged()) body.quickQuestions = quickDraft;
  if (sModel.value) body.model = sModel.value;
  if (!Object.keys(body).length) {
    setMsg.className = "setmsg";
    setMsg.textContent = "没有需要保存的修改；可以直接使用上方连接检测。";
    return;
  }
  const saveBtn = document.getElementById("saveSettings");
  saveBtn.disabled = true;
  saveBtn.textContent = "保存中…";
  fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json().then((d) => ({ ok: r.ok, d }))).then(({ ok, d }) => {
    saveBtn.disabled = false;
    /* 保存结果逐条展示：失败行保持朱砂、成功行随 good 变墨色，混在一起也分得清 */
    setMsg.className = "setmsg" + (ok ? " good" : "");
    setMsg.textContent = "";
    const lines = d.results || [];
    for (const x of lines) {
      const line = document.createElement("div");
      line.className = "setmsg-line" + (x.ok === false ? " bad" : "");
      line.textContent = x.message;
      setMsg.appendChild(line);
    }
    if (!lines.length) setMsg.textContent = ok ? "设置已保存。" : (d.error || "保存失败，请重试。");
    if (ok && d.status) {
      setStatus = d.status; sUser.value = ""; sPass.value = ""; sKey.value = "";
      renderSetStatus(d.status);
      sUser.placeholder = d.status.jwgl.username || "请输入教务系统学号";
      sPass.placeholder = d.status.jwgl.configured ? "已保存；留空不修改" : "请输入教务系统密码";
      document.getElementById("curJwgl").textContent = d.status.jwgl.configured
        ? "已保存：学号 " + d.status.jwgl.username + " · " + d.status.jwgl.sourceLabel
        : "尚未配置教务账号";
      document.getElementById("curKey").textContent = d.status.deepseek.configured
        ? "已保存：" + (d.status.deepseek.masked || "API Key") + " · " + d.status.deepseek.sourceLabel + " · " + d.status.model
        : "尚未配置 API Key · 当前模型 " + d.status.model;
      sQQAppId.value = ""; sQQSecret.value = ""; sQQPass.value = "";
      qqApplyStatus(d.status.qq);
      pickModel("");
      fillModels(d.status.models, d.status.model, "");
      applyQuickQuestions(d.status.quickQuestions);
      /* 凭证已落库：dirty 归零，「关闭」不必再二次确认；按钮短暂亮一下完成感 */
      disarmSettingsClose();
      saveBtn.textContent = "已保存 ✓";
      window.setTimeout(() => { saveBtn.textContent = "保存设置"; }, 1400);
    }
  }).catch(() => {
    saveBtn.disabled = false;
    saveBtn.textContent = "保存设置";
    setMsg.className = "setmsg";
    setMsg.textContent = "保存失败，请确认本地服务正在运行后重试。";
  });
});

/* ── 启动：拉会话列表，但默认进入新的空会话 ── */
refreshSessions().then(() => {
  startFresh();
});
/* 快捷问题以服务端保存的自定义清单为准（设置里自选过的话）；
   拉不到就保持默认，不挡页面启动 */
fetch("/api/settings").then((r) => r.json()).then((d) => {
  if (Array.isArray(d.quickQuestions) && d.quickQuestions.length) {
    quickQuestions = d.quickQuestions.slice();
    renderQchips();
  }
}).catch(() => {});
/* 有在走的番茄钟就先恢复倒计时卡片（查不到不报错、不挡启动） */
restorePomoCard();

/* QQ 那边的对话也写进同一份档案，光靠启动拉一次要重开页面才看得见。
   定时补一次列表：正在回复（busy）不打断，标签页在后台（hidden）不刷，
   正在改名或操作菜单开着时不刷——重绘会销毁输入中的改名框并关掉菜单 */
setInterval(() => {
  if (!busy && !document.hidden && !editingSessionId && !sessionActionsId) refreshSessions();
}, 20000);

/* ── 网页附件：先上传到本机受控目录，再随本轮只发送附件 id ── */
const uploadTray = document.getElementById("uploadTray");
const fileInput = document.getElementById("fileInput");
const cwrap = document.querySelector(".cwrap");
function renderUploads() {
  uploadTray.innerHTML = "";
  pendingUploads.forEach((upload) => {
    const chip = el("upchip" + (upload.status === "uploading" ? " loading" : ""));
    if (upload.status === "error") {
      /* 失败 chip 可点击重试：原名保留，错误原因收进 title */
      chip.appendChild(el2("", "失败，点击重试 · " + upload.name));
      chip.title = upload.error || "上传失败";
      chip.tabIndex = 0;
      chip.setAttribute("role", "button");
      chip.style.cursor = "pointer";
      const retry = () => { doUpload(upload); };
      chip.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        retry();
      });
      chip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); retry(); }
      });
    } else {
      chip.appendChild(el2("", (upload.status === "uploading" ? "上传中 · " : "附件 · ") + upload.name));
    }
    const remove = document.createElement("button");
    remove.type = "button"; remove.textContent = "✕"; remove.title = "移除附件";
    remove.addEventListener("click", () => {
      pendingUploads = pendingUploads.filter((x) => x.localId !== upload.localId);
      if (upload.id) fetch("/api/uploads/" + upload.id, { method: "DELETE" }).catch(() => {});
      renderUploads(); syncBtn();
    });
    chip.appendChild(remove); uploadTray.appendChild(chip);
  });
}
function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = reject; reader.readAsDataURL(file);
  });
}
async function uploadFile(file) {
  const item = { localId: uuid(), name: file.name, size: file.size, status: "uploading", file };
  pendingUploads.push(item); renderUploads(); syncBtn();
  await doUpload(item);
}
/* 上传执行体拆出来：失败 chip 点一下就能重试，不用删了重选 */
async function doUpload(item) {
  item.status = "uploading"; item.error = "";
  renderUploads(); syncBtn();
  try {
    const data = await fileAsBase64(item.file);
    const response = await fetch("/api/uploads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: item.file.name, type: item.file.type, data }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "上传失败");
    Object.assign(item, body.upload, { status: "ready" });
  } catch (error) {
    item.status = "error"; item.error = String(error.message || error);
  }
  renderUploads(); syncBtn();
}
function handleFiles(files) {
  [...files].slice(0, Math.max(0, 8 - pendingUploads.length)).forEach(uploadFile);
}
document.getElementById("attachBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { handleFiles(fileInput.files || []); fileInput.value = ""; });
/* Ctrl+V 粘贴文件：从文件管理器/别的应用复制后可直接贴进输入框，
   走同一套上传队列；纯文本粘贴保持原生行为不受影响 */
input.addEventListener("paste", (e) => {
  if (document.body.dataset.demo === "true") return;
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (files.length) {
    e.preventDefault();
    handleFiles(files);
  }
});
["dragenter", "dragover"].forEach((name) => cwrap.addEventListener(name, (e) => {
  e.preventDefault(); if (!document.body.dataset.demo.includes("true")) cwrap.classList.add("drag");
}));
["dragleave", "drop"].forEach((name) => cwrap.addEventListener(name, (e) => {
  e.preventDefault(); cwrap.classList.remove("drag");
  if (name === "drop" && e.dataTransfer) handleFiles(e.dataTransfer.files || []);
}));

async function send(text) {
  if (!text || busy) return;
  busy = true;
  lastPrompt = text;
  hero.style.display = "none";
  document.title = "● 回复中 · CourseRaptor";
  const t0 = Date.now();
  const sendingUploads = pendingUploads.filter((x) => x.status === "ready");
  const attachmentView = sendingUploads.map((x) => ({ id: x.id, name: x.name }));
  msgs.push({ role: "user", text, ts: t0, attachments: attachmentView });
  addUser(text, t0, attachmentView);
  const shell = addBotShell();
  shell.msg.classList.add("cursor");
  btn.classList.add("stop");
  btn.innerHTML = '停止<span class="kbd">⏎</span>';
  let raw = "";
  let thinkRaw = "";
  /* 新一轮对话：面板数据按本轮重取；手动关过的自动弹出重新允许 */
  hallBrief = null;
  hallAutoMuted = false;
  controller = new AbortController();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: text, sessionId: activeId,
        attachmentIds: sendingUploads.map((x) => x.id),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "HTTP " + res.status);
    }
    pendingUploads = pendingUploads.filter((x) => !sendingUploads.includes(x));
    renderUploads();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.t === "think") {
          /* 一段思考一张卡：段末标记或后续任何别的事件都把它定格折叠 */
          if (ev.phase === "end") thinkClose(shell);
          else { thinkRaw += ev.v || ""; thinkDelta(shell, ev.v || ""); }
        } else if (ev.t === "text") {
          thinkClose(shell);
          if (!raw) shell.tm.textContent = clock(Date.now());
          raw += ev.v;
          renderStreaming(shell.msg, raw);
        } else if (ev.t === "tool") {
          thinkClose(shell);
          if (ev.phase === "start") {
            toolCard(shell, ev);
            /* 只有用户明确说「打开设置」时 agent 才会调 open_settings，
               此时才自动推出；数据查询工具只在对话里回答，绝不自动推。
               这轮被手动关过就连设置也不再打扰 */
            const panel = TOOL_PANEL[ev.name];
            if (panel === "settings" && !hallAutoMuted) openHall(panel, { focus: false });
          } else {
            toolDone(shell, ev, ev.phase === "end");
            if (ev.files && ev.files.length) fileRows(shell.tl, ev.files);
            if (ev.pomodoro) pomoCard(shell.tl, ev.pomodoro);
            /* 对话里取消了番茄钟：立即对表收掉页面其他位置的倒计时卡 */
            if (ev.pomoSync) pomoSync();
            /* 工具改了数据（加待办、起番茄钟……）：面板开着就刷新，没开着就作废缓存。
               settings 是静态面板且工具失败也可能带它：只负责推出，不参与刷新 */
            const panel = TOOL_PANEL[ev.name];
            if (panel && panel !== "settings") {
              hallBrief = null;
              if (hallPanel === panel && document.body.classList.contains("hall-open")) renderHall();
            }
            /* 工具因凭证未配置失败等服务端点名要设置：自动推出（本轮手动关过则不打扰） */
            if (ev.panel && !hallAutoMuted) openHall(ev.panel, { focus: false });
          }
        } else if (ev.t === "err") {
          thinkClose(shell);
          lineBad(shell.tl, ev.v);
        } else if (ev.t === "end") {
          thinkClose(shell);
          if (ev.dur != null) shell.dur.textContent = "· " + (ev.dur / 1000).toFixed(1) + "s";
          /* 服务端可能把无名新会话建档成 default 档：认领回来的 id */
          if (ev.sid) { activeId = String(ev.sid); lsSet(ACTIVE_KEY, activeId); }
        }
      }
    }
    /* 完整跑完的一轮才写进本地镜像（和服务端落盘同一口径）。
       定格在流式已有的气泡上——再建一行会留下空行+重复回复 */
    if (raw.trim()) {
      const html = renderMd(raw);
      if (html != null) shell.msg.innerHTML = html;
      else shell.msg.textContent = raw;
      addCopyButton(shell.acts, raw);
      msgs.push({ role: "bot", text: raw, think: thinkRaw.trim() || undefined, ts: Date.now() });
    } else {
      shell.msg.textContent = "这轮没有输出，再问一次试试";
    }
  } catch (e) {
    shell.tm.textContent = clock(Date.now());
    if (e.name === "AbortError") {
      /* 用户中断：显示已生成的半截，但不进历史（同服务端口径） */
      if (raw.trim()) {
        const html = renderMd(raw);
        if (html != null) shell.msg.innerHTML = html;
        else shell.msg.textContent = raw;
        thinkClose(shell, "已中断");
        lineBad(shell.tl, "已中断", "⏸");
      } else {
        thinkClose(shell, "已中断");
        shell.msg.textContent = "已中断";
      }
    } else {
      lineBad(shell.tl, String(e.message || e));
      if (!raw.trim()) shell.msg.textContent = "这轮没有输出，再问一次试试";
      /* 失败给一键重试（中断不给：是用户主动停的） */
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "tbtn";
      retry.textContent = "重试本轮";
      retry.addEventListener("click", () => { if (!busy) send(lastPrompt); });
      shell.acts.appendChild(retry);
    }
  } finally {
    thinkClose(shell);
    shell.msg.classList.remove("cursor");
    busy = false; controller = null;
    btn.classList.remove("stop");
    btn.innerHTML = '发送<span class="kbd">⏎</span>';
    syncBtn();
    /* 标题可能挂着完成提醒；切走了就补一次亮灯。
       一直可见时把「回复中」复位（番茄钟到点写的标题不碰） */
    if (document.hidden) document.title = "● 回复完成 · CourseRaptor";
    else if (document.title.startsWith("● 回复中")) document.title = "CourseRaptor";
    refreshSessions();
    refreshHallBadge();
    input.focus();
  }
}

/* ── 输入区：textarea 自适应高度；Enter 发送、Shift+Enter 换行；
   进行中再按 = 中断（按钮同样）；空文时发送键落灰 ─────────── */
const form = document.getElementById("f");
function fit() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}
/* 空内容时发送键禁用；流式进行中永远可点（此时它是「停止」） */
function syncBtn() {
  const uploading = pendingUploads.some((x) => x.status === "uploading");
  const readyFile = pendingUploads.some((x) => x.status === "ready");
  btn.disabled = !busy && (uploading || (!input.value.trim() && !readyFile));
}
input.addEventListener("input", () => { fit(); syncBtn(); });
syncBtn();
input.addEventListener("keydown", (e) => {
  /* 中文输入法组词中的 Enter 是确认候选词，不是发送（keyCode 229 = 组词中） */
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) { controller?.abort(); return; }
  const text = input.value.trim() || (pendingUploads.some((x) => x.status === "ready") ? "请阅读并概括这些附件" : "");
  if (!text) return;
  input.value = "";
  fit();
  send(text);
});

/* 切回本页时复位标题（后台完成时的 ● 提示只留到看见为止） */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) document.title = "CourseRaptor";
});
input.focus();
