import { createFileRoute } from '@tanstack/react-router'
import { LocalUsagePage } from '@/features/local-usage'

export const Route = createFileRoute('/_authenticated/local-usage/')({
  component: LocalUsagePage,
})
