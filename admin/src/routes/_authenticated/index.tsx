import { createFileRoute } from '@tanstack/react-router'
import { Overview } from '@/features/overview'

export const Route = createFileRoute('/_authenticated/')({
  component: Overview,
})
