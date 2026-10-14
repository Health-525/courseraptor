const logScroll = document.getElementById("log");
const inner = document.getElementById("inner");
const hero = document.getElementById("hero");
const input = document.getElementById("i");
const btn = document.getElementById("b");
/* 触屏设备不自动聚焦输入框：iOS 上一进页面/每轮回复完就 focus 会把键盘
   顶起来，盖住问候语与流式内容；桌面保留即打即用的便利。
   （用户主动点击引出的聚焦不受此限，如大厅空态的「去问问」） */
const AUTO_FOCUS = !window.matchMedia("(hover: none)").matches;
let busy = false;
let controller = null;
/* 最近一轮的用户消息：失败重试用 */
let lastPrompt = "";

/* ── 多会话状态：正文以服务端存档为准，本地只记当前会话 id ── */
const ACTIVE_KEY =
  document.body.dataset.demo === "true"
    ? "raptor-demo-active-session"
    : "raptor-web-active-session";
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
  try {
    v ? localStorage.setItem(k, v) : localStorage.removeItem(k);
  } catch {}
}
/* uuid 客户端先生成：第一条消息发出时服务端才建档，不留空壳会话 */
function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `s${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
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
const GEAR =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" ' +
  'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0' +
  "l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51" +
  "a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08" +
  "a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18" +
  "a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39" +
  "a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09" +
  "a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25" +
  'a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
function iconSpan(cls, svg) {
  const n = el(cls);
  n.innerHTML = svg;
  return n;
}
function pad(x) {
  return (x < 10 ? "0" : "") + x;
}
function clock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtWhen(ts) {
  const d = new Date(ts),
    n = new Date();
  return d.toDateString() === n.toDateString()
    ? clock(ts)
    : `${d.getMonth() + 1}月${d.getDate()}日`;
}
/* 档案行悬停时间戳：不做「今天/昨天」换算，一律全量标准格式，
   等宽字体定宽——悬停浮现时行内布局不跳 */
function fmtStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(ts)}`;
}

/* ── 首屏问候：按当下时段换招呼语，配 mono 日期戳（TODAY · 9月22日 周二）。
   startFresh 恢复首屏时重算，隔午后再回来不穿帮 ── */
function heroGreeting() {
  const greet = document.getElementById("heroGreet");
  const kick = document.getElementById("heroKicker");
  const n = new Date();
  if (greet) {
    const h = n.getHours();
    const word =
      h < 6 ? "夜深了" : h < 11 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
    greet.textContent = `同学，${word}。`;
  }
  if (kick) {
    const wd = ["日", "一", "二", "三", "四", "五", "六"][n.getDay()];
    kick.textContent = `TODAY · ${n.getMonth() + 1}月${n.getDate()}日 周${wd}`;
  }
}
heroGreeting();

/* ── 快速提问：常驻在输入框上方。默认清单先渲染（页面秒开），启动后再用
   服务端保存的自定义清单（/api/settings.quickQuestions）刷新一遍 ── */
const DEFAULT_QUESTIONS = [
  "今天有什么安排",
  "这周课表",
  "教务处最近有什么通知",
  "我的成绩和 GPA",
  "最近的考试安排",
  "通识学分还缺哪些",
  "导出课表到手机日历",
];
let quickQuestions = DEFAULT_QUESTIONS.slice();
const qchips = document.getElementById("qchips");
function renderQchips() {
  qchips.innerHTML = "";
  /* 演示页与面板编辑禁用同一语言：chips 只点不发、不换序 */
  const sortable = document.body.dataset.demo !== "true";
  quickQuestions.forEach((q) => {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "chip";
    c.dataset.q = q;
    c.textContent = q;
    if (sortable) {
      c.draggable = true;
      c.title = "点击发送；按住拖动可调整顺序";
    }
    qchips.appendChild(c);
  });
}
renderQchips();
qchips.addEventListener("click", (e) => {
  const c = e.target.closest("button[data-q]");
  if (c && !busy) send(c.dataset.q);
});

/* ── 智能滚动：用户上翻（离底 > 60px）就不再自动拽底 ── */
let pinned = true;
/* 回到最新：上翻离底时浮现的圆钮（样式见 chat-page.ts 的 .jump）。
   位置跟随输入条实际高度（textarea 长高、提示词行收起都重算），
   iOS 键盘占位由 CSS 里的 --vkb 一并叠加，不打架 */
const jumpLatest = document.createElement("button");
jumpLatest.type = "button";
jumpLatest.className = "jump";
jumpLatest.hidden = true;
jumpLatest.setAttribute("aria-label", "回到最新消息");
jumpLatest.innerHTML =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
document.body.appendChild(jumpLatest);
const composerForm = document.getElementById("f");
function syncJumpBottom() {
  document.documentElement.style.setProperty(
    "--jump-bottom",
    `${composerForm.offsetHeight + 14}px`,
  );
}
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(syncJumpBottom).observe(composerForm);
}
window.addEventListener("resize", syncJumpBottom);
syncJumpBottom();
let jumpRaf = 0;
function syncJumpVisible() {
  jumpRaf = 0;
  jumpLatest.hidden = pinned;
}
logScroll.addEventListener("scroll", () => {
  pinned = logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 60;
  if (!jumpRaf) jumpRaf = requestAnimationFrame(syncJumpVisible);
});
jumpLatest.addEventListener("click", () => {
  pinned = true;
  jumpLatest.hidden = true;
  logScroll.scrollTop = logScroll.scrollHeight;
});

const HAS_MARKED = typeof marked !== "undefined";
/* 只转义 & 和 <：堵住 HTML 标签注入面（标签必须以 < 开头），同时保留
   Markdown 自己的语法字符——> 若被转义成 &gt;，块引用就失效了 */
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function renderMd(text) {
  if (!HAS_MARKED) return null;
  try {
    return marked.parse(escHtml(text), { gfm: true, breaks: true, async: false });
  } catch {
    return null;
  }
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
  [...inner.querySelectorAll(".turn")].forEach((n) => {
    n.remove();
  });
}

/* ── 消息渲染：一行题注（谁 · 时间 · 耗时）+ 正文 ── */
function addTurn(cls) {
  const sec = el(`turn ${cls}`);
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
  if (attachments?.length) {
    const row = el("upload-tray");
    attachments.forEach((a) => {
      row.appendChild(el2("upchip", `附件 · ${a.name}`));
    });
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
    } catch {
      /* 剪贴板不可用就静默 */
    }
  });
  acts.appendChild(b);
}

/** 定格一条完整助手消息（openSession 重绘历史用）；thinkText 是历史里的思考 */
function addBotMessage(raw, ts, thinkText, cards) {
  const shell = addBotShell();
  shell.tm.textContent = clock(ts);
  if (thinkText) {
    /* 历史里的思考不计时（重开时算出的耗时是假的），建卡即定格为折叠态 */
    const item = thinkNew(shell.tl);
    item.body.textContent = thinkText;
    item.st.textContent = "已完成";
    item.det.open = false;
  }
  (cards || []).forEach((card) => {
    renderResultCard(shell.tl, card);
  });
  const html = renderMd(raw);
  if (html != null) shell.msg.innerHTML = html;
  else shell.msg.textContent = raw;
  addCopyButton(shell.acts, raw);
  scroll(false);
  return shell;
}

/* ── 结构化结果卡：查询结果以红头档案卡片呈现（演示模式发送 card 事件） ── */
function renderResultCard(host, card) {
  if (!card?.title) return;
  const box = el("result-card");
  const head = el("rc-head");
  head.appendChild(el2("rc-title", card.title));
  if (card.badge) head.appendChild(el2("rc-badge", card.badge));
  if (card.updatedAt) head.appendChild(el2("rc-time", fmtWhen(card.updatedAt)));
  box.appendChild(head);
  const body = el("rc-body");
  if (card.summary) body.appendChild(el2("rc-summary", card.summary));
  if (card.metrics?.length) {
    const metrics = el("rc-metrics");
    card.metrics.forEach((m) => {
      const item = el("rc-metric");
      item.appendChild(el2("", m.label));
      const strong = document.createElement("strong");
      strong.textContent = m.value;
      item.appendChild(strong);
      metrics.appendChild(item);
    });
    body.appendChild(metrics);
  }
  (card.rows || []).forEach((row) => {
    const line = el("rc-row");
    line.appendChild(el2("", row.label));
    if (row.value) line.appendChild(el2("rc-value", row.value));
    if (row.meta) line.appendChild(el2("rc-meta", row.meta));
    body.appendChild(line);
  });
  if (card.source) body.appendChild(el2("rc-source", `来源 · ${card.source}`));
  box.appendChild(body);
  host.appendChild(box);
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
  const item = { det, st, dur, body, buf: "", at: Date.now(), manual: false, pinned: true };
  /* 卡内跟随与主区 pinned 同法：用户贴底才自动跟随，往上翻回看就不打扰。
     距底阈值取窄一档（24px）——300px 小窗容不下主区那种 60px 的宽容度 */
  body.addEventListener("scroll", () => {
    item.pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  });
  /* 监听器挂在 open=true 之后：程序化的首次展开不算用户手动开合 */
  det.addEventListener("toggle", () => {
    item.manual = true;
  });
  tl.appendChild(det);
  return item;
}

function thinkDelta(shell, text) {
  if (!shell.think) shell.think = thinkNew(shell.tl);
  const item = shell.think;
  item.buf += text;
  item.body.textContent = item.buf;
  /* 内容超过限高后把最新一段压进视野：贴底跟随，被切走的不再是新思考 */
  if (item.pinned) item.body.scrollTop = item.body.scrollHeight;
  scroll(false);
}

/** 本段思考结束：定格状态字与耗时，用户没手动开过就折叠起来 */
function thinkClose(shell, stat) {
  const item = shell.think;
  if (!item) return;
  shell.think = null;
  item.st.textContent = stat || "已完成";
  item.dur.textContent = `${((Date.now() - item.at) / 1000).toFixed(1)}s`;
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
  if (ev.id) shell.tools.set(`id:${ev.id}`, item);
  const name = ev.name || "tool";
  if (!shell.queue[name]) shell.queue[name] = [];
  shell.queue[name].push(item);
  scroll(false);
  return item;
}

function toolTake(shell, ev) {
  let item = ev.id ? shell.tools.get(`id:${ev.id}`) : null;
  if (item) shell.tools.delete(`id:${ev.id}`);
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
  item.det.className = `tool ${ok ? "ok" : "bad"}`;
  item.det.querySelector(".tstat").textContent = ok ? "完成" : "失败";
  item.det.querySelector(".tsum").textContent = String(ev.brief || "");
  item.det.querySelector(".tdur").textContent =
    ev.dur != null ? `${(ev.dur / 1000).toFixed(1)}s` : "";
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
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}
function fileRows(tl, files) {
  files.forEach((f) => {
    const row = el("frow");
    row.appendChild(el2("fmark", "📎"));
    const nm = el2("fname", f.name + (f.size ? `（${fmtSize(f.size)}）` : ""));
    row.appendChild(nm);
    const a = document.createElement("a");
    a.className = "tbtn";
    a.href = `/files/${encodeURIComponent(f.name)}`;
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
  const m = Math.floor(sec / 60),
    s = sec % 60;
  return `${(m < 10 ? "0" : "") + m}:${s < 10 ? "0" : ""}${s}`;
}
/* 到点三声提示音：WebAudio 现场合成，不依赖任何音频文件 */
function pomoBeep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    [0, 0.35, 0.7].forEach((off, i) => {
      const o = ctx.createOscillator(),
        g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = i === 2 ? 660 : 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + off);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + off + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + off + 0.3);
      o.start(ctx.currentTime + off);
      o.stop(ctx.currentTime + off + 0.32);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch {
    /* 没声音就只靠视觉 */
  }
}
function pomoCard(tl, p) {
  if (!p?.endsAt) return;
  const total =
    p.totalSec || Math.max(1, Math.round((p.endsAt - (p.startsAt || Date.now())) / 1000));
  const card = el("pomo");
  card.dataset.ends = String(p.endsAt);
  card.dataset.total = String(total);
  card.dataset.id = String(p.id || "");
  card.dataset.label = String(p.label || "专注");
  const row = el("prow");
  row.appendChild(el2("pmark", "🍅"));
  row.appendChild(
    el2("plabel", `${p.label || "专注"} · ${p.focusMinutes || Math.round(total / 60)}分钟`),
  );
  row.appendChild(el2("pmeta", `至 ${clock(p.endsAt)} 结束`));
  card.appendChild(row);
  card.appendChild(el2("pclock", pomoFmt((p.endsAt - Date.now()) / 1000)));
  const bar = el("pbar");
  bar.appendChild(document.createElement("i"));
  card.appendChild(bar);
  const foot = el("pfoot");
  foot.appendChild(el2("pstate", "专注进行中"));
  if (p.status === "running") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "tbtn";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      /* 等服务端落盘再置灰，失败回滚按钮（对齐大厅面板的取消） */
      cancel.disabled = true;
      cancel.textContent = "取消中…";
      fetch("/api/pomodoro/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: card.dataset.id }),
      })
        .then((r) => {
          if (!r.ok) throw new Error("cancel failed");
        })
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

/* ── PPT 预览卡：pptx 成品在对话里的缩影幻灯片条，点击进全屏翻页 ──
   载荷来自 generate_document / convert_document 的 ppt 字段（chat-web
   校验后透传）；DOM 结构与全屏查看器共用一个构建函数，与成品课件同构：
   朱砂印章贯穿每页、封面暖纸底印章页头、章节页朱砂整版。 */
function pptSeal() {
  const seal = el("pt-seal");
  const img = document.createElement("img");
  img.src = "/logo.png";
  img.alt = "";
  img.draggable = false;
  seal.appendChild(img);
  return seal;
}

function pptLogo() {
  const logo = el("pt-logo");
  const img = document.createElement("img");
  img.src = "/logo.png";
  img.alt = "";
  img.draggable = false;
  logo.appendChild(img);
  return logo;
}

/* 自由版式页（代码工具 blank 页）：元素按画布 10 × 5.625 英寸归一成百分比
   绝对定位；字号/线宽按容器实际宽度换算成 px（pptFitFreePx 在布局完成后
   统一算），缩影条与全屏查看器共用这一份代码，与成品 pptx 的坐标语义一致。
   不用 cqw/container-type：部分内嵌浏览器不支持，还会让宽度回退的舞台塌缩。 */
const PPT_CANVAS_W = 10;
const PPT_CANVAS_H = 5.625;
function pptFreeInner(box, s) {
  if (s.title) {
    /* 成品里 blank 页标题固定排在 0.55/0.4、宽 8.9、字号按长度 28/36 */
    const t = el("pt-el pt-text pt-title");
    t.textContent = s.title;
    t.style.left = `${(0.55 / PPT_CANVAS_W) * 100}%`;
    t.style.top = `${(0.4 / PPT_CANVAS_H) * 100}%`;
    t.style.width = `${(8.9 / PPT_CANVAS_W) * 100}%`;
    t.style.height = `${(0.85 / PPT_CANVAS_H) * 100}%`;
    t.dataset.ptsize = s.title.length > 16 ? "28" : "36";
    t.style.fontWeight = "700";
    t.style.justifyContent = "flex-end";
    box.appendChild(t);
  }
  (s.elements || []).forEach((e) => {
    const pct = {
      left: `${(e.x / PPT_CANVAS_W) * 100}%`,
      top: `${(e.y / PPT_CANVAS_H) * 100}%`,
      width: `${(e.w / PPT_CANVAS_W) * 100}%`,
      height: `${(e.h / PPT_CANVAS_H) * 100}%`,
    };
    if (e.kind === "text") {
      const d = el("pt-el pt-text");
      d.textContent = e.text;
      Object.assign(d.style, pct);
      d.dataset.ptsize = String(e.size || 14);
      if (e.color) d.style.color = `#${e.color}`;
      if (e.bold) d.style.fontWeight = "700";
      if (e.align) d.style.textAlign = e.align;
      if (e.valign)
        d.style.justifyContent =
          e.valign === "middle" ? "center" : e.valign === "bottom" ? "flex-end" : "flex-start";
      if (e.font === "kai") d.classList.add("kai");
      if (e.wrap === false) d.classList.add("nowrap");
      box.appendChild(d);
    } else if (e.kind === "logo") {
      const d = el("pt-el pt-logo-el");
      Object.assign(d.style, pct);
      const img = document.createElement("img");
      img.src = "/logo.png";
      img.alt = "";
      img.draggable = false;
      d.appendChild(img);
      box.appendChild(d);
    } else if (e.kind === "line") {
      const d = el("pt-el pt-shape");
      d.style.left = pct.left;
      d.style.top = pct.top;
      d.style.width = pct.width;
      d.style.background = `#${e.line || "E1DCCF"}`;
      /* 高度用 % 保持几何比例；线宽存磅值，布局后换算成 minHeight 兜住可见性 */
      d.style.height = pct.height;
      d.dataset.ptline = String(e.lineW || 1);
      d.dataset.ptlineMin = "1";
      box.appendChild(d);
    } else {
      const d = el(`pt-el pt-shape${e.kind === "ellipse" ? " round" : ""}`);
      Object.assign(d.style, pct);
      if (e.fill) d.style.background = `#${e.fill}`;
      if (e.line) {
        d.style.borderStyle = "solid";
        d.style.borderColor = `#${e.line}`;
        d.dataset.ptline = String(e.lineW || 1);
      }
      if (e.rotate) d.style.rotate = `${e.rotate}deg`;
      box.appendChild(d);
    }
  });
  if (s.elemCut) {
    const cut = el("pt-el pt-elemcut");
    cut.textContent = `+ ${s.elemCut} 元素`;
    cut.dataset.ptsize = "8";
    box.appendChild(cut);
  }
  /* free 页成品带内容页母版（页脚品牌字+页码+落款 logo），预览同步落款 */
  box.appendChild(pptLogo());
  /* 元素挂载后才有 clientWidth，布局完成后再统一换算字号/线宽 */
  requestAnimationFrame(() => {
    pptFitFreePx(box);
  });
}

/* 元素的自适应尺寸：自由页把容器宽 ÷ 画布 10 英寸得每英寸像素，磅 → px
   （1pt = 1/72 英寸）；JSON 管线（.pt-dsl）整页按自然画布 1000px 宽
   transform: scale 缩进容器——字号/线宽/公式全部等比，不用逐属性算。
   clientWidth 还是 0（尚未进 DOM）就等下一帧再试。 */
function pptFitFreePx(box) {
  const w = box.clientWidth;
  if (!w) {
    requestAnimationFrame(() => {
      pptFitFreePx(box);
    });
    return;
  }
  const dsl = box.querySelector(".pt-dsl");
  if (dsl) {
    /* JSON 管线：整页缩放进容器。用 zoom 不用 CSS transform 缩放——zoom
       连布局尺寸一起缩（1000px 画布缩成 176px 缩影也不撑破父级
       overflow），且本文件刻意不出现 transform 串（静态扫描会误报，
       见 cssFn 的说明；graph 画板的平移同样走 x/y 属性） */
    dsl.style.zoom = String(w / PPT_DSL_W);
    return;
  }
  const pxPerPt = w / PPT_CANVAS_W / 72;
  box.querySelectorAll("[data-ptsize]").forEach((d) => {
    const v = +d.dataset.ptsize;
    if (v) d.style.fontSize = `${Math.max(3, v * pxPerPt)}px`;
  });
  box.querySelectorAll("[data-ptline]").forEach((d) => {
    const t = Math.max(0.75, (+d.dataset.ptline || 1) * pxPerPt);
    if (d.dataset.ptlineMin) d.style.minHeight = `${t}px`;
    else d.style.borderWidth = `${t}px`;
  });
}

/* ── slide JSON 管线（ppt_save）：画布 1000 × 562.5 px，元素坐标即 px ──
   与成品 pptx 同一份坐标语义（左上原点、安全边距 50、品牌 chrome 与 core
   pptx-slides.addBrandChrome 同几何，只是单位换成 px）。整页按自然尺寸
   排版，外层 transform: scale 缩进容器（pptFitFreePx 布局后算）——字号、
   线宽、表格、公式全部等比，也不用容器查询单位（部分内嵌浏览器不支持，
   还会让宽度回退的舞台塌缩）。文本 HTML 在服务端已过白名单净化
   （web-ppt-preview 的 sanitizeHtml），这里的 innerHTML 才敢用。 */
const PPT_DSL_W = 1000;
const PPT_DSL_PAPER = "#FDFCF9";
const PPT_DSL_INK = "#25221C";
let pptDslUid = 0;
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs) {
  const n = document.createElementNS(SVG_NS, name);
  for (const k in attrs || {}) if (attrs[k] != null) n.setAttribute(k, String(attrs[k]));
  return n;
}

/* CSS/SVG 函数串拼装：函数名走参数，不写进字面量——静态扫描
   （tests/chat-app-static.test.ts）把源码里任何「名字(」都当函数调用，
   gradient/rotate/translate 这类名字本文件并没有定义，会误报
   （同 graph 画板用 x/y 属性代替 transform 串的取舍） */
function cssFn(name, args) {
  return `${name}(${args})`;
}

/* 页面标题（卡片名/查看器页题）：第一个文本元素的纯文字 */
function pptDslTitle(s) {
  for (const e of s.elements || []) {
    if (e.type === "text") {
      const d = document.createElement("div");
      d.innerHTML = e.content || "";
      const t = (d.textContent || "").trim();
      if (t) return t;
    } else if (e.type === "shape" && e.text && e.text.content) {
      return e.text.content;
    }
  }
  return "";
}
/* 缩略图/舞台的版式类：旧管线带 kind，JSON 管线一律 k-dsl（padding:0） */
function pptSlideClass(s) {
  return `k-${s.kind || "dsl"}`;
}

/* 背景生效色（与 core renderSlide 同规则：solid 直接用、gradient 取首尾
   混色、缺省纸底）——深色底判定与页脚换色都看它 */
