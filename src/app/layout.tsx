import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Work IQ, out loud",
  description: "Talk to your Microsoft 365 workplace data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
