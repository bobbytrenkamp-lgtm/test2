import type {
  AnnualSummaryRow,
  CashFlowLine,
  CashFlowSeries,
  LeaseCashFlowRow,
  MarketLeasingProfile,
  ModelInput,
  ModelResult,
  OccupancyReconciliation,
  ReturnMetrics,
  ValuationResult,
} from '@cre/domain-models';
import { CASH_FLOW_LINES } from '@cre/domain-models';
import { Decimal, ONE, TWELVE, ZERO, d, zeros } from './decimal.js';
import { buildCalendar, monthDifference } from './calendar.js';
import { CurveSet } from './curves.js';
import {
  type NormalizedSpace,
  type OccurrenceSeries,
  type RolloverContext,
  buildOccurrences,
  buildSpeculativeOccurrences,
  computeOccurrenceSeries,
  marketRentAt,
  normalizeSpaces,
  resolveProfile,
} from './leases.js';
import { monthlyRentFromBasis } from './rent-schedule.js';
import { computeExpenseSeries, totalExpenses } from './expenses.js';
import { computeRecoveries } from './recoveries.js';
import { computeOtherPropertyRevenue, computePercentageRent } from './revenue.js';
import { computeCapital } from './capital.js';
import { applyCashTrap, computeDebt } from './debt.js';
import { computeDcf, computeDirectCapitalization, computeSale } from './valuation.js';
import {
  breakevenOccupancy,
  equityMultiple,
  irrMonthly,
  npvMonthly,
  safeDivide,
  slice,
  toStringOrNull,
  xirr,
} from './metrics.js';
import { computeSponsorFees, computeWaterfall } from './waterfall.js';
import { TraceRecorder, type TraceOptions } from './trace.js';