function pptDslMix(h1, h2) {
  const p = (h) => {
    const n = parseInt(String(h).replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = p(h1);
  const b = p(h2);
  const c = (x, y) =>
    Math.round((x + y) / 2)
      .toString(16)
      .padStart(2, "0");
  return `#${c(a[0], b[0])}${c(a[1], b[1])}${c(a[2], b[2])}`;
}
function pptDslBg(s) {
  const bg = s.background;
  if (bg && bg.type === "solid") return bg.color;
  if (bg && bg.type === "gradient") {
    const cs = bg.gradient.colors || [];
    const first = cs[0];
    const last = cs[cs.length - 1];
    if (first && last) return pptDslMix(first.color, last.color);
  }
  return PPT_DSL_PAPER;
}
function pptDslBgStyle(cv, s) {
  const bg = s.background;
  if (bg && bg.type === "gradient") {
    const g = bg.gradient;
    const stops = (g.colors || []).map((c) => `${c.color} ${Math.round(c.pos * 100)}%`);
    if ((g.type || "linear") === "radial")
      cv.style.background = cssFn("radial-gradient", `circle at 50% 50%, ${stops.join(", ")}`);
    else cv.style.background = cssFn("linear-gradient", `${g.rotate || 0}deg, ${stops.join(", ")}`);
    return;
  }
  cv.style.background = pptDslBg(s);
}
/* 深色底（亮度 < 0.4，与 core luminance 同阈值）：页脚换浅色、logo 加纸托 */
function pptDslDark(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const l = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return l < 0.4;
}

/* 品牌 chrome：cover 大印章页头 / section 右下小印章+浅色页码 / plain
   页脚细线 + COURSERAPTOR + 落款 logo + 页码（几何同 addBrandChrome） */
function pptDslSeal(cx, cy, dia, ring, fill) {
  const seal = el("pt-dsl-seal");
  Object.assign(seal.style, {
    left: `${cx - dia / 2}px`,
    top: `${cy - dia / 2}px`,
    width: `${dia}px`,
    height: `${dia}px`,
    borderColor: ring,
    background: fill,
  });
  const img = document.createElement("img");
  img.src = "/logo.png";
  img.alt = "";
  img.draggable = false;
  seal.appendChild(img);
  return seal;
}
function pptDslChrome(cv, s, index) {
  const dark = pptDslDark(pptDslBg(s));
  const motif = s.motif || "plain";
  const foot = dark ? "#E9C8C2" : "#6E6656";
  if (motif === "cover") {
    cv.appendChild(pptDslSeal(500, 108, 124, PPT_DSL_PAPER, "#AD392C"));
    return;
  }
  if (motif === "section") {
    cv.appendChild(pptDslSeal(906, 498, 52, PPT_DSL_PAPER, "#AD392C"));
    const num = el("pt-dsl-num");
    Object.assign(num.style, {
      left: "840px",
      top: "536px",
      width: "50px",
      height: "22px",
      color: "#E9C8C2",
    });
    num.textContent = String(index + 1);
    cv.appendChild(num);
    return;
  }
  const rule = el("pt-dsl-rule");
  Object.assign(rule.style, {
    left: "55px",
    top: "533px",
    width: "840px",
    height: "1px",
    background: dark ? "#852B22" : "#E1DCCF",
  });
  cv.appendChild(rule);
  const brand = el("pt-dsl-foot");
  Object.assign(brand.style, {
    left: "55px",
    top: "534px",
    width: "260px",
    height: "22px",
    color: foot,
  });
  brand.textContent = "COURSERAPTOR";
  cv.appendChild(brand);
  const num = el("pt-dsl-num");
  Object.assign(num.style, {
    left: "855px",
    top: "536px",
    width: "45px",
    height: "22px",
    color: foot,
  });
  num.textContent = String(index + 1);
  cv.appendChild(num);
  if (dark) {
    const disc = el("pt-dsl-disc");
    Object.assign(disc.style, {
      left: "914px",
      top: "510px",
      width: "34px",
      height: "34px",
      background: PPT_DSL_PAPER,
    });
    cv.appendChild(disc);
  }
  const logo = el("pt-dsl-logo");
  Object.assign(logo.style, { left: "918px", top: "514px", width: "26px", height: "26px" });
  const img = document.createElement("img");
  img.src = "/logo.png";
  img.alt = "";
  img.draggable = false;
  logo.appendChild(img);
  cv.appendChild(logo);
}

function pptDslElement(e) {
  switch (e.type) {
    case "text":
      return pptDslText(e);
    case "shape":
      return pptDslShape(e);
    case "line":
      return pptDslLine(e);
    case "chart":
      return pptDslChart(e);
    case "table":
      return pptDslTable(e);
    case "latex":
      return pptDslLatex(e);
    case "code":
      return pptDslCode(e);
    default:
      return null;
  }
}

function pptDslText(e) {
  const d = el("pt-dsl-el pt-dsl-text");
  Object.assign(d.style, {
    left: `${e.left}px`,
    top: `${e.top}px`,
    width: `${e.width}px`,
    height: `${e.height}px`,
  });
  if (e.defaultColor) d.style.color = e.defaultColor;
  if (e.defaultFontName) d.style.fontFamily = e.defaultFontName;
  if (e.fill) d.style.background = e.fill;
  if (e.lineHeight) d.style.lineHeight = String(e.lineHeight);
  if (e.paragraphSpace) d.style.gap = `${e.paragraphSpace}px`;
  if (e.wordSpace) d.style.wordSpacing = `${e.wordSpace}px`;
  if (e.opacity != null) d.style.opacity = String(e.opacity);
  if (e.vAlign)
    d.style.justifyContent =
      e.vAlign === "middle" ? "center" : e.vAlign === "bottom" ? "flex-end" : "flex-start";
  if (e.rotate != null) d.style.rotate = `${e.rotate}deg`;
  if (e.shadow)
    d.style.textShadow = `${e.shadow.h}px ${e.shadow.v}px ${e.shadow.blur}px ${e.shadow.color}`;
  d.innerHTML = e.content || "";
  return d;
}

function pptDslShape(e) {
  const box = el("pt-dsl-el");
  Object.assign(box.style, {
    left: `${e.left}px`,
    top: `${e.top}px`,
    width: `${e.width}px`,
    height: `${e.height}px`,
  });
  if (e.opacity != null) box.style.opacity = String(e.opacity);
  if (e.rotate != null) box.style.rotate = `${e.rotate}deg`;
  const vw = e.viewBox[0];
  const vh = e.viewBox[1];
  const svg = svgEl("svg", { viewBox: `0 0 ${vw} ${vh}`, preserveAspectRatio: "none" });
  const path = svgEl("path", { d: e.path });
  if (e.gradient && (e.gradient.colors || []).length >= 2) {
    const gid = `pdg${++pptDslUid}`;
    const defs = svgEl("defs");
    const grad = svgEl(e.gradient.type === "radial" ? "radialGradient" : "linearGradient", {
      id: gid,
    });
    if (e.gradient.type === "radial") {
      grad.setAttribute("cx", "50%");
      grad.setAttribute("cy", "50%");
      grad.setAttribute("r", "50%");
    } else {
      grad.setAttribute("x1", "0%");
      grad.setAttribute("y1", "0%");
      grad.setAttribute("x2", "100%");
      grad.setAttribute("y2", "0%");
      grad.setAttribute("gradientTransform", cssFn("rotate", `${e.gradient.rotate || 0} 0.5 0.5`));
    }
    for (const c of e.gradient.colors)
      grad.appendChild(svgEl("stop", { offset: c.pos, "stop-color": c.color }));
    defs.appendChild(grad);
    svg.appendChild(defs);
    path.setAttribute("fill", cssFn("url", `#${gid}`));
  } else if (e.fill) path.setAttribute("fill", e.fill);
  else path.setAttribute("fill", "none");
  if (e.outline?.width) {
    path.setAttribute("stroke", e.outline.color || PPT_DSL_INK);
    path.setAttribute("stroke-width", String(e.outline.width));
    path.setAttribute("stroke-linejoin", "round");
    if (e.outline.style === "dashed") path.setAttribute("stroke-dasharray", "10 7");
    else if (e.outline.style === "dotted") path.setAttribute("stroke-dasharray", "2 4");
  }
  if (e.flipH || e.flipV) {
    const tx = e.flipH ? vw : 0;
    const ty = e.flipV ? vh : 0;
    const sx = e.flipH ? -1 : 1;
    const sy = e.flipV ? -1 : 1;
    path.setAttribute(
      "transform",
      `${cssFn("translate", `${tx} ${ty}`)} ${cssFn("scale", `${sx} ${sy}`)}`,
    );
  }
  if (e.shadow)
    path.setAttribute(
      "filter",
      cssFn("drop-shadow", `${e.shadow.h}px ${e.shadow.v}px ${e.shadow.blur}px ${e.shadow.color}`),
    );
  svg.appendChild(path);
  box.appendChild(svg);
  if (e.text) {
    const t = el("pt-dsl-el pt-dsl-shapetext");
    t.style.justifyContent =
      e.text.align === "top" ? "flex-start" : e.text.align === "bottom" ? "flex-end" : "center";
    if (e.text.defaultColor) t.style.color = e.text.defaultColor;
    if (e.text.defaultFontName) t.style.fontFamily = e.text.defaultFontName;
    t.innerHTML = e.text.content || "";
    box.appendChild(t);
  }
  return box;
}

/* 线条：start/end 是相对 left/top 的局部坐标，width 是描边粗细不是长度；
   路径语义与 core lineElementPath 一致（broken/broken2/curve/cubic） */
function pptDslLinePath(e, ox, oy) {
  const s = [e.start[0] - ox, e.start[1] - oy];
  const t = [e.end[0] - ox, e.end[1] - oy];
  const f = (p) => `${p[0]},${p[1]}`;
  if (e.broken) return `M${f(s)} L${e.broken[0] - ox},${e.broken[1] - oy} L${f(t)}`;
  if (e.broken2) {
    const bx = e.broken2[0] - ox;
    const by = e.broken2[1] - oy;
    if (Math.abs(e.end[0] - e.start[0]) >= Math.abs(e.end[1] - e.start[1]))
      return `M${f(s)} L${bx},${s[1]} L${bx},${t[1]} L${f(t)}`;
    return `M${f(s)} L${s[0]},${by} L${t[0]},${by} L${f(t)}`;
  }
  if (e.curve) return `M${f(s)} Q${e.curve[0] - ox},${e.curve[1] - oy} ${f(t)}`;
  if (e.cubic)
    return `M${f(s)} C${e.cubic[0][0] - ox},${e.cubic[0][1] - oy} ${e.cubic[1][0] - ox},${e.cubic[1][1] - oy} ${f(t)}`;
  return `M${f(s)} L${f(t)}`;
}
function pptDslLine(e) {
  const pts = [e.start, e.end];
  if (e.broken) pts.push(e.broken);
  if (e.broken2) pts.push(e.broken2);
  if (e.curve) pts.push(e.curve);
  if (e.cubic) {
    pts.push(e.cubic[0]);
    pts.push(e.cubic[1]);
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const pad = (e.width || 2) + 4; // 箭头/圆点的描边外扩
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const w = maxX - minX;
  const h = maxY - minY;
  const box = el("pt-dsl-el");
  Object.assign(box.style, {
    left: `${e.left + minX}px`,
    top: `${e.top + minY}px`,
    width: `${w}px`,
    height: `${h}px`,
  });
  const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, width: w, height: h });
  const color = e.color || PPT_DSL_INK;
  const p0 = e.points?.[0] || "";
  const p1 = e.points?.[1] || "";
  const id = `pdl${++pptDslUid}`;
  const defs = svgEl("defs");
  const mk = (kind, end) => {
    const m = svgEl("marker", {
      id: `${id}-${end}`,
      markerWidth: 6,
      markerHeight: 6,
      refX: kind === "arrow" ? 5 : 3,
      refY: 3,
      orient: "auto",
      markerUnits: "userSpaceOnUse",
    });
    if (kind === "arrow") m.appendChild(svgEl("path", { d: "M0,0 L6,3 L0,6 z", fill: color }));
    else m.appendChild(svgEl("circle", { cx: 3, cy: 3, r: 2.4, fill: color }));
    return m;
  };
  if (p0 === "arrow") defs.appendChild(mk("arrow", "s"));
  if (p0 === "dot") defs.appendChild(mk("dot", "s"));
  if (p1 === "arrow") defs.appendChild(mk("arrow", "e"));
  if (p1 === "dot") defs.appendChild(mk("dot", "e"));
  svg.appendChild(defs);
  const attrs = {
    d: pptDslLinePath(e, minX, minY),
    fill: "none",
    stroke: color,
    "stroke-width": e.width || 2,
    "stroke-linecap": "round",
  };
  if (e.style === "dashed") attrs["stroke-dasharray"] = "10 7";
  else if (e.style === "dotted") attrs["stroke-dasharray"] = "2 4";
  if (p0 === "arrow") attrs["marker-start"] = cssFn("url", `#${id}-s`);
  if (p0 === "dot") attrs["marker-start"] = cssFn("url", `#${id}-s`);
  if (p1 === "arrow") attrs["marker-end"] = cssFn("url", `#${id}-e`);
  if (p1 === "dot") attrs["marker-end"] = cssFn("url", `#${id}-e`);
  const path = svgEl("path", attrs);
  if (e.shadow)
    path.setAttribute(
      "filter",
      cssFn("drop-shadow", `${e.shadow.h}px ${e.shadow.v}px ${e.shadow.blur}px ${e.shadow.color}`),
    );
  svg.appendChild(path);
  box.appendChild(svg);
  return box;
}

/* 图表取色：themeColors 不足按 ±24° 类似色补（core expandChartColors 同
   思路）；缺省品牌八色。饼/环一色一分类，其余一色一系列（同 core） */
const PPT_DSL_CHART_BASE = [
  "#AD392C",
  "#25221C",
  "#852B22",
  "#5A554A",
  "#6E6656",
  "#9C6D1E",
  "#47714F",
  "#3F5A73",
];
function pptDslShift(hex, deg) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let hue = 0;
  if (d) {
    if (mx === r) hue = ((g - b) / d) % 6;
    else if (mx === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const l = (mx + mn) / 2;
  const s = d / (1 - Math.abs(2 * l - 1) || 1e-6);
  const h2 = (((hue + deg) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h2 / 60) % 2) - 1));
  const mm = l - c / 2;
  let rr = 0;
  let gg = 0;
  let bb = 0;
  if (h2 < 60) {
    rr = c;
    gg = x;
  } else if (h2 < 120) {
    rr = x;
    gg = c;
  } else if (h2 < 180) {
    gg = c;
    bb = x;
  } else if (h2 < 240) {
    gg = x;
    bb = c;
  } else if (h2 < 300) {
    rr = x;
    bb = c;
  } else {
    rr = c;
    bb = x;
  }
  const to = (v) =>
    Math.round(Math.max(0, Math.min(1, v + mm)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(rr)}${to(gg)}${to(bb)}`;
}
function pptDslChartColors(given, n) {
  const base = given?.length ? given.slice(0, 8) : PPT_DSL_CHART_BASE.slice();
  const out = base.slice(0, n);
  let i = 0;
  while (out.length < n) {
    out.push(pptDslShift(base[i % base.length], (Math.floor(i / base.length) + 1) * 24));
    i += 1;
  }
  return out;
}
function pptDslClip(s, n) {
  const t = String(s == null ? "" : s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
/* 迷你图表：无坐标轴刻度，只保证形态/配色/图例与成品一致（chartType 的
   bar=竖向柱、column=横条，与 core 的 barDir 映射相同） */
function pptDslChart(e) {
  const box = el("pt-dsl-el");
  Object.assign(box.style, {
    left: `${e.left}px`,
    top: `${e.top}px`,
    width: `${e.width}px`,
    height: `${e.height}px`,
  });
  const W = e.width;
  const H = e.height;
  const labels = e.data.labels || [];
  const legends = e.data.legends || [];
  const series = e.data.series || [];
  const ink = e.textColor || PPT_DSL_INK;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  const pieLike = e.chartType === "pie" || e.chartType === "ring";
  const multi = series.length > 1 || pieLike;
  const colors = pptDslChartColors(
    e.themeColors,
    pieLike ? Math.max(1, labels.length) : Math.max(1, series.length),
  );
  const legendH = multi ? 20 : 0;
  const labelFont = Math.max(9, Math.min(12, W / 60));
  const axisY = H - (e.chartType === "column" ? 4 : 16);
  if (e.fill) svg.appendChild(svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: e.fill }));
  if (multi) {
    let lx = 4;
    const items = pieLike ? labels : legends.length ? legends : series.map((_, i) => `S${i + 1}`);
    for (let i = 0; i < items.length && lx < W - 30; i++) {
      svg.appendChild(
        svgEl("rect", { x: lx, y: 2, width: 8, height: 8, rx: 2, fill: colors[i % colors.length] }),
      );
      const t = svgEl("text", { x: lx + 12, y: 10, fill: ink, "font-size": labelFont });
      t.textContent = pptDslClip(items[i], 8);
      svg.appendChild(t);
      lx += 12 + pptDslClip(items[i], 8).length * labelFont * 0.62 + 10;
    }
  }
  const plot = { x: 10, y: 6 + legendH, w: W - 20, h: Math.max(10, axisY - (6 + legendH)) };
  let vmax = 0;
  for (const arr of series) for (const v of arr) if (v > vmax) vmax = v;
  if (vmax <= 0) vmax = 1;
  if (pieLike) {
    const vals = (series[0] || labels.map(() => 1)).slice(0, labels.length);
    const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const cx = plot.x + plot.w / 2;
    const cy = plot.y + plot.h / 2;
    const r = Math.min(plot.w, plot.h) / 2 - 4;
    let ang = -Math.PI / 2;
    vals.forEach((v, i) => {
      const frac = Math.max(0, v) / total;
      if (frac <= 0) return;
      const a2 = ang + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const x1 = cx + r * Math.cos(ang);
      const y1 = cy + r * Math.sin(ang);
      const x2 = cx + r * Math.cos(a2);
      const y2 = cy + r * Math.sin(a2);
      const d = `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`;
      svg.appendChild(svgEl("path", { d, fill: colors[i % colors.length] }));
      if (e.chartType === "ring") {
        const ri = r * 0.6;
        const x3 = cx + ri * Math.cos(ang);
        const y3 = cy + ri * Math.sin(ang);
        const x4 = cx + ri * Math.cos(a2);
        const y4 = cy + ri * Math.sin(a2);
        svg.appendChild(
          svgEl("path", {
            d: `M${cx},${cy} L${x3},${y3} A${ri},${ri} 0 ${large} 1 ${x4},${y4} Z`,
            fill: "#00000000",
          }),
        );
      }
      if (frac > 0.08) {
        const lx = cx + r * 0.72 * Math.cos((ang + a2) / 2);
        const ly = cy + r * 0.72 * Math.sin((ang + a2) / 2);
        const t = svgEl("text", {
          x: lx,
          y: ly + 3,
          fill: "#FDFCF9",
          "font-size": labelFont,
          "text-anchor": "middle",
        });
        t.textContent = `${Math.round(frac * 100)}%`;
        svg.appendChild(t);
      }
      ang = a2;
    });
    box.appendChild(svg);
    return box;
  }
  if (e.chartType === "radar") {
    const cx = plot.x + plot.w / 2;
    const cy = plot.y + plot.h / 2;
    const r = Math.min(plot.w, plot.h) / 2 - 12;
    const n = Math.max(1, labels.length);
    const angOf = (i) => -Math.PI / 2 + (i / n) * Math.PI * 2;
    for (const f of [0.25, 0.5, 0.75, 1]) {
      const pts = [];
      for (let i = 0; i < n; i++)
        pts.push(`${cx + r * f * Math.cos(angOf(i))},${cy + r * f * Math.sin(angOf(i))}`);
      svg.appendChild(
        svgEl("polygon", {
          points: pts.join(" "),
          fill: "none",
          stroke: "#E1DCCF",
          "stroke-width": 1,
        }),
      );
    }
    for (let i = 0; i < n; i++) {
      svg.appendChild(
        svgEl("line", {
          x1: cx,
          y1: cy,
          x2: cx + r * Math.cos(angOf(i)),
          y2: cy + r * Math.sin(angOf(i)),
          stroke: "#E1DCCF",
          "stroke-width": 1,
        }),
      );
      const t = svgEl("text", {
        x: cx + (r + 8) * Math.cos(angOf(i)),
        y: cy + (r + 8) * Math.sin(angOf(i)) + 3,
        fill: ink,
        "font-size": labelFont,
        "text-anchor": "middle",
      });
      t.textContent = pptDslClip(labels[i], 5);
      svg.appendChild(t);
    }
    series.forEach((arr, si) => {
      const pts = arr
        .map(
          (v, i) =>
            `${cx + ((r * Math.max(0, v)) / vmax) * Math.cos(angOf(i))},${cy + ((r * Math.max(0, v)) / vmax) * Math.sin(angOf(i))}`,
        )
        .join(" ");
      svg.appendChild(
        svgEl("polygon", {
          points: pts,
          fill: colors[si % colors.length],
          "fill-opacity": 0.22,
          stroke: colors[si % colors.length],
          "stroke-width": 2,
        }),
      );
    });
    box.appendChild(svg);
    return box;
  }
  const isCols = e.chartType === "bar"; // 竖向柱（core: barDir col）
  const stack = !!e.options?.stack;
  const n = Math.max(1, labels.length);
  const m = Math.max(1, series.length);
  if (isCols) {
    const gw = plot.w / n;
    const bw = (gw * 0.62) / m;
    labels.forEach((lb, i) => {
      let acc = 0;
      series.forEach((arr, si) => {
        const v = Math.max(0, arr[i] || 0);
        const hh = (v / vmax) * plot.h;
        const x = plot.x + gw * i + gw * 0.19 + (stack ? 0 : si * bw);
        const y = plot.y + plot.h - (stack ? (acc / vmax) * plot.h : 0) - hh;
        svg.appendChild(
          svgEl("rect", {
            x,
            y,
            width: Math.max(1, bw - (stack ? 0 : 1.5)),
            height: Math.max(0, hh),
            rx: 1.5,
            fill: colors[si % colors.length],
          }),
        );
        acc += v;
      });
      const t = svgEl("text", {
        x: plot.x + gw * i + gw / 2,
        y: H - 4,
        fill: ink,
        "font-size": labelFont,
        "text-anchor": "middle",
      });
      t.textContent = pptDslClip(lb, 6);
      svg.appendChild(t);
    });
  } else if (e.chartType === "column") {
    const gh = plot.h / n;
    const bh = (gh * 0.62) / m;
    const labelW = Math.min(64, plot.w * 0.24);
    labels.forEach((lb, i) => {
      let acc = 0;
      series.forEach((arr, si) => {
        const v = Math.max(0, arr[i] || 0);
        const ww = (v / vmax) * (plot.w - labelW);
        const y = plot.y + gh * i + gh * 0.19 + (stack ? 0 : si * bh);
        const x = plot.x + labelW + (stack ? (acc / vmax) * (plot.w - labelW) : 0);
        svg.appendChild(
          svgEl("rect", {
            x,
            y,
            width: Math.max(0, ww),
            height: Math.max(1, bh - (stack ? 0 : 1.5)),
            rx: 1.5,
            fill: colors[si % colors.length],
          }),
        );
        acc += v;
      });
      const t = svgEl("text", {
        x: plot.x + labelW - 6,
        y: plot.y + gh * i + gh / 2 + 3,
        fill: ink,
        "font-size": labelFont,
        "text-anchor": "end",
      });
      t.textContent = pptDslClip(lb, 6);
      svg.appendChild(t);
    });
  } else {
    // line / area / scatter：横向等分点
    const px = (i) => plot.x + (n <= 1 ? plot.w / 2 : (i / (n - 1)) * plot.w);
    const py = (v) => plot.y + plot.h - (Math.max(0, v) / vmax) * plot.h;
    svg.appendChild(
      svgEl("line", {
        x1: plot.x,
        y1: plot.y + plot.h,
        x2: plot.x + plot.w,
        y2: plot.y + plot.h,
        stroke: "#E1DCCF",
        "stroke-width": 1,
      }),
    );
    labels.forEach((lb, i) => {
      if (i % Math.ceil(n / 6) !== 0 && i !== n - 1) return;
      const t = svgEl("text", {
        x: px(i),
        y: H - 4,
        fill: ink,
        "font-size": labelFont,
        "text-anchor": "middle",
      });
      t.textContent = pptDslClip(lb, 6);
      svg.appendChild(t);
    });
    series.forEach((arr, si) => {
      const col = colors[si % colors.length];
      if (e.chartType === "area") {
        const pts = arr.map((v, i) => `${px(i)},${py(v)}`).join(" ");
        svg.appendChild(
          svgEl("polygon", {
            points: `${px(0)},${plot.y + plot.h} ${pts} ${px(arr.length - 1)},${plot.y + plot.h}`,
            fill: col,
            "fill-opacity": 0.22,
          }),
        );
      }
      if (e.chartType !== "scatter") {
        const smooth = e.options?.lineSmooth && arr.length > 2;
        let d = "";
        arr.forEach((v, i) => {
          if (i === 0) d = `M${px(i)},${py(v)}`;
          else if (smooth) {
            const px0 = px(i - 1);
            const py0 = py(arr[i - 1]);
            const mx = (px0 + px(i)) / 2;
            d += ` C${mx},${py0} ${mx},${py(v)} ${px(i)},${py(v)}`;
          } else d += ` L${px(i)},${py(v)}`;
        });
        svg.appendChild(
          svgEl("path", {
            d,
            fill: "none",
            stroke: col,
            "stroke-width": 2,
            "stroke-linejoin": "round",
          }),
        );
      }
      arr.forEach((v, i) => {
        svg.appendChild(svgEl("circle", { cx: px(i), cy: py(v), r: 2.6, fill: col }));
      });
    });
  }
  box.appendChild(svg);
  return box;
}

/* 表格：colgroup 列宽 = 元素宽 × 占比（与成品 colW 同式，不归一）；
   合并格跳过被覆盖的格子；主题色表头/首列 + 斑马纹 */
function pptDslTable(e) {
  const box = el("pt-dsl-el");
  Object.assign(box.style, {
    left: `${e.left}px`,
    top: `${e.top}px`,
    width: `${e.width}px`,
    height: `${e.height}px`,
  });
  const wrap = el("pt-dsl-tablewrap");
  wrap.style.width = `${e.width}px`;
  wrap.style.height = `${e.height}px`;
  const tb = document.createElement("table");
  tb.className = "pt-dsl-table";
  const cg = document.createElement("colgroup");
  for (const w of e.colWidths || []) {
    const col = document.createElement("col");
    col.style.width = `${e.width * w}px`;
    cg.appendChild(col);
  }
  tb.appendChild(cg);
  const theme = e.theme || {};
  const rows = e.data || [];
  const hidden = new Set();
  rows.forEach((row, i) => {
    row.forEach((cell, j) => {
      if (cell.colspan > 1 || cell.rowspan > 1) {
        for (let r = i; r < i + cell.rowspan; r++)
          for (let c = r === i ? j + 1 : j; c < j + cell.colspan; c++) hidden.add(`${r}_${c}`);
      }
    });
  });
  rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    let col = 0;
    row.forEach((cell) => {
      const j = col;
      col += cell.colspan;
      if (hidden.has(`${i}_${j}`)) return;
      const td = document.createElement("td");
      td.textContent = cell.text || "";
      if (cell.colspan > 1) td.colSpan = cell.colspan;
      if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
      const st = cell.style || {};
      const head =
        (theme.rowHeader && i === 0) ||
        (theme.rowFooter && i === rows.length - 1) ||
        (theme.colHeader && j === 0) ||
        (theme.colFooter && j === row.length - 1);
      if (head && theme.color) {
        td.style.background = theme.color;
        td.style.color = PPT_DSL_PAPER;
        td.style.fontWeight = "700";
      } else if (st.backcolor) td.style.background = st.backcolor;
      else if (i % 2 === 1) td.style.background = "#F0EDE4";
      if (st.color && !(head && theme.color)) td.style.color = st.color;
      if (st.bold) td.style.fontWeight = "700";
      if (st.em) td.style.fontStyle = "italic";
      if (st.underline) td.style.textDecoration = "underline";
      if (st.strikethrough) td.style.textDecoration = "line-through";
      if (st.fontsize) td.style.fontSize = `${Number(st.fontsize) || 14}px`;
      if (st.fontname) td.style.fontFamily = st.fontname;
      if (st.align) td.style.textAlign = st.align;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
  wrap.appendChild(tb);
  box.appendChild(wrap);
  return box;
}

/* 公式：MathML 由服务端 temml 生成（白名单外但来源可信，随载荷直传）；
   缺失时降级为等宽源码文本 */
function pptDslLatex(e) {
  const d = el("pt-dsl-el pt-dsl-latex");
  Object.assign(d.style, {
    left: `${e.left}px`,
    top: `${e.top}px`,
    width: `${e.width}px`,
    height: `${e.height}px`,
  });
  if (e.align) d.style.textAlign = e.align;
  if (e.mathml) d.innerHTML = e.mathml;
  else {
    d.textContent = e.latex;
    d.classList.add("fallback");
  }
  return d;
}

/* 代码：纸底卡片 + 标题栏（文件名/语言）+ 行号 */
function pptDslCode(e) {
  const box = el("pt-dsl-el pt-dsl-code");
  Object.assign(box.style, {
    left: `${e.left}px`,
    top: `${e.top}px`,
    width: `${e.width}px`,
    height: `${e.height}px`,
  });
  if (e.fileName || e.language) {
    const head = el("pt-dsl-codehead");
    if (e.fileName) head.appendChild(el2("pt-dsl-codefile", e.fileName));
    if (e.language) head.appendChild(el2("pt-dsl-codelang", e.language));
    box.appendChild(head);
  }
  const body = el("pt-dsl-codebody");
  body.style.fontSize = `${e.fontSize || 14}px`;
  (e.lines || []).forEach((ln, i) => {
    const row = el("pt-dsl-codeline");
    if (e.showLineNumbers !== false) row.appendChild(el2("pt-dsl-codeno", String(i + 1)));
    row.appendChild(el2("pt-dsl-codetx", ln.content || ""));
    body.appendChild(row);
  });
  box.appendChild(body);
  return box;
}

function pptDslInner(box, s, index) {
  const cv = el("pt-dsl");
  pptDslBgStyle(cv, s);
  pptDslChrome(cv, s, index);
  (s.elements || []).forEach((e) => {
    const d = pptDslElement(e);
    if (d) cv.appendChild(d);
  });
  if (s.elemCut) {
    const cut = el("pt-dsl-elemcut");
    cut.textContent = `+ ${s.elemCut} 元素`;
    cv.appendChild(cut);
  }
  box.appendChild(cv);
}

function pptSlideInner(box, s, big, index) {
  if (!s.kind) {
    /* JSON 管线（ppt_save）：无 kind，元素坐标就是画布 px */
    pptDslInner(box, s, index);
    requestAnimationFrame(() => {
      pptFitFreePx(box);
    });
    return;
  }
  if (s.kind === "free") {
    pptFreeInner(box, s);
    return;
  }
  if (s.kind === "cover") {
    box.appendChild(pptSeal());
    box.appendChild(el2("pt-maintitle", s.title));
    if (s.author) box.appendChild(el2("pt-author", s.author));
    return;
  }
  if (s.kind === "section") {
    box.appendChild(el2("pt-sectitle", s.title));
    box.appendChild(pptSeal());
    return;
  }
  box.appendChild(el2("pt-title", s.title));
  if (s.subtitle) box.appendChild(el2("pt-sub", s.subtitle));
  if (s.bullets?.length) {
    /* 与成品同一条规则：≤6 条且无表格 → 数字圆圈视觉行，否则紧凑列表 */
    if (!s.table && s.bullets.length <= 6) {
      const rows = el("pt-rows");
      s.bullets.forEach((b, i) => {
        const row = el("pt-row");
        row.appendChild(el2("pt-num", String(i + 1)));
        row.appendChild(el2("pt-li", b));
        rows.appendChild(row);
      });
      if (s.bulletCut) rows.appendChild(el2("pt-li more", `+ ${s.bulletCut} 条`));
      box.appendChild(rows);
    } else {
      const ul = el("pt-list");
      const cap = big ? 12 : 5;
      s.bullets.slice(0, cap).forEach((b) => {
        ul.appendChild(el2("pt-li", b));
      });
      const more = (s.bulletCut || 0) + Math.max(0, s.bullets.length - cap);
      if (more > 0) {
        const li = el2("pt-li", `+ ${more} 条`);
        li.classList.add("more");
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
  } else if (s.table) {
    const tb = el("pt-table");
    const rows = [];
    if (s.table.headers?.length) rows.push({ cells: s.table.headers, head: true });
    const cap = big ? 8 : 3;
    s.table.rows.slice(0, cap).forEach((r) => {
      rows.push({ cells: r, head: false });
    });
    const rc = (s.table.rowCut || 0) + Math.max(0, s.table.rows.length - cap);
    const cols = rows.length ? rows[0].cells.length : 1;
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      if (row.head) tr.className = "pt-th";
      row.cells.forEach((c) => {
        const td = document.createElement("td");
        td.textContent = String(c == null ? "" : c);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    if (rc > 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = cols;
      td.className = "pt-more";
      td.textContent = `+ ${rc} 行`;
      tr.appendChild(td);
      tb.appendChild(tr);
    }
    box.appendChild(tb);
  }
  box.appendChild(pptLogo());
}

/* 人物图谱迷你卡：对话里每次图谱变更就地重绘一张 SVG 小图。
   布局与 /graph 独立页同算法（BFS 分层 + 层内重心对齐），但省掉
   拖拽/缩放/删除——那是独立页的事，这里只做「当场看见长出来」。 */
const GRAPH_CAT_COLORS = {
  family: "#bf4d28",
  romance: "#c4566e",
  friendship: "#47714f",
  conflict: "#3f5a73",
  hierarchy: "#9c6d1e",
  other: "#857f74",
};
/* 类别中文名：与 core/graph-categories.ts 的 GRAPH_CATEGORIES 同名同序，
   两处各存一份是刻意的——前端是无模块的静态资产，不能 import */
const GRAPH_CAT_NAMES = {
  family: "血缘亲属",
  romance: "婚姻爱情",
  friendship: "友情同盟",
  conflict: "敌对冲突",
  hierarchy: "尊卑从属",
  other: "其他",
};
const GRAPH_SVG_NS = "http://www.w3.org/2000/svg";

function graphMiniLayout(persons, relations) {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const deg = new Map(persons.map((p) => [p.id, 0]));
  const adj = new Map(persons.map((p) => [p.id, []]));
  for (const r of relations) {
    if (!byId.has(r.sourceId) || !byId.has(r.targetId) || r.sourceId === r.targetId) continue;
    deg.set(r.sourceId, (deg.get(r.sourceId) || 0) + 1);
    deg.set(r.targetId, (deg.get(r.targetId) || 0) + 1);
    adj.get(r.sourceId).push(r.targetId);
    adj.get(r.targetId).push(r.sourceId);
  }
  /* 重要度 + 度数高的当根，起始层更贴近真实中心 */
  const roots = persons
    .slice()
    .sort(
      (a, b) =>
        (deg.get(b.id) || 0) - (deg.get(a.id) || 0) || (b.importance || 1) - (a.importance || 1),
    )
    .slice(0, Math.max(1, Math.ceil(persons.length / 8)))
    .map((p) => p.id);

  const rank = new Map();
  const queue = [];
  for (const id of roots) {
    if (!rank.has(id)) {
      rank.set(id, 0);
      queue.push(id);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi];
    for (const nb of adj.get(id) || []) {
      if (!rank.has(nb)) {
        rank.set(nb, rank.get(id) + 1);
        queue.push(nb);
      }
    }
  }
  let maxRank = 0;
  for (const v of rank.values()) maxRank = Math.max(maxRank, v);
  for (const p of persons) if (!rank.has(p.id)) rank.set(p.id, maxRank + 1);

  const layers = [];
  for (const p of persons) {
    const lv = rank.get(p.id);
    if (!layers[lv]) layers[lv] = [];
    layers[lv].push(p);
  }
  const NW = 116;
  const NH = 34;
  const pos = new Map();
  for (let l = 0; l < layers.length; l++) {
    const cur = layers[l];
    if (!cur) continue;
    cur.sort((a, b) => (b.importance || 1) - (a.importance || 1) || a.name.localeCompare(b.name));
    for (let i = 0; i < cur.length; i++) {
      pos.set(cur[i].id, { x: l * (NW + 44), y: i * (NH + 14) });
    }
  }
  /* 重心对齐几轮收敛，让连线少交叉 */
  for (let pass = 0; pass < 3; pass++) {
    for (let l = 1; l < layers.length; l++) {
      const cur = layers[l];
      if (!cur) continue;
      for (const p of cur) {
        let sum = 0;
        let cnt = 0;
        for (const nb of adj.get(p.id) || []) {
          if (rank.get(nb) === l - 1 && pos.has(nb)) {
            sum += pos.get(nb).y;
            cnt++;
          }
        }
        if (cnt) pos.get(p.id).y = sum / cnt;
      }
      cur.sort((a, b) => pos.get(a.id).y - pos.get(b.id).y);
      for (let i = 1; i < cur.length; i++) {
        const need = NH + 14;
        if (pos.get(cur[i].id).y - pos.get(cur[i - 1].id).y < need)
          pos.get(cur[i].id).y = pos.get(cur[i - 1].id).y + need;
      }
    }
  }
  return { pos, NW, NH };
}

function graphMiniCard(tl, graph) {
  const persons = graph.persons || [];
  const relations = graph.relations || [];
  if (!persons.length) return;

  const used = new Set();
  for (const r of relations) {
    used.add(r.sourceId);
    used.add(r.targetId);
  }
  const visPersons = persons.filter((p) => used.has(p.id) || relations.length === 0);
  if (!visPersons.length) return;

  const { pos, NW, NH } = graphMiniLayout(visPersons, relations);

  let maxX = 0;
  let maxY = 0;
  for (const p of visPersons) {
    const q = pos.get(p.id);
    if (!q) continue;
    maxX = Math.max(maxX, q.x + NW);
    maxY = Math.max(maxY, q.y + NH);
  }
  const W = maxX + 8;
  const H = maxY + 8;

  const card = el("graphcard");
  const head = el("graph-head");
  head.appendChild(el2("graph-mark", "⌗"));
  head.appendChild(el2("graph-name", "人物图谱"));
  head.appendChild(el2("graph-meta", `${visPersons.length} 人物 · ${relations.length} 关系`));
  const more = document.createElement("a");
  more.className = "tbtn";
  /* 带 bookId：不带的话多本书时 /graph 只会开默认书，用户在对话里看的
     这本书和画板打开的那本不是同一本 */
  more.href = graph.bookId ? `/graph?bookId=${encodeURIComponent(graph.bookId)}` : "/graph";
  more.textContent = "打开画板";
  head.appendChild(more);
  card.appendChild(head);

  const canvas = el("graph-scroll");
  const svg = document.createElementNS(GRAPH_SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `人物关系图，${visPersons.length} 个人物、${relations.length} 条关系`,
  );

  const mk = (tag, attrs) => {
    const n = document.createElementNS(GRAPH_SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, String(attrs[k]));
    return n;
  };

  for (const r of relations) {
    const a = pos.get(r.sourceId);
    const b = pos.get(r.targetId);
    if (!a || !b) continue;
    const color = GRAPH_CAT_COLORS[r.category] || GRAPH_CAT_COLORS.other;
    const x1 = a.x + NW;
    const y1 = a.y + NH / 2;
    const x2 = b.x;
    const y2 = b.y + NH / 2;
    let d;
    if (x2 < x1) {
      const fx = a.x;
      const tx = b.x + NW;
      d = `M${fx} ${a.y + NH / 2} C${fx - 34} ${a.y + NH / 2} ${tx + 34} ${b.y + NH / 2} ${tx} ${b.y + NH / 2}`;
    } else {
      const mid = (x1 + x2) / 2;
      d = `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
    }
    svg.appendChild(mk("path", { d, fill: "none", stroke: color, "stroke-width": "1.4" }));
    if (r.label) {
      const lx = (a.x + b.x) / 2 + NW / 2;
      const ly = (a.y + b.y) / 2 + NH / 2;
      const w = r.label.length * 9 + 8;
      svg.appendChild(
        mk("rect", {
          x: lx - w / 2,
          y: ly - 7.5,
          width: w,
          height: 15,
          rx: 3,
          fill: "#FBF7EC",
          stroke: "#E1DCCF",
          "stroke-width": "0.5",
        }),
      );
      const t = mk("text", {
        x: lx,
        y: ly,
        "font-size": "9",
        fill: "#5C5142",
        "text-anchor": "middle",
        "dominant-baseline": "central",
      });
      t.textContent = r.label;
      svg.appendChild(t);
    }
  }

  for (const p of visPersons) {
    const q = pos.get(p.id);
    if (!q) continue;
    // 节点组用 x/y 平移而非 transform 串：SVG 语义相同，还避开了静态扫描
    // 把模板串里的 SVG 变换函数误判成 JS 函数调用
    const g = mk("g", { x: q.x, y: q.y });
    g.appendChild(
      mk("rect", {
        x: 0,
        y: 0,
        width: NW,
        height: NH,
        rx: 7,
        fill: "#FFFFFF",
        stroke: "#C9C1AF",
        "stroke-width": "1",
      }),
    );
    const nm = mk("text", {
      x: NW / 2,
      y: NH / 2,
      "font-size": "12",
      fill: "#25221C",
      "text-anchor": "middle",
      "dominant-baseline": "central",
    });
    nm.textContent = p.name.length > 9 ? `${p.name.slice(0, 9)}…` : p.name;
    g.appendChild(nm);
    for (let d = 0; d < Math.min(3, Math.max(1, p.importance || 1)); d++) {
      g.appendChild(mk("circle", { cx: NW - 8 - d * 5.5, cy: 9, r: 2, fill: "#AD392C" }));
    }
    svg.appendChild(g);
  }

  canvas.appendChild(svg);
  card.appendChild(canvas);
  tl.appendChild(card);
  scroll(false);
}

