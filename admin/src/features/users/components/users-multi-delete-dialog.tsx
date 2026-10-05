'use client'

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { type Table } from '@tanstack/react-table'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { useInvalidateBootstrap } from '@/lib/admin-data'
import { userAction } from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { type User } from '../data/schema'

type UserMultiDeleteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  table: Table<User>
}

const CONFIRM_WORD = 'DELETE'

export function UsersMultiDeleteDialog({
  open,
  onOpenChange,
  table,
}: UserMultiDeleteDialogProps) {
  const [value, setValue] = useState('')
  const invalidate = useInvalidateBootstrap()

  const selectedRows = table.getFilteredSelectedRowModel().rows

  const remove = useMutation({
    mutationFn: async () => {
      // 逐个删除：网关侧每次删除含回收实例+除名+清数据目录
      let failed = 0
      for (const row of selectedRows) {
        try {
          await userAction('delete', row.original.id)
        } catch {
          failed += 1
        }
      }
      return { failed }
    },
    onSuccess: ({ failed }) => {
      const n = selectedRows.length
      onOpenChange(false)
      setValue('')
      table.resetRowSelection()
      if (failed > 0) {
        toast.error(`已删 ${n - failed} 个，${failed} 个失败（详见操作日志）`)
      } else {
        toast.success(`已删除 ${n} 个用户（含数据目录）`)
      }
      void invalidate()
    },
  })

  const handleDelete = () => {
    if (value.trim() !== CONFIRM_WORD) {
      toast.error(`请输入 ${CONFIRM_WORD} 确认`)
      return
    }
    remove.mutate()
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      form='users-multi-delete-form'
      disabled={value.trim() !== CONFIRM_WORD || remove.isPending}
      title={
        <span className='text-destructive'>
          <AlertTriangle
            className='me-1 inline-block stroke-destructive'
            size={18}
          />{' '}
          删除 {selectedRows.length} 个用户
        </span>
      }
      desc={
        <form
          id='users-multi-delete-form'
          onSubmit={(e) => {
            e.preventDefault()
            handleDelete()
          }}
          className='space-y-4'
        >
          <p className='mb-2'>
            确定删除选中的 {selectedRows.length} 个用户吗？
            <br />
            账号、登录凭证与专属数据目录将一并删除。
          </p>

          <Label className='my-4 flex flex-col items-start gap-1.5'>
            <span className=''>输入 {CONFIRM_WORD} 确认：</span>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={`输入 ${CONFIRM_WORD} 确认`}
              autoFocus
            />
          </Label>

          <Alert variant='destructive'>
            <AlertTitle>警告</AlertTitle>
            <AlertDescription>此操作不可恢复，请谨慎执行。</AlertDescription>
          </Alert>
        </form>
      }
      confirmText='删除'
      destructive
    />
  )
}
