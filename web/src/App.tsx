import { useRef, useState, type ReactNode } from 'react'

// 固定演示文本不接受外部输入，也不调用教务系统或模型服务。
type ExampleKey = 'schedule' | 'credits' | 'calendar'

const ANSWERS: Record<ExampleKey, { question: string; body: ReactNode }> = {
  schedule: {
    question: '这周有什么课？',
    body: (
      <>
        <h3>这一周，先帮你整理好了。</h3>
        <div className="schedule-row"><span>周一<small>1–2 节</small></span><div>示例高等数学<small>示例教学楼 101</small></div></div>
        <div className="schedule-row"><span>周三<small>3–4 节</small></span><div>示例大学英语<small>示例教学楼 202</small></div></div>
        <div className="schedule-row"><span>周五<small>7–8 节</small></span><div>示例程序设计<small>示例机房</small></div></div>
        <p className="answer-note">以上全部为虚构数据。正式查询会结合你的教学周和已记录的调休安排。</p>
      </>
    ),
  },
  credits: {
    question: '通识修了哪些类别？',
    body: (
      <>
        <h3>先按已通过的课程，帮你汇总。</h3>
        <div className="schedule-row"><span>人文类</span><div>2 学分<small>虚构示例 · 已通过</small></div></div>
        <div className="schedule-row"><span>自然类</span><div>2 学分<small>虚构示例 · 已通过</small></div></div>
        <div className="schedule-row"><span>艺术类</span><div>0 学分<small>虚构示例 · 尚未覆盖</small></div></div>
        <p className="answer-note">未通过和待出分课程不计已获学分。类别覆盖不等于满足最低学分，具体要求请对照本人培养方案。</p>
      </>
    ),
  },
  calendar: {
    question: '怎么导入手机日历？',
    body: (
      <>
        <h3>三步，把安排放进口袋里。</h3>
        <ol><li>在正式助手里提问：把本学期课表和考试导出为 .ics 文件。</li><li>生成后，从本地网页对话中下载日历文件。</li><li>导入你的手机日历；安排变更后重新导出与同步。</li></ol>
        <p className="answer-note">这里仅展示操作说明，没有生成或公开任何文件。自动订阅需要另行配置发布渠道，当前订阅源公开可见。</p>
      </>
    ),
  },
}

const EXAMPLE_KEYS: ExampleKey[] = ['schedule', 'credits', 'calendar']

const START_COMMANDS = 'npm ci\nnpm run doctor\nnpm run demo'