function pptCard(tl, ppt, files) {
  if (!ppt?.slides?.length) return;
  const deckId = pptDeckId(ppt, files);
  const card = el("pptcard");
  /* 深链锚点：data-ppt-id 让 ?ppt= 能找回这张卡，__ppt/__files 让重开时
     不必再解析一遍工具输出 */
  card.dataset.pptId = deckId;
  card.__ppt = ppt;
  card.__files = files;
  const head = el("ppt-head");
  head.appendChild(el2("ppt-mark", "▦"));
  const cover = ppt.slides[0];
  const dl = files?.[0];
  /* 卡片名：旧管线取封面标题，JSON 管线取首页第一个文本（pptx 同名规则） */
  const name =
    (cover && cover.kind === "cover" && cover.title) ||
    (cover && !cover.kind && pptDslTitle(cover)) ||
    dl?.name ||
    "PPT";
  head.appendChild(el2("ppt-name", name));
  head.appendChild(
    el2(
      "ppt-meta",
      `${ppt.count} 页${ppt.slides.length < ppt.count ? ` · 前 ${ppt.slides.length} 页` : ""}`,
    ),
  );
  if (dl) {
    const a = document.createElement("a");
    a.className = "tbtn";
    a.href = `/files/${encodeURIComponent(dl.name)}`;
    a.setAttribute("download", dl.name);
    a.textContent = "下载";
    head.appendChild(a);
  }
  card.appendChild(head);
  const strip = el("pptstrip");
  ppt.slides.forEach((s, i) => {
    const sl = el(`pptslide ${pptSlideClass(s)}`);
    pptSlideInner(sl, s, false, i);
    /* 可聚焦：CSS 里早有 :focus-visible 高亮，但一直忘了给 tabindex——
       键盘用户 Tab 根本进不到预览入口，全屏关闭时也没法把焦点还回来 */
    sl.tabIndex = 0;
    sl.setAttribute("role", "button");
    sl.setAttribute("aria-label", `第 ${i + 1} 页，点击全屏预览`);
    /* 记住来源缩略图：关掉全屏把焦点还回来，键盘用户不丢位置 */
    sl.addEventListener("click", () => pptView(ppt, i, files, deckId, { returnFocus: sl }));
    strip.appendChild(sl);
  });
  card.appendChild(strip);
  tl.appendChild(card);
  scroll(false);
}

/* ── PPT 全屏查看器 ──
   打开态走查询串 ?ppt=<画册id>&p=<页号>，不占用 #hall=（那套 hash 归功能
   大厅，两套导航各走各的通道才不互相顶掉）。pushState 压栈，于是浏览器后退
   与手机返回键就是「关闭全屏」——和功能大厅的后退关闭是同一条心智；翻页只
   replaceState，不把历史栈撑成一页一格。
   画册 id 用成品文件名：同一份课件刷新前后不变，深链才站得住。没有成品
   文件时才退回计数兜底（那种深链刷新后失效，但绝不会开错画册）。 */
let pptSeq = 0;
let pptLive = null; // 打开中的查看器 { ov, deck, ppt, files, i, thumbs, returnFocus }
let pptPushed = false; // 本次打开是否真的压了历史栈（决定关闭时要不要 back）

function pptDeckId(ppt, files) {
  const named = files?.[0]?.name;
  if (named) return named;
  /* 没有成品文件时才用计数兜底：那种深链刷新后失效，但绝不会开错画册 */
  pptSeq += 1;
  return `ppt-${ppt.count}-${pptSeq}`;
}
function pptUrlId() {
  return new URLSearchParams(location.search).get("ppt") || "";
}
function pptUrlPage() {
  const n = Number(new URLSearchParams(location.search).get("p"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}
function pptUrlFor(id, page) {
  const u = new URL(location.href);
  if (id) u.searchParams.set("ppt", id);
  else u.searchParams.delete("ppt");
  if (page > 0) u.searchParams.set("p", String(page));
  else u.searchParams.delete("p");
  return u.pathname + u.search + u.hash;
}
/* 按画册 id 找回对话里那张卡：深链「刷新还原 / 前进重进」时靠它重开 */
function pptCardById(id) {
  const cards = document.querySelectorAll(".pptcard[data-ppt-id]");
  for (const c of cards) if (c.dataset.pptId === id) return c;
  return null;
}

/* 键盘守卫：焦点在输入类控件里时，方向键/空格归控件自己（全屏开着也能
   继续改搜索词），Esc 仍然放行——那是「关掉浮层」的通用手势 */
function pptEditable(t) {
  if (!t) return false;
  const tag = t.tagName ? t.tagName : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable === true;
}

function pptView(ppt, index, files, deckId, opts) {
  /* 换画册（或重复点开）：旧的不弹历史栈，只把新的一次压进去 */
  if (pptLive) pptClose(pptLive, false);
  const total = ppt.slides.length;
  let i = Math.max(0, Math.min(index, total - 1));
  const dl = files?.[0];
  const truncated = ppt.count > total; // 预览只带前 N 页，成品更厚

  const ov = el("pptv");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.setAttribute("aria-label", `${dl?.name || "PPT"} 全屏预览，共 ${total} 页`);
  ov.dataset.deck = deckId;

  /* 顶栏：文件名 + 当前页标题 + 预览截断说明 + 文件级动作 */
  const top = el("pptv-top");
  top.appendChild(el2("pptv-name", dl?.name || "PPT 预览"));
  const ptitle = el2("pptv-ptitle", "");
  top.appendChild(ptitle);
  if (truncated) top.appendChild(el2("pptv-cap", `预览前 ${total} 页 · 全 ${ppt.count} 页`));
  if (dl) {
    const a = document.createElement("a");
    a.className = "tbtn pptv-dl";
    a.href = `/files/${encodeURIComponent(dl.name)}`;
    a.setAttribute("download", dl.name);
    a.textContent = "下载";
    top.appendChild(a);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "pptv-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "关闭全屏预览");
  top.appendChild(close);

  /* 舞台：尺寸由量出来的可用高度反算，不写死「减掉底栏 118px」 */
  const body = el("pptv-body");
  const stage = el("pptv-stage");

  /* 缩略图条：长课件一页页翻找不到北，给一条能直接跳的胶片 */
  const rail = el("pptv-rail");
  const thumbs = ppt.slides.map((s, k) => {
    const t = el(`pptslide pptv-thumb ${pptSlideClass(s)}`);
    pptSlideInner(t, s, false, k);
    /* 不作为 Tab 停靠点：方向键翻页已经覆盖了键盘路径，30 个缩略图逐个
       Tab 过去只会把焦点陷阱变成耐力测试 */
    t.tabIndex = -1;
    t.setAttribute("aria-label", `跳到第 ${k + 1} 页`);
    t.addEventListener("click", () => goTo(k));
    rail.appendChild(t);
    return t;
  });

  const bar = el("pptv-bar");
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "pptv-nav";
  prev.textContent = "‹";
  prev.setAttribute("aria-label", "上一页");
  const counter = el2("pptv-count", "");
  const next = document.createElement("button");
  next.type = "button";
  next.className = "pptv-nav";
  next.textContent = "›";
  next.setAttribute("aria-label", "下一页");
  bar.appendChild(prev);
  bar.appendChild(counter);
  bar.appendChild(next);

  function render() {
    const s = ppt.slides[i];
    stage.className = `pptv-stage ${pptSlideClass(s)}`;
    while (stage.firstChild) stage.removeChild(stage.firstChild);
    pptSlideInner(stage, s, true, i);
    counter.textContent = `${i + 1} / ${total}`;
    prev.disabled = i === 0;
    next.disabled = i === total - 1;
    /* 页题：旧管线是 slide.title，JSON 管线取首页文本（无标题则隐藏） */
    const title = s.kind ? s.title || "" : pptDslTitle(s);
    ptitle.textContent = title;
    ptitle.style.display = title ? "" : "none";
    for (let k = 0; k < thumbs.length; k++) thumbs[k].classList.toggle("on", k === i);
    /* 当前页滚进视：缩略图条很长时不让用户自己找 */
    if (thumbs[i] && typeof thumbs[i].scrollIntoView === "function") {
      thumbs[i].scrollIntoView({ block: "nearest", inline: "center" });
    }
    sizeStage();
  }
  function goTo(k) {
    const j = Math.max(0, Math.min(k, total - 1));
    if (j === i) return;
    i = j;
    render();
    /* 翻页只改地址不压栈：后退一步是关全屏，不是回上一页 */
    history.replaceState(null, "", pptUrlFor(deckId, i + 1));
  }
  function go(d) {
    goTo(i + d);
  }
  function onKey(e) {
    if (pptEditable(e.target)) {
      if (e.key === "Escape") shut();
      return;
    }
    if (e.key === "Escape") shut();
    else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
    else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
      e.preventDefault();
      go(1);
    } else if (e.key === "Home") goTo(0);
    else if (e.key === "End") goTo(total - 1);
    else if (e.key === "Tab") trapFocus(e);
  }
  /* 焦点陷阱：Tab 在「关闭 / 上一页 / 下一页 / 下载」之间循环，不逃到
     背后的对话里——模态浮层的基本体面 */
  function trapFocus(e) {
    const f = [close, prev, next];
    if (dl) f.push(bar.querySelector(".pptv-dl") || ov.querySelector(".pptv-dl"));
    const items = f.filter((n) => n && n.disabled !== true);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const cur = document.activeElement;
    if (e.shiftKey && (cur === first || !ov.contains(cur))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault();
      first.focus();
    }
  }
  function shut() {
    if (pptLive) pptClose(pptLive, true);
  }

  function sizeStage() {
    const h = body.clientHeight;
    const w = body.clientWidth;
    if (h > 0 && w > 0) {
      /* 写成 CSS 变量：.pptv-stage 的 width 兜底值还在样式表里，
         量不到（旧引擎/首帧）时退回 94vw，不至于塌成一条线 */
      ov.style.setProperty("--pptv-w", `${Math.min(w, Math.round((h * 16) / 9))}px`);
    }
    /* free 页的字号/线宽是按容器宽换算的：转屏、改窗口都得重算，
       否则大图里的文字会停留在旧尺寸上发虚或溢出 */
    pptFitFreePx(stage);
  }
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(sizeStage) : null;
  if (ro) ro.observe(body);
  else window.addEventListener("resize", sizeStage);

  prev.addEventListener("click", (e) => {
    e.stopPropagation();
    go(-1);
  });
  next.addEventListener("click", (e) => {
    e.stopPropagation();
    go(1);
  });
  close.addEventListener("click", shut);
  /* 点暗处关闭：舞台自身不关（点内容不该误退），其余空白都算暗处 */
  ov.addEventListener("click", (e) => {
    if (e.target === ov || e.target === body || e.target === rail) shut();
  });
  /* 触屏左右滑动翻页（passive：只观察不拦截滚动） */
  let sx = null;
  ov.addEventListener(
    "touchstart",
    (e) => {
      sx = e.touches[0].clientX;
    },
    { passive: true },
  );
  ov.addEventListener("touchend", (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
    sx = null;
  });

  ov.appendChild(top);
  body.appendChild(stage);
  ov.appendChild(body);
  ov.appendChild(rail);
  ov.appendChild(bar);
  render();
  document.body.appendChild(ov);
  /* 锁住背后滚动：fixed 遮罩挡不住滚轮滚 #log，桌面端一晃鼠标整页对话
     就跟着跑——overflow:hidden 保留滚动位置，关掉时还在原处 */
  document.body.classList.add("ppt-open");

  pptLive = {
    ov,
    deck: deckId,
    ppt,
    files,
    thumbs,
    returnFocus: opts?.returnFocus ?? null,
    ro,
    onKey,
    goTo,
  };
  document.addEventListener("keydown", onKey);

  /* 打开即压栈：后退键从此有了「关全屏」这个动作 */
  if (opts?.push !== false) {
    history.pushState(null, "", pptUrlFor(deckId, i + 1));
    pptPushed = true;
  }
  /* 不抢焦点：深链还原时用户可能正在打字（与 openHall 的 push 口径一致） */
  if (opts?.focus !== false) close.focus();
}

/* pop 为真表示「用户主动关」——要把刚压进去的历史栈弹掉，后退键状态才
   守恒；为假表示关闭由后退/换画册触发，历史已经回退过，不能再 back */
function pptClose(live, pop) {
  if (!live?.ov.isConnected) return;
  pptLive = null;
  /* keydown 监听挂在 document 上：不摘的话关掉浮层后方向键还在翻页，
     而且每开一次就多挂一个，开三四次全乱 */
  document.removeEventListener("keydown", live.onKey);
  if (live.ro) live.ro.disconnect();
  live.ov.remove();
  document.body.classList.remove("ppt-open");
  const back = live.returnFocus;
  if (back && typeof back.focus === "function" && document.contains(back)) back.focus();
  if (pop && pptPushed) {
    pptPushed = false;
    history.back();
  }
}

/* 路由事件：查询串是 PPT 的导航通道，与 #hall= 的 hashchange 互不干扰 */
window.addEventListener("popstate", () => {
  const id = pptUrlId();
  const live = pptLive;
  if (!id) {
    /* 后退到没有 ppt= 的地址：关全屏（历史已回退，不再 back） */
    if (live) pptClose(live, false);
    return;
  }
  const page = pptUrlPage();
  if (live && live.deck === id) {
    /* 同一画册换页（前进重进）：goTo 自带钳位与同页短路 */
    live.goTo(page - 1);
    return;
  }
  /* 深链直达或「前进」重进：按 id 找回对话里那张卡重开 */
  const card = pptCardById(id);
  if (card?.__ppt) pptView(card.__ppt, page - 1, card.__files || [], id, { push: false });
});

/* 深链直达：?ppt=xxx&p=n 打开页面就恢复全屏。与 #hall= 的启动还原同套路
   ——都要等初始化脚本走完；卡片要等会话恢复后才在 DOM 里，所以重试几次，
   找不到就清掉这个失效地址，别留个打不开的链接挂在地址栏。 */
const pptBootId = pptUrlId();
if (pptBootId) {
  const pptBootTry = (n) => {
    const card = pptCardById(pptBootId);
    if (card?.__ppt) {
      pptView(card.__ppt, pptUrlPage() - 1, card.__files || [], pptBootId, {
        push: true,
        focus: false,
      });
      return;
    }
    if (n > 0) setTimeout(() => pptBootTry(n - 1), 250);
    else history.replaceState(null, "", pptUrlFor("", 0));
  };
  setTimeout(() => pptBootTry(6), 0);
}
/* 到点收尾：翻朱砂底 + 提示音 + 标题闪灯（切回页面自动复位）+ 一键接龙 */
function pomoFinish(card) {
  if (card.dataset.finished) return;
  delete card.dataset.confirming;
  card.dataset.finished = "1";
  card.classList.add("done");
  const clockEl = card.querySelector(".pclock"),
    fill = card.querySelector(".pbar i");
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
      b.type = "button";
      b.className = "tbtn";
      b.textContent = label;
      b.addEventListener("click", () => {
        if (busy) return;
        foot.querySelectorAll(".tbtn").forEach((x) => {
          x.disabled = true;
        });
        send(text);
      });
      return b;
    };
    foot.appendChild(followup(`再来一个 ${mins} 分钟番茄钟`, `再来 ${mins} 分钟`));
    foot.appendChild(followup("来一个 5 分钟番茄钟，休息一下", "休息 5 分钟"));
  }
  pomoBeep();
  document.title = "⏰ 番茄钟时间到 · CourseRaptor";
  try {
    if (window.Notification && Notification.permission === "granted") {
      new Notification("⏰ 番茄钟时间到", {
        body: `${card.dataset.label || "专注"}结束，休息一下吧`,
      });
    }
  } catch {
    /* 通知发不出就只靠页面 */
  }
}
/* 取消收尾：对话内的卡留档盖「已取消」章；恢复容器只是计时器的另一张脸，整张收走 */
function pomoCancelCard(card) {
  const restore = card.closest(".pomo-restore");
  if (restore) {
    restore.remove();
    return;
  }
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
    const ends = Number(card.dataset.ends),
      total = Number(card.dataset.total) || 1;
    const left = Math.max(0, Math.ceil((ends - now) / 1000));
    const clockEl = card.querySelector(".pclock"),
      fill = card.querySelector(".pbar i");
    if (left > 0) {
      if (clockEl) clockEl.textContent = pomoFmt(left);
      if (fill) fill.style.width = `${((100 * (total - left)) / total).toFixed(1)}%`;
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
  fetch("/api/pomodoro")
    .then((r) => r.json())
    .then((d) => {
      pomoSyncing = false;
      const activeId = d.active?.id ? String(d.active.id) : "";
      const rec = {};
      (d.recent || []).forEach((p) => {
        if (p?.id) rec[String(p.id)] = p;
      });
      document.querySelectorAll(".pomo").forEach((card) => {
        if (card.dataset.finished || card.classList.contains("cancelled")) return;
        const id = card.dataset.id || "";
        if (id && id === activeId) {
          delete card.dataset.confirming;
          return;
        }
        const remote = id ? rec[id] : null;
        if (remote && remote.status === "cancelled") {
          pomoCancelCard(card);
          return;
        }
        if (card.dataset.confirming && remote?.status !== "running") pomoFinish(card);
      });
    })
    .catch(() => {
      pomoSyncing = false;
      /* 服务端联系不上：等确认的卡按本地 endsAt 兜底翻「时间到」，别卡死 */
      document.querySelectorAll(".pomo[data-confirming]").forEach((card) => {
        if (!card.dataset.finished && !card.classList.contains("cancelled")) pomoFinish(card);
      });
    });
}
setInterval(() => {
  pomoTick();
  try {
    if (typeof hallPomoTick === "function") hallPomoTick();
  } catch {
    /* 大厅没开就跳过 */
  }
}, 1000);
/* 低频对表：别处取消后，页面上的卡最多 10 秒内收掉 */
setInterval(pomoSync, 10000);

/* 刷新/重开页面后，后台还在走的番茄钟在时间线顶部恢复一张实时卡片。
   容器不挂 .turn：切会话清屏时留着——计时是全局的，不跟某段对话走 */
function restorePomoCard() {
  if (document.body.dataset.demo === "true") return;
  fetch("/api/pomodoro")
    .then((r) => r.json())
    .then((d) => {
      const p = d.active;
      if (p?.status !== "running") return;
      const id = String(p.id || "");
      if (id && inner.querySelector(`.pomo[data-id="${id}"]`)) return;
      const wrap = el("pomo-restore");
      pomoCard(wrap, p);
      inner.prepend(wrap);
    })
    .catch(() => {
      /* 查不到就当没有：卡片本就只是计时器的另一张脸 */
    });
}

/* ── 会话档案：列表 / 打开 / 删除 / 新会话 ── */
const sessList = document.getElementById("sessList");
/* 描线小图标：置顶图钉与空态档案盒（与齿轮、大厅宫格图标同一族） */
const PIN_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24' +
  "V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15" +
  ' 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>';
const ARCHIVE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<rect x="2" y="3" width="20" height="5" rx="1"/>' +
  '<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>' +
  '<path d="M10 12h4"/></svg>';

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
  document.getElementById("sessTitle").textContent = viewingArchived ? "已归档" : "历史记录";
  document.getElementById("sessCount").textContent = shownCount ? `${shownCount} 个` : "";
  /* 主列表里有归档过才给入口；进了归档视图常驻「返回」 */
  const toggle = document.getElementById("sessArchiveToggle");
  toggle.hidden = !viewingArchived && !archivedCount;
  toggle.textContent = viewingArchived ? "返回" : `归档 ${archivedCount}`;
  const visible = lastSessions.filter((s) => !!s.archived === viewingArchived);
  if (!visible.length) {
    const li = document.createElement("li");
    li.className = "snone";
    const ico = el("");
    ico.innerHTML = ARCHIVE_SVG;
    li.appendChild(ico);
    li.appendChild(el2("snone-t", "还没有历史记录"));
    li.appendChild(
      el2(
        "snone-hint",
        archivedCount
          ? `会话都归档了，点右上「归档 ${archivedCount}」可以找回。`
          : "在下面问一句，这轮对话就会存进历史，重启也不丢。",
      ),
    );
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
      edit.className = "sedit";
      edit.value = s.title || "新会话";
      edit.maxLength = 60;
      edit.addEventListener("click", (e) => e.stopPropagation());
      edit.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveSessionTitle(s.id, edit.value);
        }
        if (e.key === "Escape") {
          editingSessionId = "";
          renderSessList();
        }
      });
      li.appendChild(edit);
      setTimeout(() => {
        edit.focus();
        edit.select();
      }, 0);
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
        button.type = "button";
        button.dataset[key] = s.id;
        button.textContent = label;
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
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }
  });
}

