import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "data", "downloads", ".git"]);

/** 递归找出仓库里所有随包分发的 .bat（跳过依赖与产物目录，以及 . 开头的本地目录）。 */
function findBatchFiles(dir = ROOT, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findBatchFiles(full, acc);
    else if (entry.name.toLowerCase().endsWith(".bat")) acc.push(full);
  }
  return acc;
}

function loneNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n" && text[i - 1] !== "\r") count += 1;
  }
  return count;
}

// cmd.exe 按字节偏移回扫批处理，「多字节中文 + 裸 LF」会让它算错行位置、把下一行
// 从中间截断执行（现象：双击 start.bat 黑窗口一闪而过，连 pause 都跑不到）。
// 而 GitHub 的 Source code zip 打包的是 blob 原文、不做 checkout 转换，所以 CRLF
// 必须真存进仓库；.gitattributes 里 *.bat -text 是这一点的唯一屏障。
test("分发的 .bat 一律以 CRLF 存放，不允许出现裸 LF", () => {
  const files = findBatchFiles();
  assert.ok(files.length > 0, "至少应找到根目录的 start.bat");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const relative = path.relative(ROOT, file).replaceAll("\\", "/");
    assert.ok(text.includes("\r\n"), `${relative} 必须使用 CRLF 换行`);
    assert.equal(loneNewlines(text), 0, `${relative} 含裸 LF：cmd 解析会错位，双击后窗口一闪而过`);
  }
});

test(".gitattributes 对 .bat 关闭行尾转换（保住 blob 里的 CRLF）", () => {
  const attrs = readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
  const rule = attrs
    .split(/\r?\n/)
    .find((line) => /^\*\.bat\b/.test(line.trim()) && !line.trim().startsWith("#"));
  assert.ok(rule, "缺少 *.bat 规则");
  assert.match(rule as string, /-text/, "*.bat 必须标 -text，否则 eol=lf 会把脚本存成裸 LF");
});

// 真跑一遍：把有副作用的依赖安装与主程序换成 echo，其余原样交给 cmd 解析。
// 只在 Windows 上有意义（同学侧就是 Windows），其他平台跳过。
test("start.bat 能被 cmd 完整解析（不被行尾/编码打断）", {
  skip: process.platform !== "win32",
}, () => {
  const original = readFileSync(path.join(ROOT, "start.bat"), "utf8");
  // 保留磁盘上真实的行尾风格：强制改写成 CRLF 会让「文件退化成裸 LF」这种回归测不出来。
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const stubbed = original
    .split(/\r?\n/)
    .map((line) => (/\bnpm\b|\braptor\.cjs\b/.test(line) ? "echo STUB" : line))
    .join(eol);
  assert.ok(!/\bnpm ci\b|raptor\.cjs/.test(stubbed), "未能隔离 start.bat 的副作用命令，拒绝执行");

  const dir = path.join(os.tmpdir(), `raptor-bat-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const file = path.join(dir, "start.bat");
    writeFileSync(file, stubbed, "utf8");
    let stderr = "";
    try {
      execFileSync("cmd.exe", ["/c", file], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 60_000,
      });
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    }
    assert.doesNotMatch(
      stderr,
      /is not recognized|不是内部或外部命令|命令语法不正确/,
      `cmd 解析被打断：${stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true }); // 断言失败也不把临时目录留给下一次
  }
});
