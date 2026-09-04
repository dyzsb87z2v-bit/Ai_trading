/**
 * Fibonacci retracements and extensions (master spec §5).
 *
 * Levels are geometry over a swing the caller supplies — they are descriptive,
 * not predictive, and this module makes no claim about what price will do at
 * them.
 */

export const RETRACEMENT_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;
export const EXTENSION_RATIOS = [1.272, 1.414, 1.618, 2, 2.618] as const;

export interface FibonacciLevel {
  ratio: number;
  price: number;
  label: string;
}

export interface Swing {
  /** Price where the move started. */
  from: number;
  /** Price where the move ended. */
  to: number;
}

/**
 * Retracement levels for a swing. Ratio 0 sits at the swing END and ratio 1 at
 * its START, so levels read the way a trader draws them: a 0.618 retracement of
 * an up-move is 61.8% of the way back down toward the low.
 */
export function fibonacciRetracements(
  swing: Swing,
  ratios: readonly number[] = RETRACEMENT_RATIOS
): FibonacciLevel[] {
  const distance = swing.to - swing.from;
  return ratios.map((ratio) => ({
    ratio,
    price: swing.to - distance * ratio,
    label: `${(ratio * 100).toFixed(1)}%`,
  }));
}

/**
 * Extension levels projected beyond the swing end, in the swing's direction.
 */
export function fibonacciExtensions(
  swing: Swing,
  ratios: readonly number[] = EXTENSION_RATIOS
): FibonacciLevel[] {
  const distance = swing.to - swing.from;
  return ratios.map((ratio) => ({
    ratio,
    price: swing.from + distance * ratio,
    label: `${(ratio * 100).toFixed(1)}%`,
  }));
}
