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
    --paper: #F5F3EC;   /* 纸面 */
    --card: #FBFAF6;    /* 浮起的纸片 */
    --shade: #ECE8DD;   /* 压深的纸（表头/代码底） */
    --ink: #26231D;     /* 墨 */
    --ink-2: #5C574C;
    --ink-3: #948E7F;
    --rule: #E3DED1;    /* 细线 */
    --rule-2: #CCC5B3;  /* 重一点的线 */
    --accent: #AF3A2C;      /* 朱砂 */
    --accent-deep: #8C2D22;
    --accent-soft: #F4E5E1;
    --serif: Georgia, "Times New Roman", "Songti SC", SimSun, serif;
    --kai: "KaiTi", "STKaiti", "Kaiti SC", var(--serif);
    --sans: system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --mono: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  /* 锁定整页：只有消息区能滚，输入/发送条永远钉在视口底部；
     dvh 让移动端键盘弹出时底栏跟着抬进可见区而不是被顶出屏幕 */
  body { margin: 0; display: grid; grid-template-columns: 268px 1fr;
         height: 100vh; height: 100dvh; overflow: hidden;
         background: var(--paper); color: var(--ink);
         font-family: var(--sans); font-size: 14px; line-height: 1.75; }
  ::selection { background: var(--accent-soft); }
  button, input, textarea { font-family: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ── 左栏：档头 ── */
  aside { display: flex; flex-direction: column; gap: 26px; min-height: 0;
          padding: 24px 20px 18px; border-right: 1px solid var(--rule);
          overflow-y: auto; }
  .mast h1 { margin: 0; font-family: var(--kai); font-weight: 400;
             font-size: 23px; color: var(--accent); letter-spacing: .5px; }
  .sec h2 { display: flex; justify-content: space-between; align-items: baseline;
            margin: 0 0 10px; padding-bottom: 6px;
            font-family: var(--mono); font-size: 10.5px; font-weight: 600;
            letter-spacing: .18em; color: var(--ink-3);
            border-bottom: 1px solid var(--rule); }
  .sec h2 span { letter-spacing: .04em; font-weight: 400; }
  .mastbtns { display: flex; gap: 8px; }
  .mastbtns .tbtn.primary { flex: 1; background: var(--accent);
                            border-color: var(--accent); color: var(--card);
                            font-weight: 600; letter-spacing: .12em; }
  .mastbtns .tbtn.primary:hover { background: var(--accent-deep);
                                  border-color: var(--accent-deep); color: #fff; }
  .foot-btn { margin-top: auto; width: 100%; }

  /* 会话档案列表：标题 + 时间元数据，行尾常驻半透明删除钮 */
  .sess { list-style: none; margin: 0; padding: 0; }
  .sess li { display: grid; grid-template-columns: 1fr 18px; column-gap: 6px;
             padding: 7px 8px 7px 10px; border-left: 2px solid transparent;
             cursor: pointer; }
  .sess li:hover { background: var(--card); }
  .sess li.on { border-left-color: var(--accent); background: var(--card); }
  .sess .st { font-size: 12.5px; color: var(--ink-2); overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; }
  .sess li.on .st { color: var(--ink); font-weight: 600; }
  .sess .sm { grid-column: 1; font-family: var(--mono); font-size: 9.5px;
              color: var(--ink-3); letter-spacing: .05em; }
  .sess .sx { grid-row: 1; grid-column: 2; justify-self: end; border: 0;
              background: none; color: var(--ink-3); opacity: .5;
              font-size: 11px; cursor: pointer; padding: 0 4px;
              transition: opacity .15s ease, color .15s ease; }
  .sess .sx:hover { opacity: 1; color: var(--accent); }
  .sess .snone { display: block; color: var(--ink-3); font-size: 12px;
                 padding: 4px 2px; cursor: default; }

  .tbtn { background: none; border: 1px solid var(--rule-2); color: var(--ink-2);
          font-size: 12.5px; padding: 5px 14px; border-radius: 2px;
          cursor: pointer; transition: border-color .15s ease, color .15s ease; }
  .tbtn:hover { border-color: var(--accent); color: var(--accent); }

  /* ── 右栏：正文 ── */
  main { display: flex; flex-direction: column; min-width: 0; min-height: 0;
         height: 100%; }
  .topbar { display: none; align-items: center; gap: 10px;
            padding: 10px 14px; border-bottom: 1px solid var(--rule);
            background: var(--paper); }
  .topbar .tb-title { font-family: var(--kai); font-size: 16px;
                      color: var(--accent); }
  .topbar .tbtn { margin-left: auto; padding: 4px 10px; font-size: 11.5px; }
  #log { flex: 1; min-height: 0; overflow-y: auto; padding: 38px 28px 28px; }
  .inner { max-width: 672px; margin: 0 auto; }

  /* 对话按「往来文书」排版：一行题注 + 正文，不做聊天气泡 */
  .turn { margin: 0 0 34px; }
  .cap { display: flex; align-items: baseline; gap: 10px; margin-bottom: 7px;
         font-family: var(--mono); font-size: 10px; letter-spacing: .14em;
         color: var(--ink-3); }
  .cap .who { font-weight: 600; letter-spacing: .28em; color: var(--ink-2); }
  .turn.user .cap .who { color: var(--accent-deep); }
  .turn.user .msg { border-left: 3px solid var(--accent); background: var(--card);
                    padding: 9px 16px; white-space: pre-wrap;
                    word-break: break-word; font-size: 14px; }
  .turn.bot .msg { font-size: 15px; line-height: 1.9; word-break: break-word; }
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
                  font-family: var(--mono); font-size: 11px;
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
  .tool .plabel { display: block; font-family: var(--mono); font-size: 9px;
                  letter-spacing: .2em; color: var(--ink-3);
                  margin-bottom: 3px; }
  .tool pre { margin: 0; padding: 6px 8px; background: var(--paper);
              border: 1px solid var(--rule); max-height: 160px;
              overflow: auto; font-family: var(--mono); font-size: 10.5px;
              line-height: 1.6; color: var(--ink-2);
              white-space: pre-wrap; word-break: break-all; }

  /* 成品文件下载行：工具卡片下方一枚「附件条」，与工具卡同宽同族 */
  .frow { display: flex; align-items: center; gap: 10px; margin-bottom: 9px;
          border: 1px solid var(--rule-2); background: var(--card);
          padding: 7px 12px; font-family: var(--mono); font-size: 11px;
          color: var(--ink-2); }
  .frow .fmark { flex: none; color: var(--accent); }
  .frow .fname { flex: 1; min-width: 0; overflow: hidden;
                 text-overflow: ellipsis; white-space: nowrap;
                 word-break: break-all; }
  .frow a.tbtn { flex: none; text-decoration: none; padding: 3px 14px;
                 font-size: 11.5px; }
  .frow a.tbtn:hover { background: var(--accent-soft); }

  /* 思考过程：独立建模成草稿卡片。与工具卡片同族但更轻（虚线框、无底色），
     内容用楷体灰字小一号——正文是系统黑体 15px，这里是 --kai 13px，两级层次
     一眼可分；长思考限高内部滚，不把屏幕撑满。 */
  .think { border: 1px dashed var(--rule-2); background: none; }
  .think summary { display: flex; align-items: center; gap: 9px;
                   padding: 4px 10px; cursor: pointer; list-style: none;
                   font-family: var(--mono); font-size: 9.5px;
                   letter-spacing: .18em; color: var(--ink-3); }
  .think summary::-webkit-details-marker { display: none; }
  .think summary:hover .tstat { color: var(--ink-2); }
  .think .tk { flex: none; color: var(--ink-3); }
  .think .tstat { flex: 1; min-width: 0; overflow: hidden;
                  text-overflow: ellipsis; white-space: nowrap;
                  letter-spacing: .04em; }
  .think .tdur { flex: none; letter-spacing: .04em; }
  .think .thbody { border-top: 1px dashed var(--rule); padding: 8px 12px 10px;
                   font-family: var(--kai); font-size: 13px; line-height: 1.95;
                   color: var(--ink-2); letter-spacing: .01em;
                   white-space: pre-wrap; word-break: break-word;
                   max-height: 300px; overflow: auto; }

  /* 兜底错误行（网络错误 / 中断这类非工具事件仍是等宽一行） */
  .tline { display: flex; gap: 8px; font-family: var(--mono); font-size: 11px;
           line-height: 1.7; padding: 2px 0; word-break: break-all; }
  .tline .mark { flex: none; width: 12px; }
  .tline.bad { color: var(--accent-deep); }
  .acts { margin-top: 9px; display: flex; gap: 8px; }
  .acts:empty { display: none; }
  .acts .tbtn { padding: 3px 12px; font-size: 11.5px; color: var(--ink-3);
                border-color: var(--rule); }

  /* ── 首屏：一张盖了章的空白纸 ── */
  .hero { padding: 13vh 8px 30px; text-align: center; }
  .hero .seal { position: relative; width: 92px; height: 92px;
                margin: 0 auto 22px; transform: rotate(-7deg); }
  .hero .seal::before { content: ""; position: absolute; inset: 0;
                        border: 2px solid var(--accent); border-radius: 50%;
                        opacity: .9; }
  .hero .seal::after { content: ""; position: absolute; inset: 6px;
                       border: 1px solid var(--accent); border-radius: 50%;
                       opacity: .45; }
  .hero .seal img { position: absolute; top: 11px; left: 11px;
                    width: 70px; height: 70px; border-radius: 50%;
                    object-fit: cover; }
  .hero h2 { margin: 0 0 10px; font-family: var(--kai); font-weight: 400;
             font-size: 30px; letter-spacing: 1px; }
  .hero p { margin: 0 auto; max-width: 430px; font-size: 13px;
            color: var(--ink-2); line-height: 2; }
  .hero .hint { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3);
                letter-spacing: .05em; }

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
  .md table { border-collapse: collapse; margin: 0.8em 0; font-size: 13px;
              display: block; overflow-x: auto; max-width: 100%;
              border: 1px solid var(--rule); background: var(--card); }
  .md th, .md td { border: 1px solid var(--rule); padding: 6px 12px;
                   text-align: left; }
  .md th { background: var(--shade); font-family: var(--mono); font-size: 11px;
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
  form { flex: none; border-top: 1px solid var(--rule); background: var(--paper);
         padding: 12px 28px 12px; }
  .quickbar { display: flex; align-items: center; gap: 10px;
              max-width: 672px; margin: 0 auto 8px; }
  .qlabel { flex: none; font-family: var(--mono); font-size: 9.5px;
            letter-spacing: .22em; color: var(--ink-3); }
  .qchips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { border: 1px solid var(--rule-2); background: var(--card);
          color: var(--ink-2); font-size: 12px; padding: 4px 12px;
          border-radius: 2px; cursor: pointer;
          transition: border-color 0.15s ease, color 0.15s ease; }
  .chip:hover { border-color: var(--accent); color: var(--accent); }
  .composer { max-width: 672px; margin: 0 auto; }
  .cwrap { display: flex; align-items: center; gap: 12px;
           background: var(--card); border: 1px solid var(--rule-2);
           border-radius: 3px; padding: 6px 7px 6px 16px;
           transition: border-color 0.15s ease, box-shadow 0.15s ease; }
  .cwrap:focus-within { border-color: var(--ink-3); }
  .clabel { flex: none; font-family: var(--kai); font-size: 16px;
            letter-spacing: 2px; color: var(--ink-3);
            border-right: 1px solid var(--rule); padding-right: 12px;
            align-self: stretch; display: flex; align-items: center;
            transition: color 0.15s ease; user-select: none; }
  .cwrap:focus-within .clabel { color: var(--accent); }
  textarea { flex: 1; background: none; border: 0; outline: none; resize: none;
             color: var(--ink); font-size: 14.5px; line-height: 1.6;
             padding: 6px 0; max-height: 180px; align-self: center; }
  textarea:focus-visible { outline: none; }  /* 聚焦态交给 .cwrap 描边表达，不叠红圈 */
  textarea::placeholder { color: var(--ink-3); }
  #b { flex: none; align-self: center; display: inline-flex;
       align-items: center; gap: 7px;
       border: 1px solid var(--accent); background: var(--accent);
       color: #FBFAF6; font-size: 13.5px; font-weight: 600; padding: 8px 18px;
       border-radius: 2px; cursor: pointer;
       transition: background 0.15s ease, color 0.15s ease,
                   border-color 0.15s ease, opacity 0.15s ease; }
  #b .kbd { font-family: var(--mono); font-size: 11px; opacity: .7; }
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
           font-size: 9.5px; letter-spacing: .14em; color: var(--ink-3); }

  /* ── 设置弹窗：一张盖了红头的办理单 ── */
  .overlay { position: fixed; inset: 0; z-index: 50;
             background: rgba(38, 35, 29, 0.42);
             display: grid; place-items: center; padding: 20px; }
  .overlay[hidden] { display: none; }
  .dlg { width: min(440px, 100%); background: var(--paper);
         border: 1px solid var(--rule-2);
         box-shadow: 0 18px 60px rgba(38, 35, 29, 0.28); }
  .dlg-head { display: flex; align-items: center; justify-content: space-between;
              padding: 14px 18px 8px; }
  .dlg-head span { font-family: var(--kai); font-size: 19px;
                   color: var(--accent); letter-spacing: 2px; }
  .dclose { border: 0; background: none; color: var(--ink-3);
            cursor: pointer; font-size: 13px; }
  .dclose:hover { color: var(--accent); }
  .dlg-rule { border-bottom: 2px solid var(--accent); margin: 0 18px; }
  .dlg-body { padding: 16px 18px 6px; }
  .fld-l { font-family: var(--mono); font-size: 9.5px; letter-spacing: .2em;
           color: var(--ink-3); padding-bottom: 5px; margin: 16px 0 10px;
           border-bottom: 1px solid var(--rule); }
  .fld-l:first-child { margin-top: 0; }
  .fld { display: grid; grid-template-columns: 72px 1fr; align-items: center;
         gap: 10px; margin: 8px 0; }
  .fld span { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3);
              letter-spacing: .1em; }
  .fld input { width: 100%; border: 1px solid var(--rule-2);
               background: var(--card); color: var(--ink);
               font-family: var(--mono); font-size: 12.5px; padding: 7px 10px;
               border-radius: 2px; outline: none; }
  .fld input:focus { border-color: var(--accent); }
  .cur { font-family: var(--mono); font-size: 10px; color: var(--ink-3);
         margin-left: 82px; letter-spacing: .04em; min-height: 14px; }
  .setnote { font-size: 11.5px; color: var(--ink-3); margin: 14px 0 2px;
             line-height: 1.8; }
  .setmsg { font-family: var(--mono); font-size: 11px; min-height: 16px;
            margin-top: 6px; white-space: pre-wrap; color: var(--accent-deep); }
  .setmsg.good { color: var(--ink-2); }
  .dlg-foot { display: flex; justify-content: flex-end; gap: 8px;
              padding: 12px 18px 16px; }
  .dlg-foot .tbtn.primary { background: var(--accent);
                            border-color: var(--accent); color: var(--card);
                            font-weight: 600; }
  .dlg-foot .tbtn.primary:hover { background: var(--accent-deep);
                                  border-color: var(--accent-deep); color: #fff; }
  .dlg-foot .tbtn:disabled { opacity: .5; cursor: default; }

  #toBottom { position: fixed; right: 30px; bottom: 104px; z-index: 5;
              background: var(--card); border: 1px solid var(--rule-2);
              color: var(--ink-2); font-size: 12px; padding: 6px 13px;
              border-radius: 2px; cursor: pointer;
              box-shadow: 0 2px 10px rgba(38, 35, 29, 0.08); }
  #toBottom[hidden] { display: none; }
  #toBottom:hover { border-color: var(--accent); color: var(--accent); }

  #log::-webkit-scrollbar, aside::-webkit-scrollbar { width: 10px; }
  #log::-webkit-scrollbar-thumb, aside::-webkit-scrollbar-thumb {
    background: var(--rule-2); border: 3px solid transparent;
    background-clip: content-box; border-radius: 5px; }
  #log::-webkit-scrollbar-thumb:hover, aside::-webkit-scrollbar-thumb:hover {
    background: var(--ink-3); background-clip: content-box; }
  #log::-webkit-scrollbar-track, aside::-webkit-scrollbar-track {
    background: transparent; }

  @media (max-width: 860px) {
    body { grid-template-columns: 1fr; }
    aside { display: none; }
    .topbar { display: flex; }
    #log { padding: 22px 16px; }
    form { padding: 10px 14px 10px; }
    .quickbar { margin-bottom: 7px; }
    .fhint { display: none; }
    #toBottom { right: 14px; bottom: 96px; }
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
    <h1>CourseRaptor</h1>
  </div>
  <div class="mastbtns">
    <button class="tbtn primary" id="newSession" title="另起一个会话（旧会话保留在档案里）">新会话</button>
  </div>
  <section class="sec">
    <h2>会话档案<span id="sessCount"></span></h2>
    <ul class="sess" id="sessList"></ul>
  </section>
  <button class="tbtn foot-btn" id="openSettings" title="教务账号与 API Key" ${demo ? "disabled" : ""}>设置</button>
</aside>
<main>
  ${demo ? '<div role="status" style="padding:12px 20px;background:var(--accent-soft);color:var(--accent);border-bottom:1px solid var(--rule)"><strong>离线演示 · 全部为虚构数据</strong><br>不连接教务或 AI，不保存到磁盘。请勿输入个人信息。正式使用请在终端运行 npm start。</div>' : ""}
  <div class="topbar">
    <span class="tb-title">CourseRaptor</span>
    <button class="tbtn" id="newSessionM">新会话</button>
    <button class="tbtn" id="openSettingsM" ${demo ? "disabled" : ""}>设置</button>
  </div>
  <div id="log"><div class="inner" id="inner">
    <div class="hero" id="hero">
      <div class="seal" aria-hidden="true"><img src="/logo.png" alt=""></div>
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
      <div class="cwrap">
        <span class="clabel" aria-hidden="true">留言</span>
        <textarea id="i" rows="1" aria-label="向 CourseRaptor 提问" placeholder="课表、成绩、考试、通知，直接问…"></textarea>
        <button id="b">发送<span class="kbd">⏎</span></button>
      </div>
      <div class="fhint">⏎ 发送 · ⇧⏎ 换行 · ${demo ? "虚构示例，会话仅保留在内存" : "会话自动存档"}</div>
    </div>
  </form>
</main>
<div class="overlay" id="overlay" hidden>
  <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
    <div class="dlg-head"><span id="dlgTitle">设置</span><button class="dclose" id="closeSettings" aria-label="关闭设置">✕</button></div>
    <div class="dlg-rule"></div>
    <div class="dlg-body">
      <div class="fld-l">教务系统</div>
      <label class="fld"><span>学号</span><input id="sUser" type="text" autocomplete="off"></label>
      <label class="fld"><span>密码</span><input id="sPass" type="password" autocomplete="new-password"></label>
      <div class="cur" id="curJwgl"></div>
      <div class="fld-l">模型服务</div>
      <label class="fld"><span>API KEY</span><input id="sKey" type="password" autocomplete="new-password"></label>
      <div class="cur" id="curKey"></div>
      <div class="setnote">留空即不修改。教务密码与 Key 仅 AES 加密保存在本机（credentials.enc），接口只回传脱敏摘要。</div>
      <div class="setmsg" id="setMsg"></div>
    </div>
    <div class="dlg-foot">
      <button class="tbtn" id="cancelSettings">取消</button>
      <button class="tbtn primary" id="saveSettings">保存</button>
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
let activeId = "";
let msgs = [];
let lastSessions = [];
function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } }
function lsSet(k, v) {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {}
}
activeId = lsGet(ACTIVE_KEY);
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

