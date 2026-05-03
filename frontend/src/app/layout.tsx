import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LLM Security Lab",
  description: "Prompt Injection CTF — Learn AI security by doing",
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
