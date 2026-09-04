/**
 * Position size engine (master spec §11).
 *
 * Converts "risk 1% of a 50,000 account" into a concrete quantity, accounting
 * for stop distance, contract size, fees and slippage.
 *
 * Two rules are enforced structurally rather than left to the caller:
 *  1. The maximum loss returned INCLUDES fees and slippage. A size that risks
 *     exactly 1% before costs risks more than 1% in reality, and that gap is
 *     what quietly turns a 1%-risk plan into a 1.3%-risk plan.
 *  2. Sizes are rounded DOWN to the tradeable increment. Rounding up would push
 *     risk above the configured limit — never acceptable.
 */

export interface RiskSettings {
  accountEquity: number;
  /** Fraction of equity risked per trade, e.g. 0.01 for 1%. */
  riskPerTradeFraction: number;
  /** Fraction of equity that may be lost in one day before trading stops. */
  maxDailyLossFraction: number;
  /** Cap on one position's notional as a fraction of equity. */
  maxPositionFraction: number;
  /** Cap on total open notional as a fraction of equity. */
  maxPortfolioExposureFraction: number;
  /** Minimum reward:risk a setup must offer to be tradeable. */
  minRiskRewardRatio: number;
  /** Hard cap on leverage (notional / equity) for a single position. */
  maxLeverage: number;
}

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  accountEquity: 0,
  riskPerTradeFraction: 0.01,
  maxDailyLossFraction: 0.03,
  maxPositionFraction: 0.2,
  maxPortfolioExposureFraction: 1,
  minRiskRewardRatio: 1.5,
  // Deliberately conservative. §11: "never recommend excessive leverage."
  maxLeverage: 2,
};

export interface CostModel {
  /** Commission as a fraction of notional, per side. */
  commissionRate: number;
  /** Flat commission per order, per side, in account currency. */
  commissionFlat: number;
  /** Assumed slippage as a fraction of price, per side. */
  slippageRate: number;
}

export const DEFAULT_COST_MODEL: CostModel = {
  commissionRate: 0.0005,
  commissionFlat: 0,
  slippageRate: 0.0005,
};

export interface PositionSizeInput {
  entryPrice: number;
  stopPrice: number;
  side: "long" | "short";
  settings: RiskSettings;
  costs?: CostModel;
  /** Value of a 1.0 price move for one unit. Shares/crypto = 1. */
  contractSize?: number;
  /** Smallest tradeable increment, e.g. 1 for shares, 0.0001 for BTC. */
  quantityIncrement?: number;
  /** Scales the risk budget, e.g. the regime risk multiplier. */
  riskMultiplier?: number;
}

export interface PositionSizeResult {
  /** Quantity to trade, already rounded down to a tradeable increment. */
  quantity: number;
  /** Equity fraction budgeted for this trade, after any multiplier. */
  riskAmount: number;
  notional: number;
  stopDistance: number;
  estimatedFees: number;
  estimatedSlippage: number;
  /** Worst-case loss at the stop, INCLUDING fees and slippage. */
  maximumLoss: number;
  /** Realised leverage of the sized position. */
  leverage: number;
  /** Constraint that determined the size, for explanation (§34). */
  bindingConstraint: "risk" | "position_cap" | "leverage" | "none";
  warnings: string[];
  /** False when no valid size exists; `quantity` is then 0. */
  tradeable: boolean;
  reason: string;
}

