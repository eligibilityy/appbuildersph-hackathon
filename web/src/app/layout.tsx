import type { Metadata } from "next";
// Open Runde, bundled from npm (@fontsource) — no Google Fonts or CDN; works with Wi-Fi off.
import "@fontsource/open-runde/400.css";
import "@fontsource/open-runde/500.css";
import "@fontsource/open-runde/600.css";
import "@fontsource/open-runde/700.css";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "Memory Aid",
  description: "On-device face memory aid",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster position="top-center" theme="light" />
      </body>
    </html>
  );
}
