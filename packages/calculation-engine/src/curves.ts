import type { GrowthCurve } from '@cre/domain-models';
import { Decimal, ONE, d } from './decimal.js';
import type { ForecastCalendar } from './calendar.js';

/**
 * Growth curves turn annual rates into a per-period multiplier.
 *
 * A "forecast year" here is a block of twelve months starting at the forecast
 * start date, not a calendar year, so that a mid-year valuation date does not
 * quietly shift the first inflation step.
 */
export class CurveSet {
  private readonly curves = new Map<string, GrowthCurve>();
  /** curveId -> cumulative factor at the start of each forecast period. */
  private readonly factorCache = new Map<string, Decimal[]>();

  constructor(
    curves: GrowthCurve[],
    private readonly calendar: ForecastCalendar,
  ) {
    for (const curve of curves) this.curves.set(curve.id, curve);
  }

  has(curveId: string | null | undefined): boolean {
    return !!curveId && this.curves.has(curveId);
  }

  /** Annual rate for forecast year `year` (1-based). */
  rateForYear(curveId: string | null | undefined, year: number): Decimal {
    if (!curveId) return new Decimal(0);
    const curve = this.curves.get(curveId);
    if (!curve) return new Decimal(0);
    const override = curve.byYear.find((entry) => entry.year === year);
    return d(override ? override.rate : curve.defaultRate);
  }

  /**
   * Cumulative growth factor applied to a period, where the first twelve
   * forecast months carry a factor of 1.0 and growth compounds annually from
   * forecast year 2 onward.
   */
  factors(curveId: string | null | undefined): Decimal[] {
    if (!curveId) return this.calendar.periods.map(() => ONE);
    const cached = this.factorCache.get(curveId);
    if (cached) return cached;

    const factors: Decimal[] = [];
    let current = ONE;
    let appliedThroughYear = 1;
    for (let i = 0; i < this.calendar.periods.length; i += 1) {
      const forecastYear = Math.floor(i / 12) + 1;
      while (appliedThroughYear < forecastYear) {
        appliedThroughYear += 1;
        current = current.times(ONE.plus(this.rateForYear(curveId, appliedThroughYear)));
      }
      factors.push(current);
    }
    this.factorCache.set(curveId, factors);
    return factors;
  }

  /**
   * Growth factor from the forecast start to an arbitrary month offset, used
   * when a value must be grown past the end of the explicit forecast (for
   * example a terminal-year market rent).
   */
  factorAtMonthOffset(curveId: string | null | undefined, monthOffset: number): Decimal {
    if (!curveId) return ONE;
    const forecastYear = Math.floor(monthOffset / 12) + 1;
    let current = ONE;
    for (let year = 2; year <= forecastYear; year += 1) {
      current = current.times(ONE.plus(this.rateForYear(curveId, year)));
    }
    return current;
  }
}
