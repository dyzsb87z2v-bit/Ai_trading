/** Shared view types for the trading terminal (master spec §33). */

export interface TerminalCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TerminalQuote {
  last: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  volume: number | null;
  vwap: number | null;
  changePercent: number | null;
  session: string;
  provenance: { source: string; timestamp: number; status: string };
}

export interface ScoreFactorView {
  id: string;
  label: string;
  value: number;
  weight: number;
  evidence: string;
}

export interface WarningView {
  code: string;
  message: string;
  severity: "info" | "warning" | "critical";
}

export interface RiskCheckView {
  id: string;
  critical: boolean;
  passed: boolean;
  indeterminate: boolean;
  message: string;
}

export interface LevelView {
  price: number;
  touches: number;
  kind: "support" | "resistance";
}

export interface TradePlanView {
  side: "long" | "short";
  entryZoneLow: number;
  entryZoneHigh: number;
  preferredEntry: number;
  invalidation: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  riskReward: number | null;
  rationale: string[];
}

export interface AnalysisView {
  symbol: string;
  timeframe: string;
  generatedAt: number;
  dataStatus: string;
  dataSource: string;
  liveAnalysisAllowed: boolean;
  freshness: { status: string; ageMs: number; reason: string };
  seriesIntegrity: { ok: boolean; issues: string[] };
  verdict: "TRADEABLE" | "NO_TRADE" | "BLOCKED" | "DATA_UNAVAILABLE";
  reasons: string[];
  warnings: WarningView[];
  volatility: number | null;
  structure: {
    trend: string;
    trendStrength: number;
    volatility: string;
    atrPercent: number | null;
    support: LevelView[];
    resistance: LevelView[];
    rationale: string[];
  } | null;
  regime: { regime: string; confidence: number; riskMultiplier: number; evidence: string[] } | null;
  mtf: {
    alignment: string;
    aggregateBias: number;
    narrative: string;
    conflicts: string[];
    views: { timeframe: string; trend: string; evidence: string }[];
  } | null;
  signal: {
    score: number;
    state: string;
    grade: string;
    agreement: number;
    tradeable: boolean;
    factors: ScoreFactorView[];
    bullishReasons: string[];
    bearishReasons: string[];
    explanation: string;
  } | null;
  levels: TradePlanView | null;
  sizing: {
    tradeable: boolean;
    quantity: number;
    notional: number;
    riskAmount: number;
    maximumLoss: number;
    estimatedFees: number;
    estimatedSlippage: number;
    leverage: number;
    bindingConstraint: string;
    warnings: string[];
    reason: string;
  } | null;
  risk: {
    verdict: "ALLOWED" | "WARNED" | "BLOCKED";
    checks: RiskCheckView[];
    blockingReasons: string[];
    warnings: string[];
    summary: string;
  } | null;
}

export interface RiskSettingsView {
  accountEquity: number;
  riskPerTradeFraction: number;
  maxDailyLossFraction: number;
  maxPositionFraction: number;
  maxPortfolioExposureFraction: number;
  minRiskRewardRatio: number;
  maxLeverage: number;
  blockAroundHighImpactEvents: boolean;
  eventBlockWindowMinutes: number;
}

export interface ProviderStatusView {
  kind: string;
  unavailableMessage: string;
  registered: number;
  configured: number;
  activeId: string | null;
  available: boolean;
}
