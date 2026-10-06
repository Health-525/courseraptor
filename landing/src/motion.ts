import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

/*
 * 落地页滚动编排（便签墙方向）：
 * 1. 滑动驱动（首屏）：hero 固定 140vh——恐龙轻微后退缩小，三张便利贴被风逐张揭走，
 *    标题轻推放大；回滚即倒放。窄屏降为轻视差（幅度方向不变，去掉 pin）。
 * 2. 滑动触发（一次性，回滚不重播）且按材质分化出场：
 *    便利贴墙「带一点旋转后摆正，像被贴到板上」；能力格短促落下；
 *    照片遮罩揭开并回缩；步骤节点落位；FAQ 沿阅读方向滑入；
 *    问答区两栏对开（窄屏改纵向）；washi 胶带条横移视差。
 * 系统偏好「减少动态」时不安装任何滚动动画，内容直接可见。
 * 区块初始不做 CSS 隐藏；JS 不可用时页面完整可读。
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

    // 便利贴墙：先快后慢，带一点旋转后摆正，像被一张张贴到板上（wrap 层动画，CSS 静态旋转在内层保持）
    gsap.fromTo(
      '.sticky-wrap',
      { autoAlpha: 0, y: 44, rotate: 7 },
      {
        autoAlpha: 1,
        y: 0,
        rotate: 0,
        duration: 0.72,
        ease: 'power3.out',
        stagger: 0.08,
        scrollTrigger: { trigger: '.wall', ...once },
      },
    )

    // 能力格：短促落下，过冲 1–2% 后稳住
    gsap.fromTo(
      '.capability',
      { autoAlpha: 0, y: 20 },
      {
        autoAlpha: 1,
        y: 0,
        duration: 0.5,
        ease: 'back.out(1.2)',
        stagger: 0.05,
        scrollTrigger: { trigger: '.capability-grid', ...once },
      },
    )

    // 产品照片：遮罩自上而下揭开，图片同时从 1.08 回缩到 1
    gsap.utils.toArray<HTMLElement>('.figure-grid .photo').forEach((f) => {
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

    // 安装步骤：序号节点先落位，内容随后跟上（和纸胶带连线保持静态）
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

    // 问答区两栏对开：宽屏问题列表从左、对话窗从右；窄屏改纵向浮起
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
      { autoAlpha: 0, y: 24, rotate: -3 },
      {
        autoAlpha: 1,
        y: 0,
        rotate: 0,
        duration: 0.6,
        ease: 'power3.out',
        scrollTrigger: { trigger: '.community-inner', ...once },
      },
    )

    // washi 胶带条横移视差：滚动经过时内容轻微往返平移
    gsap.fromTo(
      '.tape-inner',
      { xPercent: 3 },
      {
        xPercent: -3,
        ease: 'none',
        scrollTrigger: { trigger: '.tape-band', start: 'top bottom', end: 'bottom top', scrub: true },
      },
    )

    // 首屏景深：固定舞台 + 滑动驱动。恐龙后退缩小、标题轻推全程进行；
    // 便利贴承载关键信息（36 工具/12 厂商），前 40% 滚动保持完整可读，
    // 滚过信息带之后才被风逐张揭走、给下一节让出画面。
    // fromTo 锁定起点（首屏 CSS 入场动画结束后 scrub 完全接管 transform）。
    mm.add('(min-width: 901px)', () => {
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
      tl.fromTo('.hero h1', { scale: 1, y: 0 }, { scale: 1.07, y: -10, duration: 1.4 }, 0)
      tl.fromTo(
        '.mascot',
        { scale: 1, y: 0, transformOrigin: '50% 60%' },
        { scale: 0.86, y: 44, duration: 1.4 },
        0,
      )
      tl.fromTo(
        '.hero-note',
        { y: 0, autoAlpha: 1, rotate: 0 },
        { y: -110, autoAlpha: 0, rotate: -9, duration: 0.34, stagger: 0.16 },
        0.55,
      )
    })

    // 窄屏不固定舞台，保留轻视差（缩放幅度与方向不变，去掉 pin）
    mm.add('(max-width: 900px)', () => {
      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
      })
      tl.fromTo('.mascot', { y: 0, scale: 1 }, { y: -24, scale: 0.94 }, 0)
    })
  })

  return () => mm.revert()
}
