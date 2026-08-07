/**
 * Performance baseline.
 *
 * `docs/architecture.md` says the platform is designed for thousands of
 * properties and hundreds of thousands of lease steps. That was an informed
 * expectation, not a measurement, and an expectation is not something to put in
 * front of an investment committee. This measures it.
 *
 *   pnpm benchmark              # engine only, no database needed
 *   DATABASE_URL=… pnpm benchmark --database
 *
 * The output is a table of real timings and a verdict. It fails the process
 * when a budget is exceeded, so a catastrophic regression breaks the build
 * rather than sitting unread in a log. The budgets are deliberately loose —
 * they exist to catch an order-of-magnitude change, not to police the few
 * percent of noise you get from a shared CI runner.
 */
import { performance } from 'node:perf_hooks';
import type { ModelInput, ModelInputDraft } from '../packages/domain-models/src/index.js';
import { parseModelInput } from '../packages/domain-models/src/index.js';
import { calculate } from '../packages/calculation-engine/src/index.js';

interface Budget {
  /** Milliseconds this case must not exceed. */
  limit: number;
  reason: string;
}

interface Measurement {
  name: string;
  leases: number;
  rentSteps: number;
  months: number;
  millis: number;
  perLeaseMonth: number;
  budget?: Budget;
}

/**
 * Builds a synthetic property of a given size.
 *
 * Each lease gets its own space, a staggered term so rollover actually fires,
 * and the requested number of rent steps. Terms are deliberately spread across
 * the forecast so a realistic share of them expire inside it and generate
 * probability-weighted branches — a model whose leases all outlast the forecast
 * would measure the easy path and prove nothing.
 */
function syntheticModel(options: {
  leases: number;
  stepsPerLease: number;
  months: number;
}): ModelInput {
  const { leases, stepsPerLease, months } = options;
  const areaEach = 2500;

  // Typed from the draft rather than inferred: an inferred object literal
  // widens 'office' to `string`, which is why this whole draft used to be
  // forced through `as ModelInputDraft` — and that cast then hid three
  // properties that do not exist in the schema at all.
  const spaces: NonNullable<ModelInputDraft['spaces']> = Array.from(
    { length: leases },
    (_, index) => ({
      id: `S${index}`,
      code: `Suite ${index + 1}`,
      area: String(areaEach),
      spaceType: 'office',
    }),
  );

  const tenants = Array.from({ length: leases }, (_, index) => ({
    id: `T${index}`,
    name: `Tenant ${index + 1}`,
  }));

  const leaseRecords: NonNullable<ModelInputDraft['leases']> = Array.from(
    { length: leases },
    (_, index) => {
      // Terms of 3 to 9 years, commencing across a six-year window before and
      // inside the forecast, so expiries land throughout it.
      const startYear = 2022 + (index % 6);
      const termYears = 3 + (index % 7);
      // `as const` so the basis stays the literal the schema expects rather
      // than widening to `string` on its way out of this callback.
      const steps = Array.from({ length: stepsPerLease }, (_, step) => ({
        startDate: `${startYear + step + 1}-01-01`,
        amount: String(30 + step),
        basis: 'per_area_per_year' as const,
      }));

      return {
        id: `L${index}`,
        tenantId: `T${index}`,
        spaceIds: [`S${index}`],
        status: 'occupied',
        area: String(areaEach),
        commencementDate: `${startYear}-01-01`,
        expirationDate: `${startYear + termYears}-12-31`,
        baseRent: '30.00',
        baseRentBasis: 'per_area_per_year',
        escalation: { type: 'fixed_percent', rate: '0.03', frequencyMonths: 12, compounding: true },
        recovery: { method: 'base_year' },
        rentSteps: steps,
      };
    },
  );

  const draft: ModelInputDraft = {
    modelId: 'benchmark',
    modelName: 'Synthetic benchmark property',
    forecast: {
      startDate: '2026-01-01',
      months,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-BENCH',
      name: 'Synthetic benchmark property',
      propertyType: 'office',
      rentableArea: String(areaEach * leases),
    },
    spaces,
    tenants,
    leases: leaseRecords,
    // No `code` on these, nor on the expenses below. Growth curves are
    // referenced by `growthCurveId` and leasing profiles by
    // `marketLeasingProfileId`, both matching `id`; only spaces have a `code`
    // at all. zod strips unknown keys silently, so the extra properties never
    // failed — they simply were not there, and the `as ModelInputDraft` this
    // object used to carry hid the mismatch from the compiler.
    growthCurves: [{ id: 'CPI', name: 'Inflation', defaultRate: '0.025' }],
    marketLeasingProfiles: [
      {
        id: 'MLA',
        name: 'Benchmark office',
        marketRent: '32.00',
        marketRentBasis: 'per_area_per_year',
        renewalProbability: '0.65',
        renewalTermMonths: 60,
        newLeaseTermMonths: 60,
        downtimeMonths: 6,
        newFreeRentMonths: 3,
        newTiPerArea: '45.00',
        renewalTiPerArea: '15.00',
        newLcPercent: '0.05',
        renewalLcPercent: '0.02',
        recovery: { method: 'base_year' },
      },
    ],
    defaultMarketLeasingProfileId: 'MLA',
    expenses: [
      {
        id: 'E1',
        name: 'Operating expenses',
        category: 'other',
        method: 'per_area_per_year',
        amount: '11.50',
        growthCurveId: 'CPI',
        recoverableShare: '1',
      },
      {
        id: 'E2',
        name: 'Management fee',
        category: 'management',
        method: 'percent_of_effective_gross_revenue',
        amount: '0.03',
        recoverableShare: '1',
      },
    ],
    valuation: {
      discountRate: '0.08',
      discountingConvention: 'end_of_period',
      terminalCapRate: '0.065',
      terminalNoiBasis: 'forward_12',
      saleCostPercent: '0.01',
      saleMonth: months - 12,
      acquisitionPrice: String(areaEach * leases * 300),
      acquisitionCosts: '0',
    },
  };

  return parseModelInput(draft);
}

