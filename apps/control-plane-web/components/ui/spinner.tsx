import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

export function Spinner({ className }: { readonly className?: string }) {
  return <LoaderCircle aria-hidden className={cn("size-4 animate-spin", className)} />;
}
