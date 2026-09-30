import { createFileRoute } from '@tanstack/react-router'
import { LogPage } from '@/features/log'

export const Route = createFileRoute('/_authenticated/log/')({
  component: LogPage,
})
