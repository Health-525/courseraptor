/**
 * 前端资产静态检查：chat-app.js 是经 /app.js 端点伺服的独立脚本（浏览器
 * 顶层脚本，无 import），引用未定义的函数只有运行时才炸——历史 bug：
 * hallItemAct 只有调用没有定义，教务通知面板一渲染就 ReferenceError，
 * 还被 Promise 链吃成「取数失败」，看起来像网络问题。这里静态扫描兜底：
 * 所有非属性调用的标识符必须在文件里有定义，或属于浏览器/JS 内置白名单。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP_JS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/channels/web/assets/chat-app.js",
);

/** 浏览器与 JS 内置全局（chat-app.js 是浏览器顶层脚本，无 import） */
const BUILTINS = new Set([
  "abort",
  "addEventListener",
  "alert",
  "Array",
  "ArrayBuffer",
  "atob",
  "btoa",
  "Blob",
  "Boolean",
  "clearInterval",
  "clearTimeout",
  "close",
  "confirm",
  "console",
  "crypto",
  "CustomEvent",
  "Date",
  "decodeURI",
  "decodeURIComponent",
  "dispatchEvent",
  "document",
  "DOMParser",
  "encodeURI",
  "encodeURIComponent",
  "Error",
  "EvalError",
  "Event",
  "EventSource",
  "fetch",
  "File",
  "FileReader",
  "FormData",
  "focus",
  "getComputedStyle",
  "Headers",
  "history",
  "Image",
  "Infinity",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Intl",
  "isFinite",
  "isNaN",
  "JSON",
  "localStorage",
  "location",
  "Map",
  "matchMedia",
  "Math",
  "AbortController",
  "MutationObserver",
  "NaN",
  "navigator",
  "Notification",
  "Number",
  "Object",
  "open",
  "parseFloat",
  "parseInt",
  "performance",
  "postMessage",
  "Promise",
  "prompt",
  "Proxy",
  "queueMicrotask",
  "RangeError",
  "Reflect",
  "RegExp",
  "removeEventListener",
  "requestAnimationFrame",
  "requestIdleCallback",
  "ResizeObserver",
  "Response",
  "scroll",
  "scrollBy",
  "scrollIntoView",
  "scrollTo",
  "sessionStorage",
  "setInterval",
  "setTimeout",
  "Set",
  "String",
  "structuredClone",
  "Symbol",
  "SyntaxError",
  "Text",
  "TextDecoder",
  "TypeError",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "URIError",
  "URL",
  "URLSearchParams",
  "WeakMap",
  "WeakSet",
  "WebSocket",
  "window",
]);

test("chat-app.js 里被调用的函数都有定义或属浏览器内置", () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  const defs = new Set<string>(BUILTINS);
  // 函数与类声明
  for (const m of src.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    defs.add(m[1]!);
  }
  // 顶层与块内 const/let/var；解构声明整体按名收集
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    defs.add(m[1]!);
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const id = part.split(":").pop()?.trim().split(/[=\s]/)[0] ?? "";
      if (/^[A-Za-z_$][\w$]*$/.test(id)) defs.add(id);
    }
  }
  // 形参与箭头函数参数：回调里直接调用的局部函数不至于误报
  for (const m of src.matchAll(/\(([^(){}]*)\)\s*=>/g)) {
    for (const p of m[1]!.split(",")) {
      const id = p.trim().split(/[=:]/)[0]!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) defs.add(id);
    }
  }
  // 数组解构形参：如 quicks.forEach(([label, make]) => …)
  for (const m of src.matchAll(
    /\[\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*\]\s*\)\s*=>/g,
  )) {
    for (const id of m[1]!.split(",")) defs.add(id.trim());
  }
  for (const m of src.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) {
    for (const p of m[1]!.split(",")) {
      const id = p.trim().split(/[=:]/)[0]!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) defs.add(id);
    }
  }
  // catch (e) 等
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    defs.add(m[1]!);
  }

  const missing = new Map<string, number>();
  // 调用形如 name( —— 前一个字符不能是 . 或 $（属性调用/模板），
  // 也不能是标识符字符（如 fooBar 里的 Bar）
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1]!;
    // 关键字与流程语句不是调用
    if (
      /^(if|for|while|switch|catch|return|typeof|new|function|do|else|in|of|with|await|async|throw|delete|void|instanceof)$/.test(
        name,
      )
    ) {
      continue;
    }
    if (!defs.has(name)) {
      missing.set(name, (missing.get(name) ?? 0) + 1);
    }
  }
  assert.deepEqual(
    [...missing.keys()],
    [],
    `chat-app.js 引用了未定义的函数（历史 bug：渲染期 ReferenceError 被吃成「取数失败」）：${[
      ...missing.keys(),
    ].join(", ")}`,
  );
});

