import { GraduationCap } from 'lucide-react'
import { ThemeSwitch } from '@/components/theme-switch'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className='container relative grid h-svh max-w-none items-center justify-center'>
      <div className='absolute top-4 end-4'>
        <ThemeSwitch />
      </div>
      <div className='mx-auto flex w-full flex-col justify-center space-y-2 py-8 sm:p-8'>
        <div className='mb-6 flex flex-col items-center justify-center gap-3'>
          <div className='flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm'>
            <GraduationCap className='size-7' aria-hidden />
          </div>
          <div className='space-y-0.5 text-center'>
            <h1 className='text-xl font-semibold tracking-tight'>CourseRaptor</h1>
            <p className='text-sm text-muted-foreground'>更新分发后台</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}
