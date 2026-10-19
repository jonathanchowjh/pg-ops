import type { ComponentProps } from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// shadcn's Badge with its `useRender` indirection removed. Stock shadcn
// routes Badge through @base-ui/react solely to support a polymorphic
// `render` prop, which no Badge in this app uses. A plain <span> keeps every
// cva variant. test/badge.test.tsx stops the dependency being reintroduced.

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        // `critical-ink`, not `destructive`: destructive on its own 10% tint
        // is 3.99:1 in light mode, below the floor for text this size. See
        // globals.css and tokens.test.ts. The ring keeps `destructive`, which
        // is a fill and not text.
        destructive:
          "bg-critical-ink/10 text-critical-ink focus-visible:ring-destructive/20 dark:bg-critical-ink/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-critical-ink/20",
        // Not in stock shadcn. The same idiom as `destructive` — a tinted
        // fill under same-hue text — at two more hues. See globals.css.
        warning:
          "bg-warning-ink/10 text-warning-ink dark:bg-warning-ink/20 [a]:hover:bg-warning-ink/20",
        success:
          "bg-success-ink/10 text-success-ink dark:bg-success-ink/20 [a]:hover:bg-success-ink/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
