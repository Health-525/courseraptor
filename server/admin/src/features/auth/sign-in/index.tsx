import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { api, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { PasswordInput } from '@/components/password-input'
import { AuthLayout } from '../auth-layout'

export function SignIn() {
  const navigate = useNavigate()
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
      navigate({ to: '/', replace: true })
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
            输入服务器上的 UPDATE_ADMIN_TOKEN 管理员密钥
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className='grid gap-4'>
            <div className='grid gap-2'>
              <label htmlFor='admin-token' className='text-sm font-medium'>
                管理员密钥
              </label>
              <PasswordInput
                id='admin-token'
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder='UPDATE_ADMIN_TOKEN'
                autoComplete='current-password'
                required
                autoFocus
              />
              {error && <p className='text-sm text-destructive'>{error}</p>}
            </div>
            <Button type='submit' className='w-full' disabled={loading || !token.trim()}>
              {loading ? '验证中…' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
