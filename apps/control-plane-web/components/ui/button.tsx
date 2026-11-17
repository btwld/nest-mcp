import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent text-sm font-medium outline-none transition-all focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/85",
        outline: "border-border bg-background hover:bg-muted",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/75",
        ghost: "hover:bg-muted",
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2.5 text-xs",
        lg: "h-10 px-4",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export function Button({
  className,
  variant,
  size,
  loading = false,
  loadingText,
  disabled,
  children,
  ...props
}: ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    readonly loading?: boolean;
    readonly loadingText?: React.ReactNode;
  }) {
  return (
    <ButtonPrimitive
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      data-slot="button"
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <Spinner />
          {loadingText ?? children}
        </>
      ) : (
        children
      )}
    </ButtonPrimitive>
  );
}
