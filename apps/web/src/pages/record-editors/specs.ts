import { debtTypeEnum, expenseMethodEnum, rentBasisEnum } from '@cre/domain-models';
import {
  mustBeIsoDate,
  mustBeNumber,
  mustBeRate,
  readPath,
  type FieldSpec,
  type RecordSpec,
  type RecordValues,
} from './spec.js';

/**
 * The record editors, as data.
 *
 * Three of these replace a JSON textarea that showed every field of every
 * method at once. What changes is not only the controls: a `fixed_annual`
 * expense no longer displays a monthly schedule it will never read, and a
 * fixed-rate loan no longer displays an index curve, a spread, a floor and a
 * cap that do nothing.
 */

const choice = (options: readonly string[]): Array<{ value: string; label: string }> =>
  options.map((option) => ({
    value: option,
    label: option.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
  }));

const codeField = (): FieldSpec => ({
  key: 'code',
  label: 'Code',
  kind: 'text',
  required: true,
  fixedAfterCreate: true,
  help: 'The stable identifier used in traces, reports and by other records. It cannot change later, because doing so would orphan those references.',
});

const nameField = (): FieldSpec => ({ key: 'name', label: 'Name', kind: 'text', required: true });

const method = (record: RecordValues): string => String(readPath(record, 'method') ?? '');

/* -------------------------------------------------------------------------- */
/* Operating expense                                                          */
/* -------------------------------------------------------------------------- */

const usesSchedule = (record: RecordValues): boolean =>
  method(record) === 'custom_monthly_schedule';
const usesPercentage = (record: RecordValues): boolean => method(record).startsWith('percent_of_');

export const EXPENSE_SPEC: RecordSpec = {
  segment: 'expenses',
  noun: 'operating expense',
  defaults: {
    category: 'operating',
    method: 'fixed_annual',
    amount: '0',
    recoverableShare: '0',
    variableShare: '0',
    isCapitalized: false,
  },
  sections: [
    {
      title: 'What it is',
      fields: [
        codeField(),
        nameField(),
        {
          key: 'category',
          label: 'Category',
          kind: 'choice',
          required: true,
          options: choice([
            'operating',
            'utilities',
            'management',
            'taxes',
            'insurance',
            'repairs',
            'administrative',
            'ground_rent',
            'other',
          ]),
          help: 'Groups the line in reports. It does not change how the expense is calculated.',
        },
        {
          key: 'accountCode',
          label: 'Account code',
          kind: 'text',
          help: 'Matched against the chart of accounts when actuals are imported for variance.',
        },
      ],
    },
    {
      title: 'How much',
      description:
        'The method decides what the amount means. Changing it reinterprets the figure beside it; it does not convert it.',
      fields: [
        {
          key: 'method',
          label: 'Method',
          kind: 'choice',
          required: true,
          options: choice(expenseMethodEnum.options),
        },
        {
          key: 'amount',
          label: 'Amount',
          kind: 'decimal',
          required: true,
          showWhen: (record) => !usesSchedule(record),
          validate: mustBeNumber({ label: 'Amount' }),
          help: 'A total for the year, a rate per area unit, per unit, or a fraction — whichever the method says.',
        },
        {
          key: 'monthlySchedule',
          label: 'Monthly amounts',
          kind: 'schedule',
          showWhen: usesSchedule,
          placeholder: '1000, 1000, 1250, …',
          help: 'One amount per forecast month, comma separated. A schedule shorter than the forecast repeats its last value; the engine reports that as a diagnostic.',
        },
        {
          key: 'growthCurve',
          label: 'Growth curve',
          kind: 'curve',
          showWhen: (record) => !usesPercentage(record),
          help: 'A percentage-based expense follows the revenue it is charged on, so no curve applies to it.',
        },
      ],
    },
    {
      title: 'Recovery and behaviour',
      fields: [
        {
          key: 'recoverableShare',
          label: 'Recoverable share',
          kind: 'percent',
          validate: mustBeRate({ max: 1 }),
          help: 'The share eligible for recovery from tenants, before each lease’s own method, base year, stop and caps apply. 1 means wholly recoverable.',
        },
        {
          key: 'variableShare',
          label: 'Occupancy-variable share',
          kind: 'percent',
          validate: mustBeRate({ max: 1 }),
          help: 'The share that scales with physical occupancy; the rest is fixed. A wholly variable expense at 80% occupancy costs 80% of its base.',
        },
        {
          key: 'isCapitalized',
          label: 'Capitalised',
          kind: 'boolean',
          help: 'Capitalised expenses join capital expenditure below NOI instead of being deducted as an operating cost. NOI rises; unlevered cash flow does not.',
        },
      ],
    },
  ],
  summary: (record) => {
    const share = Number(readPath(record, 'recoverableShare') ?? 0);
    const variable = Number(readPath(record, 'variableShare') ?? 0);
    return [
      {
        label: 'Reads as',
        value: describeExpenseAmount(record),
      },
      {
        label: 'Recovery',
        value:
          share <= 0
            ? 'Not recoverable'
            : share >= 1
              ? 'Wholly recoverable'
              : `${(share * 100).toFixed(1)}% recoverable`,
        note: 'Before each lease’s own method and caps.',
      },
      {
        label: 'Occupancy',
        value:
          variable <= 0
            ? 'Fixed'
            : variable >= 1
              ? 'Wholly variable'
              : `${(variable * 100).toFixed(0)}% variable`,
      },
      {
        label: 'Sits',
        value: readPath(record, 'isCapitalized') === true ? 'Below NOI' : 'Above NOI',
      },
    ];
  },
};