/** Runs a case, discarding a warm-up pass so JIT compilation is not measured. */
function measure(name: string, input: ModelInput, budget?: Budget): Measurement {
  calculate(input);

  const started = performance.now();
  const result = calculate(input);
  const millis = performance.now() - started;

  const leases = input.leases.length;
  const rentSteps = input.leases.reduce((total, lease) => total + lease.rentSteps.length, 0);
  const months = result.periods.length;

  return {
    name,
    leases,
    rentSteps,
    months,
    millis,
    perLeaseMonth: millis / Math.max(leases * months, 1),
    ...(budget ? { budget } : {}),
  };
}

const CASES: Array<{
  name: string;
  leases: number;
  steps: number;
  months: number;
  budget: Budget;
}> = [
  {
    name: 'Single tenant, 10 years',
    leases: 1,
    steps: 4,
    months: 120,
    budget: { limit: 250, reason: 'The smallest useful model must feel instant.' },
  },
  {
    name: 'Small multi-tenant, 10 years',
    leases: 25,
    steps: 4,
    months: 120,
    budget: {
      limit: 1_500,
      reason: 'A typical office building, recalculated on every keystroke-driven run.',
    },
  },
  {
    name: 'Large multi-tenant, 10 years',
    leases: 100,
    steps: 6,
    months: 120,
    budget: {
      limit: 6_000,
      reason: 'A large single asset. Slower than interactive, still tolerable.',
    },
  },
  {
    name: 'Very large multi-tenant, 10 years',
    leases: 300,
    steps: 8,
    months: 120,
    budget: {
      limit: 30_000,
      reason: 'A mall or a campus. Queued to the worker rather than run on the request path.',
    },
  },
];

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : `${' '.repeat(width - value.length)}${value}`;
}

console.warn('Calculation engine performance\n');

const measurements: Measurement[] = [];
for (const testCase of CASES) {
  const input = syntheticModel({
    leases: testCase.leases,
    stepsPerLease: testCase.steps,
    months: testCase.months,
  });
  measurements.push(measure(testCase.name, input, testCase.budget));
}

console.warn(
  `${pad('Case', 34)}${padLeft('Leases', 8)}${padLeft('Steps', 8)}${padLeft('Months', 8)}` +
    `${padLeft('ms', 10)}${padLeft('µs/lease-mo', 14)}${padLeft('budget', 10)}`,
);
console.warn('-'.repeat(92));

const exceeded: Measurement[] = [];
for (const entry of measurements) {
  const withinBudget = !entry.budget || entry.millis <= entry.budget.limit;
  if (!withinBudget) exceeded.push(entry);
  console.warn(
    pad(entry.name, 34) +
      padLeft(String(entry.leases), 8) +
      padLeft(String(entry.rentSteps), 8) +
      padLeft(String(entry.months), 8) +
      padLeft(entry.millis.toFixed(1), 10) +
      padLeft((entry.perLeaseMonth * 1000).toFixed(1), 14) +
      padLeft(entry.budget ? (withinBudget ? 'ok' : 'EXCEEDED') : '—', 10),
  );
}

/**
 * How the cost grows with the model.
 *
 * The interesting number is not any single timing — it is whether the work per
 * lease-month stays flat as the model grows. Flat means linear, which is what
 * lets a large portfolio be planned for. Rising sharply would mean something is
 * quadratic in the lease count and no amount of hardware fixes it.
 */
const smallest = measurements[0];
const largest = measurements[measurements.length - 1];
if (smallest && largest) {
  const ratio = largest.perLeaseMonth / smallest.perLeaseMonth;
  console.warn(
    `\nWork per lease-month, smallest to largest case: ${ratio.toFixed(2)}x.\n` +
      (ratio <= 3
        ? 'Cost grows roughly linearly with the model. Scale is a matter of hardware and queueing.'
        : 'Cost grows faster than linearly. Something is superlinear in the lease count; ' +
          'profile before promising this scale.'),
  );
}

console.warn(
  '\nMeasured on this machine, single process, no database. Absolute numbers are\n' +
    'not portable between machines; the shape of the curve and the budgets are.',
);

if (exceeded.length > 0) {
  console.error(`\n${exceeded.length} case(s) exceeded their budget:`);
  for (const entry of exceeded) {
    console.error(
      `  - ${entry.name}: ${entry.millis.toFixed(0)}ms against a ${entry.budget?.limit}ms budget. ` +
        `${entry.budget?.reason}`,
    );
  }
  process.exit(1);
}

console.warn('\nEvery case is inside its budget.');
