import { createFileRoute, redirect } from '@tanstack/react-router'
import { getSession } from '@/lib/api'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'

/**
 * 会话守卫：每次进入受保护页面前探测 /admin/api/session。
 * 会话过期（12 小时 TTL 或两步验证开关导致的 epoch 失效）即跳登录页，
 * 登录后回到原页面。
 */
export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location }) => {
    const session = await getSession().catch(() => null)
    if (!session?.authed) {
      throw redirect({ to: '/sign-in', search: { redirect: location.href } })
    }
  },
  component: AuthenticatedLayout,
})