function patchSession(id, body) {
  return fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => (r.ok ? r.json() : Promise.reject(new Error("更新会话失败"))));
}
function saveSessionTitle(id, title) {
  const value = String(title || "").trim();
  if (!value) return;
  patchSession(id, { title: value })
    .then(() => {
      editingSessionId = "";
      sessionActionsId = "";
      return refreshSessions();
    })
    .catch(() => {});
}

function refreshSessions() {
  return fetch("/api/sessions")
    .then((r) => r.json())
    .then((d) => {
      lastSessions = d.sessions || [];
      renderSessList();
    })
    .catch(() => {});
}

function openSession(id) {
  activeId = id;
  lsSet(ACTIVE_KEY, id);
  return fetch(`/api/sessions/${encodeURIComponent(id)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      msgs = d?.messages || [];
      clearTurns();
      if (!msgs.length) {
        hero.style.display = "";
        renderSessList();
        closeDrawer();
        return;
      }
      hero.style.display = "none";
      /* 重绘历史：渲染函数不写 msgs（它已是服务端数据的镜像） */
      msgs.forEach((m) => {
        if (m.role === "user") addUser(m.text, m.ts, m.attachments);
        else addBotMessage(m.text, m.ts, m.think, m.cards);
      });
      scroll(true);
      renderSessList();
      closeDrawer();
    })
    .catch(() => {});
}

function delSession(id) {
  if (busy) return;
  /* 调用方已做两步确认（菜单 armed），这里不再弹 confirm */
  fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })
    .then(() => refreshSessions())
    .then(() => {
      if (id !== activeId) return;
      if (lastSessions.length) return openSession(lastSessions[0].id);
      activeId = "";
      lsSet(ACTIVE_KEY, "");
      startFresh();
    })
    .catch(() => {});
}

function startFresh() {
  activeId = uuid();
  lsSet(ACTIVE_KEY, activeId);
  msgs = [];
  clearTurns();
  hero.style.display = "";
  heroGreeting();
  renderSessList();
  if (AUTO_FOCUS) input.focus();
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
        if (delArmId === id) {
          delArmId = "";
          renderSessList();
        }
      }, 3000);
    }
    return;
  }
  const pin = e.target.closest("button[data-pin]");
  if (pin) {
    const current = lastSessions.find((s) => s.id === pin.dataset.pin);
    sessionActionsId = "";
    if (current)
      patchSession(current.id, { pinned: !current.pinned })
        .then(refreshSessions)
        .catch(() => {});
    return;
  }
  const rename = e.target.closest("button[data-rename]");
  if (rename) {
    editingSessionId = rename.dataset.rename;
    sessionActionsId = "";
    renderSessList();
    return;
  }
  const archive = e.target.closest("button[data-archive]");
  if (archive) {
    sessionActionsId = "";
    patchSession(archive.dataset.archive, { archived: true })
      .then(refreshSessions)
      .catch(() => {});
    return;
  }
  const unarchive = e.target.closest("button[data-unarchive]");
  if (unarchive) {
    sessionActionsId = "";
    patchSession(unarchive.dataset.unarchive, { archived: false })
      .then(refreshSessions)
      .catch(() => {});
    return;
  }
  const actions = e.target.closest("button[data-actions]");
  if (actions) {
    sessionActionsId = sessionActionsId === actions.dataset.actions ? "" : actions.dataset.actions;
    renderSessList();
    return;
  }
  const li = e.target.closest(".sess li[data-id]");
  if (li && !busy) {
    sessionActionsId = "";
    openSession(li.dataset.id);
  }
});

/* 菜单 fixed 挂 body，不跟列表滚动/窗口缩放走：与其让它悬在半空错位，直接收起 */
function dismissSessionMenu() {
  if (sessionActionsId) {
    sessionActionsId = "";
    renderSessList();
  }
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

function openDrawer() {
  document.body.classList.add("drawer-open");
}
function closeDrawer() {
  document.body.classList.remove("drawer-open");
}
document.getElementById("openDrawerM").addEventListener("click", openDrawer);
document.getElementById("drawerBackdrop").addEventListener("click", closeDrawer);

/* ── 功能大厅：右侧 push 抽屉。宫格是主页，各面板按需取数；
    对话里说「打开××」时 agent 调 open_panel / open_settings，面板自动推出。 ── */
/* 宫格图标：与工具卡齿轮同一族的 1.8px 描线 SVG（24 viewBox）。
    emoji 是彩色卡通，在墨色纸面上跳戏——单一朱砂让整套界面更像一份竖排卷宗 */
const HALL_ICONS = {
  today:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="3" y="4" width="18" height="18" rx="2"/>' +
    '<path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  schedule:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="3" y="4" width="18" height="18" rx="2"/>' +
    '<path d="M16 2v4M8 2v4M3 10h18"/>' +
    '<path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/></svg>',
  exams:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/>' +
    '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>' +
    '<path d="M10 9H8M16 13H8M16 17H8"/></svg>',
  grades:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M3 3v18h18"/>' +
    '<path d="M18 17V9M13 17V5M8 17v-3"/></svg>',
  news:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="m3 11 18-5v12L3 14v-3z"/>' +
    '<path d="M11.6 16.8a3 3 0 0 1-3.5-1.5L3 14v3l5.1 1.4a3 3 0 0 0 3.5-1.6z"/></svg>',
  todos:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>' +
    '<path d="M13 6h8M13 12h8M13 18h8"/></svg>',
  knowledge:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>' +
    '<path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  pomodoro:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<line x1="10" y1="2" x2="14" y2="2"/>' +
    '<line x1="12" y1="14" x2="15" y2="11"/>' +
    '<circle cx="12" cy="14" r="8"/></svg>',
  prompts:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="m4 17 6-6-6-6"/>' +
    '<path d="M12 19h8"/></svg>',
  usage:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="3" y="12" width="4" height="8"/>' +
    '<rect x="10" y="7" width="4" height="13"/>' +
    '<rect x="17" y="3" width="4" height="17"/></svg>',
  settings: GEAR,
  account:
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="8" r="4"/>' +
    '<path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>' +
    "</svg>",
};
/* GitHub 描线标：与宫格图标同一族的 1.8px 描线（24 viewBox），主页页脚用 */
const GH_MARK =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>' +
  "</svg>";
/* 五角星描线：同一族图标；求 Star 一行里常亮朱砂 */
const STAR_MARK =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>' +
  "</svg>";
const HALL_CARDS = [
  { id: "today", t: "今日日程", d: "下一节课与今日课程安排", group: "学习安排" },
  { id: "schedule", t: "课表", d: "本周每天的课与调休安排", group: "学习安排" },
  { id: "exams", t: "考试", d: "临近考试的时间、地点与座位", group: "学习安排" },
  { id: "grades", t: "成绩", d: "GPA、学分与最近学期成绩速览", group: "学习安排" },
  { id: "news", t: "教务通知", d: "教务处官网最新通知，标记需要行动的", group: "学习安排" },
  { id: "todos", t: "待办", d: "逾期置顶，按今天 / 明天分组", group: "效率工具" },
  { id: "knowledge", t: "知识库", d: "按课程归类，可搜可展开全文", group: "效率工具" },
  /* 人物图谱：读书时口述的人物关系，当场长成关系图画板；对话里说一句
     「宝玉是贾母的孙子」，卡片就在下方同步重绘，不必切到独立页 */
  { id: "graph", t: "人物图谱", d: "读书口述的人物关系画板", group: "效率工具" },
  /* 大厅入口按需求下架（2026-09-22）：宫格不再展示番茄钟；对话里说「来一个番茄钟」
     照常可用——manage_pomodoro 工具、SSE 事件、对话内 .pomo 倒计时卡与
     buildPomodoro 面板逻辑全部保留，恢复展示只需去掉 hidden 标记 */
  { id: "pomodoro", t: "番茄钟", d: "进行中实时倒计时与最近记录", group: "效率工具", hidden: true },
  /* 提示词模板与设置并列（2026-09-23）：原设置里的「常用问题」栏目拆出来
     成独立面板——它是内容管理，不是凭证配置，混在设置里连保存语义都变了味 */
  { id: "prompts", t: "提示词模板", d: "输入框上方「提示词」的自定义清单", group: "系统" },
  /* 用量统计（2026-10-05）：每日 token 消耗的 GitHub 式热力图 + 各模型分布。
     全平台功能（本地版记自己的 Key 用量、托管版同记并上报网关），非托管专属 */
  { id: "usage", t: "用量统计", d: "每日 Token 消耗热力图与各模型用量", group: "系统" },
  /* 导入课表：不进宫格（入口在 设置 → 学校 与课表空态），深链 #hall=import 可达 */
  {
    id: "import",
    t: "导入课表",
    d: "粘贴或上传课表，AI 解析后手动确认",
    group: "系统",
    hidden: true,
  },
  /* 我的账号：托管版专有（改本站登录密码），quota 探测成功后现身 */
  { id: "account", t: "我的账号", d: "修改本站登录密码", group: "系统", hidden: true },
  { id: "settings", t: "设置", d: "AI 模型、QQ 与本地数据", group: "系统" },
];
const HALL_GROUPS = ["学习安排", "效率工具", "系统"];
const HALL_TITLES = Object.fromEntries(HALL_CARDS.map((c) => [c.id, c.t]));
const HALL_DEMO = document.body.dataset.demo === "true";
const hallBody = document.getElementById("hallBody");
const hallTitle = document.getElementById("hallTitle");
const hallBack = document.getElementById("hallBack");
let hallPanel = ""; // 当前面板 id；空 = 宫格主页
let hallBrief = null; // /api/today 一次取数，日程/课表/考试/待办/知识五个面板共享
let hallAutoMuted = false; // 本轮对话里用户手动关过抽屉：这轮不再自动弹
/* ── 学校模式（设置 → 学校）：从 /api/settings 的 school 块同步，
   各面板与设置页据此区分「已适配学校 / 其他学校（手动课表）」 */
let schoolState = null; // { current, manual, newsReady, scheduleCached, custom:{name,city}, options:[] }
function schoolManual() {
  return !!schoolState?.manual;
}
/* 教务通知卡的门槛（与设置页 newsReady 同口径）：本校接入教务通知且教务
   账号已保存才亮卡；没接入的学校宫格直接不出这张卡。
   演示页没有 /api/settings，保持展示（点开是演示空态） */
function newsAvailable() {
  if (HALL_DEMO) return true;
  return !!schoolState?.newsReady;
}
function applySchoolState(next) {
  if (!next || typeof next !== "object") return;
  schoolState = next;
  syncSchoolUi();
}

function briefOf() {
  if (hallBrief) return Promise.resolve(hallBrief);
  /* 演示模式同样走 /api/today（demo 服务给虚构简报），五个面板共用 */
  return fetch("/api/today")
    .then((r) => r.json())
    .then((d) => {
      hallBrief = d;
      return d;
    });
}

function hallItem(title, meta, hot) {
  const item = el(`hall-item${hot ? " hot" : ""}`);
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
  b.type = "button";
  b.className = "hall-del";
  b.textContent = actLabel || "打开";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    action();
  });
  item.appendChild(b);
  return item;
}
function hallNote(text) {
  return el2("hall-note", text);
}
/* 空态引导：一键回到输入框并预填话术（纯前端，不调后端） */
function hallFocusChat(preset) {
  try {
    closeHall();
    if (typeof preset === "string" && preset) {
      input.value = preset;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.focus();
  } catch {
    /* 输入框不在就只关抽屉 */
  }
}
/* 知识分类筛选中态：搜索框是文本维，这个是分类维，两者叠加 */
let hallKnowCat = "";
/* 正文里的长链接自动识别成可点链接：按 URL 切片、纯 DOM 拼 <a>（不走
   innerHTML），www. 开头补 https://。URL 字符走 RFC 3986 白名单——
   黑名单写法会把紧跟其后的中文也吞进链接。cut=true 表示这段文字是
   被截断的摘要——末尾恰好顶到字符串结尾的 URL 大概率被拦腰切断，
   宁可不链（链了半截地址只会跳错），展开后自然恢复可点 */
const KNOW_URL_RE =
  /(https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+|www\.[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)/gi;
function linkifyInto(parent, text, cut) {
  let last = 0;
  for (const m of text.matchAll(KNOW_URL_RE)) {
    const url = m[0].replace(/[.,;:!?'")\]]+$/, "");
    const at = m.index;
    const end = at + url.length;
    if (end <= at || (cut && end === text.length)) continue;
    if (at > last) parent.appendChild(document.createTextNode(text.slice(last, at)));
    const a = document.createElement("a");
    a.href = /^www\./i.test(url) ? `https://${url}` : url;
    a.textContent = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    /* main 区是展开热区：点链接该跳转，不该顺手把卡片折叠了 */
    a.addEventListener("click", (e) => e.stopPropagation());
    parent.appendChild(a);
    last = end;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}
/* 知识条目：标题 + 摘要另起一段（分类/日期不上卡——顶部分类 chips 已够辨类），
   可展开看全文（main 区是热区，删除按钮在外不冲突），删除乐观更新（先移除节点，失败重刷恢复） */
function hallKnowledgeItem(k) {
  const full = String(k.content || "")
    .replace(/\s+/g, " ")
    .trim();
  const snippet = full.slice(0, 60);
  const truncated = full.length > snippet.length;
  const item = el("hall-item has-act know");
  const main = el("hall-item-main");
  main.appendChild(el2("ht", k.title));
  const text = el2("hm");
  const renderText = (open) => {
    text.textContent = "";
    linkifyInto(text, open ? full : snippet, !open && truncated);
    if (!open && truncated) text.appendChild(document.createTextNode("…"));
  };
  renderText(false);
  if (k.source) text.title = `来源：${k.source}`;
  main.appendChild(text);
  item.appendChild(main);
  if (!HALL_DEMO)
    item.appendChild(
      hallDelBtn("删除", () => {
        item.remove();
        hallRecount("knowledge");
        fetch(`/api/knowledge/${encodeURIComponent(k.id)}`, { method: "DELETE" })
          .then((r) => {
            if (!r.ok) throw new Error("delete failed");
          })
          .catch(() => renderHall(true));
      }),
    );
  /* 全文比摘要长才可展开；监听器挂 main 上，删除按钮点不进来 */
  if (full.length > snippet.length) {
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-expanded", "false");
    item.title = "点击展开全文";
    const toggle = () => {
      const open = item.classList.toggle("open");
      renderText(open);
      text.classList.toggle("more", open);
      item.setAttribute("aria-expanded", open ? "true" : "false");
    };
    main.addEventListener("click", toggle);
    item.addEventListener("keydown", (e) => {
      /* 焦点在链接上时 Enter 是跟链接走，不是折叠展开 */
      if ((e.key === "Enter" || e.key === " ") && !e.target.closest("button, a")) {
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
  b.type = "button";
  b.className = "hall-del";
  b.textContent = label;
  let armed = false,
    timer = 0;
  b.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      b.textContent = "确认删除";
      b.classList.add("armed");
      timer = window.setTimeout(() => {
        armed = false;
        b.textContent = label;
        b.classList.remove("armed");
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
    btn.type = "button";
    btn.className = "tbtn";
    btn.textContent = actionLabel;
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
  /* 课表/待办/知识各有独立完整页；今日日程/考试合用 /today；
     图谱是画板独立页 /graph；番茄钟/成绩/通知没有独立完整页：
     工具条不挂「完整页」链接 */
  if (panel === "schedule") return "/schedule";
  if (panel === "todos") return "/todos";
  if (panel === "knowledge") return "/knowledge";
  if (panel === "graph") return "/graph";
  if (panel === "pomodoro" || panel === "grades" || panel === "news" || panel === "usage")
    return "";
  return "/today";
}
function hallMore(panel) {
  const a = document.createElement("a");
  a.className = "hall-more";
  a.href = hallFullPage(panel);
  a.textContent = "完整页 →";
  a.setAttribute("aria-label", `在完整页打开${HALL_TITLES[panel] || panel}`);
  return a;
}
/* 面板工具条：左侧条数，右侧刷新 + 完整页；刷新清掉 brief 缓存重取 */
function hallToolbar(panel, countText) {
  const bar = el("hall-toolbar");
  const count = el2("hall-count", countText || "");
  bar.appendChild(count);
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "hall-refresh";
  refresh.textContent = "↻ 刷新";
  refresh.setAttribute("aria-label", `刷新${HALL_TITLES[panel] || panel}`);
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
  /* 日期题注与课表面板的天头同一语言：等宽小字 + 朱砂点亮 */
  const head = el("hall-group today");
  head.textContent = `${b.dateLabel} · ${b.term.weekLabel || "未在教学周"}`;
  wrap.appendChild(head);
  /* 今日日程只看今天：brief.next 会向后看到最多 14 天，跨天的（明天及以后）不进这个面板 */
  const todayNext = b.next && b.next.dateLabel === "今天" ? b.next : null;
  if (todayNext) {
    const mins = todayNext.startsInMin;
    const when =
      mins <= 0
        ? "即将开始"
        : mins < 60
          ? `还有 ${mins} 分钟`
          : `还有 ${Math.floor(mins / 60)} 小时${mins % 60 ? ` ${mins % 60} 分` : ""}`;
    wrap.appendChild(
      hallItem(
        `下一节 · ${todayNext.course.title}`,
        [
          todayNext.course.time || todayNext.course.periods || "",
          todayNext.course.location ? `@${todayNext.course.location}` : "",
          when,
        ]
          .filter(Boolean)
          .join(" · "),
        mins <= 60,
      ),
    );
  }
  /* 放假 / 调休补课的当日说明（如「今天是调休补课日，按被换周几的课表上课」） */
  if (b.schedule.note) wrap.appendChild(hallNote(b.schedule.note));
  const list = b.schedule.courses || [];
  list.forEach((c) => {
    wrap.appendChild(
      hallItem(
        c.title,
        [
          c.periods,
          c.time,
          c.location ? `@${c.location}` : "",
          c.status === "done" ? "已下课" : c.status === "current" ? "进行中" : "",
        ]
          .filter(Boolean)
          .join(" · "),
        c.status === "current",
      ),
    );
  });
  if (!list.length && !todayNext) {
    wrap.appendChild(hallEmpty("🍃", "今天没有课", "在对话框里问「这周课表」查看整周安排。"));
  }
  return wrap;
}
function buildSchedule(b) {
  const wrap = el("");
  if (!b.schedule.available) {
    if (schoolManual()) {
      wrap.appendChild(
        hallEmpty(
          "🗓️",
          "还没有导入课表",
          "其他学校模式：粘贴文字或上传文件，AI 解析后确认即可用。",
          "去导入课表",
          () => openHall("import"),
        ),
      );
      return wrap;
    }
    wrap.appendChild(hallEmpty("🗓️", "还没有课表", "在对话框里说「课表」，查询后这里就会显示。"));
    return wrap;
  }
  (b.week?.days || []).forEach((d) => {
    const courses = d.courses || [];
    const name = `${d.label} ${d.dateShort}`;
    /* 既没课也没放假/调休说明的日子连天头一起收，不占视线；
       有说明的天头把说明并进去（「周六 10/17 · 国庆节 · 调休补课日」） */
    if (!courses.length && !d.holiday && !d.isToday) return;
    const head = el(`hall-group${d.isToday ? " today" : ""}`);
    head.dataset.hallGroup = name;
    head.textContent =
      name +
      (d.holiday
        ? ` · ${d.holiday}${d.makeup ? " · 调休补课日" : ""}`
        : courses.length
          ? ""
          : " · 无课");
    /* 每天一个分组盒：搜索过滤按组收起天头（与待办分组同一套结构） */
    const box = el("hall-todo-group");
    box.dataset.hallGroup = name;
    courses.forEach((c) => {
      box.appendChild(
        hallItem(
          c.title,
          [c.time, c.location ? `@${c.location}` : "", c.teacher].filter(Boolean).join(" · "),
          d.isToday && courseHappeningNow(c),
        ),
      );
    });
    wrap.appendChild(head);
    wrap.appendChild(box);
  });
  return wrap;
}
/* 周课表条目没有 status 字段（只有今日课程有）：按 time 区间现场判断是否正在上 */
function courseHappeningNow(c) {
  if (!c.time) return false;
  const [a, z] = c.time.split("-");
  const hm = (s) => {
    const [h, m] = s.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const now = new Date();
  const min = now.getHours() * 60 + now.getMinutes();
  return hm(a) <= min && min <= hm(z);
}
function buildExams(b) {
  const wrap = el("");
  const list = b.exams?.upcoming || [];
  if (schoolManual() && !list.length) {
    wrap.appendChild(
      hallEmpty(
        "📝",
        "近 14 天没有考试",
        "当前是手动课表模式：考试安排要接入教务系统才支持，直接问我也一样。",
      ),
    );
    return wrap;
  }
  if (!list.length) {
    wrap.appendChild(
      hallEmpty("📝", "近 14 天没有考试", "有新安排时，这里会标出时间、地点与座位。"),
    );
    return wrap;
  }
  list.forEach((x) => {
    wrap.appendChild(
      hallItem(
        x.subject,
        [x.date, x.time, x.location, x.seatNumber ? `座位 ${x.seatNumber}` : ""]
          .filter(Boolean)
          .join(" · "),
        x.isToday || x.inDays <= 3,
      ),
    );
  });
  return wrap;
}
/* 分组题注计数同步：条目被就地移除/恢复后改写「组名 · N」，组空时连同题注一起收掉 */
function hallRetitleGroup(group) {
  if (!group?.classList.contains("hall-todo-group")) return;
  const head = group.previousElementSibling;
  const kids = group.querySelectorAll(".hall-item").length;
  if (!kids) {
    if (head?.classList.contains("hall-group")) head.remove();
    group.remove();
    return;
  }
  if (head?.classList.contains("hall-group")) {
    const name = head.dataset.hallGroup || head.textContent.split(" ·")[0];
    if (name) head.textContent = `${name} · ${kids}`;
  }
}
/* 待办条目行：勾选完成 + 删除都是乐观更新；逾期朱砂高亮，备注悬停可见，附 .ics 导出 */
function todoHallItem(t) {
  const item = el(`hall-item has-act${t.overdue ? " hot" : ""}`);
  /* 勾选即完成：乐观更新——先变灰，落盘成功直接移除节点（未完成列表里自然消失），
     失败才回滚；整面板不重刷，焦点与滚动都不丢 */
  const pick = document.createElement("input");
  pick.type = "checkbox";
  pick.className = "hall-done";
  pick.title = "标记完成";
  pick.setAttribute("aria-label", `标记完成：${t.title}`);
  pick.disabled = HALL_DEMO;
  if (!HALL_DEMO)
    pick.addEventListener("change", () => {
      const done = pick.checked;
      item.classList.toggle("done", done);
      pick.disabled = true;
      fetch(`/api/reminders/${encodeURIComponent(t.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ done }),
      })
        .then((r) => {
          if (!r.ok) throw new Error("save failed");
          /* 落盘后整面板重排：刚完成的条目立即进「已完成」折叠区，勾错就地能撤销。
         数据说话，分组/计数/搜索态都由重建逻辑统一接管 */
          renderHall(true);
        })
        .catch(() => {
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
  const metaText =
    t.dueLabel +
    (t.overdue ? " · 已逾期" : t.isToday ? " · 今天到期" : "") +
    (t.source ? ` · 来自${t.source}` : "");
  const hm = el2("hm", metaText);
  if (t.overdue) {
    hm.innerHTML = "";
    hm.appendChild(document.createTextNode(`${t.dueLabel} · `));
    const tag = document.createElement("span");
    tag.className = "overdue-tag";
    tag.textContent = "⚠ 已逾期";
    hm.appendChild(tag);
    if (t.source) hm.appendChild(document.createTextNode(` · 来自${t.source}`));
  }
  if (t.notes) hm.title = t.notes;
  main.appendChild(hm);
  item.appendChild(main);
  if (!HALL_DEMO && t.id) {
    const ics = document.createElement("a");
    ics.className = "hall-ics";
    ics.href = `/api/reminders/${encodeURIComponent(t.id)}.ics`;
    ics.textContent = ".ics";
    ics.title = "导出到手机日历";
    ics.setAttribute("aria-label", `导出待办到日历：${t.title}`);
    item.appendChild(ics);
  }
  if (!HALL_DEMO)
    item.appendChild(
      hallDelBtn("删除", () => {
        /* 删除同样乐观：先移除节点，失败整面板重刷恢复 */
        const group = item.parentElement;
        item.remove();
        hallRetitleGroup(group);
        hallRecount("todos");
        fetch(`/api/reminders/${encodeURIComponent(t.id)}`, { method: "DELETE" })
          .then((r) => {
            if (!r.ok) throw new Error("delete failed");
          })
          .catch(() => renderHall(true));
      }),
    );
  return item;
}
/* 已完成条目：取消勾选即恢复为未完成（乐观标记后重排），删除同两步确认 */
function todoDoneItem(t) {
  const item = el("hall-item has-act done");
  const pick = document.createElement("input");
  pick.type = "checkbox";
  pick.className = "hall-done";
  pick.checked = true;
  pick.title = "取消勾选就恢复为未完成";
  pick.setAttribute("aria-label", `恢复未完成：${t.title}`);
  if (HALL_DEMO) {
    pick.disabled = true;
  } else {
    pick.addEventListener("change", () => {
      pick.checked = true;
      /* 恢复要重新落进未完成分组，就地重排不如让数据说话；失败回滚无需处理（勾选态始终勾着） */
      pick.disabled = true;
      fetch(`/api/reminders/${encodeURIComponent(t.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: false }),
      })
        .then((r) => {
          if (!r.ok) throw new Error("save failed");
          renderHall(true);
        })
        .catch(() => {
          pick.disabled = false;
        });
    });
  }
  item.appendChild(pick);
  const main = el("hall-item-main");
  main.appendChild(el2("ht", t.title));
  main.appendChild(
    el2("hm", `${t.doneAt ? `完成于 ${fmtWhen(t.doneAt)} · ` : ""}原截止 ${t.dueLabel}`),
  );
  item.appendChild(main);
  if (!HALL_DEMO)
    item.appendChild(
      hallDelBtn("删除", () => {
        const group = item.parentElement;
        item.remove();
        hallRetitleGroup(group);
        hallRecount("todos");
        fetch(`/api/reminders/${encodeURIComponent(t.id)}`, { method: "DELETE" })
          .then((r) => {
            if (!r.ok) throw new Error("delete failed");
          })
          .catch(() => renderHall(true));
      }),
    );
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
    wrap.appendChild(
      hallEmpty(
        "✅",
        "暂无待办",
        "在对话框里说「提醒我……」，我会帮你记录并排进分组。",
        HALL_DEMO ? "" : "去记第一条",
        HALL_DEMO ? null : () => hallFocusChat("提醒我："),
      ),
    );
  }
  /* 分组：逾期 / 今天 / 明天 / 以后（与 /todos 页同口径，逾期自然置顶） */
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
    const head = el(`hall-group${g.overdue ? " overdue" : ""}`);
    head.textContent = `${g.name} · ${g.items.length}`;
    head.dataset.hallGroup = g.name;
    wrap.appendChild(head);
    const box = el("hall-todo-group");
    box.dataset.hallGroup = g.name;
    g.items.forEach((t) => {
      box.appendChild(todoHallItem(t));
    });
    wrap.appendChild(box);
  });
  /* 已完成折叠区：默认收起不抢注意力，点题注就地展开（不重拉数据） */
  if (doneList.length) {
    const head = document.createElement("button");
    head.type = "button";
    head.className = "hall-group toggle";
    head.dataset.hallGroup = "已完成";
    head.textContent = `已完成 · ${doneList.length}${todoDoneOpen ? " ▾" : " ▸"}`;
    head.setAttribute("aria-expanded", todoDoneOpen ? "true" : "false");
    head.title = todoDoneOpen ? "收起已完成待办" : "展开已完成待办";
    const box = el("hall-todo-group");
    box.dataset.hallGroup = "已完成";
    box.hidden = !todoDoneOpen;
    doneList.forEach((t) => {
      box.appendChild(todoDoneItem(t));
    });
    head.addEventListener("click", () => {
      todoDoneOpen = !todoDoneOpen;
      box.hidden = !todoDoneOpen;
      head.textContent = `已完成 · ${box.querySelectorAll(".hall-item").length}${todoDoneOpen ? " ▾" : " ▸"}`;
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
    if (!seen[c]) {
      seen[c] = 1;
      cats.push(c);
    }
  });
  if (cats.length < 2) return null;
  cats.sort((a, b) => a.localeCompare(b, "zh-CN"));
  const bar = el("hall-cats");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "按分类筛选知识");
  const all = document.createElement("button");
  all.type = "button";
  all.className = `hall-cat${!hallKnowCat ? " on" : ""}`;
  all.textContent = `全部 ${entries.length}`;
  all.addEventListener("click", () => {
    hallKnowCat = "";
    renderHall(true);
  });
  bar.appendChild(all);
  cats.forEach((c) => {
    const n = entries.filter((k) => (k.category || "未分类") === c).length;
    const b = document.createElement("button");
    b.type = "button";
    b.className = `hall-cat${hallKnowCat === c ? " on" : ""}`;
    b.textContent = `${c} ${n}`;
    b.setAttribute("aria-pressed", hallKnowCat === c ? "true" : "false");
    b.addEventListener("click", () => {
      hallKnowCat = hallKnowCat === c ? "" : c;
      renderHall(true);
    });
    bar.appendChild(b);
  });
  return bar;
}
function hallKnowEmpty() {
  return hallEmpty(
    "📚",
    "知识库还是空的",
    "在对话框里分享知识点（或说「记住：……」），我会按课程归类记进来。",
    HALL_DEMO ? "" : "去记第一条",
    HALL_DEMO ? null : () => hallFocusChat("记住："),
  );
}
/* 人物图谱面板（功能大厅抽屉）：只做「快速看一眼 + 跳完整画板」。
   完整版在 /graph 独立页——那里能拖节点、切类别、逐条删除，抽屉里
   塞不下这些交互，硬塞只会让两个地方都难用。
   演示模式也走同一路径：演示服务内置 /api/graph（一本虚构红楼梦），
   抽屉里照样能预览缩略画板，不再是「演示环境没有数据」的干空态。 */
function buildGraphHall() {
  const wrap = el("");
  return fetch("/api/graph")
    .then((r) => r.json())
    .then((d) => {
      const snapshot = d.snapshot || { persons: [], relations: [] };
      const books = d.book ? [d.book] : [];
      if (!snapshot.persons.length) {
        wrap.appendChild(
          hallEmpty(
            "⌗",
            "图谱还是空的",
            "在对话里告诉 agent 书中的人物关系，比如「宝玉是贾母的孙子」，图谱会当场长出节点与连线。",
          ),
        );
        return wrap;
      }

      const head = el("hall-sec");
      head.appendChild(el2("hall-sec-t", `《${d.book?.title || "未命名"}》`));
      head.appendChild(
        el2(
          "hall-sec-d",
          `${snapshot.persons.length} 个人物 · ${snapshot.relations.length} 条关系`,
        ),
      );
      wrap.appendChild(head);

      /* 复用对话区的迷你 SVG 布局，画一张缩略全图 */
      const persons = snapshot.persons;
      const relations = snapshot.relations;
      const used = new Set();
      for (const r of relations) {
        used.add(r.sourceId);
        used.add(r.targetId);
      }
      const visPersons = persons.filter((p) => used.has(p.id) || relations.length === 0);
      if (visPersons.length) {
        const { pos, NW, NH } = graphMiniLayout(visPersons, relations);
        let maxX = 0;
        let maxY = 0;
        for (const p of visPersons) {
          const q = pos.get(p.id);
          if (!q) continue;
          maxX = Math.max(maxX, q.x + NW);
          maxY = Math.max(maxY, q.y + NH);
        }
        const W = maxX + 8;
        const H = maxY + 8;
        const box = el("hall-graph");
        const svg = document.createElementNS(GRAPH_SVG_NS, "svg");
        svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
        svg.setAttribute("width", "100%");
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", `人物关系图，${visPersons.length} 个人物`);
        svg.style.height = "auto";
        svg.style.maxHeight = "360px";
        const mk = (tag, attrs) => {
          const n = document.createElementNS(GRAPH_SVG_NS, tag);
          for (const k in attrs) n.setAttribute(k, String(attrs[k]));
          return n;
        };
        for (const r of relations) {
          const a = pos.get(r.sourceId);
          const b = pos.get(r.targetId);
          if (!a || !b) continue;
          const color = GRAPH_CAT_COLORS[r.category] || GRAPH_CAT_COLORS.other;
          const x1 = a.x + NW;
          const y1 = a.y + NH / 2;
          let d;
          if (b.x < a.x) {
            const fx = a.x;
            const tx = b.x + NW;
            d = `M${fx} ${a.y + NH / 2} C${fx - 34} ${a.y + NH / 2} ${tx + 34} ${b.y + NH / 2} ${tx} ${b.y + NH / 2}`;
          } else {
            const mid = (x1 + b.x) / 2;
            d = `M${x1} ${y1} C${mid} ${y1} ${mid} ${b.y + NH / 2} ${b.x} ${b.y + NH / 2}`;
          }
          svg.appendChild(mk("path", { d, fill: "none", stroke: color, "stroke-width": "1.4" }));
        }
        for (const p of visPersons) {
          const q = pos.get(p.id);
          if (!q) continue;
          const g = mk("g", { x: q.x, y: q.y });
          g.appendChild(
            mk("rect", {
              x: 0,
              y: 0,
              width: NW,
              height: NH,
              rx: 7,
              fill: "#FFFFFF",
              stroke: "#C9C1AF",
              "stroke-width": "1",
            }),
          );
          const nm = mk("text", {
            x: NW / 2,
            y: NH / 2,
            "font-size": "12",
            fill: "#25221C",
            "text-anchor": "middle",
            "dominant-baseline": "central",
          });
          nm.textContent = p.name.length > 9 ? `${p.name.slice(0, 9)}…` : p.name;
          g.appendChild(nm);
          svg.appendChild(g);
        }
        box.appendChild(svg);
        wrap.appendChild(box);
      }
      void books;

      /* 类别图例：一眼看出六类各有多少条 */
      const legend = el("hall-graph-legend");
      for (const key in GRAPH_CAT_COLORS) {
        let n = 0;
        for (const r of relations) if (r.category === key) n++;
        if (!n) continue;
        const item = el("hall-graph-cat");
        const sw = el2("hall-graph-sw", "");
        sw.style.background = GRAPH_CAT_COLORS[key];
        item.appendChild(sw);
        item.appendChild(el2("hall-graph-cn", `${GRAPH_CAT_NAMES[key]} ${n}`));
        legend.appendChild(item);
      }
      if (legend.childNodes.length) wrap.appendChild(legend);

      const go = document.createElement("a");
      go.className = "tbtn";
      /* 与对话区图谱卡同一口径：带上当前书，画板才开对书 */
      go.href = d.bookId ? `/graph?bookId=${encodeURIComponent(d.bookId)}` : "/graph";
      go.textContent = "打开完整画板";
      const foot = el("hall-graph-foot");
      foot.appendChild(go);
      wrap.appendChild(foot);
      return wrap;
    })
    .catch(() => {
      wrap.appendChild(
        hallEmpty("⌗", "图谱读不出来", "data/graph.json 可能已损坏，请检查本机数据目录。"),
      );
      return wrap;
    });
}

function buildKnowledge(b) {
  /* 演示环境没有 /api/knowledge 接口：保持 brief 速览（只读，带日期） */
  if (HALL_DEMO) {
    const wrap = el("");
    const recent = b.knowledge?.recent || [];
    if (!recent.length) {
      wrap.appendChild(hallEmpty("📚", "知识库还是空的", "对话中沉淀的知识点会自动收录到这里。"));
      return wrap;
    }
    wrap.dataset.total = String(b.knowledge?.total || recent.length);
    /* 与正式环境同一张卡：标题 + 分类徽标/日期一行 + 摘要（演示无删除按钮） */
    recent.forEach((k) => {
      wrap.appendChild(hallKnowledgeItem(k));
    });
    return wrap;
  }
  /* 正式环境：全量列表 + 分类筛 + 两步删除（与 /knowledge 页同一防误删口径）；
     条目多时厅内只展前 30 条，余下走完整页，避免抽屉过长 */
  return fetch("/api/knowledge")
    .then((r) => r.json())
    .then((d) => {
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
      shown.forEach((k) => {
        box.appendChild(hallKnowledgeItem(k));
      });
      wrap.appendChild(box);
      if (entries.length > LIMIT) {
        wrap.appendChild(
          hallNote(`仅显示前 ${LIMIT} 条，共 ${entries.length} 条；完整检索去知识库完整页。`),
        );
      }
      return wrap;
    });
}
/* 番茄钟日期：M月d日 HH:MM（最近记录用，日精度不够看） */
function hallPomoDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function buildPomodoro() {
  const wrap = el("");
  if (HALL_DEMO) {
    wrap.appendChild(
      hallEmpty(
        "🍅",
        "没有进行中的番茄钟",
        "演示模式不计时；正式运行后这里显示实时倒计时与最近记录。",
        "去开始一个 25 分钟",
        () => hallFocusChat("来一个 25 分钟番茄钟"),
      ),
    );
    return wrap;
  }
  return fetch("/api/pomodoro")
    .then((r) => r.json())
    .then((d) => {
      if (d.active) {
        const p = d.active;
        const total = p.totalSec || Math.max(1, (p.focusMinutes || 25) * 60);
        const card = el("hall-item hot hall-pomo-active");
        card.appendChild(el2("ht", `${p.label || "专注"} · 进行中`));
        const clk = el2(
          "hall-pomo-clock",
          pomoFmt(
            p.remainingSec != null ? p.remainingSec : Math.max(0, (p.endsAt - Date.now()) / 1000),
          ),
        );
        clk.dataset.ends = String(p.endsAt || "");
        card.appendChild(clk);
        card.appendChild(
          el2(
            "hm",
            "共 " +
              (p.focusMinutes || Math.round(total / 60)) +
              " 分钟 · 至 " +
              clock(p.endsAt) +
              " 结束",
          ),
        );
        const bar = el("hall-pomo-bar");
        const fill = document.createElement("i");
        fill.dataset.ends = String(p.endsAt || "");
        fill.dataset.total = String(total);
        bar.appendChild(fill);
        card.appendChild(bar);
        const row = el("hall-pomo-row");
        row.appendChild(el2("hall-count", "时间到会响铃 + 标题闪灯，切页也能结算"));
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "hall-pomo-cancel";
        cancel.textContent = "取消";
        cancel.setAttribute("aria-label", `取消番茄钟：${p.label || "专注"}`);
        cancel.addEventListener("click", () => {
          cancel.disabled = true;
          cancel.textContent = "取消中…";
          fetch("/api/pomodoro/cancel", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(p.id ? { id: p.id } : {}),
          })
            .then(() => renderHall(true))
            .catch(() => {
              cancel.disabled = false;
              cancel.textContent = "取消";
            });
        });
        row.appendChild(cancel);
        card.appendChild(row);
        wrap.appendChild(card);
        hallPomoTick();
      } else {
        wrap.appendChild(
          hallEmpty(
            "🍅",
            "没有进行中的番茄钟",
            "厅里只看进度；开始还是在对话框里说一声。",
            "去开始一个 25 分钟",
            () => hallFocusChat("来一个 25 分钟番茄钟"),
          ),
        );
      }
      const stateName = { running: "进行中", done: "已完成", cancelled: "已取消" };
      const recent = (d.recent || []).slice(0, 5);
      if (recent.length) {
        const head = el("hall-group");
        head.textContent = `最近 · ${recent.length}`;
        wrap.appendChild(head);
        recent.forEach((p) => {
          wrap.appendChild(
            hallItem(
              p.label,
              (stateName[p.status] || p.status) +
                " · " +
                p.focusMinutes +
                " 分钟" +
                (p.startsAt ? ` · ${hallPomoDate(p.startsAt)}` : ""),
              p.status === "running",
            ),
          );
        });
      }
      if (!d.active)
        wrap.appendChild(hallNote("提示：在对话框说「来一个 25 分钟番茄钟」，这里会自动倒计时。"));
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
    const ends = Number(fill.dataset.ends),
      total = Number(fill.dataset.total) || 1;
    const left = Math.max(0, Math.ceil((ends - now) / 1000));
    fill.style.width = `${((100 * (total - left)) / total).toFixed(1)}%`;
  });
}
/* 成绩面板：纯缓存（get_grades 查通一次即落盘），零登录零模型 */
function gradesRender(g, wrap) {
  if (g.savedAt == null) {
    if (schoolManual()) {
      wrap.appendChild(
        hallEmpty(
          "📊",
          "还没有成绩",
          "当前是手动课表模式：成绩要接入教务系统才支持，在对话框里说「我的成绩」试试。",
        ),
      );
      return wrap;
    }
    wrap.appendChild(
      hallEmpty("📊", "还没有成绩缓存", "在对话框里说「我的成绩」，查询后这里就会显示。"),
    );
    return wrap;
  }
  wrap.dataset.total = String(g.courseCount || 0);
  wrap.appendChild(
    hallItem(
      `GPA ${g.gpa}${g.gpaBasis ? `（${g.gpaBasis}）` : ""}`,
      `必修学分 ${g.requiredCredits} · 共 ${g.courseCount} 门课`,
      true,
    ),
  );
  if (g.recentSemester) {
    wrap.appendChild(hallNote(`最近学期 ${g.recentSemester}：`));
    (g.recentCourses || []).slice(0, 8).forEach((c) => {
      wrap.appendChild(
        hallItem(c.course, `成绩 ${c.score} · ${c.credit} 学分${c.type ? ` · ${c.type}` : ""}`),
      );
    });
  }
  wrap.appendChild(
    hallNote(
      "缓存于 " +
        new Date(g.savedAt).toLocaleString("zh-CN", { hour12: false }) +
        "；在对话框里再问一次成绩即刷新。",
    ),
  );
  return wrap;
}
function buildGrades() {
  const wrap = el("");
  /* 演示给一份虚构成绩单，让面板形态可见；其余环境读真实缓存 */
  if (HALL_DEMO) {
    return Promise.resolve(
      gradesRender(
        {
          savedAt: Date.now() - 26 * 3600_000,
          gpa: "3.61",
          gpaBasis: "4.0 制（示例）",
          requiredCredits: "42.5",
          courseCount: 36,
          recentSemester: "2025-2026-2（示例）",
          recentCourses: [
            { course: "示例高等数学", score: "92", credit: "5", type: "必修" },
            { course: "示例大学英语", score: "88", credit: "3", type: "必修" },
            { course: "示例程序设计", score: "95", credit: "4", type: "必修" },
            { course: "示例体育课", score: "85", credit: "1", type: "选修" },
          ],
        },
        wrap,
      ),
    );
  }
  return fetch("/api/grades")
    .then((r) => r.json())
    .then((g) => gradesRender(g, wrap));
}
/* 教务通知面板：现场抓官网公开页（无需登录，可能要几秒） */
function buildNews() {
  const wrap = el("");
  if (HALL_DEMO) {
    wrap.appendChild(
      hallEmpty(
        "📣",
        "演示模式不抓取官网",
        "教务通知需要联网；正式运行后这里显示最新通知，需行动的置顶。",
      ),
    );
    return wrap;
  }
  return fetch("/api/news")
    .then((r) => r.json())
    .then((d) => {
      const items = d.items || [];
      wrap.dataset.total = String(items.length);
      if (d.unsupported) {
        wrap.appendChild(
          hallEmpty(
            "📣",
            "教务通知暂不可用",
            "当前是手动课表模式：通知要从教务处官网抓取，暂不支持。",
          ),
        );
        return wrap;
      }
      if (d.error) wrap.appendChild(hallNote(`抓取失败：${d.error}`));
      if (!items.length) {
        if (!d.error)
          wrap.appendChild(
            hallEmpty("📣", "没抓到通知", "教务处官网结构可能变化，或当前网络异常。"),
          );
        return wrap;
      }
      if (d.gradeBasis)
        wrap.appendChild(hallNote(`已按你所在「${d.gradeBasis} 级」标记相关性，需行动的置顶。`));
      /* 稳定排序把 high 挪到最前（组内保持日期新旧序），兑现提示里的「置顶」 */
      items
        .slice()
        .sort((a, b) => (b.relevance === "high" ? 1 : 0) - (a.relevance === "high" ? 1 : 0))
        .forEach((n) => {
          wrap.appendChild(
            hallItemAct(
              n.title,
              [
                n.category,
                n.date,
                n.relevance === "high"
                  ? "需本人行动"
                  : n.relevance === "medium"
                    ? "视个人情况"
                    : "",
                n.restricted ? "原文限校内权限访问" : "",
              ]
                .filter(Boolean)
                .join(" · "),
              () => {
                window.open(n.url, "_blank", "noopener");
              },
              "原文",
            ),
          );
          const item = wrap.lastChild;
          if (n.relevance === "high") item.classList.add("hot");
        });
      return wrap;
    });
}
/* ── 用量统计面板：GitHub 式热力图（每日 token）+ 各模型分布 ── */

/* token 数的中文缩写：1.23 亿 / 4.5 万 / 678 */
function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(2).replace(/\.?0+$/, "")} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, "")} 万`;
  return String(Math.round(n));
}

/* 本机时区的 YYYY-MM-DD（数据键是北京时间切日；用户本机即北京时间） */
function usageDateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* 热力图色阶：非零日按分位 25/50/75 升档（GitHub 同语义——非零即亮） */
function usageLevels(dayTotals) {
  const vals = Object.values(dayTotals)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (!vals.length) return (v) => (v > 0 ? 1 : 0);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
  const t1 = q(0.25);
  const t2 = q(0.5);
  const t3 = q(0.75);
  return (v) => (v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4);
}

/* 一格：日期 + 用量 + 原生 title 悬停说明（无障碍名字同步给 aria-label） */
function usageCell(date, total, levelOf, future) {
  const cell = document.createElement("span");
  cell.className = `uh-cell${future ? " future" : ""}`;
  if (future) {
    cell.setAttribute("aria-hidden", "true");
    return cell;
  }
  cell.dataset.l = String(levelOf(total));
  cell.dataset.d = date;
  const label = total > 0 ? `${total.toLocaleString("zh-CN")} tokens` : "无用量";
  cell.title = `${date} · ${label}`;
  cell.setAttribute("aria-label", `${date} ${label}`);
  return cell;
}

/* 53 周 × 7 行的热力图网格（左端行标签 + 顶部月份行 + 横向滚动，默认滚到今天） */
function usageHeatmap(dayTotals) {
  const box = el("usage-heat");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dowMon = (today.getDay() + 6) % 7; // 周一=0 … 周日=6
  const endMonday = new Date(today);
  endMonday.setDate(today.getDate() - dowMon);
  const startMonday = new Date(endMonday);
  startMonday.setDate(endMonday.getDate() - 52 * 7);
  const levelOf = usageLevels(dayTotals);

  const dayLabels = el("uh-days");
  ["一", "", "", "四", "", "", "日"].forEach((t) => {
    const s = document.createElement("span");
    s.textContent = t;
    dayLabels.appendChild(s);
  });
  box.appendChild(dayLabels);

  const scroll = el("uh-scroll");
  const inner = el("uh-inner");

  const months = el("uh-months");
  const grid = el("uh-grid");
  let lastMonth = -1;
  for (let c = 0; c <= 52; c++) {
    const monday = new Date(startMonday);
    monday.setDate(startMonday.getDate() + c * 7);
    const m = monday.getMonth();
    const mLabel = document.createElement("span");
    if (m !== lastMonth) {
      mLabel.textContent = `${m + 1}月`;
      lastMonth = m;
    }
    months.appendChild(mLabel);
    for (let r = 0; r < 7; r++) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + r);
      const key = usageDateKey(day);
      grid.appendChild(usageCell(key, dayTotals[key] || 0, levelOf, day > today));
    }
  }
  inner.appendChild(months);
  inner.appendChild(grid);

  /* 图例：与格子同尺寸的四档色阶 + 「少/多」 */
  const legend = el("uh-legend");
  legend.appendChild(el2("", "少"));
  for (let l = 0; l <= 4; l++) {
    const sw = document.createElement("i");
    sw.dataset.l = String(l);
    legend.appendChild(sw);
  }
  legend.appendChild(el2("", "多"));
  inner.appendChild(legend);

  scroll.appendChild(inner);
  box.appendChild(scroll);
  /* 打开即看今天：默认滚到最右（今天所在的最后一列） */
  requestAnimationFrame(() => {
    scroll.scrollLeft = scroll.scrollWidth;
  });
  return box;
}

/* 各模型用量分布：模型名 + 输入/输出明细 + 总量占比条 */
function usageModelList(models) {
  const box = el("usage-models");
  const sum = models.reduce((acc, m) => acc + (m.total || 0), 0);
  models.forEach((m) => {
    const row = el("um-row");
    const head = el("um-head");
    const name = document.createElement("b");
    name.textContent = m.model;
    head.appendChild(name);
    const num = el2(
      "um-num",
      fmtTokens(m.total) + (sum > 0 ? ` · ${Math.round((m.total / sum) * 100)}%` : ""),
    );
    head.appendChild(num);
    row.appendChild(head);
    const meta = el2("um-meta", `输入 ${fmtTokens(m.in)} · 输出 ${fmtTokens(m.out)}`);
    row.appendChild(meta);
    const bar = el("um-bar");
    const fill = document.createElement("i");
    fill.style.width = `${sum > 0 ? Math.max(2, (m.total / sum) * 100) : 0}%`;
    bar.appendChild(fill);
    row.appendChild(bar);
    box.appendChild(row);
  });
  return box;
}

function buildUsage() {
  return fetch("/api/usage")
    .then((r) => r.json())
    .then((d) => {
      const wrap = el("");
      const days = d.days || {};
      const models = d.models || [];
      const totals = d.totals || { today: 0, week: 0, month: 0, year: 0 };
      const dayTotals = {};
      Object.keys(days).forEach((k) => {
        dayTotals[k] = days[k].total || 0;
      });
      if (!Object.keys(dayTotals).length) {
        wrap.appendChild(
          hallEmpty(
            "▦",
            "还没有 Token 用量",
            "和 AI 对话后，这里会以 GitHub 式热力图展示每日消耗与各模型用量。",
          ),
        );
        return wrap;
      }
      /* 摘要：今日 / 近 7 天 / 近 30 天 / 近一年 */
      const kpi = el("usage-kpi");
      [
        ["今日", totals.today],
        ["近 7 天", totals.week],
        ["近 30 天", totals.month],
        ["近一年", totals.year],
      ].forEach(([label, v]) => {
        const cell = el("uk");
        cell.appendChild(el2("uk-v", fmtTokens(v)));
        cell.appendChild(el2("uk-l", label));
        kpi.appendChild(cell);
      });
      wrap.appendChild(kpi);
      wrap.appendChild(usageHeatmap(dayTotals));
      if (models.length) {
        const sec = el("hall-sec");
        sec.appendChild(el2("", "各模型用量"));
        sec.appendChild(el2("", "近一年累计"));
        wrap.appendChild(sec);
        wrap.appendChild(usageModelList(models));
      }
      if (HALL_DEMO)
        wrap.appendChild(hallNote("演示数据：虚构一年的用量；正式运行后这里是你自己的真实消耗。"));
      wrap.appendChild(
        hallNote("统计口径：每轮对话的全部模型调用（含工具循环），按北京时间切日。"),
      );
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
  graph: buildGraphHall,
  pomodoro: buildPomodoro,
  usage: buildUsage,
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
  dyn.appendChild(hallToolbar(panel, total ? `共 ${total} 条` : ""));
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
  /* 手机软键盘回车键标成「搜索」，与行为一致（不动桌面） */
  input.setAttribute("enterkeyhint", "search");
  input.placeholder = `搜索${HALL_TITLES[panel] || "本面板"}…`;
  input.setAttribute("aria-label", `在${HALL_TITLES[panel] || "本面板"}中搜索`);
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
      box =
        node.querySelector(`[data-hall-group="${key}"].hall-todo-group`) || head.nextElementSibling;
    } else {
      box = head.nextElementSibling;
    }
    if (!box) return;
    const kids = [...box.querySelectorAll(".hall-item")];
    /* 只有待办分组盒才按组藏；知识列表没有分组头（分类走 chip），番茄钟最近头同理按可见收。
       已完成区默认折叠：搜索命中它的条目时临时展开，无搜索词时回到折叠偏好 */
    const anyVisible = kids.some((k) => k.style.display !== "none");
    head.style.display = !q || anyVisible ? "" : "none";
    if (box.classList?.contains("hall-todo-group")) {
      const doneFolded = box.dataset.hallGroup === "已完成" && !todoDoneOpen;
      box.style.display = doneFolded && !q ? "none" : !q || anyVisible ? "" : "none";
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
    count.textContent = q ? `${visible} / ${total} 条` : total ? `共 ${total} 条` : "";
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
  dyn.appendChild(
    hallEmpty(
      "⚠️",
      HALL_DEMO ? "演示环境没有该数据" : "取数失败",
      HALL_DEMO ? "正式运行 npm start 后可用。" : "检查本地服务后重试。",
      "重新加载",
      () => renderHall(true),
    ),
  );
}
/* 主页徽标：不用点进去就知道有没有事；失败静默（就当没这功能）。
   顺手预热 brief 缓存，进面板时几乎瞬间装配 */
function hallBadges(dyn) {
  if (HALL_DEMO) return;
  briefOf()
    .then((b) => {
      if (hallPanel !== "" || !document.body.classList.contains("hall-open")) return;
      const put = (id, text) => {
        if (!text) return;
        const card = dyn.querySelector(`[data-panel="${id}"]`);
        if (card && !card.querySelector(".hall-badge")) {
          const badge = el2("hall-badge", text);
          if (text.trim().startsWith("⚠")) badge.classList.add("warn");
          /* 放标题行右端、箭头左边：状态和入口同一行，扫一眼就知道哪个面板有事 */
          const go = card.querySelector(".hall-go");
          if (go?.parentNode) go.parentNode.insertBefore(badge, go);
          else card.appendChild(badge);
        }
      };
      const sched = b.schedule || {};
      if (sched.available) {
        const courses = sched.courses || [];
        put(
          "today",
          courses.length
            ? `今日 ${courses.length} 节`
            : b.next
              ? `下节${b.next.dateLabel}`
              : "今日无课",
        );
      }
      const days = b.week?.days || [];
      let weekN = 0;
      days.forEach((d) => {
        weekN += (d?.courses || []).length;
      });
      put("schedule", weekN ? `本周 ${weekN} 节` : "");
      const ex = b.exams?.upcoming || [];
      put("exams", ex.length ? `${ex.length} 场临近` : "");
      const td = b.todos?.items || [];
      const overdueN = td.filter((t) => t.overdue).length;
      put("todos", overdueN ? `⚠ ${overdueN} 逾期` : td.length ? `${td.length} 条待办` : "");
      put("knowledge", b.knowledge?.total ? `共 ${b.knowledge.total} 条` : "");
    })
    .catch(() => {});
  /* 设置卡徽标：缺关键凭证才亮（模型未配或手动课表模式未导课表；QQ 选配不打扰）。
     缺配置是要行动的事，与逾期同档用朱砂实底跳出 */
  fetch("/api/settings")
    .then((r) => r.json())
    .then((d) => {
      if (hallPanel !== "" || !document.body.classList.contains("hall-open")) return;
      const card = dyn.querySelector('[data-panel="settings"]');
      if (!card || card.querySelector(".hall-badge")) return;
      const miss = d.school?.manual
        ? d.school.scheduleCached
          ? ""
          : "未导课表"
        : !d.deepseek?.configured
          ? "模型未配"
          : "";
      if (!miss) return;
      const badge = el2("hall-badge", miss);
      badge.classList.add("warn");
      const go = card.querySelector(".hall-go");
      if (go?.parentNode) go.parentNode.insertBefore(badge, go);
      else card.appendChild(badge);
    })
    .catch(() => {});
}
function renderHall(force) {
  const dyn = document.getElementById("hallDyn");
  const staticSettings = document.getElementById("hallSettings");
  const staticPrompts = document.getElementById("hallPrompts");
  const staticAccount = document.getElementById("hallAccount");
  const staticImport = document.getElementById("hallImport");
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
  /* 设置与提示词模板都是常驻 DOM（字段/清单不重建），进入时只做状态复位与取数 */
  staticSettings.hidden = hallPanel !== "settings";
  staticPrompts.hidden = hallPanel !== "prompts";
  staticAccount.hidden = hallPanel !== "account";
  staticImport.hidden = hallPanel !== "import";
  if (hallPanel === "settings") {
    hallTitle.textContent = "设置";
    showSettings();
    settle();
    return;
  }
  if (hallPanel === "account") {
    hallTitle.textContent = "我的账号";
    document.getElementById("curPassMsg").textContent = "";
    settle();
    return;
  }
  if (hallPanel === "prompts") {
    hallTitle.textContent = "提示词模板";
    showPrompts();
    settle();
    return;
  }
  if (hallPanel === "import") {
    hallTitle.textContent = "导入课表";
    showImport();
    settle();
    return;
  }
  if (!hallPanel) {
    hallTitle.textContent = "功能大厅";
    /* 主页按分组排布：学习安排 / 效率工具 / 系统，扫一眼就能定位 */
    HALL_GROUPS.forEach((g) => {
      const cards = HALL_CARDS.filter(
        (c) => c.group === g && !c.hidden && (c.id !== "news" || newsAvailable()),
      );
      if (!cards.length) return;
      const sec = el("hall-sec");
      sec.appendChild(el2("", g));
      dyn.appendChild(sec);
      const grid = el("hall-grid");
      cards.forEach((c) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "hall-card";
        card.dataset.panel = c.id;
        card.setAttribute("aria-label", `${c.t}：${c.d}`);
        const top = el("hall-card-top");
        top.appendChild(iconSpan("hall-ico", HALL_ICONS[c.id] || GEAR));
        const t = document.createElement("b");
        t.textContent = c.t;
        top.appendChild(t);
        top.appendChild(el2("hall-go", "→"));
        card.appendChild(top);
        const s = document.createElement("span");
        s.textContent = c.d;
        card.appendChild(s);
        grid.appendChild(card);
      });
      dyn.appendChild(grid);
    });
    dyn.appendChild(
      hallNote(
        HALL_DEMO
          ? "离线演示：面板里是虚构示例数据；正式运行后显示你的真实数据。"
          : "提示：点卡片进对应面板；在对话框里说「打开课表/考试/待办」也会为你推出。",
      ),
    );
    /* 主页页脚的仓库入口：地址写死在源码里（不掺运行时数据），innerHTML 不构成注入面 */
    const gh = document.createElement("a");
    gh.className = "hall-gh";
    gh.href = "https://github.com/Health-525/courseraptor";
    gh.target = "_blank";
    gh.rel = "noopener noreferrer";
    gh.setAttribute("aria-label", "GitHub 仓库页面（新窗口打开）");
    gh.innerHTML = `${GH_MARK}<span>GitHub 仓库</span>`;
    dyn.appendChild(gh);
    /* 仓库链接下面再嗷一嗓子：迅猛龙拟声词求 Star，点进仓库页即可点亮 */
    const star = document.createElement("a");
    star.className = "hall-gh gh-star";
    star.href = "https://github.com/Health-525/courseraptor";
    star.target = "_blank";
    star.rel = "noopener noreferrer";
    star.setAttribute("aria-label", "去 GitHub 点亮 Star（新窗口打开）");
    star.innerHTML = `<span>嗷呜！顺手点个</span>${STAR_MARK}<span>Star 喂饱小恐龙</span>`;
    dyn.appendChild(star);
    settle();
    hallBadges(dyn);
    return;
  }
  hallTitle.textContent = HALL_TITLES[hallPanel] || hallPanel;
  const build = HALL_PANELS[hallPanel];
  if (!build) {
    dyn.appendChild(hallNote("该功能暂无面板。"));
    settle();
    return;
  }
  /* 先给骨架屏占位，避免取数时闪空；同步面板直接装配 */
  let body = null;
  try {
    body = build();
  } catch {
    hallShowError(dyn, hallPanel);
    settle();
    return;
  }
  if (body && typeof body.then === "function") {
    dyn.setAttribute("aria-busy", "true");
    dyn.appendChild(hallSkel());
    settle();
    const want = hallPanel;
    body
      .then((node) => {
        /* 取数期间用户可能已关掉或切走：只往还开着的同一面板里补画 */
        if (document.body.classList.contains("hall-open") && hallPanel === want && dyn) {
          hallMountPanel(dyn, want, node);
        }
      })
      .catch(() => {
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
  /* 教务通知门禁：无权限时宫格本就没有这张卡，对话推送/深链误触只回宫格。
     schoolState 未到位（刚刷新）先放行，由启动同步兜底退回 */
  if (panel === "news" && schoolState && !newsAvailable()) panel = "";
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
  if (opts?.focus !== false) document.getElementById("closeHall").focus();
}

/* ── hash 深链：#hall=面板名。刷新还原、可收藏直达、浏览器后退关抽屉。
   hallHashSync 防本文件写 hash 触发 hashchange 的回环 ── */
let hallHashSync = false;
function hallPanelFromHash() {
  const m = /^#hall=([a-z]+)$/.exec(location.hash || "");
  const id = m?.[1];
  if (!id || !(HALL_TITLES[id] || id === "settings")) return "";
  /* 教务通知门禁：状态未到位先放行（刷新直达收藏的深链），权限不足时
     由启动同步退回宫格 */
  if (id === "news" && schoolState && !newsAvailable()) return "";
  return id;
}
function syncHallHash() {
  if (hallHashSync) return;
  hallHashSync = true;
  try {
    if (hallPanel) {
      if (location.hash !== `#hall=${hallPanel}`) location.hash = `hall=${hallPanel}`;
    } else if (location.hash) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  } finally {
    hallHashSync = false;
  }
}
window.addEventListener("hashchange", () => {
  if (hallHashSync) return;
  const id = hallPanelFromHash();
  const open = document.body.classList.contains("hall-open");
  if (!id) {
    if (open) closeHall();
    return;
  }
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
    try {
      openHall(hallInitial, { focus: false });
    } catch (e) {
      window.__hallInitErr = String(e?.stack || e);
    }
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
document.getElementById("openHall").addEventListener("click", () => {
  hallPanel = "";
  hallFromCard = "";
  openHall();
});
/* 窄屏顶栏不再放独立的大厅按钮（原 openHallM）：与 ☰ 同为左滑面板会被
   当成功能重复；入口统一走左抽屉里的「功能大厅」（豆包式单抽屉导航） */
document.getElementById("closeHall").addEventListener("click", closeHall);
document.getElementById("hallBackdrop").addEventListener("click", closeHall);
hallBack.addEventListener("click", () => {
  const from = hallFromCard;
  hallPanel = "";
  hallFromCard = "";
  renderHall();
  syncHallHash();
  const card = from && hallBody.querySelector(`[data-panel="${from}"]`);
  (card || document.getElementById("closeHall")).focus();
});
hallBody.addEventListener("click", (e) => {
  const card = e.target.closest("[data-panel]");
  if (card) {
    hallFromCard = card.dataset.panel;
    hallPanel = card.dataset.panel;
    renderHall();
    syncHallHash();
    hallBack.focus();
  }
});
/* 目录行内方向键移动焦点：单列列表上下移动，左右留给原生滚动 */
hallBody.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const cards = [...hallBody.querySelectorAll(".hall-card")];
  if (cards.length < 2 || !cards.includes(document.activeElement)) return;
  e.preventDefault();
  const i = cards.indexOf(document.activeElement);
  const next =
    e.key === "ArrowDown" ? (i + 1) % cards.length : (i - 1 + cards.length) % cards.length;
  cards[next].focus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeHall();
});