function App() {
  const [example, setExample] = useState<ExampleKey>('schedule')
  const [copyStatus, setCopyStatus] = useState('')
  const commandsRef = useRef<HTMLElement>(null)

  async function copyCommands() {
    try {
      await navigator.clipboard.writeText(START_COMMANDS)
      setCopyStatus('已复制，在解压后的项目目录运行即可。')
    } catch {
      setCopyStatus('浏览器未允许复制，请选中上方三条命令手动复制。')
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
        <div className="ribbon"><div className="wrap ribbon-inner"><span>课程与地点</span><span aria-hidden="true">✳</span><span>成绩与学分</span><span aria-hidden="true">✳</span><span>通知与附件</span><span aria-hidden="true">✳</span><span>考试与日历</span></div></div>
        <section className="section wrap" id="features" aria-labelledby="features-title">
          <div className="section-head"><div><p className="eyebrow">01 / LESS SEARCHING, MORE LIVING</p><h2 id="features-title">你的问题，<br />小恐龙来接。</h2></div><p>从“去哪上课”到“导入手机日历”，<br />让零散的教务信息，在同一个对话里变清楚。</p></div>
          <div className="feature-grid">
            <article className="feature feature-wide"><span className="feature-number">01 — 日程</span><h3>下一节课，<br />不用翻来翻去。</h3><p>按学期与教学周查询课表，整理节次、地点和单双周。已记录的放假与调休安排也一起考虑。</p><div className="prompt-pill">“这周的课，按天帮我整理一下。”</div><span className="feature-symbol" aria-hidden="true">↗</span></article>
            <article className="feature"><span className="feature-number">02 — 学业</span><h3>学分有数，<br />心里有底。</h3><p>查看 GPA、已获学分、未通过与待确认课程。通识分类辅助核对，具体要求以本人培养方案为准。</p><div className="prompt-pill">“哪些课还需要我留意？”</div></article>
            <article className="feature"><span className="feature-number">03 — 考试</span><h3>把安排理清，<br />给复习留时间。</h3><p>查询考试日期、时间、考场与座位信息，再导出到手机日历。变更后请重新核对和同步。</p><div className="prompt-pill">“最近有什么考试？”</div></article>
            <article className="feature"><span className="feature-number">04 — 通知</span><h3>长通知，<br />先读与你有关的。</h3><p>从列表读到正文和附件，按你的问题提取行动要点。保留原文入口，重要日期随时核对。</p><div className="prompt-pill">“这条通知需要我做什么？”</div></article>
            <article className="feature"><span className="feature-number">05 — 材料</span><h3>从一份材料，<br />到一份成品。</h3><p>读取文档、查询表格、辅助整理内容，生成 Word、Excel、PPT 或 PDF 后，在网页直接下载。</p><div className="prompt-pill">“把这份材料整理成文档。”</div></article>
          </div>
          <a className="text-link" href="https://github.com/Health-525/courseraptor/blob/main/docs/capabilities.md">查看完整能力与使用边界 <span aria-hidden="true">↗</span></a>
        </section>
        <section className="try-section" id="try" aria-labelledby="try-title"><div className="wrap try-grid">
          <div><p className="eyebrow">02 / JUST ASK</p><h2 id="try-title">像问同学一样，<br />直接问它。</h2><p className="muted">点一个问题，看看回答的样子。</p><div className="question-list" aria-label="选择示例问题">{EXAMPLE_KEYS.map((key) => (
            <button key={key} type="button" aria-pressed={example === key} onClick={() => setExample(key)}>{ANSWERS[key].question}<span aria-hidden="true">↗</span></button>
          ))}</div><p className="small muted">这里只展示虚构示例，不连接教务系统或 AI。<br />真实的本地离线演示见下方开始使用。</p></div>
          <div className="conversation"><div className="conversation-top"><span><span className="status-dot"></span> CourseRaptor</span><span>示例预览</span></div><p className="question" id="example-question">{ANSWERS[example].question}</p><div className="answer" id="example-answer" aria-live="polite" aria-atomic="true"><p className="answer-label">🦖 小恐龙</p>{ANSWERS[example].body}</div><div className="conversation-bottom">查询 · 整理 · 继续追问 <span aria-hidden="true">✦</span></div></div>
        </div></section>
        <section className="section wrap product" aria-labelledby="product-title"><div className="section-head"><div><p className="eyebrow">03 / ON YOUR OWN DESK</p><h2 id="product-title">熟悉的浏览器，<br />自己的教务助手。</h2></div><p>常用提问一键开始，对话归档方便回看。<br />正式模式支持下载日历和生成的文档。</p></div><figure><div className="window-bar"><span aria-hidden="true">● ● ●</span><span>CourseRaptor · 本周课表</span><span aria-hidden="true">↗</span></div><img src="/screenshot-demo.jpg" alt="CourseRaptor 真实网页界面：本周课表，以及待办与知识卡片" width="1264" height="1732" loading="lazy" /><figcaption>真实应用截图（课表页 /today），全部为虚构演示数据。宣传插画与产品界面分别展示。</figcaption></figure></section>
        <section className="start-section" id="start" aria-labelledby="start-title"><div className="wrap start-grid"><div><p className="eyebrow">04 / YOUR FIRST CONVERSATION</p><h2 id="start-title">三条命令，<br />认识小恐龙。</h2><p>先体验，再决定要不要配置。<br />演示无需教务账号、API Key，也不会调用 AI。</p><a className="button primary" href="https://github.com/Health-525/courseraptor/archive/refs/heads/main.zip">下载项目源码 <span aria-hidden="true">↓</span></a><p className="small muted">这是源码压缩包，需先安装 Node.js 24 或更高版本。</p></div><div className="setup"><ol><li><span>1</span><div><h3>准备好运行环境</h3><p>安装 <a href="https://nodejs.org/zh-cn/download">Node.js 24+ ↗</a>，下载项目并解压。</p></div></li><li><span>2</span><div><h3>在项目目录打开终端</h3><div className="codebox"><div><span>Terminal</span><button type="button" id="copy-command" onClick={copyCommands}>复制命令</button></div><pre><code id="commands" ref={commandsRef}>{START_COMMANDS}</code></pre></div><p id="copy-status" className="small" role="status">{copyStatus}</p></div></li><li><span>3</span><div><h3>打开终端显示的地址</h3><p>默认 <code>http://127.0.0.1:3211</code>，点击常用问题即可体验。完成后按 Ctrl+C 退出。</p></div></li></ol><div className="next-step">准备正式使用？运行 <code>npm start</code>，Windows 也可双击 <code>start.bat</code>，按提示配置自己的教务账号与 DeepSeek API Key。<a href="https://github.com/Health-525/courseraptor/blob/main/docs/student-guide.md">阅读同学使用指南 ↗</a></div></div></div></section>
        <section className="section wrap faq" aria-labelledby="faq-title"><div><p className="eyebrow">BEFORE YOU START</p><h2 id="faq-title">先说清楚，<br />用起来更安心。</h2></div><div className="faq-list"><details><summary>这是学校官方产品吗？</summary><p>不是。CourseRaptor 是非官方开源项目，当前适配南京工业大学，适合在个人电脑上自用，没有学校官方隶属或背书。</p></details><details><summary>使用需要付费吗？数据会发到哪里？</summary><p>项目以 ISC 许可证开源。离线演示不调用 AI；正式对话会把提问与所需查询结果发送到配置的模型服务，可能产生 API 费用。教务凭证保存在你自己的电脑，请勿分享已使用的项目目录。</p></details><details><summary>手机能直接打开这个网页查教务吗？</summary><p>这个网站是项目介绍页，不是在线教务服务。正式助手运行在你的电脑上；可把生成的 .ics 日历文件导入手机，或自行配置公开的 GitHub / Gitee 订阅源。公开订阅可能暴露课程与地点，发布前需确认。</p></details><details><summary>会自动提醒我，或帮我自动选课吗？</summary><p>目前没有通用后台主动提醒。今日日程、截止提醒和变更提示在路线图中；真实选课功能默认关闭，具体行为与限制见能力说明。</p></details><details><summary>安装遇到问题，去哪里反馈？</summary><p>先运行 <code>npm run doctor</code> 检查运行前提，再看同学使用指南。可复现错误请提交 <a href="https://github.com/Health-525/courseraptor/issues/new/choose">Issue</a>，使用想法可到 <a href="https://github.com/Health-525/courseraptor/discussions">Discussions</a> 交流。请勿上传学号、成绩单、密码、API Key 或完整日志。</p></details></div></section>
        <section className="community wrap"><p className="eyebrow">BUILT IN THE OPEN</p><h2>让更多同学，<br />遇见小恐龙。</h2><p>如果它帮你省下了一点时间，欢迎给个 Star，<br />也欢迎把真实需求带回来，一起让它更好用。</p><div className="actions"><a className="button primary" href="https://github.com/Health-525/courseraptor">去 GitHub 看看 <span aria-hidden="true">↗</span></a><a className="button ghost" href="https://github.com/Health-525/courseraptor/discussions">聊聊你的想法 <span aria-hidden="true">↗</span></a></div><a className="text-link" href="https://github.com/Health-525/courseraptor/blob/main/docs/roadmap.md">下一站：今日日程 · 截止提醒 · 变更提示 →</a></section>
      </main>
      <footer className="wrap footer"><a className="brand" href="#">CourseRaptor<span>🦖</span></a><span>Made for students. Built in the open.</span><div><a href="https://github.com/Health-525/courseraptor/blob/main/LICENSE">ISC License</a><a href="https://github.com/Health-525/courseraptor/blob/main/SECURITY.md">安全说明</a><a href="https://github.com/Health-525/courseraptor/blob/main/README.en.md" lang="en">English docs ↗</a></div></footer>
    </>
  )
}

export default App
