import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

// Open Runde, loaded from files in web/fonts (no Google Fonts or CDN — works with Wi-Fi off).
// next/font/local preloads it and size-matches the fallback font, so text doesn't jump on load.
const openRunde = localFont({
  src: [
    { path: "../../fonts/open-runde/OpenRunde-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/open-runde/OpenRunde-Medium.woff2", weight: "500", style: "normal" },
    { path: "../../fonts/open-runde/OpenRunde-Semibold.woff2", weight: "600", style: "normal" },
    { path: "../../fonts/open-runde/OpenRunde-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-open-runde",
  display: "swap",
  fallback: ["system-ui", "Segoe UI", "Arial", "sans-serif"],
});

export const metadata: Metadata = {
  title: { default: "Crouie", template: "%s · Crouie" },
  description:
    "Crouie helps people with dementia remember who's visiting. It recognizes faces, listens, and gently " +
    "reminds them who's there. Everything runs on this laptop, even with Wi-Fi off.",
  applicationName: "Crouie",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  manifest: "/site.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#2a9dff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={openRunde.variable}>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        {/* offset keeps toasts below the 56px header */}
        <Toaster position="top-center" theme="light" offset={72} />
      </body>
    </html>
  );
}
