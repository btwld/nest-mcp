import { cn } from "@/lib/utils";

/* eslint-disable jsx-a11y/label-has-associated-control -- Association is supplied by callers through htmlFor or nested controls. */
export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn("text-sm leading-none font-medium", className)}
      data-slot="label"
      {...props}
    />
  );
}
