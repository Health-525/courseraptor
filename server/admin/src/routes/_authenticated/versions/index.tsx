import { createFileRoute } from '@tanstack/react-router'
import { Versions } from '@/features/versions'

export const Route = createFileRoute('/_authenticated/versions/')({
  component: Versions,
})
