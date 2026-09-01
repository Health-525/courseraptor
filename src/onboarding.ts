/**
 * 首次运行凭证引导：交互式录入学号/密码 -> 真实登录验证 -> 加密保存
 * 触发条件：.env 与 credentials.enc 都没有教务凭证时
 */

import readline from "node:readline/promises";

import { config, type DeepSeekApiKeySource, maskDeepSeekApiKey } from "./config";
import { saveCredentialsStore, saveStoredCredentials } from "./credentials";
import { loginJwgl } from "./jwgl/auth";
import { createMutedTerminalOutput } from "./secret-input";

export async function ensureCredentials(): Promise<void> {
  if (config.jwglUsername && config.jwglPassword) return;

  console.log("🦖 首次使用：先配置教务系统账号（将 AES-256-GCM 加密保存在本机，不明文落盘）");
  const out = createMutedTerminalOutput();
  // terminal: true 不能省：output 是自定义 Writable（没有 isTTY），省了它
  // readline 就判定为非终端、不给 stdin 开 raw mode，终端自身的回显会把密码
  // 直接打在屏幕上——「输入不回显」就成了空话。开了之后提示符与回显都走
  // out.stream，由 setMuted 统一开关。
  const rl = readline.createInterface({
    input: process.stdin,
    output: out.stream,
    terminal: true,
  });

  try {
    for (let attempt = 1; ; attempt++) {
      const username = (await rl.question("学号: ")).trim();
      // 先直接写出提示，再关闭 readline 的回显。若先静音再把提示交给
      // rl.question，Windows 终端会把「请输入密码」也吞掉，用户看起来像卡住。
      process.stdout.write("教务系统密码（输入不回显）: ");
      out.setMuted(true);
      let password: string;
      try {
        password = await rl.question("");
      } finally {
        out.setMuted(false);
        process.stdout.write("\n");
      }

      if (!username || !password) {
        console.log("❌ 学号和密码不能为空");
        continue;
      }

      try {
        // 真实登录验证：密码错误当场重输，避免存入无效凭证
        await loginJwgl(username, password);
        saveStoredCredentials(username, password);
        config.jwglUsername = username;
        config.jwglPassword = password;
        config.credentialsSource = "encrypted";
        console.log("✅ 登录验证通过，凭证已加密保存\n");
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("密码") || msg.includes("学号")) {
          console.log(`❌ ${msg.slice(0, 60)}，请重试`);
        } else {
          console.log(`⚠️ 登录异常（${msg.slice(0, 50)}）——多为网络抖动，请重试`);
        }
        if (attempt >= 5) throw new Error("凭证配置失败（已重试 5 次）");
      }
    }
  } finally {
    rl.close();
  }
}

export interface DeepSeekKeyStatus {
  configured: boolean;
  masked?: string;
  source: DeepSeekApiKeySource;
}

/** 给 UI 的状态不包含任何完整 Key，防止调用方误回显或误传给 Agent。 */
export function getDeepSeekKeyStatus(): DeepSeekKeyStatus {
  if (!config.deepseekApiKey) return { configured: false, source: "unset" };
  return {
    configured: true,
    masked: maskDeepSeekApiKey(config.deepseekApiKey),
    source: config.deepseekApiKeySource,
  };
}

/** 本地 /key 设置流程唯一需要的终端能力；测试可注入内存实现，不读真实 stdin。 */
export interface KeySetupIO {
  write(message: string): void;
  confirm(prompt: string): Promise<boolean>;
  readSecret(prompt: string): Promise<string>;
  close?(): void;
}

export type KeySetupResult = "saved" | "kept" | "cancelled" | "invalid";

interface KeySetupServices {
  getStatus(): DeepSeekKeyStatus;
  setKey(key: string): { ok: boolean; message: string };
}

function createTerminalKeySetupIO(): KeySetupIO {
  const out = createMutedTerminalOutput();
  const rl = readline.createInterface({
    input: process.stdin,
    output: out.stream,
    terminal: true,
  });
  return {
    write: (message) => console.log(message),
    confirm: async (prompt) => /^(y|yes)$/i.test((await rl.question(`${prompt} [y/N] `)).trim()),
    readSecret: async (prompt) => {
      // 提示必须在开启静音前直接写出；否则用户只看到空白行，不知道该填什么。
      process.stdout.write(`${prompt}（输入不回显）: `);
      out.setMuted(true);
      try {
        return await rl.question("");
      } finally {
        out.setMuted(false);
        process.stdout.write("\n");
      }
    },
    close: () => rl.close(),
  };
}

/**
 * 无参 /key 的本地安全流程：已有值仅展示脱敏摘要，明确确认后才静音读取新值。
 * 完整 Key 只从 readSecret 传到 setKey；不写入 TUI、Agent、会话或日志。
 */
export async function runDeepSeekKeySetup(
  io: KeySetupIO = createTerminalKeySetupIO(),
  services: KeySetupServices = {
    getStatus: getDeepSeekKeyStatus,
    setKey: setDeepSeekApiKey,
  },
): Promise<KeySetupResult> {
  try {
    const status = services.getStatus();
    if (status.configured) {
      io.write(`当前 API Key：${status.masked ?? "已配置"}`);
      if (!(await io.confirm("是否覆盖当前 Key？"))) {
        io.write("已保留当前 API Key。");
        return "kept";
      }
    }

    io.write("请粘贴或输入新的 DeepSeek API Key（输入内容不会显示）。");
    const key = await io.readSecret("API Key");
    if (!key.trim()) {
      io.write("已取消，未修改 API Key。");
      return "cancelled";
    }

    const result = services.setKey(key);
    io.write(result.message);
    return result.ok ? "saved" : "invalid";
  } finally {
    io.close?.();
  }
}

/**
 * 配置 DeepSeek API Key（校验 -> 热生效 -> 加密持久化）
 * 热生效原理：provider 构建时不绑定 key，每次请求实时读
 * process.env.DEEPSEEK_API_KEY（AI SDK loadApiKey 惰性求值）
 */
export function setDeepSeekApiKey(key: string): { ok: boolean; message: string } {
  const trimmed = key.trim();
  if (!/^sk-[A-Za-z0-9]{16,}$/.test(trimmed)) {
    return {
      ok: false,
      message: "❌ 格式不对：请输入 sk- 开头的完整 API Key。",
    };
  }
  process.env.DEEPSEEK_API_KEY = trimmed; // 热生效
  config.deepseekApiKey = trimmed;
  config.deepseekApiKeySource = "encrypted";
  // 明确覆盖标记让重启后优先使用加密新值，但绝不改写 .env 的明文旧值。
  saveCredentialsStore({ deepseekApiKey: trimmed, deepseekApiKeyOverride: true });
  return { ok: true, message: "✅ API Key 已加密保存并立即生效，重启后仍使用新 Key。" };
}
