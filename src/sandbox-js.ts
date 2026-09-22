/**
 * run_js 沙箱：给模型一个「算数 + 倒腾文本」的计算台
 *
 * 定位：通知附件里挑出来的行列数据、筛选后的清单，经常还要去重、计数、
 * 正则摘取、分组求和。让模型心算不可靠，跑 python 又太重，所以提供
 * 一个受限 JS 执行环境：
 * - node:vm 裸上下文：没有 require/process/fetch/定时器，只有 ECMAScript 本身
 * - 3 秒超时（死循环自动掐断）、输出截断 8000 字符（防刷屏爆 token）
 * - console.log 捕获进 logs 返回；表达式的值返回在 result
 *
 * 加固边界：context 里不放入任何宿主对象/函数——console 与日志缓冲全部由
 * 引导脚本在沙箱 realm 内创建，宿主侧只经 __raptorTakeLogs 取数据。这样
 * 「拿宿主函数 constructor 链导航宿主 realm」整类路径没有起点；即便有人
 * 拼接绕过 BANNED 黑名单，裸上下文里也只有 ECMAScript 内建可用。
 * vm 本身不是安全机制（Node 官方声明），strings:false 挡住 eval/Function
 * 字符串编译，这里是纵深防御，不是牢笼——模型本来就能经工具读写本机。
 */

import vm from "node:vm";

const TIMEOUT_MS = 3000;
const MAX_CODE = 6000;
const MAX_OUT = 8000;
const MAX_LOG_LINES = 200;

export interface SandboxResult {
  ok: boolean;
  logs?: string[];
  result?: string;
  error?: string;
  truncated?: boolean;
}

function clip(s: string): { text: string; truncated: boolean } {
  return s.length > MAX_OUT
    ? { text: `${s.slice(0, MAX_OUT)}\n…（输出超长已截断）`, truncated: true }
    : { text: s, truncated: false };
}

function show(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v, null, 1) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * 沙箱内引导脚本：部署 console（含 200 行限流，防恶意循环在超时窗口内
 * 撑爆内存）与日志取回口。console.log 的参数格式化与宿主侧 show 同语义
 * （字符串原样 / undefined 显式 / 其余 JSON 缩进 1，失败退 String）。
 * 行数上限以内联数字注入，引导脚本不含用户输入，无注入面。
 */
const BOOTSTRAP = `
"use strict";
(function () {
  var logs = [];
  function show(v) {
    if (typeof v === "string") return v;
    if (v === undefined) return "undefined";
    try {
      var s = JSON.stringify(v, null, 1);
      return s === null || s === undefined ? String(v) : s;
    } catch (e) {
      return String(v);
    }
  }
  globalThis.console = {
    log: function () {
      if (logs.length >= ${MAX_LOG_LINES}) return;
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(show(arguments[i]));
      logs.push(parts.join(" "));
    },
  };
  globalThis.__raptorTakeLogs = function () {
    var out = logs;
    logs = [];
    return out;
  };
})();
`;

/** 引导脚本不随用户代码变化，预编译一次，每次执行只换 context */
const BOOTSTRAP_SCRIPT = new vm.Script(BOOTSTRAP, { filename: "sandbox-bootstrap" });

/** 从沙箱取回日志缓冲：__raptorTakeLogs 是沙箱内创建的函数，宿主只调用不读属性。
 * 返回值是沙箱 realm 的数组，逐项拷贝成宿主数组，避免跨 realm 原型污染判断 */
function collectLogs(sandboxObj: Record<string, unknown>): string[] {
  const take = sandboxObj.__raptorTakeLogs;
  if (typeof take !== "function") return [];
  try {
    const raw = (take as () => unknown)();
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (let i = 0; i < raw.length; i++) out.push(String(raw[i]));
    return out;
  } catch {
    return [];
  }
}

/** 明显越界的写法先静态拦一道（挡不住有心逃逸，但能挡住顺手一写） */
const BANNED: Array<[RegExp, string]> = [
  [/\brequire\b/, "require"],
  [/\bprocess\b/, "process"],
  [/\bchild_process\b/, "child_process"],
  [/\bglobalThis\b/, "globalThis"],
  [/\bimport\s*\(/, "import()"],
  [/\beval\s*\(/, "eval()"],
  [/\bFunction\s*\(/, "Function()"],
  [/\bfetch\s*\(/, "fetch"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bSharedArrayBuffer\b|\bAtomics\b/, "共享内存原语"],
];

export function runSandboxedJs(code: string): SandboxResult {
  const src = code.trim();
  if (!src) return { ok: false, error: "代码为空" };
  if (src.length > MAX_CODE) {
    return {
      ok: false,
      error: `代码超过 ${MAX_CODE} 字符（本工具做小计算，大数据处理请交给 query_table 筛选）`,
    };
  }
  const hit = BANNED.find(([re]) => re.test(src));
  if (hit) {
    return {
      ok: false,
      error: `沙箱禁用「${hit[1]}」：这里只能做纯计算与文本处理（数组/字符串/JSON/正则/数学）。数据先用 query_table 筛好再以 JSON 字符串传进来。`,
    };
  }

  // 空 host object：context 外露面上没有任何宿主成员
  const sandboxObj: Record<string, unknown> = {};
  try {
    const ctx = vm.createContext(sandboxObj, {
      codeGeneration: { strings: false, wasm: false },
    });
    BOOTSTRAP_SCRIPT.runInContext(ctx);
    // 完成值语义同 eval：最后一条表达式的值即 result；多行逻辑请 console.log
    const value = new vm.Script(src, { filename: "run_js" }).runInContext(ctx, {
      timeout: TIMEOUT_MS,
    });
    const logs = collectLogs(sandboxObj);
    const shown = value === undefined ? undefined : clip(show(value));
    const joined = clip(logs.join("\n"));
    return {
      ok: true,
      logs: joined.text ? joined.text.split("\n") : undefined,
      result: shown?.text,
      truncated: joined.truncated || shown?.truncated || undefined,
    };
  } catch (e) {
    const logs = collectLogs(sandboxObj);
    const msg = (e as Error).message ?? String(e);
    if (/timed?\s*out|Script execution timed out/i.test(msg)) {
      return {
        ok: false,
        error: `执行超过 ${TIMEOUT_MS / 1000} 秒被掐断（死循环？大排序？把数据先筛小再算）`,
      };
    }
    return { ok: false, error: msg.slice(0, 300), logs: logs.length ? logs : undefined };
  }
}
