import { type ColumnDef } from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DataTableColumnHeader } from '@/components/data-table'
import { LongText } from '@/components/long-text'
import { callTypes, keySourceOptions } from '../data/data'
import { type User, type UserStatus } from '../data/schema'
import { DataTableRowActions } from './data-table-row-actions'

/** 状态派生：停用 > 在线 > 正常（与筛选 facet 同一枚举） */
export function deriveStatus(u: User): UserStatus {
  if (u.disabled) return 'disabled'
  if (u.online) return 'online'
  return 'active'
}

const today = () => new Date().toISOString().slice(0, 10)

export const usersColumns: ColumnDef<User>[] = [
  {
    id: 'select',
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && 'indeterminate')
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label='全选'
        className='translate-y-[2px]'
      />
    ),
    meta: {
      className: cn('max-md:sticky start-0 z-10 rounded-tl-[inherit]'),
    },
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label='选中该行'
        className='translate-y-[2px]'
      />
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: 'username',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='用户名' />
    ),
    cell: ({ row }) => (
      <LongText className='max-w-36 ps-3'>{row.getValue('username')}</LongText>
    ),
    meta: {
      className: cn(
        'drop-shadow-[0_1px_2px_rgb(0_0_0_/_0.1)] dark:drop-shadow-[0_1px_2px_rgb(255_255_255_/_0.1)]',
        'ps-0.5 max-md:sticky start-6 @4xl/content:table-cell @4xl/content:drop-shadow-none'
      ),
    },
    enableHiding: false,
  },
  {
    id: 'status',
    accessorFn: (row) => deriveStatus(row),
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='状态' />
    ),
    cell: ({ row }) => {
      const status = deriveStatus(row.original)
      const badgeColor = callTypes.get(status)
      const label =
        status === 'disabled' ? '已停用' : status === 'online' ? '在线' : '正常'
      return (
        <div className='flex space-x-2'>
          <Badge variant='outline' className={cn(badgeColor)}>
            {label}
          </Badge>
        </div>
      )
    },
    filterFn: (row, id, value) => {
      return value.includes(row.getValue(id))
    },
    enableHiding: false,
    enableSorting: false,
  },
  {
    id: 'keySource',
    accessorFn: (row) => (row.dsMode === 'site' ? 'site' : 'own'),
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='Key 来源' />
    ),
    cell: ({ row }) => {
      const src = row.original.dsMode === 'site' ? 'site' : 'own'
      const opt = keySourceOptions.find((o) => o.value === src)
      return <Badge variant='secondary'>{opt?.label ?? '—'}</Badge>
    },
    filterFn: (row, id, value) => {
      return value.includes(row.getValue(id))
    },
    enableHiding: false,
    enableSorting: false,
  },
  {
    accessorKey: 'createdAt',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='注册于' />
    ),
    cell: ({ row }) => (
      <div className='text-muted-foreground w-fit ps-2 text-sm text-nowrap'>
        {new Date(row.getValue('createdAt')).toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </div>
    ),
  },
  {
    id: 'turnsToday',
    accessorFn: (row) => (row.turns.date === today() ? row.turns.count : 0),
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='今日轮数' />
    ),
    cell: ({ row }) => {
      const u = row.original
      const turns = u.turns.date === today() ? u.turns.count : 0
      const own = u.ownTurns.date === today() ? u.ownTurns.count : 0
      return (
        <span className='tabular-nums'>
          {turns}
          {own > 0 && (
            <Badge variant='outline' className='ms-1 text-[10px]'>
              +自{own}
            </Badge>
          )}
        </span>
      )
    },
  },
  {
    id: 'instance',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='专属实例' />
    ),
    cell: ({ row }) => {
      const u = row.original
      if (!u.online) {
        return <span className='text-muted-foreground text-xs'>离线</span>
      }
      const started = u.startedAt
        ? new Date(u.startedAt).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '—'
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className='inline-flex items-center gap-1.5 text-xs'>
              <span className='inline-block size-2 rounded-full bg-green-500' />
              在线
            </span>
          </TooltipTrigger>
          <TooltipContent>
            启动 {started}
            {u.restarts ? ` · 曾重启 ${u.restarts} 次` : ''}
          </TooltipContent>
        </Tooltip>
      )
    },
    enableSorting: false,
  },
  {
    id: 'actions',
    cell: DataTableRowActions,
  },
]
