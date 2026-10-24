import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { setupLandingMotion } from './motion'
import logoHeader from './assets/logo-header.webp'
import logoHero from './assets/logo-hero.webp'
import heroOverview from './assets/hero-overview.webp'
import panelToday from './assets/panel-today.webp'
import panelSchedule from './assets/panel-schedule.webp'
import panelTodos from './assets/panel-todos.webp'
import panelKnowledge from './assets/panel-knowledge.webp'

// 固定演示文本不接受外部输入，也不调用教务系统或模型服务。
type ExampleKey = 'schedule' | 'calendar' | 'memory'

const ANSWERS: Record<ExampleKey, { question: string; steps: string[]; body: ReactNode }> = {
  schedule: {
    question: '这周有什么课？',
    steps: ['读取本地课表', '定位教学周', '叠加放假调休'],
    body: (
      <>
        <h3>这一周，先帮你整理好了。</h3>
        <div className="schedule-row"><span>周一<small>1–2 节</small></span><div>示例高等数学<small>示例教学楼 101</small></div></div>
        <div className="schedule-row"><span>周三<small>3–4 节</small></span><div>示例大学英语<small>示例教学楼 202</small></div></div>
        <div className="schedule-row"><span>周五<small>7–8 节</small></span><div>示例程序设计<small>示例机房</small></div></div>
        <p className="answer-note">以上全部为虚构数据。正式使用时，导入的课表按教学周整理，自动叠加放假与调休，驱动今日页、周课表与日历导出。</p>
      </>
    ),
  },
  calendar: {
    question: '把这学期课表加进手机日历。',
    steps: ['读取学期课表', '叠加放假调休', '生成 .ics 日历'],
    body: (
      <>
        <h3>导出好了，导入手机就能看。</h3>
        <div className="schedule-row"><span>周一<small>1–2 节</small></span><div>示例高等数学<small>示例教学楼 101</small></div></div>
        <div className="schedule-row"><span>周三<small>3–4 节</small></span><div>示例大学英语<small>示例教学楼 202</small></div></div>
        <p className="answer-note">虚构数据演示。课表导入后整学期 .ics 一键导出，放假与调休自动叠加，导入支持 .ics 的日历 App 即可；待办也能单独导出。</p>
      </>
    ),
  },
  memory: {
    question: '上次说的报销截止是哪天来着？',
    steps: ['检索长期记忆', '定位相关事实', '核对会话上下文'],
    body: (
      <>
        <h3>从记忆里帮你找到了。</h3>
        <div className="schedule-row"><span>长期记忆<small>生活委员通知</small></span><div>9 月 30 日截止<small>虚构示例 · 已归档</small></div></div>
        <div className="schedule-row"><span>会话上下文<small>周三聊到</small></span><div>教材费报销<small>虚构示例 · 可续聊追问</small></div></div>
        <p className="answer-note">虚构数据演示。在当前会话中继续追问，也可保存长期事实，供之后查询和更新。</p>
      </>
    ),
  },
}

const EXAMPLE_KEYS: ExampleKey[] = ['schedule', 'calendar', 'memory']

const RELEASES_LATEST = 'https://github.com/Health-525/courseraptor/releases/latest'

const START_COMMANDS = ['git clone https://github.com/Health-525/courseraptor.git', 'cd courseraptor', 'npm ci', 'npm run demo']

