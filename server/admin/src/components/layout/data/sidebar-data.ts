import {
  LayoutDashboard,
  Package,
  Rocket,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: '管理员',
    email: '',
    avatar: '',
  },
  navGroups: [
    {
      title: '管理',
      items: [
        {
          title: '概览',
          url: '/',
          icon: LayoutDashboard,
        },
        {
          title: '发布新版本',
          url: '/publish',
          icon: Rocket,
        },
        {
          title: '历史版本',
          url: '/versions',
          icon: Package,
        },
      ],
    },
  ],
}