/**
 * Calculation engine version.
 *
 * Bump the minor version for additive behaviour and the major version whenever
 * an existing model's numbers would change. Stored results record the version
 * that produced them so a saved valuation can always be explained.
 *
 * ## 7.0.0
 *
 * Four further correctness fixes, found by a fourth audit pass targeted at
 * lease-option branching and recovery-pool boundary cases. As with the three
 * prior audit rounds, every one silently produced a wrong figure rather than
 * an error, which is what makes this major.
 *
 * **A renewal option no longer drops the exercised branch's weight when the
 * current term already runs through (or past) the forecast horizon.**
 * `branchOnOption` returned before pushing the exercised-weight branch
 * whenever the extension's own start date fell after the forecast end — an
 * ordinary configuration, not a rare one: any lease whose term happens to
 * span the whole hold period hits it. The already-elapsed, fully visible
 * term was understated by however much weight the exercised branch carried,
 * and at 100% renewal probability the lease vanished from the model
 * entirely, since the lapsed branch carries zero weight in that case too.
 * The exercised branch now keeps the tail's own (unextended) occurrences at
 * full weight — the extension itself is skipped, not the lease.
 *
 * **A termination option's exercise cost now reaches the cash flow.** The
 * `cost` on a termination option (a landlord buyout payment, or a
 * tenant-paid fee entered as negative) was recorded in the trace but never
 * applied to `tenantImprovements` — every termination fee configured on any
 * model was silently worth $0 in the reported output. It now lands on the
 * exercise date as its own zero-footprint cost entry, without disturbing
 * whatever the lease's own tenant-improvement cost already carried.
 *
 * **A base-year (or expense-stop) recovery pool's cap or floor no longer
 * pins the recovery at zero forever once the first billed year settles at
 * exactly zero.** A base-year pool's own first billed year settles at zero
 * by definition — the entitlement is the excess over the base year, and the
 * base year has no excess over itself — and zero is not `null`, so the cap
 * check ran anyway. A multiplicative ceiling anchored at a zero baseline
 * (`0 x (1 + capPercent) = 0`) capped every later year at zero regardless of
 * how much expenses actually grew, permanently eliminating the recovery line
 * instead of limiting its growth. Capping is now skipped for as long as the
 * applicable baseline is zero; the cumulative baseline re-anchors to the
 * first year that actually settles a nonzero amount, and compounds from
 * there.
 *
 * **Two recovery pools on the same lease that both claim the same expense
 * category now warn.** A pool with an empty `includedCategories` falls back
 * to "every category flagged recoverable," which is easy to collide with a
 * second, more specific pool naming one of those same categories — an easy
 * misconfiguration, and one that silently doubled the tenant's bill for the
 * overlapping category with no diagnostic saying why.
 *
 * None of the ~280 regression fixtures at the time exercised a lease-option
 * fixture at all (`lease-options.ts` had no dedicated test file before this
 * round), a base-year recovery pool combined with a cap, or two explicit
 * recovery pools with overlapping categories — which is why all four
 * survived three prior audit passes.
 *
 * ## 6.0.0
 *
 * Three further correctness fixes, found by a third audit pass targeted at
 * boundary and extreme-value cases the first two passes did not reach. As
 * with 4.0.0 and 5.0.0, every one silently produced a wrong figure rather
 * than an error, which is what makes this major.
 *
 * **A negative exit or direct capitalisation rate now reports a diagnostic
 * (`NEGATIVE_EXIT_CAP_RATE`, `NEGATIVE_DIRECT_CAP_RATE`) instead of silently
 * producing a negative valuation.** Both `computeSale` and
 * `computeDirectCapitalization` guarded only a rate of exactly zero; neither
 * guarded a negative one, and the schema places no floor under
 * `terminalCapRate`/`directCapRate`. A fat-fingered "-0.06" in place of
 * "0.06" divided the terminal or selected NOI by a negative number and
 * produced a large, plausible-looking negative value that flowed straight
 * into the DCF valuation, cash flows and IRR — not an obviously broken
 * number, and no diagnostic anywhere in the chain said why.
 *
 * **The waterfall's residual-unallocated fallback no longer drops cash when
 * contribution shares sum to zero.** 5.0.0 fixed the capital-call side of
 * this (`contribute()`) but not the distribution side: the "nothing left to
 * allocate the residual to" branch, reached whenever a period's cash flow
 * has no tier left to absorb it, still multiplied by each partner's raw,
 * zero `contributionShare` instead of the same even-split fallback
 * `contribute()` already uses. The branch's own comment claimed "cash is
 * never lost" and its diagnostic claimed the cash "was allocated on
 * contribution shares" — both false whenever every partner's stated share
 * is zero and the waterfall has no `residual_split` tier.
 *
 * **Portfolio `weightedExitCapRate` no longer weights a member's rate
 * against a value basis that excludes that member.** The rate's numerator
 * was accumulated whenever a member's `exitCapRate` was set — which is
 * copied from the input assumption unconditionally, independent of whether
 * `computeSale` actually priced a sale — while the denominator was only
 * accumulated when a `dcf` valuation existed. A member whose `saleMonth`
 * falls outside its own forecast (an ordinary data-entry mistake, not a
 * contrived state) still had its configured exit cap rate pulled into the
 * numerator with no matching value in the denominator, silently skewing the
 * portfolio's reported rate toward that member's, with no diagnostic.
 *
 * None of the ~270 regression fixtures at the time exercised a negative
 * capitalisation rate, a zero-share waterfall with no residual-split tier,
 * or a portfolio member whose sale month falls outside its own forecast —
 * which is why all three survived the first two audit passes.
 *
 * ## 5.0.0
 *
 * Four further correctness fixes, found by the same audit's second pass over
 * boundary and extreme-value cases. As with 4.0.0, every one silently produced
 * a wrong figure rather than an error, which is what makes this major.
 *
 * **A cash trap no longer treats a facility's own funding-period draw as
 * trappable surplus.** `applyCashTrap` swept `Decimal.max(leveredCashFlow[i],
 * ZERO)` for a breached covenant, and `leveredCashFlow` includes debt
 * proceeds. A covenant that breaches in the funding month — an annualised
 * one-month NOI stub tripping a DSCR threshold a full year would clear is an
 * ordinary way for that to happen — could sweep the entire loan proceeds
 * meant to fund the acquisition, over-calling equity by that amount. Proceeds
 * are now excluded from what counts as surplus.
 *
 * **A cash trap open when the facility is repaid now releases its held cash
 * at the sale date, not at the literal last index of the stated forecast.**
 * Combined with 4.0.0's sale truncation of equity cash flow, a trap still
 * open at sale lost the held cash outright whenever the forecast ran past the
 * sale month, which `terminalNoiBasis: 'forward_12'` deliberately does.
 * `applyCashTrap` now takes `saleIndex` and stops trapping, releasing what it
 * holds, there. Affects any model with an uncured cash trap on a facility
 * that is repaid before the forecast's last period.
 *
 * **Partner contribution shares that sum to zero no longer lose the capital
 * call.** Every partner entered at a 0% contribution share — plausible while
 * a deal's ownership is still being drafted, not a malformed state — made
 * `computeWaterfall`'s normalising sum zero; dividing by it silently zeroed
 * every partner's allocation. Shares that sum to zero are now split evenly
 * across partners instead, with a `PARTNER_SHARES_SUM_TO_ZERO` error naming
 * the cause.
 *
 * **A direct capitalisation rate of exactly zero now reports
 * `ZERO_DIRECT_CAP_RATE`** instead of silently producing no valuation, the
 * same way `computeSale` already names `ZERO_EXIT_CAP_RATE` for the exit cap
 * rate. Behaviour is unchanged when `directCapRate` is simply not
 * configured — only the explicit zero, which has no finite value to divide
 * by, now says why the method is absent.
 *
 * None of the ~260 regression fixtures at the time exercised a cash trap
 * still open at a facility's own funding month, a cash trap still open past
 * the sale date, contribution shares summing to zero, or an explicit zero
 * direct-cap rate — which is why all three survived 4.0.0's audit.
 *
 * ## 4.0.0
 *
 * Six correctness fixes, all found by the same repository-wide audit and all
 * changing existing numbers on the models they affect — every one of them
 * silently produced a wrong figure rather than an error, which is what makes
 * this a major version rather than six patches.
 *
 * **Equity distributions no longer continue after the sale date.**
 * `computeReturns` already truncated `leveredIrr`/`equityMultiple` at the
 * sale month; the equity cash flow fed to `computeWaterfall`, and
 * `cashOnCashByYear`, did not. A forecast stated past its sale month —
 * ordinary, not contrived: `terminalNoiBasis: 'forward_12'` needs NOI *after*
 * the sale to value the exit — showed partners receiving distributions for
 * months after the property was sold. Affects every waterfall on a model
 * whose forecast runs past its sale month.
 *
 * **A debt facility funded before the forecast start is now refused with a
 * diagnostic (`DEBT_FUNDED_BEFORE_FORECAST`) instead of silently running at a
 * zero balance.** Modelling an existing loan's balance as of the forecast
 * start needs its amortisation run from the real funding date, which this
 * engine does not do; refusing is correct until that is built. Affects any
 * model with a facility whose funding date predates the forecast.
 *
 * **Direct capitalisation's `trailing_12` and `stabilized` bases are now
 * annualised on a forecast shorter than 12 months**, the same way `year_1`
 * already was. Affects direct-cap value on any forecast under a year long.
 *
 * **`goingInCapRate`, `yieldOnCost` and `debtYieldYear1` are now annualised**
 * on a forecast shorter than 12 months, for the same reason. Understated by
 * up to 2x on a 6-month forecast.
 *
 * **`stabilizedCapRate` now reports `null`, not a false `"0"`, when its
 * 13-24 month window does not exist** — the figure the rest of this engine's
 * documented "never a silent zero" principle already promised.
 *
 * **Portfolio `year1NetOperatingIncome` and `weightedGoingInCapRate` now
 * annualise a member's partial first fiscal-year bucket** — a forecast that
 * does not start on its own fiscal year's first month (a mid-year
 * acquisition into a calendar-fiscal-year fund) is the ordinary case this
 * missed, not an edge one.
 *
 * None of the ~250 regression fixtures exercised a forecast shorter than 12
 * months, a debt facility funded before the forecast start, a sale month
 * earlier than the forecast's last month, or a portfolio member starting
 * mid fiscal year — which is why all six survived as long as they did.
 *
 * ## 3.3.1
 *
 * A recovery settlement's trace entry is dated to the first month of the fiscal
 * year it settles. It previously carried no period at all — the settlement is
 * annual — which made it unreachable from anything asking the trace how a given
 * month's figure was derived. No calculated value changes; a trace entry is a
 * record of work, and this records which year's work it is.
 *
 * ## 3.3.0
 *
 * Per-partner cash flows, and the partner return on both bases.
 *
 * `WaterfallDistribution` described a partner only by totals: what they put in,
 * what they took out, and a rate of return. That is not enough to audit a
 * partnership. An investor statement has to say *when* capital was called and
 * when it came back, and anything discounting or re-rating a partner's position
 * needs the dated series rather than a pair of sums. The engine already tracked
 * the series to solve each partner's IRR; it simply never reported it. It is
 * now surfaced as `initialFlow` and `flows`.
 *
 * The same partners also carried an IRR solved on uniform monthly periods while
 * the property beside them reported both that and a day-count `leveredXirr`.
 * Comparing a partner's return to the deal's therefore crossed conventions
 * unless the reader knew to pick `leveredIrr`. Partners now report `xirr` too,
 * on the same actual/365 basis, dated from the first period's start exactly as
 * the property's is.
 *
 * Additive throughout: no existing figure changes, and every previously
 * reported field keeps its value. Minor rather than patch because a stored
 * result's engine version is what tells a consumer which fields to expect.
 *
 * ## 3.2.0
 *
 * Development and refinance fee bases. Both fee types have been in the schema
 * since the equity structure was written and neither had a basis, so a model
 * configuring one produced an informational diagnostic and charged nothing —
 * silently understating what the sponsor takes.
 *
 * A development fee is charged on capital expenditure **as it is incurred**.
 * Incurred rather than budgeted: a fee on a budget is earned by writing the
 * budget. Tenant improvements and leasing commissions are excluded, because a
 * leasing commission already compensates that work.
 *
 * A refinance fee is charged on debt proceeds drawn **after the first funding
 * period**. The initial funding is the acquisition loan and the acquisition fee
 * already covers putting the deal together; charging both would pay twice for
 * one financing and inflate the sponsor's take on every model that never
 * refinanced.
 *
 * The fallback branch now assigns `fee.type` to `never`, so adding a type to
 * the schema is a compile error here rather than a fee that quietly is not
 * charged — which is exactly how these two sat unbilled.
 *
 * Additive: a model with no development or refinance fee is unchanged, and
 * every pre-existing regression assertion passes unaltered.
 *
 * ## 3.1.0
 *
 * Cash-management triggers on covenant breach. A breach the engine only
 * reported was a breach with no consequence: the model showed the covenant
 * failing and distributed the cash anyway, overstating the levered return in
 * precisely the years a lender is most worried about.
 *
 * Where a facility carries `cashTrap`, the surplus is withheld from equity
 * while the breach persists and released when the covenant has been met for the
 * required consecutive periods. The property's own performance is untouched —
 * NOI and unlevered cash flow are identical either way — which is what makes
 * this a financing outcome rather than an operating one. A new
 * `restrictedCash` line makes the movement visible, and it nets to zero over
 * any span that both traps and releases.
 *
 * **Cash sweep is deliberately not modelled.** Applying trapped cash to
 * principal makes the amortisation schedule depend on the cash flow that
 * depends on the schedule, and approximating that fixed point would misstate
 * the balance — which then misstates every covenant tested against it.
 *
 * Additive: the trigger defaults to off and every regression assertion passes
 * unaltered, so `restrictedCash` is zero on every model written before it
 * existed.
 *
 * ## 3.0.0
 *
 * **A correction to existing numbers, which is what makes this major.** A lease
 * covering only part of a space under-recovered its expenses by exactly its
 * share of that space. 2.0.0 scaled a lease's occupancy series by its share of
 * the area it sits on — right for reporting how full a floor is, wrong as the
 * multiplier for spreading an annual entitlement across months, because an
 * entitlement already carries the tenant's area through its pro-rata share.
 * Applying it twice billed a tenant holding 40% of a floor 40% of what it owed.
 * The same error reached annual other-revenue items.
 *
 * There are now two series: `occupancyFraction`, area-weighted, for occupancy
 * reporting, and `timeFraction`, for spreading annual figures over the months a
 * tenant was present. No pre-existing fixture moved — every one of them let
 * whole spaces, which is why this survived two versions — so fixture 18 exists
 * to cover the case, and it reproduces the old figure when the fix is reverted.
 *
 * Any model where a lease covers part of a space and recovers expenses will
 * show higher recoveries, and higher NOI and value with them.
 *
 * Additive in the same release: recoveries gained two things a real lease does
 * and a single settled figure could not express.
 *
 * **Several pools per lease.** Operating costs on a base year with a cap, taxes
 * and insurance net and uncapped, is one lease and three settlements. Each pool
 * now keeps its own base year, cap history and reconciliation, and the results
 * are summed. A lease with no explicit pools is one implicit pool on the terms
 * it already had.
 *
 * **Reconciliation.** A tenant pays an estimate monthly and the difference is
 * billed or credited after the year closes. That moves cash between years,
 * which moves the return. The default estimate basis is the settled amount
 * itself, which leaves nothing to reconcile.
 *
 * Both default to the previous behaviour, and all 164 pre-existing regression
 * assertions pass unaltered, including the ones comparing exact strings — so
 * these two would have been a minor bump on their own.
 *
 * ## 2.1.0
 *
 * Performance only. The discount-factor series and XIRR each took decimal.js's
 * most expensive operation — a fractional power — once per period, on each of
 * 200 bisection steps. Both now take it once and derive the rest by
 * multiplication, which made a single-tenant ten-year model eighteen times
 * faster. See `metrics.ts`.
 *
 * Nothing the platform reports changed: money is identical to the cent and all
 * regression fixtures, which assert exact strings, pass unaltered. The version
 * moves because the change is not bit-identical at full precision — repeated
 * multiplication differs from a direct power in the last digit or two of 34,
 * and that reaches fields the result serialises untruncated. A valuation stored
 * by 2.0.0 will therefore not compare byte-for-byte against a 2.1.0
 * recalculation, which `pnpm drill:restore` reports rather than hides.
 *
 * ## 2.0.0
 *
 * Lease options now affect the cash flow: renewal, termination and contraction
 * are expanded into probability-weighted branches the way rollover already was.
 * On its own that is additive — a model with no options is unchanged.
 *
 * What makes it major is the occupancy correction it required. Physical
 * occupancy of a space was derived from how much of the *period* an occurrence
 * covered, ignoring how much of the space's *area* it held. A lease taking
 * 6,000 of a 10,000 sqft suite reported the suite fully occupied. Occupancy is
 * now scaled by the occurrence's share of the area it sits on.
 *
 * Every model where a lease covers only part of a space will therefore show
 * different physical occupancy, and different general vacancy and credit loss
 * with it, because those are applied to occupancy. None of the twelve
 * pre-existing regression fixtures moved — they all let whole spaces — but real
 * rent rolls do not, so this is a major bump rather than a minor one.
 */
