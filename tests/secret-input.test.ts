import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { readSecret } from "../src/secret-input";

test("静音秘密输入显示提示但不回显内容", async () => {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (value: boolean) => void };
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  output.isTTY = true;
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

  const pending = readSecret({ input, output, prompt: "激活密钥" });
  input.write("CR-SECRET-ABCDE-FGHIJ-KLMNP\r");

  assert.equal(await pending, "CR-SECRET-ABCDE-FGHIJ-KLMNP");
  const rendered = chunks.join("");
  assert.match(rendered, /激活密钥/);
  assert.ok(!rendered.includes("CR-SECRET-ABCDE-FGHIJ-KLMNP"));
});
