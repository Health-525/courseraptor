/** 网页视图：正式服务与离线演示共用，不依赖账号、模型或会话存储。
 *
 * 前端应用代码在 assets/chat-app.js（独立 JS 资产：编辑器与工具可直接解析，
 * 语法自检也有测试兜底），此处读入后内联进页面——保持单文件交付，浏览器
 * 不多发一个请求。演示模式由 body[data-demo] 传给前端，代码本体不分叉。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "assets", "chat-app.js");
let appJsCache: string | null = null;

function appJs(): string {
  if (appJsCache === null) {
    try {
      appJsCache = fs.readFileSync(APP_JS, "utf8");
    } catch {
      // 资产读不到时页面仍可打开，但在控制台明确报因，不渲染一个死页面
      appJsCache = 'console.error("前端脚本缺失：src/web/assets/chat-app.js 不可读");';
    }
  }
  return appJsCache;
}

export function chatPage(options: { demo?: boolean } = {}): string {
  const demo = options.demo === true;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/logo.png">
<title>CourseRaptor</title>
<script src="/vendor/marked.min.js"></script>
<style>
  /* ── 设计令牌：红头档案（编辑部排版风）──
     暖纸底 + 墨色字 + 单一朱砂红；报头楷体、数据等宽小字、正文系统黑体。
     没有渐变、没有光斑、没有玻璃——所有颜色只在这一个 :root 里定义。 */
  :root {
    color-scheme: light;
    --paper: #F6F4ED;   /* 纸面 */
    --paper-deep: #F0EDE4;
    --card: #FCFBF7;    /* 浮起的纸片 */
    --shade: #ECE8DD;   /* 压深的纸（表头/代码底） */
    --ink: #25221C;     /* 墨 */
    --ink-2: #5A554A;
    /* 旧值 #898274 在纸底上仅 ~3.5:1，调深以满足 WCAG AA（小字 ≥4.5:1，与 today/knowledge 页一致） */
    --ink-3: #6E6656;
    --rule: #E1DCCF;    /* 细线 */
    --rule-2: #C9C1AF;  /* 重一点的线 */
    --accent: #AD392C;      /* 朱砂 */
    --accent-deep: #852B22;
    --accent-soft: #F3E3DE;
    --shadow-sm: 0 8px 24px rgba(50, 42, 31, 0.055);
    --serif: Georgia, "Times New Roman", "Songti SC", SimSun, serif;
    --kai: "KaiTi", "STKaiti", "Kaiti SC", var(--serif);
    --sans: system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --mono: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  /* 锁定整页：只有消息区能滚，输入/发送条永远钉在视口底部；
     dvh 让移动端键盘弹出时底栏跟着抬进可见区而不是被顶出屏幕。
     第三列 0px 是功能大厅的坑位：打开时撑到 min(420px, 40vw)，
     聊天主区被真实地往左推——不是浮层盖上来。 */
  body { margin: 0; display: grid; grid-template-columns: 284px 1fr 0;
         height: 100vh; height: 100dvh; overflow: hidden;
         background: var(--paper); color: var(--ink);
         font-family: var(--sans); font-size: 16px; line-height: 1.7;
         -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
         transition: grid-template-columns .24s ease; }
  body.hall-open { grid-template-columns: 284px 1fr min(420px, 40vw); }
  ::selection { background: var(--accent-soft); }
  button, input, textarea { font-family: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* 纯文字品牌标：不用徽章与副标题，靠字重和双色建立辨识度。 */
  .wordmark { display: inline-flex; align-items: baseline; font-family: var(--sans);
              font-weight: 500; letter-spacing: -.035em; white-space: nowrap; }
  .wordmark .course { color: var(--ink-2); }
  .wordmark .raptor { color: var(--accent); font-weight: 750; }

  /* ── 左栏：档头 ── */
  aside { display: flex; flex-direction: column; gap: 28px; min-height: 0;
          padding: 27px 22px 20px; border-right: 1px solid var(--rule);
          background: var(--paper-deep); overflow: hidden; }
  .mast { padding: 2px 0; }
  .mast h1 { display: flex; margin: 0; font-size: 21px; line-height: 1.2; }
  .mast h1::after { content: ""; flex: 1; align-self: center; height: 1px;
                    margin: 2px 0 0 15px; background: var(--rule-2); }
  .sec { display: flex; flex: 1; min-height: 0; flex-direction: column; }
  .sec h2 { display: flex; justify-content: space-between; align-items: baseline;
            flex: none;
            margin: 0 0 11px; padding-bottom: 8px;
            font-family: var(--mono); font-size: 12px; font-weight: 600;
            letter-spacing: .14em; color: var(--ink-3);
            border-bottom: 1px solid var(--rule); }
  .sec h2 span { letter-spacing: .04em; font-weight: 400; }
  /* h2 右侧一组：计数 + 归档入口（没有归档过时按钮整个隐去） */
  .sec h2 .hside { display: inline-flex; align-items: baseline; gap: 10px; }
  #sessArchiveToggle { border: 0; background: none; padding: 0; cursor: pointer;
                       font-family: var(--mono); font-size: 11px; font-weight: 400;
                       letter-spacing: .04em; color: var(--ink-3); }
  #sessArchiveToggle:hover { color: var(--accent); }
  /* 竖排：新会话主按钮在上，今日日程 / 知识库入口各占一行在其下 */
  .mastbtns { display: flex; flex-direction: column; gap: 8px; }
  /* 竖排 flex 会把子项块化：链接里的文字水平居中要用 text-align，不是 justify-content */
  .mastbtns .tbtn { text-align: center; }
  .mastbtns .tbtn.primary { background: var(--accent);
                            border-color: var(--accent); color: var(--card);
                            font-weight: 600; letter-spacing: .12em; }
  .mastbtns .tbtn.primary:hover { background: var(--accent-deep);
                                  border-color: var(--accent-deep); color: #fff; }
  /* 大厅入口：朱砂同族浅底深字，与主按钮构成主/次两级；不要描边（用户要求），悬停加深成实底 */
  #openHall, #openHallM { position: relative; }
  /* 侧栏红点（与宫格卡片内的文字徽标 .hall-badge 是两回事） */
  .hall-dot { position: absolute; top: -4px; right: -4px; width: 9px; height: 9px;
              border-radius: 50%; background: var(--accent);
              box-shadow: 0 0 0 2px var(--paper-deep); }
  .mastbtns .tbtn.hall-btn { background: var(--accent-soft); border-color: transparent;
                     color: var(--accent-deep); font-weight: 600; }
  .mastbtns .tbtn.hall-btn:hover { background: var(--accent); border-color: transparent;
                           color: #fff; }

  /* 只有会话列表可以滚动；设置按钮固定在侧栏底部，不进入滚动区。
     滚动条默认隐去，指针进入列表或键盘焦点落在列表内时才显现。 */
  .sess { flex: 1; min-height: 0; list-style: none; margin: 0; padding: 0 3px 0 0;
          overflow-y: auto; overscroll-behavior: contain;
          scrollbar-width: thin; scrollbar-color: transparent transparent; }
  .sess:hover, .sess:focus-within {
    scrollbar-color: var(--rule-2) transparent;
  }
  .sess li { display: grid; grid-template-columns: 1fr auto; column-gap: 6px;
             padding: 9px 8px 9px 11px; border-left: 2px solid transparent;
             border-radius: 0 4px 4px 0; cursor: pointer; position: relative;
             transition: background .15s ease, border-color .15s ease; }
  /* 悬停浮现浅朱砂竖线（「可进入」记号的浅一档），选中项保持实朱砂——
     两级一眼可分；写在 .on 之前，同特异性下选中态优先 */
  .sess li:hover { background: var(--card); border-left-color: var(--accent-soft); }
  .sess li.on { border-left-color: var(--accent); background: var(--card);
                box-shadow: var(--shadow-sm); }
  /* 悬停时间戳：绝对定位浮在 ⋯ 左侧，不占网格轨道——不悬停时标题吃满整行；
     等宽定宽（YYYY-MM-DD HH:MM），淡入淡出不引起行内回流 */
  .sess .stime { position: absolute; right: 36px; top: 50%;
                 transform: translateY(-50%); white-space: nowrap;
                 font-family: var(--mono); font-size: 11px;
                 color: var(--ink-3); pointer-events: none; opacity: 0;
                 background: inherit; transition: opacity .15s ease; }
  .sess li:hover .stime { opacity: 1; }
  /* 悬停时标题右侧渐隐让位：只有长到撞上时间戳的标题会被淡出
     （时间戳约 106px + 右缘 36px 偏移，透明区从行内右侧 110px 起兜住它），
     短标题落在渐变区外、完全不受影响 */
  .sess li:hover .st {
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 132px), transparent calc(100% - 108px));
    mask-image: linear-gradient(90deg, #000 calc(100% - 132px), transparent calc(100% - 108px)); }
  .sess .st { font-size: 14px; color: var(--ink-2); overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; }
  .sess li.on .st { color: var(--ink); font-weight: 600; }
  /* 已归档的条目整体退一档灰，与主列表一眼可分 */
  .sess li[data-arch="1"] .st { color: var(--ink-3); }
  .sess li[data-arch="1"].on .st { color: var(--ink-2); }
  .sess .spin { display: inline-flex; align-items: center; gap: 3px;
                color: var(--accent); margin-right: 5px; font-size: 11px; }
  .sess .spin svg { width: 10px; height: 10px; flex: none; fill: none;
                    stroke: currentColor; stroke-width: 2;
                    stroke-linecap: round; stroke-linejoin: round; }
  .sess .sedit { grid-column: 1 / -1; width: 100%; border: 1px solid var(--ink-3);
                 background: var(--card); color: var(--ink); padding: 5px 7px;
                 font-size: 13px; outline: none; }
  .sess .sx { grid-row: 1; grid-column: 2; justify-self: end; border: 0;
              background: none; color: var(--ink-3); opacity: .65;
              font-size: 16px; cursor: pointer; padding: 0 4px;
              transition: opacity .15s ease, color .15s ease; }
  .sess .sx:hover, .sess .sx[aria-expanded="true"] { opacity: 1; color: var(--accent); }
  /* 会话操作菜单：挂在 body 上、贴着 ⋯ 按钮右侧弹出的纸片卡片——侧栏列表
     是滚动容器，藏在条目里会被裁剪。fixed + JS 定位，z 压过抽屉/大厅 */
  .smenu { position: fixed; z-index: 60;
            min-width: 128px; border: 1px solid var(--rule-2); border-radius: 4px;
            background: var(--card); box-shadow: 0 10px 34px rgba(50, 42, 31, .16);
            padding: 4px; }
  .smenu button { display: flex; width: 100%; align-items: center; gap: 8px;
                  border: 0; background: none; cursor: pointer; text-align: left;
                  padding: 7px 10px; font-size: 13px; color: var(--ink-2);
                  border-radius: 2px; }
  .smenu button:hover { background: var(--accent-soft); color: var(--accent-deep); }
  .smenu button.danger:hover { background: var(--accent); color: #fff; }
  /* 两步删除的确认态：常驻红底（对齐待办/知识页的 armed 习惯） */
  .smenu button.armed { background: var(--accent); color: #fff; }
  .smenu .ssep { height: 1px; margin: 4px 6px; background: var(--rule); }
  .sess .snone { display: flex; flex-direction: column; align-items: flex-start;
                 gap: 2px; color: var(--ink-3); font-size: 13px; line-height: 1.7;
                 padding: 14px 4px 6px 11px; cursor: default; }
  .sess li.snone:hover { background: none; border-left-color: transparent; }
  .sess .snone svg { width: 24px; height: 24px; margin: 2px 0 6px; fill: none;
                     stroke: var(--rule-2); stroke-width: 1.5;
                     stroke-linecap: round; stroke-linejoin: round; }
  .sess .snone .snone-t { color: var(--ink-2); font-weight: 600; font-size: 14px; }
  .sess .snone .snone-hint { font-size: 12.5px; }
  /* 搜索无果的一键出路：清空关键词回到全部（比让人自己删字省事） */
  .sess .snone .sclear { margin-top: 6px; border: 1px solid var(--rule);
                         background: var(--card); color: var(--ink-2);
                         font-family: var(--mono); font-size: 11px;
                         border-radius: 3px; padding: 4px 10px; min-height: 27px;
                         cursor: pointer;
                         transition: border-color .15s ease, color .15s ease; }
  .sess .snone .sclear:hover { border-color: var(--accent); color: var(--accent); }

  .tbtn { background: none; border: 1px solid var(--rule-2); color: var(--ink-2);
          min-height: 38px; font-size: 14px; padding: 7px 14px; border-radius: 4px;
          cursor: pointer; text-decoration: none;
          transition: border-color .15s ease, color .15s ease,
          background .15s ease, transform .15s ease; }
  .tbtn:hover { border-color: var(--accent); color: var(--accent);
                background: var(--card); }
  .tbtn:active { transform: translateY(1px); }
  .tbtn:disabled, .tbtn[aria-disabled="true"] { opacity: .48; cursor: default; pointer-events: none; }

  /* ── 右栏：正文 ── */
  main { display: flex; flex-direction: column; min-width: 0; min-height: 0;
         height: 100%; }
  .topbar { display: none; align-items: center; gap: 10px;
            min-height: 60px; padding: 10px 16px;
            border-bottom: 1px solid var(--rule); background: var(--paper-deep); }
  .topbar .tb-title { margin-right: auto; font-size: 18px; }
  .topbar .tbtn { min-height: 34px; padding: 5px 11px; font-size: 13px; }
  #log { flex: 1; min-height: 0; overflow-y: auto; padding: 44px 40px 36px; }
  .inner { width: min(100%, 800px); min-height: 100%; margin: 0 auto; }

  /* 对话按「往来文书」排版：一行题注 + 正文，不做聊天气泡。
     新一轮落到纸上时给一记很轻的淡入上移：流式期间只有 append 触发一次，
     不随 Markdown 重渲重放；reduced-motion 下全局已禁用 */
  .turn { margin: 0 0 40px; animation: turnIn .18s ease; }
  @keyframes turnIn { from { opacity: 0; transform: translateY(4px); }
                      to { opacity: 1; transform: none; } }
  .cap { display: flex; align-items: baseline; gap: 10px; margin-bottom: 7px;
         font-family: var(--mono); font-size: 12px; letter-spacing: .1em;
         color: var(--ink-3); }
  .cap .who { font-weight: 600; letter-spacing: .28em; color: var(--ink-2); }
  .turn.user .cap .who { color: var(--accent-deep); }
  .turn.user .msg { border-left: 3px solid var(--accent); background: var(--card);
                    padding: 12px 18px; white-space: pre-wrap;
                    box-shadow: var(--shadow-sm); word-break: break-word; font-size: 16px; }
  .turn.bot .msg { font-size: 16px; line-height: 1.85; word-break: break-word; }
  .cursor::after { content: "▌"; color: var(--accent); margin-left: 2px;
                   animation: blink 1s steps(2, start) infinite; }
  @keyframes blink { to { visibility: hidden; } }

  /* 工具调用卡片：独立建模，details 展开看参数与结果预览 */
  .tl { flex-direction: column; gap: 4px; margin-bottom: 9px; }
  .tl:not(:empty) { display: flex; }
  .tl:empty { display: none; }
  .tl > * { animation: tlIn .15s ease; }
  @keyframes tlIn { from { opacity: 0; transform: translateY(3px); }
                    to { opacity: 1; transform: none; } }
  .tool { border: 1px solid var(--rule); background: var(--card); }
  .tool summary { display: flex; align-items: center; gap: 9px;
                  padding: 4px 10px; cursor: pointer; list-style: none;
                  font-family: var(--mono); font-size: 12px;
                  color: var(--ink-2); }
  .tool summary::-webkit-details-marker { display: none; }
  .tool summary:hover .tname { color: var(--accent); }
  /* 行首恒为一枚描线齿轮（不随状态换字形），状态交给行尾等宽小字说明；
     执行中让齿轮匀速转起来——机器在干活的直观反馈，完成/失败自然停转 */
  .tool .tw { flex: none; width: 12px; display: flex; align-items: center;
              color: var(--ink-3); }
  .tool .tw svg { display: block; }
  .tool.run .tw svg { animation: spin 2.4s linear infinite; }
  @keyframes spin { to { transform: rotate(1turn); } }
  .tool .tname { flex: none; }
  .tool .tsum { flex: 1; min-width: 0; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap;
                color: var(--ink-3); }
  .tool .tstat { flex: none; color: var(--ink-3); }
  .tool.ok .tstat { color: var(--ink-2); }
  .tool .tdur { flex: none; color: var(--ink-3); }
  .tool.bad { border-color: var(--accent); }
  .tool.bad .tname, .tool.bad .tstat { color: var(--accent-deep); }
  .tool .tbody { border-top: 1px dashed var(--rule); padding: 2px 10px 8px; }
  .tool .tbody:empty { display: none; }
  .tool .psec { margin-top: 6px; }
  .tool .plabel { display: block; font-family: var(--mono); font-size: 12px;
                  letter-spacing: .2em; color: var(--ink-3);
                  margin-bottom: 3px; }
  .tool pre { margin: 0; padding: 6px 8px; background: var(--paper);
              border: 1px solid var(--rule); max-height: 160px;
              overflow: auto; font-family: var(--mono); font-size: 12px;
              line-height: 1.6; color: var(--ink-2);
              white-space: pre-wrap; word-break: break-all; }

  /* 成品文件下载行：工具卡片下方一枚「附件条」，与工具卡同宽同族 */
  .frow { display: flex; align-items: center; gap: 10px; margin-bottom: 9px;
          border: 1px solid var(--rule-2); background: var(--card);
          padding: 9px 12px; font-family: var(--mono); font-size: 12px;
          color: var(--ink-2); }
  .frow .fmark { flex: none; color: var(--accent); }
  .frow .fname { flex: 1; min-width: 0; overflow: hidden;
                 text-overflow: ellipsis; white-space: nowrap;
                 word-break: break-all; }
  .frow a.tbtn { flex: none; text-decoration: none; padding: 3px 14px;
                 font-size: 12px; }
  .frow a.tbtn:hover { background: var(--accent-soft); }

  /* 番茄钟卡片：工具卡下方一条实时倒计时，时间到翻成朱砂底 */
  .pomo { border: 1px solid var(--rule-2); background: var(--card);
          padding: 12px 14px; margin-bottom: 9px; }
  .pomo .prow { display: flex; align-items: baseline; gap: 10px; }
  .pomo .pmark { flex: none; font-size: 15px; }
  .pomo .plabel { flex: 1; min-width: 0; overflow: hidden;
                 text-overflow: ellipsis; white-space: nowrap;
                 font-size: 14px; font-weight: 600; }
  .pomo .pmeta { flex: none; font-family: var(--mono); font-size: 12px;
                color: var(--ink-3); }
  .pomo .pclock { font-family: var(--mono); font-size: 34px; font-weight: 600;
                 letter-spacing: .04em; margin: 4px 0 8px;
                 font-variant-numeric: tabular-nums; }
  .pomo .pbar { height: 6px; background: var(--shade);
               border-radius: 3px; overflow: hidden; }
  .pomo .pbar i { display: block; height: 100%; width: 0;
                 background: var(--accent); border-radius: 3px; }
  .pomo .pfoot { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .pomo .pstate { flex: 1; font-family: var(--mono); font-size: 12px;
                 color: var(--ink-3); }
  .pomo .pfoot .tbtn { min-height: 30px; padding: 2px 12px; font-size: 12px; }
  .pomo.done { border-color: var(--accent); background: var(--accent-soft); }
  .pomo.done .pclock, .pomo.done .pstate { color: var(--accent-deep); }
  .pomo.cancelled { opacity: .6; }
  /* 刷新后恢复的番茄钟卡片：不在 .turn 里，间距自己对齐一轮对话 */
  .pomo-restore { margin: 0 0 40px; }

  /* 思考过程：独立建模成草稿卡片。与工具卡片同族但更轻（虚线框、无底色），
     内容用楷体灰字小一号——正文是系统黑体 15px，这里是 --kai 13px，两级层次
     一眼可分；长思考限高内部滚，不把屏幕撑满。 */
  .think { border: 1px dashed var(--rule-2); background: none; }
  .think summary { display: flex; align-items: center; gap: 9px;
                   padding: 4px 10px; cursor: pointer; list-style: none;
                   font-family: var(--mono); font-size: 12px;
                   letter-spacing: .1em; color: var(--ink-3); }
  .think summary::-webkit-details-marker { display: none; }
  .think summary:hover .tstat { color: var(--ink-2); }
  .think .tk { flex: none; color: var(--ink-3); }
  .think .tstat { flex: 1; min-width: 0; overflow: hidden;
                  text-overflow: ellipsis; white-space: nowrap;
                  letter-spacing: .04em; }
  .think .tdur { flex: none; letter-spacing: .04em; }
  .think .thbody { border-top: 1px dashed var(--rule); padding: 8px 12px 10px;
                   font-family: var(--kai); font-size: 14px; line-height: 1.9;
                   color: var(--ink-2); letter-spacing: .01em;
                   white-space: pre-wrap; word-break: break-word;
                   max-height: 300px; overflow: auto; }

  /* 兜底错误行（网络错误 / 中断这类非工具事件仍是等宽一行） */
  .tline { display: flex; gap: 8px; font-family: var(--mono); font-size: 12px;
           line-height: 1.7; padding: 2px 0; word-break: break-all; }
  .tline .mark { flex: none; width: 12px; }
  .tline.bad { color: var(--accent-deep); }
  .acts { margin-top: 9px; display: flex; gap: 8px; }
  .acts:empty { display: none; }
  .acts .tbtn { min-height: 32px; padding: 3px 12px; font-size: 12px; color: var(--ink-3);
                border-color: var(--rule); }

  /* ── 首屏：一张盖了章的空白纸 ── */
  .hero { display: flex; min-height: 100%; flex-direction: column;
          align-items: center; justify-content: center;
          padding: 48px 8px 72px; text-align: center; }
  .hero .seal { position: relative; width: 104px; height: 104px;
                margin: 0 auto 26px; transform: rotate(-7deg); }
  .hero .seal::before { content: ""; position: absolute; inset: 0;
                        border: 2px solid var(--accent); border-radius: 50%;
                        opacity: .9; }
  .hero .seal::after { content: ""; position: absolute; inset: 6px;
                       border: 1px solid var(--accent); border-radius: 50%;
                       opacity: .45; }
  .hero .seal img { position: absolute; top: 12px; left: 12px;
                    width: 80px; height: 80px; border-radius: 50%;
                    object-fit: cover; }
  .hero h2 { margin: 0 0 10px; font-family: var(--kai); font-weight: 400;
             font-size: 34px; letter-spacing: 1.5px; }
  /* 首屏日期戳：与 /today 页 lead-kicker 同一语言的 mono 眉批 */
  .hero .hero-kicker { margin: 0 0 12px; font-family: var(--mono);
                       font-size: 12px; letter-spacing: .18em;
                       color: var(--accent-deep); }
  .hero p { margin: 0 auto; max-width: 560px; font-size: 16px;
            color: var(--ink-2); line-height: 1.95; }
  .hero .hint { font-family: var(--mono); font-size: 12px; color: var(--ink-3);
                letter-spacing: .05em; }
  /* 首屏通往独立日程页的链接：与快捷提问 chip 同族，居中摆在提示语下方 */
  .hero .chip { margin-top: 20px; text-decoration: none; }

  /* ── Markdown 正文样式 ── */
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0.6em 0; }
  .md h1, .md h2, .md h3, .md h4 { font-family: var(--kai); font-weight: 400;
                                   margin: 1.2em 0 0.5em; line-height: 1.5; }
  .md h1 { font-size: 1.3em; } .md h2 { font-size: 1.2em; }
  .md h3 { font-size: 1.1em; } .md h4 { font-size: 1em; }
  .md ul, .md ol { margin: 0.6em 0; padding-left: 1.6em; }
  .md li { margin: 0.25em 0; }
  .md li::marker { color: var(--accent); }
  .md strong { font-weight: 650; }
  .md table { border-collapse: collapse; margin: 0.9em 0; font-size: 14px;
              display: block; overflow-x: auto; max-width: 100%;
              border: 1px solid var(--rule); background: var(--card); }
  .md th, .md td { border: 1px solid var(--rule); padding: 6px 12px;
                   text-align: left; }
  .md th { background: var(--shade); font-family: var(--mono); font-size: 12px;
           letter-spacing: .06em; font-weight: 600; }
  .md code { font-family: var(--mono); font-size: 0.86em; background: var(--shade);
             border: 1px solid var(--rule); padding: 1px 5px; border-radius: 2px; }
  .md pre { background: var(--card); border: 1px solid var(--rule);
            padding: 12px 14px; overflow-x: auto; margin: 0.8em 0; }
  .md pre code { background: none; border: 0; padding: 0; }
  .md blockquote { margin: 0.8em 0; padding: 2px 14px;
                   border-left: 3px solid var(--accent); color: var(--ink-2);
                   background: var(--card); }
  .md a { color: var(--accent); text-decoration: underline;
          text-underline-offset: 2px; }
  .md hr { border: 0; border-top: 1px solid var(--rule-2); margin: 1.2em 0; }

  /* ── 底部：快速提问常驻 + 档案「留言」栏 ── */
  form { flex: none; border-top: 1px solid var(--rule); background: var(--paper-deep);
         padding: 14px 32px 13px; }
  /* 桌面放得下就全部展示（wrap 两行内），不藏进横向滚动——
     用户看得见全部快捷问题才会去点；窄屏退回单排横滚，不挤输入区 */
  .quickbar { display: flex; align-items: flex-start; gap: 10px;
              max-width: 800px; margin: 0 auto 9px; }
  .qlabel { flex: none; margin-top: 8px; font-family: var(--mono); font-size: 12px;
            letter-spacing: .14em; color: var(--ink-3); }
  .qchips { display: flex; min-width: 0; flex-wrap: wrap; gap: 8px; }
  .qchips::-webkit-scrollbar { display: none; }
  .chip { border: 1px solid var(--rule-2); background: var(--card);
          flex: none; min-height: 34px; color: var(--ink-2); font-size: 13px;
          padding: 5px 12px; border-radius: 4px; cursor: pointer;
          transition: border-color 0.15s ease, color 0.15s ease,
                      background .15s ease; }
  .chip:hover { border-color: var(--accent); color: var(--accent);
                background: var(--accent-soft); }
  .composer { max-width: 800px; margin: 0 auto; }
  .upload-tray { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 auto 7px; }
  .upload-tray:empty { display: none; }
  .upchip { display: inline-flex; align-items: center; gap: 6px; max-width: 260px;
            border: 1px solid var(--rule); background: var(--card); padding: 4px 8px;
            font-family: var(--mono); font-size: 12px; color: var(--ink-2); }
  .upchip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .upchip button { border: 0; background: none; color: var(--ink-3); cursor: pointer; padding: 0; }
  .upchip.loading { opacity: .65; }
  .cwrap { display: flex; align-items: center; gap: 10px;
           background: var(--card); border: 1px solid var(--rule-2);
           border-radius: 6px; padding: 7px 8px;
           transition: border-color 0.15s ease, box-shadow 0.15s ease; }
  .cwrap:focus-within { border-color: var(--ink-3); box-shadow: var(--shadow-sm); }
  .cwrap.drag { border-color: var(--accent); background: var(--accent-soft); }
  .attach-btn { flex: none; display: inline-flex; align-items: center; justify-content: center;
                gap: 6px; height: 34px; padding: 0 10px; border: 1px solid var(--rule);
                border-radius: 4px; background: var(--paper-deep); color: var(--ink-2);
                font-family: var(--mono); font-size: 12px; cursor: pointer;
                transition: border-color .15s ease, background .15s ease, color .15s ease; }
  .attach-btn svg { width: 15px; height: 15px; fill: none; stroke: currentColor;
                    stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
  .attach-btn:hover:not(:disabled), .attach-btn:focus-visible { border-color: var(--accent);
                background: var(--accent-soft); color: var(--accent-deep); outline: none; }
  .attach-btn:disabled { cursor: default; opacity: .55; }
  textarea { flex: 1; background: none; border: 0; outline: none; resize: none;
             min-width: 0; color: var(--ink); font-size: 16px; line-height: 1.6;
             padding: 6px 0; max-height: 180px; align-self: center; }
  textarea:focus-visible { outline: none; }  /* 聚焦态交给 .cwrap 的中性描边表达 */
  textarea::placeholder { color: var(--ink-3); }
  #b { flex: none; align-self: center; display: inline-flex;
       align-items: center; gap: 7px;
       border: 1px solid var(--accent); background: var(--accent);
       min-height: 42px; color: #FBFAF6; font-size: 14px; font-weight: 600;
       padding: 9px 18px; border-radius: 4px; cursor: pointer;
       transition: background 0.15s ease, color 0.15s ease,
                   border-color 0.15s ease, opacity 0.15s ease; }
  #b .kbd { font-family: var(--mono); font-size: 12px; opacity: .7; }
  #b:hover:not(:disabled) { background: var(--accent-deep);
                            border-color: var(--accent-deep); }
  #b:disabled { background: none; border-color: var(--rule-2);
                color: var(--ink-3); cursor: default; }
  /* 流式进行中按钮变「停止」：反白描边 */
  #b.stop { background: none; color: var(--accent); }
  #b.stop:hover:not(:disabled) { background: var(--accent-soft);
                                 color: var(--accent-deep);
                                 border-color: var(--accent-deep); }
  .fhint { margin: 6px 4px 0; text-align: right; font-family: var(--mono);
           font-size: 12px; letter-spacing: .08em; color: var(--ink-3); }

  .dclose { border: 0; background: none; color: var(--ink-3); cursor: pointer;
            font-size: 15px; padding: 2px 5px; border-radius: 3px; }
  .dclose:hover { color: var(--accent); }
  .dlg-intro { margin: 0 0 16px; color: var(--ink-2); font-size: 14px;
               line-height: 1.75; }

  /* ── 设置栏目：左侧目录 + 右侧办理内容。选中栏目与会话列表同一语言：
     朱砂竖线 + 浮起纸片；目录不滚动，滚的永远是右侧内容 ── */
  .set-frame { display: flex; flex: 1; min-height: 0; gap: 22px; }
  .set-tabs { flex: none; width: 138px; display: flex; flex-direction: column; gap: 2px;
              overflow-y: auto; }
  .set-tab { display: flex; align-items: center; gap: 7px; border: 0;
             border-left: 2px solid transparent; border-radius: 0 4px 4px 0;
             background: none; cursor: pointer; padding: 8px 8px 8px 12px;
             font-family: var(--mono); font-size: 12.5px; letter-spacing: .06em;
             color: var(--ink-3);
             transition: color .15s ease, background .15s ease, border-color .15s ease; }
  /* 栏目状态点：并进目录本身——未配是朱砂实心（要行动），已配是空心细圈；
     QQ 选配，未配时不亮。取代旧的状态总览 chips 行：420px 抽屉里五枚 chip
     会 2+2+1 落单换行，且与目录导航重复 */
  .set-tab .sdot { flex: none; width: 6px; height: 6px; border-radius: 50%;
                   border: 1px solid transparent; background: transparent; }
  .set-tab .sdot.warn { background: var(--accent); border-color: var(--accent); }
  .set-tab .sdot.ok { border-color: var(--ink-3); }
  .set-tab:hover { color: var(--ink-2); background: var(--card); }
  .set-tab.on { border-left-color: var(--accent); background: var(--card);
                color: var(--ink); font-weight: 600; box-shadow: var(--shadow-sm); }
  .set-main { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding-right: 6px; }
  .set-pane { display: none; }
  .set-pane.on { display: block; }
  /* 栏目内动作行：替代原 panel 头行右侧挂动作的做法 */

  /* 字段：标签在上、输入在下，全宽对齐；不再用 72px 边栏配 82px 缩进魔数 */
  .fld { display: grid; gap: 5px; margin: 0 0 10px; }
  .fld span { font-family: var(--mono); font-size: 12px; color: var(--ink-3);
              letter-spacing: .12em; }
  .fld input, .fld select { width: 100%; border: 1px solid var(--rule-2);
               background: var(--card); color: var(--ink);
               font-family: var(--mono); font-size: 14px; padding: 9px 10px;
               border-radius: 2px; outline: none; }
  .fld input:focus, .fld select:focus { border-color: var(--accent);
               box-shadow: 0 0 0 3px rgba(173, 57, 44, .09); }
  .fld input::placeholder { color: var(--ink-3); opacity: .75; }
  /* 密码类字段：右侧「显示/隐藏」切换，长 Key 手填时能核对 */
  .fld-row { position: relative; display: block; }
  .fld-row input { padding-right: 64px; }
  .fld-eye { position: absolute; right: 1px; top: 1px; bottom: 1px;
             border: 0; border-left: 1px solid var(--rule); background: none;
             cursor: pointer; font-family: var(--mono); font-size: 11px;
             letter-spacing: .06em; color: var(--ink-3); padding: 0 12px;
             border-radius: 0 2px 2px 0; transition: color .15s ease; }
  .fld-eye:hover { color: var(--accent); }
  .fld-eye:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .fld-eye:disabled { color: var(--rule-2); cursor: default; }

  .cur { font-family: var(--mono); font-size: 12px; color: var(--ink-3);
         letter-spacing: .04em; min-height: 15px; margin: -4px 0 10px; }
  .cur:not(:empty)::before { content: "· "; color: var(--rule-2); }

  /* 连接检测行：虚线签收线——落章处，也隔开“填写”与“提交” */
  .diagrow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
             margin: 4px 0 0; padding-top: 10px;
             border-top: 1px dashed var(--rule); }
  .diagrow .tbtn { min-height: 32px; padding: 4px 10px; font-size: 12px; }
  .diagstate { font-family: var(--mono); font-size: 12px; color: var(--ink-3); }

  /* 型号卡片：取代原生下拉。选中态用朱砂竖线——与会话列表 .on 同一语言；
     “当前”徽标标的是服务端在用型号，“选中”标的是这次要保存的型号 */
  .model-cards { display: grid; gap: 8px; margin: 2px 0 10px; }
  .model-card { display: grid; grid-template-columns: 1fr auto; gap: 3px 10px;
                padding: 9px 12px 8px; cursor: pointer;
                border: 1px solid var(--rule); border-left: 3px solid var(--rule-2);
                background: var(--card); border-radius: 3px;
                transition: border-color .15s ease, box-shadow .15s ease; }
  .model-card:hover { border-color: var(--rule-2); }
  .model-card.picked { border-left-color: var(--accent); box-shadow: var(--shadow-sm); }
  .model-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .mc-name { font-size: 14px; font-weight: 600; color: var(--ink); align-self: baseline; }
  .mc-badge { justify-self: end; align-self: baseline;
              font-family: var(--mono); font-size: 11px; letter-spacing: .08em;
              color: var(--accent-deep); background: var(--accent-soft);
              padding: 2px 7px; border-radius: 2px; }
  .mc-id { grid-column: 1 / -1; font-family: var(--mono); font-size: 12px;
           color: var(--ink-3); letter-spacing: .03em; }
  .mc-note { grid-column: 1 / -1; font-size: 12px; color: var(--ink-2); line-height: 1.65; }
  .model-empty { border: 1px dashed var(--rule-2); border-radius: 3px;
                 background: var(--card); color: var(--ink-3);
                 font-size: 13px; text-align: center; padding: 16px 10px; }

  /* 提示词模板面板：添加行 + 可删 chip 清单，语言与主界面 .chip 一致 */
  .qq-add { display: flex; gap: 8px; margin: 2px 0 12px; }
  .qq-add input { flex: 1; min-width: 0; border: 1px solid var(--rule-2);
                  background: var(--card); color: var(--ink);
                  font-family: var(--mono); font-size: 14px; padding: 9px 10px;
                  border-radius: 2px; outline: none; }
  .qq-add input:focus { border-color: var(--accent);
                        box-shadow: 0 0 0 3px rgba(173, 57, 44, .09); }
  .qq-add input::placeholder { color: var(--ink-3); opacity: .75; }
  .qq-add .tbtn { flex: none; align-self: stretch; min-height: 0; }
  .qq-list { display: flex; flex-wrap: wrap; gap: 8px; min-height: 38px;
             margin: 0 0 12px; align-content: flex-start; }
  .qq-list .qq-empty { border: 1px dashed var(--rule-2); border-radius: 3px;
                       background: var(--card); color: var(--ink-3);
                       font-size: 13px; padding: 8px 12px; }
  .qq-item { display: inline-flex; align-items: center; gap: 8px;
             border: 1px solid var(--rule-2); background: var(--card);
             color: var(--ink-2); font-size: 13px; padding: 5px 8px 5px 12px;
             border-radius: 4px; max-width: 100%; }
  .qq-item span { overflow-wrap: anywhere; }
  .qq-item button { flex: none; border: 0; background: none; cursor: pointer;
                    color: var(--ink-3); font-size: 12px; line-height: 1;
                    padding: 2px; transition: color .15s ease; }
  .qq-item button:hover { color: var(--accent-deep); }
  .qq-item button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  .data-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; align-items: stretch; }
  .data-cell { border: 1px solid var(--rule); background: var(--card); padding: 10px 8px;
               min-height: 72px; display: flex; flex-direction: column;
               align-items: center; justify-content: center; gap: 4px; text-align: center; }
  .data-cell span { display: block; font-family: var(--mono); font-size: 12px; color: var(--ink-3); }
  .data-cell strong { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
  .data-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
  .data-actions .danger { color: var(--accent-deep); }
  .setmsg { font-family: var(--mono); font-size: 12px; min-height: 16px;
            margin: 0 2px 2px; white-space: pre-wrap; color: var(--accent-deep); }
  .setmsg.good { color: var(--ink-2); }
  /* 保存结果逐条展示：成功行墨色、失败行朱砂，一眼分清 */
  .setmsg.good .setmsg-line { margin: 0; }
  .setmsg.good .setmsg-line.bad { color: var(--accent-deep); }
  /* 两步确认的 armed 态：朱砂底白字（与 .hall-del.armed 同一语言，免原生 confirm） */
  .data-actions .tbtn.armed { color: var(--card); background: var(--accent);
                              border-color: var(--accent); }
  .data-cell.err { color: var(--accent-deep); font-family: var(--mono); font-size: 12px; }

  .drawer-backdrop { display: none; position: fixed; inset: 0; z-index: 39;
                     background: rgba(38, 35, 29, .35); }

  /* ── 功能大厅：占据正文网格的第三列，打开时把聊天区往左推（真 push）。
     同一份 UI 服务两个入口：侧栏按钮点击，或对话里触发对应工具时自动推出。
     窄屏（≤960px）推不动，退回右侧滑入的浮层 + 遮罩。 ── */
  .hall-backdrop { display: none; position: fixed; inset: 0; z-index: 44;
                   background: rgba(38, 35, 29, .35); }
  .hall { grid-column: 3; min-width: 0; min-height: 0;
          display: flex; flex-direction: column; overflow: hidden;
          background: var(--paper); border-left: 1px solid var(--rule-2); }
  .hall-head { display: flex; align-items: center; gap: 10px; padding: 12px 20px 8px; }
  .hall-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                white-space: nowrap; font-family: var(--kai); font-size: 18px;
                color: var(--accent); letter-spacing: 2px; }
  .hall-back { flex: none; border: 1px solid var(--rule); background: var(--card);
               color: var(--ink-2); cursor: pointer; font-size: 13px;
               padding: 4px 10px; border-radius: 4px; min-height: 30px; }
  .hall-back:hover { border-color: var(--accent); color: var(--accent); }
  .hall-rule { border-bottom: 1px solid var(--accent); margin: 0 20px; }
  .hall-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 20px 24px;
               scrollbar-width: thin; scrollbar-color: var(--rule-2) transparent; }
  .hall-body::-webkit-scrollbar { width: 8px; }
  .hall-body::-webkit-scrollbar-track { background: transparent; }
  .hall-body::-webkit-scrollbar-thumb {
    background: var(--rule-2); border: 2px solid transparent;
    background-clip: content-box; border-radius: 4px; }
  .hall-body::-webkit-scrollbar-thumb:hover {
    background: var(--ink-3); background-clip: content-box; }
  /* 宫格分组题注：与侧栏 .sec h2 同一语言（等宽小字 + 下划线），只更紧凑 */
  .hall-sec { display: flex; align-items: baseline; justify-content: space-between;
              margin: 16px 0 8px; padding-bottom: 6px;
              font-family: var(--mono); font-size: 12px; font-weight: 600;
              letter-spacing: .14em; color: var(--ink-3);
              border-bottom: 1px solid var(--rule); }
  .hall-sec:first-child { margin-top: 0; }
  .hall-sec span { letter-spacing: .04em; font-weight: 400; }
  /* 目录行：抽屉窄，一行一条像卷宗目录页，不再摆小方盒卡片。
     行间只留细分隔线；朱砂竖线是这套 UI 的「可进入」记号，悬停才浮现；
     图标块沿用大厅入口的浅底深字（无边框），说明用等宽小字与面板条目同语言 */
  .hall-grid { display: grid; grid-template-columns: 1fr; }
  .hall-card { position: relative; display: flex; flex-direction: column; gap: 4px;
               text-align: left; width: 100%;
               border: 0; border-bottom: 1px solid var(--rule);
               background: none; padding: 12px 6px 12px 15px;
               cursor: pointer; font-family: inherit;
               transition: background .15s ease; }
  .hall-grid .hall-card:last-child { border-bottom-color: transparent; }
  .hall-card::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px;
                       width: 3px; background: var(--accent);
                       opacity: 0; transition: opacity .15s ease; }
  .hall-card:hover { background: var(--paper-deep); }
  .hall-card:hover::before { opacity: 1; }
  .hall-card:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .hall-card-top { display: flex; align-items: center; gap: 9px; }
  /* 图标换成与工具卡齿轮同一族的 1.8px 描线 SVG：emoji 是彩色卡通，
     在墨色纸面上跳戏；单一朱砂使整套界面更像一份竖排卷宗 */
  .hall-ico { flex: none; width: 28px; height: 28px; display: inline-flex;
              align-items: center; justify-content: center;
              background: var(--accent-soft); color: var(--accent-deep);
              border-radius: 4px; }
  .hall-ico svg { display: block; width: 15px; height: 15px; fill: none;
                  stroke: currentColor; stroke-width: 1.8;
                  stroke-linecap: round; stroke-linejoin: round; }
  .hall-card b { flex: 1; min-width: 0; font-size: 15px; font-weight: 600;
                 overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hall-go { flex: none; color: var(--rule-2); font-size: 14px;
             transition: color .15s ease, transform .15s ease; }
  .hall-card:hover .hall-go { color: var(--accent); transform: translateX(2px); }
  .hall-card span { font-family: var(--mono); font-size: 12px; color: var(--ink-3);
                    letter-spacing: .02em; line-height: 1.6; }
  /* 主页徽标：跟在标题行右侧、箭头左边，不用点进去就知道有没有事。
     常规态浅朱砂底；「⚠ 逾期 / 未配置」这类要行动的用朱砂实底白字跳出来 */
  .hall-badge { flex: none; font-family: var(--mono); font-size: 11px;
                letter-spacing: .04em; color: var(--accent-deep);
                background: var(--accent-soft); padding: 1px 8px; border-radius: 2px;
                white-space: nowrap; }
  .hall-badge.warn { background: var(--accent); color: var(--card); font-weight: 600; }
  .hall-note { margin: 14px 2px 0; font-family: var(--mono); font-size: 12px;
               color: var(--ink-3); line-height: 1.7; }
  /* 主页页脚的仓库入口：与 .hall-note 同语言的等宽小字，描线 GitHub 标随文字同色；
     宫格的「可进入」记号是行首朱砂竖线，这里换成语义最直白的外链染朱砂 */
  .hall-gh { display: inline-flex; align-items: center; gap: 7px;
             margin: 10px 2px 0; font-family: var(--mono); font-size: 12px;
             letter-spacing: .02em; color: var(--ink-3); text-decoration: none;
             transition: color .15s ease; }
  .hall-gh:hover { color: var(--accent); }
  .hall-gh:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .hall-gh svg { flex: none; width: 15px; height: 15px; fill: none;
                 stroke: currentColor; stroke-width: 1.8;
                 stroke-linecap: round; stroke-linejoin: round; }
  /* 面板工具条：条数在左，刷新与完整页在右；粘在面板顶部方便长列表回看。
     z-index 必须显式给：行内动作按钮（原文/删除/.ics）带 opacity .45 各自成合成组，
     光靠 sticky 的默认绘制顺序压不住，滚动时会从工具条上穿模 */
  .hall-toolbar { position: sticky; top: -16px; z-index: 1; display: flex; align-items: center;
                  gap: 8px; margin: 0 -2px 10px; padding: 4px 2px 8px;
                  background: var(--paper); }
  .hall-count { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                white-space: nowrap; font-family: var(--mono); font-size: 12px;
                color: var(--ink-3); letter-spacing: .04em; }
  .hall-refresh { flex: none; border: 1px solid var(--rule); background: var(--card);
                  color: var(--ink-2); font-size: 12px; font-family: var(--mono);
                  min-height: 30px; padding: 3px 10px; border-radius: 4px; cursor: pointer; }
  .hall-refresh:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .hall-refresh:disabled { opacity: .5; cursor: default; }
  .hall-more { flex: none; display: inline-flex; align-items: center; gap: 4px;
               font-family: var(--mono); font-size: 12px; color: var(--ink-2);
               border: 1px solid var(--rule); background: var(--card);
               border-radius: 4px; padding: 4px 10px; min-height: 30px;
               text-decoration: none; }
  .hall-more:hover { border-color: var(--accent); color: var(--accent); }
  /* 面板内搜索：贴在工具条下方一起粘住，长列表边滚边滤 */
  .hall-search { display: flex; margin: 0 0 10px; }
  .hall-search input { flex: 1; min-width: 0; border: 1px solid var(--rule);
                       background: var(--card); color: var(--ink);
                       font-size: 13px; padding: 7px 10px; border-radius: 4px;
                       outline: none; }
  .hall-search input:focus { border-color: var(--ink-3); }
  .hall-search input::placeholder { color: var(--ink-3); }
  /* 面板条目：与待办列表同一语言，等信息以两行表达（标题 + 等宽小字） */
  .hall-item { border: 1px solid var(--rule); background: var(--card);
               padding: 9px 11px; margin-bottom: 6px; border-radius: 4px;
               transition: border-color .15s ease, box-shadow .15s ease; }
  .hall-item:hover, .hall-item:focus-within { border-color: var(--rule-2);
                                              box-shadow: 0 2px 10px rgba(50, 42, 31, .07); }
  /* 面板内容淡入：切换/刷新时给 0.16s 过渡（reduced-motion 下全局已禁用） */
  .hall-dyn-in { animation: hallFade .16s ease; }
  @keyframes hallFade { from { opacity: .2; } to { opacity: 1; } }
  .hall-item .ht { font-size: 14px; font-weight: 600; line-height: 1.5;
                   overflow-wrap: anywhere; }
  .hall-item .hm { font-family: var(--mono); font-size: 12px; color: var(--ink-3);
                   margin-top: 2px; line-height: 1.6; overflow-wrap: anywhere; }
  .hall-item.has-act { display: flex; align-items: flex-start; gap: 8px; }
  .hall-item-main { flex: 1; min-width: 0; }
  /* 勾选即完成是乐观更新：先变灰 + 标题删除线，后台落盘 */
  .hall-item.done { opacity: .55; }
   .hall-item.done .ht { text-decoration: line-through; }
   /* 勾选框：自绘纸片方框（与 /today 页 .todo-chk 同一套），选中朱砂底 + 纸色勾 */
   .hall-done { appearance: none; -webkit-appearance: none; position: relative;
                flex: none; width: 18px; height: 18px; margin: 2px 0 0;
                border: 1.5px solid var(--rule-2); border-radius: 4px;
                background: var(--card); cursor: pointer;
                transition: border-color .15s ease, background .15s ease; }
   .hall-done:hover { border-color: var(--accent); }
   .hall-done:checked { background: var(--accent); border-color: var(--accent); }
   .hall-done:checked::after { content: ""; position: absolute; left: 5px; top: 1.5px;
                               width: 4px; height: 9px;
                               border: solid var(--paper); border-width: 0 2px 2px 0;
                               transform: rotate(45deg); }
   .hall-done:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
   .hall-done:disabled { cursor: default; }
   .hall-del { flex: none; border: 0; background: none; padding: 4px 8px;
               min-height: 28px; color: var(--ink-3); font-family: var(--mono);
               font-size: 12px; cursor: pointer; border-radius: 3px;
               transition: color .15s ease, background .15s ease; }
   .hall-del:hover { color: var(--accent); text-decoration: underline; }
    .hall-del.armed { color: var(--card); background: var(--accent); }
    /* 待办分组题注：与 /today 页 .todo-group 同一语言（等宽小字 + 计数），只更紧凑 */
   .hall-group { margin: 12px 0 6px; font-family: var(--mono); font-size: 11.5px;
                 letter-spacing: .12em; color: var(--ink-3); }
   .hall-group:first-of-type { margin-top: 2px; }
   .hall-group.overdue { color: var(--accent-deep); font-weight: 600; }
   /* 已完成折叠开关：题注变身按钮，保持等宽小字外观 */
   .hall-group.toggle { border: 0; background: none; padding: 0; cursor: pointer;
                        text-align: left; font: inherit; font-family: var(--mono);
                        font-size: 11.5px; letter-spacing: .12em; color: var(--ink-3); }
   .hall-group.toggle:hover { color: var(--ink); }
   .hall-item .hm .overdue-tag { color: var(--accent-deep); font-weight: 600; }
   .hall-ics { flex: none; align-self: center; font-family: var(--mono); font-size: 11px;
               color: var(--ink-3); text-decoration: none; border: 1px solid var(--rule);
               border-radius: 3px; padding: 2px 7px; white-space: nowrap; }
   .hall-ics:hover { border-color: var(--accent); color: var(--accent); }
    /* 行内动作（.ics / 删除）平时退后半档，悬停或聚焦该行时全显；
       armed 确认态必须始终可见；触屏无悬停，常显 */
    .hall-item .hall-ics, .hall-item .hall-del { opacity: .45; }
    .hall-item:hover .hall-ics, .hall-item:hover .hall-del,
    .hall-item:focus-within .hall-ics,
    .hall-item:focus-within .hall-del { opacity: 1; }
    .hall-del.armed { opacity: 1; }
    @media (hover: none) {
      .hall-item .hall-ics, .hall-item .hall-del { opacity: 1; }
    }
   /* 知识分类筛：横向可滚的一排小 chip，与搜索框叠加过滤 */
  .hall-cats { display: flex; gap: 6px; overflow-x: auto; margin: 0 0 10px; padding-bottom: 2px; }
  .hall-cat { flex: none; border: 1px solid var(--rule); background: var(--card);
              color: var(--ink-2); font-family: var(--mono); font-size: 11px;
              border-radius: 3px; padding: 3px 9px; cursor: pointer; min-height: 28px; }
  .hall-cat:hover { border-color: var(--accent); color: var(--accent); }
  .hall-cat.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-deep); }
  .hall-item .hm .kdate { color: var(--ink-3); }
  /* 番茄钟进行中：标题 + 倒计时大字 + 进度条 + 至几点结束，与对话内 .pomo 卡同族 */
  .hall-pomo-active { border-left: 3px solid var(--accent); }
  .hall-pomo-clock { font-family: var(--mono); font-size: 26px; font-weight: 600;
                     letter-spacing: .06em; color: var(--accent-deep); line-height: 1.3; }
  .hall-pomo-bar { height: 5px; border: 1px solid var(--rule); border-radius: 3px;
                   background: var(--paper-deep); overflow: hidden; margin-top: 7px; }
  .hall-pomo-bar i { display: block; height: 100%; width: 0;
                     background: var(--accent); transition: width 1s linear; }
  .hall-pomo-row { display: flex; align-items: center; gap: 8px; margin-top: 7px; }
  .hall-pomo-row .hall-count { flex: 1; }
  .hall-pomo-cancel { flex: none; border: 1px solid var(--rule); background: var(--card);
                      color: var(--ink-2); font-family: var(--mono); font-size: 12px;
                      border-radius: 4px; padding: 3px 12px; min-height: 30px; cursor: pointer; }
  .hall-pomo-cancel:hover { border-color: var(--accent); color: var(--accent); }
  /* 知识条目可点开看全文：整块 main 区都是热区，键盘同样可达 */
  .hall-item.know .hall-item-main { cursor: pointer; }
  .hall-item.know:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .hall-item.know .hm.more { color: var(--ink-2); }
  .hall-item.hot { border-left: 3px solid var(--accent); }
  .hall-item.hot .hm { color: var(--accent-deep); }
  /* 加载骨架：纯色块脉冲（不用渐变，与纸面主题一致），减少取数时的布局跳动 */
  .hall-skel { display: grid; gap: 6px; }
  .hall-skel i { display: block; height: 52px; border: 1px solid var(--rule);
                 background: var(--card); border-radius: 2px;
                 animation: hallPulse 1.1s ease-in-out infinite; }
  .hall-skel i:nth-child(2) { animation-delay: .15s; }
  .hall-skel i:nth-child(3) { animation-delay: .3s; }
  @keyframes hallPulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
  /* 空态 / 错误态：虚线框纸片居中，与 .rem-empty / .model-empty 同一语言 */
  .hall-empty { border: 1px dashed var(--rule-2); border-radius: 3px;
                background: var(--card); color: var(--ink-2);
                text-align: center; padding: 20px 14px; margin-bottom: 6px; }
  .hall-empty .he-ico { font-size: 22px; line-height: 1; margin-bottom: 6px; }
  .hall-empty .he-t { font-size: 14px; font-weight: 600; }
  .hall-empty .he-s { margin-top: 4px; font-family: var(--mono); font-size: 12px;
                      color: var(--ink-3); line-height: 1.7; }
  .hall-empty .tbtn { margin-top: 10px; min-height: 32px; padding: 4px 14px; font-size: 12px; }
  /* 大厅里的设置：抽屉不宽，栏目目录改横排（沿用窄屏设置的形态），
     字段与检测行等内部样式原样复用 */
  .hall .set-frame { flex-direction: column; gap: 0; }
  .hall .set-tabs { flex-direction: row; width: auto; gap: 6px;
                    overflow-x: auto; overflow-y: hidden;
                    border-bottom: 1px solid var(--rule);
                    padding: 0 0 10px; margin: 0 0 12px; }
  .hall .set-tab { white-space: nowrap; border-left: 0;
                   border-bottom: 2px solid transparent;
                   border-radius: 4px 4px 0 0; padding: 6px 10px; }
  .hall .set-tab.on { border-bottom-color: var(--accent); box-shadow: none; }
  .hall .set-main { padding-right: 0; }
  .hall #hallSettings .setmsg { margin: 10px 2px 0; }
  /* 提示词模板面板（#hallPrompts）：与设置同一套字段语言，
     即改即存，没有「保存设置」——底部一行是恢复默认（两步确认）+ 状态小字 */
  .hall #hallPrompts .setmsg { margin: 0; }
  .prompts-foot { justify-content: space-between; align-items: center; }
  .prompts-foot .setmsg { flex: 1; min-width: 0; text-align: right; }
  .hall-settings-foot { display: flex; justify-content: flex-end; gap: 8px;
                        margin-top: 12px; padding-top: 12px;
                        border-top: 1px dashed var(--rule); }
  .hall-settings-foot .tbtn.primary { background: var(--accent);
                                      border-color: var(--accent); color: var(--card);
                                      font-weight: 600; }
  .hall-settings-foot .tbtn.primary:hover { background: var(--accent-deep);
                                            border-color: var(--accent-deep); color: #fff; }
  /* 有未保存修改时「关闭」的两步确认 armed 态（与清理按钮同一语言） */
  .hall-settings-foot .tbtn.armed { color: var(--card); background: var(--accent);
                                    border-color: var(--accent); }

  #log::-webkit-scrollbar { width: 10px; }
  #log::-webkit-scrollbar-thumb {
    background: var(--rule-2); border: 3px solid transparent;
    background-clip: content-box; border-radius: 5px; }
  #log::-webkit-scrollbar-thumb:hover {
    background: var(--ink-3); background-clip: content-box; }
  #log::-webkit-scrollbar-track {
    background: transparent; }
  .sess::-webkit-scrollbar { width: 8px; }
  .sess::-webkit-scrollbar-track { background: transparent; }
  .sess::-webkit-scrollbar-thumb {
    background: transparent; border: 2px solid transparent;
    background-clip: content-box; border-radius: 4px; }
  .sess:hover::-webkit-scrollbar-thumb,
  .sess:focus-within::-webkit-scrollbar-thumb {
    background: var(--rule-2); background-clip: content-box; }
  .sess::-webkit-scrollbar-thumb:hover {
    background: var(--ink-3); background-clip: content-box; }

  @media (max-width: 960px) {
    body { grid-template-columns: 1fr; }
    /* 窄屏推不动主区：大厅退回右侧滑入的浮层 + 遮罩 */
    body.hall-open { grid-template-columns: 1fr; }
    .hall { position: fixed; top: 0; right: 0; bottom: 0; z-index: 45;
            width: min(420px, 92vw); transform: translateX(103%);
            transition: transform .2s ease;
            box-shadow: -14px 0 36px rgba(38, 35, 29, .2); }
    body.hall-open .hall { transform: translateX(0); }
    body.hall-open .hall-backdrop { display: block; }
    aside { display: flex; position: fixed; inset: 0 auto 0 0; z-index: 40; width: min(320px, 88vw);
            transform: translateX(-102%); transition: transform .2s ease;
            box-shadow: 14px 0 36px rgba(38, 35, 29, .2); }
    body.drawer-open aside { transform: translateX(0); }
    body.drawer-open .drawer-backdrop { display: block; }
    .topbar { display: flex; }
    #log { padding: 28px 20px 24px; }
    form { padding: 11px 16px 10px; }
    /* 窄屏快捷问题回单排横滚：wrap 三四行会挤压输入区 */
    .quickbar { align-items: center; margin-bottom: 8px; }
    .qlabel { margin-top: 0; }
    .qchips { flex-wrap: nowrap; overflow-x: auto; }
    .fhint { display: none; }
  }
  @media (max-width: 560px) {
    .topbar { min-height: 54px; padding: 8px 12px; gap: 7px; }
    .topbar .tb-title { font-size: 17px; }
    .topbar .tbtn { min-height: 32px; padding: 4px 9px; font-size: 12px; }
    #log { padding: 22px 15px 18px; }
    .hero { justify-content: center; padding: 32px 4px 48px; }
    .hero .seal { width: 92px; height: 92px; margin-bottom: 22px; }
    .hero .seal img { top: 11px; left: 11px; width: 70px; height: 70px; }
    .hero h2 { font-size: 30px; }
    .hero p { font-size: 16px; line-height: 1.85; }
    .hero .hint { display: inline-block; margin-top: 5px; font-size: 12px; }
    .turn { margin-bottom: 32px; }
    .turn.bot .msg, .turn.user .msg { font-size: 16px; }
    form { padding: 9px 12px 10px; }
    .quickbar { gap: 8px; }
    .qlabel { font-size: 12px; }
    .chip { min-height: 32px; padding: 4px 10px; font-size: 12px; }
    .cwrap { gap: 8px; }
    .attach-btn { width: 34px; padding: 0; }
    .attach-text { display: none; }
    textarea { font-size: 16px; }
    #b { min-height: 40px; padding: 8px 14px; }
    #b .kbd { display: none; }
    .data-grid { grid-template-columns: repeat(2, 1fr); }
    /* 大厅已改单列目录行，行高自适应，小屏无需再调 */
    .hall-toolbar { top: -12px; }
    /* 窄屏设置弹窗：目录改横排在内容上方，选中态换用下划朱砂线 */
    .set-frame { flex-direction: column; gap: 0; }
    .set-tabs { flex-direction: row; width: auto; gap: 6px;
                overflow-x: auto; overflow-y: hidden;
                border-bottom: 1px solid var(--rule);
                padding: 0 0 10px; margin: 0 0 12px; }
    .set-tab { white-space: nowrap; border-left: 0;
               border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0;
               padding: 6px 10px; }
    .set-tab.on { border-bottom-color: var(--accent); box-shadow: none; }
    .set-main { padding-right: 0; }
  }
    @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important;
                             transition: none !important; }
  }