function addUser(text, ts) {
  const { sec, tm } = addTurn("user");
  tm.textContent = clock(ts || Date.now());
  sec.appendChild(el2("msg", text));
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
  if (!lastSessions.length) {
    const li = document.createElement("li");
    li.className = "snone";
    li.textContent = "暂无历史会话";
    sessList.appendChild(li);
    return;
  }
  lastSessions.forEach((s) => {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    if (s.id === activeId) li.className = "on";
    li.title = s.title || "新会话";
    li.appendChild(el2("st", s.title || "新会话"));
    const x = document.createElement("button");
    x.type = "button";
    x.className = "sx";
    x.dataset.del = s.id;
    x.title = "删除会话";
    x.textContent = "✕";
    li.appendChild(x);
    li.appendChild(el2("sm", fmtWhen(s.updatedAt) + " · " + s.count + " 条"));
    sessList.appendChild(li);
  });
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
      if (!msgs.length) { hero.style.display = ""; renderSessList(); return; }
      hero.style.display = "none";
      /* 重绘历史：渲染函数不写 msgs（它已是服务端数据的镜像） */
      msgs.forEach((m) => {
        if (m.role === "user") addUser(m.text, m.ts);
        else addBotMessage(m.text, m.ts, m.think);
      });
      scroll(true);
      renderSessList();
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
  const li = e.target.closest("li[data-id]");
  if (li && !busy) openSession(li.dataset.id);
});