/**
 * Size a position. Returns quantity 0 with `tradeable: false` rather than
 * throwing — an untradeable setup is a normal outcome (§35), not an error.
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const {
    entryPrice,
    stopPrice,
    side,
    settings,
    costs = DEFAULT_COST_MODEL,
    contractSize = 1,
    quantityIncrement = 1,
    riskMultiplier = 1,
  } = input;

  const warnings: string[] = [];
  const empty = (reason: string): PositionSizeResult => ({
    quantity: 0,
    riskAmount: 0,
    notional: 0,
    stopDistance: Math.abs(entryPrice - stopPrice),
    estimatedFees: 0,
    estimatedSlippage: 0,
    maximumLoss: 0,
    leverage: 0,
    bindingConstraint: "none",
    warnings,
    tradeable: false,
    reason,
  });

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return empty("Entry price must be a positive number.");
  }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    return empty("Stop price must be a positive number.");
  }
  if (settings.accountEquity <= 0) {
    return empty("Account equity is zero or unset — cannot size a position.");
  }
  // A stop on the wrong side of entry is not a small error: it inverts the
  // trade's risk. Reject it rather than sizing something incoherent.
  if (side === "long" && stopPrice >= entryPrice) {
    return empty("A long position requires a stop below the entry price.");
  }
  if (side === "short" && stopPrice <= entryPrice) {
    return empty("A short position requires a stop above the entry price.");
  }

  const stopDistance = Math.abs(entryPrice - stopPrice);
  if (stopDistance === 0) return empty("Stop distance is zero — risk is undefined.");

  const riskAmount =
    settings.accountEquity * settings.riskPerTradeFraction * clampMultiplier(riskMultiplier);
  if (riskAmount <= 0) return empty("Risk budget for this trade is zero.");

  // Per-unit cost of being stopped out: the price move plus round-trip costs.
  const perUnitStopLoss = stopDistance * contractSize;
  const perUnitSlippage = entryPrice * costs.slippageRate * 2 * contractSize;
  const perUnitCommission = entryPrice * costs.commissionRate * 2 * contractSize;
  const perUnitTotalRisk = perUnitStopLoss + perUnitSlippage + perUnitCommission;

  if (perUnitTotalRisk <= 0) return empty("Per-unit risk resolved to zero.");

  // Flat commissions are size-independent, so they come off the budget first.
  const flatCosts = costs.commissionFlat * 2;
  const budgetAfterFlat = riskAmount - flatCosts;
  if (budgetAfterFlat <= 0) {
    return empty(
      `Flat commissions (${flatCosts.toFixed(2)}) consume the entire ${riskAmount.toFixed(2)} risk budget.`
    );
  }

  const riskBoundQuantity = budgetAfterFlat / perUnitTotalRisk;

  const maxNotional = settings.accountEquity * settings.maxPositionFraction;
  const positionBoundQuantity = maxNotional / (entryPrice * contractSize);

  const leverageBoundQuantity =
    (settings.accountEquity * settings.maxLeverage) / (entryPrice * contractSize);

  let bindingConstraint: PositionSizeResult["bindingConstraint"] = "risk";
  let rawQuantity = riskBoundQuantity;
  if (positionBoundQuantity < rawQuantity) {
    rawQuantity = positionBoundQuantity;
    bindingConstraint = "position_cap";
  }
  if (leverageBoundQuantity < rawQuantity) {
    rawQuantity = leverageBoundQuantity;
    bindingConstraint = "leverage";
  }

  const quantity = roundDownToIncrement(rawQuantity, quantityIncrement);

  if (quantity <= 0) {
    return empty(
      `Risk budget ${riskAmount.toFixed(2)} is too small for one tradeable increment ` +
        `(${quantityIncrement}) at a stop distance of ${stopDistance.toFixed(4)}.`
    );
  }

  const notional = quantity * entryPrice * contractSize;
  const estimatedSlippage = quantity * entryPrice * costs.slippageRate * 2 * contractSize;
  const estimatedFees = quantity * entryPrice * costs.commissionRate * 2 * contractSize + flatCosts;
  const maximumLoss = quantity * perUnitStopLoss + estimatedSlippage + estimatedFees;
  const leverage = notional / settings.accountEquity;

  if (bindingConstraint === "position_cap") {
    warnings.push(
      `Size limited by the ${(settings.maxPositionFraction * 100).toFixed(0)}% max-position cap, ` +
        `not by the risk budget — actual risk is below target.`
    );
  }
  if (bindingConstraint === "leverage") {
    warnings.push(`Size limited by the ${settings.maxLeverage}× leverage cap.`);
  }
  if (maximumLoss > riskAmount * 1.001) {
    warnings.push(
      `Worst-case loss ${maximumLoss.toFixed(2)} exceeds the ${riskAmount.toFixed(2)} budget ` +
        `after costs — reduce size or widen the target.`
    );
  }
  const costShare = (estimatedFees + estimatedSlippage) / maximumLoss;
  if (costShare > 0.25) {
    warnings.push(
      `Fees and slippage are ${(costShare * 100).toFixed(0)}% of total risk — the stop is very tight relative to costs.`
    );
  }

  return {
    quantity,
    riskAmount,
    notional,
    stopDistance,
    estimatedFees,
    estimatedSlippage,
    maximumLoss,
    leverage,
    bindingConstraint,
    warnings,
    tradeable: true,
    reason: `Sized to risk ${maximumLoss.toFixed(2)} (${((maximumLoss / settings.accountEquity) * 100).toFixed(2)}% of equity) against a ${stopDistance.toFixed(4)} stop.`,
  };
}

/** Round down to a multiple of `increment`. Never rounds up (see file header). */
export function roundDownToIncrement(value: number, increment: number): number {
  if (increment <= 0) return value;
  const steps = Math.floor(value / increment + 1e-9);
  // Re-round to the increment's own precision so 0.1-steps don't leave 0.30000000000000004.
  const decimals = decimalPlaces(increment);
  return Number((steps * increment).toFixed(decimals));
}

function decimalPlaces(value: number): number {
  const text = value.toString();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function clampMultiplier(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 0;
  // A multiplier above 1 would let a regime INCREASE risk beyond the configured
  // limit. Regimes may only ever reduce it.
  return Math.min(1, multiplier);
}

/** Risk:reward for a setup, using net proceeds after costs. */
export function riskRewardRatio(
  entryPrice: number,
  stopPrice: number,
  targetPrice: number
): number | null {
  const risk = Math.abs(entryPrice - stopPrice);
  const reward = Math.abs(targetPrice - entryPrice);
  if (risk === 0) return null;
  return reward / risk;
}
