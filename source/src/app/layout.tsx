import type { Metadata } from "next";
import { Geist, Geist_Mono, Archivo, Azeret_Mono } from "next/font/google";
import "./globals.css";
import Shell from "@/components/Shell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Broadcast Control Room design system — two voices, both self-hosted.
// Archivo (display + UI) has the wide, high-performance grotesk character of a
// broadcast lower-third; Azeret Mono carries every numeral, timecode and metric.
// Self-hosted on purpose: the previous build pulled four families from
// fonts.googleapis.com at runtime, so the whole OS fell back to system fonts
// whenever the machine was offline.
const archivo = Archivo({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});
const azeretMono = Azeret_Mono({
  variable: "--font-data",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

// Without an explicit viewport the OS renders at desktop width on phones, so every
// panel looks shrunk and the two-column build views become unusable.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export const metadata: Metadata = {
  title: "Agentic OS — Mission Control",
  description: "Your command center for Claude, OpenClaw, Hermes",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${archivo.variable} ${azeretMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <div className="relative z-10">
          <Shell>{children}</Shell>
        </div>
      </body>
    </html>
  );
}