async function doNewSession() {
  if (busy) return;
  /* 当前会话还没说过话：不重复建档，光标归位即可 */
  if (!msgs.length) { input.focus(); return; }
  startFresh();
}
document.getElementById("newSession").addEventListener("click", doNewSession);
document.getElementById("newSessionM").addEventListener("click", doNewSession);

/* ── 设置弹窗：教务账号 + DeepSeek API Key（后端走 /key 同一套加密热生效）── */
const overlay = document.getElementById("overlay");
const sUser = document.getElementById("sUser");
const sPass = document.getElementById("sPass");
const sKey = document.getElementById("sKey");
const setMsg = document.getElementById("setMsg");
let setStatus = null;
function showSettings() {
  overlay.hidden = false;
  setMsg.className = "setmsg";
  setMsg.textContent = "";
  sPass.value = ""; sKey.value = "";
  fetch("/api/settings").then((r) => r.json()).then((d) => {
    setStatus = d;
    sUser.value = "";
    sUser.placeholder = d.jwgl.username || "教务系统学号";
    sPass.placeholder = d.jwgl.configured ? "已保存，留空不修改" : "教务系统登录密码";
    document.getElementById("curJwgl").textContent = d.jwgl.configured
      ? "当前：学号 " + d.jwgl.username + "（" + d.jwgl.sourceLabel + "）"
      : "当前：未配置教务账号";
    document.getElementById("curKey").textContent = d.deepseek.configured
      ? "当前：" + (d.deepseek.masked || "已配置") + "（" + d.deepseek.sourceLabel + "）· 模型 " + d.model
      : "当前：未配置 API Key · 模型 " + d.model;
    sKey.placeholder = "sk-…（留空不修改）";
    (d.jwgl.configured ? sPass : sUser).focus();
  }).catch(() => { setMsg.textContent = "读取设置失败：本地服务没在跑？"; });
}
function hideSettings() { overlay.hidden = true; }
document.getElementById("openSettings").addEventListener("click", showSettings);
document.getElementById("openSettingsM").addEventListener("click", showSettings);
document.getElementById("closeSettings").addEventListener("click", hideSettings);
document.getElementById("cancelSettings").addEventListener("click", hideSettings);
overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) hideSettings(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !overlay.hidden) hideSettings();
});
document.getElementById("saveSettings").addEventListener("click", () => {
  const body = {};
  const u = sUser.value.trim(), pw = sPass.value, k = sKey.value.trim();
  if (pw) {
    /* 只改密码时自动带上现有学号，免得来回填 */
    body.jwglPassword = pw;
    body.jwglUsername = u || (setStatus && setStatus.jwgl.username) || "";
  } else if (u) {
    setMsg.className = "setmsg";
    setMsg.textContent = "只改学号不行：请连同新密码一起提交";
    return;
  }
  if (k) body.apiKey = k;
  if (!Object.keys(body).length) { hideSettings(); return; }
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
    if (ok) setTimeout(hideSettings, 900);
  }).catch(() => {
    saveBtn.disabled = false;
    setMsg.textContent = "保存失败：本地服务没在跑？";
  });
});

/* ── 启动：拉会话列表，进上次打开的会话（没有就进最近一个）── */
refreshSessions().then(() => {
  const pick = lastSessions.find((s) => s.id === activeId) || lastSessions[0];
  if (pick) return openSession(pick.id);
  activeId = "";
  lsSet(ACTIVE_KEY, "");
  renderSessList();
});

/* QQ 那边的对话也写进同一份档案，光靠启动拉一次要重开页面才看得见。
   定时补一次列表：正在回复（busy）不打断，标签页在后台（hidden）不刷 */
setInterval(() => {
  if (!busy && !document.hidden) refreshSessions();
}, 20000);

async function send(text) {
  if (!text || busy) return;
  busy = true;
  lastPrompt = text;
  hero.style.display = "none";
  const t0 = Date.now();
  msgs.push({ role: "user", text, ts: t0 });
  addUser(text, t0);
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
      body: JSON.stringify({ message: text, sessionId: activeId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "HTTP " + res.status);
    }
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
  btn.disabled = !busy && !input.value.trim();
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
  const text = input.value.trim();
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
