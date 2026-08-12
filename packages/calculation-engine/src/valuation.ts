import type { ValuationAssumptions, ValuationResult } from '@cre/domain-models';
import { Decimal, TWELVE, ZERO, d } from './decimal.js';
import type { ForecastCalendar } from './calendar.js';
import { discountFactors, slice } from './metrics.js';
import { TraceRecorder, traceInputs } from './trace.js';

export interface SaleResult {
  /** 0-based forecast index in which the sale occurs. */
  saleIndex: number;
  terminalNoi: Decimal;
  terminalNoiBasis: string;
  grossSalePrice: Decimal;
  sellingCosts: Decimal;
  netSaleProceeds: Decimal;
}

export interface ValuationContext {
  calendar: ForecastCalendar;
  assumptions: ValuationAssumptions;
  /** Net operating income per period. */
  noi: Decimal[];
  /** Unlevered cash flow per period, excluding any sale proceeds. */
  unleveredCashFlow: Decimal[];
  rentableArea: Decimal;
  unitCount: number;
  trace: TraceRecorder;
}

/**
 * Resolves the disposition: which month, what NOI capitalises into the exit
 * price, and the net proceeds after costs of sale.
 *
 * A forward-twelve-month terminal NOI needs twelve months of forecast beyond
 * the sale date. When the forecast is too short the engine falls back to the
 * trailing twelve months and says so, rather than silently capitalising a
 * partial year.
 */
export function computeSale(ctx: ValuationContext): SaleResult | null {
  const { assumptions, calendar, noi } = ctx;
  const months = calendar.periods.length;
  const saleIndex = (assumptions.saleMonth ?? months) - 1;

  if (saleIndex < 0 || saleIndex >= months) {
    ctx.trace.error(
      'SALE_MONTH_OUT_OF_RANGE',
      `The modelled sale month (${assumptions.saleMonth}) falls outside the ${months}-month forecast.`,
      'valuation',
      'saleMonth',
    );
    return null;
  }

  const capRate = assumptions.terminalCapRate ? d(assumptions.terminalCapRate) : null;
  const override = assumptions.grossSalePriceOverride
    ? d(assumptions.grossSalePriceOverride)
    : null;

  if (!capRate && !override) {
    ctx.trace.error(
      'MISSING_EXIT_ASSUMPTION',
      'The model has no exit capitalisation rate and no gross sale price override, so no terminal value can be calculated.',
      'valuation',
      'terminalCapRate',
    );
    return null;
  }

  let basis = assumptions.terminalNoiBasis;
  let terminalNoi: Decimal;

  if (basis === 'forward_12') {
    const available = months - (saleIndex + 1);
    if (available >= 12) {
      terminalNoi = slice(noi, saleIndex + 1, saleIndex + 13);
    } else {
      ctx.trace.warn(
        'FORWARD_NOI_UNAVAILABLE',
        `A forward twelve-month terminal NOI needs 12 forecast months after the sale, but only ${available} are modelled. The trailing twelve months were used instead. Extend the forecast past the sale date to use a forward NOI.`,
        'valuation',
        'terminalNoiBasis',
      );
      basis = 'trailing_12';
      terminalNoi = slice(noi, saleIndex - 11, saleIndex + 1);
    }
  } else {
    terminalNoi = slice(noi, saleIndex - 11, saleIndex + 1);
  }

  // Annualise if the window ran short at the start of the forecast.
  const windowMonths = basis === 'forward_12' ? 12 : Math.min(12, saleIndex + 1);
  if (windowMonths < 12 && windowMonths > 0) {
    terminalNoi = terminalNoi.times(TWELVE).dividedBy(windowMonths);
  }

  const grossSalePrice =
    override ?? (capRate && !capRate.isZero() ? terminalNoi.dividedBy(capRate) : ZERO);
  if (!override && capRate && capRate.isZero()) {
    ctx.trace.error(
      'ZERO_EXIT_CAP_RATE',
      'The exit capitalisation rate is zero, which has no finite terminal value.',
      'valuation',
      'terminalCapRate',
    );
    return null;
  }

  const sellingCosts = grossSalePrice.times(d(assumptions.saleCostPercent));
  const netSaleProceeds = grossSalePrice.minus(sellingCosts);

  ctx.trace.record({
    target: 'valuation:sale',
    formula: 'valuation.terminalValue',
    description: override
      ? `Gross sale price taken from the stated override in forecast month ${saleIndex + 1}.`
      : `Terminal value = ${basis === 'forward_12' ? 'forward' : 'trailing'} twelve-month NOI divided by the exit capitalisation rate, in forecast month ${saleIndex + 1}.`,
    inputs: traceInputs({
      saleMonth: saleIndex + 1,
      terminalNoiBasis: basis,
      terminalNoi,
      exitCapRate: capRate ?? 'n/a (override used)',
      saleCostPercent: assumptions.saleCostPercent,
      sellingCosts,
    }),
    result: netSaleProceeds.toString(),
    sources: ['valuation'],
    periodIndex: saleIndex + 1,
  });

  return {
    saleIndex,
    terminalNoi,
    terminalNoiBasis: basis,
    grossSalePrice,
    sellingCosts,
    netSaleProceeds,
  };
}

