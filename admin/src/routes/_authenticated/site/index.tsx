import { createFileRoute } from '@tanstack/react-router'
import { SitePage } from '@/features/site'

export const Route = createFileRoute('/_authenticated/site/')({
  component: SitePage,
})
