"use client";

/**
 * Candlestick chart (master spec §4).
 *
 * Custom SVG rather than a charting library: recharts has no candlestick mark,
 * and the terminal needs price + volume + overlays + trade levels sharing one
 * coordinate space with a crosshair reading all of them at once.
 *
 * Rendering notes:
 *  - The price scale is padded to the extremes of the WICKS, not the bodies, so
 *    a long wick is never clipped.
 *  - Volume occupies its own band beneath price; the two never share a scale.
 *  - Overlays (EMA/VWAP) are drawn from the same index space as the candles, so
 *    a null warm-up value breaks the path rather than interpolating across it.
 */

import { useMemo, useRef, useState } from "react";
import type { TerminalCandle, TradePlanView } from "./types";

export interface ChartOverlay {
  id: string;
  label: string;
  color: string;
  values: (number | null)[];
}

export interface ChartLevel {
  price: number;
  label: string;
  color: string;
  dashed?: boolean;
}

interface CandleChartProps {
  candles: TerminalCandle[];
  overlays?: ChartOverlay[];
  levels?: ChartLevel[];
  plan?: TradePlanView | null;
  height?: number;
  /** Rendered as a watermark so the data's nature is visible on the chart. */
  watermark?: string;
}

const PADDING = { top: 16, right: 62, bottom: 22, left: 8 };
const VOLUME_BAND = 0.18;

