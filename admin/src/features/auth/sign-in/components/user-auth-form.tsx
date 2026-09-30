import { useEffect, useState } from 'react'
import { AxiosError } from 'axios'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, LogIn } from 'lucide-react'
import { getSession, login } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/password-input'

const formSchema = z.object({
  password: z.string().min(1, '请输入管理密码'),
  code: z.string().optional(),
})

interface UserAuthFormProps extends React.HTMLAttributes<HTMLFormElement> {
  redirectTo?: string
}

export function UserAuthForm({
  className,
  redirectTo,
  ...props
}: UserAuthFormProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [mfaRequired, setMfaRequired] = useState(false)
  const navigate = useNavigate()

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { password: '', code: '' },
  })

  // 已登录直接进面板；顺便探测是否绑了两步验证（决定是否显示动态码输入框）
  useEffect(() => {
    let alive = true
    getSession()
      .then((session) => {
        if (!alive) return
        setMfaRequired(session.mfaRequired)
        if (session.authed) {
          navigate({ to: redirectTo || '/', replace: true })
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [navigate, redirectTo])

  async function onSubmit(data: z.infer<typeof formSchema>) {
    setIsLoading(true)
    setError('')
    try {
      await login(data.password, data.code ?? '')
      navigate({ to: redirectTo || '/', replace: true })
    } catch (err) {
      if (err instanceof AxiosError) {
        const body = err.response?.data as
          | { error?: string; locked?: boolean }
          | undefined
        if (body?.error) setError(body.error)
        else if (err.response?.status === 429) setError('尝试过多，请稍后再试')
        else setError('登录失败，请检查网络后重试')
        // 密码对但动态码错（或已绑定但没填）时补出动态码输入框
        if (body?.error?.includes('动态码')) setMfaRequired(true)
      } else {
        setError('登录失败，请检查网络后重试')
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className={cn('grid gap-3', className)}
        {...props}
      >
        {error && (
          <Alert variant='destructive'>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <FormField
          control={form.control}
          name='password'
          render={({ field }) => (
            <FormItem>
              <FormLabel>管理密码</FormLabel>
              <FormControl>
                <PasswordInput placeholder='请输入管理密码' {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {mfaRequired && (
          <FormField
            control={form.control}
            name='code'
            render={({ field }) => (
              <FormItem>
                <FormLabel>动态码（2FA）</FormLabel>
                <FormControl>
                  <Input
                    placeholder='验证器 6 位数字（或恢复码）'
                    inputMode='numeric'
                    autoComplete='one-time-code'
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <Button className='mt-2' disabled={isLoading}>
          {isLoading ? <Loader2 className='animate-spin' /> : <LogIn />}
          进入管理后台
        </Button>
      </form>
    </Form>
  )
}