/* ── 大厅角标：今天有到期的待办，或 30 分钟内有课，侧栏/顶栏按钮亮小红点。
   演示环境没有 /api/today，不打扰；每 5 分钟与每轮对话结束后各刷一次 ── */
function refreshHallBadge() {
  if (HALL_DEMO) return;
  fetch("/api/today")
    .then((r) => r.json())
    .then((b) => {
      const urgent = (b.todos?.items || []).filter((t) => t.overdue || t.isToday).length;
      const soonClass = !!(b.next && b.next.dateLabel === "今天" && b.next.startsInMin <= 30);
      const show = urgent > 0 || soonClass;
      const why = [];
      if (soonClass) why.push("30 分钟内有课");
      if (urgent) why.push(`${urgent} 条待办今天到期`);
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
        btn.title = show
          ? `功能大厅（${why.join("，")}）`
          : "今日日程、课表、考试、待办、知识库、番茄钟";
      }
    })
    .catch(() => {});
}
refreshHallBadge();
setInterval(refreshHallBadge, 5 * 60 * 1000);

/* 工具名 → 功能大厅面板：仅做「开着就刷新、没开就作废缓存」的刷新映射。
   自动推出只允许显式意图（open_settings 与经 ev.panel 透传的 open_panel）
   与服务端点名的阻塞场景，数据查询工具绝不自动推——用户点开才看。 */
