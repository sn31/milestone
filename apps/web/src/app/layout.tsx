import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { RoleSwitcher } from "@/components/role-switcher";
import { getActor } from "@/lib/session";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Milestone", template: "%s · Milestone" },
  description: "AI escrow agent for freelance work",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const actor = await getActor();
  const isPartner = actor.role === "partner";
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/85 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
          <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-6">
              <Link href="/" className="flex items-center gap-2" aria-label="Milestone home">
                <span aria-hidden className="grid size-7 place-items-center rounded-md bg-zinc-900 text-[13px] font-bold text-white dark:bg-white dark:text-zinc-900">M</span>
                <span className="leading-tight">
                  <span className="block text-[15px] font-semibold tracking-tight">Milestone</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">AI escrow for freelance work</span>
                </span>
              </Link>
              <nav className="hidden items-center gap-4 text-sm text-zinc-600 sm:flex dark:text-zinc-400">
                <Link href="/" className="hover:text-zinc-900 dark:hover:text-white">Contracts</Link>
                {isPartner ? (
                  // The partner is not a contract party; its two links take New contract's place so the header stays on one row.
                  <>
                    <Link href="/lender" className="hover:text-zinc-900 dark:hover:text-white">Lender&apos;s book</Link>
                    <Link href="/ops" className="hover:text-zinc-900 dark:hover:text-white">Operations</Link>
                  </>
                ) : (
                  <Link href="/contracts/new" className="hover:text-zinc-900 dark:hover:text-white">New contract</Link>
                )}
              </nav>
            </div>
            <RoleSwitcher />
          </div>
        </header>
        <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">{children}</div>
        <footer className="mx-auto w-full max-w-4xl px-4 pb-8 text-xs text-zinc-400 sm:px-6 dark:text-zinc-500">
          Demo identities; PayPal runs in sandbox or simulated mode. The agent explains, a fixed policy decides.
        </footer>
      </body>
    </html>
  );
}
