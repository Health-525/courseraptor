/** 网页视图：正式服务与离线演示共用，不依赖账号、模型或会话存储。 */
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
    --ink-3: #898274;
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
     dvh 让移动端键盘弹出时底栏跟着抬进可见区而不是被顶出屏幕 */
  body { margin: 0; display: grid; grid-template-columns: 284px 1fr;
         height: 100vh; height: 100dvh; overflow: hidden;
         background: var(--paper); color: var(--ink);
         font-family: var(--sans); font-size: 16px; line-height: 1.7;
         -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
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
  .sess-search { flex: none; width: 100%; margin: 0 0 8px; padding: 7px 9px;
                 border: 1px solid var(--rule); border-radius: 3px;
                 background: rgba(252, 251, 247, .55); color: var(--ink);
                 font-size: 13px; outline: none; }
  .sess-search:focus { border-color: var(--ink-3); }
  /* 竖排两行：新会话主按钮在上，今日日程入口单独一行在其下 */
  .mastbtns { display: flex; flex-direction: column; gap: 8px; }
  /* 竖排 flex 会把子项块化：链接里的文字水平居中要用 text-align，不是 justify-content */
  .mastbtns .tbtn { text-align: center; }
  .mastbtns .tbtn.primary { background: var(--accent);
                            border-color: var(--accent); color: var(--card);
                            font-weight: 600; letter-spacing: .12em; }
  .mastbtns .tbtn.primary:hover { background: var(--accent-deep);
                                  border-color: var(--accent-deep); color: #fff; }
  /* 日程入口：朱砂同族浅底深字，与主按钮构成主/次两级；不要描边（用户要求），悬停加深成实底 */
  .mastbtns a.tbtn { background: var(--accent-soft); border-color: transparent;
                     color: var(--accent-deep); font-weight: 600; }
  .mastbtns a.tbtn:hover { background: var(--accent); border-color: transparent;
                           color: #fff; }
  .foot-btn { flex: none; width: 100%; background: rgba(252, 251, 247, .48);
              color: var(--ink-2); }

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
             border-radius: 0 4px 4px 0; cursor: pointer;
             transition: background .15s ease, border-color .15s ease; }
  .sess li:hover { background: var(--card); }
  .sess li.on { border-left-color: var(--accent); background: var(--card);
                box-shadow: var(--shadow-sm); }
  .sess .st { font-size: 14px; color: var(--ink-2); overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; }
  .sess li.on .st { color: var(--ink); font-weight: 600; }
  .sess .sm { grid-column: 1; font-family: var(--mono); font-size: 12px;
              color: var(--ink-3); letter-spacing: .03em; }
  .sess .spin { color: var(--accent); margin-right: 5px; font-size: 11px; }
  .sess .sedit { grid-column: 1 / -1; width: 100%; border: 1px solid var(--ink-3);
                 background: var(--card); color: var(--ink); padding: 5px 7px;
                 font-size: 13px; outline: none; }
  .sess .sx { grid-row: 1; grid-column: 2; justify-self: end; border: 0;
              background: none; color: var(--ink-3); opacity: .65;
              font-size: 16px; cursor: pointer; padding: 0 4px;
              transition: opacity .15s ease, color .15s ease; }
  .sess .sx:hover { opacity: 1; color: var(--accent); }
  .sess .sactions { display: flex; grid-column: 1 / -1; gap: 10px; margin-top: 5px; }
  .sess .sactions button { padding: 0; border: 0; background: none; cursor: pointer;
                           font-family: var(--mono); font-size: 12px; color: var(--ink-3); }
  .sess .sactions button:hover { color: var(--accent); }
  .sess .snone { display: block; color: var(--ink-3); font-size: 14px;
                 padding: 6px 2px; cursor: default; }

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
  .demo-banner { display: flex; align-items: baseline; gap: 12px;
                 padding: 12px 32px; border-bottom: 1px solid var(--rule);
                 background: var(--accent-soft); color: var(--accent-deep);
                 font-size: 14px; line-height: 1.55; }
  .demo-banner strong { flex: none; font-size: 14px; }
  .demo-banner span { color: var(--ink-2); }
  #log { flex: 1; min-height: 0; overflow-y: auto; padding: 44px 40px 36px; }
  .inner { width: min(100%, 800px); min-height: 100%; margin: 0 auto; }

  /* 对话按「往来文书」排版：一行题注 + 正文，不做聊天气泡 */
  .turn { margin: 0 0 40px; }
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
  .tool { border: 1px solid var(--rule); background: var(--card); }
  .tool summary { display: flex; align-items: center; gap: 9px;
                  padding: 4px 10px; cursor: pointer; list-style: none;
                  font-family: var(--mono); font-size: 12px;
                  color: var(--ink-2); }
  .tool summary::-webkit-details-marker { display: none; }
  .tool summary:hover .tname { color: var(--accent); }
  /* 行首恒为一枚描线齿轮（不随状态换字形），状态交给行尾等宽小字说明 */
  .tool .tw { flex: none; width: 12px; display: flex; align-items: center;
              color: var(--ink-3); }
  .tool .tw svg { display: block; }
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
  .quickbar { display: flex; align-items: center; gap: 10px;
              max-width: 800px; margin: 0 auto 9px; }
  .qlabel { flex: none; font-family: var(--mono); font-size: 12px;
            letter-spacing: .14em; color: var(--ink-3); }
  .qchips { display: flex; min-width: 0; flex-wrap: nowrap; gap: 8px;
            overflow-x: auto; scrollbar-width: none; }
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

  /* ── 设置弹窗：一张盖了红头的办理单 ── */
  .overlay { position: fixed; inset: 0; z-index: 50;
             background: rgba(38, 35, 29, 0.42);
             display: grid; place-items: center; padding: 20px; }
  .overlay[hidden] { display: none; }
  .dlg { width: min(480px, 100%); background: var(--paper);
         border: 1px solid var(--rule-2); border-radius: 6px; overflow: hidden;
         box-shadow: 0 18px 60px rgba(38, 35, 29, 0.28); }
  .dlg.wide { width: min(680px, 100%); max-height: min(840px, calc(100dvh - 40px));
              display: flex; flex-direction: column; }
  .dlg.wide .dlg-body { overflow-y: auto; }
  .dlg-head { display: flex; align-items: center; justify-content: space-between;
              padding: 16px 22px 9px; }
  .dlg-head span { font-family: var(--kai); font-size: 22px;
                   color: var(--accent); letter-spacing: 3px; }
  .dclose { border: 0; background: none; color: var(--ink-3); cursor: pointer;
            font-size: 15px; padding: 2px 5px; border-radius: 3px; }
  .dclose:hover { color: var(--accent); }
  .dlg-rule { border-bottom: 2px solid var(--accent); margin: 0 22px; }
  .dlg-body { padding: 18px 22px 12px; }
  .dlg-intro { margin: 0 0 16px; color: var(--ink-2); font-size: 14px;
               line-height: 1.75; }

  /* 办理区块：一张单子上的并列栏目，细线分格；栏目名用等宽小字，
     栏目级动作（如“＋ 添加待办”）挂在头行右侧，与侧栏会话栏目的做法同构 */
  .panel { border: 1px solid var(--rule); border-radius: 4px;
           padding: 13px 15px 12px; margin: 0 0 14px; }
  .panel-head { display: flex; align-items: baseline; justify-content: space-between;
                gap: 10px; margin: 0 0 11px; padding-bottom: 7px;
                border-bottom: 1px solid var(--rule); }
  .panel-name { font-family: var(--mono); font-size: 12px; font-weight: 600;
                letter-spacing: .18em; color: var(--ink-2); }
  .panel-act { border: 0; background: none; padding: 0; cursor: pointer;
               font-family: var(--mono); font-size: 12px; letter-spacing: .06em;
               color: var(--accent); }
  .panel-act:hover { color: var(--accent-deep); text-decoration: underline; }

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

  .rem-list { display: grid; gap: 6px; }
  .rem-empty { border: 1px dashed var(--rule-2); border-radius: 3px;
               background: var(--card); color: var(--ink-3);
               font-size: 13px; text-align: center; padding: 16px 10px; }
  .rem-item { display: grid; grid-template-columns: auto 1fr auto; gap: 8px;
              align-items: start; border: 1px solid var(--rule); background: var(--card);
              padding: 8px 9px; }
  .rem-item.done { opacity: .58; }
  .rem-title { font-size: 14px; line-height: 1.45; }
  .rem-time { grid-column: 2; font-family: var(--mono); font-size: 12px; color: var(--ink-3); }
  .rem-tools { display: flex; gap: 7px; }
  .rem-tools a, .rem-tools button { border: 0; background: none; padding: 0; color: var(--ink-3);
                                   cursor: pointer; font-size: 12px; text-decoration: none; }
  .rem-tools a:hover, .rem-tools button:hover { color: var(--accent); }
  .data-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
  .data-cell { border: 1px solid var(--rule); background: var(--card); padding: 8px 9px; }
  .data-cell span { display: block; font-family: var(--mono); font-size: 12px; color: var(--ink-3); }
  .data-cell strong { font-size: 14px; font-weight: 600; }
  .data-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
  .data-actions .danger { color: var(--accent-deep); }
  .setnote { font-size: 12.5px; color: var(--ink-3); margin: 2px 2px 6px; line-height: 1.8; }
  .setmsg { font-family: var(--mono); font-size: 12px; min-height: 16px;
            margin: 0 2px 2px; white-space: pre-wrap; color: var(--accent-deep); }
  .setmsg.good { color: var(--ink-2); }
  .dlg-foot { display: flex; justify-content: flex-end; gap: 8px; flex: none;
              padding: 13px 22px 15px; border-top: 1px solid var(--rule);
              background: var(--card); }
  .dlg-foot .tbtn.primary { background: var(--accent);
                            border-color: var(--accent); color: var(--card);
                            font-weight: 600; }
  .dlg-foot .tbtn.primary:hover { background: var(--accent-deep);
                                  border-color: var(--accent-deep); color: #fff; }
  .dlg-foot .tbtn:disabled { opacity: .5; cursor: default; }

  #toBottom { position: fixed; right: 30px; bottom: 104px; z-index: 5;
              background: var(--card); border: 1px solid var(--rule-2);
              color: var(--ink-2); font-size: 13px; padding: 7px 13px;
              border-radius: 4px; cursor: pointer;
              box-shadow: 0 2px 10px rgba(38, 35, 29, 0.08); }
  #toBottom[hidden] { display: none; }
  #toBottom:hover { border-color: var(--accent); color: var(--accent); }

  .drawer-backdrop { display: none; position: fixed; inset: 0; z-index: 39;
                     background: rgba(38, 35, 29, .35); }

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
    aside { display: flex; position: fixed; inset: 0 auto 0 0; z-index: 40; width: min(320px, 88vw);
            transform: translateX(-102%); transition: transform .2s ease;
            box-shadow: 14px 0 36px rgba(38, 35, 29, .2); }
    body.drawer-open aside { transform: translateX(0); }
    body.drawer-open .drawer-backdrop { display: block; }
    .topbar { display: flex; }
    .demo-banner { padding: 10px 16px; }
    #log { padding: 28px 20px 24px; }
    form { padding: 11px 16px 10px; }
    .quickbar { margin-bottom: 8px; }
    .fhint { display: none; }
    #toBottom { right: 14px; bottom: 96px; }
  }
  @media (max-width: 560px) {
    .topbar { min-height: 54px; padding: 8px 12px; gap: 7px; }
    .topbar .tb-title { font-size: 17px; }
    .topbar .tbtn { min-height: 32px; padding: 4px 9px; font-size: 12px; }
    .demo-banner { display: block; padding: 9px 14px; font-size: 12px; }
    .demo-banner strong { display: block; margin-bottom: 2px; font-size: 13px; }
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
    <a class="tbtn" href="/today" title="下一节课、今日安排、本周概览与临近考试">今日日程</a>
  </div>
  <section class="sec">
    <h2>会话档案<span id="sessCount"></span></h2>
    <input class="sess-search" id="sessSearch" type="search" placeholder="搜索会话" aria-label="搜索会话">
    <ul class="sess" id="sessList"></ul>
  </section>
  <button class="tbtn foot-btn" id="openSettings" title="管理教务账号与 AI 模型">账号与模型</button>
</aside>
<main>
  ${demo ? '<div class="demo-banner" role="status"><strong>离线演示 · 全部为虚构数据</strong><span>不连接教务或 AI，不保存到磁盘。请勿输入个人信息。正式使用请在终端运行 npm start。</span></div>' : ""}
  <div class="topbar">
    <span class="tb-title wordmark"><span class="course">Course</span><span class="raptor">Raptor</span></span>
    <a class="tbtn" href="/today">今日</a>
    <button class="tbtn" id="openDrawerM">会话</button>
    <button class="tbtn" id="newSessionM">新会话</button>
    <button class="tbtn" id="openSettingsM">设置</button>
  </div>
  <div id="log"><div class="inner" id="inner">
    <div class="hero" id="hero">
      <div class="seal" aria-hidden="true"><img src="/logo.png" alt="" width="80" height="80"></div>
      <h2>同学，你好。</h2>
      <p>课表、成绩、考试、通知——直接用一句话问。<br>
      <span class="hint">${demo ? "点击下方常用问题体验示例；演示会话在服务重启后清空。" : "会话保存在本机；提问与所需查询结果会发送至配置的 AI 服务。"}</span></p>
    </div>
  </div></div>
  <form id="f">
    <div class="quickbar">
      <span class="qlabel">常用</span>
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
<div class="drawer-backdrop" id="drawerBackdrop"></div>
<div class="overlay" id="overlay" hidden>
  <div class="dlg wide" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
    <div class="dlg-head"><span id="dlgTitle">账号与模型</span><button class="dclose" id="closeSettings" aria-label="关闭账号与模型设置">✕</button></div>
    <div class="dlg-rule"></div>
    <div class="dlg-body">
      <p class="dlg-intro">正式查询前，请配置自己的教务账号与模型服务。已保存的信息不会在页面中完整显示，留空即保持不变。</p>
      <section class="panel">
        <header class="panel-head"><span class="panel-name">教务账号</span></header>
        <label class="fld"><span>学号</span><input id="sUser" type="text" autocomplete="off" ${demo ? "disabled" : ""}></label>
        <label class="fld"><span>登录密码</span><input id="sPass" type="password" autocomplete="new-password" ${demo ? "disabled" : ""}></label>
        <div class="cur" id="curJwgl"></div>
        <div class="diagrow"><button class="tbtn" id="testJwgl" type="button" ${demo ? "disabled" : ""}>检测教务连接</button><span class="diagstate" id="diagJwgl"></span></div>
      </section>
      <section class="panel">
        <header class="panel-head"><span class="panel-name">AI 模型</span></header>
        <label class="fld"><span>API Key</span><input id="sKey" type="password" autocomplete="new-password" ${demo ? "disabled" : ""}></label>
        <div class="cur" id="curKey"></div>
        <div class="model-cards" id="modelCards" role="radiogroup" aria-label="选择 AI 模型"></div>
        <input type="hidden" id="sModel" value="">
        <div class="cur" id="curModel"></div>
        <div class="diagrow"><button class="tbtn" id="testDeepseek" type="button" ${demo ? "disabled" : ""}>检测模型连接</button><span class="diagstate" id="diagDeepseek"></span></div>
      </section>
      <section class="panel">
        <header class="panel-head"><span class="panel-name">截止日期待办</span><button class="panel-act" id="addReminderManual" type="button" ${demo ? "disabled" : ""}>＋ 添加待办</button></header>
        <div class="rem-list" id="reminderList"><div class="rem-empty">暂无待办提醒</div></div>
      </section>
      <section class="panel">
        <header class="panel-head"><span class="panel-name">本地数据</span></header>
        <div class="data-grid" id="dataGrid"></div>
        <div class="data-actions">
          ${demo ? '<span class="tbtn" aria-disabled="true">导出本人数据</span>' : '<a class="tbtn" href="/api/data/export" download>导出本人数据</a>'}
          <button class="tbtn" id="clearFiles" type="button" ${demo ? "disabled" : ""}>清理附件与生成文件</button>
          <button class="tbtn danger" id="clearAllData" type="button" ${demo ? "disabled" : ""}>清空全部本地数据</button>
        </div>
      </section>
      <div class="setnote">不需要修改的项目请留空。教务账号和 API Key 仅加密保存在当前电脑。</div>
      <div class="setmsg" id="setMsg"></div>
    </div>
    <div class="dlg-foot">
      <button class="tbtn" id="cancelSettings">取消</button>
      <button class="tbtn primary" id="saveSettings" ${demo ? "disabled" : ""}>保存设置</button>
    </div>
  </div>
</div>
<div class="overlay" id="reminderOverlay" hidden>
  <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="reminderTitle">
    <div class="dlg-head"><span id="reminderTitle">确认待办</span><button class="dclose" id="closeReminder" aria-label="关闭待办设置">✕</button></div>
    <div class="dlg-rule"></div>
    <div class="dlg-body">
      <p class="dlg-intro">请核对截止时间。系统不会根据不明确的日期自动创建提醒。</p>
      <label class="fld"><span>待办</span><input id="rTitle" type="text" maxlength="100"></label>
      <label class="fld"><span>截止</span><input id="rDue" type="datetime-local"></label>
      <label class="fld"><span>来源</span><input id="rSource" type="text" maxlength="160"></label>
      <label class="fld"><span>备注</span><input id="rNotes" type="text" maxlength="500"></label>
      <div class="setmsg" id="reminderMsg"></div>
    </div>
    <div class="dlg-foot">
      <button class="tbtn" id="cancelReminder" type="button">取消</button>
      <button class="tbtn primary" id="saveReminder" type="button">保存待办</button>
    </div>
  </div>
</div>
<button id="toBottom" hidden>↓ 回到底部</button>
<script>
const logScroll = document.getElementById("log");
const inner = document.getElementById("inner");
const hero = document.getElementById("hero");
const input = document.getElementById("i");
const btn = document.getElementById("b");
let busy = false;
let controller = null;
/* 最近一轮的用户消息：失败重试用 */
let lastPrompt = "";

/* ── 多会话状态：正文以服务端存档为准，本地只记当前会话 id ── */
const ACTIVE_KEY = document.body.dataset.demo === "true" ? "raptor-demo-active-session" : "raptor-web-active-session";
/* 每次打开网页都从一个空白新会话开始；历史仍可在侧栏主动打开。 */
let activeId = "";
let msgs = [];
let lastSessions = [];
let sessionQuery = "";
let sessionActionsId = "";
let editingSessionId = "";
let pendingUploads = [];
function lsSet(k, v) {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {}
}
/* uuid 客户端先生成：第一条消息发出时服务端才建档，不留空壳会话 */
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : "s" + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
}

/* ── 小工具 ── */
function el(cls) {
  const div = document.createElement("div");
  div.className = cls;
  return div;
}
function el2(cls, text) {
  const n = el(cls);
  n.textContent = text;
  return n;
}
/* 工具卡片行首的描线齿轮：状态不再换字形，靠行尾文字表达，所以图标是常量。
   内容是这里写死的字符串（不掺模型输出），innerHTML 赋值不构成注入面 */
const GEAR = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" '
  + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0'
  + 'l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51'
  + 'a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08'
  + 'a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18'
  + 'a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39'
  + 'a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09'
  + 'a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25'
  + 'a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
function iconSpan(cls, svg) {
  const n = el(cls);
  n.innerHTML = svg;
  return n;
}
function pad(x) { return (x < 10 ? "0" : "") + x; }
function clock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function fmtWhen(ts) {
  const d = new Date(ts), n = new Date();
  return d.toDateString() === n.toDateString()
    ? clock(ts) : (d.getMonth() + 1) + "月" + d.getDate() + "日";
}

/* ── 快速提问：常驻在输入框上方 ── */
const QUESTIONS = ["这周课表", "教务处最近有什么通知", "我的成绩和 GPA", "最近的考试安排", "通识学分还缺哪些", "导出课表到手机日历"];
const qchips = document.getElementById("qchips");
QUESTIONS.forEach((q) => {
  const c = document.createElement("button");
  c.type = "button";
  c.className = "chip";
  c.dataset.q = q;
  c.textContent = q;
  qchips.appendChild(c);
});
qchips.addEventListener("click", (e) => {
  const c = e.target.closest("button[data-q]");
  if (c && !busy) send(c.dataset.q);
});

/* ── 智能滚动：用户上翻（离底 > 60px）就不再自动拽底 ── */
const toBottom = document.getElementById("toBottom");
let pinned = true;
logScroll.addEventListener("scroll", () => {
  pinned = logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 60;
  toBottom.hidden = pinned;
});
toBottom.addEventListener("click", () => scroll(true));

const HAS_MARKED = typeof marked !== "undefined";
/* 只转义 & 和 <：堵住 HTML 标签注入面（标签必须以 < 开头），同时保留
   Markdown 自己的语法字符——> 若被转义成 &gt;，块引用就失效了 */
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function renderMd(text) {
  if (!HAS_MARKED) return null;
  try {
    return marked.parse(escHtml(text), { gfm: true, breaks: true, async: false });
  } catch { return null; }
}

/* 流式期间每个 delta 都整段重渲 Markdown 会卡：合并到下一帧 */
let raf = 0;
let pending = null;
function renderStreaming(node, raw) {
  pending = { node, raw };
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!pending) return;
    const html = renderMd(pending.raw);
    if (html != null) pending.node.innerHTML = html;
    else pending.node.textContent = pending.raw;
    scroll(false);
  });
}