</style>
</head>
<body data-demo="${demo}">
<aside>
  <div class="mast">
    <h1 class="wordmark"><span class="course">Course</span><span class="raptor">Raptor</span></h1>
  </div>
  <div class="mastbtns">
    <button class="tbtn primary" id="newSession" title="另起一个会话（旧会话保留在档案里）">新会话</button>
    <button class="tbtn hall-btn" id="openHall" title="今日日程、课表、考试、待办、知识库、番茄钟" aria-haspopup="dialog" aria-expanded="false" aria-controls="hall">功能大厅</button>
  </div>
  <section class="sec">
    <h2><span id="sessTitle">会话档案</span><span class="hside"><span id="sessCount"></span><button id="sessArchiveToggle" type="button" hidden></button></span></h2>
    <ul class="sess" id="sessList"></ul>
  </section>
</aside>
<main>
  <div class="topbar">
    <span class="tb-title wordmark"><span class="course">Course</span><span class="raptor">Raptor</span></span>
    <button class="tbtn" id="openHallM" aria-haspopup="dialog" aria-expanded="false" aria-controls="hall">大厅</button>
    <button class="tbtn" id="openDrawerM">会话</button>
    <button class="tbtn" id="newSessionM">新会话</button>
  </div>
  <div id="log"><div class="inner" id="inner">
    <div class="hero" id="hero">
      <div class="seal" aria-hidden="true"><img src="/logo.png" alt="" width="80" height="80"></div>
      <p class="hero-kicker" id="heroKicker">TODAY</p>
      <h2 id="heroGreet">同学，你好。</h2>
      <p>课表、成绩、考试、通知——直接用一句话问。${
        demo
          ? `<br>
      <span class="hint">点击下方提示词体验示例；演示会话在服务重启后清空。</span>`
          : ""
      }</p>
    </div>
  </div></div>
  <form id="f">
    <div class="quickbar">
      <span class="qlabel">提示词</span>
      <span class="qchips" id="qchips"></span>
    </div>
    <div class="composer">
      <div class="upload-tray" id="uploadTray"></div>
      <div class="cwrap">
        <button class="attach-btn" id="attachBtn" type="button" title="上传 PDF、Word、Excel 等文件" aria-label="上传附件" ${demo ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg><span class="attach-text">附件</span></button>
        <input id="fileInput" type="file" hidden multiple accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.pptx">
        <textarea id="i" rows="1" aria-label="向 CourseRaptor 提问" placeholder="课表、成绩、考试、通知，直接问…"></textarea>
        <button id="b">发送<span class="kbd">⏎</span></button>
      </div>
      <div class="fhint">⏎ 发送 · ⇧⏎ 换行 · ${demo ? "虚构示例，会话仅保留在内存" : "会话自动存档"}</div>
    </div>
  </form>
</main>
<div class="hall-backdrop" id="hallBackdrop"></div>
<aside class="hall" id="hall" role="dialog" aria-modal="false" aria-labelledby="hallTitle" aria-label="功能大厅" inert>
  <div class="hall-head">
    <button class="hall-back" id="hallBack" type="button" aria-label="返回功能大厅主页" hidden>← 大厅</button>
    <h2 class="hall-title" id="hallTitle" style="margin:0;font-weight:400;">功能大厅</h2>
    <button class="dclose" id="closeHall" aria-label="关闭功能大厅">✕</button>
  </div>
  <div class="hall-rule" aria-hidden="true"></div>
  <div class="hall-body" id="hallBody">
    <div id="hallDyn" aria-live="polite"></div>
    <div id="hallSettings" hidden>
      <div class="set-frame">
        <nav class="set-tabs" id="setTabs" role="tablist" aria-label="设置栏目">
          <button class="set-tab on" type="button" role="tab" id="setTabAccount" aria-controls="setPaneAccount" aria-selected="true" data-pane="account"><i class="sdot" aria-hidden="true"></i>教务账号</button>
          <button class="set-tab" type="button" role="tab" id="setTabModel" aria-controls="setPaneModel" aria-selected="false" data-pane="model"><i class="sdot" aria-hidden="true"></i>AI 模型</button>
          <button class="set-tab" type="button" role="tab" id="setTabQQ" aria-controls="setPaneQQ" aria-selected="false" data-pane="qq"><i class="sdot" aria-hidden="true"></i>QQ 机器人</button>
          <button class="set-tab" type="button" role="tab" id="setTabData" aria-controls="setPaneData" aria-selected="false" data-pane="data">本地数据</button>
        </nav>
        <div class="set-main">
          <section class="set-pane on" id="setPaneAccount" role="tabpanel" aria-labelledby="setTabAccount" data-pane="account">
            <p class="dlg-intro">正式查询课表、成绩、考试与通知前，请先配置教务账号。已保存的信息不会在页面中完整显示，留空即保持不变；账号仅加密保存在当前电脑。</p>
            <label class="fld"><span>学号</span><input id="sUser" type="text" autocomplete="off" ${demo ? "disabled" : ""}></label>
            <label class="fld"><span>登录密码</span><span class="fld-row"><input id="sPass" type="password" autocomplete="new-password" ${demo ? "disabled" : ""}><button class="fld-eye" type="button" id="eyePass" aria-pressed="false" ${demo ? "disabled" : ""}>显示</button></span></label>
            <div class="cur" id="curJwgl"></div>
            <div class="diagrow"><button class="tbtn" id="testJwgl" type="button" ${demo ? "disabled" : ""}>检测教务连接</button><span class="diagstate" id="diagJwgl"></span></div>
          </section>
          <section class="set-pane" id="setPaneModel" role="tabpanel" aria-labelledby="setTabModel" data-pane="model">
            <p class="dlg-intro">模型服务使用 DeepSeek API。API Key 与所选型号仅加密保存在当前电脑，留空即保持不变。</p>
            <label class="fld"><span>API Key</span><span class="fld-row"><input id="sKey" type="password" autocomplete="new-password" ${demo ? "disabled" : ""}><button class="fld-eye" type="button" id="eyeKey" aria-pressed="false" ${demo ? "disabled" : ""}>显示</button></span></label>
            <div class="cur" id="curKey"></div>
            <div class="model-cards" id="modelCards" role="radiogroup" aria-label="选择 AI 模型"></div>
            <input type="hidden" id="sModel" value="">
            <div class="cur" id="curModel"></div>
            <div class="diagrow"><button class="tbtn" id="testDeepseek" type="button" ${demo ? "disabled" : ""}>检测模型连接</button><span class="diagstate" id="diagDeepseek"></span></div>
          </section>
          <section class="set-pane" id="setPaneQQ" role="tabpanel" aria-labelledby="setTabQQ" data-pane="qq">
            <p class="dlg-intro">在 q.qq.com 创建机器人后填入凭证，保存后即可在 QQ 里与本服务对话。凭证仅加密保存在当前电脑，留空即保持不变。</p>
            <label class="fld"><span>AppID</span><input id="sQQAppId" type="text" autocomplete="off" placeholder="q.qq.com 机器人的 AppID" ${demo ? "disabled" : ""}></label>
            <label class="fld"><span>AppSecret</span><span class="fld-row"><input id="sQQSecret" type="password" autocomplete="new-password" ${demo ? "disabled" : ""}><button class="fld-eye" type="button" id="eyeQQSecret" aria-pressed="false" ${demo ? "disabled" : ""}>显示</button></span></label>
            <label class="fld"><span>激活暗号</span><input id="sQQPass" type="text" autocomplete="off" placeholder="首次激活用的暗号（自定）" ${demo ? "disabled" : ""}></label>
            <div class="cur" id="curQQ">未配置；到 q.qq.com 创建机器人后填入，保存后即可在 QQ 里使用</div>
          </section>
          <section class="set-pane" id="setPaneData" role="tabpanel" aria-labelledby="setTabData" data-pane="data">
            <p class="dlg-intro">会话、附件、生成文件与待办都保存在本机，可导出或按需清理。此栏目的操作即时生效，无需点「保存设置」。</p>
            <div class="data-grid" id="dataGrid"></div>
            <div class="data-actions">
              ${demo ? '<span class="tbtn" aria-disabled="true">导出本人数据</span>' : '<a class="tbtn" href="/api/data/export" download>导出本人数据</a>'}
              <button class="tbtn" id="clearFiles" type="button" ${demo ? "disabled" : ""}>清理附件与生成文件</button>
              <button class="tbtn danger" id="clearAllData" type="button" ${demo ? "disabled" : ""}>清空全部本地数据</button>
            </div>
          </section>
        </div>
      </div>
      <div class="setmsg" id="setMsg" role="status" aria-live="polite"></div>
      <div class="hall-settings-foot">
        <button class="tbtn" id="cancelSettings" type="button">关闭</button>
        <button class="tbtn primary" id="saveSettings" ${demo ? "disabled" : ""}>保存设置</button>
      </div>
    </div>
    <div id="hallPrompts" hidden>
      <p class="dlg-intro">输入框上方「提示词」一排就是这份模板清单，点一下即发送。删掉用不上的、加入你常问的，改动即时保存；每条最多 60 字、最多 12 条，清空后恢复默认清单。</p>
      <div class="qq-add">
        <input id="quickNewInput" type="text" maxlength="60" autocomplete="off" placeholder="想常问的问题，如：下周三有什么课" ${demo ? "disabled" : ""} aria-label="新增提示词模板">
        <button class="tbtn" id="quickAdd" type="button" ${demo ? "disabled" : ""}>添加</button>
      </div>
      <div class="qq-list" id="quickList" aria-label="提示词模板清单"></div>
      <div class="hall-settings-foot prompts-foot">
        <button class="tbtn" id="resetQuick" type="button" ${demo ? "disabled" : ""} title="清空自定义清单，恢复默认模板">恢复默认</button>
        <span class="setmsg good" id="promptsMsg" role="status" aria-live="polite"></span>
      </div>
    </div>
  </div>
</aside>
<div class="drawer-backdrop" id="drawerBackdrop"></div>
<script>
${appJs()}
</script>
</body>
</html>`;
}
