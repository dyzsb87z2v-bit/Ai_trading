"use client";

/**
 * Application navigation (master spec §33).
 *
 * Desktop: a horizontal bar. Mobile: a fixed bottom bar, which is the layout
 * §33 asks for and also the one that works with a thumb.
 *
 * The bottom bar is hidden on `lg` and the top bar on small screens, so only
 * one is ever rendered visibly and the page never pays for both.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  /** Short label for the cramped mobile bar. */
  short: string;
  icon: string;
}

const ITEMS: NavItem[] = [
  { href: "/terminal", label: "Terminal", short: "Chart", icon: "▤" },
  { href: "/scanner", label: "Scanner", short: "Scan", icon: "◎" },
  { href: "/portfolio", label: "Portfolio", short: "Book", icon: "▦" },
  { href: "/journal", label: "Journal", short: "Journal", icon: "✎" },
  { href: "/alerts", label: "Alerts", short: "Alerts", icon: "◔" },
  { href: "/strategies", label: "Strategies", short: "Rules", icon: "⚙" },
];

export function AppNav() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {/* Desktop */}
      <nav className="hidden items-center gap-1 lg:flex">
        {ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              isActive(item.href)
                ? "bg-surface-2 text-text"
                : "text-muted hover:bg-surface-2 hover:text-text"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {/* Mobile: fixed bottom bar (§33). */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-surface lg:hidden"
        aria-label="Primary"
      >
        {ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${
              isActive(item.href) ? "text-accent" : "text-muted"
            }`}
          >
            <span aria-hidden className="text-base leading-none">
              {item.icon}
            </span>
            {item.short}
          </Link>
        ))}
      </nav>
    </>
  );
}

/**
 * Page shell. The bottom padding on small screens keeps content clear of the
 * fixed mobile nav — without it the last row is permanently unreachable.
 */
export function PageShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col gap-3 p-4 pb-20 lg:pb-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">{title}</h1>
          {subtitle ? <p className="text-xs text-muted">{subtitle}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <AppNav />
          {actions}
        </div>
      </header>
      {children}
    </div>
  );
}
