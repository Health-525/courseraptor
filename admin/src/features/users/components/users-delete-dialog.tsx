'use client'

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { useInvalidateBootstrap } from '@/lib/admin-data'
import { userAction } from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { type User } from '../data/schema'

type UserDeleteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentRow: User
}

export function UsersDeleteDialog({
  open,
  onOpenChange,
  currentRow,
}: UserDeleteDialogProps) {
  const [value, setValue] = useState('')
  const invalidate = useInvalidateBootstrap()

  const remove = useMutation({
    mutationFn: () => userAction('delete', currentRow.id),
    onSuccess: () => {
      toast.success(`已删除 ${currentRow.username}（含数据目录）`)
      setValue('')
      onOpenChange(false)
      void invalidate()
    },
  })

  const handleDelete = () => {
    if (value.trim() !== currentRow.username) return
    remove.mutate()
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setValue('')
        onOpenChange(v)
      }}
      handleConfirm={handleDelete}
      disabled={value.trim() !== currentRow.username}
      isLoading={remove.isPending}
      title={
        <span className='text-destructive'>
          <AlertTriangle
            className='stroke-destructive me-1 inline-block'
            size={18}
          />{' '}
          删除用户
        </span>
      }
      desc={
        <div className='space-y-4'>
          <p className='mb-2'>
            确定删除 <span className='font-bold'>{currentRow.username}</span>{' '}
            吗？
            <br />
            账号、登录凭证与其专属数据目录将一并删除。
          </p>

          <Label className='my-2'>
            用户名：
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder='输入用户名确认删除'
            />
          </Label>

          <Alert variant='destructive'>
            <AlertTitle>警告</AlertTitle>
            <AlertDescription>此操作不可恢复，请谨慎执行。</AlertDescription>
          </Alert>
        </div>
      }
      confirmText='删除'
      destructive
    />
  )
}
