/**
 * 「知识库」独立页 — GET /knowledge 的页面本体
 *
 * 形态照 flomo（浮墨笔记）做减法：左侧栏（搜索 + 标签列表）+ 主列
 * （卷首概览 + 发布框 + 按日分组的卡片川流）。无导图/日历/时间线等多视图，
 * 无排序切换——只有一条按更新时间倒序的川流。
 * 视觉为红头档案：页头与 /today 同源三件套（印章+楷体 h1+mono 戳记，
 * sticky 毛玻璃）；主列开卷是一条「卷首」横带——衬线大数字（条数/标签/
 * 连续记录）配近 16 周的朱砂热力带（列=周、行=星期，只亮有记录的日子），
 * 是全页的视觉锚点；知识卡作档案卡：衬线标题独立成行、右上 mono 档号
 * （№ 按创建顺序）、左缘朱砂签条 hover 点亮、标签成药丸 chip；发布框是
 * 带朱砂竖签的白纸便签。首屏一次轻浮入动画，reduced-motion 关闭。
 *
 * 发布框（flomo 核心交互）：首行=标题、其余=正文，分类可留空自动归
 * 课表课程，Ctrl+Enter 记下；POST /api/knowledge。编辑：卡片原地变
 * 表单（PATCH /api/knowledge/:id），编辑中暂停自动刷新。
 * 数据来自 GET /api/knowledge（纯本地存储，不登录教务、不调模型），
 * 页面每 60 秒与切回标签页时自行刷新。
 * 演示模式：demo=true 时内嵌虚构数据（demoData），不发任何请求。
 */

import type { KnowledgeEntry } from "../../core/knowledge";

/** 长文默认折叠的字符数（标题+正文合计），展开收起由用户决定 */
const CLAMP_LEN = 160;
/** 首屏渲染条数，超出部分「显示更多」分批追加 */
const BATCH = 50;
/** 卷首热力带的周数（列数，每列 7 天） */
const HEAT_WEEKS = 16;

