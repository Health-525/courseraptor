import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

/*
 * 落地页滚动编排（oil-ui 滚动叙事）：
 * 1. 滑动驱动：首屏固定舞台做景深——大标题放大后退、吉祥物缩小让位、
 *    课表格与网格以不同速率离场，往回滚即倒放；桌面 pin 140vh，窄屏降为不固定的轻视差。
 * 2. 滑动触发（一次性，回滚不重播）且按区块材质分化出场：
 *    功能卡/能力卡带重量落下、产品截图遮罩揭开并回缩、安装步骤节点落位、
 *    FAQ 沿阅读方向滑入、问答区两栏对开、缎带横移视差。
 * 系统偏好「减少动态」时不安装任何滚动动画，内容直接可见。
 */
export function setupLandingMotion(): () => void {
  const mm = gsap.matchMedia()

  mm.add('(prefers-reduced-motion: no-preference)', () => {
    const once = { once: true, start: 'top 88%' }

    // 大标题：升起，字距从略松收紧，结束后回到 CSS 排版值
    gsap.utils.toArray<HTMLElement>('main h2').forEach((h) => {
      gsap.fromTo(
        h,
        { autoAlpha: 0, y: 26, letterSpacing: '0.14em' },
        {
          autoAlpha: 1,
          y: 0,
          letterSpacing: '0em',
          duration: 0.7,
          ease: 'power3.out',
          clearProps: 'letterSpacing',
          scrollTrigger: { trigger: h, ...once },
        },
      )
    })

    // 功能卡与能力卡：带重量落下，过冲 1–2% 后稳住，后一张被前一张带出
    gsap.fromTo(
      '.feature-grid .feature',
      { autoAlpha: 0, y: 30, scale: 0.985 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: 0.62,
        ease: 'back.out(1.2)',
        stagger: 0.07,
        scrollTrigger: { trigger: '.feature-grid', ...once },
      },
    )
    gsap.fromTo(
      '.capability-grid .capability',
      { autoAlpha: 0, y: 18 },
      {
        autoAlpha: 1,
        y: 0,
        duration: 0.5,
        ease: 'back.out(1.2)',
        stagger: 0.05,
        scrollTrigger: { trigger: '.capability-grid', ...once },
      },
    )

    // 产品截图：遮罩自上而下揭开，图片同时从 1.08 回缩到 1
    gsap.utils.toArray<HTMLElement>('.figure-grid figure').forEach((f) => {
      const tl = gsap.timeline({ scrollTrigger: { trigger: f, ...once } })
      tl.fromTo(
        f,
        { clipPath: 'inset(0 0 100% 0)' },
        { clipPath: 'inset(0 0 0% 0)', duration: 0.7, ease: 'power3.inOut' },
      )
      tl.fromTo(
        f.querySelector('img'),
        { scale: 1.08 },
        { scale: 1, duration: 0.9, ease: 'power2.out' },
        '<',
      )
    })

    // 安装步骤：序号节点先落位，内容随后跟上（静态连线保持）
    gsap.utils.toArray<HTMLElement>('.setup li').forEach((li) => {
      const num = li.querySelector(':scope > span')
      const body = li.querySelector(':scope > div')
      const tl = gsap.timeline({ scrollTrigger: { trigger: li, ...once } })
      tl.fromTo(
        num,
        { scale: 0.4, autoAlpha: 0 },
        { scale: 1, autoAlpha: 1, duration: 0.45, ease: 'back.out(2)' },
      )
      tl.fromTo(
        body,
        { x: -14, autoAlpha: 0 },
        { x: 0, autoAlpha: 1, duration: 0.5, ease: 'power2.out' },
        '-=0.25',
      )
    })

    // FAQ：沿阅读方向依次滑入
    gsap.fromTo(
      '.faq-list details',
      { autoAlpha: 0, x: 18 },
      {
        autoAlpha: 1,
        x: 0,
        duration: 0.5,
        ease: 'power2.out',
        stagger: 0.06,
        scrollTrigger: { trigger: '.faq-list', ...once },
      },
    )

    // 问答区两栏对开：宽屏问题列表从左、对话窗从右；窄屏改纵向浮起（单列下对开失去意义）
    const tryTrigger = () => ({ trigger: '.try-grid', ...once })
    mm.add('(min-width: 761px)', () => {
      gsap.fromTo(
        '.try-grid > div:first-child',
        { autoAlpha: 0, x: -28 },
        { autoAlpha: 1, x: 0, duration: 0.6, ease: 'power3.out', scrollTrigger: tryTrigger() },
      )
      gsap.fromTo(
        '.conversation',
        { autoAlpha: 0, x: 28 },
        { autoAlpha: 1, x: 0, duration: 0.6, ease: 'power3.out', scrollTrigger: tryTrigger() },
      )
    })
    mm.add('(max-width: 760px)', () => {
      gsap.fromTo(
        '.try-grid > div:first-child',
        { autoAlpha: 0, y: 22 },
        { autoAlpha: 1, y: 0, duration: 0.55, ease: 'power3.out', scrollTrigger: tryTrigger() },
      )
      gsap.fromTo(
        '.conversation',
        { autoAlpha: 0, y: 22 },
        { autoAlpha: 1, y: 0, duration: 0.55, ease: 'power3.out', scrollTrigger: tryTrigger() },
      )
    })

    // 开始使用与社区：栏目浮现
    gsap.fromTo(
      '.start-grid > div:first-child',
      { autoAlpha: 0, y: 22 },
      {
        autoAlpha: 1,
        y: 0,
        duration: 0.6,
        ease: 'power3.out',
        scrollTrigger: { trigger: '.start-grid', ...once },
      },
    )
    gsap.fromTo(
      '.community-mascot',
      { autoAlpha: 0, x: -20 },
      {
        autoAlpha: 1,
        x: 0,
        duration: 0.6,
        ease: 'power3.out',
        scrollTrigger: { trigger: '.community-inner', ...once },
      },
    )

    // 缎带横移视差：滚动经过时内容整体轻微往返平移
    gsap.fromTo(
      '.ribbon-inner',
      { xPercent: 3 },
      {
        xPercent: -3,
        ease: 'none',
        scrollTrigger: { trigger: '.ribbon', start: 'top bottom', end: 'bottom top', scrub: true },
      },
    )

    // 首屏景深：固定舞台 + 滑动驱动（正文与按钮保持可读可点）。
    // 用 fromTo 锁定起点：首屏 CSS 入场动画（rise-in）结束后 scrub 完全接管 transform，
    // 避免把 CSS 动画的 delay 期 from 态误记为基线。
    mm.add('(min-width: 1051px)', () => {
      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: '.hero',
          start: 'top top',
          end: '+=140%',
          scrub: true,
          pin: true,
          anticipatePin: 1,
        },
      })
      tl.fromTo(
        '.hero-copy h1',
        { scale: 1, y: 0, autoAlpha: 1, transformOrigin: '0 0' },
        { scale: 1.22, autoAlpha: 0.25 },
        0,
      )
      tl.fromTo(
        '.mascot-frame',
        { scale: 1, y: 0, rotate: 3, transformOrigin: '50% 60%' },
        { scale: 0.84, y: 44, rotate: 0.5 },
        0,
      )
      tl.fromTo('.hero-cell', { y: 0, autoAlpha: 1 }, { y: -80, autoAlpha: 0 }, 0)
      tl.fromTo('.hero-grid', { y: 0, autoAlpha: 1 }, { y: 70, autoAlpha: 0 }, 0)
    })

    // 窄屏不固定舞台，保留轻视差（缩放的幅度与方向不变，去掉 pin）
    mm.add('(max-width: 1050px)', () => {
      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
      })
      tl.fromTo('.hero-art', { y: 0, scale: 1 }, { y: -26, scale: 0.94 }, 0)
      tl.fromTo('.hero-copy', { y: 0 }, { y: 14 }, 0)
    })
  })

  return () => mm.revert()
}
