/**
 * 管理后台前端应用（Tabler 模板 + vanilla JS，无构建）。
 * 由 ui.mjs 内联进页面；数据经 /admin/api/bootstrap 一次往返带回，
 * 动作各自 POST 后整页刷新数据。#/hash 路由切换九个页面。
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

  function btn(label, cls, attrs) {
    var b = el("button", cls, label);
    b.type = "button";
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        b.setAttribute(k, attrs[k]);
      });
    }
    return b;
  }

  // ── 弹窗（Tabler modal 样式，自行控制显隐）───────────────

  var backdrop = null;

  function showModal(id) {
    var m = $(id);
    if (!m) return;
    if (!backdrop) {
      backdrop = el("div", "modal-backdrop fade show");
      backdrop.setAttribute("data-close-modal", "");
      document.body.appendChild(backdrop);
    }
    m.style.display = "block";
    m.classList.add("show");
  }

  function closeModals() {
    var open = document.querySelectorAll(".modal.show");
    for (var i = 0; i < open.length; i++) {
      open[i].classList.remove("show");
      open[i].style.display = "none";
    }
    if (backdrop) backdrop.style.display = "none";
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModals();
  });

  // ── 路由 ──────────────────────────────────────────────────

  var PANES = ["home", "users", "invites", "resets", "site", "security", "release", "keys", "log"];
  var current = "home";
  /** 发版上传进行中不自动刷新 */
  var uploading = false;

  var TITLES = {
    home: ["概览", "服务运行状态与待办"],
    users: ["用户", "注册同学、额度与实例"],
    invites: ["邀请码", "注册准入凭证"],
    resets: ["重置审批", "忘记密码的审批与一次性码"],
    site: ["站点设置", "统一 Key 与限额"],
    security: ["安全设置", "管理台两步验证"],
    release: ["版本发布", "同学端安装包分发"],
    keys: ["密钥管理", "更新后台面板密钥"],
    log: ["操作日志", "最近的管理动作"],
  };

  function showPane(id, pushHash) {
    if (PANES.indexOf(id) < 0) id = "home";
    current = id;
    var navItems = document.querySelectorAll("[data-nav-item]");
    for (var i = 0; i < navItems.length; i++) {
      navItems[i].classList.toggle("active", navItems[i].getAttribute("data-nav-item") === id);
    }
    var pages = document.querySelectorAll(".pane-page");
    for (var j = 0; j < pages.length; j++) pages[j].classList.remove("on");
    var target = $("pane-" + id);
    if (target) target.classList.add("on");
    var t = TITLES[id] || TITLES.home;
    $("pageTitle").textContent = t[0];
    $("pagePretitle").textContent = "ADMIN · " + t[0];
    if (pushHash !== false) location.hash = "#/" + id;
    window.scrollTo(0, 0);
  }

  function paneFromHash() {
    var m = /^#\/([a-z]+)/.exec(location.hash || "");
    return m ? m[1] : "";
  }

  // ── 数据 ──────────────────────────────────────────────────

  var store = { overview: null, users: null, invites: null, site: null, resets: null, security: null, update: null, log: [] };
  var userFilterText = "";
  var userFilterState = "";
  var quotaTarget = "";

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
      store.log = b.log || [];
      renderHeader();
      renderHome();
      renderUsers();
      renderInvites();
      renderResets();
      renderSite();
      renderSecurity();
      renderRelease();
      renderKeys();
      renderLog();
    });
  }

  function renderHeader() {
    var o = store.overview;
    if (!o) return;
    $("headerMeta").textContent =
      (o.version ? "v" + o.version + " · " : "") +
      "运行 " + uptimeText(o.uptimeSec) +
      " · 实例 " + o.online + "/" + o.capacity;
  }

  // ── 概览 ──────────────────────────────────────────────────

  function renderHome() {
    var o = store.overview;
    if (!o) return;
    var own = o.ownTurnsToday || 0;
    var stats = $("homeStats");
    stats.textContent = "";
    var cells = [
      ["注册同学", String(o.users), "users"],
      ["在线实例", o.online + " / " + o.capacity, "activity"],
      ["可用邀请码", String(o.invitesLeft), "ticket"],
      ["今日对话轮数", String(o.turnsToday) + (own > 0 ? " +" + own : ""), "message"],
    ];
    cells.forEach(function (c) {
      var col = el("div", "col-sm-6 col-lg-3");
      var card = el("div", "card card-sm");
      var body = el("div", "card-body");
      body.appendChild(el("div", "subheader", c[0]));
      body.appendChild(el("div", "h1 mb-0", c[1]));
      card.appendChild(body);
      col.appendChild(card);
      stats.appendChild(col);
    });

    // 待办警示：待审批 / Key 未设 / 更新后台未接入 / 2FA 未启用
    var alerts = $("homeAlerts");
    alerts.textContent = "";
    var site = store.site;
    var pend = (store.resets && store.resets.pending && store.resets.pending.length) || 0;
    var upd = store.update && store.update.overview;
    var mfaOn = store.security && store.security.mfaEnabled;
    var items = [];
    if (pend > 0) {
      items.push([
        "warning",
        pend + " 条密码重置申请待审批。",
        '<a class="btn btn-sm btn-warning ms-auto" href="#/resets">去处理</a>',
      ]);
    }
    if (site && !site.deepseekKeySet && !site.envDeepseekKeySet) {
      items.push([
        "danger",
        "站点统一 DeepSeek Key 未设置——同学须自带 Key 才能对话。",
        '<a class="btn btn-sm btn-danger ms-auto" href="#/site">去设置</a>',
      ]);
    }
    if (upd && (upd.unavailable || upd.error)) {
      items.push([
        "secondary",
        "更新后台未接入：版本发布与密钥管理不可用（检查 GATEWAY_UPDATE_URL / GATEWAY_UPDATE_TOKEN）。",
        "",
      ]);
    }
    if (!mfaOn) {
      items.push([
        "warning",
        "两步验证未启用，管理台仅凭密码即可登录。",
        '<a class="btn btn-sm btn-warning ms-auto" href="#/security">去启用</a>',
      ]);
    }
    if (!items.length) {
      var okCol = el("div", "col-12");
      okCol.appendChild(el("div", "alert alert-success", "一切正常，没有待办。"));
      alerts.appendChild(okCol);
    } else {
      items.forEach(function (it) {
        var col = el("div", "col-12");
        var a = el("div", "alert alert-" + it[0] + " d-flex align-items-center");
        a.innerHTML = "<div>" + esc(it[1]) + "</div>" + it[2];
        col.appendChild(a);
        alerts.appendChild(col);
      });
    }

    var list = $("homeLog");
    list.textContent = "";
    if (!store.log.length) {
      list.appendChild(el("li", "list-group-item text-secondary", "暂无记录"));
    } else {
      store.log.slice(0, 8).forEach(function (entry) {
        var li = el("li", "list-group-item d-flex justify-content-between");
        li.appendChild(el("span", null, entry.text));
        li.appendChild(el("span", "text-secondary small", fmtTime(entry.at)));
        list.appendChild(li);
      });
    }
    var badge = $("navResetBadge");
    if (badge) {
      badge.hidden = pend === 0;
      badge.textContent = String(pend);
    }
  }

  // ── 用户 ──────────────────────────────────────────────────

  function inviteByUser() {
    var byUser = {};
    (store.invites || []).forEach(function (i) {
      (i.usedBy || []).forEach(function (u) {
        if (String(u).indexOf("pending-") !== 0) byUser[u] = i;
      });
    });
    return byUser;
  }

  function quotaCell(u, defLimit) {
    var limit = u.dailyTurns > 0 ? u.dailyTurns : defLimit;
    var text = u.turns.count + " / " + limit;
    var cell = el("td", "mono");
    cell.textContent = text;
    if (u.dailyTurns > 0) {
      var tip = el("span", "badge bg-warning-lt ms-1", "个人");
      tip.title = "个人限额，覆盖站点默认 " + defLimit + " 轮";
      cell.appendChild(tip);
    }
    if (u.ownTurns && u.ownTurns.count) {
      var own = el("span", "badge bg-success-lt ms-1", "+自" + u.ownTurns.count);
      own.title = "自己 Key 的轮数（不限额）";
      cell.appendChild(own);
    }
    return cell;
  }

  function userDetailHtml(u, defLimit, inv) {
    var rows = [
      ["状态", u.disabled ? "已停用（无法登录）" : "正常"],
      ["Key 模式", u.dsMode === "site" ? "钉在站点免费额度（自己的 Key 保留不用）" : "自有优先（有自己的 Key 就用自己的）"],
      ["今日站点轮数", u.turns.count + " / " + (u.dailyTurns > 0 ? u.dailyTurns : defLimit)],
      ["今日自有轮数", u.ownTurns && u.ownTurns.count ? String(u.ownTurns.count) : "0"],
      ["来源邀请码", inv ? (inv.note ? inv.note + "（" + inv.code + "）" : inv.code) : "—"],
      ["注册于", fmtDate(u.createdAt)],
      [
        "专属实例",
        u.online
          ? "在线 · 启动 " + fmtTime(u.startedAt) + " · 最近活跃 " + fmtTime(u.lastRequestAt) + (u.restarts > 0 ? " · 曾重启 " + u.restarts + " 次" : "")
          : "未运行（空闲回收，下次访问 3-5 秒冷启动）",
      ],
    ];
    return rows
      .map(function (r) {
        return '<div class="datagrid-item"><div class="datagrid-title">' + esc(r[0]) + '</div><div class="datagrid-content">' + esc(r[1]) + "</div></div>";
      })
      .join("");
  }

  function renderUsers() {
    var list = store.users || [];
    var site = store.site || {};
    var defLimit = Number(site.defaultDailyTurns) || 0;
    var byUser = inviteByUser();
    var rows = $("userRows");
    if (!rows) return;
    var kw = userFilterText.trim().toLowerCase();
    var shown = list.filter(function (u) {
      if (kw && String(u.username).toLowerCase().indexOf(kw) < 0) return false;
      if (userFilterState === "active") return !u.disabled;
      if (userFilterState === "disabled") return u.disabled;
      if (userFilterState === "online") return Boolean(u.online);
      return true;
    });
    rows.textContent = "";
    if (!list.length) {
      rows.appendChild(el("tr", null, "")).innerHTML = '<td colspan="8" class="text-secondary">还没有同学注册</td>';
      return;
    }
    if (!shown.length) {
      rows.innerHTML = '<tr><td colspan="8" class="text-secondary">没有匹配的用户</td></tr>';
      return;
    }
    shown.forEach(function (u) {
      var tr = el("tr");

      var name = el("td");
      name.appendChild(el("span", "mono fw-bold", u.username));
      tr.appendChild(name);

      var st = el("td");
      st.innerHTML = u.disabled
        ? '<span class="badge bg-danger-lt">已停用</span>'
        : '<span class="badge bg-success-lt">正常</span>';
      tr.appendChild(st);

      var key = el("td");
      key.innerHTML =
        u.dsMode === "site"
          ? '<span class="badge bg-warning-lt" title="自己的 Key 保留不用">站点额度</span>'
          : '<span class="badge bg-info-lt" title="有自己的 Key 就用自己的，否则用站点 Key">自有优先</span>';
      tr.appendChild(key);

      var on = el("td");
      if (u.online) {
        var tip =
          "启动 " + fmtTime(u.startedAt) + " · 最近活跃 " + fmtTime(u.lastRequestAt) +
          (u.restarts > 0 ? " · 曾重启 " + u.restarts + " 次" : "");
        on.innerHTML = '<span class="status status-green" title="' + esc(tip) + '"></span> 在线';
      } else {
        on.innerHTML = '<span class="status status-secondary"></span> —';
      }
      tr.appendChild(on);

      var inv = byUser[u.username];
      var src = el("td", null, inv ? inv.note || inv.code : "—");
      if (inv) src.title = inv.note ? "邀请码 " + inv.code : "凭此码注册";
      tr.appendChild(src);

      tr.appendChild(el("td", "mono", fmtDate(u.createdAt)));
      tr.appendChild(quotaCell(u, defLimit));

      var acts = el("td");
      acts.className = "text-end";
      var group = el("div", "btn-group");
      group.appendChild(btn("限额", "btn btn-sm btn-outline-secondary", {
        "data-do": "quota",
        "data-u": u.username,
        "data-cur": String(u.dailyTurns || 0),
      }));
      group.appendChild(btn("详情", "btn btn-sm btn-outline-secondary", { "data-detail": u.username }));
      tr.appendChild(acts);
      acts.appendChild(group);
      var more = el("div", "btn-group ms-1");
      if (u.disabled) {
        more.appendChild(btn("启用", "btn btn-sm btn-outline-success", { "data-do": "enable", "data-u": u.username }));
      } else {
        more.appendChild(btn("停用", "btn btn-sm btn-outline-warning", { "data-do": "disable", "data-u": u.username }));
      }
      if (u.online) {
        more.appendChild(btn("回收", "btn btn-sm btn-outline-warning", { "data-do": "kick", "data-u": u.username }));
      }
      more.appendChild(btn("删除", "btn btn-sm btn-outline-danger", { "data-do": "delete", "data-u": u.username }));
      acts.appendChild(more);
      rows.appendChild(tr);
    });
  }

  // ── 邀请码 ────────────────────────────────────────────────

  function renderInvites() {
    var invites = store.invites || [];
    var rows = $("inviteRows");
    if (!rows) return;
    rows.textContent = "";
    if (!invites.length) {
      rows.innerHTML = '<tr><td colspan="5" class="text-secondary">暂无邀请码，用上方表单生成</td></tr>';
      return;
    }
    invites.forEach(function (inv) {
      var users = (inv.usedBy || []).filter(function (u) {
        return String(u).indexOf("pending-") !== 0;
      });
      var used = (inv.usedBy || []).length >= (inv.maxUses || 1);
      var expired = !used && inv.expiresAt && new Date(inv.expiresAt) < new Date();
      var tr = el("tr");
      tr.appendChild(el("td", "mono", inv.code));
      tr.appendChild(el("td", null, inv.note || "—"));
      tr.appendChild(el("td", "mono", users.length ? users.join("、") : "—"));
      var st = el("td");
      st.innerHTML = used
        ? '<span class="badge bg-secondary-lt">已使用</span>'
        : expired
          ? '<span class="badge bg-secondary-lt">已过期</span>'
          : inv.expiresAt
            ? '<span class="badge bg-info-lt">' + esc(fmtDate(inv.expiresAt)) + " 前有效</span>"
            : '<span class="badge bg-success-lt">未使用</span>';
      tr.appendChild(st);
      var acts = el("td", "text-end");
      var group = el("div", "btn-group");
      if (!used && !expired) {
        group.appendChild(btn("复制", "btn btn-sm btn-outline-secondary", { "data-copy": inv.code }));
        group.appendChild(btn("删除", "btn btn-sm btn-outline-danger", { "data-invdel": inv.code }));
      }
      acts.appendChild(group);
      tr.appendChild(acts);
      rows.appendChild(tr);
    });
  }

  // ── 重置审批 ──────────────────────────────────────────────

  function renderResets() {
    var resets = store.resets || { pending: [], codes: [] };
    var pend = resets.pending || [];
    var codes = resets.codes || [];
    var rows = $("resetRows");
    if (rows) {
      rows.textContent = "";
      if (!pend.length) {
        rows.innerHTML = '<tr><td colspan="3" class="text-secondary">暂无申请。同学在登录页点「忘记密码」提交后出现在这里。</td></tr>';
      } else {
        pend.forEach(function (q) {
          var tr = el("tr");
          tr.appendChild(el("td", "mono fw-bold", q.username));
          tr.appendChild(el("td", "mono", fmtTime(q.requestedAt)));
          var acts = el("td", "text-end");
          var group = el("div", "btn-group");
          group.appendChild(btn("同意并生成码", "btn btn-sm btn-outline-success", { "data-approve": q.id }));
          group.appendChild(btn("拒绝", "btn btn-sm btn-outline-danger", { "data-reject": q.id }));
          acts.appendChild(group);
          tr.appendChild(acts);
          rows.appendChild(tr);
        });
      }
    }
    var codeRows = $("codeRows");
    if (codeRows) {
      codeRows.textContent = "";
      if (!codes.length) {
        codeRows.innerHTML = '<tr><td colspan="4" class="text-secondary">暂无有效重置码</td></tr>';
      } else {
        codes.forEach(function (c) {
          var expired = new Date(c.expiresAt) < new Date();
          var tr = el("tr");
          tr.appendChild(el("td", "mono", c.username));
          tr.appendChild(el("td", "mono fw-bold", c.code));
          tr.appendChild(el("td", "mono", "至 " + fmtTime(c.expiresAt)));
          var acts = el("td", "text-end");
          if (expired) {
            acts.innerHTML = '<span class="badge bg-secondary-lt">已过期</span>';
          } else {
            var group = el("div", "btn-group");
            group.appendChild(btn("复制", "btn btn-sm btn-outline-secondary", { "data-copy": c.code }));
            acts.appendChild(group);
          }
          tr.appendChild(acts);
          codeRows.appendChild(tr);
        });
      }
    }
  }

  // ── 站点设置 ──────────────────────────────────────────────

  function renderSite() {
    var s = store.site;
    if (!s) return;
    $("keyState").textContent = s.deepseekKeySet
      ? "当前：面板已设置 " + s.deepseekKeyMasked
      : s.envDeepseekKeySet
        ? "面板未设置，回退服务器 env 的 GATEWAY_DEEPSEEK_KEY"
        : "未设置（同学须在「设置 → AI 模型」填自己的 Key）";
    var box = $("quotaStats");
    if (!box) return;
    var list = store.users || [];
    var o = store.overview;
    var pinned = list.filter(function (u) {
      return u.dsMode === "site";
    }).length;
    var today = new Date().toISOString().slice(0, 10);
    var ownActive = list.filter(function (u) {
      return u.ownTurns && u.ownTurns.date === today && u.ownTurns.count > 0;
    }).length;
    var rows = [
      ["站点默认限额", "每人每日 " + s.defaultDailyTurns + " 轮；用户列表里可按人另设（0 = 用默认）"],
      ["今日站点账", (o ? o.turnsToday : "—") + " 轮（统一 Key 计费，超限拦截）"],
      ["今日自有账", (o ? o.ownTurnsToday : "—") + " 轮（同学自己的 Key，不占额度仅计数）"],
      ["Key 模式分布", "共 " + list.length + " 人：钉在站点额度 " + pinned + " 人，其余「自有优先」；今日用自己的 Key 对话过 " + ownActive + " 人"],
    ];
    box.innerHTML = rows
      .map(function (r) {
        return '<div class="datagrid-item"><div class="datagrid-title">' + esc(r[0]) + '</div><div class="datagrid-content">' + esc(r[1]) + "</div></div>";
      })
      .join("");
  }

  // ── 安全设置（TOTP）──────────────────────────────────────

  function showRecoveryCodes(codes, needRelogin) {
    var box = $("mfaCodesBox");
    if (!box) return;
    box.textContent = "";
    box.appendChild(
      el("div", "alert alert-warning", "恢复码仅此一次展示，请立即抄写或截图保存——手机不在身边时，每枚可替代动态码登录一次："),
    );
    var p = el("div", "recovery-codes");
    p.textContent = codes.join("  ·  ");
    box.appendChild(p);
    var acts = el("div", "d-flex gap-2 mt-2");
    acts.appendChild(btn("复制全部", "btn btn-outline-secondary", { "data-copy": codes.join("\n") }));
    if (needRelogin) {
      var go = btn("已保存，去重新登录", "btn btn-warning");
      go.id = "mfaRelogin";
      acts.appendChild(go);
    }
    box.appendChild(acts);
    box.hidden = false;
  }

  function renderSecurity() {
    var sec = store.security;
    if (!sec) return;
    var box = $("mfaCard");
    if (!box) return;
    box.textContent = "";
    if (!sec.mfaEnabled) {
      box.innerHTML =
        '<p class="text-secondary mb-2">当前登录仅需管理密码。<b>建议启用两步验证</b>：之后登录还需输入手机验证器（Google / Microsoft Authenticator、1Password 等）的 6 位动态码，密码泄露也进不来。</p>';
      var setup = btn("启用两步验证", "btn btn-primary");
      setup.id = "mfaSetup";
      box.appendChild(setup);
      var sbox = el("div");
      sbox.id = "mfaSetupBox";
      sbox.className = "mt-3";
      box.appendChild(sbox);
      return;
    }
    box.innerHTML =
      '<div class="alert alert-success">已启用（' +
      esc(fmtDate(sec.enabledAt)) +
      " 起）——登录需管理密码 + 6 位动态码。恢复码剩余 <b>" +
      sec.recoveryLeft +
      "</b> 枚。</div>";
    var cbox = el("div");
    cbox.id = "mfaCodesBox";
    cbox.className = "mt-2";
    box.appendChild(cbox);
    var row = el("div", "d-flex flex-wrap gap-2 align-items-center");
    var input = el("input", "form-control");
    input.id = "mfaCodeInput";
    input.placeholder = "当前动态码（或恢复码）";
    input.autocomplete = "off";
    input.inputMode = "numeric";
    input.style.maxWidth = "220px";
    row.appendChild(input);
    var regen = btn("重新生成恢复码", "btn btn-outline-secondary", null);
    regen.id = "mfaRegen";
    var off = btn("关闭两步验证", "btn btn-outline-danger", null);
    off.id = "mfaOff";
    row.appendChild(regen);
    row.appendChild(off);
    box.appendChild(row);
    box.appendChild(
      el("div", "text-secondary small mt-2", "关闭与重生成都要再验一次动态码，防止会话被劫持后降级安全。手机与恢复码全丢时，SSH 上机执行 admin.mjs totp off 兜底。"),
    );
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
    var row = el("div", "d-flex align-items-center gap-2 mt-2");
    row.appendChild(el("span", "badge bg-info-lt", f.name));
    row.appendChild(el("span", "text-secondary small", (f.size / 1048576).toFixed(1) + " MB"));
    row.appendChild(btn("移除", "btn btn-sm btn-outline-secondary", { id: "updClear" }));
    box.appendChild(row);
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
      card.appendChild(el("div", "alert alert-warning", o.error || "更新后台未接入"));
      card.appendChild(
        el("div", "text-secondary", "在网关环境变量配置 GATEWAY_UPDATE_URL 与 GATEWAY_UPDATE_TOKEN，并部署更新后台（update/update-server.mjs）后，这里会显示版本列表与回滚操作。"),
      );
      var retry = btn("重试", "btn btn-outline-secondary");
      retry.id = "updRetry";
      card.appendChild(retry);
      return;
    }
    var c = o.data && o.data.current;
    cur.textContent = c ? "当前分发 v" + c.version + " · " + fmtDate(c.publishedAt) : "尚未发布过版本";
    prefillVersion(c ? c.version : "");
    card.textContent = "";
    if (!v || v.error || v.unavailable) {
      card.appendChild(el("div", "text-secondary", (v && (v.error || "无版本")) || "无版本"));
      return;
    }
    var list = v.data.versions || [];
    if (!list.length) {
      card.appendChild(el("div", "text-secondary", "还没有发布过版本；在上方上传第一个安装包，或在维护者机器上 npm run publish"));
      return;
    }
    var total = list.reduce(function (s, r) {
      return s + (r.sizeBytes || 0);
    }, 0);
    card.appendChild(el("div", "text-secondary small mb-2", "共 " + list.length + " 个版本 · " + mb(total) + " · 设为分发＝学生端下次启动即下载该版本"));
    var wrap = el("div", "list-group list-group-flush");
    list.forEach(function (r) {
      var item = el("div", "list-group-item d-flex align-items-center gap-2 flex-wrap");
      item.appendChild(el("span", "mono fw-bold", "v" + r.version));
      if (r.isCurrent) item.appendChild(el("span", "badge bg-success-lt", "分发中"));
      else if (r.rolledBackAt) item.appendChild(el("span", "badge bg-secondary-lt", "已回滚"));
      item.appendChild(el("span", "text-secondary small", r.notes || "—"));
      item.appendChild(el("span", "text-secondary small ms-auto mono", fmtDate(r.publishedAt) + " · " + mb(r.sizeBytes || 0)));
      if (!r.isCurrent) {
        var group = el("div", "btn-group");
        group.appendChild(btn("设为分发", "btn btn-sm btn-outline-secondary", { "data-udo": "rollback", "data-ver": r.version }));
        group.appendChild(btn("删除", "btn btn-sm btn-outline-danger", { "data-udo": "delete", "data-ver": r.version }));
        item.appendChild(group);
      }
      wrap.appendChild(item);
    });
    card.appendChild(wrap);
  }

  // ── 密钥管理 ──────────────────────────────────────────────

  function renderKeys() {
    var r = store.update && store.update.keys;
    var rows = $("keyRows");
    if (!rows) return;
    rows.textContent = "";
    if (!r || r.unavailable || r.error) {
      rows.innerHTML = '<tr><td colspan="5" class="text-secondary">' + esc((r && r.error) || "更新后台未接入") + "</td></tr>";
      return;
    }
    var list = (r.data && r.data.keys) || [];
    if (!list.length) {
      rows.innerHTML = '<tr><td colspan="5" class="text-secondary">没有可用密钥</td></tr>';
      return;
    }
    list.forEach(function (k) {
      var tr = el("tr");
      tr.appendChild(el("td", "mono fw-bold", k.name));
      tr.appendChild(el("td", null, "")).innerHTML = k.isEnv
        ? '<span class="badge bg-secondary-lt">主密钥</span>'
        : '<span class="badge bg-info-lt">面板密钥</span>';
      tr.appendChild(el("td", "mono", fmtTime(k.createdAt)));
      tr.appendChild(el("td", "mono", fmtTime(k.lastUsedAt)));
      var acts = el("td", "text-end");
      if (!k.isEnv) {
        var group = el("div", "btn-group");
        group.appendChild(btn("删除", "btn btn-sm btn-outline-danger", { "data-keydel": k.id, "data-name": k.name }));
        acts.appendChild(group);
      }
      tr.appendChild(acts);
      rows.appendChild(tr);
    });
  }

  // ── 操作日志 ──────────────────────────────────────────────

  function renderLog() {
    var rows = $("logRows");
    if (!rows) return;
    rows.textContent = "";
    if (!store.log.length) {
      rows.innerHTML = '<tr><td colspan="2" class="text-secondary">暂无记录</td></tr>';
      return;
    }
    store.log.forEach(function (entry) {
      var tr = el("tr");
      tr.appendChild(el("td", "mono text-secondary", fmtTime(entry.at)));
      tr.appendChild(el("td", null, entry.text));
      rows.appendChild(tr);
    });
  }

  // ── 事件（委托）──────────────────────────────────────────

  document.addEventListener("click", function (e) {
    var t = e.target.closest ? e.target.closest("button,a") : null;
    if (!t) return;
    if (t.id === "refresh") {
      load();
      return;
    }
    if (t.id === "logout") {
      api("/admin/logout", {}).then(function () {
        location.href = "/admin";
      });
      return;
    }
    if (t.hasAttribute("data-open-modal")) {
      showModal(t.getAttribute("data-open-modal"));
      return;
    }
    if (t.hasAttribute("data-close-modal")) {
      closeModals();
      return;
    }
    if (t.classList.contains("nav-link") && t.hasAttribute("data-nav")) {
      showPane(t.getAttribute("data-nav"));
      // 窄屏：切页后收起侧栏菜单，别让它盖住内容
      var menu = document.getElementById("sidebar-menu");
      if (menu && menu.classList.contains("show")) {
        menu.classList.remove("show");
        var toggleBtn = document.querySelector('[data-bs-target="#sidebar-menu"]');
        if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
      }
      return;
    }
    var detail = t.getAttribute("data-detail");
    if (detail) {
      var u = (store.users || []).filter(function (x) {
        return x.username === detail;
      })[0];
      if (u) {
        var defLimit = Number((store.site || {}).defaultDailyTurns) || 0;
        $("userDetailBody").innerHTML = '<div class="datagrid">' + userDetailHtml(u, defLimit, inviteByUser()[u.username] || null) + "</div>";
        showModal("modalUserDetail");
      }
      return;
    }
    if (t.id === "userCreateGo") {
      api("/admin/api/user/create", {
        username: $("newUsername").value.trim(),
        password: $("newPassword").value,
      }).then(function (r) {
        if (!r || r.error) {
          alert((r && r.error) || "创建失败");
          return;
        }
        closeModals();
        $("newUsername").value = "";
        $("newPassword").value = "";
        alert("用户 " + r.user.username + " 已创建，可立即登录。");
        load();
      });
      return;
    }
    if (t.id === "quotaGo") {
      var turns = Number($("quotaValue").value);
      if (Number.isNaN(turns) || turns < 0) {
        alert("限额需为不小于 0 的整数（0 = 用站点默认）");
        return;
      }
      api("/admin/api/user/quota", { user: quotaTarget, turns: turns }).then(function (r) {
        if (!r || r.error) {
          alert((r && r.error) || "失败");
          return;
        }
        closeModals();
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
        var qr = el("div", "qr-box");
        qr.innerHTML = r.qrSvg;
        box.appendChild(qr);
        var grouped = r.secret.replace(/(.{4})/g, "$1 ").trim();
        box.appendChild(
          el("div", "text-secondary", "用手机验证器扫描二维码（或手输密钥 " + grouped + "），然后输入当前 6 位动态码完成绑定："),
        );
        var row = el("div", "d-flex gap-2 mt-2");
        var input = el("input", "form-control");
        input.id = "mfaVerifyCode";
        input.placeholder = "6 位动态码";
        input.inputMode = "numeric";
        input.autocomplete = "one-time-code";
        input.maxLength = 6;
        input.style.maxWidth = "160px";
        row.appendChild(input);
        var go = btn("验证并启用", "btn btn-primary", null);
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
    if (t.hasAttribute("data-copy")) {
      var code = t.getAttribute("data-copy");
      navigator.clipboard.writeText(code).then(function () {
        t.textContent = "已复制";
        t.className = "copy-ok";
      });
      return;
    }
    var invDel = t.getAttribute("data-invdel");
    if (invDel) {
      if (!confirm("删除该邀请码？（未使用才可删，不影响已注册同学）")) return;
      api("/admin/api/invite/delete", { code: invDel }).then(function (r) {
        if (!r || r.error) {
          alert((r && r.error) || "删除失败");
          return;
        }
        load();
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
    var doWhat = t.getAttribute("data-do");
    var user = t.getAttribute("data-u");
    if (!doWhat || !user) return;
    if (doWhat === "quota") {
      quotaTarget = user;
      $("quotaUser").textContent = user + "（当前：0 = 用站点默认；输入 0-100000 的整数）";
      $("quotaValue").value = t.getAttribute("data-cur") || "0";
      showModal("modalQuota");
      return;
    }
    if (doWhat === "delete") {
      if (!confirm("删除用户 " + user + "？账号、登录凭证与其专属数据目录将一并删除，不可恢复，确认？")) return;
      api("/admin/api/user/delete", { user: user }).then(function (r) {
        if (!r || r.error) {
          alert((r && r.error) || "删除失败");
          return;
        }
        load();
      });
      return;
    }
    var confirmText =
      doWhat === "disable"
        ? "停用后该同学将立即无法登录，确认？"
        : "回收后该同学的实例立即停止，下次访问重新拉起，确认？";
    if (!confirm(confirmText)) return;
    api("/admin/api/user/" + doWhat, { user: user }).then(load);
  });

  // 表单提交（阻止默认跳转，走 API）
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (f.id === "inviteForm") {
      e.preventDefault();
      api("/admin/api/invite", {
        count: Number($("invCount").value) || 1,
        note: $("invNote").value,
        days: Number($("invDays").value) || 0,
      }).then(load);
    } else if (f.id === "siteKeyForm") {
      e.preventDefault();
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
    } else if (f.id === "keyForm") {
      e.preventDefault();
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
        box.appendChild(el("div", "alert alert-warning", "密钥「" + k.name + "」已创建——明文仅此一次展示，之后无法再查看，请立即复制保存："));
        var row = el("div", "d-flex gap-2");
        var input = el("input", "form-control mono");
        input.readOnly = true;
        input.value = token;
        input.onfocus = function () {
          this.select();
        };
        row.appendChild(input);
        row.appendChild(btn("复制", "btn btn-outline-secondary", { "data-copy": token }));
        box.appendChild(row);
        load();
      });
    }
  });

  // 用户搜索与筛选
  (function () {
    var search = $("userSearch");
    if (search) {
      search.addEventListener("input", function () {
        userFilterText = search.value;
        renderUsers();
      });
    }
    var filter = $("userFilter");
    if (filter) {
      filter.addEventListener("change", function () {
        userFilterState = filter.value;
        renderUsers();
      });
    }
  })();

  // 上传发版：拖拽与版本号
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
        drop.classList.add("drag-on");
      });
      drop.addEventListener("dragleave", function () {
        drop.classList.remove("drag-on");
      });
      drop.addEventListener("drop", function (e) {
        e.preventDefault();
        drop.classList.remove("drag-on");
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

  // 页面可见且无上传进行中时，每 60s 轻量刷新
  setInterval(function () {
    if (uploading || document.visibilityState !== "visible") return;
    load();
  }, 60000);

  window.addEventListener("hashchange", function () {
    var id = paneFromHash();
    if (id && id !== current) showPane(id, false);
  });

  showPane(paneFromHash() || "home", false);
  load();
})();