export function knowledgePage(
  options: { demo?: boolean; demoData?: KnowledgeEntry[] } = {},
): string {
  const demo = options.demo === true;
  const demoData = options.demoData;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#F6F4ED">
<link rel="icon" type="image/png" href="/logo.png">
<title>知识库 · CourseRaptor</title>
<style>
  /* 红头档案令牌：暖纸底 + 墨字 + 单一朱砂红（与 /today 等页同源）；
     阴影与衬线/等宽字体也是同源令牌；热力带四档色阶取自朱砂，
     空档用可辨的纸灰（近透明的旧色阶在浅底上等于隐形） */
  :root {
    color-scheme: light;
    --paper: #F6F4ED;
    --paper-deep: #F0EDE4;
    --card: #FFFFFF;
    --shade: #ECE8DD;
    --ink: #25221C;
    --ink-2: #5A554A;
    /* 旧值 #898274 在纸底上仅 ~3.5:1，调深以满足 WCAG AA（小字 ≥4.5:1） */
    --ink-3: #6E6656;
    --rule: #E1DCCF;
    --rule-2: #C9C1AF;
    --accent: #AD392C;
    --accent-deep: #852B22;
    --accent-soft: #F3E3DE;
    --heat-0: rgba(50, 42, 31, 0.09);
    --heat-1: #EBC9BD;
    --heat-2: #D0806A;
    --heat-3: #AD392C;
    --heat-s: 12px;
    --shadow-sm: 0 8px 24px rgba(50, 42, 31, 0.055);
    --shadow-md: 0 10px 28px rgba(50, 42, 31, 0.09);
    --serif: Georgia, "Times New Roman", "Songti SC", SimSun, serif;
    --kai: "KaiTi", "STKaiti", "Kaiti SC", var(--serif);
    --sans: system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --mono: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
    --head-h: 64px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink);
         font-family: var(--sans); font-size: 16px; line-height: 1.7;
         -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  ::selection { background: var(--accent-soft); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tbtn { background: none; border: 1px solid var(--rule-2); color: var(--ink-2);
          min-height: 36px; font-size: 14px; padding: 6px 14px; border-radius: 8px;
          cursor: pointer; text-decoration: none; display: inline-flex;
          align-items: center; font-family: inherit;
          transition: border-color .15s ease, color .15s ease, background .15s ease; }
  .tbtn:hover { border-color: var(--accent); color: var(--accent); background: var(--card); }
  .tbtn:active { transform: translateY(1px); }

  /* ── 页头：与 /today /todos 同源的红头档案三件套（印章+楷体 h1+mono 戳记），
     sticky 半透明纸底 + 柔和模糊，滚动时内容从页头下穿过去 ── */
  .pagehead { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 16px;
              padding: 10px 28px; height: var(--head-h); border-bottom: 1px solid var(--rule);
              background: rgba(246, 244, 237, 0.92);
              -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
  .pagehead .seal { flex: none; position: relative; width: 44px; height: 44px;
                    transform: rotate(-7deg); }
  .pagehead .seal::before { content: ""; position: absolute; inset: 0;
                            border: 2px solid var(--accent); border-radius: 50%; opacity: .9; }
  .pagehead .seal img { position: absolute; top: 5px; left: 5px; width: 34px; height: 34px;
                        border-radius: 50%; object-fit: cover; }
  .ph-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 14px; }
  .ph-title h1 { margin: 0; font-family: var(--kai); font-weight: 400;
                 font-size: 24px; letter-spacing: 2px; }
  .ph-title .ph-stamp { font-family: var(--mono); font-size: 12px; color: var(--ink-3);
                        letter-spacing: .1em; white-space: nowrap; }
  .ph-right { display: flex; align-items: center; gap: 10px; }

  /* ── 布局：侧栏（搜索 + 标签，meta 沉底）+ 主列川流 ──
     侧栏 288px 白底通高（flex 列，meta 贴底，不再留半截空白），
     主区底压深一档（paper-deep），白卡在浅底上「浮」出来 */
  main { display: grid; grid-template-columns: 288px minmax(0, 1fr); align-items: stretch;
         min-height: calc(100vh - var(--head-h)); background: var(--paper-deep); }

  .kn-rail { background: var(--card); border-right: 1px solid var(--rule);
             padding: 20px 18px 20px; position: sticky; top: var(--head-h); align-self: start;
             /* 白底至少铺满一屏：内容再长，左栏也不会在半截处断成纸底 */
             min-height: calc(100vh - var(--head-h));
             max-height: calc(100vh - var(--head-h)); overflow-y: auto;
             display: flex; flex-direction: column; }
  .kw-box { width: 100%; min-height: 42px; padding: 8px 14px; border: 1px solid transparent;
            border-radius: 10px; background: var(--shade); color: var(--ink); font-size: 14px;
            font-family: inherit; transition: background .15s ease, border-color .15s ease,
            box-shadow .15s ease; }
  .kw-box:focus { outline: none; background: var(--card); border-color: var(--accent);
                  box-shadow: 0 0 0 3px var(--accent-soft); }
  .kw-hint { margin: 6px 2px 0; font-size: 11px; color: var(--ink-3); }
  .rail-sec { margin: 18px 0 4px; font-size: 12px; color: var(--ink-2); font-weight: 500;
              letter-spacing: .12em; display: flex; align-items: center; gap: 10px; }
  .rail-sec::after { content: ""; flex: 1; border-bottom: 1px solid var(--rule); }
  .cat-nav { display: flex; flex-direction: column; gap: 1px; margin: 6px 0 14px; }
  .cat-btn { display: flex; align-items: baseline; gap: 7px;
             background: none; border: none; padding: 6px 10px; border-radius: 8px;
             color: var(--ink-2); font-size: 14px; cursor: pointer; font-family: inherit;
             text-align: left; width: 100%; position: relative;
             transition: background .12s ease, color .12s ease; }
  .cat-btn:hover { background: var(--shade); color: var(--ink); }
  .cat-btn.active { background: var(--accent-soft); color: var(--accent-deep); font-weight: 600; }
  .cat-btn.active::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px;
                            width: 2.5px; border-radius: 2px; background: var(--accent); }
  .cat-hash { color: var(--accent); flex: none; font-family: var(--mono); font-size: 13px; }
  .cat-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cat-count { font-size: 12px; color: var(--ink-3); flex: none;
               font-variant-numeric: tabular-nums; font-family: var(--mono); }
  /* meta 沉到侧栏底：标签少时也不留半截空白 */
  .rail-meta { margin-top: auto; padding-top: 12px; border-top: 1px solid var(--rule);
               font-size: 12px; line-height: 1.7; color: var(--ink-3); font-family: var(--mono); }
  .rail-meta .tbtn { margin-top: 12px; min-height: 30px; padding: 3px 12px; font-size: 12px; }

  /* ── 主列 ── */
  .kn-main { width: 100%; max-width: 900px; margin: 0 auto; padding: 22px 24px 64px; }

  /* 卷首横带：全页视觉锚点——衬线大数字台账 + 朱砂热力带 */
  .kn-hero { display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
             background: var(--card); border: 1px solid var(--rule); border-radius: 14px;
             box-shadow: var(--shadow-sm); padding: 16px 22px; margin-bottom: 16px; }
  .hero-stats { display: flex; align-items: baseline; flex: none; }
  .hs-cell { display: flex; align-items: baseline; gap: 8px; padding: 0 22px;
             border-left: 1px solid var(--rule); }
  .hs-cell:first-child { border-left: none; padding-left: 0; }
  .hs-cell .n { font-family: var(--serif); font-size: 34px; font-weight: 600; line-height: 1.05;
                color: var(--ink); font-variant-numeric: tabular-nums; }
  .hs-cell.hot .n { color: var(--accent); }
  .hs-cell .l { font-size: 12px; color: var(--ink-3); }
  .hero-heat { flex: 1; min-width: 250px; display: flex; flex-direction: column;
               align-items: flex-end; gap: 6px; }
  /* 列=周、行=星期（grid-auto-flow: column 按周下行填充），
     旧版按行铺 16 列会把同一周折行、看起来像坏掉的灰块 */
  .heat-grid { display: grid; grid-template-rows: repeat(7, var(--heat-s));
               grid-auto-flow: column; grid-auto-columns: var(--heat-s); gap: 3px; }
  .heat-cell { border-radius: 3px; background: var(--heat-0); transition: transform .1s ease; }
  .heat-cell:hover { transform: scale(1.25); }
  .heat-cell.h1 { background: var(--heat-1); }
  .heat-cell.h2 { background: var(--heat-2); }
  .heat-cell.h3 { background: var(--heat-3); }
  .heat-cell.blank { background: transparent; }
  .heat-note { margin: 0; font-size: 11.5px; color: var(--ink-3); }

  /* 发布框：带朱砂竖签的白纸便签，聚焦时阴影浮起 */
  .composer { position: relative; border: 1px solid var(--rule); border-radius: 14px;
              background: var(--card); padding: 6px 16px 12px 20px; margin-bottom: 20px;
              box-shadow: var(--shadow-sm);
              transition: border-color .18s ease, box-shadow .18s ease; }
  .composer::before { content: ""; position: absolute; left: 0; top: 14px; bottom: 14px;
                      width: 3px; border-radius: 3px; background: var(--accent); opacity: .85; }
  .composer:focus-within { border-color: var(--rule-2); box-shadow: var(--shadow-md); }
  .cp-text { width: 100%; min-height: 68px; border: none; outline: none; resize: vertical;
             background: transparent; color: var(--ink); font-size: 15px; line-height: 1.65;
             font-family: inherit; padding: 10px 0 6px; }
  .cp-text::placeholder { color: var(--ink-3); }
  .cp-row { display: flex; align-items: center; gap: 8px; }
  .cp-subject { flex: 1; min-width: 0; border: 1px solid transparent; border-radius: 8px;
                background: var(--shade); color: var(--ink); font-size: 13px;
                padding: 6px 12px; font-family: inherit;
                transition: background .15s ease, box-shadow .15s ease; }
  .cp-subject:focus { outline: none; background: var(--card);
                      box-shadow: 0 0 0 1.5px var(--accent); }
  .cp-send { flex: none; border: none; border-radius: 8px; background: var(--accent);
             color: #FCFBF7; font-size: 14px; font-weight: 500; padding: 7px 20px;
             cursor: pointer; font-family: inherit;
             transition: background .15s ease, box-shadow .15s ease; }
  .cp-send:hover { background: var(--accent-deep); box-shadow: 0 2px 10px rgba(173, 57, 44, 0.28); }
  .cp-send:active { transform: translateY(1px); }
  .cp-send:disabled { opacity: .5; cursor: default; box-shadow: none; }
  .cp-note { margin: 6px 0 0; font-size: 12.5px; color: var(--ink-3); }
  .cp-note.ok { color: var(--accent-deep); }
  .cp-note.err { color: var(--accent-deep); }

  .skel { color: var(--ink-3); font-size: 15px; padding: 8px 2px; }
  .empty { margin: 0; padding: 32px 20px; border: 1.5px dashed var(--rule-2); text-align: center;
           border-radius: 12px; background: var(--card); color: var(--ink-3); font-size: 14px;
           line-height: 1.8; }

  /* 按日分组头：朱砂菱标 + 衬线日期 + mono 计数 + 引导细线 */
  .day-head { display: flex; align-items: baseline; gap: 10px; margin: 26px 2px 12px; }
  .day-head::after { content: ""; flex: 1; border-bottom: 1px solid var(--rule);
                     transform: translateY(-3px); }
  .day-mark { flex: none; align-self: center; width: 7px; height: 7px; border-radius: 1.5px;
              background: var(--accent); transform: rotate(45deg); }
  .day-label { font-family: var(--serif); font-size: 15px; font-weight: 600;
               letter-spacing: .02em; color: var(--ink); }
  .day-head .day-count { font-size: 12px; color: var(--ink-3); font-weight: 400;
                         font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .day-head:first-child { margin-top: 0; }

  /* 档案卡：左缘签条（hover 点亮朱砂）、衬线标题独立成行、右上 mono 档号 */
  .k-entry { padding: 14px 18px 12px 20px; border: 1px solid var(--rule);
             border-left: 3px solid var(--rule-2); background: var(--card);
             border-radius: 12px; margin-bottom: 12px; box-shadow: var(--shadow-sm);
             transition: border-color .15s ease, box-shadow .18s ease, transform .18s ease; }
  .k-entry:hover { border-color: var(--rule-2); border-left-color: var(--accent);
                   box-shadow: var(--shadow-md); transform: translateY(-1px); }
  .k-head { display: flex; align-items: baseline; gap: 12px; }
  .k-title { flex: 1; min-width: 0; font-family: var(--serif); font-size: 16.5px;
             font-weight: 600; line-height: 1.5; color: var(--ink); overflow-wrap: anywhere; }
  .k-no { flex: none; font-family: var(--mono); font-size: 11px; color: var(--ink-3);
          letter-spacing: .08em; font-variant-numeric: tabular-nums; }
  .k-text { margin: 4px 0 0; font-size: 14.5px; line-height: 1.75; color: var(--ink-2);
            white-space: pre-wrap; overflow-wrap: anywhere; }
  .k-text a { color: var(--accent-deep); text-decoration: underline;
              text-underline-offset: 2px; }
  .k-text a:hover { color: var(--accent); }
  .k-text.clamp { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
                  overflow: hidden; }
  .k-toggle { justify-self: start; background: none; border: none; padding: 2px 0;
              color: var(--ink-3); font-size: 12px; cursor: pointer; margin-top: 4px; }
  .k-toggle:hover { color: var(--accent); text-decoration: underline; }
  mark { background: var(--accent-soft); color: var(--accent-deep); padding: 0 1px; }
  .k-foot { display: flex; align-items: center; gap: 12px; margin-top: 10px;
            font-size: 12.5px; }
  .k-tag { background: var(--accent-soft); border: none; border-radius: 999px;
           padding: 2px 11px; color: var(--accent-deep); cursor: pointer;
           font-family: inherit; font-size: 12px; line-height: 1.6;
           max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
           transition: background .15s ease, color .15s ease; }
  .k-tag:hover { background: var(--accent); color: #FCFBF7; }
  .k-tag.none { background: var(--shade); color: var(--ink-3); }
  .k-tag.none:hover { background: var(--rule-2); color: var(--ink); }
  .k-date { flex: none; color: var(--ink-3); white-space: nowrap; font-family: var(--mono);
            font-size: 12px; }
  .k-ops { margin-left: auto; display: flex; gap: 2px; opacity: 0;
           transition: opacity .15s ease; }
  .k-entry:hover .k-ops, .k-ops:focus-within { opacity: 1; }
  .k-del { background: none; border: none; padding: 2px 4px; color: var(--ink-3); flex: none;
           font-size: 12px; cursor: pointer; }
  .k-del:hover { color: var(--accent); text-decoration: underline; }
  .k-del.armed { color: #FCFBF7; background: var(--accent); border-radius: 4px;
                 padding: 2px 8px; }
  .k-more { display: block; margin: 14px auto 0; min-height: 36px; padding: 6px 22px;
            font-size: 13px; border-radius: 999px; background: var(--card); }
  .k-more:hover { background: var(--card); box-shadow: var(--shadow-sm); }

  /* ── 条目编辑态：卡片原地变表单 ── */
  .k-edit { display: grid; gap: 8px; }
  .k-edit input, .k-edit textarea { border: 1px solid transparent; border-radius: 8px;
                                    background: var(--shade); color: var(--ink); font-size: 14px;
                                    padding: 7px 12px; font-family: inherit; width: 100%; }
  .k-edit input:focus, .k-edit textarea:focus { outline: none; background: var(--card);
                                                box-shadow: 0 0 0 1.5px var(--accent); }
  .k-edit-title { font-weight: 600; }
  .k-edit-content { min-height: 96px; resize: vertical; line-height: 1.65; }
  .k-edit-row { display: flex; align-items: center; gap: 8px; }
  .k-edit-subject { flex: 1; }
  .k-save { border: none; border-radius: 8px; background: var(--accent); color: #FCFBF7;
            font-size: 13px; font-weight: 500; padding: 7px 18px; cursor: pointer;
            font-family: inherit; }
  .k-save:hover { background: var(--accent-deep); }
  .k-cancel { background: none; border: 1px solid var(--rule-2); border-radius: 8px;
              color: var(--ink-2); font-size: 13px; padding: 6px 14px; cursor: pointer;
              font-family: inherit; }
  .k-cancel:hover { border-color: var(--ink-3); color: var(--ink); }
  .k-edit .cp-note { margin: 0; }

  /* 首屏一次轻浮入（卷首→发布框→前几条卡），搜索/筛选重渲不再播 */
  @keyframes rise { from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: none; } }
  .enter { animation: rise .38s cubic-bezier(.2, .7, .3, 1) both; }

  @media (max-width: 720px) {
    :root { --heat-s: 10px; }
    .pagehead { flex-wrap: wrap; height: auto; padding: 12px 16px; gap: 10px 12px;
                background: rgba(246, 244, 237, 0.96); }
    .pagehead .seal { width: 38px; height: 38px; }
    .pagehead .seal img { top: 4px; left: 4px; width: 30px; height: 30px; }
    .ph-title h1 { font-size: 20px; }
    .ph-title .ph-stamp { display: none; }
    .ph-right { width: 100%; flex-wrap: wrap; justify-content: flex-end; }
    .ph-right .tbtn { flex: none; white-space: nowrap; }
    main { display: block; min-height: 0; }
    .kn-rail { position: static; min-height: 0; max-height: none; overflow: visible;
               border-right: none; border-bottom: 1px solid var(--rule); padding: 14px 16px 16px; }
    .cat-nav { flex-direction: row; flex-wrap: wrap; gap: 4px; margin: 6px 0 4px; }
    .cat-btn { border: 1px solid var(--rule-2); background: var(--paper); padding: 4px 10px;
               width: auto; }
    .cat-btn.active::before { display: none; }
    .cat-label { max-width: 9em; }
    .rail-meta { margin-top: 10px; padding-top: 10px; }
    .kn-main { padding: 16px 14px 56px; }
    .kn-hero { flex-direction: column; align-items: stretch; gap: 14px; padding: 14px 16px; }
    .hero-stats { flex-wrap: wrap; gap: 8px 0; }
    .hs-cell { padding: 0 16px; }
    .hs-cell .n { font-size: 28px; }
    .hero-heat { min-width: 0; align-items: flex-start; }
  }
  /* 触屏：搜索框提到 16px 防 iOS 聚焦缩放；小字按钮放大到能点的尺寸；
     操作按钮触屏没有 hover，常显 */
  @media (hover: none) {
    .kw-box { font-size: 16px; }
    .cat-btn { min-height: 38px; }
    .k-del { min-height: 34px; padding: 6px 12px; }
    .k-toggle { min-height: 34px; padding: 8px 0; }
    .k-more { min-height: 38px; }
    .k-tag { min-height: 30px; }
    .k-ops { opacity: 1; }
  }
  @media print {
    body { background: #fff; }
    .ph-right, .kw-box, .kw-hint, .rail-meta, .composer, .hero-heat,
    .k-del, .k-toggle, .k-more { display: none !important; }
    .k-text.clamp { display: block; -webkit-line-clamp: unset; }
    main { display: block; max-width: none; padding: 0; }
    .kn-rail { display: none; }
    .kn-main { padding: 0; max-width: none; }
    .kn-hero, .k-entry { box-shadow: none; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
</style>
</head>
<body data-demo="${demo}">
<header class="pagehead">
  <span class="seal" aria-hidden="true"><img src="/logo.png" alt="" width="34" height="34"></span>
  <div class="ph-title">
    <h1>知识库</h1>
    <span class="ph-stamp">COURSERAPTOR · KNOWLEDGE</span>
  </div>
  <div class="ph-right">
    <a class="tbtn" href="/today">今日日程</a>
    <a class="tbtn" href="/">返回对话</a>
  </div>
</header>
<main>
  <aside class="kn-rail" aria-label="知识分类">
    <input class="kw-box" id="kwBox" type="search" enterkeyhint="search" placeholder="搜索知识…" aria-label="搜索知识">
    <p class="kw-hint">按 / 聚焦 · Esc 清空</p>
    <p class="rail-sec">标签</p>
    <div class="cat-nav" id="catNav"></div>
    <div class="rail-meta" id="knMeta"></div>
  </aside>
  <section class="kn-main" aria-label="知识川流">
    <section class="kn-hero" id="knHero" aria-label="积累概览">
      <div class="hero-stats" id="heroStats"></div>
      <div class="hero-heat" id="heroHeat"></div>
    </section>
${
  demo
    ? ""
    : `    <div class="composer" id="composer">
      <textarea class="cp-text" id="cpText" rows="3" placeholder="记点什么…（首行作为标题，其余为正文；Ctrl+Enter 记下）" aria-label="记录新知识"></textarea>
      <div class="cp-row">
        <input class="cp-subject" id="cpSubject" type="text" placeholder="分类（可选，留空自动归课表课程）" aria-label="知识分类">
        <button type="button" class="cp-send" id="cpSend">记下</button>
      </div>
      <p class="cp-note" id="cpNote" hidden></p>
    </div>
`
}
    <div class="kn-flow" id="listBody"><p class="skel">…</p></div>
  </section>
</main>
<script>
const CLAMP_LEN = ${CLAMP_LEN};
const BATCH = ${BATCH};
const HEAT_WEEKS = ${HEAT_WEEKS};
${demo && demoData ? `const DEMO_DATA = ${JSON.stringify(demoData)};` : "const DEMO_DATA = null;"}
const $ = (id) => document.getElementById(id);
let entries = [];
let activeCat = "ALL"; // "ALL" | "NONE"（未分类）| 具体课程名
let keyword = "";
let visibleCount = BATCH;
let editingId = null; // 条目编辑态：有值时自动刷新暂停，不打断输入
let firstPaint = true; // 首屏浮入动画只播一次
const expandedIds = new Set();
/* 档号：按创建顺序的全局编号（№ 001…），与筛选无关 */
let serialById = new Map();

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function fmtDay(ts) {
  const d = new Date(ts);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
}
function dayKey(d) {
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}
/* 相对时间：今天 / 昨天 / N 天前 / M月D日（flomo 式时间显示） */
function fmtAgo(ts) {
  if (!ts) return "—";
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(new Date(ts))) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 30) return diff + " 天前";
  return fmtDay(ts);
}
/* 命中高亮：纯 DOM 拼接（不走 innerHTML），把关键词片段包进 <mark> */
function appendMarked(parent, text, kw) {
  if (!kw) { parent.appendChild(document.createTextNode(text)); return; }
  const lower = text.toLowerCase();
  const k = kw.toLowerCase();
  let i = 0;
  let at = lower.indexOf(k);
  while (at >= 0) {
    if (at > i) parent.appendChild(document.createTextNode(text.slice(i, at)));
    parent.appendChild(el("mark", null, text.slice(at, at + k.length)));
    i = at + k.length;
    at = lower.indexOf(k, i);
  }
  parent.appendChild(document.createTextNode(text.slice(i)));
}
/* 正文里的长链接自动识别成可点链接（新标签打开）：先按 URL 切片，
   链接段整段成 <a>、纯文本段再走命中高亮；与大厅知识面板同一套口径 */
const URL_RE =
  /(https?:\\/\\/[A-Za-z0-9._~:\\/?#\\[\\]@!$&'()*+,;=%-]+|www\\.[A-Za-z0-9._~:\\/?#\\[\\]@!$&'()*+,;=%-]+)/gi;
function appendRich(parent, text, kw) {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?'")\\]]+$/, "");
    const at = m.index;
    const end = at + url.length;
    if (end <= at) continue;
    if (at > last) appendMarked(parent, text.slice(last, at), kw);
    const a = document.createElement("a");
    a.href = /^www\\./i.test(url) ? "https://" + url : url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    appendMarked(a, url, kw);
    parent.appendChild(a);
    last = end;
  }
  if (last < text.length) appendMarked(parent, text.slice(last), kw);
}
/* 两步删除：第一次点变身「确认删除」，3 秒内再点才执行，超时还原 */
function armDelete(btn, onConfirm) {
  if (btn.dataset.armed === "1") { onConfirm(); return; }
  btn.dataset.armed = "1";
  const label = btn.textContent;
  btn.textContent = "确认删除";
  btn.classList.add("armed");
  setTimeout(() => {
    btn.dataset.armed = "";
    btn.textContent = label;
    btn.classList.remove("armed");
  }, 3000);
}
/* 首屏浮入：给节点挂 .enter 并错峰，仅 firstPaint 期间生效 */
function rise(node, i) {
  if (!firstPaint) return node;
  node.classList.add("enter");
  node.style.animationDelay = Math.min(i, 12) * 30 + "ms";
  return node;
}

function catCounts() {
  const m = new Map();
  for (const e of entries) {
    const key = e.category || "";
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
}
/* 川流：恒按更新时间倒序（flomo 只有一条时间流，没有排序切换） */
function filtered() {
  let list = entries;
  if (activeCat === "NONE") list = list.filter((e) => !e.category);
  else if (activeCat !== "ALL") list = list.filter((e) => e.category === activeCat);
  if (keyword) {
    const kw = keyword.toLowerCase();
    list = list.filter((e) =>
      (e.title + "\\n" + e.content + "\\n" + (e.category || "未分类")).toLowerCase().includes(kw));
  }
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

function renderNav() {
  const counts = catCounts();
  const cats = [...counts.entries()].filter(([k]) => k)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
  const nav = $("catNav");
  nav.textContent = "";
  nav.appendChild(catBtn("ALL", "全部", entries.length));
  for (const [name, n] of cats) nav.appendChild(catBtn(name, name, n, true));
  const none = counts.get("") || 0;
  if (none) nav.appendChild(catBtn("NONE", "未分类", none));
}

function catBtn(key, label, count, isTag) {
  const btn = el("button", "cat-btn" + (activeCat === key ? " active" : ""));
  btn.type = "button";
  btn.dataset.cat = key;
  if (isTag) btn.appendChild(el("span", "cat-hash", "#"));
  btn.appendChild(el("span", "cat-label", label));
  btn.appendChild(el("span", "cat-count", String(count)));
  btn.addEventListener("click", () => {
    activeCat = key;
    visibleCount = BATCH;
    renderNav();
    renderList();
    /* 导航重建后焦点归位到同分类（键盘用户不用重新 Tab） */
    for (const b of document.querySelectorAll("#catNav .cat-btn")) {
      if (b.dataset.cat === key) { b.focus(); break; }
    }
  });
  return btn;
}

/* 卷首台账：条数 / 标签数 / 连续记录天数（衬线大数字） */
function renderHeroStats() {
  const host = $("heroStats");
  host.textContent = "";
  const cats = catCounts();
  const days = new Set();
  for (const e of entries) days.add(dayKey(new Date(e.updatedAt)));
  /* 连续记录：从今天往回数；今天还没记就从昨天起算 */
  const cursor = new Date();
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  const cell = (n, l, hot) => {
    const c = el("div", "hs-cell" + (hot ? " hot" : ""));
    c.appendChild(el("span", "n", String(n)));
    c.appendChild(el("span", "l", l));
    return c;
  };
  host.appendChild(cell(entries.length, "条知识"));
  host.appendChild(cell([...cats.keys()].filter(Boolean).length, "个标签"));
  host.appendChild(cell(streak, "天连续记录", streak > 0));
}

/* 卷首热力带：近 N 周每日条目数，列=周行=星期，朱砂四档 */
function renderHeroHeat() {
  const host = $("heroHeat");
  host.textContent = "";
  const counts = new Map();
  for (const e of entries) {
    const k = dayKey(new Date(e.updatedAt));
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 周一=0，对齐周列
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow);
  const grid = el("div", "heat-grid");
  grid.setAttribute("role", "img");
  grid.setAttribute("aria-label", "近 " + HEAT_WEEKS + "周的知识热力图");
  for (let w = HEAT_WEEKS - 1; w >= 0; w--) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - w * 7 + d);
      const cell = el("div", "heat-cell");
      if (date > today) {
        cell.classList.add("blank");
      } else {
        const n = counts.get(dayKey(date)) || 0;
        if (n > 0) cell.classList.add(n <= 2 ? "h1" : n <= 5 ? "h2" : "h3");
        cell.title = fmtDay(date.getTime()) + "：" + n + " 条";
      }
      grid.appendChild(cell);
    }
  }
  host.appendChild(grid);
  host.appendChild(el("p", "heat-note", "近 " + HEAT_WEEKS + " 周 · 颜色越深记得越多"));
}

function renderRailMeta() {
  const meta = $("knMeta");
  meta.textContent = "";
  if (DEMO_DATA) {
    meta.appendChild(el("div", null, "演示数据 · 只读"));
    return;
  }
  meta.appendChild(el("div", null, "每 60 秒自动刷新"));
  const btn = el("button", "tbtn", "刷新");
  btn.type = "button";
  btn.addEventListener("click", load);
  meta.appendChild(btn);
}

function entryEl(item, order) {
  const card = el("article", "k-entry");
  card.dataset.kid = item.id;
  if (editingId === item.id) return editEl(card, item);
  /* 档案卡头：衬线标题 + 右上档号（按创建顺序） */
  const head = el("div", "k-head");
  const title = el("strong", "k-title");
  appendMarked(title, item.title, keyword);
  head.appendChild(title);
  const no = serialById.get(item.id);
  if (no) head.appendChild(el("span", "k-no", "№ " + String(no).padStart(3, "0")));
  card.appendChild(head);
  const long = item.content && item.content !== item.title;
  if (long) {
    const text = el("p", "k-text");
    appendRich(text, item.content, keyword);
    if (item.title.length + item.content.length > CLAMP_LEN && !expandedIds.has(item.id)) {
      text.classList.add("clamp");
    }
    card.appendChild(text);
    if (item.title.length + item.content.length > CLAMP_LEN) {
      const toggle = el("button", "k-toggle", expandedIds.has(item.id) ? "收起" : "展开全文");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", expandedIds.has(item.id) ? "true" : "false");
      toggle.addEventListener("click", () => {
        if (expandedIds.has(item.id)) {
          expandedIds.delete(item.id);
          text.classList.add("clamp");
          toggle.textContent = "展开全文";
          toggle.setAttribute("aria-expanded", "false");
        } else {
          expandedIds.add(item.id);
          text.classList.remove("clamp");
          toggle.textContent = "收起";
          toggle.setAttribute("aria-expanded", "true");
        }
      });
      card.appendChild(toggle);
    }
  }
  const foot = el("div", "k-foot");
  const tag = el("button", "k-tag" + (item.category ? "" : " none"), "# " + (item.category || "未分类"));
  tag.type = "button";
  if (item.category) tag.title = item.category;
  tag.addEventListener("click", () => {
    activeCat = item.category || "NONE";
    visibleCount = BATCH;
    renderNav();
    renderList();
    window.scrollTo({ top: 0 });
  });
  foot.appendChild(tag);
  foot.appendChild(el("span", "k-date", fmtAgo(item.updatedAt)));
  if (!DEMO_DATA) {
    const ops = el("div", "k-ops");
    const edit = el("button", "k-del", "编辑");
    edit.type = "button";
    edit.addEventListener("click", () => {
      editingId = item.id;
      renderList();
    });
    ops.appendChild(edit);
    const del = el("button", "k-del", "删除");
    del.type = "button";
    del.addEventListener("click", () => {
      armDelete(del, () => {
        fetch("/api/knowledge/" + item.id, { method: "DELETE" }).then(load).catch(load);
      });
    });
    ops.appendChild(del);
    foot.appendChild(ops);
  }
  card.appendChild(foot);
  return rise(card, order);
}

function emptyEl(text) {
  return el("p", "empty", text);
}
/* 空库引导：有发布框时引导直写，演示模式引导回对话页 */
function emptyNewEl() {
  return emptyEl(DEMO_DATA
    ? "知识库还是空的。在对话页分享你学到的知识点（或说「记住：……」），我会自动记进知识库并按课程归类。"
    : "知识库还是空的。在上方直接记一条（首行作标题），或在对话里说「记住：……」我来记下并按课程归类。");
}

/* 条目编辑态：卡片原地变表单，保存走 PATCH，分类留空即自动归课表课程 */
function editEl(card, item) {
  const form = el("div", "k-edit");
  const title = el("input", "k-edit-title");
  title.type = "text";
  title.value = item.title;
  const content = el("textarea", "k-edit-content");
  content.value = item.content;
  const subject = el("input", "k-edit-subject");
  subject.type = "text";
  subject.value = item.category || "";
  subject.placeholder = "分类（留空自动归课表课程）";
  const note = el("p", "cp-note");
  note.hidden = true;
  const save = el("button", "k-save", "保存");
  save.type = "button";
  const cancel = el("button", "k-cancel", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", () => { editingId = null; renderList(); });
  const fail = (msg) => {
    save.disabled = false;
    note.hidden = false;
    note.className = "cp-note err";
    note.textContent = msg;
  };
  save.addEventListener("click", () => {
    save.disabled = true;
    fetch("/api/knowledge/" + item.id, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title.value, content: content.value, subject: subject.value }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) { fail(d.error || "保存失败"); return; }
        editingId = null;
        load();
      })
      .catch(() => fail("网络错误，稍后再试"));
  });
  for (const field of [title, content, subject]) {
    field.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") save.click();
    });
  }
  const row = el("div", "k-edit-row");
  row.appendChild(subject);
  row.appendChild(save);
  row.appendChild(cancel);
  form.appendChild(title);
  form.appendChild(content);
  form.appendChild(row);
  form.appendChild(note);
  card.appendChild(form);
  return card;
}

