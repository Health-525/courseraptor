/**
 * 首次运行凭证引导：交互式录入学号/密码 -> 真实登录验证 -> 加密保存
 * 触发条件：.env 与 credentials.enc 都没有教务凭证时
 */

import readline from "node:readline/promises";
import { Writable } from "node:stream";

import { config } from "./config";
import { saveCredentialsStore, saveStoredCredentials } from "./credentials";
import { loginJwgl } from "./jwgl/auth";

/** 密码输入静音（回车后换行），避免明文密码留在终端回显里 */
function createMutedOutput() {
  let muted = false;
  const stream = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  return {
    stream,
    setMuted: (v: boolean) => {
      muted = v;
    },
  };
}

export async function ensureCredentials(): Promise<void> {
  if (config.jwglUsername && config.jwglPassword) return;

  console.log("🦖 首次使用：先配置教务系统账号（将 AES-256-GCM 加密保存在本机，不明文落盘）");
  const out = createMutedOutput();
  const rl = readline.createInterface({ input: process.stdin, output: out.stream });

  try {
    for (let attempt = 1; ; attempt++) {
      const username = (await rl.question("学号: ")).trim();
      out.setMuted(true);
      const password = await rl.question("教务系统密码（输入不回显）: ");
      out.setMuted(false);
      process.stdout.write("\n");

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

/**
 * /key 斜杠命令：配置 DeepSeek API Key（校验 -> 热生效 -> 加密持久化）
 * 热生效原理：provider 构建时不绑定 key，每次请求实时读
 * process.env.DEEPSEEK_API_KEY（AI SDK loadApiKey 惰性求值）
 */
export function setDeepSeekApiKey(key: string): { ok: boolean; message: string } {
  const trimmed = key.trim();
  if (!/^sk-[A-Za-z0-9]{16,}$/.test(trimmed)) {
    return {
      ok: false,
      message: "❌ 格式不对：应为 sk- 开头的完整 Key（如 /key sk-xxxxxxxx…）",
    };
  }
  process.env.DEEPSEEK_API_KEY = trimmed; // 热生效
  config.deepseekApiKey = trimmed;
  saveCredentialsStore({ deepseekApiKey: trimmed }); // 加密持久化（保留教务凭证字段）
  return { ok: true, message: "✅ API Key 已加密保存并立即生效，直接提问即可" };
}
