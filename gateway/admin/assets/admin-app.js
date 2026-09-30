/**
 * 管理总台前端应用（完全按同学端网页版推导，不沿用旧管理台骨架）。
 *
 * 页面形态 = web 独立页（today / knowledge / schedule）的编辑台变体：
 * 报头（旋转印章 + 楷体标题 + 眉批 + 时钟）+ 左侧窄栏（kicker / 楷体题 /
 * 目录导航 / 运行信息）+ 右侧朱砂顶线卡片列。首页是对话页 hero 与
 * 功能大厅目录行的合体；「同学」页是知识库式的名录 + 个人档案。
 *
 * 交付模式与 chat-app.js 相同：无构建、独立资产，由 ui.mjs 内联进页面。
 * 数据仍走 /admin/api/bootstrap 一次往返；#/hash 路由可直达各管理区。
 */
(function () {
  "use strict";

  // ── 小工具 ────────────────────────────────────────────────

  function api(path, body) {
    var opts = body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {};
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) {
        location.href = "/admin";
        return null;
      }
      return r.json();
    });
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtDate(iso) {
    return String(iso || "").slice(0, 10);
  }

  function fmtTime(iso) {
    return iso ? String(iso).replace("T", " ").slice(0, 16) : "—";
  }

  function mb(n) {
    return (n / 1048576).toFixed(1) + " MB";
  }

  function uptimeText(sec) {
    var up = sec || 0;
    if (up >= 86400) return Math.floor(up / 86400) + " 天 " + Math.floor((up % 86400) / 3600) + " 小时";
    if (up >= 3600) return Math.floor(up / 3600) + " 小时 " + Math.floor((up % 3600) / 60) + " 分";
    return Math.floor(up / 60) + " 分钟";
  }

  // 管理区图标：与 web 大厅宫格同一族 1.8px 描线 SVG（24 viewBox）
  var ICONS = {
    students:
      '<svg viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7"/><path d="M16 3.5a4 4 0 0 1 0 7"/><path d="M17 14c2.8.5 5 3 5 6.2"/></svg>',
    access:
      '<svg viewBox="0 0 24 24"><path d="M4 22h16c1.1 0 2-.9 2-2v-4H2v4c0 1.1.9 2 2 2z"/><path d="M6 13V4c0-1.1.9-2 2-2h8c1.1 0 2 .9 2 2v9"/><path d="M10 6h4"/></svg>',
    model:
      '<svg viewBox="0 0 24 24"><path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/></svg>',
    release:
      '<svg viewBox="0 0 24 24"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
    keys:
      '<svg viewBox="0 0 24 24"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>',
    security:
      '<svg viewBox="0 0 24 24"><path d="M12 22s8-3.6 8-10V5.5L12 2 4 5.5V12c0 6.4 8 10 8 10z"/><path d="M9 11.5l2 2 4-4.5"/></svg>',
  };

  // ── 路由（#/hash，目录导航与浏览器前进后退共用）──────────

  var PANES = ["home", "students", "access", "model", "release", "keys", "security"];
  var current = "home";
  /** 发版上传进行中不自动刷新数据，避免打断进度条 */
  var uploading = false;

  var TITLES = {
    home: "首页",
    students: "同学",
    access: "准入",
    model: "模型与额度",
    release: "版本",
    keys: "密钥",
    security: "安全",
  };

  function showPane(id, pushHash) {
    if (PANES.indexOf(id) < 0) id = "home";
    current = id;
    var links = document.querySelectorAll(".cat-btn[data-nav]");
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle("active", links[i].getAttribute("data-nav") === id);
    }
    var panels = document.querySelectorAll(".pane .panel");
    for (var j = 0; j < panels.length; j++) panels[j].classList.remove("on");
    var target = $("pane-" + id);
    if (target) target.classList.add("on");
    var railTitle = $("railTitle");
    if (railTitle) railTitle.textContent = TITLES[id] || "首页";
    if (pushHash !== false) location.hash = "#/" + id;
    var content = document.querySelector("main.content");
    if (content) content.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function paneFromHash() {
    var m = /^#\/([a-z]+)/.exec(location.hash || "");
    return m ? m[1] : "";
  }

  // ── 全站数据缓存（bootstrap 一次取回，各视图共用）────────

  var store = { overview: null, users: null, invites: null, site: null, resets: null, security: null, update: null };

  function load() {
    return api("/admin/api/bootstrap").then(function (b) {
      if (!b) return;
      store.overview = b.overview;
      store.users = b.users;
      store.invites = b.invites;
      store.site = b.site;
      store.resets = b.resets;
      store.security = b.security;
      store.update = b.update;
      renderRail();
      renderHome();
      renderStudents();
      renderAccess();
      renderModel();
      renderRelease();
      renderKeys();
      renderSecurity();
    });
  }

  // ── 报头时钟 + 左栏运行信息（rail-meta）──────────────────

  function tickClock() {
    var now = new Date();
    var week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
    var d = $("phDate");
    var w = $("phWeek");
    if (d) {
      d.textContent = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    }
    if (w) w.textContent = "星期" + week + " · 值班中";
  }

  function renderRail() {
    var o = store.overview;
    if (!o) return;
    var meta = $("railMeta");
    if (meta) {
      meta.textContent = "";
      var lines = [
        (o.version ? "v" + o.version : "") + " · 运行 " + uptimeText(o.uptimeSec),
        "在线实例 " + o.online + " / " + o.capacity,
        "注册同学 " + o.users + " · 可用邀请码 " + o.invitesLeft,
      ];
      for (var i = 0; i < lines.length; i++) meta.appendChild(el("div", null, lines[i]));
    }
    // 目录导航右侧的等宽计数（待审、在册）
    var pending = $("navCountAccess");
    if (pending) {
      var n = (store.resets && store.resets.pending && store.resets.pending.length) || 0;
      pending.textContent = n > 0 ? "待审 " + n : "";
      pending.classList.toggle("warn", n > 0);
    }
    var cnt = $("navCountStudents");
    if (cnt) cnt.textContent = o.users ? String(o.users) : "";
  }

  // ── 首页：hero + 功能大厅式目录 ──────────────────────────

  function keyBadge(site) {
    if (!site) return ["Key 状态未知", ""];
    if (site.deepseekKeySet) return ["站点 Key 已设置", ""];
    if (site.envDeepseekKeySet) return ["回退 env Key", ""];
    return ["Key 未设置", "warn"];
  }

  function renderHome() {
    var o = store.overview;
    var site = store.site;
    if (!o) return;
    var own = o.ownTurnsToday || 0;
    $("homeStats").textContent = "";
    var stats = [
      [String(o.users), "在册同学"],
      [o.online + " / " + o.capacity, "在线实例"],
      [String(o.invitesLeft), "可用邀请码"],
      [String(o.turnsToday) + (own > 0 ? " +" + own : ""), "今日对话轮数"],
    ];
    for (var i = 0; i < stats.length; i++) {
      var cell = el("div", "hstat");
      cell.appendChild(el("b", null, stats[i][0]));
      cell.appendChild(el("span", null, stats[i][1]));
      $("homeStats").appendChild(cell);
    }
    var pend = (store.resets && store.resets.pending && store.resets.pending.length) || 0;
    var upd = store.update && store.update.overview;
    var kb = keyBadge(site);
    var cards = [
      {
        nav: "students",
        t: "同学",
        d: "在册名录与每人档案：状态、来源、Key 模式、用量与实例",
        badge: o.online > 0 ? "在线 " + o.online : "",
        warn: false,
      },
      { nav: "access", t: "准入", d: "邀请码的生成与档案 · 忘记密码的审批与一次性码", badge: pend > 0 ? "待审 " + pend : "", warn: pend > 0 },
      { nav: "model", t: "模型与额度", d: "站点统一 DeepSeek Key · 每日对话限额 · 分账统计", badge: kb[0], warn: kb[1] === "warn" },
      {
        nav: "release",
        t: "版本",
        d: "同学端安装包的网页发版 · 分发版本与回滚",
        badge: upd && !upd.unavailable && !upd.error && upd.data && upd.data.current ? "分发 v" + upd.data.current.version : "未接入",
        warn: upd && (upd.unavailable || upd.error),
      },
      { nav: "keys", t: "密钥", d: "更新后台面板密钥：命令行发版与后台登录用", badge: "", warn: false },
      {
        nav: "security",
        t: "安全",
        d: "管理台两步验证（TOTP）：动态码 + 恢复码",
        badge: store.security && store.security.mfaEnabled ? "已启用" : "未启用",
        warn: !(store.security && store.security.mfaEnabled),
      },
    ];
    var grid = $("homeDir");
    grid.textContent = "";
    for (var j = 0; j < cards.length; j++) {
      var c = cards[j];
      var card = el("button", "hall-card");
      card.type = "button";
      card.setAttribute("data-nav", c.nav);
      var top = el("div", "hall-card-top");
      var ico = el("span", "hall-ico");
      ico.innerHTML = ICONS[c.nav] || "";
      top.appendChild(ico);
      top.appendChild(el("b", null, c.t));
      if (c.badge) {
        var badge = el("span", "hall-badge" + (c.warn ? " warn" : ""), c.badge);
        top.appendChild(badge);
      }
      top.appendChild(el("span", "hall-go", "→"));
      card.appendChild(top);
      card.appendChild(el("span", null, c.d));
      grid.appendChild(card);
    }
    // 页脚运行注记：三层 Key 链路与回收说明（web hall-note 同语言）
    var note = $("homeNote");
    if (note) {
      var keyLine = !site
        ? ""
        : site.deepseekKeySet
          ? "站点统一 Key：面板已设置（" + esc(site.deepseekKeyMasked) + "），新拉起实例即用"
          : site.envDeepseekKeySet
            ? "站点统一 Key：面板未设置，回退服务器 env（GATEWAY_DEEPSEEK_KEY）"
            : "站点统一 Key：未设置——同学须在网页「设置 → AI 模型」填自己的 Key";
      note.innerHTML =
        "实例按需拉起、空闲 30 分钟自动回收；每人每日限额默认 " +
        esc(site ? site.defaultDailyTurns : "—") +
        " 轮，可在「同学」档案里按人另设。<br>" +
        keyLine;
    }
  }

  // ── 同学：名录 + 个人档案（知识库页的列表 / 详情语言）────

  var studentFilter = "";
  var openStudent = "";

  function inviteByUser() {
    var byUser = {};
    (store.invites || []).forEach(function (i) {
      (i.usedBy || []).forEach(function (u) {
        if (String(u).indexOf("pending-") !== 0) byUser[u] = i;
      });
    });
    return byUser;
  }

  function quotaLine(u, defLimit) {
    var limit = u.dailyTurns > 0 ? u.dailyTurns : defLimit;
    var own = u.ownTurns && u.ownTurns.count ? ' <span class="ok">+自 ' + u.ownTurns.count + "</span>" : "";
    var lim = u.dailyTurns > 0
      ? ' <b class="hot" title="个人限额，覆盖站点默认 ' + defLimit + ' 轮">/ ' + limit + "</b>"
      : " / " + limit;
    return u.turns.count + lim + own;
  }

  function renderStudents() {
    var list = store.users || [];
    var site = store.site || {};
    var defLimit = Number(site.defaultDailyTurns) || 0;
    var byUser = inviteByUser();
    var box = $("studentList");
    if (!box) return;
    $("studentCount").textContent = list.length ? "共 " + list.length + " 人" : "";
    var kw = studentFilter.trim().toLowerCase();
    var shown = list.filter(function (u) {
      return !kw || String(u.username).toLowerCase().indexOf(kw) >= 0;
    });
    box.textContent = "";
    if (!list.length) {
      box.appendChild(el("p", "empty", "还没有同学注册。发出邀请码后，同学在 /register 凭码注册。"));
      return;
    }
    if (!shown.length) {
      box.appendChild(el("p", "empty", "没有匹配「" + studentFilter + "」的同学"));
      return;
    }
    for (var i = 0; i < shown.length; i++) {
      var u = shown[i];
      var row = el("button", "st-row");
      row.type = "button";
      row.setAttribute("data-student", u.username);
      if (u.username === openStudent) row.classList.add("active");
      var head = el("div", "st-row-top");
      head.appendChild(el("span", "dot" + (u.online ? "" : " off")));
      head.appendChild(el("b", null, u.username));
      if (u.disabled) head.appendChild(el("span", "hall-badge warn", "已停用"));
      else if (u.online) head.appendChild(el("span", "hall-badge", "在线"));
      if (u.dsMode === "site") head.appendChild(el("span", "hall-badge", "站点额度"));
      var q = el("span", "st-quota mono");
      q.innerHTML = quotaLine(u, defLimit);
      head.appendChild(q);
      head.appendChild(el("span", "hall-go", "→"));
      row.appendChild(head);
      var inv = byUser[u.username];
      row.appendChild(el("span", "st-sub", (inv ? (inv.note || "邀请码 " + inv.code) : "来源未知") + " · 注册于 " + fmtDate(u.createdAt)));
      box.appendChild(row);
    }
    renderStudentDossier(defLimit, byUser);
  }

  function renderStudentDossier(defLimit, byUser) {
    var box = $("studentDossier");
    if (!box) return;
    var u = (store.users || []).filter(function (x) {
      return x.username === openStudent;
    })[0];
    if (!u) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    box.hidden = false;
    box.textContent = "";
    var head = el("div", "dos-head");
    var back = el("button", "tbtn", "← 返回名录");
    back.type = "button";
    back.id = "studentBack";
    head.appendChild(back);
    head.appendChild(el("span", "dos-name mono", u.username));
    box.appendChild(head);
    var inv = byUser[u.username];
    var rows = [
      ["状态", u.disabled ? "已停用（无法登录）" : "正常"],
      ["Key 模式", u.dsMode === "site" ? "钉在站点免费额度（自己的 Key 保留不用）" : "自有优先（有自己的 Key 就用自己的）"],
      ["今日站点轮数", quotaLine(u, defLimit)],
      ["来源邀请码", inv ? (inv.note ? inv.note + "（" + inv.code + "）" : inv.code) : "—"],
      ["注册于", fmtDate(u.createdAt)],
      [
        "专属实例",
        u.online
          ? "在线 · 启动 " + fmtTime(u.startedAt) + " · 最近活跃 " + fmtTime(u.lastRequestAt) + (u.restarts > 0 ? " · 曾自动重启 " + u.restarts + " 次" : "")
          : "未运行（空闲回收，下次访问冷启动 3-5 秒）",
      ],
    ];
    var body = el("div", "dos-body");
    for (var i = 0; i < rows.length; i++) {
      var line = el("div", "dos-row");
      line.appendChild(el("span", "dos-k", rows[i][0]));
      var v = el("span", "dos-v");
      if (rows[i][0] === "今日站点轮数") v.innerHTML = rows[i][1];
      else v.textContent = rows[i][1];
      line.appendChild(v);
      body.appendChild(line);
    }
    box.appendChild(body);
    var acts = el("div", "dos-acts");
    var mk = function (label, what, cls) {
      var b = el("button", "tbtn" + (cls ? " " + cls : ""), label);
      b.type = "button";
      b.setAttribute("data-do", what);
      b.setAttribute("data-u", u.username);
      if (what === "quota") b.setAttribute("data-cur", String(u.dailyTurns || 0));
      return b;
    };
    acts.appendChild(mk("设每日限额", "quota"));
    if (u.disabled) acts.appendChild(mk("恢复登录", "enable"));
    else acts.appendChild(mk("停用账号", "disable", "danger"));
    if (u.online) acts.appendChild(mk("回收实例", "kick", "danger"));
    box.appendChild(acts);
    var hint = el("p", "dos-hint");
    hint.textContent = "停用立即禁止登录；回收实例后该同学下次访问重新拉起（新模式与新限额即刻生效）。托管凭证仍加密保留在服务器。";
    box.appendChild(hint);
  }

  // ── 准入：邀请码 + 密码重置 ───────────────────────────────

  function renderAccess() {
    var invites = store.invites || [];
    var resets = store.resets || { pending: [], codes: [] };
    // 邀请码档案
    var invBox = $("inviteList");
    if (invBox) {
      invBox.textContent = "";
      if (!invites.length) {
        invBox.appendChild(el("p", "empty", "暂无邀请码，用上方表单生成"));
      } else {
        for (var i = 0; i < invites.length; i++) {
          var inv = invites[i];
          var users = (inv.usedBy || []).filter(function (u) {
            return String(u).indexOf("pending-") !== 0;
          });
          var used = (inv.usedBy || []).length >= (inv.maxUses || 1);
          var expired = !used && inv.expiresAt && new Date(inv.expiresAt) < new Date();
          var state = used ? "已使用" : expired ? "已过期" : inv.expiresAt ? fmtDate(inv.expiresAt) + " 前有效" : "未使用";
          var row = el("div", "inv-row");
          var code = el("b", "mono inv-code", inv.code);
          row.appendChild(code);
          row.appendChild(el("span", "hall-badge", state));
          row.appendChild(el("span", "inv-note", inv.note || "—"));
          row.appendChild(el("span", "inv-used mono", users.length ? users.join("、") : "—"));
          if (!used && !expired) {
            var cp = el("button", "tbtn", "复制");
            cp.type = "button";
            cp.setAttribute("data-copy", inv.code);
            row.appendChild(cp);
          }
          invBox.appendChild(row);
        }
      }
    }
    // 重置审批
    var pend = resets.pending || [];
    var codes = resets.codes || [];
    var pendBox = $("resetPending");
    if (pendBox) {
      pendBox.textContent = "";
      if (!pend.length) {
        pendBox.appendChild(el("p", "empty", "没有待审批的申请。同学在登录页点「忘记密码」提交后出现在这里。"));
      } else {
        for (var j = 0; j < pend.length; j++) {
          var q = pend[j];
          var rrow = el("div", "inv-row");
          rrow.appendChild(el("b", "mono", q.username));
          rrow.appendChild(el("span", "inv-used mono", fmtTime(q.requestedAt)));
          var ok = el("button", "tbtn", "同意并生成码");
          ok.type = "button";
          ok.setAttribute("data-approve", q.id);
          var no = el("button", "tbtn danger", "拒绝");
          no.type = "button";
          no.setAttribute("data-reject", q.id);
          rrow.appendChild(ok);
          rrow.appendChild(no);
          pendBox.appendChild(rrow);
        }
      }
    }
    var codeBox = $("resetCodes");
    if (codeBox) {
      codeBox.textContent = "";
      if (!codes.length) {
        codeBox.appendChild(el("p", "empty", "暂无有效重置码"));
      } else {
        for (var k = 0; k < codes.length; k++) {
          var c = codes[k];
          var expiredCode = new Date(c.expiresAt) < new Date();
          var crow = el("div", "inv-row");
          crow.appendChild(el("span", "mono", c.username));
          crow.appendChild(el("b", "hot mono", c.code));
          crow.appendChild(el("span", "inv-used mono", "至 " + fmtTime(c.expiresAt)));
          if (expiredCode) {
            crow.appendChild(el("span", "hall-badge", "已过期"));
          } else {
            var ccp = el("button", "tbtn", "复制");
            ccp.type = "button";
            ccp.setAttribute("data-copy", c.code);
            crow.appendChild(ccp);
          }
          codeBox.appendChild(crow);
        }
      }
    }
  }

  // ── 模型与额度 ────────────────────────────────────────────

  function renderModel() {
    var s = store.site;
    if (!s) return;
    var state = $("keyState");
    if (state) {
      state.textContent = s.deepseekKeySet
        ? "当前：面板已设置 " + s.deepseekKeyMasked
        : s.envDeepseekKeySet
          ? "面板未设置，回退服务器 env 的 GATEWAY_DEEPSEEK_KEY"
          : "未设置（同学须在网页「设置 → AI 模型」填自己的 Key）";
    }
    $("defaultTurns").textContent = s.defaultDailyTurns;
    var list = store.users || [];
    var pinned = list.filter(function (u) {
      return u.dsMode === "site";
    }).length;
    var today = new Date().toISOString().slice(0, 10);
    var ownActive = list.filter(function (u) {
      return u.ownTurns && u.ownTurns.date === today && u.ownTurns.count > 0;
    }).length;
    var o = store.overview;
    var el2 = $("quotaStats");
    if (el2) {
      el2.textContent = "";
      var mk = function (k, v) {
        var line = el("div", "dos-row");
        line.appendChild(el("span", "dos-k", k));
        line.appendChild(el("span", "dos-v mono", v));
        el2.appendChild(line);
      };
      mk("站点默认限额", "每人每日 " + (s.defaultDailyTurns || "—") + " 轮；「同学」档案里可按人另设（0 = 用默认）");
      mk("今日站点账", (o ? o.turnsToday : "—") + " 轮（统一 Key 计费，受限额拦截）");
      mk("今日自有账", (o ? o.ownTurnsToday : "—") + " 轮（同学自己的 Key，不占额度仅计数）");
      mk("Key 模式分布", "共 " + list.length + " 人：钉在站点额度 " + pinned + " 人，其余「自有优先」；今日用自己的 Key 对话过 " + ownActive + " 人");
    }
  }

  // ── 安全设置（TOTP）──────────────────────────────────────

  function showRecoveryCodes(codes, needRelogin) {
    var boxEl = $("mfaCodesBox") || $("mfaSetupBox");
    if (!boxEl) return;
    boxEl.textContent = "";
    boxEl.appendChild(el("div", "notice", "恢复码仅此一次展示，请立即抄写或截图保存——手机不在身边时，每枚可替代动态码登录一次："));
    var p = el("p", "codes");
    p.textContent = codes.join("  ·  ");
    boxEl.appendChild(p);
    var acts = el("div", "dos-acts");
    var cp = el("button", "tbtn", "复制全部");
    cp.type = "button";
    cp.setAttribute("data-copy", codes.join("\n"));
    acts.appendChild(cp);
    if (needRelogin) {
      var go = el("button", "tbtn", "已保存，去重新登录");
      go.type = "button";
      go.id = "mfaRelogin";
      acts.appendChild(go);
    }
    boxEl.appendChild(acts);
    boxEl.hidden = false;
  }

  function renderSecurity() {
    var sec = store.security;
    if (!sec) return;
    var boxEl = $("mfaCard");
    if (!boxEl) return;
    boxEl.textContent = "";
    if (!sec.mfaEnabled) {
      boxEl.appendChild(
        el(
          "p",
          "lead",
          "当前登录仅需管理密码。建议启用两步验证：之后登录还需输入手机验证器（Google / Microsoft Authenticator、1Password 等）的 6 位动态码，密码泄露也进不来。",
        ),
      );
      var setup = el("button", "tbtn", "启用两步验证");
      setup.type = "button";
      setup.id = "mfaSetup";
      var wrap = el("div", "dos-acts");
      wrap.appendChild(setup);
      boxEl.appendChild(wrap);
      var sbox = el("div", null);
      sbox.id = "mfaSetupBox";
      sbox.style.marginTop = "14px";
      boxEl.appendChild(sbox);
      return;
    }
    boxEl.appendChild(
      el(
        "p",
        "lead",
        "已启用（" + fmtDate(sec.enabledAt) + " 起）——登录需管理密码 + 6 位动态码。恢复码剩余 " + sec.recoveryLeft + " 枚。",
      ),
    );
    var cbox = el("div", null);
    cbox.id = "mfaCodesBox";
    cbox.style.marginTop = "12px";
    boxEl.appendChild(cbox);
    var acts = el("div", "dos-acts");
    var input = el("input", null);
    input.id = "mfaCodeInput";
    input.placeholder = "当前动态码（或恢复码）";
    input.autocomplete = "off";
    input.inputMode = "numeric";
    acts.appendChild(input);
    var regen = el("button", "tbtn", "重新生成恢复码");
    regen.type = "button";
    regen.id = "mfaRegen";
    var off = el("button", "tbtn danger", "关闭两步验证");
    off.type = "button";
    off.id = "mfaOff";
    acts.appendChild(regen);
    acts.appendChild(off);
    boxEl.appendChild(acts);
    var hint = el("p", "dos-hint");
    hint.textContent = "关闭与重生成都要再验一次动态码，防止会话被劫持后降级安全。手机与恢复码全部丢失时，需 SSH 上机执行 admin.mjs totp off 兜底。";
    boxEl.appendChild(hint);
  }

  // ── 版本发布 ──────────────────────────────────────────────

  var updState = { file: null, xhr: null, versionTouched: false };

  function nextPatch(v) {
    var p = String(v || "").split(".");
    var a = Number(p[0]);
    var b = Number(p[1]);
    var c = Number(p[2]);
    if (![a, b, c].every(Number.isFinite)) return "";
    return a + "." + b + "." + (c + 1);
  }

  function prefillVersion(curVer) {
    if (updState.versionTouched) return;
    var input = $("updVer");
    var next = curVer ? nextPatch(curVer) : "";
    input.value = next;
    input.placeholder = curVer ? next : "1.0.0";
  }

  function updPickFile(f) {
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) {
      alert("只支持 zip 格式的安装包");
      return;
    }
    if (f.size > 200 * 1048576) {
      alert("安装包超过 200 MB 上限（当前 " + (f.size / 1048576).toFixed(1) + " MB）");
      return;
    }
    updState.file = f;
    var box = $("updFileBox");
    box.textContent = "";
    var chip = el("div", "file-chip");
    chip.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>';
    chip.appendChild(el("span", "name", f.name));
    chip.appendChild(el("span", "size", (f.size / 1048576).toFixed(1) + " MB"));
    var rm = el("button", "tbtn", "移除");
    rm.type = "button";
    rm.id = "updClear";
    chip.appendChild(rm);
    box.appendChild(chip);
  }

  function updPublish() {
    if (updState.xhr) return;
    var ver = $("updVer").value.trim();
    var notes = $("updNotes").value.trim();
    if (!/^\d+\.\d+\.\d+$/.test(ver)) {
      alert("版本号必须是 x.y.z 格式，例如 1.2.3");
      return;
    }
    if (!updState.file) {
      alert("请先选择 zip 安装包");
      return;
    }
    var xhr = new XMLHttpRequest();
    updState.xhr = xhr;
    uploading = true;
    var prog = $("updProg");
    var bar = $("updBar");
    var pct = $("updPct");
    var phase = $("updPhase");
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
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = function () {
      updState.xhr = null;
      uploading = false;
      prog.hidden = true;
      var data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch (err) {
        /* 空响应体按失败处理 */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        alert("v" + ver + " 已发布，学生端下次启动 raptor 时提示更新。");
        $("updNotes").value = "";
        $("updFileBox").textContent = "";
        updState.file = null;
        updState.versionTouched = false;
        load();
      } else {
        alert((data && data.error) || "发布失败（HTTP " + xhr.status + "）");
      }
    };
    xhr.onerror = function () {
      updState.xhr = null;
      uploading = false;
      prog.hidden = true;
      alert("网络错误，请检查与网关的连接");
    };
    xhr.onabort = function () {
      updState.xhr = null;
      uploading = false;
      prog.hidden = true;
    };
    xhr.send(updState.file);
  }

  function renderRelease() {
    var o = store.update && store.update.overview;
    var v = store.update && store.update.versions;
    if (!o) return;
    var card = $("updCard");
    var cur = $("updCur");
    if (o.unavailable || o.error) {
      cur.textContent = "";
      card.textContent = "";
      card.appendChild(el("div", "notice", o.error || "更新后台未接入"));
      card.appendChild(
        el(
          "p",
          "lead",
          "在网关环境变量配置 GATEWAY_UPDATE_URL 与 GATEWAY_UPDATE_TOKEN，并部署更新后台（update/update-server.mjs）后，这里会显示版本列表与回滚操作。",
        ),
      );
      var retry = el("button", "tbtn", "重试");
      retry.type = "button";
      retry.id = "updRetry";
      card.appendChild(retry);
      return;
    }
    var c = o.data && o.data.current;
    cur.textContent = c ? "当前分发 v" + c.version + " · " + fmtDate(c.publishedAt) : "尚未发布过版本";
    prefillVersion(c ? c.version : "");
    card.textContent = "";
    if (!v || v.error || v.unavailable) {
      card.appendChild(el("p", "empty", (v && (v.error || "无版本")) || "无版本"));
      return;
    }
    var list = v.data.versions || [];
    if (!list.length) {
      card.appendChild(el("p", "empty", "还没有发布过版本；在上方上传第一个安装包，或在维护者机器上 npm run publish"));
      return;
    }
    var total = list.reduce(function (s, r) {
      return s + (r.sizeBytes || 0);
    }, 0);
    var meta = el("div", "upd-meta");
    meta.appendChild(el("span", null, "共 " + list.length + " 个版本 · " + mb(total)));
    meta.appendChild(el("span", null, "设为分发＝学生端下次启动即下载该版本"));
    card.appendChild(meta);
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var row = el("div", "inv-row");
      var name = el("b", "mono", "v" + r.version);
      row.appendChild(name);
      if (r.isCurrent) row.appendChild(el("span", "hall-badge", "分发中"));
      else if (r.rolledBackAt) row.appendChild(el("span", "hall-badge", "已回滚"));
      row.appendChild(el("span", "inv-note", r.notes || "—"));
      row.appendChild(el("span", "inv-used mono", fmtDate(r.publishedAt) + " · " + mb(r.sizeBytes || 0)));
      if (!r.isCurrent) {
        var rb = el("button", "tbtn", "设为分发");
        rb.type = "button";
        rb.setAttribute("data-udo", "rollback");
        rb.setAttribute("data-ver", r.version);
        var del = el("button", "tbtn danger", "删除");
        del.type = "button";
        del.setAttribute("data-udo", "delete");
        del.setAttribute("data-ver", r.version);
        row.appendChild(rb);
        row.appendChild(del);
      }
      card.appendChild(row);
    }
  }

  // ── 密钥管理 ──────────────────────────────────────────────

  function renderKeys() {
    var r = store.update && store.update.keys;
    var box = $("keyList");
    if (!box) return;
    box.textContent = "";
    if (!r || r.unavailable || r.error) {
      box.appendChild(el("p", "empty", (r && r.error) || "更新后台未接入"));
      return;
    }
    var list = (r.data && r.data.keys) || [];
    if (!list.length) {
      box.appendChild(el("p", "empty", "没有可用密钥"));
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var k = list[i];
      var row = el("div", "inv-row");
      row.appendChild(el("b", "mono", k.name));
      row.appendChild(el("span", "hall-badge", k.isEnv ? "主密钥" : "面板密钥"));
      row.appendChild(el("span", "inv-used mono", "建 " + fmtTime(k.createdAt) + " · 用 " + fmtTime(k.lastUsedAt)));
      if (!k.isEnv) {
        var del = el("button", "tbtn danger", "删除");
        del.type = "button";
        del.setAttribute("data-keydel", k.id);
        del.setAttribute("data-name", k.name);
        row.appendChild(del);
      }
      box.appendChild(row);
    }
  }

  // ── 事件（委托）──────────────────────────────────────────

  document.addEventListener("click", function (e) {
    var t = e.target.closest ? e.target.closest("button,a") : null;
    if (!t) return;
    if (t.id === "refresh" || t.id === "refreshM") {
      load();
      return;
    }
    if (t.id === "logout") {
      api("/admin/logout", {}).then(function () {
        location.href = "/admin";
      });
      return;
    }
    // 目录导航（rail 与首页宫格共用 data-nav）
    if (t.classList.contains("cat-btn") || t.classList.contains("hall-card")) {
      showPane(t.getAttribute("data-nav"));
      return;
    }
    // 同学名录行 → 打开个人档案
    if (t.classList.contains("st-row")) {
      openStudent = t.getAttribute("data-student") || "";
      renderStudents();
      var dos = $("studentDossier");
      if (dos) dos.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    if (t.id === "studentBack") {
      openStudent = "";
      renderStudents();
      return;
    }
    // 搜索输入在 keyup 里处理；下面是各动作按钮
    if (t.id === "updGo") {
      updPublish();
      return;
    }
    if (t.id === "updCancel") {
      if (updState.xhr) updState.xhr.abort();
      return;
    }
    if (t.id === "updClear") {
      updState.file = null;
      $("updFileBox").textContent = "";
      return;
    }
    if (t.id === "updRetry") {
      load();
      return;
    }
    if (t.id === "invGen") {
      api("/admin/api/invite", {
        count: Number($("invCount").value) || 1,
        note: $("invNote").value,
        days: Number($("invDays").value) || 0,
      }).then(load);
      return;
    }
    if (t.id === "keyGen") {
      api("/admin/api/update/keys", { name: $("keyName").value }).then(function (r) {
        $("keyName").value = "";
        if (!r || r.error || r.unavailable) {
          alert((r && (r.error || "更新后台不可达")) || "创建失败");
          return;
        }
        var token = r.data && r.data.token;
        var k = r.data && r.data.key;
        var box = $("keyCreated");
        box.hidden = false;
        box.textContent = "";
        box.appendChild(el("div", "notice", "密钥「" + k.name + "」已创建——明文仅此一次展示，之后无法再查看，请立即复制保存："));
        var row = el("div", "inv-row");
        var input = el("input", "mono");
        input.readOnly = true;
        input.value = token;
        input.onfocus = function () {
          this.select();
        };
        row.appendChild(input);
        var cp = el("button", "tbtn", "复制");
        cp.type = "button";
        cp.setAttribute("data-copy", token);
        row.appendChild(cp);
        box.appendChild(row);
        load();
      });
      return;
    }
    if (t.id === "siteKeySave") {
      var nk = $("siteKeyInput").value.trim();
      if (nk && !confirm("保存站点统一 DeepSeek Key（新拉起的实例生效），确认？")) return;
      api("/admin/api/site", { deepseekKey: nk }).then(function (r) {
        if (r && r.error) {
          alert(r.error);
          return;
        }
        $("siteKeyInput").value = "";
        load();
      });
      return;
    }
    if (t.id === "mfaSetup") {
      api("/admin/api/totp/setup", {}).then(function (r) {
        if (!r || r.error) {
          alert((r && r.error) || "生成二维码失败");
          return;
        }
        var box = $("mfaSetupBox");
        box.textContent = "";
        var qr = el("div", "qr");
        qr.innerHTML = r.qrSvg;
        box.appendChild(qr);
        var grouped = r.secret.replace(/(.{4})/g, "$1 ").trim();
        box.appendChild(
          el(
            "p",
            "lead",
            "用手机验证器扫描二维码（或手输密钥 " + grouped + "），然后输入验证器上当前的 6 位动态码完成绑定：",
          ),
        );
        var row = el("div", "inv-row");
        var input = el("input", null);
        input.id = "mfaVerifyCode";
        input.placeholder = "6 位动态码";
        input.inputMode = "numeric";
        input.autocomplete = "one-time-code";
        input.maxLength = 6;
        row.appendChild(input);
        var go = el("button", "tbtn", "验证并启用");
        go.type = "button";
        go.id = "mfaEnable";
        row.appendChild(go);
        box.appendChild(row);
      });
      return;
    }
    if (t.id === "mfaEnable") {
      var vcode = $("mfaVerifyCode").value.trim();
      if (!vcode) {
        alert("请输入验证器上当前的 6 位动态码");
        return;
      }
      api("/admin/api/totp/enable", { code: vcode }).then(function (r) {
        if (!r || r.error) {
          alert((r && r.error) || "启用失败");
          return;
        }
        showRecoveryCodes(r.recoveryCodes, true);
      });
      return;
    }
    if (t.id === "mfaRelogin") {
      location.href = "/admin";
      return;
    }
    if (t.id === "mfaRegen" || t.id === "mfaOff") {
      var ccode = $("mfaCodeInput").value.trim();
      if (!ccode) {
        alert("请先输入当前动态码（或恢复码）");
        return;
      }
      if (t.id === "mfaOff" && !confirm("关闭后登录仅需管理密码，确认关闭两步验证？")) return;
      api("/admin/api/totp/" + (t.id === "mfaOff" ? "disable" : "recovery"), { code: ccode }).then(function (r) {
        if (!r || r.error) {
          alert((r && r.error) || "操作失败");
          return;
        }
        if (t.id === "mfaOff") {
          alert("两步验证已关闭。当前会话已一并注销，请用管理密码重新登录。");
          location.href = "/admin";
          return;
        }
        showRecoveryCodes(r.recoveryCodes, false);
      });
      return;
    }
    if (t.hasAttribute("data-copy")) {
      var code = t.getAttribute("data-copy");
      navigator.clipboard.writeText(code).then(function () {
        t.textContent = "已复制";
        t.className = "copy-ok";
      });
      return;
    }
    var approveId = t.getAttribute("data-approve");
    var rejectId = t.getAttribute("data-reject");
    if (approveId || rejectId) {
      if (approveId) {
        if (!confirm("同意该同学的重置申请并生成一次性码（24 小时有效）？新密码将由同学自己设置。")) return;
        api("/admin/api/reset/approve", { id: approveId }).then(function (r) {
          if (!r || r.error) {
            alert((r && r.error) || "失败");
            return;
          }
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
      var vt =
        updWhat === "rollback"
          ? "把 v" + version + " 设为当前分发版本（同学端将收到它），确认？"
          : "删除 v" + version + " 的安装包（不可恢复，当前分发版本不能删），确认？";
      if (!confirm(vt)) return;
      api("/admin/api/update/" + updWhat, { version: version }).then(function (r) {
        if (r && (r.error || r.unavailable)) {
          alert(r.error || "更新后台不可达");
          return;
        }
        load();
      });
      return;
    }
    var keyId = t.getAttribute("data-keydel");
    if (keyId) {
      if (!confirm("删除密钥「" + (t.getAttribute("data-name") || "") + "」？用它发版或登录的地方会立即失效，确认？")) return;
      api("/admin/api/update/keys/delete", { id: keyId }).then(function (r) {
        if (!r || r.error || r.unavailable) {
          alert((r && (r.error || "更新后台不可达")) || "删除失败");
          return;
        }
        load();
      });
      return;
    }
    if (!doWhat || !user) return;
    if (doWhat === "quota") {
      var q = prompt("给 " + user + " 设每日对话轮数限额（0 = 用站点默认）：", t.getAttribute("data-cur") || "0");
      if (q === null) return;
      api("/admin/api/user/" + doWhat, { user: user, turns: Number(q) }).then(function (r) {
        if (r && r.error) {
          alert(r.error);
          return;
        }
        load();
      });
      return;
    }
    var confirmText =
      doWhat === "disable" ? "停用后该同学将立即无法登录，确认？" : "回收后该同学的实例立即停止，下次访问重新拉起，确认？";
    if (!confirm(confirmText)) return;
    api("/admin/api/user/" + doWhat, { user: user }).then(load);
  });

  // 同学名录搜索（知识库 kw-box 同款：/ 聚焦，Esc 清空）
  (function () {
    var box = $("studentSearch");
    if (box) {
      box.addEventListener("input", function () {
        studentFilter = box.value;
        renderStudents();
      });
      box.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") {
          box.value = "";
          studentFilter = "";
          renderStudents();
        }
      });
    }
  })();

  // 上传发版：拖拽区与版本号输入
  (function () {
    var drop = $("updDrop");
    var fileInput = $("updFile");
    if (drop && fileInput) {
      drop.addEventListener("click", function () {
        fileInput.click();
      });
      drop.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fileInput.click();
        }
      });
      drop.addEventListener("dragover", function (e) {
        e.preventDefault();
        drop.classList.add("on");
      });
      drop.addEventListener("dragleave", function () {
        drop.classList.remove("on");
      });
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
    var verInput = $("updVer");
    if (verInput) {
      verInput.addEventListener("input", function () {
        updState.versionTouched = true;
      });
    }
  })();

  // 轻量轮询：页面可见且无进行中的上传时，每 60s 重拉一次数据
  setInterval(function () {
    if (uploading || document.visibilityState !== "visible") return;
    load();
  }, 60000);

  window.addEventListener("hashchange", function () {
    var id = paneFromHash();
    if (id && id !== current) showPane(id, false);
  });

  // 报头时钟每 30s 对一次表
  tickClock();
  setInterval(tickClock, 30000);

  showPane(paneFromHash() || "home", false);
  load();
})();
