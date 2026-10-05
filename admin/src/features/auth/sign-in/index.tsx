import { useSearch } from '@tanstack/react-router'
import { AuthLayout } from '../auth-layout'
import { UserAuthForm } from './components/user-auth-form'

export function SignIn() {
  const { redirect } = useSearch({ from: '/(auth)/sign-in' })

  return (
    <AuthLayout>
      <div className='flex flex-col gap-6'>
        <div className='space-y-1.5'>
          <h2 className='text-2xl font-bold tracking-tight'>登录管理后台</h2>
          <p className='text-sm text-muted-foreground'>
            输入管理密码进入控制台
          </p>
        </div>
        <UserAuthForm redirectTo={redirect} />
        <p className='text-center text-xs text-muted-foreground/70'>
          班级互助服务 · CourseRaptor
        </p>
      </div>
    </AuthLayout>
  )
}
