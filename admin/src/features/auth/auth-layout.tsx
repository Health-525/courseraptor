import { RaptorMark } from '@/components/layout/app-title'

type AuthLayoutProps = {
  children: React.ReactNode
}

/** 登录页骨架：左侧墨绿品牌面板（桌面端），右侧表单区 */
export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className='bg-background grid min-h-svh lg:grid-cols-[1.05fr_1fr]'>
      <aside className='bg-sidebar text-sidebar-foreground relative hidden flex-col justify-between overflow-hidden p-10 lg:flex'>
        {/* 爪痕水印：品牌的安静存在感 */}
        <RaptorMark className='text-sidebar-primary/12 pointer-events-none absolute -end-20 -top-16 size-[30rem] rotate-12' />

        <div className='flex items-center gap-2.5'>
          <span className='bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-lg'>
            <RaptorMark className='size-[18px]' />
          </span>
          <span className='text-sm font-bold tracking-tight'>
            CourseRaptor
            <span className='text-sidebar-primary font-medium'> · 管理台</span>
          </span>
        </div>

        <div className='relative max-w-md'>
          <h1 className='text-3xl leading-snug font-bold tracking-tight'>
            班级自己的
            <br />
            AI 教务助手
          </h1>
          <p className='text-sidebar-foreground/70 mt-4 text-sm leading-relaxed'>
            课表、成绩、考试、通知——同学一句话查询。这里是站长的控制台：
            管账号、发邀请码、审重置、发版本。
          </p>
          <ul className='text-sidebar-foreground/60 mt-8 space-y-2.5 text-[13px]'>
            <li className='flex items-center gap-2.5'>
              <span className='bg-sidebar-primary/20 size-1.5 rounded-full' />
              多用户托管 · 每人独立实例与数据
            </li>
            <li className='flex items-center gap-2.5'>
              <span className='bg-sidebar-primary/20 size-1.5 rounded-full' />
              邀请码注册 · 站点 Key 与额度分账
            </li>
            <li className='flex items-center gap-2.5'>
              <span className='bg-sidebar-primary/20 size-1.5 rounded-full' />
              两步验证 · 管理动作全审计
            </li>
          </ul>
        </div>

        <p className='text-sidebar-foreground/40 text-xs'>
          CourseRaptor · 班级互助服务
        </p>
      </aside>

      <div className='flex items-center justify-center p-6 sm:p-10'>
        <div className='w-full max-w-sm'>
          {/* 移动端 / 窄屏的紧凑品牌头 */}
          <div className='mb-8 flex items-center gap-2.5 lg:hidden'>
            <span className='bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg'>
              <RaptorMark className='size-[18px]' />
            </span>
            <span className='text-sm font-bold tracking-tight'>
              CourseRaptor
              <span className='text-primary font-medium'> · 管理台</span>
            </span>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
