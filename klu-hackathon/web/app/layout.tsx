import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KLU Hackathon Portal",
  description: "Hackathons and competitions in India for KL University students.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
