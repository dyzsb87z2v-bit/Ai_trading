/**
 * Portfolio analytics, correlation risk and journal metrics
 * (master spec §17, §23, §24).
 *
 * The headline job of this module is to answer a question users rarely ask
 * themselves: "how many of my positions are actually the same bet?" Five
 * separate tickers that all rise and fall together is one position with five
 * sets of fees, and the account is exposed accordingly.
 */

export interface PortfolioPosition {
  symbol: string;
  side: "long" | "short";
  quantity: number;
  averageEntryPrice: number;
  /** Latest mark. Null when no fresh price is available for the symbol. */
  markPrice: number | null;
  contractSize?: number;
  sector?: string;
  currency?: string;
  assetClass?: string;
}

export interface PortfolioSummary {
  totalEquity: number;
  cash: number;
  invested: number;
  unrealizedPnl: number;
  realizedPnl: number;
  /** Gross notional as a fraction of equity. */
  grossExposure: number;
  /** Net directional notional as a fraction of equity. */
  netExposure: number;
  /** Symbols whose mark is missing — their value is EXCLUDED, not guessed. */
  unpricedSymbols: string[];
  positions: number;
}

export function summarizePortfolio(
  positions: readonly PortfolioPosition[],
  cash: number,
  realizedPnl: number
): PortfolioSummary {
  let invested = 0;
  let unrealizedPnl = 0;
  let longNotional = 0;
  let shortNotional = 0;
  const unpricedSymbols: string[] = [];

  for (const position of positions) {
    const contractSize = position.contractSize ?? 1;
    if (position.markPrice === null) {
      // A position we cannot price is reported, not valued at cost — pretending
      // cost is market value is how a stale book hides a loss.
      unpricedSymbols.push(position.symbol);
      continue;
    }
    const notional = position.markPrice * position.quantity * contractSize;
    const direction = position.side === "long" ? 1 : -1;
    invested += Math.abs(notional);
    unrealizedPnl +=
      (position.markPrice - position.averageEntryPrice) *
      direction *
      position.quantity *
      contractSize;
    if (direction > 0) longNotional += notional;
    else shortNotional += notional;
  }

  const totalEquity = cash + unrealizedPnl;
  return {
    totalEquity,
    cash,
    invested,
    unrealizedPnl,
    realizedPnl,
    grossExposure: totalEquity === 0 ? 0 : (longNotional + shortNotional) / totalEquity,
    netExposure: totalEquity === 0 ? 0 : (longNotional - shortNotional) / totalEquity,
    unpricedSymbols,
    positions: positions.length,
  };
}

/**
 * Pearson correlation of two aligned return series.
 * Returns null when the inputs are too short or either series has no variance —
 * a "correlation" against a constant is undefined, not zero.
 */
export function correlation(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;

  const meanA = a.reduce((x, y) => x + y, 0) / a.length;
  const meanB = b.reduce((x, y) => x + y, 0) / b.length;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  if (varianceA === 0 || varianceB === 0) return null;
  return covariance / Math.sqrt(varianceA * varianceB);
}

/** Simple returns from a close series. */
export function toReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] === 0) continue;
    out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return out;
}

export interface CorrelationPair {
  symbolA: string;
  symbolB: string;
  correlation: number;
  /** Combined notional of the pair, as a fraction of equity. */
  combinedExposure: number;
}

export interface ConcentrationBucket {
  key: string;
  exposure: number;
  symbols: string[];
}

export interface PortfolioRiskReport {
  highlyCorrelatedPairs: CorrelationPair[];
  sectorConcentration: ConcentrationBucket[];
  currencyConcentration: ConcentrationBucket[];
  assetClassConcentration: ConcentrationBucket[];
  /** Symbols with no return history — excluded from correlation, not assumed 0. */
  symbolsWithoutHistory: string[];
  warnings: string[];
}

export interface PortfolioRiskOptions {
  /** |ρ| at or above this counts as "the same bet". */
  correlationThreshold?: number;
  /** Bucket exposure above this fraction of equity raises a concentration flag. */
  concentrationThreshold?: number;
}

/**
 * Assess portfolio-level risk (§17).
 *
 * Correlation uses returns the CALLER supplies — this module never fabricates a
 * price history to fill a gap. Symbols without history are named in the report
 * so the user knows the analysis is partial rather than clean.
 */