/**
 * Discounted cash-flow valuation: the present value of unlevered property cash
 * flow through the sale date plus the present value of the net sale proceeds.
 */
export function computeDcf(ctx: ValuationContext, sale: SaleResult | null): ValuationResult | null {
  const discountRate = d(ctx.assumptions.discountRate);
  if (discountRate.isZero() && !ctx.assumptions.discountRate) {
    ctx.trace.error(
      'MISSING_DISCOUNT_RATE',
      'No discount rate is set, so no discounted cash-flow value can be calculated.',
      'valuation',
      'discountRate',
    );
    return null;
  }
  if (!sale) return null;

  const convention = ctx.assumptions.discountingConvention;
  const detail: NonNullable<ValuationResult['presentValueByPeriod']> = [];
  let pvCashFlow = ZERO;

  // One pass for the whole series; see `discountFactors` on why taking the
  // fractional power once matters.
  const factors = discountFactors(discountRate, sale.saleIndex + 1, convention);

  for (let i = 0; i <= sale.saleIndex; i += 1) {
    const cashFlow = ctx.unleveredCashFlow[i] ?? ZERO;
    const factor = factors[i] as Decimal;
    const pv = cashFlow.times(factor);
    pvCashFlow = pvCashFlow.plus(pv);
    detail.push({
      periodIndex: i + 1,
      cashFlow: cashFlow.toString(),
      discountFactor: factor.toString(),
      presentValue: pv.toString(),
    });
  }

  // The reversion is discounted at the sale date on the same convention as the
  // operating cash flows so the two are consistent.
  const reversionFactor = factors[sale.saleIndex] as Decimal;
  const pvReversion = sale.netSaleProceeds.times(reversionFactor);
  const value = pvCashFlow.plus(pvReversion);

  ctx.trace.record({
    target: 'valuation:dcf',
    formula: 'valuation.dcf',
    description: `Discounted cash-flow value: present value of ${sale.saleIndex + 1} months of unlevered cash flow plus the present value of net sale proceeds, discounted at ${discountRate.times(100).toFixed(4)}% (${convention.replace(/_/g, ' ')}).`,
    inputs: traceInputs({
      discountRate,
      convention,
      presentValueOfCashFlow: pvCashFlow,
      netSaleProceeds: sale.netSaleProceeds,
      reversionDiscountFactor: reversionFactor,
      presentValueOfReversion: pvReversion,
    }),
    result: value.toString(),
    sources: ['valuation'],
  });

  return {
    method: 'dcf',
    value: value.toString(),
    detail: {
      presentValueOfCashFlow: pvCashFlow.toString(),
      presentValueOfReversion: pvReversion.toString(),
      discountRate: discountRate.toString(),
      discountingConvention: convention,
      saleMonth: String(sale.saleIndex + 1),
      terminalNoi: sale.terminalNoi.toString(),
      terminalNoiBasis: sale.terminalNoiBasis,
      grossSalePrice: sale.grossSalePrice.toString(),
      sellingCosts: sale.sellingCosts.toString(),
      valuePerArea: ctx.rentableArea.isZero() ? '0' : value.dividedBy(ctx.rentableArea).toString(),
      valuePerUnit: ctx.unitCount === 0 ? '0' : value.dividedBy(ctx.unitCount).toString(),
    },
    presentValueByPeriod: detail,
  };
}

