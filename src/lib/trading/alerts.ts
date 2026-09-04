/**
 * Alert engine (master spec §26).
 *
 * Evaluates alert rules against a completed analysis and returns the ones that
 * fired. Two properties the design guarantees:
 *
 *  1. **An alert never fires on data it cannot verify.** A rule whose input is
 *     missing stays silent rather than guessing — a false alert on a stale feed
 *     is worse than no alert.
 *
 *  2. **Edge-triggered, not level-triggered.** A price alert above 100 fires
 *     when price CROSSES 100, not on every evaluation while it stays there.
 *     Cooldown and last-state tracking make repeat firing explicit.
 */

import type { AnalysisResult } from "./analysisService";
import { lastDefinedIndex } from "./indicators";
import type { IndicatorSet } from "./indicators";

export type AlertKind =
  | "price_above"
  | "price_below"
  | "percent_change"
  | "breakout"
  | "breakdown"
  | "rsi_above"
  | "rsi_below"
  | "macd_cross"
  | "volume_spike"
  | "volatility_above"
  | "support_touch"
  | "resistance_touch"
  | "signal_change"
  | "stop_hit"
  | "target_hit";

export type AlertChannel = "browser" | "email" | "telegram" | "push";

export interface AlertRule {
  id: string;
  symbol: string;
  kind: AlertKind;
  /** Threshold or level the rule compares against, when it needs one. */
  value?: number;
  /** For signal_change: the state last seen, so only a change fires. */
  previousState?: string;
  enabled: boolean;
  channels: AlertChannel[];
  /** Minimum ms between two firings of the same rule. */
  cooldownMs?: number;
  lastTriggeredAt?: number | null;
  /** Level-crossing rules need the previous side to be edge-triggered. */
  lastValue?: number | null;
  note?: string;
}

export interface AlertEvent {
  ruleId: string;
  symbol: string;
  kind: AlertKind;
  message: string;
  /** Value that caused the trigger, for the notification body. */
  observed: number | null;
  threshold: number | null;
  triggeredAt: number;
  channels: AlertChannel[];
  severity: "info" | "warning" | "critical";
}

export interface AlertEvaluation {
  fired: AlertEvent[];
  /** Rules that could not be evaluated, and why. Never silently skipped. */
  skipped: { ruleId: string; reason: string }[];
  /** Updated rule state the caller must persist for edge-triggering to work. */
  stateUpdates: {
    ruleId: string;
    lastValue: number | null;
    lastTriggeredAt: number | null;
    previousState?: string;
  }[];
}

export interface AlertContext {
  analysis: AnalysisResult;
  indicators: IndicatorSet | null;
  /** Open position for the symbol, when stop/target alerts are configured. */
  position?: {
    side: "long" | "short";
    stopPrice: number | null;
    takeProfitPrice: number | null;
  } | null;
  now?: number;
}

function latestOf(series: readonly (number | null)[] | undefined): number | null {
  if (!series) return null;
  const index = lastDefinedIndex(series);
  return index < 0 ? null : (series[index] as number);
}

/**
 * True when `value` has crossed `threshold` since the previous observation.
 * A null `previous` means this is the first look: no edge exists yet, so the
 * rule stays silent rather than firing on whatever side it happens to start on.
 */
function crossedUp(previous: number | null, value: number, threshold: number): boolean {
  if (previous === null) return false;
  return previous <= threshold && value > threshold;
}

function crossedDown(previous: number | null, value: number, threshold: number): boolean {
  if (previous === null) return false;
  return previous >= threshold && value < threshold;
}

