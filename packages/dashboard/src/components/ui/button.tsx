import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils.js'

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-card text-foreground hover:bg-secondary dark:bg-muted dark:text-foreground dark:hover:bg-muted',
        outline:
          'border border-border bg-transparent text-foreground hover:bg-secondary hover:text-foreground dark:border-border dark:text-muted-foreground dark:hover:bg-secondary dark:hover:text-foreground',
        ghost:
          'text-foreground hover:bg-secondary hover:text-foreground dark:text-muted-foreground dark:hover:bg-secondary dark:hover:text-foreground',
        destructive:
          'bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-700 dark:hover:bg-rose-800',
        link: 'text-sky-600 underline-offset-4 hover:underline dark:text-sky-400',
      },
      size: {
        default: 'h-8 px-3 py-1',
        sm: 'h-7 px-2 text-xs',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { buttonVariants }
