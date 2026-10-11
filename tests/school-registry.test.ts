/**
 * 学校注册表：可选清单登记、运行期切换、凭证里保存的 schoolId 决定默认学校
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HAS_NJTECH } from "./_util/njtech-probe";

// 隔离：凭证与数据都指到临时目录，绝不碰真机 credentials.enc / data/
process.env.RAPTOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-school-"));
process.env.RAPTOR_CREDENTIALS_FILE = path.join(process.env.RAPTOR_DATA_DIR, "credentials.enc");
// 本文件专门验证「凭证决定默认学校」：RAPTOR_SCHOOL 必须缺席
delete process.env.RAPTOR_SCHOOL;

const { saveCredentialsStore } = await import("../src/core/credentials");

test("未存过 schoolId 时默认 custom（不接入任何学校）；登记序即清单序（真实学校在前）", async () => {
  const { school, listSchoolOptions } = await import("../src/core/school");
  await import("../src/adapters");
  assert.equal(school().info.id, "custom");
  assert.equal(school().info.manual, true);
  const opts = listSchoolOptions();
  const ids = opts.map((a) => a.info.id);
  // njtech 是本地可选插件、不进公开仓库：装了才有真实学校垫在 custom 之前
  assert.deepEqual(ids, HAS_NJTECH ? ["njtech", "custom"] : ["custom"]);
  // 手动课表标记：custom 有、真实学校没有；custom 恒为清单末位
  assert.equal(opts[opts.length - 1]!.info.manual, true);
  if (HAS_NJTECH) {
    assert.notEqual(opts[0]!.info.manual, true);
  }
});

test("凭证里保存 schoolId=custom：新进程默认落在自定义学校", async () => {
  // 上面已在本进程装配过 custom；用子进程模拟「新进程启动」最贴近真实路径
  const root = path.resolve(import.meta.dirname, "..");
  const { pathToFileURL } = await import("node:url");
  const entry = `
    (async () => {
      delete process.env.RAPTOR_SCHOOL;
      await import(${JSON.stringify(pathToFileURL(path.join(root, "src/adapters/index.ts")).href)});
      const { school } = await import(${JSON.stringify(
        pathToFileURL(path.join(root, "src/core/school.ts")).href,
      )});
      console.log(school().info.id);
    })();
  `;
  saveCredentialsStore({ schoolId: "custom" });
  const { execFile } = await import("node:child_process");
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "--eval", entry],
      { cwd: root, env: process.env },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
  });
  assert.equal(out, "custom");
});

test("selectSchool 运行期切换与未知 id 拒绝", async () => {
  const { school, selectSchool } = await import("../src/core/school");
  assert.equal(selectSchool("custom"), true);
  assert.equal(school().info.id, "custom");
  assert.equal(school().info.manual, true);
  assert.equal(selectSchool(" nonexistent "), false);
  if (HAS_NJTECH) {
    // 未知 id 不改变当前学校
    assert.equal(school().info.id, "custom");
    assert.equal(selectSchool("njtech"), true);
    assert.equal(school().info.id, "njtech");
    assert.equal(selectSchool(" nonexistent "), false);
    assert.equal(school().info.id, "njtech");
  } else {
    // 无 njtech 插件：未知 id 拒绝后仍停在 custom
    assert.equal(school().info.id, "custom");
  }
});
