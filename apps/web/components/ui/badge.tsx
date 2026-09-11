import type { ComponentProps } from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// This file is shadcn's Badge with its `useRender` indirection removed.
//
// Stock shadcn routes Badge through @base-ui/react's `useRender` solely to
// support a polymorphic `render` prop. When this was written the repo carried
// two react majors, and that package hoisted to the repo ROOT next to the Ink
// TUI's react 18 with no copy nested under apps/web — so its hooks ran
// against react 18's dispatcher while this tree rendered under the app's
// react 19, and EVERY render threw "Cannot read properties of null (reading
// 'useRef')" with a stack pointing at ../../node_modules/react. The same
// defect class as the one documented in test/render.tsx, reached through a
// different package.
//
// P1b deleted the TUI, so that mis-resolution can no longer happen. This file
// still does not use the primitive: the `render` prop was never wanted here,
// and a vendored <span> has nothing to resolve at all. See test/badge.test.tsx.
//
// Aliasing, deduping and inlining were all tried for that earlier case and
// all failed, because the hoisting is physical rather than a resolution
// preference. But shadcn VENDORS component source into the repo instead of
// installing a package — that is the entire reason for choosing it — so the
// component is ours to own. A plain <span> keeps every cva variant, which is
// the actual value here, and drops a primitive this console never uses: not
// one Badge in the app is polymorphic.
//
// badge.test.tsx is what stops the dependency being reintroduced.

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        // The two variants stock shadcn has no opinion about, because stock
        // shadcn is not a severity scale. `destructive` above already
        // established the idiom — a tinted fill under same-hue text — so
        // these are that idiom at two more hues, not a new mechanism. See
        // globals.css for why the grayscale palette could not express this.
        warning:
          "bg-warning/10 text-warning dark:bg-warning/20 [a]:hover:bg-warning/20",
        success:
          "bg-success/10 text-success dark:bg-success/20 [a]:hover:bg-success/20",
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
