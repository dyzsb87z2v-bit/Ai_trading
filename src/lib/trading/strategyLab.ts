/**
 * Strategy Lab — an IF / AND / OR / THEN rule tree that compiles into a
 * backtester `Strategy` function (master spec §19).
 *
 * Why a data structure rather than user-supplied code: a strategy arrives from
 * a form or an API body, and `eval`-ing it would be remote code execution. A
 * declarative tree can be validated, stored, versioned and replayed safely.
 *
 * Every condition is evaluated against bars 0..i only — the compiled strategy
 * receives the same past-only `BarContext` the backtester gives any strategy,
 * so a rule tree physically cannot look ahead.
 */

import type { BarContext, Strategy, StrategyDecision } from "./backtest";
import { computeIndicatorSet, lastDefinedIndex, type IndicatorSet } from "./indicators";
import { atr } from "./indicators/volatility";
import { analyzeStructure, type StructureEventKind } from "./structure";
import { detectRegime, type MarketRegime } from "./regime";
import type { Side } from "./types";

// ---------------------------------------------------------------------------
// Rule vocabulary
// ---------------------------------------------------------------------------

/** A value a condition can read: an indicator series, or a constant. */
export type Operand =
  | { kind: "indicator"; id: IndicatorId }
  | { kind: "constant"; value: number }
  | { kind: "price"; field: "open" | "high" | "low" | "close" | "volume" };

export type IndicatorId =
  | "ema20"
  | "ema50"
  | "ema200"
  | "sma20"
  | "rsi"
  | "macd"
  | "macdSignal"
  | "macdHistogram"
  | "atr"
  | "adx"
  | "plusDi"
  | "minusDi"
  | "stochK"
  | "stochD"
  | "cci"
  | "roc"
  | "obv"
  | "vwap"
  | "relativeVolume"
  | "bollingerUpper"
  | "bollingerLower"
  | "bollingerMiddle"
  | "percentB";

export type Comparator = "gt" | "gte" | "lt" | "lte" | "eq";

export type Condition =
  /** Compare two operands on the current bar. */
  | { type: "compare"; left: Operand; operator: Comparator; right: Operand }
  /** `fast` crossed `slow` on THIS bar (needs the previous bar too). */
  | { type: "cross"; fast: Operand; slow: Operand; direction: "above" | "below" }
  /** A structure event occurred within the last `withinBars` bars. */
  | { type: "structure"; event: StructureEventKind; withinBars?: number }
  /** The current market regime is one of these. */
  | { type: "regime"; oneOf: MarketRegime[] }
  /** The detected trend matches. */
  | { type: "trend"; is: "uptrend" | "downtrend" | "range" | "undetermined" };

export type RuleNode =
  { all: RuleNode[] } | { any: RuleNode[] } | { not: RuleNode } | { condition: Condition };

export type StopSpec =
  | { type: "atr"; multiple: number }
  | { type: "percent"; percent: number }
  /** Beyond the nearest protective swing, plus an ATR buffer. */
  | { type: "structure"; atrBuffer?: number };

export type TargetSpec =
  | { type: "r"; multiple: number }
  | { type: "atr"; multiple: number }
  | { type: "percent"; percent: number }
  | { type: "none" };

export interface StrategyDefinition {
  name: string;
  side: Side;
  /** Bars required before the strategy may act. */
  warmupBars?: number;
  entry: RuleNode;
  /** Optional discretionary exit. Stops and targets always apply regardless. */
  exit?: RuleNode;
  stop: StopSpec;
  target?: TargetSpec;
  /** Fraction of equity to risk; falls back to the run's riskPerTrade. */
  riskFraction?: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  path: string;
  message: string;
}

const INDICATOR_IDS = new Set<string>([
  "ema20",
  "ema50",
  "ema200",
  "sma20",
  "rsi",
  "macd",
  "macdSignal",
  "macdHistogram",
  "atr",
  "adx",
  "plusDi",
  "minusDi",
  "stochK",
  "stochD",
  "cci",
  "roc",
  "obv",
  "vwap",
  "relativeVolume",
  "bollingerUpper",
  "bollingerLower",
  "bollingerMiddle",
  "percentB",
]);

const MAX_DEPTH = 12;

/**
 * Validate a definition before compiling it. Returns every problem, not just
 * the first, so a form can show them all at once.
 */
