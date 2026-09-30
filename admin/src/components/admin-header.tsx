import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Header } from '@/components/layout/header'
import { ThemeSwitch } from '@/components/theme-switch'
import { ConfigDrawer } from '@/components/config-drawer'
import { useBootstrap, useInvalidateBootstrap } from '@/lib/admin-data'
import { fmtUptime } from '@/lib/format'

/**
 * 全站统一的页头：左侧眉题 + 页面标题，右侧运行信息胶囊 / 刷新 / 主题。
 * （移动端也可见——刷新和主题不再像旧版那样在手机上不可达）
 */
export function AdminHeader({
  title,
  pretitle = 'ADMIN',
}: {
  title: string
  pretitle?: string
}) {
  const { data, isFetching } = useBootstrap()
  const invalidate = useInvalidateBootstrap()

  const meta = data?.overview

  return (
    <Header fixed>
      <div className='flex min-w-0 flex-col gap-0.5'>
        <span className='text-muted-foreground/70 text-[10px] font-semibold tracking-[0.18em]'>
          {pretitle}
        </span>
        <span className='truncate text-lg leading-tight font-bold tracking-tight'>
          {title}
        </span>
      </div>
      <div className='ms-auto flex items-center gap-1.5'>
        {meta && (
          <span className='text-muted-foreground hidden max-w-72 items-center gap-1.5 truncate rounded-full border px-3 py-1 font-mono text-[11px] tabular-nums md:inline-flex'>
            <span className='bg-primary size-1.5 rounded-full' />
            v{meta.version}
            <span className='text-muted-foreground/40'>·</span>
            运行 {fmtUptime(meta.uptimeSec)}
            <span className='text-muted-foreground/40'>·</span>
            实例 {meta.online}/{meta.capacity}
          </span>
        )}
        <Button
          variant='ghost'
          size='icon'
          className='rounded-full'
          aria-label='刷新数据'
          disabled={isFetching}
          onClick={() => void invalidate()}
        >
          {isFetching ? (
            <Loader2 className='size-[1.2rem] animate-spin' />
          ) : (
            <RefreshCw className='size-[1.2rem]' />
          )}
        </Button>
        <ThemeSwitch />
        <ConfigDrawer />
      </div>
    </Header>
  )
}
