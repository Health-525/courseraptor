import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useInvalidateBootstrap } from '@/lib/admin-data'
import { userAction } from '@/lib/api'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { type User } from '../data/schema'

const copy = {
  disable: {
    title: '停用账号',
    desc: (u: User) =>
      `停用后 ${u.username} 将立即无法登录（在线实例也会被拒绝）。确认停用？`,
    confirm: '停用',
    done: (u: User) => `已停用 ${u.username}`,
  },
  enable: {
    title: '启用账号',
    desc: (u: User) => `恢复 ${u.username} 的登录权限。`,
    confirm: '启用',
    done: (u: User) => `已启用 ${u.username}`,
  },
  kick: {
    title: '回收实例',
    desc: (u: User) =>
      `立即结束 ${u.username} 的专属实例进程，同学正在用的对话会中断（下次登录自动拉起）。`,
    confirm: '回收',
    done: (u: User) => `已回收 ${u.username} 的实例`,
  },
} as const

type UserConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentRow: User
  action: 'disable' | 'enable' | 'kick' | null
}

export function UserConfirmDialog({
  open,
  onOpenChange,
  currentRow,
  action,
}: UserConfirmDialogProps) {
  const invalidate = useInvalidateBootstrap()
  const act = useMutation({
    mutationFn: () => {
      if (!action) throw new Error('no action')
      return userAction(action, currentRow.id)
    },
    onSuccess: () => {
      if (action) toast.success(copy[action].done(currentRow))
      onOpenChange(false)
      void invalidate()
    },
  })

  if (!action) return null
  const c = copy[action]

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      handleConfirm={() => act.mutate()}
      isLoading={act.isPending}
      title={c.title}
      desc={c.desc(currentRow)}
      confirmText={c.confirm}
      destructive={action !== 'enable'}
      className='sm:max-w-sm'
    />
  )
}
