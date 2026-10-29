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