function describeExpenseAmount(record: RecordValues): string {
  const amount = String(readPath(record, 'amount') ?? '0');
  switch (method(record)) {
    case 'fixed_annual':
      return `${amount} per year`;
    case 'per_area_per_year':
      return `${amount} per area unit per year`;
    case 'per_unit_per_year':
      return `${amount} per unit per year`;
    case 'percent_of_effective_gross_revenue':
      return `${(Number(amount) * 100).toFixed(2)}% of effective gross revenue`;
    case 'percent_of_base_rent':
      return `${(Number(amount) * 100).toFixed(2)}% of base rent`;
    case 'custom_monthly_schedule': {
      const schedule = readPath(record, 'monthlySchedule');
      const count = Array.isArray(schedule) ? schedule.length : 0;
      return count === 0 ? 'A schedule with no months in it' : `A schedule of ${count} month(s)`;
    }
    default:
      return amount;
  }
}

/* -------------------------------------------------------------------------- */
/* Market leasing assumption                                                  */
/* -------------------------------------------------------------------------- */

const escalationFields = (prefix: 'renewalEscalation' | 'newEscalation'): FieldSpec[] => [
  {
    key: `${prefix}.type`,
    label: 'Escalation',
    kind: 'choice',
    options: choice(['none', 'fixed_percent', 'fixed_amount', 'index', 'market_reset']),
    help: 'How the rent steps up over the term. A fixed percentage compounds annually; an index follows a growth curve; a market reset re-strikes the rent at the market rate above.',
  },
  {
    key: `${prefix}.rate`,
    label: 'Rate or amount',
    kind: 'decimal',
    showWhen: (record) => {
      const type = readPath(record, `${prefix}.type`);
      return typeof type === 'string' && type !== 'none' && type !== '';
    },
    help: 'A decimal fraction for a percentage (0.03 for 3%), or an amount for a fixed step.',
  },
];

