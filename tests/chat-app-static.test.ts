/**
 * 前端资产静态检查：chat-app.js 是内联进页面的单文件脚本，引用未定义
 * 的函数只有运行时才炸——历史 bug：hallItemAct 只有调用没有定义，教务
 * 通知面板一渲染就 ReferenceError，还被 Promise 链吃成「取数失败」，
 * 看起来像网络问题。这里静态扫描兜底：所有非属性调用的标识符必须在
 * 文件里有定义，或属于浏览器/JS 内置白名单。
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
  "Response",
  "scroll",
  "scrollBy",
  "scrollIntoView",
  "scrollTo",
  "sessionStorage",
  "setInterval",
  "setTimeout",
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
    defs.add(m[1]);
  }
  // 顶层与块内 const/let/var；解构声明整体按名收集
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    defs.add(m[1]);
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      const id = part.split(":").pop()?.trim().split(/[=\s]/)[0] ?? "";
      if (/^[A-Za-z_$][\w$]*$/.test(id)) defs.add(id);
    }
  }
  // 形参与箭头函数参数：回调里直接调用的局部函数不至于误报
  for (const m of src.matchAll(/\(([^(){}]*)\)\s*=>/g)) {
    for (const p of m[1].split(",")) {
      const id = p.trim().split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) defs.add(id);
    }
  }
  // 数组解构形参：如 quicks.forEach(([label, make]) => …)
  for (const m of src.matchAll(
    /\[\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*\]\s*\)\s*=>/g,
  )) {
    for (const id of m[1].split(",")) defs.add(id.trim());
  }
  for (const m of src.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) {
    for (const p of m[1].split(",")) {
      const id = p.trim().split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) defs.add(id);
    }
  }
  // catch (e) 等
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    defs.add(m[1]);
  }

  const missing = new Map<string, number>();
  // 调用形如 name( —— 前一个字符不能是 . 或 $（属性调用/模板），
  // 也不能是标识符字符（如 fooBar 里的 Bar）
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
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
  assert.match(src, /aria-label", verb \+ "："/);
  assert.match(src, /b\.disabled = dir < 0 \? i === 0 : i === quickDraft\.length - 1/);
  assert.match(src, /function moveQuick\(i, dir\)/);
  // 换序与增删走同一条即改即存管线：面板与 chips 同步刷新后落盘
  const fn = src.match(/function commitQuickOrder\(texts\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "commitQuickOrder 函数存在");
  assert.match(fn[0], /renderQuickList\(\)/);
  assert.match(fn[0], /renderQchips\(\)/);
  assert.match(fn[0], /saveQuick\(\)/);
});