function moreBtn(list, shown) {
  const more = el("button", "tbtn k-more", "显示更多（还有 " + (list.length - shown.length) + " 条）");
  more.type = "button";
  more.addEventListener("click", () => { visibleCount += BATCH; renderList(); });
  return more;
}

/* 川流主体：按日分组（朱砂菱标日期头），恒按更新时间倒序 */
function renderList() {
  const host = $("listBody");
  host.textContent = "";
  if (!entries.length) {
    host.appendChild(emptyNewEl());
    firstPaint = false;
    return;
  }
  const list = filtered();
  if (!list.length) {
    host.appendChild(emptyEl("没有匹配的知识条目，换个关键词或标签试试。"));
    firstPaint = false;
    return;
  }
  const shown = list.slice(0, visibleCount);
  const today = new Date().toDateString();
  const byDay = [];
  for (const item of shown) {
    const d = new Date(item.updatedAt);
    const key = dayKey(d);
    if (!byDay.length || byDay[byDay.length - 1].key !== key) {
      byDay.push({ key: key, label: d.toDateString() === today ? "今天" : fmtDay(item.updatedAt), items: [] });
    }
    byDay[byDay.length - 1].items.push(item);
  }
  let order = 2; // 0/1 留给卷首与发布框
  for (const g of byDay) {
    const head = el("div", "day-head");
    head.appendChild(el("span", "day-mark"));
    head.appendChild(el("span", "day-label", g.label));
    head.appendChild(el("span", "day-count", g.items.length + " 条"));
    host.appendChild(rise(head, order));
    order++;
    for (const item of g.items) {
      host.appendChild(entryEl(item, order));
      order++;
    }
  }
  if (list.length > shown.length) host.appendChild(moreBtn(list, shown));
  firstPaint = false;
}

