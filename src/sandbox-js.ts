/**
 * run_js 沙箱：给模型一个「算数 + 倒腾文本」的计算台
 *
 * 定位：通知附件里挑出来的行列数据、筛选后的清单，经常还要去重、计数、
 * 正则摘取、分组求和。让模型心算不可靠，跑 python 又太重，所以提供
 * 一个受限 JS 执行环境：
 * - node:vm 裸上下文：没有 require/process/fetch/定时器，只有 ECMAScript 本身
 * - 3 秒超时（死循环自动掐断）、输出截断 8000 字符（防刷屏爆 token）
 * - console.log 捕获进 logs 返回；表达式的值返回在 result
 * 它是能力补充，不是安全边界——模型本来就能经工具读写本机，别拿它当牢笼。
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
    ? { text: s.slice(0, MAX_OUT) + "\n…（输出超长已截断）", truncated: true }
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
    return { ok: false, error: `代码超过 ${MAX_CODE} 字符（本工具做小计算，大数据处理请交给 query_table 筛选）` };
  }
  const hit = BANNED.find(([re]) => re.test(src));
  if (hit) {
    return {
      ok: false,
      error: `沙箱禁用「${hit[1]}」：这里只能做纯计算与文本处理（数组/字符串/JSON/正则/数学）。数据先用 query_table 筛好再以 JSON 字符串传进来。`,
    };
  }

  const logs: string[] = [];
  const sandbox: Record<string, unknown> = {
    console: {
      log: (...a: unknown[]) => {
        if (logs.length < MAX_LOG_LINES) logs.push(a.map(show).join(" "));
      },
    },
  };
  try {
    const ctx = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    // 完成值语义同 eval：最后一条表达式的值即 result；多行逻辑请 console.log
    const value = new vm.Script(src, { filename: "run_js" }).runInContext(ctx, {
      timeout: TIMEOUT_MS,
    });
    const shown = value === undefined ? undefined : clip(show(value));
    const joined = clip(logs.join("\n"));
    return {
      ok: true,
      logs: joined.text ? joined.text.split("\n") : undefined,
      result: shown?.text,
      truncated: joined.truncated || shown?.truncated || undefined,
    };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/timed?\s*out|Script execution timed out/i.test(msg)) {
      return { ok: false, error: `执行超过 ${TIMEOUT_MS / 1000} 秒被掐断（死循环？大排序？把数据先筛小再算）` };
    }
    return { ok: false, error: msg.slice(0, 300), logs: logs.length ? logs : undefined };
  }
}