export function CandleChart({
  candles,
  overlays = [],
  levels = [],
  plan = null,
  height = 420,
  watermark,
}: CandleChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const width = 1000; // viewBox width; the SVG scales to its container.

  const geometry = useMemo(() => {
    if (candles.length === 0) return null;

    const plotWidth = width - PADDING.left - PADDING.right;
    const plotHeight = height - PADDING.top - PADDING.bottom;
    const priceHeight = plotHeight * (1 - VOLUME_BAND);
    const volumeHeight = plotHeight * VOLUME_BAND;
    const volumeTop = PADDING.top + priceHeight;

    let min = Infinity;
    let max = -Infinity;
    for (const candle of candles) {
      if (candle.low < min) min = candle.low;
      if (candle.high > max) max = candle.high;
    }
    // Trade levels must be visible, so they widen the scale when they sit
    // outside the price range.
    for (const level of levels) {
      if (level.price < min) min = level.price;
      if (level.price > max) max = level.price;
    }

    const span = max - min || Math.max(max * 0.01, 1);
    min -= span * 0.06;
    max += span * 0.06;

    const maxVolume = candles.reduce((acc, c) => Math.max(acc, c.volume), 0) || 1;
    const slot = plotWidth / candles.length;
    const bodyWidth = Math.max(1, Math.min(14, slot * 0.68));

    const xFor = (index: number) => PADDING.left + slot * (index + 0.5);
    const yFor = (price: number) =>
      PADDING.top + priceHeight - ((price - min) / (max - min)) * priceHeight;
    const volumeYFor = (volume: number) =>
      volumeTop + volumeHeight - (volume / maxVolume) * volumeHeight * 0.92;

    return {
      plotWidth,
      priceHeight,
      volumeTop,
      volumeHeight,
      min,
      max,
      slot,
      bodyWidth,
      xFor,
      yFor,
      volumeYFor,
    };
  }, [candles, levels, height]);

  if (!geometry || candles.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-black/10 text-xs text-text-muted dark:border-white/10"
        style={{ height }}
      >
        No candles to plot.
      </div>
    );
  }

  const { min, max, slot, bodyWidth, xFor, yFor, volumeYFor, volumeTop, volumeHeight } = geometry;

  const priceTicks = buildTicks(min, max, 6);
  const hovered = hoverIndex !== null ? candles[hoverIndex] : null;

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    // Map client pixels into viewBox units before inverting the x scale.
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.floor((x - PADDING.left) / slot);
    setHoverIndex(index >= 0 && index < candles.length ? index : null);
  };

  const planLines: ChartLevel[] = plan
    ? [
        { price: plan.preferredEntry, label: "Entry", color: "#3b82f6" },
        { price: plan.stopLoss, label: "Stop", color: "#ef4444" },
        { price: plan.takeProfit1, label: "TP1", color: "#22c55e", dashed: true },
        { price: plan.takeProfit2, label: "TP2", color: "#22c55e", dashed: true },
        { price: plan.takeProfit3, label: "TP3", color: "#22c55e", dashed: true },
      ]
    : [];

  return (
    <div className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full select-none"
        style={{ height }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
        role="img"
        aria-label="Price chart"
      >
        {watermark ? (
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            className="fill-current text-text-muted"
            style={{ fontSize: 34, opacity: 0.09, fontWeight: 700, letterSpacing: 2 }}
          >
            {watermark}
          </text>
        ) : null}

        {priceTicks.map((tick) => (
          <g key={`tick-${tick}`}>
            <line
              x1={PADDING.left}
              x2={width - PADDING.right}
              y1={yFor(tick)}
              y2={yFor(tick)}
              stroke="currentColor"
              strokeOpacity={0.08}
              strokeWidth={1}
            />
            <text
              x={width - PADDING.right + 6}
              y={yFor(tick) + 3}
              className="fill-current text-text-muted"
              style={{ fontSize: 10 }}
            >
              {formatPrice(tick)}
            </text>
          </g>
        ))}

        {/* Volume band sits under price with its own independent scale. */}
        {candles.map((candle, index) => {
          const up = candle.close >= candle.open;
          return (
            <rect
              key={`vol-${candle.timestamp}`}
              x={xFor(index) - bodyWidth / 2}
              y={volumeYFor(candle.volume)}
              width={bodyWidth}
              height={Math.max(0.5, volumeTop + volumeHeight - volumeYFor(candle.volume))}
              fill={up ? "#22c55e" : "#ef4444"}
              opacity={0.28}
            />
          );
        })}

        {overlays.map((overlay) => (
          <path
            key={overlay.id}
            d={buildOverlayPath(overlay.values, xFor, yFor)}
            fill="none"
            stroke={overlay.color}
            strokeWidth={1.4}
            strokeOpacity={0.9}
          />
        ))}

        {[...levels, ...planLines].map((level, i) => (
          <g key={`level-${level.label}-${i}`}>
            <line
              x1={PADDING.left}
              x2={width - PADDING.right}
              y1={yFor(level.price)}
              y2={yFor(level.price)}
              stroke={level.color}
              strokeWidth={1}
              strokeOpacity={0.75}
              strokeDasharray={level.dashed ? "5 4" : undefined}
            />
            <text
              x={PADDING.left + 4}
              y={yFor(level.price) - 3}
              style={{ fontSize: 9, fontWeight: 600 }}
              fill={level.color}
            >
              {level.label} {formatPrice(level.price)}
            </text>
          </g>
        ))}

        {candles.map((candle, index) => {
          const up = candle.close >= candle.open;
          const color = up ? "#16a34a" : "#dc2626";
          const bodyTop = yFor(Math.max(candle.open, candle.close));
          const bodyBottom = yFor(Math.min(candle.open, candle.close));
          return (
            <g key={candle.timestamp}>
              <line
                x1={xFor(index)}
                x2={xFor(index)}
                y1={yFor(candle.high)}
                y2={yFor(candle.low)}
                stroke={color}
                strokeWidth={1}
              />
              <rect
                x={xFor(index) - bodyWidth / 2}
                y={bodyTop}
                width={bodyWidth}
                // A doji has zero body height; clamp so it still draws a line.
                height={Math.max(1, bodyBottom - bodyTop)}
                fill={color}
              />
            </g>
          );
        })}

        {hoverIndex !== null && hovered ? (
          <g>
            <line
              x1={xFor(hoverIndex)}
              x2={xFor(hoverIndex)}
              y1={PADDING.top}
              y2={height - PADDING.bottom}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeDasharray="3 3"
            />
            <line
              x1={PADDING.left}
              x2={width - PADDING.right}
              y1={yFor(hovered.close)}
              y2={yFor(hovered.close)}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeDasharray="3 3"
            />
          </g>
        ) : null}
      </svg>

      {hovered ? (
        <div className="pointer-events-none absolute left-2 top-2 rounded-md border border-black/10 bg-white/95 px-2 py-1 font-mono text-[10px] leading-relaxed shadow-sm dark:border-white/15 dark:bg-black/85">
          <div className="text-text-muted">{new Date(hovered.timestamp).toUTCString()}</div>
          <div>
            O {formatPrice(hovered.open)} H {formatPrice(hovered.high)} L {formatPrice(hovered.low)}{" "}
            C {formatPrice(hovered.close)}
          </div>
          <div className="text-text-muted">V {hovered.volume.toLocaleString()}</div>
        </div>
      ) : null}

      {overlays.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-3 px-2 text-[10px] text-text-muted">
          {overlays.map((overlay) => (
            <span key={overlay.id} className="flex items-center gap-1">
              <span
                className="inline-block h-[2px] w-3 rounded"
                style={{ background: overlay.color }}
              />
              {overlay.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Build an overlay path, starting a new sub-path after every null so a warm-up
 * gap is a break in the line rather than a straight segment across it.
 */
function buildOverlayPath(
  values: (number | null)[],
  xFor: (index: number) => number,
  yFor: (price: number) => number
): string {
  let path = "";
  let penDown = false;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null || !Number.isFinite(value)) {
      penDown = false;
      continue;
    }
    path += `${penDown ? "L" : "M"}${xFor(i).toFixed(2)} ${yFor(value).toFixed(2)} `;
    penDown = true;
  }
  return path.trim();
}

function buildTicks(min: number, max: number, count: number): number[] {
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) ticks.push(min + ((max - min) * i) / count);
  return ticks;
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(4);
}