function scroll(force) {
  if (force || pinned) logScroll.scrollTop = logScroll.scrollHeight;
}

function clearTurns() {
  [...inner.querySelectorAll(".turn")].forEach((n) => n.remove());
}

/* ── 消息渲染：一行题注（谁 · 时间 · 耗时）+ 正文 ── */
function addTurn(cls) {
  const sec = el("turn " + cls);
  const cap = el("cap");
  cap.appendChild(el2("who", cls === "user" ? "你" : "助手"));
  const tm = el2("tm", "");
  const dur = el2("dur", "");
  cap.appendChild(tm);
  cap.appendChild(dur);
  sec.appendChild(cap);
  return { sec, cap, tm, dur };
}

function addUser(text, ts, attachments) {
  const { sec, tm } = addTurn("user");
  tm.textContent = clock(ts || Date.now());
  sec.appendChild(el2("msg", text));
  if (attachments && attachments.length) {
    const row = el("upload-tray");
    attachments.forEach((a) => row.appendChild(el2("upchip", "附件 · " + a.name)));
    sec.appendChild(row);
  }
  inner.appendChild(sec);
  scroll(true);
}

/** 助手一轮：题注 + 时间线区（思考卡片 + 工具卡片）+ 回答正文 + 操作行 */
function addBotShell() {
  const { sec, tm, dur } = addTurn("bot");
  const tl = el("tl");
  const msg = el("msg md");
  const acts = el("acts");
  sec.appendChild(tl);
  sec.appendChild(msg);
  sec.appendChild(acts);
  inner.appendChild(sec);
  scroll(true);
  /* 工具卡片索引：id 精确配对为主，同名排队兜底；think 是当前展开中的思考卡片 */
  return { sec, tm, dur, tl, msg, acts, tools: new Map(), queue: {}, think: null };
}

