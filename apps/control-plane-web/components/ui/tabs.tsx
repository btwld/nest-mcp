"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "@/lib/utils";

export function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root className={cn("flex flex-col gap-4", className)} {...props} />;
}

export function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      className={cn(
        "inline-flex h-9 w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-all hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 data-active:bg-background data-active:text-foreground data-active:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel className={cn("outline-none", className)} {...props} />;
}