export const MARKET_LEASING_SPEC: RecordSpec = {
  segment: 'market-leasing',
  noun: 'market leasing assumption',
  defaults: {
    marketRent: '0',
    marketRentBasis: 'per_area_per_year',
    renewalProbability: '0.65',
    renewalTermMonths: 60,
    newLeaseTermMonths: 60,
    downtimeMonths: '6',
    renewalFreeRentMonths: '0',
    newFreeRentMonths: '3',
    renewalTiPerArea: '0',
    newTiPerArea: '0',
    renewalLcPercent: '0',
    newLcPercent: '0',
    precedence: 0,
  },
  sections: [
    {
      title: 'What it is',
      fields: [
        codeField(),
        nameField(),
        {
          key: 'precedence',
          label: 'Precedence',
          kind: 'integer',
          help: 'Resolves overlaps when more than one profile could apply to a space. The higher number wins, and the winner is recorded in the calculation trace.',
        },
      ],
    },
    {
      title: 'Market rent',
      description:
        'What the space would let for today, and how that grows. Both branches below start from this.',
      fields: [
        {
          key: 'marketRent',
          label: 'Market rent',
          kind: 'decimal',
          required: true,
          validate: mustBeNumber({ min: 0, label: 'Market rent' }),
        },
        {
          key: 'marketRentBasis',
          label: 'Basis',
          kind: 'choice',
          options: choice(rentBasisEnum.options),
        },
        {
          key: 'marketRentGrowthCurve',
          label: 'Rent growth curve',
          kind: 'curve',
          help: 'Grows the market rent used by rollovers landing in later years. Contractual rent on an existing lease is unaffected.',
        },
      ],
    },
    {
      title: 'Rollover',
      description:
        'A rollover is modelled as two weighted branches: renewal at this probability, and a new lease at its complement. Downtime applies only to the new-lease branch, because a tenant that renews never leaves.',
      fields: [
        {
          key: 'renewalProbability',
          label: 'Renewal probability',
          kind: 'percent',
          required: true,
          validate: mustBeRate({ max: 1 }),
          help: 'A fraction between 0 and 1. Both branches are always calculated; this is how they are weighted.',
        },
        {
          key: 'downtimeMonths',
          label: 'Downtime (months)',
          kind: 'months',
          validate: mustBeNumber({ min: 0, label: 'Downtime' }),
          help: 'Vacant months between one lease ending and the next beginning, on the new-lease branch only.',
        },
      ],
    },
    {
      title: 'If the tenant renews',
      pairWithNext: true,
      fields: [
        { key: 'renewalTermMonths', label: 'Term (months)', kind: 'integer' },
        {
          key: 'renewalFreeRentMonths',
          label: 'Free rent (months)',
          kind: 'months',
          validate: mustBeNumber({ min: 0, label: 'Free rent' }),
        },
        {
          key: 'renewalTiPerArea',
          label: 'Tenant improvement, per area',
          kind: 'decimal',
          validate: mustBeNumber({ min: 0, label: 'TI' }),
        },
        {
          key: 'renewalLcPercent',
          label: 'Leasing commission',
          kind: 'percent',
          validate: mustBeRate({ max: 1 }),
          help: 'A fraction of the rent over the term.',
        },
        ...escalationFields('renewalEscalation'),
      ],
    },
    {
      title: 'If the tenant leaves',
      fields: [
        { key: 'newLeaseTermMonths', label: 'Term (months)', kind: 'integer' },
        {
          key: 'newFreeRentMonths',
          label: 'Free rent (months)',
          kind: 'months',
          validate: mustBeNumber({ min: 0, label: 'Free rent' }),
        },
        {
          key: 'newTiPerArea',
          label: 'Tenant improvement, per area',
          kind: 'decimal',
          validate: mustBeNumber({ min: 0, label: 'TI' }),
        },
        {
          key: 'newLcPercent',
          label: 'Leasing commission',
          kind: 'percent',
          validate: mustBeRate({ max: 1 }),
        },
        ...escalationFields('newEscalation'),
      ],
    },
    {
      title: 'Recovery on rollover',
      description: 'What a lease signed under this profile recovers.',
      fields: [
        {
          key: 'recovery.method',
          label: 'Method',
          kind: 'choice',
          options: choice([
            'none',
            'triple_net',
            'base_year',
            'expense_stop',
            'full_service_gross',
            'fixed_amount',
          ]),
        },
        {
          key: 'recovery.expenseStopPerArea',
          label: 'Expense stop, per area',
          kind: 'decimal',
          showWhen: (record) => readPath(record, 'recovery.method') === 'expense_stop',
        },
        {
          key: 'recovery.adminFeePercent',
          label: 'Administrative fee',
          kind: 'percent',
          showWhen: (record) => {
            const value = readPath(record, 'recovery.method');
            return typeof value === 'string' && value !== 'none' && value !== '';
          },
          validate: mustBeRate({ max: 1 }),
          help: 'Charged on the recovered amount, after the entitlement is worked out.',
        },
      ],
    },
  ],
  summary: (record) => {
    const probability = Number(readPath(record, 'renewalProbability') ?? 0);
    const downtime = Number(readPath(record, 'downtimeMonths') ?? 0);
    const renewalTi = Number(readPath(record, 'renewalTiPerArea') ?? 0);
    const newTi = Number(readPath(record, 'newTiPerArea') ?? 0);
    /*
     * The weighted cost of a rollover, per area unit, on TI alone.
     *
     * This is arithmetic over the two fields above it, not a call to the
     * engine, and the panel says so. It is here because the renewal
     * probability's effect on cost is the thing analysts most often get wrong
     * by eye: 70% renewal with 10 of renewal TI against 50 of new TI is not
     * "somewhere in between", it is 22.
     */
    const weightedTi = probability * renewalTi + (1 - probability) * newTi;
    return [
      { label: 'Renews', value: `${(probability * 100).toFixed(0)}% of the time` },
      {
        label: 'Weighted TI',
        value: weightedTi.toFixed(2),
        note: 'Per area unit, over both branches.',
      },
      {
        label: 'Vacancy on turnover',
        value: `${((1 - probability) * downtime).toFixed(1)} months`,
        note: 'Weighted: downtime applies to the new-lease branch only.',
      },
    ];
  },
};

