import { createFileRoute } from '@tanstack/react-router'
import { TokenUsagePage } from '@/features/token-usage'

export const Route = createFileRoute('/_authenticated/token-usage/')({
  component: TokenUsagePage,
})
