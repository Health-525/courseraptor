import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { type Table } from '@tanstack/react-table'
import { Trash2, UserX, UserCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useInvalidateBootstrap } from '@/lib/admin-data'
import { userAction } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DataTableBulkActions as BulkActionsToolbar } from '@/components/data-table'
import { type User } from '../data/schema'
import { UsersMultiDeleteDialog } from './users-multi-delete-dialog'

type DataTableBulkActionsProps = {
  table: Table<User>
}

export function DataTableBulkActions({ table }: DataTableBulkActionsProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const invalidate = useInvalidateBootstrap()
  const selectedRows = table.getFilteredSelectedRowModel().rows

  const bulkStatus = useMutation({
    mutationFn: async (action: 'enable' | 'disable') => {
      let failed = 0
      for (const row of selectedRows) {
        try {
          await userAction(action, row.original.id)
        } catch {
          failed += 1
        }
      }
      return { failed, action }
    },
    onSuccess: ({ failed, action }) => {
      const n = selectedRows.length
      table.resetRowSelection()
      void invalidate()
      if (failed > 0) {
        toast.error(
          `${action === 'enable' ? '启用' : '停用'} ${n - failed} 个，${failed} 个失败`
        )
      } else {
        toast.success(`已${action === 'enable' ? '启用' : '停用'} ${n} 个账号`)
      }
    },
  })

  return (
    <>
      <BulkActionsToolbar table={table} entityName='个账号'>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant='outline'
              size='icon'
              onClick={() => bulkStatus.mutate('enable')}
              className='size-8'
              aria-label='启用选中的账号'
              title='启用选中的账号'
            >
              <UserCheck />
              <span className='sr-only'>启用选中的账号</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>启用选中的账号</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant='outline'
              size='icon'
              onClick={() => bulkStatus.mutate('disable')}
              className='size-8'
              aria-label='停用选中的账号'
              title='停用选中的账号'
            >
              <UserX />
              <span className='sr-only'>停用选中的账号</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>停用选中的账号</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant='destructive'
              size='icon'
              onClick={() => setShowDeleteConfirm(true)}
              className='size-8'
              aria-label='删除选中的账号'
              title='删除选中的账号'
            >
              <Trash2 />
              <span className='sr-only'>删除选中的账号</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>删除选中的账号</p>
          </TooltipContent>
        </Tooltip>
      </BulkActionsToolbar>

      <UsersMultiDeleteDialog
        table={table}
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
      />
    </>
  )
}
