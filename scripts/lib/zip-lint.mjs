/**
 * 便携 zip 条目校验（package-portable 产出后、package-exe 嵌入前共用）。
 *
 * 历史坑（2026-10-17 CI Release 连败两版的根因）：zip-normalized.ps1 曾用
 * 「$src 原串长度」算相对路径偏移，而 Get-ChildItem 子项 FullName 是展开后的
 * 长名——TEMP 是 8.3 短名（DEV-CA~1 / RUNNER~1）时全体条目错位（本机差 1 字符
 * 成双斜杠 `CourseRaptor//...`，CI runner 差 3 字符成半截名 `CourseRaptor/ptor/...`）。
 * 错位条目同样以 `CourseRaptor/` 开头，仅凭前缀检查放行过；exe 启动器按约定
 * 剥一层前缀后释放错位，自检报「安装不完整（缺少 runtime\node.exe）」。
 *
 * 本模块在打包链路上硬拦四类病包：
 *   1. 顶层前缀不是恰好一层（含 `//`、剥后为空）
 *   2. 顶层目录之外的条目
 *   3. 启动器/桌面壳自检依赖的关键文件缺失（错位条目下必缺）
 *   4. 相对路径超过 MAX_REL（exe 释放普通路径离 MAX_PATH=260 的护栏）
 */

import { readFileSync } from "node:fs";

export const PORTABLE_TOP_DIR = "CourseRaptor";
export const MAX_REL = 150;

/** 启动器（exe-launcher.cs）与桌面壳（desktop/src/payload.ts）自检都点名的文件 */
const REQUIRED_ENTRIES = [
  "start.bat",
  "runtime/node.exe",
  "runtime/npm.cmd",
  "app/bin/raptor.cjs",
  "app/scripts/doctor.mjs",
  "app/local/host/headless.ts",
].map((rel) => `${PORTABLE_TOP_DIR}/${rel}`);

/**
 * 条目名判定（纯函数，单测直接喂名字符串数组）。
 * names 只应包含文件条目（目录条目由调用方滤掉）。
 */
export function lintEntryNames(names) {
  const prefix = `${PORTABLE_TOP_DIR}/`;
  const errors = [];
  let maxRel = 0;

  for (const name of names) {
    if (!name.startsWith(prefix)) {
      errors.push(`顶层目录之外的条目：${name}`);
      continue;
    }
    const rel = name.slice(prefix.length);
    if (rel === "") {
      errors.push(`条目剥掉顶层后为空：${name}`);
      continue;
    }
    if (rel.startsWith("/") || name.includes("//")) {
      errors.push(`条目含双斜杠（多为短路径偏移错位）：${name}`);
      continue;
    }
    if (rel.length > maxRel) maxRel = rel.length;
    if (rel.length > MAX_REL) errors.push(`相对路径 ${rel.length} 字符超 ${MAX_REL} 护栏：${name}`);
  }
  for (const req of REQUIRED_ENTRIES) {
    if (!names.includes(req)) errors.push(`缺少自检关键文件：${req}`);
  }

  return { ok: errors.length === 0, errors, count: names.length, maxRel };
}

/** 读 zip 文件做条目校验；坏文件抛错由调用方处理（打包链路上应中止） */
export async function lintPortableZip(zipPath) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(readFileSync(zipPath));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  return lintEntryNames(names);
}
