import { useRef, useState, type ReactNode } from 'react'

// 固定演示文本不接受外部输入，也不调用教务系统或模型服务。
type ExampleKey = 'schedule' | 'exam' | 'memory'

const ANSWERS: Record<ExampleKey, { question: string; body: ReactNode }> = {
  schedule: {
    question: '这周有什么课？',
    body: (
      <>
        <h3>这一周，先帮你整理好了。</h3>
        <div className="schedule-row"><span>周一<small>1–2 节</small></span><div>示例高等数学<small>示例教学楼 101</small></div></div>
        <div className="schedule-row"><span>周三<small>3–4 节</small></span><div>示例大学英语<small>示例教学楼 202</small></div></div>
        <div className="schedule-row"><span>周五<small>7–8 节</small></span><div>示例程序设计<small>示例机房</small></div></div>
        <p className="answer-note">以上全部为虚构数据。正式查询会自动登录教务、按教学周整理，并叠加已记录的放假与调休安排。</p>
      </>
    ),
  },
  exam: {
    question: '下周三有考试吗？加到手机日历。',
    body: (
      <>
        <h3>查到了，日历和提醒一并办好。</h3>
        <div className="schedule-row"><span>示例高等数学<small>第 13 周 · 周三</small></span><div>14:00–16:00<small>示例教学楼 A301 · 045 号</small></div></div>
        <div className="schedule-row"><span>示例大学英语<small>第 14 周 · 周一</small></span><div>09:00–11:00<small>示例教学楼 B102 · 118 号</small></div></div>
        <p className="answer-note">虚构数据演示。正式使用时，登录教务、查考试、导出 .ics、设提醒由 Agent 一次链式完成，考前一天主动提醒你。</p>
      </>
    ),
  },
  memory: {
    question: '上次说的报销截止是哪天来着？',
    body: (
      <>
        <h3>从记忆里帮你找到了。</h3>
        <div className="schedule-row"><span>长期记忆<small>生活委员通知</small></span><div>9 月 30 日截止<small>虚构示例 · 已归档</small></div></div>
        <div className="schedule-row"><span>会话上下文<small>周三聊到</small></span><div>教材费报销<small>虚构示例 · 可续聊追问</small></div></div>
        <p className="answer-note">虚构数据演示。短期会话跨重启续聊，长期事实自主沉淀与更新，越用越懂你。</p>
      </>
    ),
  },
}

const EXAMPLE_KEYS: ExampleKey[] = ['schedule', 'exam', 'memory']

const START_COMMANDS = 'npm install\nnpm run demo'