/* 发布框：首行=标题、其余=正文，Ctrl+Enter 记下 */
function bindComposer() {
  const box = $("composer");
  if (!box) return;
  const text = $("cpText");
  const subject = $("cpSubject");
  const send = $("cpSend");
  const note = $("cpNote");
  const flash = (msg, ok) => {
    note.hidden = false;
    note.className = "cp-note" + (ok ? " ok" : " err");
    note.textContent = msg;
    if (ok) setTimeout(() => { note.hidden = true; }, 2600);
  };
  const submit = () => {
    const raw = text.value.trim();
    if (!raw) { flash("先写点什么再记下", false); return; }
    const lines = raw.split("\\n");
    const title = lines[0].trim().slice(0, 80);
    const content = lines.slice(1).join("\\n").trim();
    if (!title) { flash("首行是标题，不能为空", false); return; }
    send.disabled = true;
    fetch("/api/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, content: content || title, subject: subject.value.trim() }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        send.disabled = false;
        if (!ok) { flash(d.error || "保存失败", false); return; }
        text.value = "";
        subject.value = "";
        flash(d.updatedExisting ? "已有同名知识，已更新" : "已记下", true);
        visibleCount = BATCH;
        load();
      })
      .catch(() => { send.disabled = false; flash("网络错误，稍后再试", false); });
  };
  send.addEventListener("click", submit);
  text.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") submit();
  });
}