export function assessPortfolioRisk(
  positions: readonly PortfolioPosition[],
  returnsBySymbol: Readonly<Record<string, readonly number[]>>,
  equity: number,
  options: PortfolioRiskOptions = {}
): PortfolioRiskReport {
  const correlationThreshold = options.correlationThreshold ?? 0.7;
  const concentrationThreshold = options.concentrationThreshold ?? 0.4;
  const warnings: string[] = [];
  const symbolsWithoutHistory: string[] = [];

  const notionalOf = (position: PortfolioPosition): number => {
    if (position.markPrice === null) return 0;
    return Math.abs(position.markPrice * position.quantity * (position.contractSize ?? 1));
  };

  for (const position of positions) {
    const history = returnsBySymbol[position.symbol];
    if (!history || history.length < 3) symbolsWithoutHistory.push(position.symbol);
  }

  const highlyCorrelatedPairs: CorrelationPair[] = [];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i];
      const b = positions[j];
      const returnsA = returnsBySymbol[a.symbol];
      const returnsB = returnsBySymbol[b.symbol];
      if (!returnsA || !returnsB) continue;

      const length = Math.min(returnsA.length, returnsB.length);
      if (length < 3) continue;
      // Align on the most recent overlapping window.
      const rho = correlation(returnsA.slice(-length), returnsB.slice(-length));
      if (rho === null) continue;

      // Two SHORTS in correlated names are also the same bet; two opposite
      // sides in correlated names partially hedge. Adjust the sign accordingly.
      const sameDirection = a.side === b.side;
      const effective = sameDirection ? rho : -rho;

      if (Math.abs(effective) >= correlationThreshold && effective > 0) {
        highlyCorrelatedPairs.push({
          symbolA: a.symbol,
          symbolB: b.symbol,
          correlation: rho,
          combinedExposure: equity === 0 ? 0 : (notionalOf(a) + notionalOf(b)) / equity,
        });
      }
    }
  }
  highlyCorrelatedPairs.sort((x, y) => y.combinedExposure - x.combinedExposure);

  const bucket = (key: keyof PortfolioPosition): ConcentrationBucket[] => {
    const map = new Map<string, { exposure: number; symbols: string[] }>();
    for (const position of positions) {
      const value = position[key];
      if (typeof value !== "string") continue;
      const entry = map.get(value) ?? { exposure: 0, symbols: [] };
      entry.exposure += notionalOf(position);
      entry.symbols.push(position.symbol);
      map.set(value, entry);
    }
    return [...map.entries()]
      .map(([bucketKey, value]) => ({
        key: bucketKey,
        exposure: equity === 0 ? 0 : value.exposure / equity,
        symbols: value.symbols,
      }))
      .sort((a, b) => b.exposure - a.exposure);
  };

  const sectorConcentration = bucket("sector");
  const currencyConcentration = bucket("currency");
  const assetClassConcentration = bucket("assetClass");

  if (highlyCorrelatedPairs.length > 0) {
    const top = highlyCorrelatedPairs[0];
    warnings.push(
      `HIGH CORRELATION RISK — ${top.symbolA} and ${top.symbolB} move together ` +
        `(ρ = ${top.correlation.toFixed(2)}) and together carry ` +
        `${(top.combinedExposure * 100).toFixed(0)}% of equity in exposure.`
    );
  }
  for (const [label, buckets] of [
    ["Sector", sectorConcentration],
    ["Currency", currencyConcentration],
    ["Asset class", assetClassConcentration],
  ] as const) {
    const over = buckets.filter((b) => b.exposure >= concentrationThreshold);
    for (const item of over) {
      warnings.push(
        `${label} concentration — ${(item.exposure * 100).toFixed(0)}% of equity is in ` +
          `"${item.key}" (${item.symbols.join(", ")}).`
      );
    }
  }
  if (symbolsWithoutHistory.length > 0) {
    warnings.push(
      `Correlation analysis is incomplete: no return history for ${symbolsWithoutHistory.join(", ")}.`
    );
  }

  return {
    highlyCorrelatedPairs,
    sectorConcentration,
    currencyConcentration,
    assetClassConcentration,
    symbolsWithoutHistory,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Journal analytics (§23)
// ---------------------------------------------------------------------------

export interface JournalTrade {
  closedAt: number;
  netPnl: number;
  /** Risk taken at entry, for R-multiple statistics. */
  riskAmount: number | null;
  strategy?: string;
}

export interface JournalStatistics {
  totalTrades: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  /** Mean R-multiple across trades that recorded their risk. */
  averageR: number | null;
  averageWin: number;
  averageLoss: number;
  netPnl: number;
  maxDrawdown: number;
  byPeriod: {
    daily: PeriodPnl[];
    weekly: PeriodPnl[];
    monthly: PeriodPnl[];
  };
}

export interface PeriodPnl {
  /** ISO-ish period key: 2026-09-04, 2026-W36, 2026-09. */
  period: string;
  netPnl: number;
  trades: number;
}

export function computeJournalStatistics(trades: readonly JournalTrade[]): JournalStatistics {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const wins = sorted.filter((t) => t.netPnl > 0);
  const losses = sorted.filter((t) => t.netPnl < 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.netPnl, 0));
  const netPnl = sorted.reduce((sum, t) => sum + t.netPnl, 0);

  const winRate = sorted.length === 0 ? 0 : wins.length / sorted.length;
  const averageWin = wins.length === 0 ? 0 : grossProfit / wins.length;
  const averageLoss = losses.length === 0 ? 0 : grossLoss / losses.length;

  const withRisk = sorted.filter(
    (t): t is JournalTrade & { riskAmount: number } => t.riskAmount !== null && t.riskAmount > 0
  );
  const averageR =
    withRisk.length === 0
      ? null
      : withRisk.reduce((sum, t) => sum + t.netPnl / t.riskAmount, 0) / withRisk.length;

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of sorted) {
    cumulative += trade.netPnl;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return {
    totalTrades: sorted.length,
    winRate,
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    expectancy: winRate * averageWin - (1 - winRate) * averageLoss,
    averageR,
    averageWin,
    averageLoss,
    netPnl,
    maxDrawdown,
    byPeriod: {
      daily: groupBy(sorted, dailyKey),
      weekly: groupBy(sorted, isoWeekKey),
      monthly: groupBy(sorted, monthlyKey),
    },
  };
}

function groupBy(
  trades: readonly JournalTrade[],
  keyFor: (timestamp: number) => string
): PeriodPnl[] {
  const map = new Map<string, PeriodPnl>();
  for (const trade of trades) {
    const period = keyFor(trade.closedAt);
    const entry = map.get(period) ?? { period, netPnl: 0, trades: 0 };
    entry.netPnl += trade.netPnl;
    entry.trades++;
    map.set(period, entry);
  }
  return [...map.values()].sort((a, b) => a.period.localeCompare(b.period));
}

function dailyKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function monthlyKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

/** ISO-8601 week key (weeks start Monday; week 1 contains the first Thursday). */
function isoWeekKey(timestamp: number): string {
  const date = new Date(timestamp);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNumber + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
