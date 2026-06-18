import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vouch — Nightly Handover",
  description: "Action-first night-shift handover for hotel morning managers.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