export function validateStrategyDefinition(definition: StrategyDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!definition.name || definition.name.trim().length === 0) {
    issues.push({ path: "name", message: "A strategy needs a name." });
  }
  if (definition.side !== "long" && definition.side !== "short") {
    issues.push({ path: "side", message: 'Side must be "long" or "short".' });
  }

  validateStop(definition.stop, issues);
  if (definition.target) validateTarget(definition.target, issues);

  if (
    definition.riskFraction !== undefined &&
    (!Number.isFinite(definition.riskFraction) ||
      definition.riskFraction <= 0 ||
      definition.riskFraction > 0.1)
  ) {
    issues.push({
      path: "riskFraction",
      // Same 10% ceiling the REST layer and the sizing engine enforce.
      message: "riskFraction must be between 0 and 0.1 (10%).",
    });
  }

  validateNode(definition.entry, "entry", issues, 0);
  if (definition.exit) validateNode(definition.exit, "exit", issues, 0);

  return issues;
}

function validateStop(stop: StopSpec, issues: ValidationIssue[]): void {
  if (stop.type === "atr" && (!Number.isFinite(stop.multiple) || stop.multiple <= 0)) {
    issues.push({ path: "stop.multiple", message: "ATR stop multiple must be positive." });
  }
  if (stop.type === "percent" && (!Number.isFinite(stop.percent) || stop.percent <= 0)) {
    issues.push({ path: "stop.percent", message: "Percent stop must be positive." });
  }
}

function validateTarget(target: TargetSpec, issues: ValidationIssue[]): void {
  if (target.type === "r" && (!Number.isFinite(target.multiple) || target.multiple <= 0)) {
    issues.push({ path: "target.multiple", message: "R multiple must be positive." });
  }
  if (target.type === "atr" && (!Number.isFinite(target.multiple) || target.multiple <= 0)) {
    issues.push({ path: "target.multiple", message: "ATR target multiple must be positive." });
  }
  if (target.type === "percent" && (!Number.isFinite(target.percent) || target.percent <= 0)) {
    issues.push({ path: "target.percent", message: "Percent target must be positive." });
  }
}

function validateNode(
  node: RuleNode,
  path: string,
  issues: ValidationIssue[],
  depth: number
): void {
  // A rule tree arrives from an API body; bound the depth so a pathological
  // nesting cannot blow the stack during evaluation.
  if (depth > MAX_DEPTH) {
    issues.push({ path, message: `Rule nesting exceeds the ${MAX_DEPTH}-level limit.` });
    return;
  }
  if (!node || typeof node !== "object") {
    issues.push({ path, message: "Rule node must be an object." });
    return;
  }

  if ("all" in node || "any" in node) {
    const children = "all" in node ? node.all : node.any;
    const key = "all" in node ? "all" : "any";
    if (!Array.isArray(children) || children.length === 0) {
      issues.push({ path: `${path}.${key}`, message: `"${key}" needs at least one child.` });
      return;
    }
    children.forEach((child, i) => validateNode(child, `${path}.${key}[${i}]`, issues, depth + 1));
    return;
  }
  if ("not" in node) {
    validateNode(node.not, `${path}.not`, issues, depth + 1);
    return;
  }
  if ("condition" in node) {
    validateCondition(node.condition, `${path}.condition`, issues);
    return;
  }
  issues.push({ path, message: "Rule node must be one of: all, any, not, condition." });
}

function validateCondition(condition: Condition, path: string, issues: ValidationIssue[]): void {
  switch (condition.type) {
    case "compare":
      validateOperand(condition.left, `${path}.left`, issues);
      validateOperand(condition.right, `${path}.right`, issues);
      if (!["gt", "gte", "lt", "lte", "eq"].includes(condition.operator)) {
        issues.push({ path: `${path}.operator`, message: "Unknown comparator." });
      }
      break;
    case "cross":
      validateOperand(condition.fast, `${path}.fast`, issues);
      validateOperand(condition.slow, `${path}.slow`, issues);
      break;
    case "structure":
      if (
        condition.withinBars !== undefined &&
        (!Number.isInteger(condition.withinBars) || condition.withinBars < 1)
      ) {
        issues.push({
          path: `${path}.withinBars`,
          message: "withinBars must be a positive integer.",
        });
      }
      break;
    case "regime":
      if (!Array.isArray(condition.oneOf) || condition.oneOf.length === 0) {
        issues.push({ path: `${path}.oneOf`, message: "regime needs at least one value." });
      }
      break;
    case "trend":
      break;
    default:
      issues.push({ path, message: "Unknown condition type." });
  }
}