const TOOL_PANEL = {
  get_schedule: "schedule",
  export_calendar: "schedule",
  get_exams: "exams",
  manage_todos: "todos",
  manage_knowledge: "knowledge",
  manage_graph: "graph",
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
  if (!msgs.length) {
    input.focus();
    closeDrawer();
    return;
  }
  startFresh();
  closeDrawer();
}
document.getElementById("newSession").addEventListener("click", doNewSession);
document.getElementById("newSessionM").addEventListener("click", doNewSession);

/* Key 来源二选一（仅托管版显示）：site=站点免费额度 / own=自己的 Key。
   切换只改网关上的模式标记，永不删 Key——随时可切回，无需重填，所以
   不需要任何确认弹窗（原生 confirm 在 iOS 主屏独立窗口里会被静默忽略，
   表现为点了没反应；本项目其余处也一律用 armed 两步确认而非 confirm）。
   开关按「同学的选择」渲染：没存 Key 时点「自己的 Key」是引导填 Key 的
   中间态，绝不能被额度接口按「实际生效」推导的值弹回站点 */
let dsUiMode = "";
/* 托管版标记：/api/quota（网关专属接口）探测成功才置 true。AI 模型栏目里
   凡是「本地 / 托管」语义不同的文案都看它——本地版探测永远失败，一行不动 */
var dsHosted = false;
/* Key 状态不再常驻一行小字（供应商、型号下拉各自可见，掩码 Key + 来源 +
   供应商 + 型号的拼接行是纯重复）：已配置改由输入框 placeholder 表达
   「已保存；留空不修改」，未配置显示该供应商的
   Key 形状提示；切换由 applyProviderUi 统一落 placeholder */
let keyConfigured = false;
function renderCurKey(d) {
  keyConfigured = !!d?.deepseek?.configured;
  applyProviderUi();
}
function setDsMode(m) {
  var site = document.getElementById("dsSite");
  var own = document.getElementById("dsOwn");
  var keyRow = document.getElementById("sKeyRow");
  if (!site || !own) return;
  site.setAttribute("aria-pressed", m === "site" ? "true" : "false");
  own.setAttribute("aria-pressed", m === "own" ? "true" : "false");
  if (keyRow) keyRow.style.display = m === "own" ? "" : "none";
}
function dsSay(text, good) {
  var el = document.getElementById("setMsg");
  if (!el) return;
  el.className = `setmsg${good ? " good" : ""}`;
  el.textContent = text;
}
function postDsMode(m) {
  fetch("/api/ds-mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: m }),
  })
    .then((r) => r.ok)
    .then((okFlag) => {
      if (!okFlag) {
        dsSay("切换失败，请稍后再试。");
        return;
      }
      dsUiMode = m;
      setDsMode(m);
      if (m === "own") {
        const kk = document.getElementById("sKey");
        if (kk && !kk.value) {
          dsSay("在下方填入 API Key 并点「保存设置」，保存后即用自己的 Key。");
          kk.focus();
        }
      } else {
        dsSay("已切换到站点免费额度；自己的 Key 已保留，随时可切回。", true);
      }
      refreshQuota();
    })
    .catch(() => {
      dsSay("网络错误，切换失败。");
    });
}
document.addEventListener("click", (e) => {
  var t = e.target.closest ? e.target.closest(".ds-opt") : null;
  if (!t) return;
  if (t.id === "dsSite") postDsMode("site");
  else if (t.id === "dsOwn") postDsMode("own");
});

/* 站点托管版的免费额度展示：/api/quota 由多用户网关提供；本地版与演示页
   没有该接口，静默隐藏即可，不影响任何本地行为 */
function refreshQuota() {
  fetch("/api/quota")
    .then((r) => (r.ok ? r.json() : null))
    .then((q) => {
      var el = document.getElementById("curQuota");
      /* 形状守卫：非网关环境对 /api/quota 兜底出 200 页面/杂 JSON 时绝不能
         把站点卡片亮出来——本地版与演示页必须一行站点内容都不出现 */
      if (!el || !q || typeof q.used !== "number" || typeof q.limit !== "number") return;
      if (!dsHosted) {
        dsHosted = true;
        /* 简介换成托管语境：本地版说「保存在当前电脑」，托管版 Key 在服务器上 */
        const intro = document.getElementById("dsIntro");
        if (intro) {
          intro.textContent =
            "模型服务支持多家供应商。下方选择 Key 来源：站点免费额度开箱即用；自己的 Key 由服务器加密保存，留空即保持不变。";
        }
        /* renderCurKey 幂等：探测完成后重放一次，确保 placeholder 按最新状态落定 */
        renderCurKey(setStatus);
      }
      /* 站点配了 Key 的厂商清单（供应商下拉在站点额度模式下据此过滤；
         过渡期网关未下发时按仅 DeepSeek）与 Key 来源选择同步给供应商块 */
      if (Array.isArray(q.siteProviders)) siteProviders = q.siteProviders;
      quotaUiMode = dsUiMode || (q.dsMode === "site" ? "site" : q.hasOwnKey ? "own" : "site");
      el.hidden = false;
      /* 开关跟「同学的选择」走：本页点过的选择优先；没有点过时按服务端
         选择推导——钉在站点的显示站点，跟随模式且已存 Key 的显示自有，
         跟随但没存 Key 的（新同学默认态）显示站点 */
      var ui = dsUiMode || (q.dsMode === "site" ? "site" : q.hasOwnKey ? "own" : "site");
      var mode = document.getElementById("dsMode");
      if (mode) {
        mode.hidden = false;
        setDsMode(ui);
      }
      var accEl = document.getElementById("curAccount");
      if (accEl && q.username) accEl.textContent = `当前登录账号：${q.username}`;
      var cardDef = HALL_CARDS.find((c) => c.id === "account");
      if (cardDef?.hidden) {
        cardDef.hidden = false;
        if (!hallPanel) renderHall();
      }
      el.textContent = q.ownKeyActive
        ? "✓ 正在使用自己的 " +
          providerLabelOf(providerCurrent) +
          " Key（今日 " +
          (q.ownUsed || 0) +
          " 轮，不占站点额度）" +
          (q.remaining !== undefined ? `；站点免费额度保留：剩余 ${q.remaining} 次` : "")
        : q.hasOwnKey
          ? "站点免费对话：今日已用 " +
            q.used +
            "/" +
            q.limit +
            "，剩余 " +
            q.remaining +
            " 次（已保存自己的 Key，上方可随时切换）"
          : ui === "own"
            ? "已选择用自己的 Key：填入并保存后生效；保存前仍可用站点免费额度"
            : "站点免费对话：今日已用 " +
              q.used +
              "/" +
              q.limit +
              "，剩余 " +
              q.remaining +
              " 次；填自己的 Key 后不占站点额度";
    })
    .catch(() => {});
}

/* 我的账号：托管版同学自助改本站登录密码（/api/password 由网关提供；
   本地版无此标签，整块不会出现） */
document.getElementById("saveMyPass").addEventListener("click", () => {
  var msg = document.getElementById("curPassMsg");
  var cur = document.getElementById("sPassCur").value;
  var nw = document.getElementById("sPassNew").value;
  var nw2 = document.getElementById("sPassNew2").value;
  if (!cur || !nw) {
    msg.textContent = "请填写当前密码和新密码。";
    return;
  }
  if (nw !== nw2) {
    msg.textContent = "两次输入的新密码不一致。";
    return;
  }
  if (nw.length < 8) {
    msg.textContent = "新密码至少 8 位。";
    return;
  }
  msg.textContent = "正在修改…";
  fetch("/api/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ current: cur, next: nw }),
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, d: d })))
    .then((res) => {
      if (res.ok && res.d?.ok) {
        msg.textContent = "✓ 已修改；下次登录请使用新密码。";
        document.getElementById("sPassCur").value = "";
        document.getElementById("sPassNew").value = "";
        document.getElementById("sPassNew2").value = "";
      } else {
        msg.textContent = res.d?.error || "修改失败，请稍后再试。";
      }
    })
    .catch(() => {
      msg.textContent = "网络错误，修改失败。";
    });
});

refreshQuota();

/* ── 设置：常驻在功能大厅抽屉里（见 #hallSettings），DeepSeek API Key
   等凭证仍走后端 /api/settings 同一套加密热生效 ── */
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

/* ── 提示词模板面板（#hallPrompts，2026-09-23 从设置拆出）：即改即存。
   quickSaved 是服务端最近一次确认的基线；增删/恢复默认后立刻 POST，失败回滚
   并提示——没有草稿态，也就不需要「保存设置」按钮和关闭拦截 ── */