function addCopyButton(acts, raw) {
  if (!raw.trim()) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tbtn";
  b.textContent = "复制";
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(raw);
      b.textContent = "已复制";
      setTimeout(() => (b.textContent = "复制"), 1200);
    } catch { /* 剪贴板不可用就静默 */ }
  });
  acts.appendChild(b);
}

/** 定格一条完整助手消息（openSession 重绘历史用）；thinkText 是历史里的思考 */
function addBotMessage(raw, ts, thinkText) {
  const shell = addBotShell();
  shell.tm.textContent = clock(ts);
  if (thinkText) {
    /* 历史里的思考不计时（重开时算出的耗时是假的），建卡即定格为折叠态 */
    const item = thinkNew(shell.tl);
    item.body.textContent = thinkText;
    item.st.textContent = "已完成";
    item.det.open = false;
  }
  const html = renderMd(raw);
  if (html != null) shell.msg.innerHTML = html;
  else shell.msg.textContent = raw;
  addCopyButton(shell.acts, raw);
  scroll(false);
  return shell;
}

/* ── 思考卡片：一段 reasoning 一张卡，流式期间展开、段落收尾自动折叠 ── */
function thinkNew(tl) {
  const det = document.createElement("details");
  det.className = "think";
  det.open = true;
  const sum = document.createElement("summary");
  sum.appendChild(el2("tk", "思考"));
  const st = el2("tstat", "进行中");
  const dur = el2("tdur", "");
  sum.appendChild(st);
  sum.appendChild(dur);
  det.appendChild(sum);
  const body = el("thbody");
  det.appendChild(body);
  const item = { det, st, dur, body, buf: "", at: Date.now(), manual: false };
  /* 监听器挂在 open=true 之后：程序化的首次展开不算用户手动开合 */
  det.addEventListener("toggle", () => { item.manual = true; });
  tl.appendChild(det);
  return item;
}