function validateOperand(operand: Operand, path: string, issues: ValidationIssue[]): void {
  if (!operand || typeof operand !== "object") {
    issues.push({ path, message: "Operand must be an object." });
    return;
  }
  if (operand.kind === "indicator") {
    if (!INDICATOR_IDS.has(operand.id)) {
      issues.push({ path: `${path}.id`, message: `Unknown indicator "${operand.id}".` });
    }
    return;
  }
  if (operand.kind === "constant") {
    if (!Number.isFinite(operand.value)) {
      issues.push({ path: `${path}.value`, message: "Constant must be a finite number." });
    }
    return;
  }
  if (operand.kind === "price") {
    if (!["open", "high", "low", "close", "volume"].includes(operand.field)) {
      issues.push({ path: `${path}.field`, message: "Unknown price field." });
    }
    return;
  }
  issues.push({
    path: `${path}.kind`,
    message: "Operand kind must be indicator, constant or price.",
  });
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Per-bar snapshot the conditions read. Computed once per decision. */
interface EvaluationFrame {
  indicators: IndicatorSet;
  context: BarContext;
  /** Index within `context.candles` of the bar being decided on. */
  index: number;
}

function indicatorSeries(set: IndicatorSet, id: IndicatorId): (number | null)[] {
  switch (id) {
    case "ema20":
      return set.ema20;
    case "ema50":
      return set.ema50;
    case "ema200":
      return set.ema200;
    case "sma20":
      return set.sma20;
    case "rsi":
      return set.rsi;
    case "macd":
      return set.macd.macd;
    case "macdSignal":
      return set.macd.signal;
    case "macdHistogram":
      return set.macd.histogram;
    case "atr":
      return set.atr;
    case "adx":
      return set.adx.adx;
    case "plusDi":
      return set.adx.plusDi;
    case "minusDi":
      return set.adx.minusDi;
    case "stochK":
      return set.stochastic.k;
    case "stochD":
      return set.stochastic.d;
    case "cci":
      return set.cci;
    case "roc":
      return set.roc;
    case "obv":
      return set.obv;
    case "vwap":
      return set.vwap;
    case "relativeVolume":
      return set.relativeVolume;
    case "bollingerUpper":
      return set.bollinger.upper;
    case "bollingerLower":
      return set.bollinger.lower;
    case "bollingerMiddle":
      return set.bollinger.middle;
    case "percentB":
      return set.bollinger.percentB;
  }
}

/**
 * Read an operand at `offset` bars back from the decision bar.
 * Returns null when the value is not yet defined (indicator warm-up) — the
 * caller then treats the condition as unmet rather than guessing.
 */
function readOperand(frame: EvaluationFrame, operand: Operand, offset = 0): number | null {
  const index = frame.index - offset;
  if (index < 0) return null;

  if (operand.kind === "constant") return operand.value;
  if (operand.kind === "price") {
    const candle = frame.context.candles[index];
    return candle ? candle[operand.field] : null;
  }
  const value = indicatorSeries(frame.indicators, operand.id)[index];
  return value ?? null;
}

function compare(left: number, operator: Comparator, right: number): boolean {
  switch (operator) {
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    // Exact float equality is never what a rule means; treat "equal" as a
    // relative tolerance so 0.1+0.2 === 0.3 behaves as a human expects.
    case "eq":
      return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-9);
  }
}

function evaluateCondition(frame: EvaluationFrame, condition: Condition): boolean {
  switch (condition.type) {
    case "compare": {
      const left = readOperand(frame, condition.left);
      const right = readOperand(frame, condition.right);
      if (left === null || right === null) return false;
      return compare(left, condition.operator, right);
    }
    case "cross": {
      // A cross needs both bars: an undefined previous bar means no cross.
      const fastNow = readOperand(frame, condition.fast, 0);
      const slowNow = readOperand(frame, condition.slow, 0);
      const fastPrev = readOperand(frame, condition.fast, 1);
      const slowPrev = readOperand(frame, condition.slow, 1);
      if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) {
        return false;
      }
      return condition.direction === "above"
        ? fastPrev <= slowPrev && fastNow > slowNow
        : fastPrev >= slowPrev && fastNow < slowNow;
    }
    case "structure": {
      const within = condition.withinBars ?? 3;
      const structure = analyzeStructure(frame.context.candles);
      return structure.events.some(
        (event) => event.kind === condition.event && event.index > frame.index - within
      );
    }
    case "regime": {
      const regime = detectRegime({ candles: frame.context.candles });
      return condition.oneOf.includes(regime.regime);
    }
    case "trend": {
      return analyzeStructure(frame.context.candles).trend === condition.is;
    }
  }
}

