import { createFileRoute } from '@tanstack/react-router'
import { Keys } from '@/features/keys'

export const Route = createFileRoute('/_authenticated/keys/')({
  component: Keys,
})