/* -------------------------------------------------------------------------- */
/* Debt facility                                                              */
/* -------------------------------------------------------------------------- */

const isFloating = (record: RecordValues): boolean => readPath(record, 'rateType') === 'floating';

export const DEBT_SPEC: RecordSpec = {
  segment: 'debt',
  noun: 'debt facility',
  defaults: {
    type: 'permanent',
    commitment: '0',
    initialFunding: '0',
    rateType: 'fixed',
    fixedRate: '0',
    spread: '0',
    interestOnlyMonths: 0,
    amortizationMonths: 0,
    termMonths: 120,
    originationFeePercent: '0',
    exitFeePercent: '0',
    unusedFeePercent: '0',
    capitalizeInterest: false,
    repayOnSale: true,
  },
  sections: [
    {
      title: 'Loan terms',
      fields: [
        codeField(),
        nameField(),
        { key: 'type', label: 'Type', kind: 'choice', options: choice(debtTypeEnum.options) },
        {
          key: 'commitment',
          label: 'Commitment',
          kind: 'decimal',
          required: true,
          validate: mustBeNumber({ min: 0, label: 'Commitment' }),
          help: 'The maximum available. An unused fee, if any, is charged on the part not drawn.',
        },
        {
          key: 'initialFunding',
          label: 'Initial funding',
          kind: 'decimal',
          validate: mustBeNumber({ min: 0, label: 'Initial funding' }),
          help: 'Drawn at the funding date. Later draws are a dated schedule, below.',
        },
        {
          key: 'fundingDate',
          label: 'Funding date',
          kind: 'date',
          required: true,
          validate: mustBeIsoDate,
        },
        {
          key: 'termMonths',
          label: 'Term (months)',
          kind: 'integer',
          required: true,
          validate: mustBeNumber({ min: 1, label: 'Term' }),
        },
        {
          key: 'interestOnlyMonths',
          label: 'Interest-only (months)',
          kind: 'integer',
          help: 'Counted from the funding date. Amortisation begins when it ends.',
        },
        {
          key: 'amortizationMonths',
          label: 'Amortisation (months)',
          kind: 'integer',
          help: 'The schedule the payment is sized on, which is usually longer than the term. Zero means interest-only throughout, with the balance repaid at maturity.',
        },
        {
          key: 'repayOnSale',
          label: 'Repays on sale',
          kind: 'boolean',
          help: 'The outstanding balance is retired out of the disposition proceeds.',
        },
      ],
    },
    {
      title: 'Rate',
      fields: [
        {
          key: 'rateType',
          label: 'Rate type',
          kind: 'choice',
          options: choice(['fixed', 'floating']),
        },
        {
          key: 'fixedRate',
          label: 'Fixed rate',
          kind: 'percent',
          showWhen: (record) => !isFloating(record),
          validate: mustBeRate({ max: 1 }),
          help: 'An annual rate as a decimal fraction: 0.055 for 5.5%.',
        },
        {
          key: 'indexCurve',
          label: 'Index curve',
          kind: 'curve',
          showWhen: isFloating,
          help: 'A growth curve whose annual rates are the index path. The applied rate is MIN(MAX(index + spread, floor), cap).',
        },
        {
          key: 'spread',
          label: 'Spread',
          kind: 'percent',
          showWhen: isFloating,
          validate: mustBeRate({ max: 1 }),
        },
        {
          key: 'rateFloor',
          label: 'Floor',
          kind: 'percent',
          showWhen: isFloating,
          validate: mustBeRate({ max: 1 }),
          help: 'Leave blank for no floor. A blank is not zero: a floor of zero would stop a negative index rate from ever helping.',
        },
        {
          key: 'rateCap',
          label: 'Cap',
          kind: 'percent',
          showWhen: isFloating,
          validate: mustBeRate({ max: 1 }),
        },
        {
          key: 'capitalizeInterest',
          label: 'Capitalises interest',
          kind: 'boolean',
          help: 'Interest joins the balance instead of being paid in cash. Usual on a construction facility, and it grows the loan with no matching draw.',
        },
      ],
    },
    {
      title: 'Fees',
      fields: [
        {
          key: 'originationFeePercent',
          label: 'Origination',
          kind: 'percent',
          validate: mustBeRate({ max: 1 }),
          help: 'Charged on the commitment at the funding date.',
        },
        {
          key: 'exitFeePercent',
          label: 'Exit',
          kind: 'percent',
          validate: mustBeRate({ max: 1 }),
          help: 'Charged on the amount repaid at maturity or on sale.',
        },
        {
          key: 'unusedFeePercent',
          label: 'Unused',
          kind: 'percent',
          validate: mustBeRate({ max: 1 }),
          help: 'Charged on the undrawn part of the commitment.',
        },
      ],
    },
    {
      title: 'Covenants',
      description:
        'Each is tested every period and reported as a breach. Leave one blank if the facility does not carry it — the engine does not test what is not set.',
      fields: [
        {
          key: 'minimumDscr',
          label: 'Minimum DSCR',
          kind: 'decimal',
          validate: mustBeNumber({ min: 0, label: 'DSCR' }),
          help: 'Net operating income over debt service. A ratio, not a fraction: 1.20, not 0.012.',
        },
        {
          key: 'maximumLtv',
          label: 'Maximum LTV',
          kind: 'percent',
          validate: mustBeRate({ max: 1 }),
        },
        {
          key: 'maximumLtc',
          label: 'Maximum LTC',
          kind: 'percent',
          validate: mustBeRate({ max: 1 }),
        },
        {
          key: 'minimumDebtYield',
          label: 'Minimum debt yield',
          kind: 'percent',
          validate: mustBeRate({ max: 1 }),
        },
      ],
    },
  ],
  summary: (record) => {
    const commitment = Number(readPath(record, 'commitment') ?? 0);
    const initial = Number(readPath(record, 'initialFunding') ?? 0);
    const term = Number(readPath(record, 'termMonths') ?? 0);
    const io = Number(readPath(record, 'interestOnlyMonths') ?? 0);
    const amort = Number(readPath(record, 'amortizationMonths') ?? 0);
    const rate = isFloating(record)
      ? Number(readPath(record, 'spread') ?? 0)
      : Number(readPath(record, 'fixedRate') ?? 0);

    const rows: Array<{ label: string; value: string; note?: string }> = [
      {
        label: 'Rate',
        value: isFloating(record)
          ? `index + ${(rate * 100).toFixed(2)}%`
          : `${(rate * 100).toFixed(2)}% fixed`,
      },
      {
        label: 'First-year interest',
        value: (initial * (isFloating(record) ? rate : rate)).toFixed(0),
        note: isFloating(record)
          ? 'Spread only — the index is not read here.'
          : 'On the initial funding, before any amortisation.',
      },
      {
        label: 'Structure',
        value:
          amort === 0
            ? `${term} months, interest only`
            : io === 0
              ? `${term} months, amortising over ${amort}`
              : `${io} months interest only, then amortising over ${amort}`,
      },
    ];

    if (initial > commitment && commitment > 0) {
      rows.push({
        label: 'Check',
        value: 'Initial funding exceeds the commitment',
        note: 'The engine will draw the commitment; the excess is ignored.',
      });
    }
    if (amort > 0 && io + amort < term) {
      rows.push({
        label: 'Check',
        value: 'Amortises to zero before maturity',
        note: `Interest-only plus amortisation is ${io + amort} months against a ${term}-month term.`,
      });
    }
    return rows;
  },
};

/* -------------------------------------------------------------------------- */

export const RECORD_SPECS: Record<string, RecordSpec> = {
  expenses: EXPENSE_SPEC,
  'market-leasing': MARKET_LEASING_SPEC,
  debt: DEBT_SPEC,
};
