/**
 * NYTDC 学工系统（奥蓝）解析纯函数单测（离线）
 *
 * 样本取自实机抓取的真实页面（2026-10，学生本人账号）：
 * 登录页隐藏域、信息汇总空表、资料下载一条 2011 年的样表。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { hiddenValue, isLoginPage, extractTableById, parseMessagesGrid, parseFilesGrid } =
  await import("../src/adapters/nytdc/xgstu");

const LOGIN_HTML = `
<form name="form1" method="post" action="./login.aspx" id="form1">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="abc123==" />
<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="C2EE9ABB" />
<input name="userbh" type="text" id="userbh" />
<input name="yxdm" type="hidden" id="yxdm" value="13989" />
</form>`;

test("hiddenValue：取 __VIEWSTATE / yxdm，缺失返回空串", () => {
  assert.equal(hiddenValue(LOGIN_HTML, "__VIEWSTATE"), "abc123==");
  assert.equal(hiddenValue(LOGIN_HTML, "__VIEWSTATEGENERATOR"), "C2EE9ABB");
  assert.equal(hiddenValue(LOGIN_HTML, "yxdm"), "13989");
  assert.equal(hiddenValue(LOGIN_HTML, "不存在"), "");
});

test("isLoginPage：登录页与已登录页可区分", () => {
  assert.equal(isLoginPage(LOGIN_HTML), true);
  assert.equal(isLoginPage("<span>欢迎你:张三</span><a>注销登录</a>"), false);
  assert.equal(isLoginPage('<script>alert("无效验证码!")</script>'), true);
  assert.equal(isLoginPage('<script>alert("请重新登录系统!")</script>'), true);
});

test("extractTableById：按 id 取表，嵌套 table 不被截断", () => {
  const html = `
    <table id="MyDataGrid"><tr><td>外层</td></tr>
      <tr><td><table><tr><td>内层</td></tr></table></td></tr>
    </table>
    <table id="Other"><tr><td>别的表</td></tr></table>`;
  const grid = extractTableById(html, "MyDataGrid");
  assert.ok(grid);
  assert.match(grid, /外层/);
  assert.match(grid, /内层/);
  assert.ok(!grid.includes("别的表"));
  assert.equal(extractTableById(html, "不存在"), null);
});

test("parseMessagesGrid：空表（只有序号行）返回空数组", () => {
  // 奥蓝在没有消息时会渲染这样一行：<td colspan="2"><span>1</span></td>
  const empty = '<tr align="left"><td colspan="2"><span>1</span></td></tr>';
  assert.deepEqual(parseMessagesGrid(empty), []);
});

test("parseMessagesGrid：有消息时抽标题与日期", () => {
  const grid = `
    <tr><td><a onclick="xzdm('1','','1','教育管理')">关于评选奖学金的通知</a></td>
        <td><a class="time">2026-10-09</a></td></tr>
    <tr align="left"><td colspan="2"><span>1</span></td></tr>`;
  const items = parseMessagesGrid(grid);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "关于评选奖学金的通知");
  assert.equal(items[0].date, "2026-10-09");
});

test("parseFilesGrid：解析资料行（真实样本）并拼出下载地址", () => {
  const grid = `
    <tr>
      <td><a onclick="down2('public%5c%e4%b8%aa%e6%80%a7%e5%8c%96%e9%9c%80%e6%b1%82%e6%a0%b7%e8%a1%a8%e6%9d%9c%e9%9d%99.doc')">个性化需求样表杜静</a></td>
      <td><a class="time">2011-2-15</a></td>
    </tr>
    <tr align="left"><td colspan="2"><span>1</span></td></tr>`;
  const files = parseFilesGrid(grid);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "个性化需求样表杜静");
  assert.equal(files[0].date, "2011-2-15");
  assert.equal(
    files[0].url,
    "http://xgstu.nytdc.edu.cn/aldfdnf.aspx?lx=1&file=public%5c%e4%b8%aa%e6%80%a7%e5%8c%96%e9%9c%80%e6%b1%82%e6%a0%b7%e8%a1%a8%e6%9d%9c%e9%9d%99.doc",
  );
});

test("parseFilesGrid：没有 down2 链接的行被忽略", () => {
  const grid =
    '<tr><td><a href="/x.aspx">普通链接</a></td><td><a class="time">2026-01-01</a></td></tr>';
  assert.deepEqual(parseFilesGrid(grid), []);
});
