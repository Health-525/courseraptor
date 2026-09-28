import { createFileRoute } from '@tanstack/react-router'
import { Publish } from '@/features/publish'

export const Route = createFileRoute('/_authenticated/publish/')({
  component: Publish,
})
