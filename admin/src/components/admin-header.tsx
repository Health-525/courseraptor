import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Header } from '@/components/layout/header'
import { ThemeSwitch } from '@/components/theme-switch'
import { ConfigDrawer } from '@/components/config-drawer'
import { useBootstrap, useInvalidateBootstrap } from '@/lib/admin-data'
import { fmtUptime } from '@/lib/format'

/**
 * 全站统一的页头：左侧页面标题，右侧 网关运行信息 / 手动刷新 / 主题。
 * （旧管理台的顶栏在手机端被隐藏，这里移动端也可见——刷新和退出不再不可达）
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
      <div className='flex min-w-0 flex-col'>
        <span className='text-muted-foreground text-xs font-medium'>
          {pretitle}
        </span>
        <span className='truncate text-base font-semibold'>{title}</span>
      </div>
      <div className='ms-auto flex items-center gap-1.5'>
        {meta && (
          <span className='text-muted-foreground hidden max-w-64 truncate text-xs md:inline'>
            v{meta.version} · 运行 {fmtUptime(meta.uptimeSec)} · 实例{' '}
            {meta.online}/{meta.capacity}
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
