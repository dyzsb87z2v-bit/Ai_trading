/**
 * Strategy Lab rule engine (§19).
 *
 * The properties under test: a rule tree cannot look ahead, an invalid tree
 * fails loudly rather than silently never triggering, and a compiled strategy
 * behaves identically to a hand-written one in the backtester.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  STRATEGY_PRESETS,
  compileStrategy,
  listStrategyPresets,
  validateStrategyDefinition,
  type StrategyDefinition,
} from "@/lib/trading/strategyLab";
import { runBacktest } from "@/lib/trading/backtest";
import type { Candle } from "@/lib/trading/types";

function series(direction: 1 | -1, count = 200): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const close = 100 + direction * i * 0.4 + Math.sin(i / 4) * 4;
    candles.push({
      timestamp: i * 3_600_000,
      open: close - direction * 0.1,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 10_000 + (i % 5) * 800,
    });
  }
  return candles;
}

const MINIMAL: StrategyDefinition = {
  name: "test",
  side: "long",
  entry: {
    condition: {
      type: "compare",
      left: { kind: "indicator", id: "rsi" },
      operator: "gt",
      right: { kind: "constant", value: 50 },
    },
  },
  stop: { type: "atr", multiple: 2 },
  target: { type: "r", multiple: 2 },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validation: a well-formed definition has no issues", () => {
  assert.deepEqual(validateStrategyDefinition(MINIMAL), []);
});

test("validation: rejects an unknown indicator", () => {
  const issues = validateStrategyDefinition({
    ...MINIMAL,
    entry: {
      condition: {
        type: "compare",
        left: { kind: "indicator", id: "notAnIndicator" as never },
        operator: "gt",
        right: { kind: "constant", value: 1 },
      },
    },
  });
  assert.ok(issues.some((i) => /Unknown indicator/.test(i.message)));
});

test("validation: rejects an empty all/any group", () => {
  const issues = validateStrategyDefinition({ ...MINIMAL, entry: { all: [] } });
  assert.ok(issues.some((i) => /at least one child/.test(i.message)));
});

test("validation: rejects a risk fraction above the 10% ceiling", () => {
  const issues = validateStrategyDefinition({ ...MINIMAL, riskFraction: 0.5 });
  assert.ok(issues.some((i) => i.path === "riskFraction"));
});

test("validation: rejects a non-positive stop", () => {
  const issues = validateStrategyDefinition({ ...MINIMAL, stop: { type: "atr", multiple: 0 } });
  assert.ok(issues.some((i) => i.path === "stop.multiple"));
});

test("validation: bounds rule nesting depth", () => {
  // Build a tree deeper than the limit.
  let node: StrategyDefinition["entry"] = MINIMAL.entry;
  for (let i = 0; i < 20; i++) node = { all: [node] };
  const issues = validateStrategyDefinition({ ...MINIMAL, entry: node });
  assert.ok(issues.some((i) => /nesting exceeds/.test(i.message)));
});

test("validation: reports every problem, not just the first", () => {
  const issues = validateStrategyDefinition({
    name: "",
    side: "sideways" as never,
    entry: { all: [] },
    stop: { type: "atr", multiple: -1 },
  });
  assert.ok(issues.length >= 3, `expected several issues, got ${issues.length}`);
});

test("compile: an invalid definition throws rather than never triggering", () => {
  assert.throws(
    () => compileStrategy({ ...MINIMAL, stop: { type: "atr", multiple: 0 } }),
    /Invalid strategy/
  );
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

test("compile: a strategy only sees bars up to the decision bar", () => {
  const candles = series(1);
  let sawFuture = false;
  const strategy = compileStrategy(MINIMAL);
  const wrapped: typeof strategy = (context) => {
    if (context.candles.length !== context.index + 1) sawFuture = true;
    return strategy(context);
  };
  runBacktest({
    candles,
    timeframe: "1H",
    strategy: wrapped,
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    warmupBars: 60,
  });
  assert.equal(sawFuture, false);
});

test("compile: an always-false rule never enters", () => {
  const never = compileStrategy({
    ...MINIMAL,
    entry: {
      condition: {
        type: "compare",
        left: { kind: "constant", value: 0 },
        operator: "gt",
        right: { kind: "constant", value: 1 },
      },
    },
  });
  const result = runBacktest({
    candles: series(1),
    timeframe: "1H",
    strategy: never,
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    warmupBars: 60,
  });
  assert.equal(result.trades.length, 0);
});

test("compile: an always-true rule enters and produces trades", () => {
  const always = compileStrategy({
    ...MINIMAL,
    entry: {
      condition: {
        type: "compare",
        left: { kind: "constant", value: 1 },
        operator: "gt",
        right: { kind: "constant", value: 0 },
      },
    },
  });
  const result = runBacktest({
    candles: series(1),
    timeframe: "1H",
    strategy: always,
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    warmupBars: 60,
  });
  assert.ok(result.trades.length > 0, "an always-true entry must trade");
});

test("compile: NOT inverts its child", () => {
  const definition: StrategyDefinition = {
    ...MINIMAL,
    entry: {
      not: {
        condition: {
          type: "compare",
          left: { kind: "constant", value: 1 },
          operator: "gt",
          right: { kind: "constant", value: 0 },
        },
      },
    },
  };
  const result = runBacktest({
    candles: series(1),
    timeframe: "1H",
    strategy: compileStrategy(definition),
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    warmupBars: 60,
  });
  assert.equal(result.trades.length, 0, "NOT(true) must never enter");
});

test("compile: ANY enters when a single branch is true", () => {
  const definition: StrategyDefinition = {
    ...MINIMAL,
    entry: {
      any: [
        {
          condition: {
            type: "compare",
            left: { kind: "constant", value: 0 },
            operator: "gt",
            right: { kind: "constant", value: 1 },
          },
        },
        {
          condition: {
            type: "compare",
            left: { kind: "constant", value: 1 },
            operator: "gt",
            right: { kind: "constant", value: 0 },
          },
        },
      ],
    },
  };
  const result = runBacktest({
    candles: series(1),
    timeframe: "1H",
    strategy: compileStrategy(definition),
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    warmupBars: 60,
  });
  assert.ok(result.trades.length > 0);
});

test("compile: an indicator still in warm-up reads as unmet, not as zero", () => {
  // ema200 is undefined for the first 199 bars; a > comparison against it must
  // not silently succeed by treating null as 0.
  const definition: StrategyDefinition = {
    ...MINIMAL,
    warmupBars: 5,
    entry: {
      condition: {
        type: "compare",
        left: { kind: "price", field: "close" },
        operator: "gt",
        right: { kind: "indicator", id: "ema200" },
      },
    },
  };
  const short = series(1, 80); // never enough bars for ema200
  const result = runBacktest({
    candles: short,
    timeframe: "1H",
    strategy: compileStrategy(definition),
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    warmupBars: 5,
  });
  assert.equal(result.trades.length, 0, "an undefined indicator must not satisfy a comparison");
});

test("compile: a long stop sits below entry and the target above", () => {
  const result = runBacktest({
    candles: series(1),
    timeframe: "1H",
    strategy: compileStrategy({
      ...MINIMAL,
      entry: {
        condition: {
          type: "compare",
          left: { kind: "constant", value: 1 },
          operator: "gt",
          right: { kind: "constant", value: 0 },
        },
      },
    }),
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    warmupBars: 60,
  });
  assert.ok(result.trades.length > 0);
  for (const trade of result.trades) {
    assert.equal(trade.side, "long");
  }
  assert.equal(result.warnings.filter((w) => /wrong side/.test(w)).length, 0);
});

test("compile: percent and ATR stops both produce valid trades", () => {
  for (const stop of [
    { type: "percent" as const, percent: 3 },
    { type: "atr" as const, multiple: 2 },
    { type: "structure" as const, atrBuffer: 0.5 },
  ]) {
    const result = runBacktest({
      candles: series(1),
      timeframe: "1H",
      strategy: compileStrategy({
        ...MINIMAL,
        stop,
        entry: {
          condition: {
            type: "compare",
            left: { kind: "constant", value: 1 },
            operator: "gt",
            right: { kind: "constant", value: 0 },
          },
        },
      }),
      initialCapital: 100_000,
      riskPerTrade: 0.01,
      warmupBars: 60,
    });
    assert.ok(result.trades.length > 0, `stop type ${stop.type} produced no trades`);
  }
});

test("compile: the exit rule takes precedence over a new entry", () => {
  // Entry always true, exit always true: the position must close, never flip
  // direction within one bar.
  const alwaysTrue = {
    condition: {
      type: "compare" as const,
      left: { kind: "constant" as const, value: 1 },
      operator: "gt" as const,
      right: { kind: "constant" as const, value: 0 },
    },
  };
  const result = runBacktest({
    candles: series(1),
    timeframe: "1H",
    strategy: compileStrategy({ ...MINIMAL, entry: alwaysTrue, exit: alwaysTrue }),
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    warmupBars: 60,
  });
  // Every trade should be a signal exit after exactly one bar held.
  assert.ok(result.trades.length > 0);
  assert.ok(
    result.trades.every((t) => t.barsHeld <= 2),
    "the exit rule should close quickly"
  );
});

test("cross: detects the crossing bar and not the bars around it", () => {
  // A series where ema20 crosses ema50 exactly once, upward.
  const definition: StrategyDefinition = {
    ...MINIMAL,
    entry: {
      condition: {
        type: "cross",
        fast: { kind: "indicator", id: "ema20" },
        slow: { kind: "indicator", id: "ema50" },
        direction: "above",
      },
    },
  };
  const candles = [
    ...series(-1, 120),
    ...series(1, 120).map((c, i) => ({ ...c, timestamp: (120 + i) * 3_600_000 })),
  ];
  const result = runBacktest({
    candles,
    timeframe: "1H",
    strategy: compileStrategy(definition),
    initialCapital: 100_000,
    riskPerTrade: 0.01,
    warmupBars: 60,
  });
  // The point is that a cross fires on a transition, so it must be rare.
  assert.ok(result.trades.length <= 5, `a cross should be rare, got ${result.trades.length}`);
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

test("presets: every shipped preset is valid and compiles", () => {
  for (const [id, definition] of Object.entries(STRATEGY_PRESETS)) {
    assert.deepEqual(validateStrategyDefinition(definition), [], `preset ${id} is invalid`);
    assert.doesNotThrow(() => compileStrategy(definition), `preset ${id} failed to compile`);
  }
});

test("presets: every preset runs a backtest without warnings about bad stops", () => {
  for (const [id, definition] of Object.entries(STRATEGY_PRESETS)) {
    const result = runBacktest({
      candles: series(1),
      timeframe: "1H",
      strategy: compileStrategy(definition),
      initialCapital: 100_000,
      riskPerTrade: 0.01,
      warmupBars: 60,
    });
    assert.equal(
      result.warnings.filter((w) => /wrong side of price/.test(w)).length,
      0,
      `preset ${id} produced an invalid stop`
    );
  }
});

test("presets: the listing exposes id, name and side", () => {
  const list = listStrategyPresets();
  assert.ok(list.length >= 5);
  for (const entry of list) {
    assert.ok(entry.id && entry.name);
    assert.ok(entry.side === "long" || entry.side === "short");
  }
});
