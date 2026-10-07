import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { setupLandingMotion } from './motion'
import logoHeader from './assets/logo-header.webp'
import logoHero from './assets/logo-hero.webp'
import screenshotHall from './assets/screenshot-hall.webp'
import screenshotKnowledge from './assets/screenshot-knowledge.webp'
import screenshotTui from './assets/screenshot-tui.webp'

// 固定演示文本不接受外部输入，也不调用教务系统或模型服务。
type ExampleKey = 'schedule' | 'exam' | 'memory'

const ANSWERS: Record<ExampleKey, { question: string; steps: string[]; body: ReactNode }> = {
  schedule: {
    question: '这周有什么课？',
    steps: ['登录教务', '读取教学周', '叠加放假调休'],
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
    steps: ['登录教务', '查询考试安排', '导出 .ics 日历', '设置考前提醒'],
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
    steps: ['检索长期记忆', '定位相关事实', '核对会话上下文'],
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

const START_COMMANDS = ['npm install', 'npm run demo']

/* 社区统计数字：进入视口后缓动数上来；系统偏好减少动态或目标为 0 时直接显示 */
function Stat({ value, label }: { value: number; label: string }) {
  const [shown, setShown] = useState(() => {
    if (value === 0) return 0
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? value : 0
  })
  const dtRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (value === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const node = dtRef.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        const start = performance.now()
        const duration = 900
        const tick = (now: number) => {
          const progress = Math.min(1, (now - start) / duration)
          setShown(Math.round(value * (1 - Math.pow(1 - progress, 3))))
          if (progress < 1) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      },
      { threshold: 0.6 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [value])

  return (
    <div>
      <dt ref={dtRef}>{shown}</dt>
      <dd>{label}</dd>
    </div>
  )
}

function App() {
  const [example, setExample] = useState<ExampleKey>('schedule')
  const [copyStatus, setCopyStatus] = useState('')
  const [copied, setCopied] = useState(false)
  const commandsRef = useRef<HTMLElement>(null)

  async function copyCommands() {
    try {
      await navigator.clipboard.writeText(START_COMMANDS.join('\n'))
      setCopied(true)
      setCopyStatus('已复制，在解压后的源码目录运行即可。')
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
        <a className="brand" href="#" aria-label="CourseRaptor 首页"><img src={logoHeader} alt="" width="36" height="36" />CourseRaptor<span className="brand-tag">FOR NJTECH &amp; HEBAU</span></a>
        <nav aria-label="主导航"><a href="#features">能做什么</a><a href="#try">看看示例</a><a href="#start">开始使用</a><a className="github-link" href="https://github.com/Health-525/courseraptor">GitHub ↗</a></nav></div>
      </header>
      <main id="main">
        <section className="hero wrap" aria-labelledby="hero-title">
          <p className="eyebrow"><span className="status-dot"></span> 开源 · 本地运行 · 给同学的助手 · 给开发者的样例</p>
          <div className="hero-head">
            <div>
              <h1 id="hero-title">教务琐事，<span className="hl">一句话。</span></h1>
              <p className="hero-desc">早八在哪上，通识修了哪些，考试什么时候——把反复翻找的时间，留给更想做的事。</p>
            </div>
            <div className="actions"><a className="button primary" href="#start">带走小恐龙 · exe 约 115MB <span aria-hidden="true">↓</span></a><a className="button ghost" href="#try">先看看它怎么答 <span aria-hidden="true">↓</span></a></div>
          </div>
          <figure className="hero-shot">
            <span className="photo-pin pin-l" aria-hidden="true"></span>
            <span className="photo-pin pin-r" aria-hidden="true"></span>
            <img src={screenshotHall} alt="CourseRaptor 网页版实拍：对话区与右侧功能大厅宫格，含新上线的用量统计热力图" width="1600" height="881" fetchPriority="high" />
            <span className="hero-sticker" aria-hidden="true"><img src={logoHero} alt="" width="840" height="840" /></span>
            <aside className="shot-tag tag-a"><span className="tape" aria-hidden="true"></span><b>新上线</b>一年用量热力图——每天用了多少、花在哪个模型，一格一天</aside>
            <aside className="shot-tag tag-b"><span className="tape" aria-hidden="true"></span>聊过的知识自动沉淀，<b>flomo 式知识库</b></aside>
            <aside className="shot-tag tag-c"><span className="tape" aria-hidden="true"></span>课表图<b>直接发在对话里</b></aside>
          </figure>
          <p className="hero-note-fine">36 个内置工具 · 12 家模型厂商 · 终端 / 网页 / QQ 三端同一份记忆 · 凭证 AES-256-GCM 加密不出本机</p>
        </section>
        <div className="tape-band" aria-hidden="true"><div className="wrap tape-inner"><span>课表与考试</span><span>✳</span><span>成绩与学籍</span><span>✳</span><span>通知与待办</span><span>✳</span><span>日历与知识库</span></div></div>
        <section className="section wrap screen" id="features" aria-labelledby="features-title">
          <div className="section-head"><div><p className="eyebrow">01 / LESS SEARCHING, MORE LIVING</p><h2 id="features-title">你说一句话，<br />小恐龙来办。</h2></div><p>不是又一个功能菜单，而是一位懂教务、会规划步骤、<br />记得住你的事的 Agent。</p></div>
          <div className="wall">
            <div className="sticky-wrap"><article className="sticky sticky-yellow"><span className="tape" aria-hidden="true"></span><span className="sticky-no">01</span><h3>对话即办事</h3><p>自动理解意图、拆解步骤、调度 36 个内置工具——登录教务、查考试、导日历、设提醒一气呵成。</p><p className="ask">“下周三有考试吗？加到手机日历，考前提醒我。”</p></article></div>
            <div className="sticky-wrap"><article className="sticky sticky-white"><span className="tape" aria-hidden="true"></span><span className="sticky-no">02</span><h3>思考与记忆</h3><p>思考过程与工具调用全程可见，可追问、可纠正；两层记忆跨重启续聊、自主沉淀事实。</p><p className="ask">“上次聊的那个截止日期是哪天？”</p></article></div>
            <div className="sticky-wrap"><article className="sticky sticky-green"><span className="tape" aria-hidden="true"></span><span className="sticky-no">03</span><h3>三端随叫随到</h3><p>终端 TUI、本地网页与 QQ 官方机器人共享同一 Agent 内核、同一套工具与记忆。</p><p className="ask">“在哪儿都能找到我。”</p></article></div>
            <div className="sticky-wrap"><article className="sticky sticky-white"><span className="tape" aria-hidden="true"></span><span className="sticky-no">04</span><h3>通知替你读</h3><p>按年级自动标注相关度，附件 Excel 结构化筛选，长文分页续读；关键日期藏在附件里也会被拎出来。</p><p className="ask">“这条通知需要我做什么？”</p></article></div>
            <div className="sticky-wrap"><article className="sticky sticky-green"><span className="tape" aria-hidden="true"></span><span className="sticky-no">05</span><h3>凭证不出本机</h3><p>教务账号与模型 API Key 以 AES-256-GCM 加密保存在本机，开源可审计；匿名装机统计可一键关闭。</p><p className="ask">“Local-first · 开源可审计”</p></article></div>
            <div className="sticky-wrap"><article className="sticky sticky-yellow"><span className="tape" aria-hidden="true"></span><span className="sticky-no">06</span><h3>学习教练</h3><p>学习类对话自动切换教练模式：直觉先于形式、答错先给提示，备考按「模板→变式→整卷」编排。</p><p className="ask">“帮我复习高数，下周三考试。”</p></article></div>
          </div>
        </section>
        <section className="section capability-band screen" aria-label="全景能力清单">
          <div className="wrap">
            <div className="capability-panel">
              <div className="capability-head">
                <div>
                  <p className="eyebrow">FULL TOOLBELT / 全景能力</p>
                  <h3>36 个内置工具，从教务到备考，一套内核全包。</h3>
                </div>
                <p className="capability-note">以南工大全量配置计；其他学校按已接入能力自动裁剪 · <a href="https://github.com/Health-525/courseraptor/blob/main/docs/capabilities.md">完整清单与使用边界 ↗</a></p>
              </div>
              <div className="capability-grid">
                <div className="capability"><span>教务查询 <em>×13</em></span><p>课表（自动叠加放假调休）、成绩与 GPA、考试安排、学籍打码、选课冲突只读对比、搜课与可重修。</p></div>
                <div className="capability"><span>通知情报 <em>×3</em></span><p>按年级标注相关度、正文全文、附件下载缓存＋Excel 结构化筛选＋长文分页续读。</p></div>
                <div className="capability"><span>文件与数据 <em>×4</em></span><p>本地文件读取、Excel 筛选查询、沙箱 JS 计算、附件缓存管理。</p></div>
                <div className="capability"><span>文档与课件 <em>×4</em></span><p>Word / Excel / PDF 生成与跨格式互转；PPT 写代码排版、套品牌课件模板，网页里直接翻页预览。</p></div>
                <div className="capability"><span>时间日历天气 <em>×5</em></span><p>教学周时间、调休落盘、.ics 日历导出与订阅、课表图片导出、天气与穿衣建议。</p></div>
                <div className="capability"><span>记忆与效率 <em>×7</em></span><p>两层记忆、待办双通道到期提醒、按课程归类的知识库、番茄钟、学习教练方法库、用量统计热力图。</p></div>
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
        <section className="section wrap product screen" aria-labelledby="product-title"><div className="section-head"><div><p className="eyebrow">03 / ON YOUR OWN DESK</p><h2 id="product-title">三种打开方式，<br />同一个助手。</h2></div><p>终端 TUI、本地网页与 QQ 机器人共享同一内核与记忆。<br />正式模式支持下载日历和生成的文档。</p></div>
          <div className="figure-grid">
            <figure className="photo photo-a"><span className="photo-pin" aria-hidden="true"></span><div className="window-bar"><span className="lights" aria-hidden="true"><i></i><i></i><i></i></span><span>CourseRaptor · 对话与功能大厅</span><span aria-hidden="true">↗</span></div><img src={screenshotHall} alt="CourseRaptor 网页版：对话区与右侧功能大厅宫格（今日日程、课表、考试、待办、知识库、用量统计等面板）" width="1600" height="881" loading="lazy" /><figcaption>对话 + 功能大厅：一句话把面板推出来，虚构演示数据。</figcaption></figure>
            <figure className="photo photo-b"><span className="photo-pin" aria-hidden="true"></span><div className="window-bar"><span className="lights" aria-hidden="true"><i></i><i></i><i></i></span><span>CourseRaptor · 知识库</span><span aria-hidden="true">↗</span></div><img src={screenshotKnowledge} alt="CourseRaptor 知识库独立页：标签侧栏、发布框与按日分组的卡片川流，卷首是近 16 周记录热力带" width="1600" height="881" loading="lazy" /><figcaption>知识库独立页（/knowledge）：对话里的知识点自动沉淀，16 周热力带看记录密度，虚构演示数据。</figcaption></figure>
            <figure className="photo photo-c"><span className="photo-pin" aria-hidden="true"></span><div className="window-bar"><span className="lights" aria-hidden="true"><i></i><i></i><i></i></span><span>CourseRaptor · 终端 TUI</span><span aria-hidden="true">↗</span></div><img src={screenshotTui} alt="CourseRaptor 终端 TUI 首屏：今日课表、待办、考试与通知速览" width="1600" height="881" loading="lazy" /><figcaption>终端 TUI 首屏（演示模式数据）。</figcaption></figure>
          </div>
        </section>
        <section className="start-section screen" id="start" aria-labelledby="start-title"><div className="wrap start-grid"><div><p className="eyebrow">04 / YOUR FIRST CONVERSATION</p><h2 id="start-title">五分钟，<br />认识小恐龙。</h2><p>先体验，再决定要不要配置。<br />演示无需教务账号、API Key，也不会调用 AI。</p><div className="actions"><a className="button primary" href="https://github.com/Health-525/courseraptor/releases/latest">下载最新版单文件 exe · 约 115MB <span aria-hidden="true">↓</span></a><a className="button ghost" href="https://github.com/Health-525/courseraptor/releases">绿色 zip · 全部版本 <span aria-hidden="true">↗</span></a></div><p className="small muted">exe 双击即用、内置 Node 运行时；升级把新版 exe 放进原文件夹再双击即可，账号与数据不动。</p></div><div className="setup"><ol><li><span>1</span><div><h3>下载并启动</h3><p>最新版 <a href="https://github.com/Health-525/courseraptor/releases/latest">见 Releases 页↗</a>：单文件 exe 双击即用，或绿色 zip 解压后双击 start.bat。</p></div></li><li><span>2</span><div><h3>按引导完成配置</h3><p>录入教务账号与模型 API Key——默认 DeepSeek，也内置通义千问、Kimi、智谱 GLM 等 12 家国内厂商可选，每家 Key 独立加密保存、切换不丢；开发者可克隆源码，免账号先跑离线演示。</p><div className="codebox"><div><span className="lights" aria-hidden="true"><i></i><i></i><i></i></span><span>Terminal</span><button type="button" id="copy-command" onClick={copyCommands}>{copied ? '✓ 已复制' : '复制命令'}</button></div><pre><code id="commands" ref={commandsRef}>{START_COMMANDS.map((cmd) => <span key={cmd}><span className="ps1" aria-hidden="true">$ </span>{cmd}{'\n'}</span>)}</code></pre></div><p id="copy-status" className="small" role="status">{copyStatus}</p></div></li><li><span>3</span><div><h3>打开终端显示的地址</h3><p>网页版默认 <code>http://localhost:3210</code>；终端、网页都能用，QQ 机器人可选开启。</p></div></li></ol><div className="next-step">准备正式使用？按引导配置教务账号与任一家厂商的模型 API Key 即可开始对话，日常成本个位数人民币；其他学校开箱可用「手动课表」模式，粘贴课表文字 AI 解析即可。<a href="https://github.com/Health-525/courseraptor/blob/main/docs/student-guide.md">阅读同学使用指南 ↗</a></div></div></div></section>
        <section className="section wrap faq screen" aria-labelledby="faq-title"><div><p className="eyebrow">BEFORE YOU START</p><h2 id="faq-title">先说清楚，<br />用起来更安心。</h2></div><div className="faq-list"><details><summary>这是学校官方产品吗？</summary><p>不是。CourseRaptor 是非官方开源项目，已适配南京工业大学（全量）与河北农业大学（社区维护），其他学校开箱可用「手动课表」模式（粘贴或上传课表，AI 解析成结构化课表）；没有学校官方隶属或背书。</p></details><details><summary>使用需要付费吗？数据会发到哪里？</summary><p>项目以 MIT 附加限制条款开源（仅作学习交流：可自由使用与修改，禁学术提交、参赛与任何商业用途），安装与使用免费。离线演示不调用 AI；正式对话会把提问与所需查询结果发送到你配置的模型服务（默认 DeepSeek，可换通义千问、Kimi、移动云等 12 家国内厂商），日常成本约个位数人民币每月。教务凭证 AES-256-GCM 加密保存在你自己的电脑；安装包含匿名装机统计（不含对话内容，环境变量 RAPTOR_NO_TELEMETRY=1 可关），请勿分享已使用的项目目录。</p></details><details><summary>手机能直接打开这个网页查教务吗？</summary><p>这个网站是项目介绍页，不是在线教务服务。正式助手运行在你的电脑上；可把生成的 .ics 日历文件导入手机，或自行配置公开的 GitHub / Gitee 订阅源。公开订阅可能暴露课程与地点，发布前需确认。</p></details><details><summary>会自动提醒我吗？</summary><p>待办与关键日期支持桌面通知 + QQ 双通道主动提醒；考试、放假等日程可导出日历订阅。</p></details><details><summary>我是开发者，这个项目对我有什么用？</summary><p>它同时是一套跑在真实使用里的本地 Agent 工程样例：Vercel AI SDK v7 的 <code>ToolLoopAgent</code> 多轮工具循环、<code>SchoolAdapter</code> 端口-适配器架构（新增一所学校 = 新增一个自包含目录，内核零改动）、12 家厂商的模型注册表装配，以及本地优先的凭证加密与沙箱设计。模式可自由复用（MIT + 附加限制），也欢迎<a href="https://github.com/Health-525/courseraptor/blob/main/docs/adapter-guide.md">为你的学校写一个适配器</a>，合入后你就是该校的署名维护者。</p></details><details><summary>安装遇到问题，去哪里反馈？</summary><p>先看同学使用指南与仓库 README 的部署说明。可复现错误请提交 <a href="https://github.com/Health-525/courseraptor/issues/new/choose">Issue</a>，使用想法可到 <a href="https://github.com/Health-525/courseraptor/discussions">Discussions</a> 交流。请勿上传学号、成绩单、密码、API Key 或完整日志。</p></details></div></section>
        <section className="community wrap screen" aria-labelledby="community-title">
          <div className="community-inner">
            <div className="community-mascot">
              <div className="community-mascot-frame"><img src={logoHero} alt="CourseRaptor 小恐龙" width="840" height="840" loading="lazy" /></div>
            </div>
            <div className="community-copy">
              <p className="eyebrow">BUILT IN THE OPEN</p>
              <h2 id="community-title">让更多同学，<br /><em>遇见小恐龙。</em></h2>
              <p>如果它帮你省下了一点时间，欢迎给个 Star，<br />也欢迎把真实需求带回来，一起让它更好用。</p>
              <p className="small muted">开发者：工程模式可整体搬走做自己的 Agent（MIT + 附加限制，禁商用）；<br />也欢迎为你的学校写适配器，成为署名维护者。</p>
              <dl className="community-stats">
                <Stat value={36} label="内置工具" />
                <Stat value={3} label="终端 · 网页 · QQ" />
                <Stat value={12} label="家模型厂商" />
              </dl>
              <div className="actions"><a className="button primary" href="https://github.com/Health-525/courseraptor">去 GitHub 看看 <span aria-hidden="true">↗</span></a><a className="button ghost" href="https://github.com/Health-525/courseraptor/discussions">聊聊你的想法 <span aria-hidden="true">↗</span></a></div>
              <a className="text-link" href="https://github.com/Health-525/courseraptor/blob/main/docs/roadmap.md">下一站：培养方案核对 · 考试复习计划 · 配置向导 →</a>
            </div>
          </div>
        </section>
      </main>
      <footer className="wrap footer"><a className="brand" href="#">CourseRaptor<span>🦖</span></a><span>Made for students. A reference for agent builders.</span><div><a href="https://github.com/Health-525/courseraptor/blob/main/LICENSE">MIT · 附加条款</a><a href="https://github.com/Health-525/courseraptor/blob/main/SECURITY.md">安全说明</a><a href="https://github.com/Health-525/courseraptor/blob/main/README.en.md" lang="en">English docs ↗</a></div></footer>
    </>
  )
}

export default App
