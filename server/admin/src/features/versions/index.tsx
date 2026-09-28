import { useState } from 'react'
import { format } from 'date-fns'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, type VersionEntry } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import useDialogState from '@/hooks/use-dialog-state'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : format(date, 'yyyy-MM-dd HH:mm')
}

type PendingAction =
  | { kind: 'rollback'; entry: VersionEntry }
  | { kind: 'delete'; entry: VersionEntry }

export function Versions() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useDialogState()
  const [pending, setPending] = useState<PendingAction | null>(null)
  const { data, isPending } = useQuery({
    queryKey: ['versions'],
    queryFn: api.versions,
  })

  const refresh = () => queryClient.invalidateQueries()

  const rollbackMutation = useMutation({
    mutationFn: (version: string) => api.rollback(version),
    onSuccess: (_data, version) => {
      toast.success(`已回滚到 v${version}`, {
        description: '学生端将下载该版本',
      })
      refresh()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (version: string) => api.deleteVersion(version),
    onSuccess: (_data, version) => {
      toast.success(`v${version} 已删除`)
      refresh()
    },
  })

  function ask(action: PendingAction) {
    setPending(action)
    setOpen(true)
  }

  function handleConfirm() {
    if (!pending) return
    if (pending.kind === 'rollback') rollbackMutation.mutate(pending.entry.version)
    else deleteMutation.mutate(pending.entry.version)
  }

  const versions = data?.versions ?? []

  return (
    <>
      <Header>
        <div className='me-auto' />
        <Search placeholder='搜索功能' />
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>

      <Main>
        <div className='mb-2 flex items-center justify-between space-y-2'>
          <h1 className='text-2xl font-bold tracking-tight'>历史版本</h1>
        </div>

        {isPending ? (
          <Skeleton className='h-64 rounded-xl' />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>版本列表</CardTitle>
              <CardDescription>
                服务器 update-data 目录中的全部安装包；回滚把当前分发版本指回历史包
              </CardDescription>
            </CardHeader>
            {versions.length === 0 ? (
              <div className='px-6 pb-6 text-sm text-muted-foreground'>
                还没有发布过版本。
              </div>
            ) : (
              <div className='overflow-x-auto px-6 pb-6'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>版本</TableHead>
                      <TableHead>大小</TableHead>
                      <TableHead>发布时间</TableHead>
                      <TableHead className='max-w-64'>更新说明</TableHead>
                      <TableHead className='text-end'>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {versions.map((entry) => (
                      <TableRow key={entry.version}>
                        <TableCell className='font-mono font-medium'>
                          v{entry.version}
                          {entry.isCurrent && (
                            <Badge className='ms-2' variant='default'>
                              当前
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>{formatBytes(entry.sizeBytes)}</TableCell>
                        <TableCell>{formatTime(entry.publishedAt)}</TableCell>
                        <TableCell
                          className='max-w-64 truncate text-muted-foreground'
                          title={entry.notes}
                        >
                          {entry.notes || '—'}
                        </TableCell>
                        <TableCell className='text-end'>
                          {entry.isCurrent ? (
                            <span className='text-muted-foreground'>—</span>
                          ) : (
                            <div className='flex justify-end gap-1'>
                              <Button
                                variant='ghost'
                                size='icon'
                                title='回滚到此版本'
                                onClick={() => ask({ kind: 'rollback', entry })}
                              >
                                <History className='size-4' />
                              </Button>
                              <Button
                                variant='ghost'
                                size='icon'
                                title='删除此版本'
                                onClick={() => ask({ kind: 'delete', entry })}
                              >
                                <Trash2 className='size-4 text-destructive' />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        )}
      </Main>

      <ConfirmDialog
        open={Boolean(open)}
        onOpenChange={setOpen}
        title={pending?.kind === 'delete' ? '删除版本' : '回滚版本'}
        desc={
          pending?.kind === 'delete'
            ? `确定删除 v${pending.entry.version} 吗？安装包将从服务器移除，不可恢复。`
            : `确定回滚到 v${pending?.entry.version} 吗？学生端将下载该版本。`
        }
        confirmText={pending?.kind === 'delete' ? '删除' : '回滚'}
        destructive={pending?.kind === 'delete'}
        handleConfirm={handleConfirm}
        className='sm:max-w-sm'
      />
    </>
  )
}
