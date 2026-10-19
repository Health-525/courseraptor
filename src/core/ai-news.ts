/** AI 新闻引擎桥接：固定入口、JSON 标准输入、独立状态目录与可取消子进程。 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { dataDir, PROJECT_ROOT } from "./paths";

type NewsCommand = "doctor" | "prepare" | "save" | "query";
export type NewsResult = Record<string, unknown>;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** 完整日报需分页读写：仅新闻工作流提高轮数上限，普通对话仍保持 20 轮。 */
export function newsWorkflowStop({
  steps,
}: {
  steps: ReadonlyArray<{ toolCalls: ReadonlyArray<{ toolName: string }> }>;
}): boolean {
  const writingNews = steps.some((step) =>
    step.toolCalls.some(
      (call) => call.toolName === "prepare_ai_news" || call.toolName === "save_ai_news_digest",
    ),
  );
  return steps.length >= (writingNews ? 100 : 20);
}

function pythonCandidates(): Array<{ executable: string; prefix: string[] }> {
  const configured = process.env.RAPTOR_AI_NEWS_PYTHON?.trim();
  if (configured) return [{ executable: configured, prefix: [] }];
  const bundled = path.join(
    PROJECT_ROOT,
    "runtime",
    "python",
    process.platform === "win32" ? "python.exe" : "bin/python3",
  );
  if (existsSync(bundled)) return [{ executable: bundled, prefix: [] }];
  return process.platform === "win32"
    ? [
        { executable: "python", prefix: [] },
        { executable: "py", prefix: ["-3"] },
      ]
    : [
        { executable: "python3", prefix: [] },
        { executable: "python", prefix: [] },
      ];
}

/** 模型不能指定解释器、脚本、命令参数或状态路径。 */
export async function runAiNews(
  command: NewsCommand,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<NewsResult> {
  const script = path.join(PROJECT_ROOT, "scripts", "ai-news", "news.py");
  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    AI_NEWS_STATE_DIR: path.resolve(dataDir(), "ai-news"),
  };
  for (const candidate of pythonCandidates()) {
    try {
      return await new Promise<NewsResult>((resolve, reject) => {
        if (signal?.aborted) {
          resolve({ status: "failed", error: "AI 新闻操作已取消" });
          return;
        }
        const child = spawn(candidate.executable, [...candidate.prefix, script, command], {
          cwd: PROJECT_ROOT,
          env,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        let failure: string | undefined;
        const stop = (message: string) => {
          failure = message;
          child.kill();
        };
        const abort = () => stop("AI 新闻操作已取消");
        const timer = setTimeout(
          () => stop("AI 新闻操作超时，请稍后重试"),
          command === "prepare" ? 240_000 : 30_000,
        );
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT_BYTES) stop("AI 新闻返回的数据超过大小限制");
          else chunks.push(chunk);
        });
        // 不把解释器 stderr 直接喂给模型，防止意外泄露本地环境或凭证。
        child.stderr.resume();
        child.stdin.on("error", () => {});
        child.on("error", (error) => {
          cleanup();
          reject(error);
        });
        child.on("close", () => {
          cleanup();
          if (failure) {
            resolve({ status: "failed", error: failure });
            return;
          }
          try {
            const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
            resolve(result as NewsResult);
          } catch {
            resolve({
              status: "failed",
              error: "新闻引擎未正常启动，请检查 Python 3.11+ 和脚本安装是否完整",
            });
          }
        });
        child.stdin.end(JSON.stringify(input));
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { status: "failed", error: "无法启动 AI 新闻引擎，请检查解释器路径与执行权限" };
    }
  }
  return {
    status: "unavailable",
    error:
      "AI 新闻需要 Python 3.11+。请安装后重启应用，或将 RAPTOR_AI_NEWS_PYTHON 配置为解释器完整路径；其他功能可继续使用。",
  };
}