export const ENGINE_VERSION = '7.0.0';

/** Maximum passes of the revenue/expense fixed-point solver. */
const SOLVER_MAX_PASSES = 12;
/** Convergence threshold, in currency units, for the solver. */
const SOLVER_TOLERANCE = new Decimal('0.005');

export interface CalculateOptions {
  trace?: Partial<TraceOptions>;
  /** Wall-clock stamp recorded on the result. Injected for reproducible tests. */
  calculatedAt?: string;
}

export function calculate(input: ModelInput, options: CalculateOptions = {}): ModelResult {
  const traceOptions: TraceOptions = {
    enabled: options.trace?.enabled ?? false,
    targetPrefixes: options.trace?.targetPrefixes,
    maxEntries: options.trace?.maxEntries ?? 200_000,
  };
  const trace = new TraceRecorder(traceOptions);
  const recordTrace = trace.enabled;

  const calendar = buildCalendar(input.forecast);
  const n = calendar.periods.length;
  const forecastStart = calendar.periods[0]?.start;
  const forecastEnd = calendar.periods[n - 1]?.end;
  if (!forecastStart || !forecastEnd) {
    throw new Error('A forecast must contain at least one period.');
  }

  const curves = new CurveSet(input.growthCurves, calendar);
  const profiles = new Map<string, MarketLeasingProfile>(
    input.marketLeasingProfiles.map((profile) => [profile.id, profile]),
  );

  /* --------------------------------------------------------------------- */
  /* Physical structure and lease occurrences                              */
  /* --------------------------------------------------------------------- */

  const spaces = normalizeSpaces(input.spaces, input.leases, trace);
  const spaceMap = new Map<string, NormalizedSpace>(spaces.map((space) => [space.id, space]));

  const rolloverCtx: RolloverContext = {
    calendar,
    curves,
    profiles,
    defaultProfileId: input.defaultMarketLeasingProfileId ?? null,
    spaces: spaceMap,
    trace,
    forecastStart,
    forecastEnd,
  };

  const occurrences = buildOccurrences(input.leases, rolloverCtx);
  let occurrenceSeries: OccurrenceSeries[] = occurrences.map((occurrence) =>
    computeOccurrenceSeries(occurrence, rolloverCtx, recordTrace),
  );

  detectOverlaps(occurrenceSeries, spaceMap, trace);

  // Space that no lease ever touches is absorbed speculatively on the market
  // leasing assumptions, then rolls over like any other lease.
  const contractOccupancy = accumulateSpaceOccupancy(occurrenceSeries, spaces, n);
  const speculative = buildSpeculativeOccurrences(spaces, contractOccupancy, rolloverCtx);
  if (speculative.length > 0) {
    occurrenceSeries = [
      ...occurrenceSeries,
      ...speculative.map((occurrence) =>
        computeOccurrenceSeries(occurrence, rolloverCtx, recordTrace),
      ),
    ];
  }

  const revenueSpaces = spaces.filter((space) => !space.isNonRevenue);
  const totalRentableArea = revenueSpaces.reduce((acc, space) => acc.plus(space.area), ZERO);
  const declaredArea = input.property.rentableArea ? d(input.property.rentableArea) : null;
  if (declaredArea && !declaredArea.isZero()) {
    const difference = declaredArea.minus(totalRentableArea).abs();
    if (difference.greaterThan(declaredArea.times('0.01'))) {
      trace.warn(
        'AREA_MISMATCH',
        `The property records ${declaredArea.toFixed(0)} ${input.areaUnit} of rentable area, but the space list totals ${totalRentableArea.toFixed(0)}. The space list is used for occupancy and recovery denominators.`,
        `property:${input.property.id}`,
        'rentableArea',
      );
    }
  }
  const unitCount =
    input.property.unitCount > 0
      ? input.property.unitCount
      : revenueSpaces.reduce((acc, space) => acc + space.unitCount, 0);

  /* --------------------------------------------------------------------- */
  /* Occupancy and potential base rent                                     */
  /* --------------------------------------------------------------------- */

  const spaceOccupancy = accumulateSpaceOccupancy(occurrenceSeries, spaces, n);

  const occupiedArea = zeros(n);
  const vacantArea = zeros(n);
  const marketRentOnVacant = zeros(n);

  for (const space of revenueSpaces) {
    const occupancy = spaceOccupancy.get(space.id) ?? zeros(n);
    const profile = resolveProfile(
      rolloverCtx,
      space.marketLeasingProfileId,
      [space.id],
      `space:${space.id}`,
    );
    for (let i = 0; i < n; i += 1) {
      const period = calendar.periods[i];
      if (!period) continue;
      const occupied = (occupancy[i] as Decimal).clamp(0, 1);
      const vacantFraction = ONE.minus(occupied);
      occupiedArea[i] = (occupiedArea[i] as Decimal).plus(space.area.times(occupied));
      vacantArea[i] = (vacantArea[i] as Decimal).plus(space.area.times(vacantFraction));
      if (profile && vacantFraction.greaterThan(0)) {
        const market = marketRentAt(profile, period.start, rolloverCtx);
        const monthly = monthlyRentFromBasis(
          market.amount,
          market.basis,
          space.area.times(vacantFraction),
          Math.round(space.unitCount * vacantFraction.toNumber()),
        );
        marketRentOnVacant[i] = (marketRentOnVacant[i] as Decimal).plus(monthly);
      }
    }
  }

  const physicalOccupancy = occupiedArea.map((area) =>
    totalRentableArea.isZero() ? ONE : area.dividedBy(totalRentableArea),
  );

  const contractualBaseRent = zeros(n);
  const freeRentSeries = zeros(n);
  const otherLeaseRevenue = zeros(n);
  const tenantImprovements = zeros(n);
  const leasingCommissions = zeros(n);
  for (const series of occurrenceSeries) {
    for (let i = 0; i < n; i += 1) {
      contractualBaseRent[i] = (contractualBaseRent[i] as Decimal).plus(series.baseRent[i] ?? ZERO);
      freeRentSeries[i] = (freeRentSeries[i] as Decimal).plus(series.freeRent[i] ?? ZERO);
      otherLeaseRevenue[i] = (otherLeaseRevenue[i] as Decimal).plus(series.otherRevenue[i] ?? ZERO);
      tenantImprovements[i] = (tenantImprovements[i] as Decimal).plus(
        series.tenantImprovements[i] ?? ZERO,
      );
      leasingCommissions[i] = (leasingCommissions[i] as Decimal).plus(
        series.leasingCommissions[i] ?? ZERO,
      );
    }
  }

  const potentialBaseRent = contractualBaseRent.map((rent, i) =>
    rent.plus(marketRentOnVacant[i] as Decimal),
  );
  const absorptionAndTurnoverVacancy = marketRentOnVacant.map((v) => v.negated());
  const scheduledBaseRent = contractualBaseRent.map((rent, i) =>
    rent.minus(freeRentSeries[i] as Decimal),
  );

  const percentageRent = computePercentageRent(
    occurrenceSeries,
    calendar,
    curves,
    trace,
    recordTrace,
  );

  /* --------------------------------------------------------------------- */
  /* Fixed-point solve for revenue-linked expenses and recoveries          */
  /* --------------------------------------------------------------------- */

  let effectiveGrossRevenue = zeros(n);
  let expenseSeries = computeExpenseSeries(
    input.expenses,
    {
      calendar,
      curves,
      trace,
      rentableArea: totalRentableArea,
      unitCount,
      occupancy: physicalOccupancy,
      effectiveGrossRevenue,
      baseRent: scheduledBaseRent,
    },
    false,
  );
  let recoveries = computeRecoveries(
    occurrenceSeries,
    {
      calendar,
      expenses: expenseSeries,
      denominatorArea: totalRentableArea,
      occupancy: physicalOccupancy,
      trace,
    },
    false,
  );
  let otherPropertyRevenue = computeOtherPropertyRevenue(
    input.otherRevenue,
    {
      calendar,
      curves,
      rentableArea: totalRentableArea,
      unitCount,
      occupancy: physicalOccupancy,
      baseRent: scheduledBaseRent,
      trace,
    },
    false,
  );

  let grossPotentialRevenue = zeros(n);
  let generalVacancy = zeros(n);
  let creditLoss = zeros(n);
  let converged = false;

  for (let pass = 0; pass < SOLVER_MAX_PASSES; pass += 1) {
    grossPotentialRevenue = scheduledBaseRent.map((rent, i) =>
      rent
        .plus(percentageRent.total[i] as Decimal)
        .plus(recoveries.total[i] as Decimal)
        .plus(otherLeaseRevenue[i] as Decimal)
        .plus(otherPropertyRevenue.total[i] as Decimal),
    );

    const allowances = computeVacancyAllowances(
      input,
      grossPotentialRevenue,
      scheduledBaseRent,
      recoveries.total,
      percentageRent.total,
      otherLeaseRevenue.map((v, i) => v.plus(otherPropertyRevenue.total[i] as Decimal)),
      absorptionAndTurnoverVacancy,
    );
    generalVacancy = allowances.generalVacancy;
    creditLoss = allowances.creditLoss;

    const nextEgr = grossPotentialRevenue.map((gpr, i) =>
      gpr.minus(generalVacancy[i] as Decimal).minus(creditLoss[i] as Decimal),
    );

    const delta = nextEgr.reduce(
      (acc, value, i) => Decimal.max(acc, value.minus(effectiveGrossRevenue[i] as Decimal).abs()),
      ZERO,
    );
    effectiveGrossRevenue = nextEgr;

    const isFinalPass = delta.lessThan(SOLVER_TOLERANCE);
    expenseSeries = computeExpenseSeries(
      input.expenses,
      {
        calendar,
        curves,
        trace,
        rentableArea: totalRentableArea,
        unitCount,
        occupancy: physicalOccupancy,
        effectiveGrossRevenue,
        baseRent: scheduledBaseRent,
      },
      recordTrace && isFinalPass,
    );
    recoveries = computeRecoveries(
      occurrenceSeries,
      {
        calendar,
        expenses: expenseSeries,
        denominatorArea: totalRentableArea,
        occupancy: physicalOccupancy,
        trace,
      },
      recordTrace && isFinalPass,
    );
    otherPropertyRevenue = computeOtherPropertyRevenue(
      input.otherRevenue,
      {
        calendar,
        curves,
        rentableArea: totalRentableArea,
        unitCount,
        occupancy: physicalOccupancy,
        baseRent: scheduledBaseRent,
        trace,
      },
      recordTrace && isFinalPass,
    );

    if (isFinalPass) {
      converged = true;
      break;
    }
  }

  if (!converged) {
    trace.warn(
      'SOLVER_DID_NOT_CONVERGE',
      `Revenue-linked expenses did not settle within ${SOLVER_MAX_PASSES} passes. Check for an expense defined as a percentage of revenue that is also fully recoverable at a high rate.`,
      'model',
      'expenses',
    );
  }

  // Recompute the revenue lines once more against the final expense pass so the
  // reported figures match the expenses that were actually charged.
  grossPotentialRevenue = scheduledBaseRent.map((rent, i) =>
    rent
      .plus(percentageRent.total[i] as Decimal)
      .plus(recoveries.total[i] as Decimal)
      .plus(otherLeaseRevenue[i] as Decimal)
      .plus(otherPropertyRevenue.total[i] as Decimal),
  );
  const finalAllowances = computeVacancyAllowances(
    input,
    grossPotentialRevenue,
    scheduledBaseRent,
    recoveries.total,
    percentageRent.total,
    otherLeaseRevenue.map((v, i) => v.plus(otherPropertyRevenue.total[i] as Decimal)),
    absorptionAndTurnoverVacancy,
  );
  generalVacancy = finalAllowances.generalVacancy;
  creditLoss = finalAllowances.creditLoss;
  effectiveGrossRevenue = grossPotentialRevenue.map((gpr, i) =>
    gpr.minus(generalVacancy[i] as Decimal).minus(creditLoss[i] as Decimal),
  );

  const operatingExpenses = totalExpenses(expenseSeries, n, false);
  const netOperatingIncome = effectiveGrossRevenue.map((egr, i) =>
    egr.minus(operatingExpenses[i] as Decimal),
  );

  /* --------------------------------------------------------------------- */
  /* Capital and unlevered cash flow                                       */
  /* --------------------------------------------------------------------- */

  const capital = computeCapital(
    input.capital,
    {
      calendar,
      curves,
      rentableArea: totalRentableArea,
      unitCount,
      trace,
    },
    recordTrace,
  );
  const capitalizedExpenses = totalExpenses(expenseSeries, n, true);
  const capitalExpenditures = capital.total.map((value, i) =>
    value.plus(capitalizedExpenses[i] as Decimal),
  );

  const unleveredCashFlow = netOperatingIncome.map((noi, i) =>
    noi
      .minus(tenantImprovements[i] as Decimal)
      .minus(leasingCommissions[i] as Decimal)
      .minus(capitalExpenditures[i] as Decimal),
  );

  /* --------------------------------------------------------------------- */
  /* Valuation                                                             */
  /* --------------------------------------------------------------------- */

  const valuationCtx = {
    calendar,
    assumptions: input.valuation,
    noi: netOperatingIncome,
    unleveredCashFlow,
    rentableArea: totalRentableArea,
    unitCount,
    trace,
  };
  const sale = computeSale(valuationCtx);
  const dcf = computeDcf(valuationCtx, sale);
  const directCap = computeDirectCapitalization(valuationCtx);
  const valuations: ValuationResult[] = [dcf, directCap].filter(
    (value): value is ValuationResult => value !== null,
  );

  const concludedValue = dcf ? d(dcf.value) : directCap ? d(directCap.value) : ZERO;
  const acquisitionBasis = input.valuation.acquisitionPrice
    ? d(input.valuation.acquisitionPrice)
    : concludedValue;
  const acquisitionCosts = d(input.valuation.acquisitionCosts);
  const totalCost = acquisitionBasis
    .plus(acquisitionCosts)
    .plus(capital.total.reduce((acc, v) => acc.plus(v), ZERO));

  /* --------------------------------------------------------------------- */
  /* Debt                                                                  */
  /* --------------------------------------------------------------------- */

  const debt = computeDebt(
    input.debt,
    {
      calendar,
      curves,
      trace,
      noi: netOperatingIncome,
      propertyValue: concludedValue,
      totalCost,
      saleIndex: sale?.saleIndex ?? null,
    },
    recordTrace,
  );

  const grossSaleProceeds = zeros(n);
  const sellingCosts = zeros(n);
  const netDispositionProceeds = zeros(n);
  if (sale) {
    grossSaleProceeds[sale.saleIndex] = sale.grossSalePrice;
    sellingCosts[sale.saleIndex] = sale.sellingCosts;
    netDispositionProceeds[sale.saleIndex] = sale.netSaleProceeds.minus(
      debt.payoff[sale.saleIndex] as Decimal,
    );
  }

  const leveredBeforeTrap = unleveredCashFlow.map((ucf, i) =>
    ucf
      .plus(debt.proceeds[i] as Decimal)
      .minus(debt.interest[i] as Decimal)
      .minus(debt.principal[i] as Decimal)
      .minus(debt.fees[i] as Decimal)
      .plus(sale && i === sale.saleIndex ? sale.netSaleProceeds : ZERO)
      .minus(debt.payoff[i] as Decimal),
  );

  /*
   * A covenant breach the engine only reports is a breach with no consequence.
   * Where a facility carries a cash-management trigger, the surplus is withheld
   * from equity while the breach persists — the property performs exactly as
   * before and the equity holder receives nothing, which moves the levered
   * return without moving a single operating figure.
   *
   * Zero on every model that has no trigger configured, which is every model
   * written before one existed.
   */
  const cashTrap = applyCashTrap(
    input.debt,
    debt.schedules,
    leveredBeforeTrap,
    debt.proceeds,
    sale?.saleIndex ?? null,
  );
  for (const event of cashTrap.events) {
    trace.warn(
      event.event === 'trapped' ? 'CASH_TRAP_SPRUNG' : 'CASH_TRAP_RELEASED',
      event.event === 'trapped'
        ? `Cash management triggered in period ${event.periodIndex}: ${event.reason}. Surplus cash is withheld from equity until the covenant is cured.`
        : `Cash management released in period ${event.periodIndex}: ${event.reason}. ${event.amount} returns to equity.`,
      'debt',
      'cashTrap',
    );
  }
  const leveredCashFlow = leveredBeforeTrap.map((cf, i) =>
    cf.minus(cashTrap.movement[i] as Decimal),
  );

  /* --------------------------------------------------------------------- */
  /* Equity, fees and waterfall                                            */
  /* --------------------------------------------------------------------- */

  const sponsorFees = computeSponsorFees({
    calendar,
    structure: input.equity,
    effectiveGrossRevenue,
    acquisitionBasis,
    grossSalePrice: sale?.grossSalePrice ?? ZERO,
    saleIndex: sale?.saleIndex ?? null,
    capitalExpenditure: capitalExpenditures,
    debtProceeds: debt.proceeds,
    trace,
  });

  // The loan funds at closing, so any proceeds landing in the first forecast
  // month reduce the equity written at time zero instead of appearing as a
  // distribution to partners in month one.
  const closingDebt = debt.proceeds[0] ?? ZERO;
  const initialEquity = Decimal.max(
    acquisitionBasis.plus(acquisitionCosts).plus(sponsorFees.atClose).minus(closingDebt),
    ZERO,
  );
  // `leveredCashFlow` stays full-length past the sale date because
  // `unleveredCashFlow` legitimately needs to (the forward_12 terminal-value
  // basis reads NOI *after* the sale date — see docs/calculation-
  // specification.md). But once the property is sold, equity has exited: it
  // receives nothing more, however positive the property's hypothetical
  // future cash flow reads. Zeroing here, rather than only at the point
  // `computeReturns` derives IRR/multiple, is what stops those same phantom
  // periods from also reaching the waterfall — a partner cannot be paid a
  // distribution for a deal they are no longer in.
  const saleIndex = sale?.saleIndex ?? null;
  const equityCashFlow = leveredCashFlow.map((cf, i) =>
    saleIndex !== null && i > saleIndex
      ? ZERO
      : i === 0
        ? cf.minus(closingDebt).minus(sponsorFees.total[i] as Decimal)
        : cf.minus(sponsorFees.total[i] as Decimal),
  );

  const waterfall = computeWaterfall({
    calendar,
    structure: input.equity,
    equityCashFlow,
    initialEquity,
    trace,
  });

  /* --------------------------------------------------------------------- */
  /* Assemble output                                                       */
  /* --------------------------------------------------------------------- */

  const monthlyDecimals: Record<CashFlowLine, Decimal[]> = {
    potentialBaseRent,
    absorptionAndTurnoverVacancy,
    contractualBaseRent,
    freeRent: freeRentSeries.map((v) => v.negated()),
    scheduledBaseRent,
    percentageRent: percentageRent.total,
    expenseRecoveries: recoveries.total,
    otherLeaseRevenue,
    otherPropertyRevenue: otherPropertyRevenue.total,
    grossPotentialRevenue,
    generalVacancy: generalVacancy.map((v) => v.negated()),
    creditLoss: creditLoss.map((v) => v.negated()),
    effectiveGrossRevenue,
    operatingExpenses: operatingExpenses.map((v) => v.negated()),
    netOperatingIncome,
    tenantImprovements: tenantImprovements.map((v) => v.negated()),
    leasingCommissions: leasingCommissions.map((v) => v.negated()),
    capitalExpenditures: capitalExpenditures.map((v) => v.negated()),
    unleveredCashFlow,
    debtProceeds: debt.proceeds,
    interestExpense: debt.interest.map((v) => v.negated()),
    principalAmortization: debt.principal.map((v) => v.negated()),
    financingFees: debt.fees.map((v) => v.negated()),
    // Negative in the period cash is trapped, positive when it is released, so
    // the line sums to zero over any span that both traps and releases.
    restrictedCash: cashTrap.movement.map((v) => v.negated()),
    leveredCashFlow,
    grossSaleProceeds,
    sellingCosts: sellingCosts.map((v) => v.negated()),
    debtPayoff: debt.payoff.map((v) => v.negated()),
    netDispositionProceeds,
    netCashFlow: leveredCashFlow,
  };

  const monthly = {} as CashFlowSeries;
  for (const line of CASH_FLOW_LINES) {
    monthly[line] = monthlyDecimals[line].map((value) => value.toDecimalPlaces(2).toFixed(2));
  }

  const annual: AnnualSummaryRow[] = [...calendar.periodsByFiscalYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fiscalYear, indices]) => {
      const lines = {} as Record<CashFlowLine, string>;
      for (const line of CASH_FLOW_LINES) {
        const series = monthlyDecimals[line];
        const value = indices.reduce((acc, index) => acc.plus(series[index] as Decimal), ZERO);
        lines[line] = value.toDecimalPlaces(2).toFixed(2);
      }
      return { fiscalYear, months: indices.length, lines };
    });

  const occupancy: OccupancyReconciliation[] = calendar.periods.map((period, i) => {
    const occupied = occupiedArea[i] as Decimal;
    const vacant = vacantArea[i] as Decimal;
    const egr = effectiveGrossRevenue[i] as Decimal;
    const potential = (potentialBaseRent[i] as Decimal)
      .plus(recoveries.total[i] as Decimal)
      .plus(percentageRent.total[i] as Decimal)
      .plus(otherLeaseRevenue[i] as Decimal)
      .plus(otherPropertyRevenue.total[i] as Decimal);
    return {
      periodIndex: period.index,
      totalRentableArea: totalRentableArea.toFixed(4),
      occupiedArea: occupied.toFixed(4),
      leasedArea: occupied.toFixed(4),
      availableArea: vacant.toFixed(4),
      physicalVacantArea: vacant.toFixed(4),
      physicalOccupancyPercent: (physicalOccupancy[i] as Decimal).toFixed(8),
      economicOccupancyPercent: potential.isZero()
        ? '0.00000000'
        : egr.dividedBy(potential).toFixed(8),
    };
  });

  const tenantNames = new Map(input.tenants.map((tenant) => [tenant.id, tenant.name]));
  const leaseCashFlows: LeaseCashFlowRow[] = occurrenceSeries.map((series) => ({
    leaseId: series.occurrence.id,
    tenantId: series.occurrence.tenantId,
    tenantName: tenantNames.get(series.occurrence.tenantId) ?? series.occurrence.tenantName,
    ...(series.occurrence.scenario === 'contract'
      ? {}
      : { rolloverOf: series.occurrence.sourceLeaseId }),
    scenario: series.occurrence.scenario,
    baseRent: series.baseRent.map((v) => v.toFixed(2)),
    freeRent: series.freeRent.map((v) => v.negated().toFixed(2)),
    percentageRent: (percentageRent.byOccurrence.get(series.occurrence.id) ?? zeros(n)).map((v) =>
      v.toFixed(2),
    ),
    recoveries: (recoveries.byOccurrence.get(series.occurrence.id) ?? zeros(n)).map((v) =>
      v.toFixed(2),
    ),
    otherRevenue: series.otherRevenue.map((v) => v.toFixed(2)),
    tenantImprovements: series.tenantImprovements.map((v) => v.negated().toFixed(2)),
    leasingCommissions: series.leasingCommissions.map((v) => v.negated().toFixed(2)),
    occupiedArea: series.occupiedArea.map((v) => v.toFixed(4)),
  }));

  const returns = computeReturns({
    input,
    calendar,
    unleveredCashFlow,
    leveredCashFlow,
    netOperatingIncome,
    grossPotentialRevenue,
    operatingExpenses,
    effectiveGrossRevenue,
    debt,
    sale,
    concludedValue,
    acquisitionBasis,
    acquisitionCosts,
    totalCost,
    initialEquity,
    closingDebt,
    totalRentableArea,
    unitCount,
    physicalOccupancy,
  });

  validateModel(input, trace, {
    totalRentableArea,
    physicalOccupancy,
    concludedValue,
  });

  return {
    engineVersion: ENGINE_VERSION,
    modelId: input.modelId,
    calculatedAt: options.calculatedAt ?? new Date().toISOString(),
    currency: input.currency,
    areaUnit: input.areaUnit,
    periods: calendar.periods.map(({ start: _s, end: _e, ...meta }) => meta),
    monthly,
    annual,
    occupancy,
    leaseCashFlows,
    recoveryDetail: recoveries.detail,
    debtSchedules: debt.schedules,
    valuations,
    returns,
    waterfall,
    diagnostics: trace.getDiagnostics(),
    trace: trace.getTrace(),
  };
}

