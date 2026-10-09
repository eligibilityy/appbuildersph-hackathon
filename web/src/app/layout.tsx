import type { Metadata } from "next";
import "./globals.css";

// System fonts only — no next/font/google or any remote font (must work with Wi-Fi off).
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
      <body className="antialiased">{children}</body>
    </html>
  );
}