function App() {
  const [example, setExample] = useState<ExampleKey>('schedule')
  const [copyStatus, setCopyStatus] = useState('')
  const commandsRef = useRef<HTMLElement>(null)

  async function copyCommands() {
    try {
      await navigator.clipboard.writeText(START_COMMANDS)
      setCopyStatus('已复制，在解压后的源码目录运行即可。')
    } catch {
      setCopyStatus('浏览器未允许复制，请选中上方命令手动复制。')
      const node = commandsRef.current
      if (node) {
        const range = document.createRange()
        range.selectNodeContents(node)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
    }
  }

  return (
    <>
      <a className="skip" href="#main">跳到正文</a>
      <header className="header wrap">
        <a className="brand" href="#" aria-label="CourseRaptor 首页"><img src="/courseraptor-logo.png" alt="" width="36" height="36" />CourseRaptor<span className="brand-tag">FOR NJTECH</span></a>
        <nav aria-label="主导航"><a href="#features">能做什么</a><a href="#try">看看示例</a><a href="#start">开始使用</a><a className="github-link" href="https://github.com/Health-525/courseraptor">GitHub ↗</a></nav>
      </header>
      <main id="main">
        <section className="hero wrap" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow"><span className="status-dot"></span> 为南工同学打造 · 开源 · 个人电脑运行</p>
            <h1 id="hero-title">教务琐事，<br /><em>一句话。</em></h1>
            <p className="hero-desc">早八在哪上，通识修了哪些，考试什么时候。<br />把反复翻找的时间，留给更想做的事。</p>
            <div className="actions"><a className="button primary" href="#start">认识你的小恐龙 <span aria-hidden="true">↗</span></a><a className="button ghost" href="#try">先看看它怎么答 <span aria-hidden="true">↓</span></a></div>
            <p className="hero-note">无需账号即可体验离线演示。正式查询需自行配置教务账号与模型 API Key。</p>
          </div>
          <div className="hero-art">
            <div className="mascot-frame"><img src="/courseraptor-logo.png" alt="戴着眼镜的绿色小恐龙 CourseRaptor" width="1254" height="1254" fetchPriority="high" /></div>
            <div className="floating-note note-top"><span aria-hidden="true">✦</span><div>教务里的小事<br /><strong>交给我就好。</strong></div></div>
            <div className="floating-note note-bottom"><span className="status-dot"></span> Web / CLI / 可选 QQ</div>
            <span className="art-label">YOUR CAMPUS SIDEKICK / 01</span>
          </div>
        </section>
        <div className="ribbon"><div className="wrap ribbon-inner"><span>课表与考试</span><span aria-hidden="true">✳</span><span>成绩与学籍</span><span aria-hidden="true">✳</span><span>通知与待办</span><span aria-hidden="true">✳</span><span>日历与知识库</span></div></div>
        <section className="section wrap screen" id="features" aria-labelledby="features-title">
          <div className="section-head"><div><p className="eyebrow">01 / LESS SEARCHING, MORE LIVING</p><h2 id="features-title">你说一句话，<br />小恐龙来办。</h2></div><p>不是又一个功能菜单，而是一位懂教务、会规划步骤、<br />记得住你的事的 Agent。</p></div>
          <div className="feature-grid">
            <article className="feature feature-wide"><span className="feature-number">01 — 对话即办事</span><h3>复合请求，<br />一次链式办完。</h3><p>自动理解意图、拆解步骤、调度 31 个内置工具——登录教务、查考试、导日历、设提醒一气呵成，不用自己拆成一次次查询与点击。</p><div className="prompt-pill">“下周三有考试吗？加到手机日历，考前提醒我。”</div><span className="feature-symbol" aria-hidden="true">↗</span></article>
            <article className="feature"><span className="feature-number">02 — 思考与记忆</span><h3>过程看得见，<br />越用越懂你。</h3><p>思考过程与工具调用全程可见，可追问、可纠正；两层记忆跨重启续聊、自主沉淀事实，待办到期主动找人提醒。</p><div className="prompt-pill">“上次聊的那个截止日期是哪天？”</div></article>
            <article className="feature"><span className="feature-number">03 — 三端随叫随到</span><h3>终端、网页、QQ，<br />同一份记忆。</h3><p>TUI、本地网页与 QQ 官方机器人共享同一 Agent 内核、31 个工具与记忆，在哪儿都能一句话办事。</p><div className="prompt-pill">“在哪儿都能找到我。”</div></article>
            <article className="feature"><span className="feature-number">04 — 通知替你读</span><h3>长通知，<br />先读与你有关的。</h3><p>按年级自动标注相关度，附件 Excel 结构化筛选，长文分页续读；关键日期藏在附件里也会被拎出来提醒你。</p><div className="prompt-pill">“这条通知需要我做什么？”</div></article>
            <article className="feature"><span className="feature-number">05 — 数据不出本机</span><h3>凭证加密，<br />隐私优先。</h3><p>教务账号与 API Key 以 AES-256-GCM 加密保存在本机，开源可审计；无需服务器，也不用向任何第三方交出密码。</p><div className="prompt-pill">“Local-first · 开源可审计”</div></article>
          </div>
        </section>
        <section className="section capability-band screen" aria-label="全景能力清单">
          <div className="wrap">
            <div className="capability-panel">
              <div className="capability-head">
                <div>
                  <p className="eyebrow">FULL TOOLBELT / 全景能力</p>
                  <h3>31 个内置工具，十类校园事务，一套内核全包。</h3>
                </div>
                <p className="capability-note">全部功能在真实教务环境验证可用 · <a href="https://github.com/Health-525/courseraptor/blob/main/docs/capabilities.md">完整清单与使用边界 ↗</a></p>
              </div>
              <div className="capability-grid">
                <div className="capability"><span>教务查询 <em>×12</em></span><p>课表（自动叠加放假调休）、成绩与 GPA、考试安排、学籍打码、选课冲突只读对比、搜课与可重修。</p></div>
                <div className="capability"><span>通知情报 <em>×3</em></span><p>按年级标注相关度、正文全文、附件下载缓存＋Excel 结构化筛选＋长文分页续读。</p></div>
                <div className="capability"><span>文件与数据 <em>×4</em></span><p>本地文件读取、Excel 筛选查询、沙箱 JS 计算、附件缓存管理。</p></div>
                <div className="capability"><span>文档写作 <em>×2</em></span><p>Word / Excel / PPT / PDF 一句话生成，支持跨格式转换，网页直接下载。</p></div>
                <div className="capability"><span>时间日历天气 <em>×5</em></span><p>教学周时间、调休落盘、.ics 日历导出、日历发布订阅、天气与穿衣建议。</p></div>
                <div className="capability"><span>记忆与效率 <em>×4</em></span><p>两层记忆、待办双通道到期提醒、按课程归类的知识库、番茄钟。</p></div>
              </div>
            </div>
          </div>
        </section>
        <section className="try-section screen" id="try" aria-labelledby="try-title"><div className="wrap try-grid">
          <div><p className="eyebrow">02 / JUST ASK</p><h2 id="try-title">像问同学一样，<br />直接问它。</h2><p className="muted">点一个问题，看看回答的样子。</p><div className="question-list" aria-label="选择示例问题">{EXAMPLE_KEYS.map((key) => (
            <button key={key} type="button" aria-pressed={example === key} onClick={() => setExample(key)}>{ANSWERS[key].question}<span aria-hidden="true">↗</span></button>
          ))}</div><p className="small muted">这里只展示虚构示例，不连接教务系统或 AI。<br />真实的本地离线演示见下方开始使用。</p></div>
          <div className="conversation"><div className="conversation-top"><span><span className="status-dot"></span> CourseRaptor</span><span>示例预览</span></div><p className="question" id="example-question">{ANSWERS[example].question}</p><div className="answer" id="example-answer" aria-live="polite" aria-atomic="true"><p className="answer-label">🦖 小恐龙</p>{ANSWERS[example].body}</div><div className="conversation-bottom">查询 · 整理 · 继续追问 <span aria-hidden="true">✦</span></div></div>
        </div></section>
        <section className="section wrap product screen" aria-labelledby="product-title"><div className="section-head"><div><p className="eyebrow">03 / ON YOUR OWN DESK</p><h2 id="product-title">三种打开方式，<br />同一个助手。</h2></div><p>终端 TUI、本地网页与 QQ 机器人共享同一内核与记忆。<br />正式模式支持下载日历和生成的文档。</p></div>
          <div className="figure-grid">
            <figure><div className="window-bar"><span aria-hidden="true">● ● ●</span><span>CourseRaptor · 功能大厅</span><span aria-hidden="true">↗</span></div><img src="/screenshot-hall.png" alt="CourseRaptor 网页版功能大厅：知识卡与功能卡" width="2548" height="1402" loading="lazy" /><figcaption>网页版功能大厅（/hall），虚构演示数据。</figcaption></figure>
            <figure><div className="window-bar"><span aria-hidden="true">● ● ●</span><span>CourseRaptor · 终端 TUI</span><span aria-hidden="true">↗</span></div><img src="/screenshot-tui.png" alt="CourseRaptor 终端 TUI 首屏：今日课表、待办、考试与通知速览" width="2548" height="1402" loading="lazy" /><figcaption>终端 TUI 首屏（演示模式数据）。</figcaption></figure>
          </div>
        </section>
        <section className="start-section screen" id="start" aria-labelledby="start-title"><div className="wrap start-grid"><div><p className="eyebrow">04 / YOUR FIRST CONVERSATION</p><h2 id="start-title">五分钟，<br />认识小恐龙。</h2><p>先体验，再决定要不要配置。<br />演示无需教务账号、API Key，也不会调用 AI。</p><div className="actions"><a className="button primary" href="https://github.com/Health-525/courseraptor/releases/latest/download/courseraptor-v0.3.0-portable-win-x64.exe">下载 v0.3.0 单文件 exe · 112MB <span aria-hidden="true">↓</span></a><a className="button ghost" href="https://github.com/Health-525/courseraptor/releases">绿色 zip · 全部版本 <span aria-hidden="true">↗</span></a></div><p className="small muted">exe 双击即用、内置 Node 运行时；升级把新版 exe 放进原文件夹再双击即可，账号与数据不动。</p></div><div className="setup"><ol><li><span>1</span><div><h3>下载并启动</h3><p>最新版 <a href="https://github.com/Health-525/courseraptor/releases">v0.3.0（2026-09-26 发布）↗</a>：单文件 exe 双击即用，或绿色 zip 解压后双击 start.bat。</p></div></li><li><span>2</span><div><h3>按引导完成配置</h3><p>录入教务账号与 DeepSeek API Key，AES-256-GCM 加密保存在本机；开发者可克隆源码，免账号先跑离线演示。</p><div className="codebox"><div><span>Terminal</span><button type="button" id="copy-command" onClick={copyCommands}>复制命令</button></div><pre><code id="commands" ref={commandsRef}>{START_COMMANDS}</code></pre></div><p id="copy-status" className="small" role="status">{copyStatus}</p></div></li><li><span>3</span><div><h3>打开终端显示的地址</h3><p>网页版默认 <code>http://localhost:3210</code>；终端、网页都能用，QQ 机器人可选开启。</p></div></li></ol><div className="next-step">准备正式使用？按引导配置教务账号与 DeepSeek API Key 即可开始对话，日常成本个位数人民币。<a href="https://github.com/Health-525/courseraptor/blob/main/docs/student-guide.md">阅读同学使用指南 ↗</a></div></div></div></section>
        <section className="section wrap faq screen" aria-labelledby="faq-title"><div><p className="eyebrow">BEFORE YOU START</p><h2 id="faq-title">先说清楚，<br />用起来更安心。</h2></div><div className="faq-list"><details><summary>这是学校官方产品吗？</summary><p>不是。CourseRaptor 是非官方开源项目，当前适配南京工业大学，适合在个人电脑上自用，没有学校官方隶属或背书。</p></details><details><summary>使用需要付费吗？数据会发到哪里？</summary><p>项目以 ISC 许可证开源，安装与使用免费。离线演示不调用 AI；正式对话会把提问与所需查询结果发送到你配置的模型服务（DeepSeek），日常成本约个位数人民币每月。教务凭证 AES-256-GCM 加密保存在你自己的电脑，请勿分享已使用的项目目录。</p></details><details><summary>手机能直接打开这个网页查教务吗？</summary><p>这个网站是项目介绍页，不是在线教务服务。正式助手运行在你的电脑上；可把生成的 .ics 日历文件导入手机，或自行配置公开的 GitHub / Gitee 订阅源。公开订阅可能暴露课程与地点，发布前需确认。</p></details><details><summary>会自动提醒我，或帮我自动选课吗？</summary><p>待办与关键日期支持桌面通知 + QQ 双通道主动提醒；考试、放假等日程可导出日历订阅。真实选课等写操作默认关闭，仅保留只读对比工具，具体行为与限制见能力说明。</p></details><details><summary>安装遇到问题，去哪里反馈？</summary><p>先看同学使用指南与仓库 README 的部署说明。可复现错误请提交 <a href="https://github.com/Health-525/courseraptor/issues/new/choose">Issue</a>，使用想法可到 <a href="https://github.com/Health-525/courseraptor/discussions">Discussions</a> 交流。请勿上传学号、成绩单、密码、API Key 或完整日志。</p></details></div></section>
        <section className="community wrap screen"><p className="eyebrow">BUILT IN THE OPEN</p><h2>让更多同学，<br />遇见小恐龙。</h2><p>如果它帮你省下了一点时间，欢迎给个 Star，<br />也欢迎把真实需求带回来，一起让它更好用。</p><div className="actions"><a className="button primary" href="https://github.com/Health-525/courseraptor">去 GitHub 看看 <span aria-hidden="true">↗</span></a><a className="button ghost" href="https://github.com/Health-525/courseraptor/discussions">聊聊你的想法 <span aria-hidden="true">↗</span></a></div><a className="text-link" href="https://github.com/Health-525/courseraptor/blob/main/docs/roadmap.md">下一站：今日日程 · 截止提醒 · 变更提示 →</a></section>
      </main>
      <footer className="wrap footer"><a className="brand" href="#">CourseRaptor<span>🦖</span></a><span>Made for students. Built in the open.</span><div><a href="https://github.com/Health-525/courseraptor/blob/main/LICENSE">ISC License</a><a href="https://github.com/Health-525/courseraptor/blob/main/SECURITY.md">安全说明</a><a href="https://github.com/Health-525/courseraptor/blob/main/README.en.md" lang="en">English docs ↗</a></div></footer>
    </>
  )
}

export default App
