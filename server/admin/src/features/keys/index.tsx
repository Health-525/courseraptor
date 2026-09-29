import { useState } from 'react'
import { format } from 'date-fns'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, type AdminKey } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : format(date, 'yyyy-MM-dd HH:mm')
}

export function Keys() {
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useDialogState()
  const [deleteOpen, setDeleteOpen] = useDialogState()
  const [name, setName] = useState('')
  // 创建成功后暂存明文，用于一次性展示；关闭对话框即清空
  const [created, setCreated] = useState<{ name: string; token: string } | null>(
    null
  )
  const [pendingDelete, setPendingDelete] = useState<AdminKey | null>(null)

  const { data, isPending } = useQuery({
    queryKey: ['keys'],
    queryFn: api.keys,
  })

  const createMutation = useMutation({
    mutationFn: (keyName: string) => api.createKey(keyName),
    onSuccess: (result) => {
      setCreated({ name: result.key.name, token: result.token })
      setName('')
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (key: AdminKey) => api.deleteKey(key.id),
    onSuccess: (_data, key) => {
      toast.success(`「${key.name}」已删除`)
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  function openCreate() {
    setCreated(null)
    setName('')
    setCreateOpen(true)
  }

  function closeCreate() {
    setCreateOpen(null)
    setCreated(null)
    setName('')
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (createMutation.isPending) return
    createMutation.mutate(name.trim())
  }

  async function copyToken() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.token)
      toast.success('已复制到剪贴板')
    } catch {
      toast.error('复制失败，请手动选中复制')
    }
  }

  function askDelete(key: AdminKey) {
    setPendingDelete(key)
    setDeleteOpen(true)
  }

  const keys = data?.keys ?? []

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
          <h1 className='text-2xl font-bold tracking-tight'>密钥管理</h1>
          <Button size='sm' onClick={openCreate}>
            <Plus className='me-1 size-4' />
            新建密钥
          </Button>
        </div>

        {isPending ? (
          <Skeleton className='h-64 rounded-xl' />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>管理员密钥</CardTitle>
              <CardDescription>
                主密钥来自服务器环境变量 UPDATE_ADMIN_TOKEN，始终可用且不能在这里删除；
                面板密钥可自由创建与删除，与主密钥权限完全相同
              </CardDescription>
            </CardHeader>
            <div className='overflow-x-auto px-6 pb-6'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>创建时间</TableHead>
                    <TableHead>最后使用</TableHead>
                    <TableHead className='text-end'>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell className='font-medium'>
                        <span className='me-2 inline-flex items-center gap-1'>
                          <KeyRound className='size-4 text-muted-foreground' />
                          {key.name}
                        </span>
                        {key.isEnv ? (
                          <Badge variant='default'>主密钥</Badge>
                        ) : (
                          <Badge variant='secondary'>面板密钥</Badge>
                        )}
                      </TableCell>
                      <TableCell>{formatTime(key.createdAt)}</TableCell>
                      <TableCell>{formatTime(key.lastUsedAt)}</TableCell>
                      <TableCell className='text-end'>
                        {key.isEnv ? (
                          <span className='text-muted-foreground'>—</span>
                        ) : (
                          <Button
                            variant='ghost'
                            size='icon'
                            title='删除此密钥'
                            onClick={() => askDelete(key)}
                          >
                            <Trash2 className='size-4 text-destructive' />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </Main>

      <Dialog
        open={Boolean(createOpen)}
        onOpenChange={(open) => (open ? openCreate() : closeCreate())}
      >
        <DialogContent className='sm:max-w-md'>
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle>密钥「{created.name}」已创建</DialogTitle>
                <DialogDescription>
                  明文仅此一次展示，关闭后无法再次查看，请立即复制保存。
                </DialogDescription>
              </DialogHeader>
              <div className='flex items-center gap-2'>
                <Input
                  readOnly
                  value={created.token}
                  className='font-mono text-xs'
                  onFocus={(e) => e.target.select()}
                />
                <Button
                  type='button'
                  variant='outline'
                  size='icon'
                  title='复制密钥'
                  onClick={copyToken}
                >
                  <Copy className='size-4' />
                </Button>
              </div>
              <DialogFooter>
                <Button type='button' onClick={closeCreate}>
                  我已保存，关闭
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>新建密钥</DialogTitle>
                <DialogDescription>
                  创建后生成一个与主密钥权限相同的管理员密钥，可用于登录面板与命令行发版。
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate} className='grid gap-4'>
                <div className='grid gap-2'>
                  <Label htmlFor='key-name'>名称（可选）</Label>
                  <Input
                    id='key-name'
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={64}
                    placeholder='例如：发布机 / 值班同学'
                    autoFocus
                  />
                  <p className='text-xs text-muted-foreground'>
                    仅用于辨认用途，最多 64 字
                  </p>
                </div>
                <DialogFooter>
                  <Button
                    type='button'
                    variant='outline'
                    onClick={closeCreate}
                    disabled={createMutation.isPending}
                  >
                    取消
                  </Button>
                  <Button type='submit' disabled={createMutation.isPending}>
                    {createMutation.isPending ? '创建中…' : '创建'}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteOpen)}
        onOpenChange={setDeleteOpen}
        title='删除密钥'
        desc={
          pendingDelete
            ? `确定删除「${pendingDelete.name}」吗？使用该密钥的登录与发版会立即失效。如果删除的是当前登录所用的密钥，需要换用其他密钥重新登录。`
            : ''
        }
        confirmText='删除'
        destructive
        isLoading={deleteMutation.isPending}
        handleConfirm={() => {
          if (pendingDelete) deleteMutation.mutate(pendingDelete)
          setDeleteOpen(null)
        }}
        className='sm:max-w-md'
      />
    </>
  )
}