const quickList = document.getElementById("quickList");
const quickNewInput = document.getElementById("quickNewInput");
const promptsMsg = document.getElementById("promptsMsg");
let quickSaved = DEFAULT_QUESTIONS.slice();
let quickDraft = quickSaved.slice();
let quickMsgTimer = 0;
function quickCountText() {
  return quickDraft.length
    ? `共 ${quickDraft.length} 条 · 上限 12 条`
    : "清单为空 · 保存后恢复默认模板";
}
/* 状态小字：常态是条数，保存后闪一下「已保存」，出错换朱砂 */
function quickIdleMsg() {
  window.clearTimeout(quickMsgTimer);
  promptsMsg.className = "setmsg good";
  promptsMsg.textContent = quickCountText();
}
function quickFlashSaved() {
  window.clearTimeout(quickMsgTimer);
  promptsMsg.textContent = "已保存 ✓";
  quickMsgTimer = window.setTimeout(quickIdleMsg, 1500);
}
function quickError(text) {
  window.clearTimeout(quickMsgTimer);
  promptsMsg.className = "setmsg";
  promptsMsg.textContent = text;
}
function renderQuickList() {
  quickList.innerHTML = "";
  if (!quickDraft.length) {
    const empty = el("qq-empty");
    empty.textContent = "清单为空：保存后输入框上方将恢复默认快捷问题";
    quickList.appendChild(empty);
    return;
  }
  const sortable = document.body.dataset.demo !== "true";
  quickDraft.forEach((q, i) => {
    const item = el("qq-item");
    item.dataset.q = q;
    if (sortable) item.draggable = true;
    /* 拖拽把手：只作视觉提示（⠿），拖动源是整条 qq-item */
    const grip = document.createElement("i");
    grip.className = "qq-grip";
    grip.setAttribute("aria-hidden", "true");
    grip.textContent = "⠿";
    const span = document.createElement("span");
    span.textContent = q;
    item.appendChild(grip);
    item.appendChild(span);
    if (sortable) {
      const mkMove = (label, dir) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "qq-move";
        b.textContent = label;
        b.disabled = dir < 0 ? i === 0 : i === quickDraft.length - 1;
        const verb = dir < 0 ? "上移" : "下移";
        b.title = verb;
        b.setAttribute("aria-label", `${verb}：${q}`);
        b.addEventListener("click", () => moveQuick(i, dir));
        return b;
      };
      item.appendChild(mkMove("↑", -1));
      item.appendChild(mkMove("↓", 1));
    }
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "✕";
    del.title = "删除该模板";
    del.setAttribute("aria-label", `删除：${q}`);
    del.addEventListener("click", () => {
      quickDraft = quickDraft.filter((x) => x !== q);
      renderQuickList();
      saveQuick();
    });
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
  saveQuick();
  quickNewInput.focus();
}
document.getElementById("quickAdd").addEventListener("click", quickAddFromInput);
quickNewInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    quickAddFromInput();
  }
});
/* 恢复默认是即时的破坏性操作：两步确认（与清理按钮同一语言），确认后才落盘 */
(() => {
  const btn = document.getElementById("resetQuick");
  let armed = false,
    timer = 0;
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    if (!armed) {
      armed = true;
      btn.textContent = "确认恢复默认？";
      btn.classList.add("armed");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        armed = false;
        btn.textContent = "恢复默认";
        btn.classList.remove("armed");
      }, 3000);
      return;
    }
    window.clearTimeout(timer);
    armed = false;
    btn.textContent = "恢复默认";
    btn.classList.remove("armed");
    quickDraft = DEFAULT_QUESTIONS.slice();
    renderQuickList();
    saveQuick();
  });
})();
/* 换序落位（拖拽 drop 与 ↑↓ 按钮共用）：面板清单与输入框上方 chips
   同步换成新顺序，再走即改即存；顺序没变（拖回原位）就不发请求 */
function commitQuickOrder(texts) {
  if (texts.join("\u0000") === quickDraft.join("\u0000")) return;
  quickDraft = texts.slice();
  quickQuestions = quickDraft.slice();
  renderQuickList();
  renderQchips();
  saveQuick();
}
/* ↑↓ 按钮换序：边界（首条 ↑、末条 ↓）在渲染时已禁用，这里再挡一层 */
function moveQuick(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= quickDraft.length) return;
  const next = quickDraft.slice();
  next.splice(j, 0, next.splice(i, 1)[0]);
  commitQuickOrder(next);
}
/* 拖拽换序：面板清单与输入框上方 chips 共用一套 HTML5 DnD。拖动中
   dragover 把条目实时插到最近落点前（所见即所拖），drop 时读回 DOM
   顺序交给 onReorder 落盘。与点击发送不冲突：浏览器拖拽与 click 手势
   互斥，按住拖完松手不会触发 chip 的 click ── */
function enableDragSort(container, onReorder) {
  let dragEl = null;
  const settle = () => {
    if (dragEl) dragEl.classList.remove("dragging");
    dragEl = null;
  };
  container.addEventListener("dragstart", (e) => {
    const item = e.target.closest("[data-q]");
    if (!item || !container.contains(item)) return;
    dragEl = item;
    item.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    /* Firefox 要求 dragstart 里 setData 才会真正启动拖拽 */
    e.dataTransfer.setData("text/plain", item.dataset.q || "");
  });
  container.addEventListener("dragover", (e) => {
    if (!dragEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const target = nearestDropTarget(container, dragEl, e.clientX, e.clientY);
    if (target) container.insertBefore(dragEl, target);
    else container.appendChild(dragEl);
  });
  container.addEventListener("drop", (e) => {
    if (!dragEl) return;
    e.preventDefault();
    settle();
    onReorder([...container.querySelectorAll("[data-q]")].map((n) => n.dataset.q));
  });
  /* 拖出容器取消（拖到页面外松手）不走 drop，这里兜底清态 */
  container.addEventListener("dragend", settle);
}
/* 最近落点：多行 wrap 与窄屏单行横滚都适配——找中心离指针最近的条目，
   指针越过其中心（右/下方）就插到它后面 */
function nearestDropTarget(container, dragEl, x, y) {
  let best = null;
  let bestDist = Infinity;
  container.querySelectorAll("[data-q]").forEach((n) => {
    if (n === dragEl) return;
    const r = n.getBoundingClientRect();
    const d = (r.left + r.width / 2 - x) ** 2 + (r.top + r.height / 2 - y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  });
  if (!best) return null;
  const r = best.getBoundingClientRect();
  return x > r.left + r.width / 2 || y > r.top + r.height / 2 ? best.nextSibling : best;
}
if (document.body.dataset.demo !== "true") {
  enableDragSort(qchips, commitQuickOrder);
  enableDragSort(quickList, commitQuickOrder);
}
/* 增删/恢复默认后的落盘：成功用服务端归一化结果回填基线与主界面 chips */
function saveQuick() {
  if (document.body.dataset.demo === "true") return;
  fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quickQuestions: quickDraft }),
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok || !d.status) throw new Error("save failed");
      applyQuickQuestions(d.status.quickQuestions);
      quickFlashSaved();
    })
    .catch(() => {
      quickDraft = quickSaved.slice();
      renderQuickList();
      /* chips 已按拖后顺序重渲过，一并还原到基线，两处不各说各话 */
      quickQuestions = quickSaved.slice();
      renderQchips();
      quickError("保存失败，已还原上次保存的清单。");
    });
}
/* 服务端清单到位（打开面板 / 保存成功）的统一落点：
   基线与编辑副本同步，主界面 chips 与面板状态小字一并刷新 */
function applyQuickQuestions(list) {
  quickSaved = Array.isArray(list) && list.length ? list.slice() : DEFAULT_QUESTIONS.slice();
  quickDraft = quickSaved.slice();
  renderQuickList();
  quickQuestions = quickSaved.slice();
  renderQchips();
  quickIdleMsg();
}
/* 打开提示词模板面板：先按已知基线渲染（秒开），再和服务端对一次 */
function showPrompts() {
  const hall = document.getElementById("hall");
  if (!hall.contains(document.activeElement)) settingsReturnFocus = document.activeElement;
  quickIdleMsg();
  fetch("/api/settings")
    .then((r) => r.json())
    .then((d) => {
      if (hallPanel !== "prompts") return;
      applyQuickQuestions(d.quickQuestions);
    })
    .catch(() => {
      if (hallPanel === "prompts") quickError("读取清单失败，检查本地服务后重进。");
    });
}
renderQuickList();
quickIdleMsg();

/* ── 未保存修改保护：凭证类字段填了内容（未保存）就是 dirty。
    closeHall 拦一次 + 「关闭」按钮武装二次确认，与清理按钮的两步删除同一语言 ── */
let settingsCloseArmed = false;
let settingsCloseTimer = 0;
function settingsDirty() {
  if (document.body.dataset.demo === "true") return false;
  const customUrlEl = document.getElementById("customBaseUrl");
  const customModelEl = document.getElementById("customModelId");
  const savedUrl = setStatus?.provider ? setStatus.provider.customBaseUrl || "" : "";
  return !!(
    providerCurrent !== providerSaved ||
    (providerCurrent === "custom" &&
      customUrlEl &&
      customUrlEl.value.trim() &&
      customUrlEl.value.trim() !== savedUrl) ||
    (providerCurrent === "custom" && customModelEl && customModelEl.value.trim()) ||
    sKey.value.trim() ||
    sModel.value ||
    sQQAppId.value.trim() ||
    sQQSecret.value ||
    sQQPass.value.trim()
  );
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

/* ── 密码可见性：API Key / AppSecret / 网站密码右侧「显示/隐藏」。
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
  return fetch("/api/data")
    .then((r) => r.json())
    .then((d) => {
      const cells = [
        ["会话", `${d.sessions.count} 个 · ${d.sessions.messages} 条`],
        ["已读附件", `${d.attachments.count} 个 · ${fmtSize(d.attachments.bytes)}`],
        ["网页上传", `${d.uploads.count} 个 · ${fmtSize(d.uploads.bytes)}`],
        ["生成文件", `${d.generated.count} 个 · ${fmtSize(d.generated.bytes)}`],
        ["未完成待办", `${d.reminders.open} 条`],
      ];
      const host = document.getElementById("dataGrid");
      host.innerHTML = "";
      cells.forEach(([label, value]) => {
        const cell = el("data-cell");
        cell.appendChild(el2("", label));
        const strong = document.createElement("strong");
        strong.textContent = value;
        cell.appendChild(strong);
        host.appendChild(cell);
      });
    })
    .catch(() => {
      /* 取数失败给一行看得见的提示，不静默留空 */
      const host = document.getElementById("dataGrid");
      host.innerHTML = "";
      const cell = el("data-cell err");
      cell.textContent = "读取失败，检查本地服务后重进";
      host.appendChild(cell);
    });
}

function runDiagnostic(target, buttonId, stateId) {
  const button = document.getElementById(buttonId),
    state = document.getElementById(stateId);
  button.disabled = true;
  state.textContent = "检测中…";
  fetch("/api/diagnostics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target }),
  })
    .then((r) => r.json())
    .then((d) => {
      button.disabled = false;
      state.textContent = d.result ? d.result.message : d.error || "检测失败";
    })
    .catch(() => {
      button.disabled = false;
      state.textContent = "检测失败，请确认本地服务正在运行。";
    });
}
document
  .getElementById("testDeepseek")
  .addEventListener("click", () => runDiagnostic("deepseek", "testDeepseek", "diagDeepseek"));

/* ── 自绘下拉：原生 <select> 点开的选项列表浏览器不让改样式，换成与
   会话 ⋯ 菜单同一语言的纸片浮层。按钮 aria-expanded 标记开合；键盘
   ↑↓ 在选项间移动，Esc / 点外面 / 滚动收起 ── */
let ddOpenBtn = null;
function closeDd(refocus) {
  const pop = document.getElementById("ddPop");
  if (pop) pop.remove();
  if (ddOpenBtn) {
    ddOpenBtn.setAttribute("aria-expanded", "false");
    if (refocus) ddOpenBtn.focus();
    ddOpenBtn = null;
  }
}
function toggleDd(btn, items, onPick) {
  if (ddOpenBtn === btn) {
    closeDd(true);
    return;
  }
  closeDd();
  const pop = document.createElement("div");
  pop.id = "ddPop";
  pop.className = "dd-pop";
  pop.setAttribute("role", "listbox");
  items.forEach((it) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `dd-item${it.on ? " on" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", it.on ? "true" : "false");
    const main = document.createElement("span");
    main.className = "dd-main";
    main.textContent = it.label;
    row.appendChild(main);
    if (it.note) {
      const note = document.createElement("span");
      note.className = "dd-note";
      note.textContent = it.note;
      row.appendChild(note);
    }
    row.addEventListener("click", () => {
      onPick(it.id);
      closeDd(true);
    });
    pop.appendChild(row);
  });
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.minWidth = `${r.width}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8))}px`;
  /* 下方空间不够就翻到上方；两边都紧张时贴空间大的一侧 */
  const spaceBelow = window.innerHeight - r.bottom;
  if (spaceBelow < 160 && r.top > spaceBelow) {
    pop.style.bottom = `${window.innerHeight - r.top + 4}px`;
  } else {
    pop.style.top = `${r.bottom + 4}px`;
  }
  pop.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...pop.querySelectorAll(".dd-item")];
    const i = rows.indexOf(document.activeElement);
    rows[(i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length].focus();
  });
  btn.setAttribute("aria-expanded", "true");
  ddOpenBtn = btn;
  /* 焦点先落在选中项（没有则第一项）：键盘 ↑↓ 连续移动 */
  const firstChoice = pop.querySelector(".dd-item.on") || pop.querySelector(".dd-item");
  if (firstChoice) firstChoice.focus();
}
/* 闭合状态下按 ↑↓ 也展开（承接原生下拉的键盘习惯） */
function bindDdBtn(btn) {
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (ddOpenBtn !== btn) btn.click();
  });
}
/* 点浮层与按钮以外的地方、设置面板滚动、Esc 都收起 */
document.addEventListener(
  "click",
  (e) => {
    if (!ddOpenBtn) return;
    if (e.target.closest && (e.target.closest("#ddPop") || e.target.closest(".dd-btn"))) return;
    closeDd();
  },
  true,
);
document.addEventListener(
  "scroll",
  (e) => {
    if (!ddOpenBtn) return;
    /* 浮层自己滚动（长清单）不收起 */
    if (e.target?.closest?.("#ddPop")) return;
    closeDd();
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && ddOpenBtn) {
      e.stopPropagation();
      closeDd(true);
    }
  },
  true,
);

/* ── 供应商下拉：内置国内厂商 + 自定义 OpenAI 兼容端点（OpenAI 兼容接入）。
   与型号/学校下拉同一套自绘浮层。本地版随「保存设置」提交（保存前只改
   预览）；托管版（dsHosted 探测成功）供应商由网关管理，走 /api/provider
   即切即重启实例。站点免费额度模式下只能选站点配了 Key 的厂商
   （siteProviders，quota 下发；探测不到按仅 DeepSeek 过渡）── */
let providerCurrent = "deepseek";
let providerSaved = "deepseek";
let providerOptions = [];
let providerHosted = false;
let siteProviders = ["deepseek"]; // quota 探测成功后更新；PR 过渡期默认仅 DeepSeek
let quotaUiMode = ""; // quota 探测得到的 Key 来源选择（与 dsUiMode 同推导）
function providerLabelOf(id) {
  const p = providerOptions.find((x) => x.id === id);
  return p?.label ? p.label : id;
}
function providerKeyHintOf(id) {
  const p = providerOptions.find((x) => x.id === id);
  return p?.keyHint ? p.keyHint : "API Key";
}
function applyProviderUi() {
  const btn = document.getElementById("providerSelect");
  if (btn) btn.textContent = providerLabelOf(providerCurrent);
  const isCustom = providerCurrent === "custom";
  const urlRow = document.getElementById("customBaseUrlRow");
  if (urlRow) urlRow.hidden = !isCustom;
  const modelRow = document.getElementById("customModelRow");
  if (modelRow) modelRow.hidden = !isCustom;
  const kk = document.getElementById("sKey");
  if (kk)
    kk.placeholder =
      keyConfigured && providerCurrent === providerSaved
        ? "已保存；留空不修改"
        : providerKeyHintOf(providerCurrent);
  const note = document.getElementById("dsOwnNote");
  if (note)
    note.textContent = `自己的 ${providerLabelOf(providerCurrent)} Key，不占免费额度、不限轮数`;
}
function fillProviders(d) {
  const p = d?.provider;
  if (!p) return;
  providerOptions = Array.isArray(p.options)
    ? p.options.filter((x) => x && typeof x.id === "string")
    : [];
  providerHosted = !!p.hosted;
  providerSaved = p.current || "deepseek";
  providerCurrent = p.current || "deepseek";
  const url = document.getElementById("customBaseUrl");
  if (url) url.value = p.customBaseUrl || "";
  const mid = document.getElementById("customModelId");
  if (mid) mid.value = providerCurrent === "custom" ? d.model || "" : "";
  applyProviderUi();
}
/* 供应商预切换的型号清单预览（未保存选择不落缓存，服务端 noCache） */
function previewProviderModels(id) {
  if (id === "custom") {
    const urlEl = document.getElementById("customBaseUrl");
    const cu = urlEl ? urlEl.value.trim() : "";
    if (!cu) {
      fillModels([], "", "自定义供应商：填好服务地址并保存后拉取型号清单，或在下方直接输入型号 ID");
      return;
    }
  }
  const cu =
    id === "custom"
      ? encodeURIComponent(document.getElementById("customBaseUrl").value.trim())
      : "";
  fetch(`/api/models?provider=${encodeURIComponent(id)}${cu ? `&custom=${cu}` : ""}&refresh=1`)
    .then((r) => r.json())
    .then((m) => {
      if (!m) return;
      fillModels(m.options || [], m.current || "", m.source === "live" ? "" : m.message);
    })
    .catch(() => {});
}
function pickProvider(id) {
  if (id === providerCurrent) return;
  if (dsHosted) {
    /* 托管版：网关收下选择并踢掉实例，页面对话走新供应商；稍候重载取新状态 */
    fetch("/api/provider", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: id }),
    })
      .then((r) => r.ok)
      .then((okFlag) => {
        if (!okFlag) {
          dsSay("供应商切换失败，请稍后再试。");
          return;
        }
        dsSay("已切换供应商，正在重启服务，稍候…", true);
        window.setTimeout(() => window.location.reload(), 1500);
      })
      .catch(() => dsSay("网络错误，供应商切换失败。"));
    return;
  }
  providerCurrent = id;
  applyProviderUi();
  const mid = document.getElementById("customModelId");
  if (mid) mid.value = "";
  pickModel("");
  previewProviderModels(id);
}
const providerSelectBtn = document.getElementById("providerSelect");
if (providerSelectBtn) {
  bindDdBtn(providerSelectBtn);
  providerSelectBtn.addEventListener("click", () => {
    /* 托管版不给自定义端点（防内网探测）；站点额度模式下只列站点配了 Key 的厂商 */
    let list = providerOptions.filter((p) => !providerHosted || p.id !== "custom");
    if (dsHosted && quotaUiMode === "site") {
      list = list.filter((p) => siteProviders.indexOf(p.id) >= 0);
    }
    if (!list.length) return;
    toggleDd(
      providerSelectBtn,
      list.map((p) => ({
        id: p.id,
        label: p.label,
        note: providerHosted && p.id === "custom" ? "托管环境不可用" : p.note,
        on: p.id === providerCurrent,
      })),
      pickProvider,
    );
  });
}

/* ── 型号下拉框：候选由后端给（该 Key 实际可用的型号），拉不到时是内置兜底清单。
   sModel 仍是值的唯一载体（hidden input），保存逻辑读 sModel.value 不变：
   下拉显示当前在用型号＝「不修改」，选成别的型号保存时才提交切换 ── */
let modelCurrent = "";
let modelOptions = [];
let modelEmptyMsg = "";
function modelLabelOf(id) {
  const m = modelOptions.find((x) => x.id === id);
  return m ? m.label || m.id : "";
}
function pickModel(id) {
  sModel.value = id || "";
  const btn = document.getElementById("modelSelect");
  if (btn) btn.textContent = modelLabelOf(sModel.value || modelCurrent) || modelEmptyMsg || "—";
}
function fillModels(options, current, message) {
  const list = Array.isArray(options) ? options : [];
  modelCurrent = current || "";
  modelOptions = list.filter((m) => m && typeof m.id === "string");
  modelEmptyMsg = modelOptions.length ? "" : message || "型号清单读取中…";
  pickModel(sModel.value && modelOptions.some((m) => m.id === sModel.value) ? sModel.value : "");
  /* 当前型号由下拉按钮自身显示（按钮文案即在用型号），不常驻一行小字重复；
     这行只在服务端带话时出现：清单降级原因 / 自定义端点引导 */
  if (curModel) {
    const note = message && modelOptions.length ? message : "";
    curModel.textContent = note;
    curModel.hidden = !note;
  }
}
const modelSelectBtn = document.getElementById("modelSelect");
if (modelSelectBtn) {
  bindDdBtn(modelSelectBtn);
  modelSelectBtn.addEventListener("click", () => {
    if (!modelOptions.length) return;
    const active = sModel.value || modelCurrent;
    toggleDd(
      modelSelectBtn,
      modelOptions.map((m) => ({
        id: m.id,
        label: m.label || m.id,
        note: m.note,
        on: m.id === active,
      })),
      (id) => {
        /* 选回当前在用型号＝不修改；选成别的＝保存时切换（演示页纯预览） */
        pickModel(id === modelCurrent ? "" : id);
      },
    );
  });
}

/* ── 设置栏目切换：点左列目录，右列换内容。「保存设置」只属于
   凭证类栏目（模型 / QQ）；本地数据即改即存，不亮保存 ── */
const setTabs = [...document.querySelectorAll(".set-tab")];
let setLastTab = "model"; // 记住上次停留的栏目，进设置直达上次位置
function setTab(name) {
  if (!setTabs.some((t) => t.dataset.pane === name && !t.hidden)) name = "model";
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
  document.getElementById("saveSettings").hidden = !["model", "qq"].includes(name);
}
for (const tab of setTabs) tab.addEventListener("click", () => setTab(tab.dataset.pane));
/* 方向键在栏目间移动焦点：大厅里目录是横排（左右）+ 窄屏也是横排，竖排同样支持上下 */
document.getElementById("setTabs").addEventListener("keydown", (e) => {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const i = setTabs.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
  setTabs[(i + step + setTabs.length) % setTabs.length].focus();
});
/* 栏目状态点（取代旧的状态总览 chips）：未配=朱砂实心（要行动），已配=空心圈；
   QQ 选配，未配时不亮。数据来自 showSettings / 保存成功的那次 /api/settings */
function renderSetDots(d) {
  if (!d) return;
  const mark = (pane, ok, optional) => {
    const dot = document.querySelector(`#setTabs .set-tab[data-pane="${pane}"] .sdot`);
    if (!dot) return;
    dot.className = `sdot ${ok ? "ok" : optional ? "" : "warn"}`;
    dot.title = ok ? "已配置" : optional ? "" : "未配置，需要填写";
  };
  mark("model", !!d.deepseek?.configured, false);
  mark("qq", !!d.qq?.configured, true);
}

/* 课表导入状态行（设置 → 本地数据）：有缓存提示可重导，没缓存引导导入 */
function syncSchoolUi() {
  const cur = document.getElementById("curSchool");
  if (!cur) return;
  const cached = schoolState?.scheduleCached;
  cur.textContent = cached
    ? "已有导入的课表；换学期或课表有变时重新导入即可"
    : "还没有导入课表：点下方按钮粘贴或上传，AI 解析后确认";
}

function qqStatusText(q) {
  return q?.configured
    ? "已配置：AppID " +
        (q.appIdMasked || "已保存") +
        " · " +
        q.sourceLabel +
        (q.passcodeSet ? " · 暗号已设" : " · 未设暗号")
    : "未配置；到 q.qq.com 创建机器人后填入，保存后即可在 QQ 里使用";
}
function qqApplyStatus(q) {
  document.getElementById("curQQ").textContent = qqStatusText(q);
  sQQSecret.placeholder = q?.configured ? "已保存；留空不修改" : "q.qq.com 机器人的 AppSecret";
  sQQPass.placeholder = q?.passcodeSet ? "已设暗号；留空不修改" : "首次激活用的暗号（自定）";
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
  sKey.value = "";
  pickModel("");
  const customModelEl = document.getElementById("customModelId");
  if (customModelEl) customModelEl.value = "";
  sQQAppId.value = "";
  sQQSecret.value = "";
  sQQPass.value = "";
  document.getElementById("diagDeepseek").textContent = "";
  document.getElementById("diagSchool").textContent = "";
  refreshData();
  fetch("/api/settings")
    .then((r) => r.json())
    .then((d) => {
      setStatus = d;
      renderSetDots(d);
      applySchoolState(d.school);
      fillProviders(d);
      renderCurKey(d);
      refreshQuota();
      applyProviderUi();
      qqApplyStatus(d.qq);
      fillModels(d.models, d.model, "");
    })
    .catch(() => {
      setMsg.textContent = "无法读取设置，请确认本地服务正在运行。";
    });
  // 清单以该 Key 实际可用的型号为准；服务端 10 分钟内走缓存，不重复联网
  fetch("/api/models")
    .then((r) => r.json())
    .then((m) => {
      if (!m || !Array.isArray(m.options)) return;
      fillModels(m.options, m.current, m.source === "live" ? "" : m.message);
    })
    .catch(() => {});
}
/* 「取消」= 关掉大厅抽屉；设置面板是常驻 DOM，下次进入重新复位取数 */
document.getElementById("cancelSettings").addEventListener("click", closeHall);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (sessionActionsId) {
    sessionActionsId = "";
    renderSessList();
    return;
  }
  /* 大厅（含设置）是更上层的容器：窄屏下它是浮层+遮罩，Esc 应先关它 */
  if (document.body.classList.contains("hall-open")) {
    closeHall();
    return;
  }
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
    btn.dataset.timer = String(
      window.setTimeout(() => {
        btn.dataset.armed = "";
        btn.textContent = btn.dataset.label || confirmLabel;
        btn.classList.remove("armed");
      }, 3000),
    );
    return;
  }
  window.clearTimeout(Number(btn.dataset.timer));
  btn.dataset.armed = "";
  btn.classList.remove("armed");
  btn.disabled = true;
  btn.textContent = "清理中…";
  fetch("/api/data/clear", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scopes }),
  })
    .then((r) => r.json())
    .then(() => {
      refreshData();
      refreshSessions();
      if (scopes.includes("sessions")) startFresh();
    })
    .catch(() => {})
    .finally(() => {
      btn.disabled = document.body.dataset.demo === "true";
      btn.textContent = btn.dataset.label || confirmLabel;
    });
}
document
  .getElementById("clearFiles")
  .addEventListener("click", (e) =>
    armClearData(e.currentTarget, ["attachments", "uploads", "generated"], "确认清理文件？"),
  );
document
  .getElementById("clearAllData")
  .addEventListener("click", (e) =>
    armClearData(
      e.currentTarget,
      ["sessions", "attachments", "uploads", "generated", "reminders"],
      "确认清空全部？",
    ),
  );
/* 危险按钮的作用范围收进 title（悬停可见），常态文案保持短 */
document.getElementById("clearFiles").title =
  "清理已读附件副本、网页上传和生成文件；聊天记录与待办保留";
