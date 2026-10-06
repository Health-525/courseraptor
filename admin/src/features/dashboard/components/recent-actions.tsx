import { Link } from '@tanstack/react-router'
import { useBootstrap } from '@/lib/admin-data'

/** 最近管理动作（admin-log 前几条，全部见「操作日志」） */
export function RecentActions() {
  const { data } = useBootstrap()
  const entries = (data?.log ?? []).slice(0, 6)

  return (
    <div className='space-y-6'>
      {entries.length === 0 && (
        <p className='text-sm text-muted-foreground'>还没有管理操作记录</p>
      )}
      {entries.map((entry) => (
        <div
          key={`${entry.at}-${entry.text}`}
          className='flex items-center gap-4'
        >
          <div className='flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary'>
            管
          </div>
          <div className='flex flex-1 flex-wrap items-center justify-between gap-1'>
            <div className='min-w-0 space-y-1'>
              <p className='truncate text-sm leading-none font-medium'>
                {entry.text}
              </p>
              <p className='text-sm text-muted-foreground'>
                {new Date(entry.at).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
          </div>
        </div>
      ))}
      <div className='text-sm text-muted-foreground'>
        <Link
          to='/log'
          className='underline underline-offset-4 hover:text-primary'
        >
          查看全部操作日志
        </Link>
      </div>
    </div>
  )
}
