"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "sonner";

import { ControlPlaneApiError } from "@/lib/control-plane-api";

function shouldRetry(failureCount: number, error: Error): boolean {
  if (failureCount >= 1) return false;
  if (!(error instanceof ControlPlaneApiError)) return true;
  return error.status === 0 || [408, 425, 429].includes(error.status) || error.status >= 500;
}

export function Providers({ children }: { readonly children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: shouldRetry,
            staleTime: 5_000,
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster closeButton position="bottom-right" richColors />
    </QueryClientProvider>
  );
}
