import { createFileRoute } from '@tanstack/react-router'
import { ReleasePage } from '@/features/release'

export const Route = createFileRoute('/_authenticated/release/')({
  component: ReleasePage,
})