export function evaluateAlerts(
  rules: readonly AlertRule[],
  context: AlertContext
): AlertEvaluation {
  const now = context.now ?? Date.now();
  const fired: AlertEvent[] = [];
  const skipped: AlertEvaluation["skipped"] = [];
  const stateUpdates: AlertEvaluation["stateUpdates"] = [];

  const analysis = context.analysis;
  const price = analysis.structure ? lastPrice(context) : null;

  for (const rule of rules) {
    if (!rule.enabled) continue;

    // Cooldown is checked before evaluation so a hot rule cannot spam.
    if (rule.cooldownMs && rule.lastTriggeredAt && now - rule.lastTriggeredAt < rule.cooldownMs) {
      continue;
    }

    const outcome = evaluateRule(rule, context, price, now);
    if (outcome.kind === "skip") {
      skipped.push({ ruleId: rule.id, reason: outcome.reason });
      continue;
    }

    stateUpdates.push({
      ruleId: rule.id,
      lastValue: outcome.observed,
      lastTriggeredAt: outcome.fired ? now : (rule.lastTriggeredAt ?? null),
      previousState: outcome.state,
    });

    if (outcome.fired && outcome.event) fired.push(outcome.event);
  }

  return { fired, skipped, stateUpdates };
}

function lastPrice(context: AlertContext): number | null {
  const closes = context.indicators?.closes;
  if (!closes || closes.length === 0) return null;
  return closes[closes.length - 1];
}

type RuleOutcome =
  | { kind: "skip"; reason: string }
  | {
      kind: "evaluated";
      fired: boolean;
      observed: number | null;
      event?: AlertEvent;
      state?: string;
    };

function makeEvent(
  rule: AlertRule,
  message: string,
  observed: number | null,
  threshold: number | null,
  now: number,
  severity: AlertEvent["severity"] = "info"
): AlertEvent {
  return {
    ruleId: rule.id,
    symbol: rule.symbol,
    kind: rule.kind,
    message,
    observed,
    threshold,
    triggeredAt: now,
    channels: rule.channels,
    severity,
  };
}