function App() {
  const [example, setExample] = useState<ExampleKey>('schedule')
  const [copyStatus, setCopyStatus] = useState('')
  const [copied, setCopied] = useState(false)
  const commandsRef = useRef<HTMLElement>(null)

  async function copyCommands() {
    try {
      await navigator.clipboard.writeText(START_COMMANDS.join('\n'))
      setCopied(true)
      setCopyStatus('已复制；需要 Node.js 24+ 和 Git，在终端运行即可。')
      window.setTimeout(() => setCopied(false), 2000)
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

  // 滚动编排：首屏滑动驱动（便利贴揭走、恐龙后退）与便签墙区块出场由 GSAP 接管；减少动态时不安装。
  useLayoutEffect(() => setupLandingMotion(), [])

  // 吸顶导航滚动态：离开顶部后投影加深、内距收紧。
  useEffect(() => {
    const header = document.querySelector('.header')
    if (!header) return
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // 导航当前分区高亮：区块中心过视口中线时点亮对应锚链接。
  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>('main section[id]')
    const links = document.querySelectorAll<HTMLAnchorElement>('.header nav a[href^="#"]')
    if (!sections.length || !links.length) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          links.forEach((a) => a.classList.remove('active'))
          const id = entry.target.getAttribute('id')
          document.querySelector(`.header nav a[href="#${id}"]`)?.classList.add('active')
        }
      },
      { rootMargin: '-45% 0px -50% 0px' },
    )
    sections.forEach((s) => observer.observe(s))
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <a className="skip" href="#main">跳到正文</a>
      <header className="header"><div className="wrap header-inner">
        <a className="brand" href="#" aria-label="CourseRaptor 首页"><img src={logoHeader} alt="" width="36" height="36" />CourseRaptor</a>
        <nav aria-label="主导航"><a href="#features">能做什么</a><a href="#try">看看示例</a><a href="#start">开始使用</a><a href="#faq">常见问题</a><a className="github-link" href="https://github.com/Health-525/courseraptor">GitHub ↗</a><a className="nav-download" href={RELEASES_LATEST}>下载</a></nav></div>
      </header>
      <main id="main">
        <section className="hero wrap" aria-labelledby="hero-title">
          <p className="eyebrow"><span className="status-dot"></span> 大学生的开源 AI 课表与待办助手</p>
          <div className="hero-head">
            <div>
              <h1 id="hero-title">导入课表，<span className="hl">开口就问。</span></h1>
              <p className="hero-desc">这周在哪上课，周五要交什么——用一句话查课、记待办，整理自己的本周安排。</p>
            </div>
            <div className="hero-cta">
              <div className="actions"><a className="button primary" href={RELEASES_LATEST}>下载 Windows 版 <span aria-hidden="true">↓</span></a><a className="button ghost" href="#try">先看看它怎么答 <span aria-hidden="true">↓</span></a></div>
              <ul className="hero-facts" aria-label="项目要点"><li>MIT 开源</li><li>记录存在本机</li><li>模型自己选</li></ul>
            </div>
          </div>
          <figure className="hero-shot">
            <span className="photo-pin pin-l" aria-hidden="true"></span>
            <span className="photo-pin pin-r" aria-hidden="true"></span>
            <img src={heroOverview} alt="CourseRaptor 当前主界面与右侧功能大厅，使用隔离的虚构示例数据" width="1600" height="1000" fetchPriority="high" />
            <span className="hero-sticker" aria-hidden="true"><img src={logoHero} alt="" width="840" height="840" /></span>
            <aside className="shot-tag tag-a"><span className="tape" aria-hidden="true"></span><b>先查课表</b>课程、时间和地点，按教学周整理</aside>
            <aside className="shot-tag tag-b"><span className="tape" aria-hidden="true"></span>说出截止日期，保存后在<b>待办里核对</b></aside>
            <aside className="shot-tag tag-c"><span className="tape" aria-hidden="true"></span>功能大厅<b>在右侧栏打开</b></aside>
          </figure>
          <p className="hero-note-fine">截图为当前源码界面与虚构示例数据，未调用 AI。记录本地保存 · 自选模型 · 正式 AI 对话需自备 API Key，相关内容会发送到模型服务，可能产生费用</p>
        </section>
        <div className="tape-band" aria-hidden="true"><div className="wrap tape-inner"><span>查本周课程</span><span>✳</span><span>记截止待办</span><span>✳</span><span>整理今日安排</span><span>✳</span><span>保存学习记录</span></div></div>
        <section className="section wrap screen" id="features" aria-labelledby="features-title">
          <div className="section-head"><div><p className="eyebrow">01 / LESS SEARCHING, MORE LIVING</p><h2 id="features-title">你说一句话，<br />小恐龙来办。</h2></div><p>课表和截止日期不用来回翻，<br />先把这两件小事交给同一个助手。</p></div>
          <div className="wall">
            <div className="sticky-wrap"><article className="sticky sticky-yellow"><span className="tape" aria-hidden="true"></span><span className="sticky-no">01</span><h3>先把课表导进来</h3><p>粘贴课表文字或上传文件，逐行核对后保存。之后按教学周查询课程、时间和地点。</p><p className="ask">“这周周三有哪些课？在哪上？”</p></article></div>
            <div className="sticky-wrap"><article className="sticky sticky-white"><span className="tape" aria-hidden="true"></span><span className="sticky-no">02</span><h3>说出截止事项</h3><p>把事项和截止时间说清楚，保存后可查询、修改或标记完成；程序运行时按规则提醒。</p><p className="ask">“周五下午三点前交实验报告。”</p></article></div>
            <div className="sticky-wrap"><article className="sticky sticky-green"><span className="tape" aria-hidden="true"></span><span className="sticky-no">03</span><h3>整理今天的安排</h3><p>结合你已导入的课表和已保存的待办回答，在功能大厅检查具体记录。</p><p className="ask">“今天有哪些课，还有什么没做？”</p></article></div>
            <div className="sticky-wrap"><article className="sticky sticky-white"><span className="tape" aria-hidden="true"></span><span className="sticky-no">04</span><h3>留下学习记录</h3><p>把知识点按课程保存，之后再查询或修改；也可读取 PDF、Word 与表格材料。</p><p className="ask">“把这个知识点记到高等数学。”</p></article></div>
            <div className="sticky-wrap"><article className="sticky sticky-green"><span className="tape" aria-hidden="true"></span><span className="sticky-no">05</span><h3>记录本地保存</h3><p>个人记录与加密凭证保存在本机。正式对话所需的内容会发送到你选择的模型服务商。</p><p className="ask">“自己选模型，也清楚数据去向。”</p></article></div>
            <div className="sticky-wrap"><article className="sticky sticky-yellow"><span className="tape" aria-hidden="true"></span><span className="sticky-no">06</span><h3>按需要辅助学习</h3><p>学习类请求按需加载费曼法、习题诊断或螺旋复习等技能，围绕你提供的内容展开。</p><p className="ask">“用费曼法检查我对这个概念的理解。”</p></article></div>
          </div>
        </section>
        <section className="section capability-band screen" aria-label="全景能力清单">
          <div className="wrap">
            <div className="capability-panel">
              <div className="capability-head">
                <div>
                  <p className="eyebrow">WHEN YOU NEED MORE / 按需展开</p>
                  <h3>先用好课表和待办，再按需要展开。</h3>
                </div>
                <p className="capability-note">通用课表可直接导入；在线成绩、考试与通知查询取决于学校适配器 · <a href="https://github.com/Health-525/courseraptor/blob/main/docs/capabilities.md">完整清单与使用边界 ↗</a></p>
              </div>
              <div className="capability-grid">
                <div className="capability"><span>课表与校历</span><p>按教学周查课、放假调休一句话落盘；教务通知调课、换教室换教师直接改本地课表，今日页、周课表、课表图片与 .ics 导出都以它为准。</p></div>
                <div className="capability"><span>文件与数据</span><p>本地文件读取、Excel 筛选查询、沙箱 JS 计算、附件缓存管理。</p></div>
                <div className="capability"><span>文档生成</span><p>Word / Excel / PDF 生成与跨格式互转，中文原生可写；成品文件落在本机，对话里直接回传。</p></div>
                <div className="capability"><span>记忆 · 待办 · 知识</span><p>两层记忆、主程序运行时的待办到期提醒、按课程归类的知识库。</p></div>
                <div className="capability"><span>学习与效率</span><p>按需加载费曼学习、习题诊断、螺旋复习等学习技能，也可使用番茄钟与功能面板。</p></div>
                <div className="capability"><span>时间与天气</span><p>模型的唯一时钟（教学周推算）、天气与带伞穿衣建议。</p></div>
              </div>
            </div>
          </div>
        </section>
        <section className="try-section screen" id="try" aria-labelledby="try-title"><div className="wrap try-grid">
          <div><p className="eyebrow">02 / JUST ASK</p><h2 id="try-title">像问同学一样，<br />直接问它。</h2><p className="muted">点一个问题，看看回答的样子。</p><div className="question-list" aria-label="选择示例问题">{EXAMPLE_KEYS.map((key) => (
            <button key={key} type="button" aria-pressed={example === key} onClick={() => setExample(key)}>{ANSWERS[key].question}<span aria-hidden="true">↗</span></button>
          ))}</div><p className="small muted">这里只展示虚构示例，不连接教务系统或 AI。<br />真实的本地离线演示见下方开始使用。</p></div>
          <div className="conversation"><div className="conversation-top"><span><span className="status-dot"></span> CourseRaptor</span><span>示例预览</span></div><p className="question" id="example-question">{ANSWERS[example].question}</p><div className="answer" id="example-answer" aria-live="polite" aria-atomic="true"><p className="answer-label">🦖 小恐龙</p><div className="steps" key={`steps-${example}`} aria-label="示例工具调用步骤">{ANSWERS[example].steps.map((step) => <span className="step" key={step}>{step}</span>)}</div><div className="answer-body" key={example}>{ANSWERS[example].body}</div></div><div className="conversation-bottom">查询 · 整理 · 继续追问 <span aria-hidden="true">✦</span></div></div>
        </div></section>
        <section className="section wrap product screen" aria-labelledby="product-title"><div className="section-head"><div><p className="eyebrow">03 / ON YOUR OWN DESK</p><h2 id="product-title">四个面板，<br />一眼看清。</h2></div><p>功能大厅在右侧栏里打开，今天、本周、截止、知识各占一页。<br />网页、终端与可选的 QQ 入口共用同一个助手和同一份本地记录。</p></div>
          <div className="figure-grid">
            <figure className="photo photo-a"><span className="photo-pin" aria-hidden="true"></span><div className="window-bar"><span className="lights" aria-hidden="true"><i></i><i></i><i></i></span><span>今日日程</span></div><img src={panelToday} alt="功能大厅今日日程侧栏：示例课程的时间、地点与上课状态" width="420" height="300\" loading="lazy" decoding="async" /><figcaption>今日日程：当天的课与上课状态。</figcaption></figure>
            <figure className="photo photo-b"><span className="photo-pin" aria-hidden="true"></span><div className="window-bar"><span className="lights" aria-hidden="true"><i></i><i></i><i></i></span><span>本周课表</span></div><img src={panelSchedule} alt="功能大厅课表侧栏：按星期列出示例课程、时间和地点" width="420" height="700\" loading="lazy" decoding="async" /><figcaption>课表：按星期查看课程、时间和地点。</figcaption></figure>
            <figure className="photo photo-c"><span className="photo-pin" aria-hidden="true"></span><div className="window-bar"><span className="lights" aria-hidden="true"><i></i><i></i><i></i></span><span>截止待办</span></div><img src={panelTodos} alt="功能大厅待办侧栏：按逾期、明天、以后分组的示例待办" width="420" height="610\" loading="lazy" decoding="async" /><figcaption>待办：按截止时间分组，逾期一眼可见。</figcaption></figure>
            <figure className="photo photo-d"><span className="photo-pin" aria-hidden="true"></span><div className="window-bar"><span className="lights" aria-hidden="true"><i></i><i></i><i></i></span><span>课程知识库</span></div><img src={panelKnowledge} alt="功能大厅知识库侧栏：按课程筛选和搜索示例知识点" width="420" height="660\" loading="lazy" decoding="async" /><figcaption>知识库：按课程整理，可搜索。</figcaption></figure>
          </div>
          <p className="figure-note small muted">以上均为当前源码界面截图，课程、待办与知识记录为虚构示例数据。</p>
        </section>
        <section className="start-section screen" id="start" aria-labelledby="start-title"><div className="wrap start-grid"><div><p className="eyebrow">04 / YOUR FIRST CONVERSATION</p><h2 id="start-title">从第一张课表，<br />开始用起来。</h2><p>Windows 用户可下载安装包，配置模型后导入课表。<br />只想先看界面？有 Node.js 环境可运行离线演示。</p><div className="actions"><a className="button primary" href="https://github.com/Health-525/courseraptor/releases/latest">下载 Windows 安装包 <span aria-hidden="true">↓</span></a><a className="button ghost" href="https://github.com/Health-525/courseraptor/releases">绿色 zip · 全部版本 <span aria-hidden="true">↗</span></a></div><p className="small muted">安装包已内置 Node 运行时；正式 AI 对话仍需自备模型 Key。macOS 和 Linux 使用源码版。</p></div><div className="setup"><ol><li><span>1</span><div><h3>下载并启动</h3><p>最新版 <a href="https://github.com/Health-525/courseraptor/releases/latest">见 Releases 页↗</a>：选择 desktop-win-x64-setup.exe 结尾的安装器，或便携包；zip 解压后按说明运行 start.bat。</p></div></li><li><span>2</span><div><h3>按引导完成配置</h3><p>在设置中保存自己的模型 API Key 并检测连接，再导入课表、核对预览后确认。先看离线演示的话，需要 Node.js 24+ 和 Git，再运行下方命令。</p><div className="codebox"><div><span className="lights" aria-hidden="true"><i></i><i></i><i></i></span><span>Terminal</span><button type="button" id="copy-command" onClick={copyCommands}>{copied ? '✓ 已复制' : '复制命令'}</button></div><pre><code id="commands" ref={commandsRef}>{START_COMMANDS.map((cmd) => <span key={cmd}><span className="ps1" aria-hidden="true">$ </span>{cmd}{'\n'}</span>)}</code></pre></div><p id="copy-status" className="small" role="status">{copyStatus}</p></div></li><li><span>3</span><div><h3>打开终端显示的地址</h3><p>正式网页通常在 <code>http://127.0.0.1:3210</code>；离线演示通常为 3211，以启动提示为准。先核对一门课，再记一条待办。</p></div></li></ol><div className="next-step">正式对话按所选服务商计费，费用随模型和用量变化。个人记录本地保存，相关对话内容发送到模型服务；导入课表后请检查周次、节次和地点。<a href="https://github.com/Health-525/courseraptor/blob/main/docs/student-guide.md">阅读同学使用指南 ↗</a></div></div></div></section>
        <section className="section wrap faq screen" id="faq" aria-labelledby="faq-title"><div><p className="eyebrow">BEFORE YOU START</p><h2 id="faq-title">先说清楚，<br />用起来更安心。</h2></div><div className="faq-list"><details><summary>这是学校官方产品吗？</summary><p>不是。CourseRaptor 是非官方开源项目，与任何学校官方无关、未获授权或认可；通用课表可通过粘贴或上传文件导入，不要求学校已适配；在线成绩、考试和教务通知查询仍需要对应适配器。</p></details><details><summary>使用需要付费吗？数据会发到哪里？</summary><p>项目以 MIT 许可证开源，安装与使用免费。离线演示不调用 AI；正式对话会把提问与所需查询结果发送到你配置的模型服务（默认 DeepSeek，可换通义千问、Kimi、移动云等 12 家国内厂商），费用取决于所选模型与实际用量，不承诺固定月费。教务凭证 AES-256-GCM 加密保存在你自己的电脑；不上报任何遥测（历史安装包的匿名装机统计服务已下线，RAPTOR_NO_TELEMETRY=1 可关旧包上报），请勿分享已使用的项目目录。</p></details><details><summary>手机能直接打开这个网页查教务吗？</summary><p>这个网站是项目介绍页，不是在线教务服务。正式助手运行在你的电脑上；可把生成的 .ics 日历文件导入手机，或自行配置公开的 GitHub / Gitee 订阅源。公开订阅可能暴露课程与地点，发布前需确认。</p></details><details><summary>会自动提醒我吗？</summary><p>主程序保持运行、通知权限可用时，按规则提醒临近到期的待办；QQ 推送还需配置机器人和接收对象。手机日历可导入 .ics 文件，提醒行为由日历 App 设置决定。</p></details><details><summary>我是开发者，这个项目对我有什么用？</summary><p>它同时是一个可运行、可拆解的本地 Agent 参考项目：Vercel AI SDK v7 的 <code>ToolLoopAgent</code> 多轮工具循环、内核与外部系统隔离的端口注入架构（依赖方向由 <code>npm run verify:imports</code> 在 CI 钉死）、12 家厂商的模型注册表装配，以及本地优先的凭证加密与沙箱设计。模式可自由复用（MIT）。</p></details><details><summary>安装遇到问题，去哪里反馈？</summary><p>先看同学使用指南与仓库 README 的部署说明。可复现错误请提交 <a href="https://github.com/Health-525/courseraptor/issues/new/choose">Issue</a>，使用想法可到 <a href="https://github.com/Health-525/courseraptor/discussions">Discussions</a> 交流。请勿上传学号、成绩单、密码、API Key 或完整日志。</p></details></div></section>
        <section className="community wrap screen" aria-labelledby="community-title">
          <div className="community-inner">
            <div className="community-mascot">
              <div className="community-mascot-frame"><img src={logoHero} alt="CourseRaptor 小恐龙" width="840" height="840" loading="lazy" /></div>
            </div>
            <div className="community-copy">
              <p className="eyebrow">BUILT IN THE OPEN</p>
              <h2 id="community-title">让更多同学，<br /><em>遇见小恐龙。</em></h2>
              <p>如果它帮你省下了一点时间，欢迎给个 Star，<br />也欢迎把真实需求带回来，一起让它更好用。</p>
              <p className="small muted">开发者：工程模式可整体搬走做自己的 Agent（MIT）；<br />也欢迎修 bug、改文档，或到 Discussions 交流。</p>
              <dl className="community-stats">
                <div><dt>课表</dt><dd>按教学周查课</dd></div>
                <div><dt>待办</dt><dd>保存截止事项</dd></div>
                <div><dt>记录</dt><dd>本机保存与查询</dd></div>
              </dl>
              <div className="actions"><a className="button primary" href="https://github.com/Health-525/courseraptor">去 GitHub 看看 <span aria-hidden="true">↗</span></a><a className="button ghost" href="https://github.com/Health-525/courseraptor/discussions">聊聊你的想法 <span aria-hidden="true">↗</span></a></div>
              <a className="text-link" href="https://github.com/Health-525/courseraptor/blob/main/docs/roadmap.md">查看路线图与参与方向 →</a>
            </div>
          </div>
        </section>
      </main>
      <footer className="wrap footer"><a className="brand" href="#">CourseRaptor<span>🦖</span></a><span>Made for students. A reference for agent builders.</span><div><a href="https://github.com/Health-525/courseraptor/blob/main/LICENSE">MIT License</a><a href="https://github.com/Health-525/courseraptor/blob/main/SECURITY.md">安全说明</a><a href="https://github.com/Health-525/courseraptor/blob/main/README.en.md" lang="en">English docs ↗</a></div></footer>
    </>
  )
}

export default App