export function evaluateRule(frame: EvaluationFrame, node: RuleNode): boolean {
  if ("all" in node) return node.all.every((child) => evaluateRule(frame, child));
  if ("any" in node) return node.any.some((child) => evaluateRule(frame, child));
  if ("not" in node) return !evaluateRule(frame, node.not);
  return evaluateCondition(frame, node.condition);
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Compile a definition into a `Strategy` the backtester can run.
 *
 * Throws on an invalid definition rather than silently producing a strategy
 * that never triggers — a rule tree with a typo'd indicator should fail loudly.
 */
export function compileStrategy(definition: StrategyDefinition): Strategy {
  const issues = validateStrategyDefinition(definition);
  if (issues.length > 0) {
    throw new Error(
      `Invalid strategy "${definition.name}": ` +
        issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
    );
  }

  const warmup = definition.warmupBars ?? 60;

  return (context: BarContext): StrategyDecision => {
    const candles = context.candles;
    if (candles.length <= warmup) return { action: "none" };

    const indicators = computeIndicatorSet(candles);
    const frame: EvaluationFrame = { indicators, context, index: candles.length - 1 };

    // Exit first: an open position's exit rule takes precedence over a fresh
    // entry, so a strategy cannot flip direction in a single bar.
    if (context.position) {
      if (definition.exit && evaluateRule(frame, definition.exit)) {
        return { action: "exit", reason: `${definition.name}: exit rule met` };
      }
      return { action: "none" };
    }

    if (!evaluateRule(frame, definition.entry)) return { action: "none" };

    const price = candles[candles.length - 1].close;
    const stopPrice = resolveStop(definition, candles, price);
    if (stopPrice === null) return { action: "none" };

    const direction = definition.side === "long" ? 1 : -1;
    const riskPerUnit = Math.abs(price - stopPrice);
    // A zero-distance stop makes risk undefined; refuse rather than divide by it.
    if (riskPerUnit <= 0) return { action: "none" };

    const takeProfitPrice = resolveTarget(definition, candles, price, riskPerUnit, direction);

    return {
      action: "enter",
      side: definition.side,
      stopPrice,
      takeProfitPrice,
      riskFraction: definition.riskFraction,
      reason: `${definition.name}: entry rule met`,
    };
  };
}

function resolveStop(
  definition: StrategyDefinition,
  candles: readonly { high: number; low: number; close: number }[],
  price: number
): number | null {
  const direction = definition.side === "long" ? 1 : -1;
  const stop = definition.stop;

  if (stop.type === "percent") {
    return price - direction * price * (stop.percent / 100);
  }

  const atrValue = latestAtr(candles);
  if (atrValue === null || atrValue <= 0) return null;

  if (stop.type === "atr") {
    return price - direction * atrValue * stop.multiple;
  }

  // Structural: beyond the nearest protective swing, plus an ATR buffer.
  const structure = analyzeStructure(candles as never);
  const levels = definition.side === "long" ? structure.support : structure.resistance;
  const protective = levels
    .filter((level) => (definition.side === "long" ? level.price < price : level.price > price))
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0];

  const buffer = atrValue * (stop.atrBuffer ?? 0.5);
  if (!protective) {
    // No structure to lean on — fall back to a 2 ATR stop rather than skipping
    // the trade, and never to an undefined level.
    return price - direction * atrValue * 2;
  }
  return protective.price - direction * buffer;
}

function resolveTarget(
  definition: StrategyDefinition,
  candles: readonly { high: number; low: number; close: number }[],
  price: number,
  riskPerUnit: number,
  direction: number
): number | undefined {
  const target = definition.target;
  if (!target || target.type === "none") return undefined;

  if (target.type === "r") return price + direction * riskPerUnit * target.multiple;
  if (target.type === "percent") return price + direction * price * (target.percent / 100);

  const atrValue = latestAtr(candles);
  if (atrValue === null || atrValue <= 0) return undefined;
  return price + direction * atrValue * target.multiple;
}