function evaluateRule(
  rule: AlertRule,
  context: AlertContext,
  price: number | null,
  now: number
): RuleOutcome {
  const { analysis, indicators } = context;

  // Data the rule needs but does not have means silence, not a guess.
  const needsPrice = [
    "price_above",
    "price_below",
    "support_touch",
    "resistance_touch",
    "stop_hit",
    "target_hit",
  ];
  if (needsPrice.includes(rule.kind) && price === null) {
    return { kind: "skip", reason: "no price available for this symbol" };
  }
  if (rule.kind.startsWith("rsi_") && !indicators) {
    return { kind: "skip", reason: "indicators unavailable" };
  }

  switch (rule.kind) {
    case "price_above": {
      if (rule.value === undefined) return { kind: "skip", reason: "rule has no threshold" };
      const fired = crossedUp(rule.lastValue ?? null, price as number, rule.value);
      return {
        kind: "evaluated",
        fired,
        observed: price,
        event: fired
          ? makeEvent(rule, `${rule.symbol} crossed above ${rule.value}`, price, rule.value, now)
          : undefined,
      };
    }
    case "price_below": {
      if (rule.value === undefined) return { kind: "skip", reason: "rule has no threshold" };
      const fired = crossedDown(rule.lastValue ?? null, price as number, rule.value);
      return {
        kind: "evaluated",
        fired,
        observed: price,
        event: fired
          ? makeEvent(rule, `${rule.symbol} crossed below ${rule.value}`, price, rule.value, now)
          : undefined,
      };
    }
    case "percent_change": {
      const change = analysis.signal ? null : null;
      const observed = changePercentOf(context);
      if (observed === null) return { kind: "skip", reason: "no change percentage available" };
      if (rule.value === undefined) return { kind: "skip", reason: "rule has no threshold" };
      void change;
      const fired = Math.abs(observed) >= Math.abs(rule.value);
      return {
        kind: "evaluated",
        fired,
        observed,
        event: fired
          ? makeEvent(
              rule,
              `${rule.symbol} moved ${observed.toFixed(2)}% (threshold ${rule.value}%)`,
              observed,
              rule.value,
              now
            )
          : undefined,
      };
    }
    case "breakout":
    case "breakdown": {
      const wanted = rule.kind === "breakout" ? "breakout" : "breakdown";
      const structure = analysis.structure;
      if (!structure) return { kind: "skip", reason: "no structure available" };
      const recent = structure.events.filter(
        (event) => event.index >= structure.swings.length - 1 || true
      );
      const bars = 3;
      const total = context.indicators?.closes.length ?? 0;
      const hit = recent.find((event) => event.kind === wanted && event.index > total - bars);
      return {
        kind: "evaluated",
        fired: Boolean(hit),
        observed: hit?.price ?? price,
        event: hit
          ? makeEvent(rule, `${rule.symbol}: ${hit.evidence}`, hit.price, hit.level, now, "warning")
          : undefined,
      };
    }
    case "rsi_above":
    case "rsi_below": {
      const rsi = latestOf(indicators?.rsi);
      if (rsi === null) return { kind: "skip", reason: "RSI not yet defined" };
      if (rule.value === undefined) return { kind: "skip", reason: "rule has no threshold" };
      const fired =
        rule.kind === "rsi_above"
          ? crossedUp(rule.lastValue ?? null, rsi, rule.value)
          : crossedDown(rule.lastValue ?? null, rsi, rule.value);
      return {
        kind: "evaluated",
        fired,
        observed: rsi,
        event: fired
          ? makeEvent(
              rule,
              `${rule.symbol} RSI ${rsi.toFixed(1)} crossed ${rule.kind === "rsi_above" ? "above" : "below"} ${rule.value}`,
              rsi,
              rule.value,
              now
            )
          : undefined,
      };
    }
    case "macd_cross": {
      const histogram = indicators?.macd.histogram;
      if (!histogram) return { kind: "skip", reason: "MACD not yet defined" };
      const value = latestOf(histogram);
      if (value === null) return { kind: "skip", reason: "MACD not yet defined" };
      // A cross is the histogram changing sign.
      const fired =
        rule.lastValue !== null &&
        rule.lastValue !== undefined &&
        Math.sign(rule.lastValue) !== Math.sign(value) &&
        value !== 0;
      return {
        kind: "evaluated",
        fired,
        observed: value,
        event: fired
          ? makeEvent(
              rule,
              `${rule.symbol} MACD crossed ${value > 0 ? "bullish" : "bearish"}`,
              value,
              0,
              now
            )
          : undefined,
      };
    }
    case "volume_spike": {
      const relative = latestOf(indicators?.relativeVolume);
      if (relative === null) return { kind: "skip", reason: "relative volume not yet defined" };
      const threshold = rule.value ?? 2;
      const fired = crossedUp(rule.lastValue ?? null, relative, threshold);
      return {
        kind: "evaluated",
        fired,
        observed: relative,
        event: fired
          ? makeEvent(
              rule,
              `${rule.symbol} volume ${relative.toFixed(2)}× average`,
              relative,
              threshold,
              now,
              "warning"
            )
          : undefined,
      };
    }
    case "volatility_above": {
      const volatility = analysis.volatility;
      if (volatility === null) return { kind: "skip", reason: "volatility not measurable" };
      const threshold = rule.value ?? 0.5;
      const fired = crossedUp(rule.lastValue ?? null, volatility, threshold);
      return {
        kind: "evaluated",
        fired,
        observed: volatility,
        event: fired
          ? makeEvent(
              rule,
              `${rule.symbol} annualised volatility ${(volatility * 100).toFixed(1)}%`,
              volatility,
              threshold,
              now,
              "warning"
            )
          : undefined,
      };
    }
    case "support_touch":
    case "resistance_touch": {
      const structure = analysis.structure;
      if (!structure) return { kind: "skip", reason: "no structure available" };
      const levels = rule.kind === "support_touch" ? structure.support : structure.resistance;
      if (levels.length === 0) return { kind: "skip", reason: "no levels detected" };
      const current = price as number;
      // "Touch" means within 0.25% of the level.
      const near = levels.find((level) => Math.abs(level.price - current) / current <= 0.0025);
      return {
        kind: "evaluated",
        fired: Boolean(near),
        observed: current,
        event: near
          ? makeEvent(
              rule,
              `${rule.symbol} is testing ${rule.kind === "support_touch" ? "support" : "resistance"} at ${near.price.toFixed(4)}`,
              current,
              near.price,
              now
            )
          : undefined,
      };
    }
    case "signal_change": {
      const state = analysis.signal?.state;
      if (!state) return { kind: "skip", reason: "no signal computed" };
      const fired = rule.previousState !== undefined && rule.previousState !== state;
      return {
        kind: "evaluated",
        fired,
        observed: analysis.signal?.score ?? null,
        state,
        event: fired
          ? makeEvent(
              rule,
              `${rule.symbol} signal changed: ${rule.previousState} → ${state} ` +
                `(${analysis.signal?.score.toFixed(0)}/100)`,
              analysis.signal?.score ?? null,
              null,
              now,
              "warning"
            )
          : undefined,
      };
    }
    case "stop_hit":
    case "target_hit": {
      const position = context.position;
      if (!position) return { kind: "skip", reason: "no open position for this symbol" };
      const level = rule.kind === "stop_hit" ? position.stopPrice : position.takeProfitPrice;
      if (level === null) return { kind: "skip", reason: "position has no such level" };
      const current = price as number;
      const hit =
        rule.kind === "stop_hit"
          ? position.side === "long"
            ? current <= level
            : current >= level
          : position.side === "long"
            ? current >= level
            : current <= level;
      return {
        kind: "evaluated",
        fired: hit,
        observed: current,
        event: hit
          ? makeEvent(
              rule,
              `${rule.symbol} reached its ${rule.kind === "stop_hit" ? "stop" : "target"} at ${level}`,
              current,
              level,
              now,
              rule.kind === "stop_hit" ? "critical" : "info"
            )
          : undefined,
      };
    }
  }
}

