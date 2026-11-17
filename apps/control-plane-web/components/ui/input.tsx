import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      className={cn(
        "h-9 w-full min-w-0 rounded-lg border border-transparent bg-input/50 px-3 py-1 text-base outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm",
        className,
      )}
      data-slot="input"
      {...props}
    />
  );
}
