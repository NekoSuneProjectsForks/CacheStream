import type { Metadata } from "next";
import "./globals.css";
import { appName } from "@/lib/app-name";

export const metadata: Metadata = {
  title: appName(),
  description: "Headless Twitch streaming control panel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
