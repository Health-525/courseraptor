#!/usr/bin/env node
/**
 * 发版：bump package.json 版本 -> 提交 -> 打 tag -> 推送。
 * 同学端 raptor 启动时对比 GitHub master 上的版本号即会提示更新（src/update-check.ts）。
 *
 * 用法：npm run release            # patch：0.1.0 -> 0.1.1
 *       npm run release -- minor   # 0.1.0 -> 0.2.0
 *       npm run release -- major   # 0.1.0 -> 1.0.0
 * 前提：工作区干净（改动先提交），推送成功前发版不算完成，失败时按提示手动 push。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const bump = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(bump)) {
  console.error(`未知版本档位：${bump}（可用 patch | minor | major）`);
  process.exit(1);
}

function git(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

if (git("git status --porcelain")) {
  console.error("工作区有未提交改动，先提交/收尾再发版（版本号改动未写入）。");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);
const next =
  bump === "major" ? [maj + 1, 0, 0] : bump === "minor" ? [maj, min + 1, 0] : [maj, min, pat + 1];
pkg.version = next.join(".");
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const tag = `v${pkg.version}`;
const branch = git("git branch --show-current");
git("git add package.json");
git(`git commit -m "release: ${tag}"`);
git(`git tag ${tag}`);
console.log(`本地已提交 ${tag}，推送到 origin/${branch} …`);

try {
  execSync(`git push origin ${branch}`, { stdio: "inherit" });
  execSync(`git push origin ${tag}`, { stdio: "inherit" });
  console.log(`✅ ${tag} 已发布。同学下次启动 raptor 会看到更新提示。`);
} catch (e) {
  console.error(
    `⚠️ 推送失败：${e.message.split("\n")[0]}\n` +
      `   手动补推即可完成发版：git push origin ${branch} && git push origin ${tag}`
  );
  process.exit(1);
}