/* -------------------------------------------------------------------------- */
/* Vacancy allowances                                                        */
/* -------------------------------------------------------------------------- */

/**
 * General vacancy and credit loss.
 *
 * Absorption and turnover vacancy is already deducted lease-by-lease when a
 * space rolls or sits empty. Applying a general vacancy allowance on top of
 * that would deduct the same vacancy twice, so by default the general allowance
 * is reduced by the vacancy the lease-level forecast already captured, and only
 * the shortfall against the target rate is charged.
 */
function computeVacancyAllowances(
  input: ModelInput,
  grossPotentialRevenue: Decimal[],
  scheduledBaseRent: Decimal[],
  recoveries: Decimal[],
  percentageRent: Decimal[],
  otherRevenue: Decimal[],
  absorptionAndTurnoverVacancy: Decimal[],
): { generalVacancy: Decimal[]; creditLoss: Decimal[] } {
  const n = grossPotentialRevenue.length;
  const rate = d(input.vacancy.generalVacancyRate);
  const creditRate = d(input.vacancy.creditLossRate);
  const appliesTo = new Set(input.vacancy.appliesTo);

  const generalVacancy = zeros(n);
  const creditLoss = zeros(n);

  for (let i = 0; i < n; i += 1) {
    let base = ZERO;
    if (appliesTo.has('base_rent')) base = base.plus(scheduledBaseRent[i] as Decimal);
    if (appliesTo.has('recoveries')) base = base.plus(recoveries[i] as Decimal);
    if (appliesTo.has('percentage_rent')) base = base.plus(percentageRent[i] as Decimal);
    if (appliesTo.has('other_revenue')) base = base.plus(otherRevenue[i] as Decimal);

    const target = base.times(rate);
    const alreadyModelled = (absorptionAndTurnoverVacancy[i] as Decimal).negated();
    generalVacancy[i] = input.vacancy.netAgainstModelledVacancy
      ? Decimal.max(target.minus(alreadyModelled), ZERO)
      : target;
    creditLoss[i] = base.times(creditRate);
  }

  return { generalVacancy, creditLoss };
}