function latestAtr(
  candles: readonly { high: number; low: number; close: number }[]
): number | null {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const series = atr(highs, lows, closes, 14);
  const index = lastDefinedIndex(series);
  return index < 0 ? null : (series[index] as number);
}

// ---------------------------------------------------------------------------
// Presets — the spec's worked examples (§19), as data rather than code.
// ---------------------------------------------------------------------------

export const STRATEGY_PRESETS: Readonly<Record<string, StrategyDefinition>> = {
  "ema-cross": {
    name: "EMA 20/50 cross",
    side: "long",
    entry: {
      all: [
        {
          condition: {
            type: "cross",
            fast: { kind: "indicator", id: "ema20" },
            slow: { kind: "indicator", id: "ema50" },
            direction: "above",
          },
        },
        {
          condition: {
            type: "compare",
            left: { kind: "price", field: "close" },
            operator: "gt",
            right: { kind: "indicator", id: "ema200" },
          },
        },
      ],
    },
    exit: {
      condition: {
        type: "cross",
        fast: { kind: "indicator", id: "ema20" },
        slow: { kind: "indicator", id: "ema50" },
        direction: "below",
      },
    },
    stop: { type: "atr", multiple: 2 },
    target: { type: "r", multiple: 2.5 },
  },
  "rsi-reversal": {
    name: "RSI oversold reversal",
    side: "long",
    entry: {
      all: [
        {
          condition: {
            type: "compare",
            left: { kind: "indicator", id: "rsi" },
            operator: "lt",
            right: { kind: "constant", value: 30 },
          },
        },
        {
          condition: {
            type: "compare",
            left: { kind: "price", field: "close" },
            operator: "gt",
            right: { kind: "indicator", id: "ema200" },
          },
        },
      ],
    },
    exit: {
      condition: {
        type: "compare",
        left: { kind: "indicator", id: "rsi" },
        operator: "gt",
        right: { kind: "constant", value: 60 },
      },
    },
    stop: { type: "atr", multiple: 2 },
    target: { type: "r", multiple: 2 },
  },
  /** The spec's §19 example, expressed exactly. */
  "spec-example": {
    name: "Trend + momentum + volume",
    side: "long",
    entry: {
      all: [
        {
          condition: {
            type: "compare",
            left: { kind: "price", field: "close" },
            operator: "gt",
            right: { kind: "indicator", id: "ema200" },
          },
        },
        {
          condition: {
            type: "compare",
            left: { kind: "indicator", id: "rsi" },
            operator: "gt",
            right: { kind: "constant", value: 50 },
          },
        },
        {
          condition: {
            type: "compare",
            left: { kind: "indicator", id: "macdHistogram" },
            operator: "gt",
            right: { kind: "constant", value: 0 },
          },
        },
        {
          condition: {
            type: "compare",
            left: { kind: "indicator", id: "relativeVolume" },
            operator: "gt",
            right: { kind: "constant", value: 1 },
          },
        },
      ],
    },
    stop: { type: "structure", atrBuffer: 0.5 },
    target: { type: "r", multiple: 3 },
  },
  breakout: {
    name: "Confirmed breakout",
    side: "long",
    entry: {
      all: [
        { condition: { type: "structure", event: "breakout", withinBars: 2 } },
        {
          condition: {
            type: "compare",
            left: { kind: "indicator", id: "relativeVolume" },
            operator: "gt",
            right: { kind: "constant", value: 1.5 },
          },
        },
        { not: { condition: { type: "structure", event: "fakeout", withinBars: 5 } } },
      ],
    },
    stop: { type: "structure", atrBuffer: 0.5 },
    target: { type: "r", multiple: 3 },
  },
  "vwap-reclaim": {
    name: "VWAP reclaim",
    side: "long",
    entry: {
      all: [
        {
          condition: {
            type: "cross",
            fast: { kind: "price", field: "close" },
            slow: { kind: "indicator", id: "vwap" },
            direction: "above",
          },
        },
        { condition: { type: "regime", oneOf: ["trending", "momentum", "breakout"] } },
      ],
    },
    stop: { type: "atr", multiple: 1.5 },
    target: { type: "r", multiple: 2 },
  },
};

export function listStrategyPresets(): { id: string; name: string; side: Side }[] {
  return Object.entries(STRATEGY_PRESETS).map(([id, definition]) => ({
    id,
    name: definition.name,
    side: definition.side,
  }));
}