/** Direct capitalisation: a selected NOI divided by a capitalisation rate. */
export function computeDirectCapitalization(ctx: ValuationContext): ValuationResult | null {
  // Not configured at all and configured to literally 0% are different
  // things. The first means direct capitalisation was never requested as a
  // valuation method, and silently producing nothing is correct. The second
  // is a rate with no finite value to divide by — the same situation
  // `computeSale` already names with `ZERO_EXIT_CAP_RATE` for the exit cap
  // rate — and deserves the same diagnostic rather than looking identical to
  // "not requested".
  if (ctx.assumptions.directCapRate === null || ctx.assumptions.directCapRate === undefined) {
    return null;
  }
  const rate = d(ctx.assumptions.directCapRate);
  if (rate.isZero()) {
    ctx.trace.error(
      'ZERO_DIRECT_CAP_RATE',
      'The direct capitalisation rate is zero, which has no finite value.',
      'valuation',
      'directCapRate',
    );
    return null;
  }

  const { noi, calendar } = ctx;
  let selectedNoi: Decimal;
  let basisLabel: string;

  switch (ctx.assumptions.directCapNoiBasis) {
    case 'trailing_12': {
      const monthsAvailable = Math.min(12, noi.length);
      selectedNoi = slice(noi, Math.max(0, noi.length - 12), noi.length);
      // A forecast shorter than 12 months has no trailing twelve to select —
      // what it has is annualised, the same way `year_1` already does below,
      // rather than reported as however many months happen to exist. Reusing
      // the raw sum here understated value on any short forecast: half of it
      // on a 6-month one, since it was the "trailing twelve" divided by a
      // cap rate calibrated to a full year's income.
      if (monthsAvailable < 12 && monthsAvailable > 0) {
        selectedNoi = selectedNoi.times(TWELVE).dividedBy(monthsAvailable);
      }
      basisLabel = 'trailing twelve months of the forecast';
      break;
    }
    case 'stabilized': {
      // The stabilised year is the first fiscal year whose NOI stops growing by
      // more than 2% against the following year, or the last full year.
      const years = [...calendar.periodsByFiscalYear.entries()].sort((a, b) => a[0] - b[0]);
      const annual = years.map(([year, indices]) => ({
        year,
        months: indices.length,
        noi: indices.reduce((acc, i) => acc.plus(noi[i] ?? ZERO), ZERO),
      }));
      const full = annual.filter((entry) => entry.months === 12);
      let chosen = full[full.length - 1] ?? annual[annual.length - 1];
      for (let i = 0; i < full.length - 1; i += 1) {
        const current = full[i] as { noi: Decimal };
        const next = full[i + 1] as { noi: Decimal };
        if (current.noi.isZero()) continue;
        const growth = next.noi.minus(current.noi).dividedBy(current.noi).abs();
        if (growth.lessThan('0.02')) {
          chosen = full[i];
          break;
        }
      }
      selectedNoi = chosen ? chosen.noi : ZERO;
      // No full fiscal year exists yet on a forecast shorter than one (the
      // same reason `full` can be empty and this falls back to a partial
      // `annual[]` entry) — annualise it rather than capitalising a partial
      // year's income at a full-year cap rate.
      if (chosen && chosen.months < 12 && chosen.months > 0) {
        selectedNoi = selectedNoi.times(TWELVE).dividedBy(chosen.months);
      }
      basisLabel = `stabilised year (FY${chosen?.year ?? 'n/a'})`;
      break;
    }
    case 'year_1':
    default: {
      const monthsAvailable = Math.min(12, noi.length);
      selectedNoi = slice(noi, 0, monthsAvailable);
      if (monthsAvailable < 12 && monthsAvailable > 0) {
        selectedNoi = selectedNoi.times(TWELVE).dividedBy(monthsAvailable);
      }
      basisLabel = 'first twelve forecast months';
      break;
    }
  }

  const adjustments = d(ctx.assumptions.directCapAdjustments);
  const value = selectedNoi.dividedBy(rate).plus(adjustments);

  ctx.trace.record({
    target: 'valuation:directCapitalization',
    formula: 'valuation.directCapitalization',
    description: `Direct capitalisation: NOI from the ${basisLabel} divided by a ${rate.times(100).toFixed(4)}% capitalisation rate, adjusted by ${adjustments.toFixed(2)}.`,
    inputs: traceInputs({ selectedNoi, capRate: rate, adjustments, basis: basisLabel }),
    result: value.toString(),
    sources: ['valuation'],
  });

  return {
    method: 'direct_capitalization',
    value: value.toString(),
    detail: {
      selectedNoi: selectedNoi.toString(),
      noiBasis: basisLabel,
      capRate: rate.toString(),
      adjustments: adjustments.toString(),
      valuePerArea: ctx.rentableArea.isZero() ? '0' : value.dividedBy(ctx.rentableArea).toString(),
      valuePerUnit: ctx.unitCount === 0 ? '0' : value.dividedBy(ctx.unitCount).toString(),
    },
  };
}
