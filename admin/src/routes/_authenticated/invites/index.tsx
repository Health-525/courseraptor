import { createFileRoute } from '@tanstack/react-router'
import { InvitesPage } from '@/features/invites'

export const Route = createFileRoute('/_authenticated/invites/')({
  component: InvitesPage,
})