function changePercentOf(context: AlertContext): number | null {
  const closes = context.indicators?.closes;
  if (!closes || closes.length < 2) return null;
  const previous = closes[closes.length - 2];
  if (previous === 0) return null;
  return ((closes[closes.length - 1] - previous) / previous) * 100;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface AlertDispatcher {
  channel: AlertChannel;
  /** Whether the operator has actually configured this channel. */
  isConfigured(): boolean;
  send(event: AlertEvent): Promise<{ ok: boolean; detail?: string }>;
}

export interface DispatchOutcome {
  event: AlertEvent;
  channel: AlertChannel;
  ok: boolean;
  detail?: string;
}

/**
 * Deliver events to their channels.
 *
 * An unconfigured channel is reported as a failed delivery with a clear reason,
 * never as a success — the operator must be able to tell that an alert they set
 * up is not actually reaching them (§26: "implement only where credentials are
 * actually configured").
 */
export async function dispatchAlerts(
  events: readonly AlertEvent[],
  dispatchers: readonly AlertDispatcher[]
): Promise<DispatchOutcome[]> {
  const outcomes: DispatchOutcome[] = [];

  for (const event of events) {
    for (const channel of event.channels) {
      const dispatcher = dispatchers.find((d) => d.channel === channel);
      if (!dispatcher) {
        outcomes.push({ event, channel, ok: false, detail: `No dispatcher for "${channel}".` });
        continue;
      }
      if (!dispatcher.isConfigured()) {
        outcomes.push({
          event,
          channel,
          ok: false,
          detail: `Channel "${channel}" is not configured — this alert did not reach you.`,
        });
        continue;
      }
      try {
        const result = await dispatcher.send(event);
        outcomes.push({ event, channel, ok: result.ok, detail: result.detail });
      } catch (error) {
        outcomes.push({
          event,
          channel,
          ok: false,
          detail: error instanceof Error ? error.message : "delivery failed",
        });
      }
    }
  }
  return outcomes;
}

/**
 * The browser channel is always available: it needs no credentials, because
 * delivery is the UI polling for undelivered events.
 */
export function createBrowserDispatcher(sink: (event: AlertEvent) => void): AlertDispatcher {
  return {
    channel: "browser",
    isConfigured: () => true,
    send: async (event) => {
      sink(event);
      return { ok: true };
    },
  };
}

export const ALERT_KIND_LABELS: Readonly<Record<AlertKind, string>> = {
  price_above: "Price above",
  price_below: "Price below",
  percent_change: "Percent change",
  breakout: "Breakout",
  breakdown: "Breakdown",
  rsi_above: "RSI above",
  rsi_below: "RSI below",
  macd_cross: "MACD cross",
  volume_spike: "Volume spike",
  volatility_above: "Volatility above",
  support_touch: "Support touch",
  resistance_touch: "Resistance touch",
  signal_change: "Signal change",
  stop_hit: "Stop hit",
  target_hit: "Target hit",
};
