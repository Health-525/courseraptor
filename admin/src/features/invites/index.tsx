import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, Ticket, Trash2 } from 'lucide-react'
import { AdminHeader } from '@/components/admin-header'
import { Main } from '@/components/layout/main'
import { useBootstrap, useInvalidateBootstrap } from '@/lib/admin-data'
import { inviteCreate, inviteDelete, type Invite } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { fmtDate } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
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

/** 邀请码面板：生成（数量/备注/有效期）+ 列表（复制/删除） */
export function InvitesPage() {
  const { data, isLoading } = useBootstrap()
  const invalidate = useInvalidateBootstrap()

  const [count, setCount] = useState('5')
  const [note, setNote] = useState('')
  const [days, setDays] = useState('0')
  const [deleting, setDeleting] = useState<Invite | null>(null)

  const create = useMutation({
    mutationFn: () =>
      inviteCreate(Number(count) || 1, note.trim(), Number(days) || 0),
    onSuccess: (res) => {
      toast.success(`已生成 ${res.created.length} 个邀请码`)
      setNote('')
      void invalidate()
    },
  })

  const remove = useMutation({
    mutationFn: () => inviteDelete(deleting!.code),
    onSuccess: () => {
      toast.success('邀请码已删除')
      setDeleting(null)
      void invalidate()
    },
  })

  return (
    <>
      <AdminHeader title='邀请码' pretitle='ADMIN · 管理' />
      <Main>
        <Card>
          <CardHeader>
            <CardTitle>生成邀请码</CardTitle>
            <CardDescription>
              邀请码一次性使用；生成后复制发给同学，注册时填写。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex flex-wrap items-end gap-3'>
              <div className='grid w-24 gap-1.5'>
                <Label htmlFor='inv-count'>数量</Label>
                <Input
                  id='inv-count'
                  type='number'
                  min={1}
                  max={50}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
              </div>
              <div className='grid min-w-48 flex-1 gap-1.5'>
                <Label htmlFor='inv-note'>备注（如：班级群）</Label>
                <Input
                  id='inv-note'
                  value={note}
                  maxLength={100}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder='给谁用的，方便日后辨认'
                />
              </div>
              <div className='grid w-36 gap-1.5'>
                <Label htmlFor='inv-days'>有效天数（0=永久）</Label>
                <Input
                  id='inv-days'
                  type='number'
                  min={0}
                  max={365}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </div>
              <Button
                disabled={create.isPending || !(Number(count) >= 1 && Number(count) <= 50)}
                onClick={() => create.mutate()}
              >
                <Ticket />
                生成
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className='mt-4'>
          <CardHeader>
            <CardTitle>邀请码列表</CardTitle>
            <CardDescription>已使用或已过期的不支持删除（保留作记录）</CardDescription>
          </CardHeader>
          <CardContent className='px-0'>
            {isLoading && (
              <div className='flex flex-col gap-2 px-6 pb-4'>
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className='h-10 w-full' />
                ))}
              </div>
            )}
            {data && (
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>邀请码</TableHead>
                      <TableHead>备注</TableHead>
                      <TableHead>使用者</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className='w-24' />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.invites.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className='text-muted-foreground py-8 text-center'>
                          还没有邀请码
                        </TableCell>
                      </TableRow>
                    )}
                    {data.invites.map((inv) => (
                      <InviteRow key={inv.code} invite={inv} onDelete={() => setDeleting(inv)} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <ConfirmDialog
          open={deleting !== null}
          onOpenChange={(v) => !v && setDeleting(null)}
          title='删除邀请码'
          desc={`确定删除 ${deleting?.code ?? ''} 吗？未使用才可删除。`}
          cancelBtnText='取消'
          confirmText='删除'
          destructive
          isLoading={remove.isPending}
          handleConfirm={() => remove.mutate()}
          className='sm:max-w-sm'
        />
      </Main>
    </>
  )
}

function InviteRow({ invite, onDelete }: { invite: Invite; onDelete: () => void }) {
  const used = (invite.usedBy?.length ?? 0) >= (invite.maxUses ?? 1)
  const expired = Boolean(invite.expiresAt && new Date(invite.expiresAt) < new Date())
  const active = !used && !expired

  const status = useMemo(() => {
    if (used) return <Badge variant='secondary'>已使用</Badge>
    if (expired) return <Badge variant='destructive'>已过期</Badge>
    if (invite.expiresAt)
      return (
        <Badge variant='outline' className='font-normal'>
          {fmtDate(invite.expiresAt)} 前有效
        </Badge>
      )
    return <Badge>未使用</Badge>
  }, [used, expired, invite.expiresAt])

  const users = (invite.usedBy ?? []).filter((u) => !u.startsWith('pending-'))

  return (
    <TableRow>
      <TableCell className='font-mono'>{invite.code}</TableCell>
      <TableCell className='max-w-40 truncate'>{invite.note || '—'}</TableCell>
      <TableCell className='max-w-40 truncate'>{users.join('、') || '—'}</TableCell>
      <TableCell>{status}</TableCell>
      <TableCell>
        {active && (
          <div className='flex gap-1'>
            <Button
              variant='ghost'
              size='icon'
              className='size-8'
              aria-label='复制邀请码'
              onClick={() => void copyText(invite.code)}
            >
              <Copy />
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='text-destructive size-8'
              aria-label='删除邀请码'
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  )
}