function thinkDelta(shell, text) {
  if (!shell.think) shell.think = thinkNew(shell.tl);
  const item = shell.think;
  item.buf += text;
  item.body.textContent = item.buf;
  scroll(false);
}

/** 本段思考结束：定格状态字与耗时，用户没手动开过就折叠起来 */
function thinkClose(shell, stat) {
  const item = shell.think;
  if (!item) return;
  shell.think = null;
  item.st.textContent = stat || "已完成";
  item.dur.textContent = ((Date.now() - item.at) / 1000).toFixed(1) + "s";
  if (!item.manual) item.det.open = false;
}

/* ── 工具卡片：行首齿轮恒定，状态用等宽小字写「执行中 / 完成 / 失败」 ── */
function appendPre(body, label, text) {
  const w = el("psec");
  w.appendChild(el2("plabel", label));
  const pre = document.createElement("pre");
  pre.textContent = text;
  w.appendChild(pre);
  body.appendChild(w);
}

function toolCard(shell, ev) {
  const det = document.createElement("details");
  det.className = "tool run";
  const sum = document.createElement("summary");
  sum.appendChild(iconSpan("tw", GEAR));
  sum.appendChild(el2("tname", ev.name || "tool"));
  sum.appendChild(el2("tsum", ""));
  sum.appendChild(el2("tstat", "执行中"));
  sum.appendChild(el2("tdur", ""));
  det.appendChild(sum);
  const body = el("tbody");
  if (ev.args) appendPre(body, "参数", ev.args);
  det.appendChild(body);
  shell.tl.appendChild(det);
  const item = { det, body };
  if (ev.id) shell.tools.set("id:" + ev.id, item);
  const name = ev.name || "tool";
  (shell.queue[name] = shell.queue[name] || []).push(item);
  scroll(false);
  return item;
}

function toolTake(shell, ev) {
  let item = ev.id ? shell.tools.get("id:" + ev.id) : null;
  if (item) shell.tools.delete("id:" + ev.id);
  if (!item) {
    const q = shell.queue[ev.name] || [];
    item = q.shift() || null;
  }
  /* start 事件丢失等兜底：直接补一张已建好的卡再定格 */
  if (!item) item = toolCard(shell, { id: "", name: ev.name, args: "" });
  return item;
}

function toolDone(shell, ev, ok) {
  const item = toolTake(shell, ev);
  item.det.className = "tool " + (ok ? "ok" : "bad");
  item.det.querySelector(".tstat").textContent = ok ? "完成" : "失败";
  item.det.querySelector(".tsum").textContent = String(ev.brief || "");
  item.det.querySelector(".tdur").textContent =
    ev.dur != null ? (ev.dur / 1000).toFixed(1) + "s" : "";
  if (ev.out) appendPre(item.body, "结果", ev.out);
  scroll(false);
}

