import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AdminHeader } from '@/components/admin-header'
import { Main } from '@/components/layout/main'
import { useBootstrap, useInvalidateBootstrap } from '@/lib/admin-data'
import { siteSaveKey } from '@/lib/api'
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
import { Skeleton } from '@/components/ui/skeleton'

/** 站点设置：统一 DeepSeek Key（三层优先级的中间层）+ 限额分账 */
export function SitePage() {
  const { data, isLoading } = useBootstrap()
  const invalidate = useInvalidateBootstrap()
  const [key, setKey] = useState('')
  const [confirming, setConfirming] = useState(false)

  const save = useMutation({
    mutationFn: () => siteSaveKey(key.trim()),
    onSuccess: () => {
      toast.success('站点 Key 已保存（新拉起的实例立即使用）')
      setKey('')
      setConfirming(false)
      void invalidate()
    },
  })

  const site = data?.site
  const o = data?.overview

  const stateLine = isLoading ? (
    <Skeleton className='h-5 w-64' />
  ) : site?.deepseekKeySet ? (
    <p className='text-sm'>
      面板已设置 <code className='bg-muted rounded px-1.5 py-0.5 font-mono text-xs'>{site.deepseekKeyMasked}</code>
    </p>
  ) : site?.envDeepseekKeySet ? (
    <p className='text-sm'>
      面板未设置，回退服务器 env 的 <code className='bg-muted rounded px-1.5 py-0.5 font-mono text-xs'>GATEWAY_DEEPSEEK_KEY</code>
    </p>
  ) : (
    <p className='text-sm text-red-600 dark:text-red-400'>
      未设置（面板与服务器 env 都没有 Key，同学对话将不可用）
    </p>
  )

  const pinnedCount = data?.users.filter((u) => u.dsMode === 'site').length ?? 0
  const ownActiveCount =
    data?.users.filter(
      (u) => u.dsMode !== 'site' && u.ownTurns.date === new Date().toISOString().slice(0, 10) && u.ownTurns.count > 0,
    ).length ?? 0

  return (
    <>
      <AdminHeader title='站点设置' pretitle='ADMIN · 配置' />
      <Main>
        <Card>
          <CardHeader>
            <CardTitle>站点统一 DeepSeek Key</CardTitle>
            <CardDescription>同学端「设置 → AI 模型」的统一 Key</CardDescription>
          </CardHeader>
          <CardContent className='space-y-3'>
            {stateLine}
            <div className='flex gap-2'>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder='粘贴新的 sk- 开头 Key（留空保存 = 清除面板 Key）'
                autoComplete='off'
                className='font-mono'
              />
              <Button
                className='shrink-0'
                disabled={save.isPending || (key.trim() !== '' && !(key.trim().startsWith('sk-') && key.trim().length >= 20))}
                onClick={() => (key.trim() ? setConfirming(true) : save.mutate())}
              >
                保存
              </Button>
            </div>
            <p className='text-muted-foreground text-xs'>
              保存后新拉起的实例立即使用新 Key；在线实例下次拉起时切换。同学保存自己的 Key
              后优先用自己的，不消耗站点额度。
            </p>
          </CardContent>
        </Card>

        <Card className='mt-4'>
          <CardHeader>
            <CardTitle>对话限额与分账</CardTitle>
            <CardDescription>限额只管用站点 Key 的轮数；同学自有 Key 的轮数单独记账</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className='h-24 w-full' />
            ) : (
              <div className='grid gap-3 sm:grid-cols-2'>
                <div className='flex items-center justify-between gap-4 rounded-md border px-4 py-3'>
                  <span className='text-muted-foreground text-sm'>站点默认限额</span>
                  <span className='font-semibold tabular-nums'>
                    {site?.defaultDailyTurns ?? '—'} 轮/人/日
                  </span>
                </div>
                <div className='flex items-center justify-between gap-4 rounded-md border px-4 py-3'>
                  <span className='text-muted-foreground text-sm'>今日站点账</span>
                  <span className='font-semibold tabular-nums'>
                    {o?.turnsToday ?? '—'} 轮
                  </span>
                </div>
                <div className='flex items-center justify-between gap-4 rounded-md border px-4 py-3'>
                  <span className='text-muted-foreground text-sm'>今日自有账</span>
                  <span className='font-semibold tabular-nums'>
                    {o?.ownTurnsToday ?? '—'} 轮（不限额）
                  </span>
                </div>
                <div className='flex items-center justify-between gap-4 rounded-md border px-4 py-3'>
                  <span className='text-muted-foreground text-sm'>Key 模式分布</span>
                  <span className='flex items-center gap-1.5'>
                    <Badge variant='outline'>{data?.users.length ?? 0} 人</Badge>
                    <Badge variant='secondary'>钉站点 {pinnedCount}</Badge>
                    <Badge variant='outline'>自有今日活跃 {ownActiveCount}</Badge>
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title='保存站点 Key'
          desc='确定保存这枚 DeepSeek Key 吗？新拉起的实例将立即使用它。'
          cancelBtnText='取消'
          confirmText='保存'
          isLoading={save.isPending}
          handleConfirm={() => save.mutate()}
          className='sm:max-w-sm'
        />
      </Main>
    </>
  )
}
