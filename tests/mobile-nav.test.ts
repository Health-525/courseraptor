import assert from "node:assert/strict";
import { test } from "node:test";

import { MOBILE_NAV_CSS, type MobileSection, mobileNav } from "../src/channels/web/mobile-nav";

const sections: Array<[MobileSection, string]> = [
  ["chat", "/"],
  ["today", "/today"],
  ["schedule", "/schedule"],
  ["todos", "/todos"],
  ["knowledge", "/knowledge"],
];

test("手机底部导航覆盖五个核心界面，并只标记当前页", () => {
  for (const [active, href] of sections) {
    const html = mobileNav(active);
    assert.equal((html.match(/class="mobile-tab(?: active)?"/g) ?? []).length, 5);
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
    assert.match(html, new RegExp(`class="mobile-tab active" href="${href.replace("/", "\\/")}"`));
  }
});

test("底部导航只在手机断点出现，打印与桌面保持原样", () => {
  assert.match(MOBILE_NAV_CSS, /\.mobile-tabbar \{ display: none; \}/);
  assert.match(MOBILE_NAV_CSS, /@media \(max-width: 720px\)/);
  assert.match(
    MOBILE_NAV_CSS,
    /@media print \{ \.mobile-tabbar \{ display: none !important; \} \}/,
  );
  assert.doesNotMatch(MOBILE_NAV_CSS, /@media \(min-width/);
});

test("手机外壳：报头朱砂通栏、激活项朱砂印章，均只在手机断点生效", () => {
  const mobileBlock = MOBILE_NAV_CSS.slice(MOBILE_NAV_CSS.indexOf("@media (max-width: 720px)"));
  // 报头：.pagehead 在手机上铺朱砂底、带文件头双线，且吸顶
  assert.match(mobileBlock, /\.pagehead \{[^}]*position: sticky;[^}]*background: var\(--accent\)/);
  assert.match(mobileBlock, /\.pagehead::after \{[^}]*border-bottom: 3px solid var\(--card\)/);
  // 激活导航项 = 朱砂方章里嵌纸色图标
  assert.match(
    mobileBlock,
    /\.mobile-tab\.active \.mobile-tab-ico \{[^}]*background: var\(--accent\);[^}]*color: var\(--card\)/,
  );
  // 浮起 Dock 贴安全区，内容区留足底距
  assert.match(mobileBlock, /bottom: calc\(8px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(mobileBlock, /padding-bottom: calc\(88px \+ env\(safe-area-inset-bottom\)\)/);
  // 报头样式不得漏到桌面：手机块之前不出现 .pagehead 规则
  assert.doesNotMatch(MOBILE_NAV_CSS.slice(0, MOBILE_NAV_CSS.indexOf("@media")), /\.pagehead/);
});