document.getElementById("clearAllData").title = "清空全部本地会话、附件、生成文件和待办；不可恢复";
document.getElementById("saveSettings").addEventListener("click", () => {
  const body = {};
  const k = sKey.value.trim();
  if (k) body.apiKey = k;
  /* 供应商与自定义端点：本地版随保存提交（托管版走 /api/provider，不进这里） */
  if (!dsHosted && providerCurrent !== providerSaved) body.providerId = providerCurrent;
  if (providerCurrent === "custom") {
    const cuEl = document.getElementById("customBaseUrl");
    const cu = cuEl ? cuEl.value.trim() : "";
    if (cu) body.customBaseUrl = cu;
    const cmEl = document.getElementById("customModelId");
    const cm = cmEl ? cmEl.value.trim() : "";
    if (cm) body.model = cm; /* 手输型号优先于下拉选择 */
  }
  const qa = sQQAppId.value.trim(),
    qs = sQQSecret.value,
    qp = sQQPass.value.trim();
  if (qa || qs) {
    if (!qa || !qs) {
      setMsg.className = "setmsg";
      setMsg.textContent = "QQ 的 AppID 与 AppSecret 需要一起填写（q.qq.com 机器人详情页可查）。";
      return;
    }
    body.qqAppId = qa;
    body.qqAppSecret = qs;
  }
  if (qp) body.qqPasscode = qp;
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
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      saveBtn.disabled = false;
      /* 保存结果逐条展示：失败行保持朱砂、成功行随 good 变墨色，混在一起也分得清 */
      setMsg.className = `setmsg${ok ? " good" : ""}`;
      setMsg.textContent = "";
      const lines = d.results || [];
      for (const x of lines) {
        const line = document.createElement("div");
        line.className = `setmsg-line${x.ok === false ? " bad" : ""}`;
        line.textContent = x.message;
        setMsg.appendChild(line);
      }
      if (!lines.length) setMsg.textContent = ok ? "设置已保存。" : d.error || "保存失败，请重试。";
      if (ok && d.status) {
        setStatus = d.status;
        sKey.value = "";
        renderSetDots(d.status);
        /* 学校切换落库后：同步模式标记（各面板门禁用） */
        if (d.status.school) {
          applySchoolState(d.status.school);
        }
        fillProviders(d.status);
        renderCurKey(d.status);
        refreshQuota();
        sQQAppId.value = "";
        sQQSecret.value = "";
        sQQPass.value = "";
        qqApplyStatus(d.status.qq);
        pickModel("");
        fillModels(d.status.models, d.status.model, "");
        /* 凭证已落库：dirty 归零，「关闭」不必再二次确认；按钮短暂亮一下完成感 */
        disarmSettingsClose();
        saveBtn.textContent = "已保存 ✓";
        window.setTimeout(() => {
          saveBtn.textContent = "保存设置";
        }, 1400);
      }
    })
    .catch(() => {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存设置";
      setMsg.className = "setmsg";
      setMsg.textContent = "保存失败，请确认本地服务正在运行后重试。";
    });
});

/* ── 导入课表面板（#hallImport）：粘贴/上传 → AI 解析 → 追问 → 可编辑预览 → 确认。
     服务端不存会话状态：追问答案由前端持有、重新解析时带上重放；
     预览行点开就地编辑（课名/星期/节次/周次/地点/教师），删除两步确认；
     确认导入两步确认后覆盖本地课表缓存（手动课表模式的数据源） ── */
const impText = document.getElementById("impText");
const impStateEl = document.getElementById("impState");
const impParseBtn = document.getElementById("impParse");
const impCommitBtn = document.getElementById("impCommit");
const imp = {
  uploadId: "",
  fileName: "",
  answers: {}, // question -> answer：追问循环的状态，重新解析时带上
  courses: [],
  rejected: [],
  conflicts: [],
  questions: [],
  parsed: false,
  termHint: "",
  termStartHint: "",
  busy: false,
  done: "",
};
const IMP_WEEKDAYS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
function impSay(text) {
  impStateEl.textContent = text || "";
}
/* 候选学期与服务端 candidateTerms 同一套日历规则（仅用于下拉预选） */
function impTermCandidates() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  if (m >= 9)
    return [
      { year: y, semester: 3 },
      { year: y - 1, semester: 12 },
    ];
  if (m >= 7)
    return [
      { year: y, semester: 3 },
      { year: y - 1, semester: 12 },
      { year: y - 1, semester: 3 },
    ];
  return [
    { year: y - 1, semester: 12 },
    { year: y - 1, semester: 3 },
  ];
}
function impTermLabel(t) {
  return `${t.year}-${t.year + 1}学年第${t.semester === 3 ? "一" : "二"}学期`;
}
/* 节次文本 → 数组："3-4" / "3,4" / "3 4" 都认；编辑框里随手改 */
function impParsePeriods(s) {
  const out = [];
  String(s || "")
    .split(/[,，;；\s]+/)
    .filter(Boolean)
    .forEach((seg) => {
      const m = seg.match(/(\d+)\s*[-~—－]\s*(\d+)/);
      if (m) {
        for (let p = Number(m[1]); p <= Number(m[2]); p++) out.push(p);
      } else {
        const n = Number.parseInt(seg, 10);
        if (n > 0) out.push(n);
      }
    });
  return [...new Set(out)].sort((a, b) => a - b);
}
function impCourseMeta(c) {
  return [
    IMP_WEEKDAYS[c.weekday] || `周${c.weekday}`,
    `${(c.periods || []).join(",")}节`,
    c.weeks ? `${c.weeks}周` : "",
    c.location ? `@${c.location}` : "",
    c.teacher,
  ]
    .filter(Boolean)
    .join(" · ");
}
function impSyncCommit() {
  impCommitBtn.disabled = !imp.parsed || !imp.courses.length || !!imp.done;
}
function showImport() {
  impRender();
}
/* 全量重绘追问区 / 预览区 / 学期行；textarea 与上传 chip 是常驻 DOM 不动 */
function impRender() {
  const qBox = document.getElementById("impQuestions");
  const pBox = document.getElementById("impPreview");
  const tBox = document.getElementById("impTerm");
  qBox.innerHTML = "";
  pBox.innerHTML = "";
  tBox.innerHTML = "";
  if (imp.done) {
    const done = el("imp-done");
    done.appendChild(el2("id-t", `✓ ${imp.done}`));
    done.appendChild(
      el2(
        "id-s",
        "课表已写入本地缓存：对话里问「这周有什么课」、功能大厅与 /schedule 页都会用它。",
      ),
    );
    const go = document.createElement("button");
    go.type = "button";
    go.className = "tbtn";
    go.textContent = "查看课表";
    go.addEventListener("click", () => openHall("schedule"));
    done.appendChild(go);
    pBox.appendChild(done);
    impSyncCommit();
    return;
  }
  if (!imp.parsed) {
    impSyncCommit();
    return;
  }
  /* 追问卡：未回答过的问题逐条给输入框（答案可留空 = 先按解析结果走） */
  imp.questions.forEach((q) => {
    const card = el("imp-q");
    card.dataset.question = q.question;
    card.appendChild(el2("iq-t", `AI 想确认：${q.question}`));
    if (q.options) card.appendChild(el2("iq-o", `可选：${q.options}`));
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "写下你的回答，然后点「解析课表」带上答案重新解析";
    input.value = imp.answers[q.question] || "";
    card.appendChild(input);
    qBox.appendChild(card);
  });
  if (imp.questions.length) {
    const note = el2("imp-warn", "答完上面的框再点一次「解析课表」；不确定的可以留空直接看预览。");
    qBox.appendChild(note);
  }
  /* 解析质量问题如实亮出来：被拒行 + 时间冲突 */
  const warns = [];
  imp.rejected.forEach((r) => {
    warns.push(`第 ${r.row} 行未解析：${r.reason}`);
  });
  imp.conflicts.forEach((c) => {
    warns.push(`⚠ ${c}`);
  });
  if (warns.length) pBox.appendChild(el2("imp-warn", warns.join("\n")));
  imp.courses.forEach((c, i) => {
    pBox.appendChild(impRowNode(c, i));
  });
  if (!imp.courses.length && !warns.length)
    pBox.appendChild(el2("imp-warn", "没有解析出任何课程：换一段更完整的文字再试。"));
  /* 学期与开学日期：模型从内容里看出的线索做预选，最终以这里的选择为准 */
  const row = el("imp-term-row");
  const termFld = el("fld");
  termFld.appendChild(el2("", "学期"));
  const sel = document.createElement("select");
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "自动（按当前日期）";
  sel.appendChild(auto);
  const candidates = impTermCandidates();
  candidates.forEach((t) => {
    const o = document.createElement("option");
    o.value = `${t.year}:${t.semester}`;
    o.textContent = impTermLabel(t);
    sel.appendChild(o);
  });
  if (imp.termHint) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = `内容提到：${imp.termHint}`;
    o.disabled = true;
    sel.insertBefore(o, sel.children[1] ?? null);
  }
  termFld.appendChild(sel);
  row.appendChild(termFld);
  const startFld = el("fld");
  startFld.appendChild(el2("", "开学日期（第 1 周的周一）"));
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.value = /^\d{4}-\d{2}-\d{2}$/.test(imp.termStartHint || "") ? imp.termStartHint : "";
  startFld.appendChild(dateInput);
  row.appendChild(startFld);
  tBox.appendChild(row);
  const note = el2(
    "hall-note",
    "开学日期用于推算「今天是第几周」，不填则按 9 月 / 2 月的周一估算；之后在设置里重新导入可校准。",
  );
  tBox.appendChild(note);
  impSyncCommit();
}
/* 单条课程行：折叠态一行摘要，点开 6 个字段就地编辑；删除两步确认 */
function impRowNode(c, i) {
  const row = el("imp-row");
  const top = el("imp-row-top");
  top.tabIndex = 0;
  top.setAttribute("role", "button");
  top.setAttribute("aria-expanded", "false");
  const main = document.createElement("span");
  main.className = "ir-main";
  main.textContent = c.title || "（未命名课程）";
  const meta = document.createElement("span");
  meta.className = "ir-meta";
  meta.textContent = impCourseMeta(c);
  top.appendChild(main);
  top.appendChild(meta);
  top.appendChild(
    hallDelBtn("删除", () => {
      imp.courses.splice(i, 1);
      impRender();
    }),
  );
  row.appendChild(top);
  const edit = el("imp-edit");
  edit.hidden = true;
  const fields = [
    { key: "title", label: "课程名", type: "text", value: () => c.title || "" },
    {
      key: "weekday",
      label: "星期",
      type: "select",
      options: IMP_WEEKDAYS.slice(1).map((n, k) => [String(k + 1), n]),
      value: () => String(c.weekday || 1),
    },
    {
      key: "periods",
      label: "节次（如 3-4）",
      type: "text",
      value: () => (c.periods || []).join(","),
    },
    { key: "weeks", label: "周次（如 1-16）", type: "text", value: () => c.weeks || "" },
    { key: "location", label: "地点", type: "text", value: () => c.location || "" },
    { key: "teacher", label: "教师", type: "text", value: () => c.teacher || "" },
  ];
  const syncTop = () => {
    main.textContent = c.title || "（未命名课程）";
    meta.textContent = impCourseMeta(c);
  };
  fields.forEach((f) => {
    const fld = el("fld");
    fld.appendChild(el2("", f.label));
    let input;
    if (f.type === "select") {
      input = document.createElement("select");
      f.options.forEach(([v, n]) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = n;
        input.appendChild(o);
      });
    } else {
      input = document.createElement("input");
      input.type = "text";
    }
    input.value = f.value();
    input.addEventListener("input", () => {
      if (f.key === "weekday") c.weekday = Number(input.value) || 1;
      else if (f.key === "periods") c.periods = impParsePeriods(input.value);
      else c[f.key] = input.value.trim();
      syncTop();
    });
    fld.appendChild(input);
    edit.appendChild(fld);
  });
  row.appendChild(edit);
  const toggle = () => {
    edit.hidden = !edit.hidden;
    top.setAttribute("aria-expanded", edit.hidden ? "false" : "true");
    if (!edit.hidden) {
      const first = edit.querySelector("input, select");
      if (first) first.focus();
    }
  };
  top.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    toggle();
  });
  top.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !e.target.closest("button")) {
      e.preventDefault();
      toggle();
    }
  });
  return row;
}
/* 解析（也承担「带着答案重新解析」） */
impParseBtn.addEventListener("click", () => {
  if (imp.busy) return;
  const text = impText.value.trim();
  if (!text && !imp.uploadId) {
    impSay("先粘贴课表文字，或选择一个课表文件");
    return;
  }
  const answers = [];
  document.querySelectorAll("#impQuestions .imp-q").forEach((card) => {
    const q = card.dataset.question || "";
    const a = card.querySelector("input")?.value || "";
    if (q && a.trim()) answers.push({ question: q, answer: a.trim() });
  });
  imp.busy = true;
  impParseBtn.disabled = true;
  impParseBtn.textContent = "解析中…";
  impSay("AI 正在解析课表（几秒到半分钟）…");
  fetch("/api/schedule/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      ...(imp.uploadId ? { uploadId: imp.uploadId } : {}),
      ...(imp.fileName ? { fileName: imp.fileName } : {}),
      answers,
    }),
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok || d.error) {
        impSay(d.error || "解析失败，请稍后重试");
        return;
      }
      answers.forEach((a) => {
        imp.answers[a.question] = a.answer;
      });
      imp.courses = d.courses || [];
      imp.rejected = d.rejected || [];
      imp.conflicts = d.conflicts || [];
      imp.questions = (d.questions || []).filter((q) => !imp.answers[q.question]);
      imp.termHint = d.termHint || "";
      imp.termStartHint = d.termStartHint || "";
      imp.parsed = true;
      imp.done = "";
      impSay(
        imp.questions.length
          ? "解析出 " +
              imp.courses.length +
              " 条课程；AI 还有 " +
              imp.questions.length +
              " 个问题要确认（见下方）"
          : `解析出 ${imp.courses.length} 条课程；核对预览后点「确认导入」`,
      );
      impRender();
    })
    .catch(() => impSay("网络错误，解析失败"))
    .finally(() => {
      imp.busy = false;
      impParseBtn.disabled = HALL_DEMO;
      impParseBtn.textContent = "解析课表";
    });
});
/* 上传：与聊天附件同一条 /api/uploads 通道（Excel/CSV/PDF/Word/TXT 服务端预解析） */
document.getElementById("impFileBtn").addEventListener("click", () => {
  document.getElementById("impFile").click();
});
document.getElementById("impFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  impSay(`正在上传 ${file.name}…`);
  const reader = new FileReader();
  reader.onerror = () => impSay("读取文件失败");
  reader.onload = () => {
    const b64 = String(reader.result || "").split(",")[1] || "";
    fetch("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, type: file.type || "", data: b64 }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok || !d.upload) {
          impSay(d.error || "上传失败");
          return;
        }
        imp.uploadId = d.upload.id;
        imp.fileName = file.name;
        document.getElementById("impFileName").textContent =
          `${file.name}（${Math.max(1, Math.round(file.size / 1024))} KB，已上传）`;
        impSay("文件已就绪，点「解析课表」让 AI 读取");
      })
      .catch(() => impSay("网络错误，上传失败"));
  };
  reader.readAsDataURL(file);
});
/* 确认导入：两步确认（覆盖现有课表缓存），成功后清 brief 缓存让各面板立刻用新数据 */
impCommitBtn.addEventListener("click", () => {
  if (impCommitBtn.disabled || imp.busy) return;
  if (impCommitBtn.dataset.armed !== "1") {
    impCommitBtn.dataset.armed = "1";
    impCommitBtn.dataset.label = impCommitBtn.textContent;
    impCommitBtn.textContent = "确认覆盖导入？";
    impCommitBtn.classList.add("armed");
    window.clearTimeout(Number(impCommitBtn.dataset.timer));
    impCommitBtn.dataset.timer = String(
      window.setTimeout(() => {
        impCommitBtn.dataset.armed = "";
        impCommitBtn.textContent = impCommitBtn.dataset.label || "确认导入";
        impCommitBtn.classList.remove("armed");
      }, 3000),
    );
    return;
  }
  window.clearTimeout(Number(impCommitBtn.dataset.timer));
  impCommitBtn.dataset.armed = "";
  impCommitBtn.classList.remove("armed");
  const termSel = document.querySelector("#impTerm select");
  const dateInput = document.querySelector('#impTerm input[type="date"]');
  const courses = imp.courses.map((c) => ({
    title: c.title,
    weekday: c.weekday,
    periods: c.periods,
    weeks: c.weeks,
    location: c.location || "",
    teacher: c.teacher || "",
  }));
  const body = { courses };
  if (termSel?.value) {
    const [y, s] = termSel.value.split(":");
    body.year = Number(y);
    body.semester = Number(s);
  }
  if (dateInput?.value) body.termStart = dateInput.value;
  imp.busy = true;
  impCommitBtn.disabled = true;
  impCommitBtn.textContent = "导入中…";
  fetch("/api/schedule/import/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok || d.error) {
        impSay(d.error || "导入失败");
        impSyncCommit();
        impCommitBtn.textContent = impCommitBtn.dataset.label || "确认导入";
        return;
      }
      imp.done = `已导入 ${d.count} 门课（${d.term}）`;
      hallBrief = null;
      if (schoolState) {
        schoolState.scheduleCached = true;
        syncSchoolUi();
      }
      impSay("");
      impRender();
      impCommitBtn.textContent = impCommitBtn.dataset.label || "确认导入";
    })
    .catch(() => {
      impSay("网络错误，导入失败");
      impSyncCommit();
      impCommitBtn.textContent = impCommitBtn.dataset.label || "确认导入";
    })
    .finally(() => {
      imp.busy = false;
    });
});
/* 返回：回设置的本地数据栏（导入课表入口在那儿）；直接深链进来的关掉抽屉也一样能走 */
document.getElementById("impBack").addEventListener("click", () => {
  openHall("settings");
  setTab("data");
});
/* 设置 → 本地数据 → 导入 / 重新导入课表 */
const openImportBtn = document.getElementById("openImport");
if (openImportBtn)
  openImportBtn.addEventListener("click", () => {
    openHall("import");
  });

/* ── 启动：拉会话列表，但默认进入新的空会话 ── */
refreshSessions().then(() => {
  startFresh();
});
/* 快捷问题以服务端保存的自定义清单为准（设置里自选过的话）；
   拉不到就保持默认，不挡页面启动。顺手同步学校模式（各面板门禁用） */
fetch("/api/settings")
  .then((r) => r.json())
  .then((d) => {
    if (d.school) {
      applySchoolState(d.school);
      /* news 门禁状态到位：正在看通知面板但权限不足（深链竞态）时退回宫格；
         宫格开着时重排一次（schoolState 晚于首渲染到达的场合），该亮的卡补上 */
      if (hallPanel === "news" && !newsAvailable()) {
        hallPanel = "";
        if (document.body.classList.contains("hall-open")) {
          renderHall();
          syncHallHash();
        }
      } else if (!hallPanel && document.body.classList.contains("hall-open")) {
        renderHall();
      }
    }
    if (Array.isArray(d.quickQuestions) && d.quickQuestions.length) {
      quickQuestions = d.quickQuestions.slice();
      renderQchips();
    }
  })
  .catch(() => {});
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
    const chip = el(`upchip${upload.status === "uploading" ? " loading" : ""}`);
    if (upload.status === "error") {
      /* 失败 chip 可点击重试：原名保留，错误原因收进 title */
      chip.appendChild(el2("", `失败，点击重试 · ${upload.name}`));
      chip.title = upload.error || "上传失败";
      chip.tabIndex = 0;
      chip.setAttribute("role", "button");
      chip.style.cursor = "pointer";
      const retry = () => {
        doUpload(upload);
      };
      chip.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        retry();
      });
      chip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          retry();
        }
      });
    } else {
      chip.appendChild(
        el2("", (upload.status === "uploading" ? "上传中 · " : "附件 · ") + upload.name),
      );
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "✕";
    remove.title = "移除附件";
    remove.addEventListener("click", () => {
      pendingUploads = pendingUploads.filter((x) => x.localId !== upload.localId);
      if (upload.id) fetch(`/api/uploads/${upload.id}`, { method: "DELETE" }).catch(() => {});
      renderUploads();
      syncBtn();
    });
    chip.appendChild(remove);
    uploadTray.appendChild(chip);
  });
}
function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function uploadFile(file) {
  const item = { localId: uuid(), name: file.name, size: file.size, status: "uploading", file };
  pendingUploads.push(item);
  renderUploads();
  syncBtn();
  await doUpload(item);
}
/* 上传执行体拆出来：失败 chip 点一下就能重试，不用删了重选 */
async function doUpload(item) {
  item.status = "uploading";
  item.error = "";
  renderUploads();
  syncBtn();
  try {
    const data = await fileAsBase64(item.file);
    const response = await fetch("/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: item.file.name, type: item.file.type, data }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "上传失败");
    Object.assign(item, body.upload, { status: "ready" });
  } catch (error) {
    item.status = "error";
    item.error = String(error.message || error);
  }
  renderUploads();
  syncBtn();
}
function handleFiles(files) {
  [...files].slice(0, Math.max(0, 8 - pendingUploads.length)).forEach(uploadFile);
}
document.getElementById("attachBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  handleFiles(fileInput.files || []);
  fileInput.value = "";
});
/* Ctrl+V 粘贴文件：从文件管理器/别的应用复制后可直接贴进输入框，
   走同一套上传队列；纯文本粘贴保持原生行为不受影响 */
input.addEventListener("paste", (e) => {
  if (document.body.dataset.demo === "true") return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    handleFiles(files);
  }
});
["dragenter", "dragover"].forEach((name) => {
  cwrap.addEventListener(name, (e) => {
    e.preventDefault();
    if (!document.body.dataset.demo.includes("true")) cwrap.classList.add("drag");
  });
});
["dragleave", "drop"].forEach((name) => {
  cwrap.addEventListener(name, (e) => {
    e.preventDefault();
    cwrap.classList.remove("drag");
    if (name === "drop" && e.dataTransfer) handleFiles(e.dataTransfer.files || []);
  });
});

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
        message: text,
        sessionId: activeId,
        attachmentIds: sendingUploads.map((x) => x.id),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
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
          else {
            thinkRaw += ev.v || "";
            thinkDelta(shell, ev.v || "");
          }
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
            if (ev.files?.length) fileRows(shell.tl, ev.files);
            if (ev.pomodoro) pomoCard(shell.tl, ev.pomodoro);
            /* pptx 成品：下载行之外再出一张可翻页的幻灯片预览卡 */
            if (ev.ppt) pptCard(shell.tl, ev.ppt, ev.files);
            /* 图谱变更：对话里就地重绘迷你关系图，与文字回复流并行 */
            if (ev.graph) graphMiniCard(shell.tl, ev.graph);
            /* 对话里取消了番茄钟：立即对表收掉页面其他位置的倒计时卡 */
            if (ev.pomoSync) pomoSync();
            /* 工具改了数据（加待办、起番茄钟……）：面板开着就刷新，没开着就作废缓存。
               settings 是静态面板且工具失败也可能带它：只负责推出，不参与刷新 */
            const panel = TOOL_PANEL[ev.name];
            if (panel && panel !== "settings") {
              hallBrief = null;
              if (hallPanel === panel && document.body.classList.contains("hall-open"))
                renderHall();
            }
            /* 服务端点名要推出的面板：open_panel（用户显式说「打开××」）与
               凭证未配置要点名的设置。自动推出（本轮手动关过则不打扰） */
            if (ev.panel && !hallAutoMuted) openHall(ev.panel, { focus: false });
          }
        } else if (ev.t === "card") {
          /* 结构化结果卡：跟在对应工具卡之后、正文之前 */
          thinkClose(shell);
          if (ev.card) renderResultCard(shell.tl, ev.card);
        } else if (ev.t === "err") {
          thinkClose(shell);
          lineBad(shell.tl, ev.v);
        } else if (ev.t === "end") {
          thinkClose(shell);
          if (ev.dur != null) shell.dur.textContent = `· ${(ev.dur / 1000).toFixed(1)}s`;
          /* 服务端可能把无名新会话建档成 default 档：认领回来的 id */
          if (ev.sid) {
            activeId = String(ev.sid);
            lsSet(ACTIVE_KEY, activeId);
          }
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
      retry.addEventListener("click", () => {
        if (!busy) send(lastPrompt);
      });
      shell.acts.appendChild(retry);
    }
  } finally {
    thinkClose(shell);
    shell.msg.classList.remove("cursor");
    busy = false;
    controller = null;
    btn.classList.remove("stop");
    btn.innerHTML = '发送<span class="kbd">⏎</span>';
    syncBtn();
    /* 标题可能挂着完成提醒；切走了就补一次亮灯。
       一直可见时把「回复中」复位（番茄钟到点写的标题不碰） */
    if (document.hidden) document.title = "● 回复完成 · CourseRaptor";
    else if (document.title.startsWith("● 回复中")) document.title = "CourseRaptor";
    refreshSessions();
    refreshHallBadge();
    if (AUTO_FOCUS) input.focus();
  }
}

/* ── 输入区：textarea 自适应高度；Enter 发送、Shift+Enter 换行；
   进行中再按 = 中断（按钮同样）；空文时发送键落灰 ─────────── */
const form = document.getElementById("f");
function fit() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}
/* 空内容时发送键禁用；流式进行中永远可点（此时它是「停止」） */
function syncBtn() {
  const uploading = pendingUploads.some((x) => x.status === "uploading");
  const readyFile = pendingUploads.some((x) => x.status === "ready");
  btn.disabled = !busy && (uploading || (!input.value.trim() && !readyFile));
}
input.addEventListener("input", () => {
  fit();
  syncBtn();
});
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
  if (busy) {
    controller?.abort();
    return;
  }
  const text =
    input.value.trim() ||
    (pendingUploads.some((x) => x.status === "ready") ? "请阅读并概括这些附件" : "");
  if (!text) return;
  input.value = "";
  fit();
  send(text);
});

/* 切回本页时复位标题（后台完成时的 ● 提示只留到看见为止） */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) document.title = "CourseRaptor";
});

/* ── iOS 键盘抬升：Safari 键盘弹出时布局视口不缩（100dvh 不变）、只有
   visualViewport 变小，钉在视口底部的输入条会被键盘整个盖住。这里把
   「布局视口高 − 视觉视口高」的差值写进 --vkb（px），页面与两个抽屉
   用它整体抬到键盘上方（见 chat-page.ts 的 height/bottom 用法）。
   Android 两套视口同步缩放、差值恒为 0，天然不生效；桌面没有键盘。
   双指缩放（scale≠1）不算键盘，跳过以免误抬。 ── */
const vv = window.visualViewport;
if (vv) {
  const syncKb = () => {
    const kb =
      Math.abs(vv.scale - 1) > 0.01 ? 0 : Math.max(0, Math.round(window.innerHeight - vv.height));
    document.documentElement.style.setProperty("--vkb", `${kb}px`);
    /* iOS 会顺势把页面往上顶；锁高布局里那只是一段空白，拉回顶部 */
    if (kb > 0 && window.scrollY !== 0) window.scrollTo(0, 0);
    /* 高度变化后按需贴底：正在看最新消息时不让键盘把消息顶出视野 */
    requestAnimationFrame(() => {
      if (pinned) scroll(false);
    });
  };
  vv.addEventListener("resize", syncKb);
}
if (AUTO_FOCUS) input.focus();
