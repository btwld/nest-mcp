import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { Providers } from "@/app/providers";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MCP Manager",
  description: "Private console for managed MCP servers.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html className={`${geistSans.variable} ${geistMono.variable}`} lang="en">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
