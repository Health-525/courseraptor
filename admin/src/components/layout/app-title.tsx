import { Link } from '@tanstack/react-router'
import { Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Button } from '../ui/button'

/** 迅猛龙爪痕：三道渐细的弧形爪印，CourseRaptor 的品牌记号 */
export function RaptorMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2.4'
      strokeLinecap='round'
      aria-hidden='true'
      className={className}
    >
      <path d='M5 21c1.2-5.5 1.6-11 .8-18' />
      <path d='M12 21c1.2-5.5 1.6-11 .8-18' />
      <path d='M19 21c1.2-5.5 1.6-11 .8-18' />
    </svg>
  )
}

export function AppTitle() {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size='lg'
          className='gap-0 py-0 hover:bg-transparent active:bg-transparent'
          asChild
        >
          <div>
            <Link
              to='/'
              onClick={() => setOpenMobile(false)}
              className='grid flex-1 text-start text-sm leading-tight'
            >
              <span className='flex items-center gap-2'>
                <span className='bg-sidebar-primary text-sidebar-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-md'>
                  <RaptorMark className='size-4' />
                </span>
                <span className='truncate font-bold tracking-tight'>
                  CourseRaptor
                  <span className='text-sidebar-primary font-medium'>
                    {' '}
                    · 管理台
                  </span>
                </span>
              </span>
              <span className='text-sidebar-foreground/60 mt-0.5 truncate text-[11px]'>
                班级互助服务控制台
              </span>
            </Link>
            <ToggleSidebar />
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function ToggleSidebar({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      data-sidebar='trigger'
      data-slot='sidebar-trigger'
      variant='ghost'
      size='icon'
      className={cn('aspect-square size-8 max-md:scale-125', className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <X className='md:hidden' />
      <Menu className='max-md:hidden' />
      <span className='sr-only'>展开 / 收起侧栏</span>
    </Button>
  )
}
