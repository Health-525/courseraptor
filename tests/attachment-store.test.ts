/**
 * 附件缓存库测试
 *
 * 钉住三件事：
 * 1. 同一 URL/路径稳定映射同一 id，缓存命中免重下；
 * 2. 删除只认索引登记过的条目（agent 只能删自己下载的副本）；
 * 3. 索引被外部改坏指向缓存目录之外时，删除必须拒绝、绝不越界。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 必须在导入被测模块之前指向临时数据目录，避免读写真实 data/
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-attstore-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const {
  attachmentIdForSource,
  putAttachment,
  findByUrl,
  findByLocalPath,
  getMeta,
  readStoredBuffer,
  listAttachments,
  deleteAttachment,
  clearAttachments,
  attachmentStats,
} = await import("../src/attachment-store");

const URL_A =
  "https://jwc.njtech.edu.cn/system/_content/download.jsp?urltype=news.DownloadAttachUrl&owner=1&wbfileid=ABC";

test("id 稳定：同 URL 永远同 id，不同来源不同 id", () => {
  assert.equal(attachmentIdForSource("url", URL_A), attachmentIdForSource("url", URL_A));
  assert.notEqual(attachmentIdForSource("url", URL_A), attachmentIdForSource("url", `${URL_A}X`));
  // Windows 路径大小写不敏感：同一文件不同写法应归一
  assert.equal(
    attachmentIdForSource("local", "D:\\DownLoads\\List.XLSX"),
    attachmentIdForSource("local", "d:/downloads/list.xlsx"),
  );
});

test("put/findBy/read：落盘在缓存目录且字节一致", async () => {
  const buf = Buffer.from("hello xlsx bytes");
  const id = attachmentIdForSource("url", URL_A);
  const meta = await putAttachment({
    id,
    filename: "网课目录.xlsx",
    kind: "table",
    format: "xlsx",
    source: "url",
    url: URL_A,
    buf,
    sheetNames: ["Sheet1"],
  });
  assert.ok(meta.storedPath.startsWith(path.join(tmpData, "attachments", "files")));
  assert.ok(fs.existsSync(meta.storedPath), "文件必须真实落盘");
  assert.equal(findByUrl(URL_A)?.id, id);
  assert.equal(getMeta(id)?.filename, "网课目录.xlsx");
  assert.deepEqual(readStoredBuffer(id), buf);
  assert.equal(listAttachments().length, 1);
  const stats = attachmentStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.totalBytes, buf.length);
});

test("本地路径缓存：findByLocalPath 走 resolve 归一", async () => {
  const p = path.join(tmpData, "orig", "成绩单.CSV");
  await putAttachment({
    id: attachmentIdForSource("local", p),
    filename: "成绩单.csv",
    kind: "table",
    format: "csv",
    source: "local",
    originPath: p,
    buf: Buffer.from("a,b\n1,2"),
  });
  assert.ok(findByLocalPath(p));
  assert.ok(findByLocalPath(path.resolve(p)), "等价写法也要命中");
});

test("缓存文件被手动删掉 = 视为未命中（触发重下而非读空）", async () => {
  const id = attachmentIdForSource("url", URL_A);
  fs.rmSync(getMeta(id)!.storedPath);
  assert.equal(findByUrl(URL_A), null);
  assert.equal(getMeta(id), null);
  assert.equal(readStoredBuffer(id), null);
});

test("delete：删文件删索引；未知 id 返回 false 不碰磁盘", async () => {
  const id = attachmentIdForSource("local", path.join(tmpData, "orig", "成绩单.CSV"));
  const target = getMeta(id)!.storedPath;
  assert.equal(await deleteAttachment(id), true);
  assert.ok(!fs.existsSync(target));
  assert.equal(
    listAttachments().find((m) => m.id === id),
    undefined,
  );
  assert.equal(await deleteAttachment("ffffffffffff"), false);
});

test("越界护栏：索引被改成缓存目录外的路径时，删除必须拒绝且原文件无恙", async () => {
  // 模拟用户自己放进临时目录、绝不允许 agent 删除的文件
  const userFile = path.join(tmpData, "users-important.xlsx");
  fs.writeFileSync(userFile, "user data");

  const idxFile = path.join(tmpData, "attachments", "index.json");
  const idx = JSON.parse(fs.readFileSync(idxFile, "utf8")) as Record<string, unknown>;
  idx.evil00000001 = {
    id: "evil00000001",
    filename: "x.xlsx",
    kind: "table",
    format: "xlsx",
    source: "url",
    storedPath: userFile,
    size: 9,
    fetchedAt: new Date().toISOString(),
    hits: 0,
  };
  fs.writeFileSync(idxFile, JSON.stringify(idx));

  assert.equal(await deleteAttachment("evil00000001"), false);
  assert.ok(fs.existsSync(userFile), "越界条目删除必须失败，用户文件必须还在");
});

test("clearAttachments：只清缓存副本，一次删光", async () => {
  await putAttachment({
    id: "keep00000001",
    filename: "a.txt",
    kind: "text",
    format: "txt",
    source: "local",
    originPath: path.join(tmpData, "a.txt"),
    buf: Buffer.from("aaa"),
  });
  const removed = await clearAttachments();
  assert.ok(removed >= 1);
  assert.equal(attachmentStats().count, 0);
  // clear 后索引里不残留任何登记（含越界假条目）
  assert.equal(listAttachments().length, 0);
});