/** 非工具错误（网络失败 / 中断 / agent err）：仍是等宽一行 */
function lineBad(tl, text, mark) {
  const p = el("tline bad");
  p.appendChild(el2("mark", mark || "✗"));
  p.appendChild(el2("st", text));
  tl.appendChild(p);
  scroll(false);
}

/* ── 成品文件下载行：工具结果带 files 时渲染在工具卡下方 ── */
function fmtSize(n) {
  if (!n) return "";
  return n >= 1048576
    ? (n / 1048576).toFixed(1) + " MB"
    : Math.max(1, Math.round(n / 1024)) + " KB";
}
function fileRows(tl, files) {
  files.forEach((f) => {
    const row = el("frow");
    row.appendChild(el2("fmark", "📎"));
    const nm = el2("fname", f.name + (f.size ? "（" + fmtSize(f.size) + "）" : ""));
    row.appendChild(nm);
    const a = document.createElement("a");
    a.className = "tbtn";
    a.href = "/files/" + encodeURIComponent(f.name);
    a.setAttribute("download", f.name);
    a.textContent = "下载";
    row.appendChild(a);
    tl.appendChild(row);
  });
  scroll(false);
}

/* ── 会话档案：列表 / 打开 / 删除 / 新会话 ── */
const sessList = document.getElementById("sessList");
function renderSessList() {
  sessList.innerHTML = "";
  document.getElementById("sessCount").textContent =
    lastSessions.length ? lastSessions.length + " 个" : "";
  const visible = lastSessions.filter((s) =>
    !sessionQuery || String(s.title || "").toLowerCase().includes(sessionQuery.toLowerCase()));
  if (!visible.length) {
    const li = document.createElement("li");
    li.className = "snone";
    li.textContent = lastSessions.length ? "没有匹配的会话" : "暂无历史会话";
    sessList.appendChild(li);
    return;
  }
  visible.forEach((s) => {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    if (s.id === activeId) li.className = "on";
    li.title = s.title || "新会话";
    if (editingSessionId === s.id) {
      const edit = document.createElement("input");
      edit.className = "sedit"; edit.value = s.title || "新会话"; edit.maxLength = 60;
      edit.addEventListener("click", (e) => e.stopPropagation());
      edit.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveSessionTitle(s.id, edit.value); }
        if (e.key === "Escape") { editingSessionId = ""; renderSessList(); }
      });
      li.appendChild(edit);
      setTimeout(() => { edit.focus(); edit.select(); }, 0);
    } else {
      const title = el("st");
      if (s.pinned) title.appendChild(el2("spin", "置顶"));
      title.appendChild(document.createTextNode(s.title || "新会话"));
      li.appendChild(title);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "sx";
    x.dataset.actions = s.id;
    x.title = "会话操作";
    x.textContent = "⋯";
    li.appendChild(x);
    li.appendChild(el2("sm", fmtWhen(s.updatedAt) + " · " + s.count + " 条"));
    if (sessionActionsId === s.id && editingSessionId !== s.id) {
      const actions = el("sactions");
      const action = (label, key) => {
        const button = document.createElement("button");
        button.type = "button"; button.dataset[key] = s.id; button.textContent = label;
        actions.appendChild(button);
      };
      action(s.pinned ? "取消置顶" : "置顶", "pin");
      action("改名", "rename");
      action("删除", "del");
      li.appendChild(actions);
    }
    sessList.appendChild(li);
  });
}

function patchSession(id, body) {
  return fetch("/api/sessions/" + encodeURIComponent(id), {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.ok ? r.json() : Promise.reject(new Error("更新会话失败")));
}
function saveSessionTitle(id, title) {
  const value = String(title || "").trim();
  if (!value) return;
  patchSession(id, { title: value }).then(() => {
    editingSessionId = ""; sessionActionsId = ""; return refreshSessions();
  }).catch(() => {});
}

function refreshSessions() {
  return fetch("/api/sessions").then((r) => r.json()).then((d) => {
    lastSessions = d.sessions || [];
    renderSessList();
  }).catch(() => {});
}

function openSession(id) {
  activeId = id;
  lsSet(ACTIVE_KEY, id);
  return fetch("/api/sessions/" + encodeURIComponent(id))
    .then((r) => (r.ok ? r.json() : null)).then((d) => {
      msgs = (d && d.messages) || [];
      clearTurns();
      if (!msgs.length) { hero.style.display = ""; renderSessList(); closeDrawer(); return; }
      hero.style.display = "none";
      /* 重绘历史：渲染函数不写 msgs（它已是服务端数据的镜像） */
      msgs.forEach((m) => {
        if (m.role === "user") addUser(m.text, m.ts, m.attachments);
        else addBotMessage(m.text, m.ts, m.think);
      });
      scroll(true);
      renderSessList();
      closeDrawer();
    }).catch(() => {});
}

function delSession(id) {
  if (busy) return;
  if (!window.confirm("删除这个会话？不可恢复。")) return;
  fetch("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" })
    .then(() => refreshSessions())
    .then(() => {
      if (id !== activeId) return;
      if (lastSessions.length) return openSession(lastSessions[0].id);
      activeId = "";
      lsSet(ACTIVE_KEY, "");
      startFresh();
    }).catch(() => {});
}

function startFresh() {
  activeId = uuid();
  lsSet(ACTIVE_KEY, activeId);
  msgs = [];
  clearTurns();
  hero.style.display = "";
  renderSessList();
  input.focus();
}

sessList.addEventListener("click", (e) => {
  const del = e.target.closest("button[data-del]");
  if (del) { delSession(del.dataset.del); return; }
  const pin = e.target.closest("button[data-pin]");
  if (pin) {
    const current = lastSessions.find((s) => s.id === pin.dataset.pin);
    if (current) patchSession(current.id, { pinned: !current.pinned }).then(refreshSessions).catch(() => {});
    return;
  }
  const rename = e.target.closest("button[data-rename]");
  if (rename) { editingSessionId = rename.dataset.rename; sessionActionsId = ""; renderSessList(); return; }
  const actions = e.target.closest("button[data-actions]");
  if (actions) {
    sessionActionsId = sessionActionsId === actions.dataset.actions ? "" : actions.dataset.actions;
    renderSessList(); return;
  }
  const li = e.target.closest("li[data-id]");
  if (li && !busy) openSession(li.dataset.id);
});

document.getElementById("sessSearch").addEventListener("input", (e) => {
  sessionQuery = e.target.value.trim(); renderSessList();
});

function openDrawer() { document.body.classList.add("drawer-open"); }
function closeDrawer() { document.body.classList.remove("drawer-open"); }
document.getElementById("openDrawerM").addEventListener("click", openDrawer);
document.getElementById("drawerBackdrop").addEventListener("click", closeDrawer);

async function doNewSession() {
  if (busy) return;
  /* 当前会话还没说过话：不重复建档，光标归位即可 */
  if (!msgs.length) { input.focus(); closeDrawer(); return; }
  startFresh();
  closeDrawer();
}
document.getElementById("newSession").addEventListener("click", doNewSession);
document.getElementById("newSessionM").addEventListener("click", doNewSession);

