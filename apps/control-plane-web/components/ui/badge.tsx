import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        mono: "border-border font-mono text-[10px] text-muted-foreground",
        success: "border-transparent bg-success/10 text-success",
        warning: "border-transparent bg-warning/12 text-warning-foreground",
        destructive: "border-transparent bg-destructive/10 text-destructive",
        info: "border-transparent bg-info/10 text-info",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} data-slot="badge" {...props} />
  );
}
