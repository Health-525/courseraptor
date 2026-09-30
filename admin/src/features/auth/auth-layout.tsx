import { Badge } from '@/components/ui/badge'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className='container grid h-svh max-w-none items-center justify-center'>
      <div className='mx-auto flex w-full flex-col justify-center space-y-2 py-8 sm:w-[480px] sm:p-8'>
        <div className='mb-4 flex items-center justify-center'>
          <h1 className='text-xl font-semibold'>
            Course<span className='text-primary font-bold'>Raptor</span>{' '}
            <Badge variant='outline' className='ms-1 font-medium'>
              ADMIN
            </Badge>
          </h1>
        </div>
        {children}
        <p className='text-muted-foreground mt-4 text-center text-sm'>
          班级互助服务 · CourseRaptor
        </p>
      </div>
    </div>
  )
}