/* -------------------------------------------------------------------------- */
/* Returns                                                                   */
/* -------------------------------------------------------------------------- */

interface ReturnsContext {
  input: ModelInput;
  calendar: ReturnType<typeof buildCalendar>;
  unleveredCashFlow: Decimal[];
  leveredCashFlow: Decimal[];
  netOperatingIncome: Decimal[];
  grossPotentialRevenue: Decimal[];
  operatingExpenses: Decimal[];
  effectiveGrossRevenue: Decimal[];
  debt: ReturnType<typeof computeDebt>;
  sale: ReturnType<typeof computeSale>;
  concludedValue: Decimal;
  acquisitionBasis: Decimal;
  acquisitionCosts: Decimal;
  totalCost: Decimal;
  initialEquity: Decimal;
  closingDebt: Decimal;
  totalRentableArea: Decimal;
  unitCount: number;
  physicalOccupancy: Decimal[];
}

function computeReturns(ctx: ReturnsContext): ReturnMetrics {
  const {
    input,
    calendar,
    unleveredCashFlow,
    leveredCashFlow,
    netOperatingIncome,
    debt,
    sale,
    concludedValue,
    acquisitionBasis,
    acquisitionCosts,
    totalCost,
    initialEquity,
    closingDebt,
    totalRentableArea,
    unitCount,
  } = ctx;

  const saleIndex = sale?.saleIndex ?? calendar.periods.length - 1;
  const horizon = saleIndex + 1;
  const initialOutflow = acquisitionBasis.plus(acquisitionCosts).negated();

  const unleveredFlows = unleveredCashFlow
    .slice(0, horizon)
    .map((cf, i) => (sale && i === sale.saleIndex ? cf.plus(sale.netSaleProceeds) : cf));
  const leveredFlows = leveredCashFlow
    .slice(0, horizon)
    .map((cf, i) => (i === 0 ? cf.minus(closingDebt) : cf));

  const unleveredIrr = irrMonthly(unleveredFlows, initialOutflow);
  const leveredIrr = irrMonthly(leveredFlows, initialEquity.negated());

  const datedUnlevered = [
    {
      date: calendar.periods[0]?.start ?? { year: 2000, month: 1, day: 1 },
      amount: initialOutflow,
    },
    ...unleveredFlows.map((amount, i) => ({
      date: calendar.periods[i]?.end ?? { year: 2000, month: 1, day: 1 },
      amount,
    })),
  ];
  const datedLevered = [
    {
      date: calendar.periods[0]?.start ?? { year: 2000, month: 1, day: 1 },
      amount: initialEquity.negated(),
    },
    ...leveredFlows.map((amount, i) => ({
      date: calendar.periods[i]?.end ?? { year: 2000, month: 1, day: 1 },
      amount,
    })),
  ];

  // `computeDirectCapitalization`'s `year_1` basis annualises a forecast
  // shorter than 12 months rather than dividing a partial year's income by a
  // cap rate calibrated to a full one; these three metrics read the same
  // "year 1 NOI" concept and were not annualised the same way, understating
  // going-in cap rate, yield on cost and year-1 debt yield by up to 2x on a
  // 6-month forecast.
  const year1NoiMonths = Math.min(12, netOperatingIncome.length);
  let year1Noi = slice(netOperatingIncome, 0, year1NoiMonths);
  if (year1NoiMonths < 12 && year1NoiMonths > 0) {
    year1Noi = year1Noi.times(TWELVE).dividedBy(year1NoiMonths);
  }
  const goingInCap = safeDivide(year1Noi, acquisitionBasis);
  const yieldOnCost = safeDivide(year1Noi, totalCost);

  const dscrValues: Decimal[] = [];
  for (const schedule of debt.schedules) {
    for (const row of schedule.rows) {
      if (row.dscr !== null) dscrValues.push(d(row.dscr));
    }
  }

  const cashOnCashByYear = [...calendar.periodsByFiscalYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fiscalYear, indices]) => {
      // Excludes the sale period itself (its cash flow is a capital event,
      // the lump-sum sale proceeds, not operating income) and, the same
      // fix as the waterfall above, everything after it — a fiscal year
      // that falls entirely after the sale has no operating cash flow to
      // this deal at all, not the property's still-projected income from an
      // ownership that already ended.
      const operating = indices
        .filter((index) => index < saleIndex)
        .reduce((acc, index) => acc.plus(leveredCashFlow[index] ?? ZERO), ZERO);
      return {
        fiscalYear,
        value: initialEquity.isZero() ? '0' : operating.dividedBy(initialEquity).toString(),
      };
    });

  const year1Gpr = slice(ctx.grossPotentialRevenue, 0, 12);
  const year1Opex = slice(ctx.operatingExpenses, 0, 12);
  const year1DebtService = slice(debt.interest, 0, 12).plus(slice(debt.principal, 0, 12));

  const debtBalanceYear1 = debt.endingBalance[Math.min(11, debt.endingBalance.length - 1)] ?? ZERO;

  return {
    unleveredIrr: toStringOrNull(unleveredIrr),
    leveredIrr: toStringOrNull(leveredIrr),
    unleveredXirr: toStringOrNull(xirr(datedUnlevered)),
    leveredXirr: toStringOrNull(xirr(datedLevered)),
    equityMultiple: toStringOrNull(equityMultiple([initialEquity.negated(), ...leveredFlows])),
    netPresentValue: npvMonthly(
      unleveredFlows,
      d(input.valuation.discountRate),
      input.valuation.discountingConvention,
      initialOutflow,
    ).toString(),
    profit: unleveredFlows.reduce((acc, v) => acc.plus(v), initialOutflow).toString(),
    goingInCapRate: toStringOrNull(goingInCap),
    // Months 13-24 have to actually exist: `slice` sums whatever falls in an
    // out-of-range window rather than signalling "unavailable", so a
    // forecast shorter than 24 months summed an empty or partial window to
    // zero — reported as a real "0%" stabilised cap rate rather than the
    // missing figure it actually is. See docs/calculation-specification.md:
    // a figure that cannot be computed is `null`, never a silent zero.
    stabilizedCapRate:
      netOperatingIncome.length >= 24
        ? toStringOrNull(safeDivide(slice(netOperatingIncome, 12, 24), acquisitionBasis))
        : null,
    exitCapRate: input.valuation.terminalCapRate ?? null,
    yieldOnCost: toStringOrNull(yieldOnCost),
    cashOnCashByYear,
    averageDscr:
      dscrValues.length === 0
        ? null
        : dscrValues
            .reduce((acc, v) => acc.plus(v), ZERO)
            .dividedBy(dscrValues.length)
            .toString(),
    minimumDscr:
      dscrValues.length === 0
        ? null
        : dscrValues.reduce((acc, v) => (v.lessThan(acc) ? v : acc)).toString(),
    debtYieldYear1: toStringOrNull(safeDivide(year1Noi, debtBalanceYear1)),
    loanToValue: toStringOrNull(safeDivide(closingDebt, concludedValue)),
    loanToCost: toStringOrNull(safeDivide(closingDebt, totalCost)),
    breakevenOccupancy: toStringOrNull(breakevenOccupancy(year1Gpr, year1Opex, year1DebtService)),
    valuePerArea: toStringOrNull(safeDivide(concludedValue, totalRentableArea)),
    valuePerUnit: unitCount === 0 ? null : concludedValue.dividedBy(unitCount).toString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                */
/* -------------------------------------------------------------------------- */

/** Occupancy fraction per space per period, summed across occurrences. */
function accumulateSpaceOccupancy(
  series: OccurrenceSeries[],
  spaces: NormalizedSpace[],
  periods: number,
): Map<string, Decimal[]> {
  const occupancy = new Map<string, Decimal[]>(spaces.map((space) => [space.id, zeros(periods)]));
  for (const entry of series) {
    for (const spaceId of entry.occurrence.spaceIds) {
      const target = occupancy.get(spaceId);
      if (!target) continue;
      for (let i = 0; i < periods; i += 1) {
        target[i] = (target[i] as Decimal).plus(entry.occupancyFraction[i] ?? ZERO);
      }
    }
  }
  return occupancy;
}

function detectOverlaps(
  series: OccurrenceSeries[],
  spaces: Map<string, NormalizedSpace>,
  trace: TraceRecorder,
): void {
  const bySpace = new Map<string, OccurrenceSeries[]>();
  for (const entry of series) {
    if (entry.occurrence.scenario !== 'contract') continue;
    for (const spaceId of entry.occurrence.spaceIds) {
      const bucket = bySpace.get(spaceId);
      if (bucket) bucket.push(entry);
      else bySpace.set(spaceId, [entry]);
    }
  }

  for (const [spaceId, entries] of bySpace) {
    if (entries.length < 2) continue;
    const periods = entries[0]?.occupancyFraction.length ?? 0;
    for (let i = 0; i < periods; i += 1) {
      const total = entries.reduce(
        (acc, entry) => acc.plus(entry.occupancyFraction[i] ?? ZERO),
        ZERO,
      );
      if (total.greaterThan('1.0001')) {
        trace.error(
          'SPACE_DOUBLE_LET',
          `Space ${spaces.get(spaceId)?.code ?? spaceId} is let to more than one tenant in forecast month ${i + 1}. Overlapping lease terms inflate both occupancy and revenue.`,
          `space:${spaceId}`,
          'leases',
        );
        break;
      }
    }
  }
}

function validateModel(
  input: ModelInput,
  trace: TraceRecorder,
  context: { totalRentableArea: Decimal; physicalOccupancy: Decimal[]; concludedValue: Decimal },
): void {
  if (context.totalRentableArea.isZero() && input.leases.length > 0) {
    trace.error(
      'NO_RENTABLE_AREA',
      'The model has leases but no rentable area, so per-area rents and recovery denominators cannot be computed.',
      `property:${input.property.id}`,
      'rentableArea',
    );
  }
  for (const [index, occupancy] of context.physicalOccupancy.entries()) {
    if (occupancy.greaterThan('1.0001')) {
      trace.error(
        'OCCUPANCY_ABOVE_100',
        `Physical occupancy exceeds 100% in forecast month ${index + 1}. Check for overlapping leases or lease areas larger than their spaces.`,
        `property:${input.property.id}`,
        'occupancy',
      );
      break;
    }
    if (occupancy.lessThan(0)) {
      trace.error(
        'NEGATIVE_OCCUPANCY',
        `Physical occupancy is negative in forecast month ${index + 1}.`,
        `property:${input.property.id}`,
        'occupancy',
      );
      break;
    }
  }
  if (!input.valuation.discountRate || d(input.valuation.discountRate).isZero()) {
    trace.warn(
      'ZERO_DISCOUNT_RATE',
      'The discount rate is zero, so the discounted cash-flow value is an undiscounted sum of future cash flows.',
      'valuation',
      'discountRate',
    );
  }
  for (const lease of input.leases) {
    if (d(lease.area).isZero() && lease.status !== 'vacant') {
      trace.warn(
        'LEASE_MISSING_AREA',
        `Lease ${lease.id} has no area. Per-area rent, recoveries and occupancy will all be zero for it.`,
        `lease:${lease.id}`,
        'area',
      );
    }
  }
  const currencies = new Set([input.currency]);
  if (currencies.size > 1) {
    trace.error('MULTIPLE_CURRENCIES', 'A model cannot mix currencies.', 'model', 'currency');
  }
}

export { monthDifference, TWELVE, ONE };
