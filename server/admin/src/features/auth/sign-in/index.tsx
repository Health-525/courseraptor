import { useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { CircleAlert } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { api, ApiError } from '@/lib/api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/password-input'
import { AuthLayout } from '../auth-layout'

export function SignIn() {
  const navigate = useNavigate()
  const { redirect } = useSearch({ from: '/(auth)/sign-in' })
  const { auth } = useAuthStore()
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const value = token.trim()
    if (!value || loading) return
    setLoading(true)
    setError(null)
    auth.setAccessToken(value)
    try {
      await api.overview()
      // redirect 来自退出登录/会话失效前的完整路径（含 /admin 前缀），剥去前缀后跳转
      const target =
        redirect && redirect.startsWith('/admin')
          ? redirect.replace(/^\/admin/, '') || '/'
          : '/'
      navigate({ to: target, replace: true })
    } catch (err) {
      auth.reset()
      if (err instanceof ApiError) {
        setError(err.status === 429 ? err.message : '密钥无效，请重试')
      } else {
        setError('无法连接服务器，请稍后再试')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthLayout>
      <Card className='mx-auto max-w-sm'>
        <CardHeader>
          <CardTitle className='text-2xl'>登录后台</CardTitle>
          <CardDescription>
            输入管理员密钥（服务器环境变量 UPDATE_ADMIN_TOKEN）
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className='grid gap-4'>
            <div className='grid gap-2'>
              <Label htmlFor='admin-token'>管理员密钥</Label>
              <PasswordInput
                id='admin-token'
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder='UPDATE_ADMIN_TOKEN 的值'
                autoComplete='current-password'
                required
                autoFocus
              />
            </div>
            {error && (
              <Alert variant='destructive'>
                <CircleAlert className='size-4' aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button
              type='submit'
              className='w-full'
              disabled={loading || !token.trim()}
            >
              {loading ? '验证中…' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
