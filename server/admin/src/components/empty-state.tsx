import { cn } from '@/lib/utils'

type EmptyStateProps = {
  icon: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-16 text-center',
        className
      )}
    >
      <div className='flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground'>
        {icon}
      </div>
      <p className='mt-2 text-sm font-medium'>{title}</p>
      {description && (
        <p className='text-sm text-muted-foreground'>{description}</p>
      )}
      {action && <div className='mt-4'>{action}</div>}
    </div>
  )
}