test("提示词模板换序钩子齐全：面板与输入框上方 chips 都可拖，↑↓ 按钮兜底", () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  // 通用拖拽排序有定义，且 qchips / quickList 两处都绑定
  assert.match(src, /function enableDragSort\(/);
  assert.match(src, /enableDragSort\(qchips, commitQuickOrder\)/);
  assert.match(src, /enableDragSort\(quickList, commitQuickOrder\)/);
  // chips 与面板条目都标了可拖，chips 的 title 教用户「能拖」
  assert.match(src, /c\.draggable = true/);
  assert.match(src, /item\.draggable = true/);
  assert.match(src, /按住拖动可调整顺序/);
  // 键盘/触屏兜底：↑↓ 按钮带 aria-label，首末条对应方向禁用
  assert.match(src, /aria-label", `\$\{verb\}：\$\{q\}`/);
  assert.match(src, /b\.disabled = dir < 0 \? i === 0 : i === quickDraft\.length - 1/);
  assert.match(src, /function moveQuick\(i, dir\)/);
  // 换序与增删走同一条即改即存管线：面板与 chips 同步刷新后落盘
  const fn = src.match(/function commitQuickOrder\(texts\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "commitQuickOrder 函数存在");
  assert.match(fn[0], /renderQuickList\(\)/);
  assert.match(fn[0], /renderQchips\(\)/);
  assert.match(fn[0], /saveQuick\(\)/);
});

test("PPT 全屏查看器：深链路由、锁滚、焦点与 a11y 四件套齐全", () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  // 路由：打开态走 ?ppt=&p= 查询串，pushState 压栈让后退键变成「关全屏」
  assert.match(src, /function pptUrlId\(\)/);
  assert.match(src, /function pptUrlPage\(\)/);
  assert.match(src, /function pptCardById\(/);
  assert.match(src, /history\.pushState\(null, "", pptUrlFor\(deckId, i \+ 1\)\)/);
  // 翻页只 replaceState：不把历史栈撑成一页一格
  assert.match(src, /history\.replaceState\(null, "", pptUrlFor\(deckId, i \+ 1\)\)/);
  // popstate 是唯一的关闭/翻页入口：后退到没有 ppt= 的地址就关
  assert.match(src, /window\.addEventListener\("popstate", \(\) => \{/);
  assert.match(src, /if \(live\) pptClose\(live, false\);/);
  // 主动关才 back()：由后退触发的关闭不能再弹一次历史
  assert.match(src, /if \(pop && pptPushed\) \{/);

  // 锁滚：fixed 遮罩挡不住滚轮滚 #log
  assert.match(src, /document\.body\.classList\.add\("ppt-open"\)/);
  assert.match(src, /document\.body\.classList\.remove\("ppt-open"\)/);

  // keydown 监听必须摘：挂在 document 上，不摘会越开越多、关了还在翻页
  assert.match(src, /document\.removeEventListener\("keydown", live\.onKey\)/);
  assert.match(src, /document\.addEventListener\("keydown", onKey\)/);

  // 键盘守卫：焦点在输入类控件里时方向键归控件自己
  assert.match(src, /function pptEditable\(t\)/);
  assert.match(src, /if \(pptEditable\(e\.target\)\)/);

  // a11y：模态语义 + 焦点陷阱 + 打开即聚焦 + 关闭归还来源缩略图
  assert.match(src, /ov\.setAttribute\("role", "dialog"\)/);
  assert.match(src, /ov\.setAttribute\("aria-modal", "true"\)/);
  assert.match(src, /function trapFocus\(e\)/);
  assert.match(src, /close\.setAttribute\("aria-label", "关闭全屏预览"\)/);
  assert.match(src, /returnFocus: opts\?\.returnFocus \?\? null/);

  // 画册 id 用成品文件名：同一份课件刷新前后不变，深链才站得住
  assert.match(src, /const named = files\?\.\[0\]\?\.name;/);
  assert.match(src, /card\.dataset\.pptId = deckId;/);
  assert.match(src, /pptView\(ppt, i, files, deckId, \{ returnFocus: sl \}\)/);
  // 对话卡缩略图必须可聚焦：CSS 的 :focus-visible 高亮一直在，但缺 tabindex
  // 的话键盘用户进不到预览入口，全屏关闭也没处还焦点
  assert.match(src, /sl\.tabIndex = 0;/);
  assert.match(src, /sl\.setAttribute\("role", "button"\)/);

  // 预览截断要说清：count 是总页数、slides 最多前 N 页，计数器不许拿
  // 总页数冒充可翻范围（那是「翻到 30 页却显示 /60」的老 bug）
  assert.match(src, /const truncated = ppt\.count > total;/);
  assert.match(src, /预览前 \$\{total\} 页 · 全 \$\{ppt\.count\} 页/);
  assert.match(src, /counter\.textContent = `\$\{i \+ 1\} \/ \$\{total\}`;/);

  // 缩略图条：长课件能直接跳页，当前页有标记
  assert.match(src, /const rail = el\("pptv-rail"\);/);
  assert.match(src, /thumbs\[k\]\.classList\.toggle\("on", k === i\)/);
});

test("图谱卡与图谱面板都带 bookId 跳 /graph：多本书不开错书", () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  // 对话区迷你卡：不带 bookId 时 /graph 只会开默认书
  assert.match(
    src,
    /more\.href = graph\.bookId \? `\/graph\?bookId=\$\{encodeURIComponent\(graph\.bookId\)\}` : "\/graph";/,
  );
  // 功能大厅里的图谱面板：同一口径
  assert.match(
    src,
    /go\.href = d\.bookId \? `\/graph\?bookId=\$\{encodeURIComponent\(d\.bookId\)\}` : "\/graph";/,
  );
});

test("教务通知卡按学校显隐：newsReady 门禁接线齐全，没接入的学校不出卡", () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  // 门槛函数：以服务端算好的 school.newsReady 为准，演示页放行
  assert.match(src, /function newsAvailable\(\) \{/);
  const fn = src.match(/function newsAvailable\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "newsAvailable 函数存在");
  assert.match(fn[0], /HALL_DEMO/);
  assert.match(fn[0], /schoolState\?\.newsReady/);
  // 宫格过滤带上 news 门禁（没接入的学校宫格直接不出这张卡）
  assert.match(src, /c\.id !== "news" \|\| newsAvailable\(\)/);
  // 对话推送与 #hall=news 深链误触：schoolState 到位后不进无权限面板
  assert.match(src, /panel === "news" && schoolState && !newsAvailable\(\)/);
  assert.match(src, /id === "news" && schoolState && !newsAvailable\(\)/);
  // 启动同步兜底：深链竞态进了 news 但权限不足时退回宫格并清 hash
  const boot = src.match(/news 门禁状态到位[\s\S]*?\n {2}\}/);
  assert.ok(boot, "启动同步里有 news 门禁兜底");
  assert.match(boot[0], /hallPanel === "news" && !newsAvailable\(\)/);
  assert.match(boot[0], /syncHallHash\(\)/);
});