/* ── 设置弹窗：教务账号 + DeepSeek API Key（后端走 /key 同一套加密热生效）── */
const overlay = document.getElementById("overlay");
const sUser = document.getElementById("sUser");
const sPass = document.getElementById("sPass");
const sKey = document.getElementById("sKey");
const sModel = document.getElementById("sModel");
const curModel = document.getElementById("curModel");
const setMsg = document.getElementById("setMsg");
const reminderOverlay = document.getElementById("reminderOverlay");
const reminderMsg = document.getElementById("reminderMsg");
const rTitle = document.getElementById("rTitle");
const rDue = document.getElementById("rDue");
const rSource = document.getElementById("rSource");
const rNotes = document.getElementById("rNotes");
let reminderSourceUrl = "";
let setStatus = null;

function localDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

function refreshReminders() {
  return fetch("/api/reminders").then((r) => r.json()).then((d) => {
    const host = document.getElementById("reminderList");
    host.innerHTML = "";
    const reminders = d.reminders || [];
    if (!reminders.length) { host.appendChild(el2("rem-empty", "暂无待办提醒")); return; }
    reminders.forEach((reminder) => {
      const item = el("rem-item" + (reminder.done ? " done" : ""));
      const done = document.createElement("input");
      done.type = "checkbox"; done.checked = !!reminder.done; done.title = "标记完成";
      done.addEventListener("change", () => fetch("/api/reminders/" + reminder.id, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ done: done.checked }),
      }).then(refreshReminders));
      item.appendChild(done);
      item.appendChild(el2("rem-title", reminder.title));
      const tools = el("rem-tools");
      const cal = document.createElement("a");
      cal.href = "/api/reminders/" + reminder.id + ".ics"; cal.download = ""; cal.textContent = "日历";
      tools.appendChild(cal);
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "删除";
      del.addEventListener("click", () => {
        if (!window.confirm("删除这条待办提醒？")) return;
        fetch("/api/reminders/" + reminder.id, { method: "DELETE" }).then(refreshReminders).then(refreshData);
      });
      tools.appendChild(del); item.appendChild(tools);
      item.appendChild(el2("rem-time", new Date(reminder.dueAt).toLocaleString("zh-CN", { hour12: false })));
      host.appendChild(item);
    });
  }).catch(() => {});
}

function refreshData() {
  return fetch("/api/data").then((r) => r.json()).then((d) => {
    const cells = [
      ["会话", d.sessions.count + " 个 · " + d.sessions.messages + " 条"],
      ["已读附件", d.attachments.count + " 个 · " + fmtSize(d.attachments.bytes)],
      ["网页上传", d.uploads.count + " 个 · " + fmtSize(d.uploads.bytes)],
      ["生成文件", d.generated.count + " 个 · " + fmtSize(d.generated.bytes)],
      ["未完成待办", d.reminders.open + " 条"],
    ];
    const host = document.getElementById("dataGrid"); host.innerHTML = "";
    cells.forEach(([label, value]) => {
      const cell = el("data-cell"); cell.appendChild(el2("", label));
      const strong = document.createElement("strong"); strong.textContent = value; cell.appendChild(strong);
      host.appendChild(cell);
    });
  }).catch(() => {});
}

function openReminder(preset) {
  const p = preset || {};
  reminderSourceUrl = p.sourceUrl || "";
  rTitle.value = p.title || "";
  rDue.value = localDateTime(p.dueAt);
  rSource.value = p.source || "";
  rNotes.value = "";
  reminderMsg.textContent = "";
  reminderOverlay.hidden = false;
  (rTitle.value ? rDue : rTitle).focus();
}
function closeReminder() { reminderOverlay.hidden = true; }
document.getElementById("addReminderManual").addEventListener("click", () => openReminder({}));
document.getElementById("closeReminder").addEventListener("click", closeReminder);
document.getElementById("cancelReminder").addEventListener("click", closeReminder);
reminderOverlay.addEventListener("mousedown", (e) => { if (e.target === reminderOverlay) closeReminder(); });
document.getElementById("saveReminder").addEventListener("click", () => {
  const button = document.getElementById("saveReminder");
  if (!rTitle.value.trim() || !rDue.value) {
    reminderMsg.textContent = "请填写待办内容并确认截止时间。"; return;
  }
  button.disabled = true;
  fetch("/api/reminders", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: rTitle.value.trim(), dueAt: new Date(rDue.value).toISOString(),
      source: rSource.value.trim(), sourceUrl: reminderSourceUrl, notes: rNotes.value.trim(),
    }),
  }).then((r) => r.json().then((d) => ({ ok: r.ok, d }))).then(({ ok, d }) => {
    button.disabled = false;
    if (!ok) { reminderMsg.textContent = d.error || "保存失败"; return; }
    closeReminder(); refreshReminders(); refreshData();
  }).catch(() => { button.disabled = false; reminderMsg.textContent = "保存失败，请重试。"; });
});

function runDiagnostic(target, buttonId, stateId) {
  const button = document.getElementById(buttonId), state = document.getElementById(stateId);
  button.disabled = true; state.textContent = "检测中…";
  fetch("/api/diagnostics", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }),
  }).then((r) => r.json()).then((d) => {
    button.disabled = false; state.textContent = d.result ? d.result.message : (d.error || "检测失败");
  }).catch(() => { button.disabled = false; state.textContent = "检测失败，请确认本地服务正在运行。"; });
}
document.getElementById("testJwgl").addEventListener("click", () => runDiagnostic("jwgl", "testJwgl", "diagJwgl"));
document.getElementById("testDeepseek").addEventListener("click", () => runDiagnostic("deepseek", "testDeepseek", "diagDeepseek"));

/* ── 型号卡片：候选由后端给（该 Key 实际可用的型号），拉不到时是内置兜底清单。
   sModel 仍是值的唯一载体（hidden input），保存逻辑读 sModel.value 不变 ── */
function pickModel(id) {
  sModel.value = id || "";
  for (const card of document.querySelectorAll("#modelCards .model-card")) {
    const on = card.dataset.modelId === id;
    card.classList.toggle("picked", on);
    card.setAttribute("aria-checked", on ? "true" : "false");
  }
}
function fillModels(options, current, message) {
  const list = Array.isArray(options) ? options : [];
  const keep = sModel.value;
  const host = document.getElementById("modelCards");
  host.textContent = "";
  if (!list.length) {
    host.appendChild(el2("model-empty", message || "型号清单读取中…"));
  } else {
    for (const m of list) {
      if (!m || typeof m.id !== "string") continue;
      const card = el("model-card");
      card.dataset.modelId = m.id;
      card.setAttribute("role", "radio");
      card.tabIndex = 0;
      card.appendChild(el2("mc-name", m.label || m.id));
      if (m.id === current) card.appendChild(el2("mc-badge", "当前"));
      card.appendChild(el2("mc-id", m.id));
      if (m.note) card.appendChild(el2("mc-note", m.note));
      card.addEventListener("click", () => {
        if (document.body.dataset.demo === "true") return;
        /* 再点一次已选卡片＝取消更换，回到「不修改」 */
        pickModel(card.dataset.modelId === sModel.value ? "" : card.dataset.modelId);
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); card.click(); }
      });
      host.appendChild(card);
    }
  }
  pickModel(keep && list.some((m) => m && m.id === keep) ? keep : "");
  const picked = list.filter((m) => m && m.id === current)[0];
  let note = "当前：" + ((picked && picked.label) || current || "未设置");
  if (picked && picked.note) note += " · " + picked.note;
  if (message && list.length) note += " · " + message;
  curModel.textContent = note;
}
/* 方向键在卡片间移动焦点（承接原生下拉的键盘习惯）；空格/回车才做选择 */
document.getElementById("modelCards").addEventListener("keydown", (e) => {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const cards = [...document.querySelectorAll("#modelCards .model-card")];
  if (cards.length < 2) return;
  const step = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1;
  const next = cards[(cards.indexOf(document.activeElement) + step + cards.length) % cards.length];
  if (next) { e.preventDefault(); next.focus(); }
});

