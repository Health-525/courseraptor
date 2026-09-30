/**
 * 管理台前端应用（与 src/channels/web/assets/chat-app.js 同一套交付模式：
 * 独立 JS 资产、无构建步骤，由 ui.mjs 读入后内联进页面，浏览器不多发请求）。
 *
 * 页面骨架与设计令牌对齐同学端网页（chat-page.ts 的「红头档案」应用壳）：
 * 左侧 284px 档头栏（wordmark + 分组导航，样式同会话列表）、右侧滚动内容区、
 * 窄屏退回 ☰ 左抽屉。全部数据经 /admin/api/bootstrap 一次往返带回，
 * 动作型请求各自 POST，完成后整页刷新数据。
 *
 * 面板：总览 / 同学账号 / 邀请码 / 重置审批 / 站点设置 / 安全设置 /
 * 版本发布 / 密钥管理；#hash 路由可在刷新与直达间保持位置。
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

  function fmtDate(iso) {
    return String(iso || "").slice(0, 10);
  }

  function fmtTime(iso) {
    return iso ? String(iso).replace("T", " ").slice(0, 16) : "—";
  }

  function mb(n) {
    return (n / 1048576).toFixed(1) + " MB";
  }

  // ── 面板路由（#hash）──────────────────────────────────────

  var PANES = ["overview", "users", "invites", "resets", "site", "security", "release", "keys"];
  var current = "overview";
  /** 上传发版进行中 / 恢复码未确认时，切面板不整页刷新数据，避免打断 */
  var busy = false;

  function showPane(id, pushHash) {
    if (PANES.indexOf(id) < 0) id = "overview";
    current = id;
    var items = document.querySelectorAll(".nav-item");
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle("on", items[i].getAttribute("data-nav") === id);
    }
    var panels = document.querySelectorAll(".pane .panel");
    for (var j = 0; j < panels.length; j++) panels[j].classList.remove("on");
    var target = $("pane-" + id);
    if (target) target.classList.add("on");
    if (pushHash !== false) location.hash = "#/" + id;
    document.body.classList.remove("drawer-open");
    var content = document.querySelector("main.content");
    if (content) content.scrollTop = 0;
  }

  function paneFromHash() {
    var m = /^#\/([a-z]+)/.exec(location.hash || "");
    return m ? m[1] : "";
  }

  // ── 渲染：总览 ────────────────────────────────────────────

  function uptimeText(sec) {
    var up = sec || 0;
    if (up >= 86400) return Math.floor(up / 86400) + " 天 " + Math.floor((up % 86400) / 3600) + " 小时";
    if (up >= 3600) return Math.floor(up / 3600) + " 小时 " + Math.floor((up % 3600) / 60) + " 分";
    return Math.floor(up / 60) + " 分钟";
  }

  function renderOverview(o, site) {
    if (!o) return;
    var own = o.ownTurnsToday || 0;
    $("stats").innerHTML =
      '<div class="stat"><div class="n">' +
      o.users +
      '</div><div class="t">注册同学</div></div>' +
      '<div class="stat"><div class="n hot">' +
      o.online +
      "/" +
      o.capacity +
      '</div><div class="t">在线 / 并发上限</div></div>' +
      '<div class="stat"><div class="n">' +
      o.invitesLeft +
      '</div><div class="t">可用邀请码</div></div>' +
      '<div class="stat"><div class="n hot">' +
      o.turnsToday +
      (own > 0 ? '<span style="font-size:13px;color:var(--ink-3)"> +' + own + "</span>" : "") +
      "</div><div class=\"t\">今日对话轮数" +
      (own > 0 ? "（另自有 Key +" + own + "）" : "") +
      "</div></div>";
    var up = uptimeText(o.uptimeSec);
    $("uptimeLine").textContent =
      (o.version ? "v" + o.version + " · " : "") + "运行 " + up + " · " + o.online + "/" + o.capacity + " 在线";
    var keyLine = !site
      ? ""
      : site.deepseekKeySet
        ? "站点统一 Key：面板已设置（<span class=\"mono\">" + esc(site.deepseekKeyMasked) + "</span>），新拉起实例即用"
        : site.envDeepseekKeySet
          ? "站点统一 Key：面板未设置，回退服务器 env（GATEWAY_DEEPSEEK_KEY）"
          : '站点统一 Key：<b class="hot">未设置</b>——同学须在设置里填自己的 Key';
    var todo =
      (o.pendingResets || 0) > 0
        ? '<p style="margin:10px 0 0"><a href="#/resets" class="goto">' +
          o.pendingResets +
          " 条密码重置申请待审批，点击前往处理 →</a></p>"
        : "";
    $("statusCard").innerHTML =
      '<p class="lead" style="margin-top:2px"><span class="dot' +
      (o.online > 0 ? "" : " off") +
      '"></span>网关已连续运行 ' +
      esc(up) +
      "，当前 " +
      o.online +
      " 个实例在线" +
      (o.online > 0 ? "" : "（空闲时不占内存）") +
      (o.version ? '，网关 <span class="mono">v' + esc(o.version) + "</span>（升级后在此核对）" : "") +
      "。</p>" +
      '<p style="color:var(--ink-3);font-size:13px;margin:4px 0 0">' +
      keyLine +
      "</p>" +
      '<p style="color:var(--ink-3);font-size:13px;margin:4px 0 0">实例按需拉起、空闲 30 分钟自动回收；每人每日限额默认 ' +
      esc(site ? site.defaultDailyTurns : "—") +
      " 轮，可在「同学账号」按人单独设置。</p>" +
      todo;
  }

  // ── 渲染：同学账号 ────────────────────────────────────────

  function renderUsers(list, defaultTurns, invites) {
    if (!list) return;
    // 用户名 → 注册用的邀请码（usedBy 已回填用户名，反查即得绑定关系）
    var byUser = {};
    (invites || []).forEach(function (i) {
      (i.usedBy || []).forEach(function (u) {
        if (String(u).indexOf("pending-") !== 0) byUser[u] = i;
      });
    });
    var el = $("users");
    if (!list.length) {
      el.innerHTML = '<tr><td colspan="8" class="empty">还没有同学注册</td></tr>';
      return;
    }
    var defLimit = Number(defaultTurns) || 0;
    el.innerHTML = list
      .map(function (u) {
        var inv = byUser[u.username];
        var origin = !inv
          ? "—"
          : inv.note
            ? '<span title="邀请码 ' + esc(inv.code) + '">' + esc(inv.note) + "</span>"
            : '<span class="mono" title="凭此码注册">' + esc(inv.code) + "</span>";
        var status = u.disabled
          ? '<span class="pill bad">已停用</span>'
          : '<span class="pill">正常</span>';
        var keySrc =
          u.dsMode === "site"
            ? '<span class="pill bad" title="钉在站点免费额度：自己保存的 Key 保留不用">站点额度</span>'
            : '<span class="pill" title="有自己保存的 Key 就用自己的，否则用站点 Key">自有优先</span>';
        var online = '<span class="dot off"></span>—';
        if (u.online) {
          var tip =
            "实例启动 " +
            fmtTime(u.startedAt) +
            " · 最近活跃 " +
            fmtTime(u.lastRequestAt) +
            (u.restarts > 0 ? " · 曾自动重启 " + u.restarts + " 次" : "");
          online = '<span class="dot" title="' + esc(tip) + '"></span>在线';
        }
        var limit = u.dailyTurns > 0 ? u.dailyTurns : defLimit;
        var quota =
          u.turns.count +
          (u.dailyTurns > 0
            ? '<b class="hot" title="个人限额，覆盖站点默认 ' + defLimit + ' 轮">/' + limit + "</b>"
            : '<span style="color:var(--ink-3)">/' + limit + "</span>");
        if (u.ownTurns && u.ownTurns.count) {
          quota +=
            ' <span title="自己 Key 的轮数（不限额）" style="color:var(--ok)">+自' + u.ownTurns.count + "</span>";
        }
        var acts =
          '<button class="tbtn" data-do="quota" data-u="' +
          esc(u.username) +
          '" data-cur="' +
          (u.dailyTurns || 0) +
          '">限额</button>';
        if (u.disabled) {
          acts += '<button class="tbtn" data-do="enable" data-u="' + esc(u.username) + '">启用</button>';
        } else {
          acts += '<button class="tbtn danger" data-do="disable" data-u="' + esc(u.username) + '">停用</button>';
        }
        if (u.online) {
          acts += '<button class="tbtn danger" data-do="kick" data-u="' + esc(u.username) + '">踢下线</button>';
        }
        return (
          "<tr><td class=\"mono\">" +
          esc(u.username) +
          "</td><td>" +
          status +
          "</td><td>" +
          keySrc +
          "</td><td>" +
          online +
          "</td><td>" +
          origin +
          '</td><td class="mono">' +
          fmtDate(u.createdAt) +
          '</td><td class="mono">' +
          quota +
          "</td><td>" +
          acts +
          "</td></tr>"
        );
      })
      .join("");
  }

  // ── 渲染：邀请码 ──────────────────────────────────────────

  function renderInvites(list) {
    if (!list) return;
    var el = $("invites");
    if (!list.length) {
      el.innerHTML = '<tr><td colspan="5" class="empty">暂无邀请码，用上方表单生成</td></tr>';
      return;
    }
    el.innerHTML = list
      .map(function (i) {
        // pending- 前缀是消费瞬间的占位（正常会立刻回填成用户名），展示时剔除
        var users = (i.usedBy || []).filter(function (u) {
          return String(u).indexOf("pending-") !== 0;
        });
        var used = (i.usedBy || []).length >= (i.maxUses || 1);
        var expired = !used && i.expiresAt && new Date(i.expiresAt) < new Date();
        var status = used
          ? '<span class="pill">已使用</span>'
          : expired
            ? '<span class="pill bad">已过期</span>'
            : i.expiresAt
              ? '<span class="pill bad">' + fmtDate(i.expiresAt) + " 前有效</span>"
              : '<span class="pill">未使用</span>';
        var who = users.length ? users.map(esc).join("、") : "—";
        var copy =
          used || expired ? "" : '<button class="tbtn" data-copy="' + esc(i.code) + '" type="button">复制</button>';
        return (
          '<tr><td class="mono">' +
          esc(i.code) +
          "</td><td>" +
          esc(i.note || "—") +
          '</td><td class="mono">' +
          who +
          "</td><td>" +
          status +
          "</td><td>" +
          copy +
          "</td></tr>"
        );
      })
      .join("");
  }

  // ── 渲染：密码重置审批 ────────────────────────────────────

  function renderResets(r) {
    if (!r) return;
    var pend = r.pending || [];
    var codes = r.codes || [];
    var box = $("resetBox");
    var dot = $("resetsDot");
    if (dot) dot.hidden = pend.length === 0;
    if (!pend.length && !codes.length) {
      box.innerHTML = '<p class="empty">暂无申请。同学在登录页点「忘记密码」提交后出现在这里。</p>';
      return;
    }
    var html = "";
    if (pend.length) {
      html +=
        '<table class="plain"><thead><tr><th>用户名</th><th>申请时间</th><th>操作</th></tr></thead><tbody>' +
        pend
          .map(function (q) {
            return (
              '<tr><td class="mono">' +
              esc(q.username) +
              '</td><td class="mono">' +
              esc(fmtTime(q.requestedAt)) +
              '</td><td><button class="tbtn" data-approve="' +
              esc(q.id) +
              '">同意并生成码</button>' +
              '<button class="tbtn danger" data-reject="' +
              esc(q.id) +
              '">拒绝</button></td></tr>'
            );
          })
          .join("") +
        "</tbody></table>";
    } else {
      html += '<p class="empty">没有待审批的申请。</p>';
    }
    if (codes.length) {
      html +=
        '<h2 style="margin-top:16px">有效重置码<span class="en">ACTIVE CODES</span><span class="act mono" style="font-size:11px">同意后把码发给同学，新密码由同学自己设</span></h2>' +
        '<table class="plain"><thead><tr><th>用户名</th><th>重置码</th><th>过期时间</th><th></th></tr></thead><tbody>' +
        codes
          .map(function (c) {
            var expired = new Date(c.expiresAt) < new Date();
            return (
              "<tr><td class=\"mono\">" +
              esc(c.username) +
              '</td><td class="mono"><b class="hot">' +
              esc(c.code) +
              "</b></td>" +
              '<td class="mono">' +
              esc(fmtTime(c.expiresAt)) +
              "</td><td>" +
              (expired
                ? '<span class="pill bad">已过期</span>'
                : '<button class="tbtn" data-copy="' + esc(c.code) + '" type="button">复制</button>') +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table>";
    }
    box.innerHTML = html;
  }

  // ── 渲染：站点设置 ────────────────────────────────────────

  function renderSite(s, users) {
    if (!s) return;
    $("siteKeyState").textContent = s.deepseekKeySet
      ? "当前：面板已设置 " + s.deepseekKeyMasked
      : s.envDeepseekKeySet
        ? "面板未设置，回退服务器 env 的 GATEWAY_DEEPSEEK_KEY"
        : "未设置（同学须在设置里填自己的 Key）";
    $("siteDefaultTurns").textContent = s.defaultDailyTurns;
    var list = users || [];
    var pinned = list.filter(function (u) {
      return u.dsMode === "site";
    }).length;
    var today = new Date().toISOString().slice(0, 10);
    var ownActive = list.filter(function (u) {
      return u.ownTurns && u.ownTurns.date === today && u.ownTurns.count > 0;
    }).length;
    $("dsModeLine").textContent =
      "共 " +
      list.length +
      " 位同学：钉在站点额度 " +
      pinned +
      " 人，其余「自有优先」（有自己的 Key 就用自己的）；今日用自己 Key 对话过的 " +
      ownActive +
      " 人。";
  }

  // ── 渲染：安全设置（TOTP）─────────────────────────────────

  function showRecoveryCodes(codes, needRelogin) {
    var el = $("mfaCodesBox") || $("mfaSetupBox");
    if (!el) return;
    el.innerHTML =
      '<div class="notice">恢复码仅此一次展示，请立即抄写或截图保存——手机不在身边时，每枚可替代动态码登录一次：</div>' +
      '<p class="codes">' +
      codes.map(esc).join(" &nbsp;·&nbsp; ") +
      "</p>" +
      '<div style="margin-top:8px"><button class="tbtn" data-copy="' +
      esc(codes.join("\n")) +
      '" type="button">复制全部</button>' +
      (needRelogin ? ' <button class="tbtn" id="mfaRelogin" type="button">已保存，去重新登录</button>' : "") +
      "</div>";
    el.hidden = false;
  }

  function renderSecurity(sec) {
    if (!sec) return;
    var el = $("mfaCard");
    if (!sec.mfaEnabled) {
      el.innerHTML =
        '<p class="lead" style="margin-top:2px">当前登录仅需管理密码。<b>建议启用两步验证</b>：之后登录还需输入手机验证器（Google / Microsoft Authenticator、1Password 等）的 6 位动态码，密码泄露也进不来。</p>' +
        '<div style="margin-top:12px"><button class="tbtn" id="mfaSetup" type="button" style="padding:8px 18px">启用两步验证</button></div>' +
        '<div id="mfaSetupBox" style="margin-top:14px"></div>';
      return;
    }
    el.innerHTML =
      '<p class="lead" style="margin-top:2px"><span class="dot"></span>已启用（' +
      esc(fmtDate(sec.enabledAt)) +
      " 起）——登录需管理密码 + 6 位动态码。恢复码剩余 <b class=\"mono\">" +
      sec.recoveryLeft +
      "</b> 枚。</p>" +
      '<div id="mfaCodesBox" style="margin-top:12px"></div>' +
      '<div class="row" style="margin-top:14px"><input id="mfaCodeInput" placeholder="当前动态码（或恢复码）" autocomplete="off" inputmode="numeric">' +
      '<button class="tbtn" id="mfaRegen" type="button" style="margin:0;padding:8px 18px">重新生成恢复码</button>' +
      '<button class="tbtn danger" id="mfaOff" type="button" style="margin:0;padding:8px 18px">关闭两步验证</button></div>' +
      '<p class="hint" style="margin-top:10px">关闭与重生成都要再验一次动态码，防止会话被劫持后降级安全。手机与恢复码全部丢失时，需 SSH 上机执行 admin.mjs totp off 兜底。</p>';
  }

  // ── 渲染：版本发布 ────────────────────────────────────────

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
    var el = $("updVer");
    var next = curVer ? nextPatch(curVer) : "";
    el.value = next;
    el.placeholder = curVer ? next : "1.0.0";
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
    $("updFileBox").innerHTML =
      '<div class="file-chip">' +
      '<svg viewBox="0 0 24 24"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>' +
      '<span class="name">' +
      esc(f.name) +
      '</span><span class="size">' +
      (f.size / 1048576).toFixed(1) +
      ' MB</span>' +
      '<button class="tbtn" id="updClear" type="button">移除</button></div>';
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
    busy = true;
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
      busy = false;
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
        $("updFileBox").innerHTML = "";
        updState.file = null;
        updState.versionTouched = false;
        load();
      } else {
        alert((data && data.error) || "发布失败（HTTP " + xhr.status + "）");
      }
    };
    xhr.onerror = function () {
      updState.xhr = null;
      busy = false;
      prog.hidden = true;
      alert("网络错误，请检查与网关的连接");
    };
    xhr.onabort = function () {
      updState.xhr = null;
      busy = false;
      prog.hidden = true;
    };
    xhr.send(updState.file);
  }

  function renderUpdate(o, v) {
    if (!o) return;
    var cur = $("updCur");
    var card = $("updCard");
    if (o.unavailable || o.error) {
      cur.textContent = "";
      card.innerHTML =
        '<div class="notice">' +
        esc(o.error || "更新后台未接入") +
        "</div>" +
        '<p style="color:var(--ink-2);font-size:13px">在网关环境变量配置 GATEWAY_UPDATE_URL 与 GATEWAY_UPDATE_TOKEN，并部署更新后台（update/update-server.mjs）后，这里会显示版本列表与回滚操作。</p>' +
        '<div style="margin-top:10px"><button class="tbtn" id="updRetry" type="button">重试</button></div>';
      return;
    }
    var c = o.data && o.data.current;
    cur.textContent = c ? "当前 v" + c.version + " · " + fmtDate(c.publishedAt) : "尚未发布过版本";
    prefillVersion(c ? c.version : "");
    if (!v || v.error || v.unavailable) {
      card.innerHTML = '<p class="empty">' + esc((v && (v.error || "无版本")) || "无版本") + "</p>";
      return;
    }
    var list = v.data.versions || [];
    if (!list.length) {
      card.innerHTML = '<p class="empty">还没有发布过版本；在上方上传第一个安装包，或在维护者机器上 npm run publish</p>';
      return;
    }
    var total = list.reduce(function (s, r) {
      return s + (r.sizeBytes || 0);
    }, 0);
    card.innerHTML =
      '<div class="meta" style="margin:0 0 12px"><span>共 ' +
      list.length +
      " 个版本 · " +
      mb(total) +
      "</span><span>设为分发＝学生端下次启动即下载该版本</span></div>" +
      '<table class="plain"><thead><tr><th>版本</th><th>说明</th><th>发布时间</th><th>大小</th><th>操作</th></tr></thead><tbody>' +
      list
        .map(function (r) {
          var tag = r.isCurrent
            ? ' <span class="pill">分发中</span>'
            : r.rolledBackAt
              ? ' <span class="pill bad">已回滚</span>'
              : "";
          var acts = r.isCurrent
            ? ""
            : '<button class="tbtn" data-udo="rollback" data-ver="' +
              esc(r.version) +
              '">设为分发</button>' +
              '<button class="tbtn danger" data-udo="delete" data-ver="' +
              esc(r.version) +
              '">删除</button>';
          return (
            '<tr><td class="mono">v' +
            esc(r.version) +
            tag +
            "</td><td>" +
            esc(r.notes || "—") +
            '</td><td class="mono">' +
            fmtDate(r.publishedAt) +
            '</td><td class="mono">' +
            mb(r.sizeBytes || 0) +
            "</td><td>" +
            acts +
            "</td></tr>"
          );
        })
        .join("") +
      "</tbody></table>";
  }

  // ── 渲染：密钥管理 ────────────────────────────────────────

  function renderKeys(r) {
    var el = $("keys");
    if (!r) return;
    if (r.unavailable || r.error) {
      el.innerHTML = '<tr><td colspan="5" class="empty">' + esc(r.error || "更新后台未接入") + "</td></tr>";
      return;
    }
    var list = (r.data && r.data.keys) || [];
    if (!list.length) {
      el.innerHTML = '<tr><td colspan="5" class="empty">没有可用密钥</td></tr>';
      return;
    }
    el.innerHTML = list
      .map(function (k) {
        var type = k.isEnv ? '<span class="pill">主密钥</span>' : '<span class="pill">面板密钥</span>';
        var del = k.isEnv
          ? ""
          : '<button class="tbtn danger" data-keydel="' + esc(k.id) + '" data-name="' + esc(k.name) + '">删除</button>';
        return (
          "<tr><td class=\"mono\">" +
          esc(k.name) +
          "</td><td>" +
          type +
          '</td><td class="mono">' +
          fmtTime(k.createdAt) +
          '</td><td class="mono">' +
          fmtTime(k.lastUsedAt) +
          "</td><td>" +
          del +
          "</td></tr>"
        );
      })
      .join("");
  }

  // ── 数据装载 ──────────────────────────────────────────────

  function load() {
    api("/admin/api/bootstrap").then(function (b) {
      if (!b) return;
      renderOverview(b.overview, b.site);
      renderUsers(b.users, b.site ? b.site.defaultDailyTurns : 0, b.invites);
      renderInvites(b.invites);
      renderResets(b.resets);
      renderSite(b.site, b.users);
      renderSecurity(b.security);
      renderUpdate(b.update.overview, b.update.versions);
      renderKeys(b.update.keys);
    });
  }

  // ── 事件（全量委托）──────────────────────────────────────

  document.addEventListener("click", function (e) {
    // 遮罩是 div 不是 button/a：委托找控件前先单独处理「点遮罩收抽屉」
    if (e.target && e.target.classList && e.target.classList.contains("drawer-backdrop")) {
      document.body.classList.remove("drawer-open");
      return;
    }
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
    if (t.id === "openDrawerM") {
      document.body.classList.add("drawer-open");
      return;
    }
    if (t.classList.contains("nav-item")) {
      showPane(t.getAttribute("data-nav"));
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
      $("updFileBox").innerHTML = "";
      return;
    }
    if (t.id === "updRetry") {
      load();
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
        box.innerHTML =
          '<div class="notice">密钥「' +
          esc(k.name) +
          "」已创建——明文仅此一次展示，之后无法再查看，请立即复制保存：</div>" +
          '<div class="row" style="margin-top:10px"><input class="mono" readonly value="' +
          esc(token) +
          '" onfocus="this.select()">' +
          '<button class="tbtn" data-copy="' +
          esc(token) +
          '" type="button" style="margin:0;padding:8px 18px">复制</button></div>';
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
        var grouped = r.secret.replace(/(.{4})/g, "$1 ").trim();
        $("mfaSetupBox").innerHTML =
          '<div class="qr">' +
          r.qrSvg +
          "</div>" +
          '<p style="font-size:13px;color:var(--ink-2)">用手机验证器扫描二维码（或手输密钥 <b class="mono">' +
          esc(grouped) +
          "</b>），然后输入验证器上当前的 6 位动态码完成绑定：</p>" +
          '<div class="row" style="margin-top:10px"><input id="mfaVerifyCode" placeholder="6 位动态码" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="max-width:160px;letter-spacing:.3em;text-align:center">' +
          '<button class="tbtn" id="mfaEnable" type="button" style="margin:0;padding:8px 18px">验证并启用</button></div>';
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
        alert("请先在左侧输入当前动态码（或恢复码）");
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
    if (t.id === "invGen") {
      api("/admin/api/invite", {
        count: Number($("invCount").value) || 1,
        note: $("invNote").value,
        days: Number($("invDays").value) || 0,
      }).then(load);
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
      doWhat === "disable" ? "停用后该同学将立即无法登录，确认？" : "踢下线后该同学的实例立即回收，确认？";
    if (!confirm(confirmText)) return;
    api("/admin/api/user/" + doWhat, { user: user }).then(load);
  });

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
    if (verInput) verInput.addEventListener("input", function () {
      updState.versionTouched = true;
    });
  })();

  // 轻量轮询：页面可见、无进行中的上传时每 60s 刷一次数据（跨公网 RTT 大，
  // 只重拉 bootstrap 一个请求；不可见标签页跳过）
  setInterval(function () {
    if (busy || document.visibilityState !== "visible") return;
    load();
  }, 60000);

  // hash 变化（浏览器前进/后退）也跟着切面板
  window.addEventListener("hashchange", function () {
    var id = paneFromHash();
    if (id && id !== current) showPane(id, false);
  });

  showPane(paneFromHash() || "overview", false);
  load();
})();
