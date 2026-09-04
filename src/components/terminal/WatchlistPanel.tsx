"use client";

/**
 * Watchlist / instrument selector (master spec §25, §33).
 *
 * Each row shows only what has actually been computed for that symbol. A symbol
 * that has not been analysed shows blanks, never a placeholder number — an
 * invented "0.00%" reads as real data.
 */

import { Badge, Button, Input } from "@/components/ui";

export interface WatchlistRow {
  symbol: string;
  assetClass: string;
  last: number | null;
  changePercent: number | null;
  score: number | null;
  state: string | null;
  dataStatus: string | null;
}

interface WatchlistPanelProps {
  rows: WatchlistRow[];
  activeSymbol: string;
  onSelect: (symbol: string) => void;
  onAdd: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  draft: string;
  onDraftChange: (value: string) => void;
}

export function WatchlistPanel({
  rows,
  activeSymbol,
  onSelect,
  onAdd,
  onRemove,
  draft,
  onDraftChange,
}: WatchlistPanelProps) {
  return (
    <div className="flex h-full flex-col gap-2">
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const symbol = draft.trim().toUpperCase();
          if (symbol) onAdd(symbol);
        }}
      >
        <Input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Add symbol"
          className="flex-1"
          aria-label="Add symbol to watchlist"
        />
        <Button type="submit" size="sm" variant="secondary">
          Add
        </Button>
      </form>

      <div className="flex flex-col gap-1 overflow-y-auto">
        {rows.map((row) => {
          const active = row.symbol === activeSymbol;
          return (
            <div
              key={row.symbol}
              className={`group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 transition-colors ${
                active
                  ? "border-primary/40 bg-primary/5"
                  : "border-transparent hover:bg-black/5 dark:hover:bg-white/5"
              }`}
              onClick={() => onSelect(row.symbol)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onSelect(row.symbol);
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-semibold">{row.symbol}</span>
                  <span className="text-[9px] uppercase text-text-muted">{row.assetClass}</span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[10px] text-text-muted">
                  {/* Blank, not zero, when nothing has been computed yet. */}
                  <span>{row.last === null ? "—" : row.last.toFixed(2)}</span>
                  <span
                    className={
                      row.changePercent === null
                        ? ""
                        : row.changePercent >= 0
                          ? "text-green-600 dark:text-green-400"
                          : "text-red-600 dark:text-red-400"
                    }
                  >
                    {row.changePercent === null
                      ? "—"
                      : `${row.changePercent >= 0 ? "+" : ""}${row.changePercent.toFixed(2)}%`}
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 flex-col items-end gap-0.5">
                {row.score !== null ? (
                  <span className="font-mono text-[11px] font-semibold">
                    {row.score.toFixed(0)}
                  </span>
                ) : null}
                {row.state ? (
                  <Badge
                    variant={
                      row.state.includes("BUY")
                        ? "success"
                        : row.state.includes("SELL")
                          ? "danger"
                          : row.state === "NO_TRADE"
                            ? "danger"
                            : "warning"
                    }
                    size="sm"
                  >
                    {row.state.replace(/_/g, " ")}
                  </Badge>
                ) : null}
              </div>

              <button
                type="button"
                aria-label={`Remove ${row.symbol}`}
                className="opacity-0 transition-opacity group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(row.symbol);
                }}
              >
                <span className="text-xs text-text-muted hover:text-red-500">×</span>
              </button>
            </div>
          );
        })}

        {rows.length === 0 ? (
          <p className="px-2 py-4 text-center text-[11px] text-text-muted">
            Watchlist is empty. Add a symbol above.
          </p>
        ) : null}
      </div>
    </div>
  );
}
