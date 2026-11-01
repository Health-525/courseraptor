/** 手机端外壳：底部导航 Dock + 朱砂报头（五个核心界面共用；桌面端始终隐藏）。
 *
 * 设计：移动端不是桌面版的缩小，而是「红头文件」本体——每页以一条朱砂
 * 报头开场（楷体页题 + 等宽栏标 + 文件头双线），正文留在纸面上；红色
 * 只属于报头与印章，卡片一律素纸细线。底部导航是浮起的纸 Dock，激活
 * 项是一枚朱砂印章（纸色图标嵌在朱砂方章里）。
 * 报头样式挂在 .pagehead（今日/课表/待办/知识四页共用骨架）上；对话页
 * 的顶栏是 .topbar，报头化在 chat-page 自己的样式里做。 */
export type MobileSection = "chat" | "today" | "schedule" | "todos" | "knowledge";

const ITEMS: Array<{
  id: MobileSection;
  href: string;
  label: string;
  icon: string;
}> = [
  {
    id: "chat",
    href: "/",
    label: "对话",
    icon: '<path d="M5 18.5 3.5 21v-5A8 8 0 1 1 7 19.5"/><path d="M8 10h8M8 14h5"/>',
  },
  {
    id: "today",
    href: "/today",
    label: "今日",
    icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
  },
  {
    id: "schedule",
    href: "/schedule",
    label: "课表",
    icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M9 4v17M15 4v17M3 15h18"/>',
  },
  {
    id: "todos",
    href: "/todos",
    label: "待办",
    icon: '<path d="m4 6 1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h10M11 12h10M11 18h10"/>',
  },
  {
    id: "knowledge",
    href: "/knowledge",
    label: "知识",
    icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 5.5v14M8 7h8M8 11h6"/>',
  },
];

export function mobileNav(active: MobileSection): string {
  const items = ITEMS.map((item) => {
    const selected = item.id === active;
    return `<a class="mobile-tab${selected ? " active" : ""}" href="${item.href}"${
      selected ? ' aria-current="page"' : ""
    }><span class="mobile-tab-ico" aria-hidden="true"><svg viewBox="0 0 24 24">${item.icon}</svg></span><span>${item.label}</span></a>`;
  }).join("");
  return `<nav class="mobile-tabbar" aria-label="核心功能导航">${items}</nav>`;
}

export const MOBILE_NAV_CSS = `
  .mobile-tabbar { display: none; }
  @media (max-width: 720px) {
    /* 浮起纸 Dock：内容区底部留足 dock 高度 + 呼吸空隙 */
    body:not(.chat-shell) { padding-bottom: calc(88px + env(safe-area-inset-bottom)); }
    .chat-shell main { padding-bottom: calc(88px + env(safe-area-inset-bottom)); }
    .mobile-tabbar { position: fixed; z-index: 35;
                     left: max(10px, env(safe-area-inset-left));
                     right: max(10px, env(safe-area-inset-right));
                     bottom: calc(8px + env(safe-area-inset-bottom));
                     display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
                     gap: 2px; padding: 5px;
                     border: 1px solid var(--rule-2); border-radius: 20px;
                     background: var(--card);
                     box-shadow: 0 14px 36px rgba(50, 42, 31, .16), 0 2px 6px rgba(50, 42, 31, .07); }
    .mobile-tab { display: flex; min-width: 0; min-height: 50px; flex-direction: column;
                  align-items: center; justify-content: center; gap: 3px;
                  border-radius: 13px; color: var(--ink-3); text-decoration: none;
                  font-size: 11px; line-height: 1.2; letter-spacing: .02em; cursor: pointer;
                  -webkit-tap-highlight-color: transparent; touch-action: manipulation;
                  transition: color .15s ease, background .15s ease, transform .15s ease; }
    /* 激活 = 一枚朱砂印章：纸色图标嵌在朱砂方章里，文字加粗转墨色 */
    .mobile-tab-ico { display: inline-flex; width: 40px; height: 30px;
                      align-items: center; justify-content: center;
                      border-radius: 9px;
                      transition: background .15s ease; }
    .mobile-tab-ico svg { width: 19px; height: 19px; fill: none; stroke: currentColor;
                          stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .mobile-tab.active { color: var(--ink); font-weight: 600; }
    .mobile-tab.active .mobile-tab-ico { background: var(--accent); color: var(--card);
                                         box-shadow: inset 0 0 0 1px rgba(252, 251, 247, .22); }
    .mobile-tab:active { transform: scale(.96); }
    .mobile-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

    /* ── 朱砂报头：.pagehead（今日/课表/待办/知识）在手机上变身报头带 ──
       竖排结构：栏标(等宽小字) → 楷体页题 → 副行(日期/动作)；带底一条
       粗纸线 + 3px 下方一条细线 = 红头文件的「文件头双线」。红只在报头，
       正文纸面一律素卡细线。 */
    .pagehead { position: sticky; top: 0; z-index: 30; display: block;
                padding: max(12px, env(safe-area-inset-top)) 18px 10px;
                background: var(--accent); border-bottom: 0; color: var(--card);
                box-shadow: none; }
    .pagehead::after { content: ""; display: block; height: 0;
                       margin: 10px -18px 0;
                       border-bottom: 3px solid var(--card);
                       box-shadow: 0 6px 0 -3px rgba(252, 251, 247, .45); }
    /* 恐龙印章钤在报头右上角（文件的落款章位），微斜；徽标嵌进纸色圆底，
       深色徽标在朱砂带上不发糊 */
    .pagehead .seal { position: absolute; display: block;
                      top: max(12px, env(safe-area-inset-top)); right: 16px;
                      width: 46px; height: 46px; transform: rotate(-8deg); }
    .pagehead .seal::before { border-color: rgba(252, 251, 247, .9); }
    .pagehead .seal img { top: 6px; left: 6px; width: 34px; height: 34px;
                          background: var(--card); }
    .pagehead .ph-title { display: flex; flex-direction: column;
                          align-items: flex-start; gap: 2px; padding-right: 64px; }
    .pagehead .ph-stamp { display: block; order: -1; color: rgba(252, 251, 247, .78);
                          font-size: 10px; letter-spacing: .3em; }
    .pagehead .ph-title h1 { color: var(--card); font-size: 27px; line-height: 1.25;
                             letter-spacing: 3px; }
    .pagehead .ph-right { margin-top: 8px; width: auto;
                          display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .pagehead .ph-clock { text-align: left; }
    .pagehead .ph-date { color: rgba(252, 251, 247, .85); font-size: 12px; }
    .pagehead .ph-week { color: rgba(252, 251, 247, .7); }
    /* 报头里的按钮：纸色幽灵胶囊（各页自行决定哪些在手机上保留） */
    .pagehead .ph-right .tbtn { border: 1px solid rgba(252, 251, 247, .55);
                                background: none; color: var(--card);
                                border-radius: 999px; min-height: 32px;
                                padding: 4px 13px; font-size: 12px; }
    .pagehead .ph-right .tbtn:hover, .pagehead .ph-right .tbtn:active {
      border-color: var(--card); color: var(--accent);
      background: var(--card); }

    /* ── 纸面正文：报头之下卡片一律素纸细线圆角，红色顶线让位给报头 ── */
    .card, .lead { border: 1px solid var(--rule-2);
                   border-top: 1px solid var(--rule-2); border-radius: 14px; }
  }
  @media print { .mobile-tabbar { display: none !important; } }
`;