function showSettings() {
  overlay.hidden = false;
  closeDrawer();
  setMsg.className = "setmsg";
  setMsg.textContent = "";
  sPass.value = ""; sKey.value = ""; pickModel("");
  document.getElementById("diagJwgl").textContent = "";
  document.getElementById("diagDeepseek").textContent = "";
  refreshReminders(); refreshData();
  fetch("/api/settings").then((r) => r.json()).then((d) => {
    setStatus = d;
    sUser.value = "";
    sUser.placeholder = d.jwgl.username || "请输入教务系统学号";
    sPass.placeholder = d.jwgl.configured ? "已保存；留空不修改" : "请输入教务系统密码";
    document.getElementById("curJwgl").textContent = d.jwgl.configured
      ? "已保存：学号 " + d.jwgl.username + " · " + d.jwgl.sourceLabel
      : "尚未配置教务账号";
    document.getElementById("curKey").textContent = d.deepseek.configured
      ? "已保存：" + (d.deepseek.masked || "API Key") + " · " + d.deepseek.sourceLabel + " · " + d.model
      : "尚未配置 API Key · 当前模型 " + d.model;
    sKey.placeholder = "sk-…；留空不修改";
    fillModels(d.models, d.model, "");
    (d.jwgl.configured ? sPass : sUser).focus();
  }).catch(() => { setMsg.textContent = "无法读取设置，请确认本地服务正在运行。"; });
  // 清单以该 Key 实际可用的型号为准；服务端 10 分钟内走缓存，不重复联网
  fetch("/api/models").then((r) => r.json()).then((m) => {
    if (!m || !Array.isArray(m.options)) return;
    fillModels(m.options, m.current, m.source === "live" ? "" : m.message);
  }).catch(() => {});
}
function hideSettings() { overlay.hidden = true; }
document.getElementById("openSettings").addEventListener("click", showSettings);
document.getElementById("openSettingsM").addEventListener("click", showSettings);
document.getElementById("closeSettings").addEventListener("click", hideSettings);
document.getElementById("cancelSettings").addEventListener("click", hideSettings);
overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) hideSettings(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!reminderOverlay.hidden) closeReminder();
  else if (!overlay.hidden) hideSettings();
  else closeDrawer();
});

function clearData(scopes, prompt) {
  if (!window.confirm(prompt)) return;
  fetch("/api/data/clear", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopes }),
  }).then((r) => r.json()).then(() => {
    refreshReminders(); refreshData(); refreshSessions();
    if (scopes.includes("sessions")) startFresh();
  }).catch(() => {});
}
document.getElementById("clearFiles").addEventListener("click", () => clearData(
  ["attachments", "uploads", "generated"],
  "清理已读附件副本、网页上传和生成文件？聊天记录与待办会保留。",
));
document.getElementById("clearAllData").addEventListener("click", () => clearData(
  ["sessions", "attachments", "uploads", "generated", "reminders"],
  "清空全部本地会话、附件、生成文件和待办？此操作不可恢复。",
));
document.getElementById("saveSettings").addEventListener("click", () => {
  const body = {};
  const u = sUser.value.trim(), pw = sPass.value, k = sKey.value.trim();
  if (pw) {
    /* 只改密码时自动带上现有学号，免得来回填 */
    body.jwglPassword = pw;
    body.jwglUsername = u || (setStatus && setStatus.jwgl.username) || "";
  } else if (u) {
    setMsg.className = "setmsg";
    setMsg.textContent = "修改学号时，请同时填写新的登录密码。";
    return;
  }
  if (k) body.apiKey = k;
  if (sModel.value) body.model = sModel.value;
  if (!Object.keys(body).length) {
    setMsg.className = "setmsg";
    setMsg.textContent = "没有需要保存的修改；可以直接使用上方连接检测。";
    return;
  }
  const saveBtn = document.getElementById("saveSettings");
  saveBtn.disabled = true;
  fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json().then((d) => ({ ok: r.ok, d }))).then(({ ok, d }) => {
    saveBtn.disabled = false;
    setMsg.className = "setmsg" + (ok ? " good" : "");
    setMsg.textContent = (d.results || []).map((x) => x.message).join("\\n");
    if (ok && d.status) {
      setStatus = d.status; sUser.value = ""; sPass.value = ""; sKey.value = "";
      sUser.placeholder = d.status.jwgl.username || "请输入教务系统学号";
      sPass.placeholder = d.status.jwgl.configured ? "已保存；留空不修改" : "请输入教务系统密码";
      document.getElementById("curJwgl").textContent = d.status.jwgl.configured
        ? "已保存：学号 " + d.status.jwgl.username + " · " + d.status.jwgl.sourceLabel
        : "尚未配置教务账号";
      document.getElementById("curKey").textContent = d.status.deepseek.configured
        ? "已保存：" + (d.status.deepseek.masked || "API Key") + " · " + d.status.deepseek.sourceLabel + " · " + d.status.model
        : "尚未配置 API Key · 当前模型 " + d.status.model;
      pickModel("");
      fillModels(d.status.models, d.status.model, "");
    }
  }).catch(() => {
    saveBtn.disabled = false;
    setMsg.textContent = "保存失败，请确认本地服务正在运行后重试。";
  });
});

/* ── 启动：拉会话列表，但默认进入新的空会话 ── */
refreshSessions().then(() => {
  startFresh();
});

/* QQ 那边的对话也写进同一份档案，光靠启动拉一次要重开页面才看得见。
   定时补一次列表：正在回复（busy）不打断，标签页在后台（hidden）不刷 */
setInterval(() => {
  if (!busy && !document.hidden) refreshSessions();
}, 20000);

