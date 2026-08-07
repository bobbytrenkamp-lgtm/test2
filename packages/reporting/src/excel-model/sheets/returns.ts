import type { ModelInput, ModelResult } from '@cre/domain-models';
import type { WorkbookModel } from '../model.js';
import { LABEL_COL, TOTAL_COL } from '../layout.js';
import type { TimeAxis } from '../layout.js';

/**
 * Valuation and returns, calculated by Excel from the workbook's own numbers.
 *
 * The engine's IRR is deliberately **not** exported. If the workbook simply
 * displayed it, changing an assumption would move every cash flow and leave the
 * headline return sitting at its old value — the precise failure this feature
 * exists to prevent. `XIRR` over the Cash Flow sheet's own rows means the
 * return is a consequence of the model, not a caption on it.
 *
 * `XIRR` rather than `IRR` because the cash flows are monthly and dated: `IRR`
 * would return a monthly rate needing annualisation, while `XIRR` uses the
 * period end dates already on the schedule and returns an annual rate directly,
 * which is what the engine's `unleveredXirr` and `leveredXirr` report.
 */
export function buildReturns(
  workbook: WorkbookModel,
  input: ModelInput,
  result: ModelResult,
  axis: TimeAxis,
): void {
  const sheet = workbook.sheet('Returns', {
    freezeRows: 1,
    columnWidths: [
      { column: LABEL_COL, width: 40 },
      { column: TOTAL_COL, width: 20 },
    ],
  });

  sheet.at(sheet.claimRow(), LABEL_COL, {
    kind: 'header',
    value: 'Valuation and returns',
    format: 'text',
  });
  sheet.skipRows(1);

  const last = axis.count - 1;
  const saleMonth = input.valuation.saleMonth ?? axis.count;
  const saleIndex = Math.min(Math.max(saleMonth - 1, 0), last);

  /* ------------------------------------------------------------------ */
  sheet.section('Exit value');

  /*
   * The terminal NOI window, resolved exactly as the engine resolves it.
   *
   * Two rules that a naive "sum twelve months from the sale" misses, both
   * found by checking every cached value against its own formula:
   *
   * 1. **A forward window that does not fit falls back to trailing.** The
   *    engine requires a full twelve months *after* the sale; with fewer it
   *    switches basis and warns (`FORWARD_NOI_UNAVAILABLE`). Clamping the
   *    range instead — which is what this did first — silently produced a
   *    one-month NOI, and on the renewal-option fixture that understated the
   *    sale price by $2.36m, exactly twelve-fold.
   *
   * 2. **A short trailing window is annualised.** A sale early in the
   *    forecast has fewer than twelve months behind it, so the engine scales
   *    by `12 / months available` rather than capitalising a part-year figure.
   *
   * Both depend only on the sale month and the forecast length, so they are
   * settled here and the formula carries the resulting range and multiplier.
   */
  const monthsAfterSale = axis.count - (saleIndex + 1);
  const useForward = input.valuation.terminalNoiBasis === 'forward_12' && monthsAfterSale >= 12;

  const windowStart = useForward ? saleIndex + 1 : Math.max(saleIndex - 11, 0);
  const windowEnd = useForward ? saleIndex + 12 : saleIndex;
  const windowMonths = useForward ? 12 : Math.min(12, saleIndex + 1);
  const annualiser = windowMonths > 0 && windowMonths < 12 ? 12 / windowMonths : 1;

  const basisNote =
    input.valuation.terminalNoiBasis === 'forward_12' && !useForward
      ? `Basis: trailing_12. A forward window needs 12 months after the sale and only ` +
        `${monthsAfterSale} are modelled, so the engine falls back — this matches it.`
      : `Basis: ${useForward ? 'forward_12' : 'trailing_12'}` +
        (annualiser === 1 ? '.' : `, annualised from ${windowMonths} months.`);

  scalar(
    sheet,
    'Terminal NOI',
    {
      kind: 'formula',
      formula: (refs) => {
        const window = `SUM(${refs.range('cashFlow.netOperatingIncome', windowStart, windowEnd)})`;
        return annualiser === 1 ? window : `${window}*12/${windowMonths}`;
      },
      format: 'currency0',
      note: basisNote,
    },
    'returns.terminalNoi',
  );

  scalar(
    sheet,
    'Gross sale price',
    {
      kind: 'formula',
      formula: (refs) =>
        `IF(${refs.name('ExitCapRate')}=0,0,${refs.ref('returns.terminalNoi')}/${refs.name(
          'ExitCapRate',
        )})`,
      format: 'currency0',
      note: 'Guarded against a zero cap rate, which would otherwise show #DIV/0!.',
    },
    'returns.grossSalePrice',
  );

  scalar(
    sheet,
    'Selling costs',
    {
      kind: 'formula',
      formula: (refs) => `${refs.ref('returns.grossSalePrice')}*${refs.name('SellingCosts')}`,
      format: 'currency0',
    },
    'returns.sellingCosts',
  );

  scalar(
    sheet,
    'Net sale proceeds before debt',
    {
      kind: 'formula',
      formula: (refs) =>
        `${refs.ref('returns.grossSalePrice')}-${refs.ref('returns.sellingCosts')}`,
      format: 'currency0',
    },
    'returns.netSaleProceeds',
  );

  /* ------------------------------------------------------------------ */
  sheet.skipRows(1);
  sheet.section('Basis');

  scalar(
    sheet,
    'Total cost',
    {
      kind: 'formula',
      formula: (refs) => `${refs.name('PurchasePrice')}+${refs.name('AcquisitionCosts')}`,
      format: 'currency0',
    },
    'returns.totalCost',
  );

  scalar(
    sheet,
    'Going-in cap rate',
    {
      kind: 'formula',
      formula: (refs) =>
        `IF(${refs.ref('returns.totalCost')}=0,0,` +
        `SUM(${refs.range('cashFlow.netOperatingIncome', 0, Math.min(11, last))})/` +
        `${refs.ref('returns.totalCost')})`,
      format: 'percent2',
    },
    'returns.goingInCapRate',
  );

  /* ------------------------------------------------------------------ */
  sheet.skipRows(1);
  sheet.section('Cash flows to the investor');

  // The acquisition outflow, and then every period's cash flow. Laid out as a
  // pair of rows so XIRR has a dated series to work from.
  const dateRow = sheet.claimRow();
  const unleveredRow = sheet.claimRow();
  const leveredRow = sheet.claimRow();
  sheet.label(dateRow, LABEL_COL, 'Date', { indent: 1 });
  sheet.label(unleveredRow, LABEL_COL, 'Unlevered cash flow', { indent: 1 });
  sheet.label(leveredRow, LABEL_COL, 'Levered cash flow', { indent: 1 });

  // Column B is period zero: the acquisition.
  sheet.at(
    dateRow,
    TOTAL_COL,
    {
      kind: 'metadata',
      value: input.valuation.acquisitionDate ?? input.forecast.startDate,
      format: 'text',
    },
    'returns.date#0',
  );
  sheet.at(
    unleveredRow,
    TOTAL_COL,
    {
      kind: 'formula',
      formula: (refs) => `-${refs.ref('returns.totalCost')}`,
      format: 'currency0',
    },
    'returns.unleveredFlow#0',
  );
  sheet.at(
    leveredRow,
    TOTAL_COL,
    {
      kind: 'formula',
      // Equity in is the basis less whatever the debt funds at closing.
      formula: (refs) =>
        `-${refs.ref('returns.totalCost')}+${refs.ref('cashFlow.debtProceeds', 0)}`,
      format: 'currency0',
    },
    'returns.leveredFlow#0',
  );

  for (let period = 0; period < axis.count; period += 1) {
    const column = TOTAL_COL + 1 + period;
    sheet.at(
      dateRow,
      column,
      { kind: 'metadata', value: axis.periods[period]?.endDate ?? '', format: 'text' },
      `returns.date#${period + 1}`,
    );
    sheet.at(
      unleveredRow,
      column,
      {
        kind: 'formula',
        formula: (refs) => refs.ref('cashFlow.unleveredCashFlow', period),
        format: 'currency0',
      },
      `returns.unleveredFlow#${period + 1}`,
    );
    sheet.at(
      leveredRow,
      column,
      {
        kind: 'formula',
        // Period zero already carried the opening draw, so it is netted out
        // here to avoid counting the same proceeds twice.
        formula: (refs) =>
          period === 0
            ? `${refs.ref('cashFlow.leveredCashFlow', period)}-${refs.ref('cashFlow.debtProceeds', 0)}`
            : refs.ref('cashFlow.leveredCashFlow', period),
        format: 'currency0',
      },
      `returns.leveredFlow#${period + 1}`,
    );
  }

  /* ------------------------------------------------------------------ */
  sheet.skipRows(1);
  sheet.section('Returns');

  const flowRange =
    (key: string): ((refs: import('../model.js').RefResolver) => string) =>
    (refs) =>
      refs.range(key, 0, axis.count);
  const dateRange = (refs: import('../model.js').RefResolver): string =>
    refs.range('returns.date', 0, axis.count);

  scalar(
    sheet,
    'Unlevered XIRR',
    {
      kind: 'formula',
      formula: (refs) =>
        `IFERROR(XIRR(${flowRange('returns.unleveredFlow')(refs)},${dateRange(refs)}),"n/a")`,
      format: 'percent2',
      cachedValue: numberOrNull(result.returns.unleveredXirr),
    },
    'returns.unleveredXirr',
  );

  scalar(
    sheet,
    'Levered XIRR',
    {
      kind: 'formula',
      formula: (refs) =>
        `IFERROR(XIRR(${flowRange('returns.leveredFlow')(refs)},${dateRange(refs)}),"n/a")`,
      format: 'percent2',
      cachedValue: numberOrNull(result.returns.leveredXirr),
    },
    'returns.leveredXirr',
  );

  scalar(
    sheet,
    'Equity multiple',
    {
      kind: 'formula',
      formula: (refs) => {
        const range = flowRange('returns.leveredFlow')(refs);
        // Distributions over contributions, both taken from the same row.
        return `IFERROR(SUMIF(${range},">0")/-SUMIF(${range},"<0"),"n/a")`;
      },
      format: 'multiple',
      cachedValue: numberOrNull(result.returns.equityMultiple),
    },
    'returns.equityMultiple',
  );

  scalar(
    sheet,
    'Net present value (unlevered)',
    {
      kind: 'formula',
      formula: (refs) =>
        `IFERROR(XNPV(${refs.name('DiscountRate')},` +
        `${flowRange('returns.unleveredFlow')(refs)},${dateRange(refs)}),"n/a")`,
      format: 'currency0',
    },
    'returns.npv',
  );

  scalar(
    sheet,
    'Profit',
    {
      kind: 'formula',
      formula: (refs) => `SUM(${flowRange('returns.leveredFlow')(refs)})`,
      format: 'currency0',
    },
    'returns.profit',
  );
}

function scalar(
  sheet: ReturnType<WorkbookModel['sheet']>,
  label: string,
  spec: import('../model.js').CellSpec,
  key: string,
): void {
  const row = sheet.claimRow();
  sheet.label(row, LABEL_COL, label, { indent: 1 });
  sheet.at(row, TOTAL_COL, spec, key);
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
