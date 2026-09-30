/**
 * 前端资产静态检查：admin-app.js 是内联进管理台页面的单文件脚本（与
 * chat-app.js 同一交付模式），引用未定义的函数只有运行时才炸——这里静态
 * 扫描兜底：所有非属性调用的标识符必须在文件里有定义，或属于浏览器/JS
 * 内置白名单。另断言发版正则与面板骨架完好（历史 bug：模板字符串把
 * 未加倍的 \d 吞掉，发版校验把合法版本号拒掉）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const APP_JS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../gateway/admin/assets/admin-app.js",
);
const UI_MJS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../gateway/admin/ui.mjs",
);

/** 浏览器与 JS 内置全局（admin-app.js 是浏览器顶层脚本，无 import） */
const BUILTINS = new Set([
  "addEventListener",
  "alert",
  "Array",
  "Blob",
  "Boolean",
  "clearInterval",
  "clearTimeout",
  "confirm",
  "console",
  "Date",
  "decodeURIComponent",
  "document",
  "encodeURIComponent",
  "Error",
  "fetch",
  "Infinity",
  "isFinite",
  "isNaN",
  "JSON",
  "location",
  "Map",
  "Math",
  "NaN",
  "navigator",
  "Number",
  "Object",
  "parseFloat",
  "parseInt",
  "Promise",
  "prompt",
  "RegExp",
  "removeEventListener",
  "setInterval",
  "setTimeout",
  "String",
  "XMLHttpRequest",
  "window",
]);

test("admin-app.js 是合法 JavaScript（只编译不执行）", () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  new vm.Script(src);
});

test("admin-app.js 里被调用的函数都有定义或属浏览器内置", () => {
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
  for (const m of src.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) {
    for (const p of m[1].split(",")) {
      const id = p.trim().split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) defs.add(id);
    }
  }
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    defs.add(m[1]);
  }

  const missing = new Map<string, number>();
  // 调用形如 name( —— 前一个字符不能是 . 或 $（属性调用/模板），
  // 也不能是标识符字符（如 fooBar 里的 Bar）
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    // 关键字与流程语句不是调用（var 也在内：CSS 的 color:var(--x) 会被当成调用形）
    if (
      /^(if|for|while|switch|catch|return|typeof|new|function|do|else|in|of|with|await|async|throw|delete|void|instanceof|var|let|const)$/.test(
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
    `admin-app.js 引用了未定义的函数（渲染期 ReferenceError 会被吃成「取数失败」）：${[
      ...missing.keys(),
    ].join(", ")}`,
  );
});

test("发版校验正则原样保留（模板转义事故回归）", () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  assert.ok(src.includes("/^\\d+\\.\\d+\\.\\d+$/.test(ver)"), "版本号正则应原样出现在资产里");
  assert.ok(src.includes("/\\.zip$/i.test(f.name)"), "zip 后缀正则应原样保留");
});

test("面板骨架与页面壳一致：每个面板 id 在 ui.mjs 里有对应挂载点", () => {
  const src = fs.readFileSync(APP_JS, "utf8");
  const ui = fs.readFileSync(UI_MJS, "utf8");
  const panes = src.match(/var PANES = \[([^\]]+)\]/)?.[1] ?? "";
  assert.ok(panes, "PANES 列表应存在");
  for (const id of panes.split(",").map((s) => s.trim().replace(/['"]/g, ""))) {
    assert.ok(ui.includes(`id="pane-${id}"`), `页面壳缺少 pane-${id} 挂载点`);
  }
});