/* ── 网页附件：先上传到本机受控目录，再随本轮只发送附件 id ── */
const uploadTray = document.getElementById("uploadTray");
const fileInput = document.getElementById("fileInput");
const cwrap = document.querySelector(".cwrap");
function renderUploads() {
  uploadTray.innerHTML = "";
  pendingUploads.forEach((upload) => {
    const chip = el("upchip" + (upload.status === "uploading" ? " loading" : ""));
    chip.appendChild(el2("", (upload.status === "uploading" ? "上传中 · " : upload.status === "error" ? "失败 · " : "附件 · ") + upload.name));
    const remove = document.createElement("button");
    remove.type = "button"; remove.textContent = "✕"; remove.title = "移除附件";
    remove.addEventListener("click", () => {
      pendingUploads = pendingUploads.filter((x) => x.localId !== upload.localId);
      if (upload.id) fetch("/api/uploads/" + upload.id, { method: "DELETE" }).catch(() => {});
      renderUploads(); syncBtn();
    });
    chip.appendChild(remove); uploadTray.appendChild(chip);
  });
}
function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = reject; reader.readAsDataURL(file);
  });
}
async function uploadFile(file) {
  const localId = uuid();
  const item = { localId, name: file.name, size: file.size, status: "uploading" };
  pendingUploads.push(item); renderUploads(); syncBtn();
  try {
    const data = await fileAsBase64(file);
    const response = await fetch("/api/uploads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, type: file.type, data }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "上传失败");
    Object.assign(item, body.upload, { status: "ready" });
  } catch (error) {
    item.status = "error"; item.error = String(error.message || error);
    item.name = item.name + "（" + item.error + "）";
  }
  renderUploads(); syncBtn();
}
function handleFiles(files) {
  [...files].slice(0, Math.max(0, 8 - pendingUploads.length)).forEach(uploadFile);
}
document.getElementById("attachBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { handleFiles(fileInput.files || []); fileInput.value = ""; });
["dragenter", "dragover"].forEach((name) => cwrap.addEventListener(name, (e) => {
  e.preventDefault(); if (!document.body.dataset.demo.includes("true")) cwrap.classList.add("drag");
}));
["dragleave", "drop"].forEach((name) => cwrap.addEventListener(name, (e) => {
  e.preventDefault(); cwrap.classList.remove("drag");
  if (name === "drop" && e.dataTransfer) handleFiles(e.dataTransfer.files || []);
}));

async function send(text) {
  if (!text || busy) return;
  busy = true;
  lastPrompt = text;
  hero.style.display = "none";
  const t0 = Date.now();
  const sendingUploads = pendingUploads.filter((x) => x.status === "ready");
  const attachmentView = sendingUploads.map((x) => ({ id: x.id, name: x.name }));
  msgs.push({ role: "user", text, ts: t0, attachments: attachmentView });
  addUser(text, t0, attachmentView);
  const shell = addBotShell();
  shell.msg.classList.add("cursor");
  btn.classList.add("stop");
  btn.innerHTML = '停止<span class="kbd">⏎</span>';
  let raw = "";
  let thinkRaw = "";
  controller = new AbortController();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: text, sessionId: activeId,
        attachmentIds: sendingUploads.map((x) => x.id),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "HTTP " + res.status);
    }
    pendingUploads = pendingUploads.filter((x) => !sendingUploads.includes(x));
    renderUploads();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.t === "think") {
          /* 一段思考一张卡：段末标记或后续任何别的事件都把它定格折叠 */
          if (ev.phase === "end") thinkClose(shell);
          else { thinkRaw += ev.v || ""; thinkDelta(shell, ev.v || ""); }
        } else if (ev.t === "text") {
          thinkClose(shell);
          if (!raw) shell.tm.textContent = clock(Date.now());
          raw += ev.v;
          renderStreaming(shell.msg, raw);
        } else if (ev.t === "tool") {
          thinkClose(shell);
          if (ev.phase === "start") toolCard(shell, ev);
          else {
            toolDone(shell, ev, ev.phase === "end");
            if (ev.files && ev.files.length) fileRows(shell.tl, ev.files);
          }
        } else if (ev.t === "err") {
          thinkClose(shell);
          lineBad(shell.tl, ev.v);
        } else if (ev.t === "end") {
          thinkClose(shell);
          if (ev.dur != null) shell.dur.textContent = "· " + (ev.dur / 1000).toFixed(1) + "s";
          /* 服务端可能把无名新会话建档成 default 档：认领回来的 id */
          if (ev.sid) { activeId = String(ev.sid); lsSet(ACTIVE_KEY, activeId); }
        }
      }
    }
    /* 完整跑完的一轮才写进本地镜像（和服务端落盘同一口径）。
       定格在流式已有的气泡上——再建一行会留下空行+重复回复 */
    if (raw.trim()) {
      const html = renderMd(raw);
      if (html != null) shell.msg.innerHTML = html;
      else shell.msg.textContent = raw;
      addCopyButton(shell.acts, raw);
      msgs.push({ role: "bot", text: raw, think: thinkRaw.trim() || undefined, ts: Date.now() });
    } else {
      shell.msg.textContent = "这轮没有输出，再问一次试试";
    }
  } catch (e) {
    shell.tm.textContent = clock(Date.now());
    if (e.name === "AbortError") {
      /* 用户中断：显示已生成的半截，但不进历史（同服务端口径） */
      if (raw.trim()) {
        const html = renderMd(raw);
        if (html != null) shell.msg.innerHTML = html;
        else shell.msg.textContent = raw;
        thinkClose(shell, "已中断");
        lineBad(shell.tl, "已中断", "⏸");
      } else {
        thinkClose(shell, "已中断");
        shell.msg.textContent = "已中断";
      }
    } else {
      lineBad(shell.tl, String(e.message || e));
      if (!raw.trim()) shell.msg.textContent = "这轮没有输出，再问一次试试";
      /* 失败给一键重试（中断不给：是用户主动停的） */
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "tbtn";
      retry.textContent = "重试本轮";
      retry.addEventListener("click", () => { if (!busy) send(lastPrompt); });
      shell.acts.appendChild(retry);
    }
  } finally {
    thinkClose(shell);
    shell.msg.classList.remove("cursor");
    busy = false; controller = null;
    btn.classList.remove("stop");
    btn.innerHTML = '发送<span class="kbd">⏎</span>';
    syncBtn();
    /* 标题可能挂着完成提醒；切走了就补一次亮灯 */
    if (document.hidden) document.title = "● 回复完成 · CourseRaptor";
    refreshSessions();
    input.focus();
  }
}

/* ── 输入区：textarea 自适应高度；Enter 发送、Shift+Enter 换行；
   进行中再按 = 中断（按钮同样）；空文时发送键落灰 ─────────── */
const form = document.getElementById("f");
function fit() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}
/* 空内容时发送键禁用；流式进行中永远可点（此时它是「停止」） */
function syncBtn() {
  const uploading = pendingUploads.some((x) => x.status === "uploading");
  const readyFile = pendingUploads.some((x) => x.status === "ready");
  btn.disabled = !busy && (uploading || (!input.value.trim() && !readyFile));
}
input.addEventListener("input", () => { fit(); syncBtn(); });
syncBtn();
input.addEventListener("keydown", (e) => {
  /* 中文输入法组词中的 Enter 是确认候选词，不是发送（keyCode 229 = 组词中） */
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) { controller?.abort(); return; }
  const text = input.value.trim() || (pendingUploads.some((x) => x.status === "ready") ? "请阅读并概括这些附件" : "");
  if (!text) return;
  input.value = "";
  fit();
  send(text);
});

/* 切回本页时复位标题（后台完成时的 ● 提示只留到看见为止） */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) document.title = "CourseRaptor";
});
input.focus();
</script>
</body>
</html>`;
}
