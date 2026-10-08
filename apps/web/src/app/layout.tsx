import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { RoleSwitcher } from "@/components/role-switcher";
import { MotionProvider, NavLink } from "@/components/ui";
import { getActor } from "@/lib/session";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const instrumentSerif = Instrument_Serif({ variable: "--font-instrument-serif", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: { default: "Milestone", template: "%s · Milestone" },
  description: "Payment on verified delivery for freelance work",
};

/** The wordmark glyph: a three-station rail, the last station lit green (money released). */
function RailMark() {
  return (
    <svg aria-hidden viewBox="0 0 14 30" className="h-[30px] w-[14px] shrink-0" fill="none">
      <path d="M7 6 V24" stroke="var(--hairline-strong)" strokeWidth="1.5" strokeDasharray="2 2.5" />
      <path d="M7 6 V15" stroke="var(--fg)" strokeWidth="1.5" />
      <circle cx="7" cy="4.5" r="3" fill="var(--fg)" />
      <circle cx="7" cy="15" r="3" fill="var(--fg)" />
      <circle cx="7" cy="25.5" r="3" fill="var(--bg)" stroke="var(--state-released)" strokeWidth="1.5" />
    </svg>
  );
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const actor = await getActor();
  const isPartner = actor.role === "partner";
  const links = isPartner
    ? [
        { href: "/", label: "Contracts", exact: true },
        { href: "/lender", label: "Lender’s book" },
        { href: "/ops", label: "Operations" },
      ]
    : [
        { href: "/", label: "Contracts", exact: true },
        { href: "/contracts/new", label: "New contract" },
        { href: "/disputes", label: "Disputes" },
      ];
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* Marks JS as available before first paint so count-ups can hide their final value until they animate. */}
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
      </head>
      <body className="flex min-h-full flex-col">
        <MotionProvider>
          <header className="sticky top-0 z-40 border-b border-hairline bg-bg/80 backdrop-blur-md">
            <div className="mx-auto w-full max-w-content px-4 sm:px-6">
              <div className="flex h-14 items-center justify-between gap-3 sm:h-16 sm:gap-4">
                <div className="flex min-w-0 items-center gap-8">
                  <Link href="/" className="flex shrink-0 items-center gap-2 sm:gap-2.5" aria-label="Milestone, all contracts">
                    <RailMark />
                    <span className="font-display text-[23px] leading-none sm:text-[26px] tracking-[-0.01em] text-fg">Milestone</span>
                  </Link>
                  <nav aria-label="Main" className="hidden items-center gap-6 md:flex">
                    {links.map((l) => (
                      <NavLink key={l.href} href={l.href} exact={l.exact}>
                        {l.label}
                      </NavLink>
                    ))}
                  </nav>
                </div>
                <RoleSwitcher />
              </div>
              <nav aria-label="Main" className="-mt-1 flex items-center gap-5 overflow-x-auto pb-2 md:hidden">
                {links.map((l) => (
                  <NavLink key={l.href} href={l.href} exact={l.exact} className="text-[13px]">
                    {l.label}
                  </NavLink>
                ))}
              </nav>
            </div>
          </header>
          <div className="mx-auto w-full max-w-content flex-1 px-4 py-10 sm:px-6 sm:py-14">{children}</div>
          <footer className="border-t border-hairline">
            <div className="mx-auto flex w-full max-w-content flex-col gap-2 px-4 py-6 font-mono text-[11px] text-fg-faint sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p>Demo identities. PayPal runs in sandbox or simulated mode.</p>
              <p>The agent explains. A fixed policy decides.</p>
            </div>
          </footer>
        </MotionProvider>
      </body>
    </html>
  );
}
