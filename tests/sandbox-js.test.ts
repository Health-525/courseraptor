/**
 * run_js 沙箱测试
 *
 * 定位声明：给模型一个「去重/计数/分组求和/正则摘取」的计算台，
 * 不是安全边界（模型本来就能经工具读写本机）。钉住的是行为契约：
 * eval 式完成值、console 捕获、越界写法静态拒绝、死循环限时掐断、输出截断。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runSandboxedJs } from "../src/sandbox-js";

test("最后表达式的值就是 result（eval 语义）", () => {
  const r = runSandboxedJs("1 + 2");
  assert.equal(r.ok, true);
  assert.equal(r.result, "3");

  const arr = runSandboxedJs("const s=new Set(['a','b','a']); [...s].join(',')");
  assert.equal(arr.result, "a,b");
});

test("console.log 逐行进 logs", () => {
  const r = runSandboxedJs(`
    const grades = [85, 92, 78];
    console.log("平均", grades.reduce((a,b)=>a+b,0)/grades.length);
    console.log("去重数", new Set([1,1,2]).size);
  `);
  assert.equal(r.ok, true);
  assert.deepEqual(r.logs, ["平均 85", "去重数 2"]);
});

test("对象结果序列化为 JSON", () => {
  const r = runSandboxedJs(`
    const rows=[{c:"数学",n:2},{c:"英语",n:1}];
    const g={}; for (const x of rows) g[x.c]=x.n; g
  `);
  assert.equal(r.ok, true);
  assert.match(r.result ?? "", /"数学"/);
});

test("越界写法静态拒绝：require / process / fetch / eval / new Function", () => {
  for (const code of [
    "require('fs')",
    "process.exit(0)",
    "fetch('http://evil.example')",
    "eval('1+1')",
    "new Function('return 1')()",
  ]) {
    const r = runSandboxedJs(code);
    assert.equal(r.ok, false, code);
    assert.match(r.error ?? "", /沙箱禁用/);
  }
});

test("死循环 3 秒掐断，不挂死宿主进程", { timeout: 15000 }, () => {
  const t0 = Date.now();
  const r = runSandboxedJs("while(true){}");
  const dt = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /被掐断/);
  assert.ok(dt < 10000, `应在秒级返回，实际 ${dt}ms`);
});

test("运行时异常返回 ok:false 并带上已输出的 logs", () => {
  const r = runSandboxedJs(`console.log("before"); undefined.x`);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /undefined/);
  assert.deepEqual(r.logs, ["before"]);
});

test("超长输出截断（防爆 token）", () => {
  const r = runSandboxedJs(`console.log("x".repeat(20000)); 42`);
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
});

test("空代码与超长代码礼貌拒绝", () => {
  assert.equal(runSandboxedJs("   ").ok, false);
  const big = "const a = 1;\n".repeat(1000);
  const r = runSandboxedJs(big);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /超过/);
});
