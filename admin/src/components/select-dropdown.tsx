import { useFormContext } from 'react-hook-form'
import { Loader } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FormControl } from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type SelectDropdownProps = {
  onValueChange?: (value: string) => void
  defaultValue: string | undefined
  placeholder?: string
  isPending?: boolean
  items: { label: string; value: string }[] | undefined
  disabled?: boolean
  className?: string
  isControlled?: boolean
}

export function SelectDropdown({
  defaultValue,
  onValueChange,
  isPending,
  items,
  placeholder,
  disabled,
  className = '',
  isControlled = false,
}: SelectDropdownProps) {
  // FormControl 依赖 react-hook-form 的 Form 上下文（useFormField 会解构
  // useFormContext() 的返回值）；在表单外使用（如站点设置页）会当场渲染崩溃，
  // 这里按上下文有无退化为裸 SelectTrigger。
  const form = useFormContext()
  const defaultState = isControlled
    ? { value: defaultValue, onValueChange }
    : { defaultValue, onValueChange }
  const trigger = (
    <SelectTrigger disabled={disabled} className={cn(className)}>
      <SelectValue placeholder={placeholder ?? 'Select'} />
    </SelectTrigger>
  )
  return (
    <Select {...defaultState}>
      {form ? <FormControl>{trigger}</FormControl> : trigger}
      <SelectContent>
        {isPending ? (
          <SelectItem disabled value='loading' className='h-14'>
            <div className='flex items-center justify-center gap-2'>
              <Loader className='h-5 w-5 animate-spin' />
              {'  '}
              Loading...
            </div>
          </SelectItem>
        ) : (
          items?.map(({ label, value }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  )
}
