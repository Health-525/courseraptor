/** 手机端五个核心界面共用底部导航；桌面端始终隐藏。 */
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
    body:not(.chat-shell) { padding-bottom: calc(66px + env(safe-area-inset-bottom)); }
    .chat-shell main { padding-bottom: calc(66px + env(safe-area-inset-bottom)); }
    .mobile-tabbar { position: fixed; z-index: 35; left: 0; right: 0; bottom: 0;
                     display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
                     padding: 6px max(8px, env(safe-area-inset-right)) max(6px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
                     border-top: 1px solid var(--rule); background: var(--card);
                     box-shadow: 0 -8px 24px rgba(50, 42, 31, .055); }
    .mobile-tab { display: flex; min-width: 0; min-height: 52px; flex-direction: column;
                  align-items: center; justify-content: center; gap: 2px;
                  border-radius: 8px; color: var(--ink-3); text-decoration: none;
                  font-size: 12px; line-height: 1.25; cursor: pointer;
                  -webkit-tap-highlight-color: transparent; touch-action: manipulation;
                  transition: color .15s ease, background .15s ease, transform .15s ease; }
    .mobile-tab-ico { display: inline-flex; width: 34px; height: 28px;
                      align-items: center; justify-content: center; border-radius: 8px;
                      transition: background .15s ease; }
    .mobile-tab-ico svg { width: 20px; height: 20px; fill: none; stroke: currentColor;
                          stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .mobile-tab.active { color: var(--accent-deep); font-weight: 600; }
    .mobile-tab.active .mobile-tab-ico { background: var(--accent-soft); }
    .mobile-tab:active { transform: scale(.97); background: var(--paper-deep); }
    .mobile-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  }
  @media print { .mobile-tabbar { display: none !important; } }
`;
