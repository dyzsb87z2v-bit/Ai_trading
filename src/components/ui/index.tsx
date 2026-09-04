"use client";

/**
 * Minimal UI kit.
 *
 * Written from scratch so the app carries no design-system dependency. Kept
 * deliberately small — this is a terminal, and every component here earns its
 * place by being used on the one screen that matters.
 *
 * Colours come from the CSS variables in globals.css so light and dark are one
 * definition rather than two parallel sets of class names.
 */

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------

const BUTTON_VARIANTS = {
  primary: "bg-accent text-white hover:opacity-90",
  secondary: "border border-line bg-surface hover:bg-surface-2",
  ghost: "hover:bg-surface-2",
  danger: "bg-red-600 text-white hover:bg-red-700",
} as const;

const BUTTON_SIZES = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
}) {
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className
      )}
      {...rest}
    />
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "rounded-md border border-line bg-transparent px-2 py-1 text-xs",
        "outline-none focus:border-accent",
        className
      )}
      {...rest}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        "rounded-md border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-accent",
        className
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

const CARD_PADDING = {
  none: "p-0",
  sm: "p-2.5",
  md: "p-3",
  lg: "p-4",
} as const;

export function Card({
  title,
  action,
  children,
  className,
  bodyClassName,
  padding = "md",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  padding?: keyof typeof CARD_PADDING;
}) {
  return (
    <section className={cx("flex flex-col rounded-lg border border-line bg-surface", className)}>
      {title || action ? (
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h2 className="text-xs font-semibold">{title}</h2>
          {action}
        </header>
      ) : null}
      <div className={cx("min-h-0", CARD_PADDING[padding], bodyClassName)}>{children}</div>
    </section>
  );
}

const BADGE_VARIANTS = {
  neutral: "bg-muted-bg text-muted",
  accent: "bg-accent/10 text-accent",
  success: "bg-green-500/12 text-green-600 dark:text-green-400",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  danger: "bg-red-500/12 text-red-600 dark:text-red-400",
  info: "bg-blue-500/12 text-blue-600 dark:text-blue-400",
} as const;

export type BadgeVariant = keyof typeof BADGE_VARIANTS;

const BADGE_SIZES = {
  sm: "px-1.5 py-0.5 text-[9px]",
  md: "px-2 py-0.5 text-[10px]",
  lg: "px-2.5 py-1 text-[11px]",
} as const;

export function Badge({
  variant = "neutral",
  size = "md",
  dot = false,
  children,
  className,
}: {
  variant?: BadgeVariant;
  size?: keyof typeof BADGE_SIZES;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full font-semibold uppercase tracking-wide",
        BADGE_SIZES[size],
        BADGE_VARIANTS[variant],
        className
      )}
    >
      {dot ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted">
      <span
        className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        aria-hidden
      />
      {label}
    </span>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "danger";
  title?: ReactNode;
  children?: ReactNode;
}) {
  const tones = {
    info: "border-blue-500/40 bg-blue-500/5",
    warning: "border-amber-500/40 bg-amber-500/5",
    danger: "border-red-500/40 bg-red-500/5",
  } as const;
  return (
    <div className={cx("rounded-lg border px-3 py-2", tones[tone])}>
      {title ? <div className="text-xs font-semibold">{title}</div> : null}
      {children ? <div className="mt-1 text-[11px] leading-snug text-muted">{children}</div> : null}
    </div>
  );
}
