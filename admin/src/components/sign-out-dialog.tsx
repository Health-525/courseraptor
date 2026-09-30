import { useState } from 'react'
import { useNavigate, useLocation } from '@tanstack/react-router'
import { logout } from '@/lib/api'
import { ConfirmDialog } from '@/components/confirm-dialog'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [loading, setLoading] = useState(false)

  const handleSignOut = async () => {
    setLoading(true)
    try {
      await logout()
    } catch {
      // 会话可能已过期，退出照样跳登录页
    } finally {
      setLoading(false)
      onOpenChange(false)
      navigate({
        to: '/sign-in',
        search: { redirect: location.href },
        replace: true,
      })
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title='退出登录'
      desc='确定退出管理台吗？下次进入需要重新输入密码（和动态码）。'
      cancelBtnText='取消'
      confirmText='退出'
      destructive
      isLoading={loading}
      handleConfirm={() => void handleSignOut()}
      className='sm:max-w-sm'
    />
  )
}
