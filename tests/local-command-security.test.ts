import assert from "node:assert/strict";
import { test } from "node:test";
import { localOnlyCommandMessage } from "../src/tui/slash-menu";

test("仅本机命令 /key 及其参数写法均不得进入远程渠道", () => {
  assert.match(localOnlyCommandMessage("/key") ?? "", /本机终端/);
  assert.match(localOnlyCommandMessage("/Key") ?? "", /本机终端/);
  assert.match(localOnlyCommandMessage("/KEY sk-Secret1234567890ABCDE") ?? "", /本机终端/);
  assert.match(localOnlyCommandMessage("/key sk-Secret1234567890ABCDE") ?? "", /本机终端/);
  assert.equal(localOnlyCommandMessage("/keyfoo"), undefined);
  assert.equal(localOnlyCommandMessage("帮我执行 /key"), undefined);
});
