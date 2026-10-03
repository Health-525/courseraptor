import {
  Gauge,
  KeyRound,
  MonitorSmartphone,
  Rocket,
  ScrollText,
  Settings2,
  ShieldCheck,
  Ticket,
  Users,
} from 'lucide-react'
import { useBootstrap } from '@/lib/admin-data'
import { Badge } from '@/components/ui/badge'
import { type SidebarData } from '../types'

/** 待审批重置数角标：跟随 bootstrap 数据自动更新，为 0 时整个不渲染 */
function ResetBadge() {
  const { data } = useBootstrap()
  const count = data?.overview.pendingResets ?? 0
  if (count <= 0) return null
  return (
    <Badge
      variant='destructive'
      className='ms-auto rounded-full px-1.5 py-0 text-xs'
    >
      {count}
    </Badge>
  )
}

export const sidebarData: SidebarData = {
  navGroups: [
    {
      title: '总览',
      items: [
        {
          title: '概览',
          url: '/',
          icon: Gauge,
        },
      ],
    },
    {
      title: '管理',
      items: [
        {
          title: '用户',
          url: '/users',
          icon: Users,
        },
        {
          title: '邀请码',
          url: '/invites',
          icon: Ticket,
        },
        {
          title: '重置审批',
          url: '/resets',
          icon: KeyRound,
          badge: <ResetBadge />,
        },
      ],
    },
    {
      title: '配置',
      items: [
        {
          title: '站点设置',
          url: '/site',
          icon: Settings2,
        },
        {
          title: '安全设置',
          url: '/security',
          icon: ShieldCheck,
        },
      ],
    },
    {
      title: '发布',
      items: [
        {
          title: '版本发布',
          url: '/release',
          icon: Rocket,
        },
        {
          title: '密钥管理',
          url: '/keys',
          icon: KeyRound,
        },
      ],
    },
    {
      title: '系统',
      items: [
        {
          title: '本地版监控',
          url: '/local-usage',
          icon: MonitorSmartphone,
        },
        {
          title: '操作日志',
          url: '/log',
          icon: ScrollText,
        },
      ],
    },
  ],
}