function renderAll() {
  serialById = new Map(
    [...entries].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((e, i) => [e.id, i + 1]),
  );
  renderNav();
  renderHeroStats();
  renderHeroHeat();
  renderRailMeta();
  renderList();
  if (firstPaint) {
    rise($("knHero"), 0);
    const composer = $("composer");
    if (composer) rise(composer, 1);
  }
}

function load() {
  if (DEMO_DATA) { entries = DEMO_DATA; renderAll(); return; }
  /* 编辑中的表单不重渲（60 秒自动刷新不能吃掉输入框里的字） */
  if (editingId) return;
  fetch("/api/knowledge", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((d) => { entries = d.entries || []; renderAll(); })
    .catch(() => {
      const host = $("listBody");
      host.textContent = "";
      host.appendChild(emptyEl("知识暂时取不出来，请稍候刷新。"));
    });
}
$("kwBox").addEventListener("input", (ev) => {
  keyword = ev.target.value.trim();
  visibleCount = BATCH;
  renderList();
});
/* 部分浏览器点搜索框原生 × 只发 search 不发 input，兜底同步一次 */
$("kwBox").addEventListener("search", (ev) => {
  keyword = ev.target.value.trim();
  visibleCount = BATCH;
  renderList();
});
$("kwBox").addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && ev.target.value) {
    ev.target.value = "";
    keyword = "";
    visibleCount = BATCH;
    renderList();
  }
});
// / 快捷聚焦搜索（正在输入时忽略）
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "/") return;
  const t = ev.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  ev.preventDefault();
  $("kwBox").focus();
});
bindComposer();
load();
if (!DEMO_DATA) {
  setInterval(load, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
}
</script>
</body>
</html>`;
}
