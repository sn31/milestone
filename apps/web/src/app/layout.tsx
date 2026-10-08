import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { RoleSwitcher } from "@/components/role-switcher";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Milestone",
  description: "AI escrow agent for freelance work",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
          <Link href="/" className="font-semibold">Milestone</Link>
          <RoleSwitcher />
        </header>
        <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">{children}</div>
      </body>
    </html>
  );
}
