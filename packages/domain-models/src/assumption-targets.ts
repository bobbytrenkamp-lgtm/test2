import type { AssumptionValueType } from './assumption-proposals.js';

/**
 * The single list of assumptions this platform can write through the
 * assumption-proposal safety boundary — model-level valuation and vacancy
 * inputs, and the scalar fields of the six model-scoped collections.
 *
 * This is the target dictionary an external system (a market-data feed, an
 * import from a PDF extraction) needs in order to address a real field, and
 * it is also — the same array, not a second one — what the proposal decision
 * route consults to know whether accepting a proposal can write anything at
 * all. A target that appears here is writable by construction; there is no
 * second "is this actually writable" check to fall out of sync with this
 * one.
 *
 * ## Why not derive this purely from the zod schemas
 *
 * `packages/domain-models/src/model-input.ts` already defines every one of
 * these fields with its real type, and introspecting those schemas at
 * runtime was the first design considered. It was dropped for two reasons:
 *
 * - Several fields that exist on the model input are not safe to
 *   single-value overwrite — `rentSteps`, `escalation`, `draws`, `cashTrap`
 *   are structured objects a decimal or a date cannot express, and a
 *   generic introspector would need exactly this list to know which fields
 *   to skip, which is the list this file already is.
 * - A human label ("Exit capitalization rate") and a presentation unit
 *   ("rate" vs "currency" vs "months") are not recoverable from a zod type
 *   at all; they are product decisions, not type information.
 *
 * So this stays a hand-written list — but a single one. Every field on it is
 * checked against the real collection schemas by
 * `assumption-targets.test.ts`, which fails the moment this file and
 * `model-input.ts` disagree about a field's existence or its shape. That is
 * what keeps "hand-written" from becoming "silently drifted": the list can
 * be wrong for a day, never for a release.
 */

export type AssumptionUnit =
  'rate' | 'currency' | 'area' | 'months' | 'count' | 'multiple' | 'text';

/** One writable field, addressed the way this file's own doc comment does. */
export interface TargetDescriptor {
  /** The field name inside its section or collection, e.g. `terminalCapRate`. */
  field: string;
  label: string;
  valueType: AssumptionValueType;
  unit?: AssumptionUnit;
  /** Present when `valueType` is `enum`. */
  enumValues?: readonly string[];
}

export interface CollectionDescriptor {
  /** The contract's name for the collection, e.g. `marketLeasing`. */
  collection: string;
  /** Singular noun for messages: "a market leasing profile". */
  noun: string;
  fields: readonly TargetDescriptor[];
}

/** `valuation.<field>`. */
export const VALUATION_TARGETS: readonly TargetDescriptor[] = [
  { field: 'discountRate', label: 'Discount rate', valueType: 'decimal', unit: 'rate' },
  {
    field: 'discountingConvention',
    label: 'Discounting convention',
    valueType: 'enum',
    enumValues: ['end_of_period', 'mid_period'],
  },
  {
    field: 'terminalCapRate',
    label: 'Exit capitalization rate',
    valueType: 'decimal',
    unit: 'rate',
  },
  {
    field: 'terminalNoiBasis',
    label: 'Terminal NOI basis',
    valueType: 'enum',
    enumValues: ['forward_12', 'trailing_12'],
  },
  { field: 'saleCostPercent', label: 'Sale cost', valueType: 'decimal', unit: 'rate' },
  { field: 'saleMonth', label: 'Sale month', valueType: 'integer', unit: 'months' },
  {
    field: 'grossSalePriceOverride',
    label: 'Gross sale price override',
    valueType: 'decimal',
    unit: 'currency',
  },
  {
    field: 'directCapRate',
    label: 'Direct capitalization rate',
    valueType: 'decimal',
    unit: 'rate',
  },
  {
    field: 'directCapNoiBasis',
    label: 'Direct capitalization NOI basis',
    valueType: 'enum',
    enumValues: ['year_1', 'stabilized', 'trailing_12'],
  },
  {
    field: 'directCapAdjustments',
    label: 'Direct capitalization adjustments',
    valueType: 'decimal',
    unit: 'rate',
  },
  {
    field: 'acquisitionPrice',
    label: 'Acquisition price',
    valueType: 'decimal',
    unit: 'currency',
  },
  {
    field: 'acquisitionCosts',
    label: 'Acquisition costs',
    valueType: 'decimal',
    unit: 'currency',
  },
  { field: 'acquisitionDate', label: 'Acquisition date', valueType: 'date' },
];

/** `vacancy.<field>`. */
export const VACANCY_TARGETS: readonly TargetDescriptor[] = [
  {
    field: 'generalVacancyRate',
    label: 'General vacancy rate',
    valueType: 'decimal',
    unit: 'rate',
  },
  {
    field: 'netAgainstModelledVacancy',
    label: 'Net against modelled vacancy',
    valueType: 'boolean',
  },
  { field: 'creditLossRate', label: 'Credit loss rate', valueType: 'decimal', unit: 'rate' },
];

/** `<collection>.<code>.<field>`. */
export const COLLECTIONS: readonly CollectionDescriptor[] = [
  {
    collection: 'expenses',
    noun: 'an operating expense',
    fields: [
      { field: 'category', label: 'Category', valueType: 'string' },
      { field: 'accountCode', label: 'Account code', valueType: 'string' },
      {
        field: 'method',
        label: 'Method',
        valueType: 'enum',
        enumValues: [
          'fixed_annual',
          'per_area_per_year',
          'per_unit_per_year',
          'percent_of_effective_gross_revenue',
          'percent_of_base_rent',
          'custom_monthly_schedule',
        ],
      },
      { field: 'amount', label: 'Amount', valueType: 'decimal', unit: 'currency' },
      {
        field: 'recoverableShare',
        label: 'Recoverable share',
        valueType: 'decimal',
        unit: 'rate',
      },
      { field: 'variableShare', label: 'Variable share', valueType: 'decimal', unit: 'rate' },
      { field: 'isCapitalized', label: 'Capitalized', valueType: 'boolean' },
    ],
  },
  {
    collection: 'otherRevenue',
    noun: 'an other-revenue item',
    fields: [
      { field: 'category', label: 'Category', valueType: 'string' },
      {
        field: 'method',
        label: 'Method',
        valueType: 'enum',
        enumValues: [
          'fixed_annual',
          'per_unit_per_month',
          'per_area_per_year',
          'percent_of_base_rent',
          'custom_monthly_schedule',
        ],
      },
      { field: 'amount', label: 'Amount', valueType: 'decimal', unit: 'currency' },
      { field: 'varyWithOccupancy', label: 'Varies with occupancy', valueType: 'boolean' },
    ],
  },
  {
    collection: 'capital',
    noun: 'a capital item',
    fields: [
      {
        field: 'category',
        label: 'Category',
        valueType: 'enum',
        enumValues: [
          'recurring_capital',
          'replacement_reserve',
          'major_project',
          'building_improvement',
          'deferred_maintenance',
          'development_hard_cost',
          'development_soft_cost',
          'contingency',
          'other',
        ],
      },
      {
        field: 'method',
        label: 'Method',
        valueType: 'enum',
        enumValues: [
          'fixed_annual',
          'per_area_per_year',
          'per_unit_per_year',
          'custom_monthly_schedule',
          'one_time',
        ],
      },
      { field: 'amount', label: 'Amount', valueType: 'decimal', unit: 'currency' },
      { field: 'startDate', label: 'Start date', valueType: 'date' },
      { field: 'endDate', label: 'End date', valueType: 'date' },
      { field: 'capitalized', label: 'Capitalized', valueType: 'boolean' },
      { field: 'fundingSource', label: 'Funding source', valueType: 'string' },
    ],
  },
  {
    collection: 'debt',
    noun: 'a debt facility',
    fields: [
      {
        field: 'type',
        label: 'Facility type',
        valueType: 'enum',
        enumValues: [
          'acquisition',
          'permanent',
          'construction',
          'bridge',
          'revolver',
          'mezzanine',
          'preferred_equity',
          'seller_financing',
          'supplemental',
        ],
      },
      { field: 'commitment', label: 'Commitment', valueType: 'decimal', unit: 'currency' },
      {
        field: 'initialFunding',
        label: 'Initial funding',
        valueType: 'decimal',
        unit: 'currency',
      },
      { field: 'fundingDate', label: 'Funding date', valueType: 'date' },
      {
        field: 'rateType',
        label: 'Rate type',
        valueType: 'enum',
        enumValues: ['fixed', 'floating'],
      },
      { field: 'fixedRate', label: 'Fixed rate', valueType: 'decimal', unit: 'rate' },
      { field: 'spread', label: 'Spread', valueType: 'decimal', unit: 'rate' },
      { field: 'rateFloor', label: 'Rate floor', valueType: 'decimal', unit: 'rate' },
      { field: 'rateCap', label: 'Rate cap', valueType: 'decimal', unit: 'rate' },
      {
        field: 'interestOnlyMonths',
        label: 'Interest-only period',
        valueType: 'integer',
        unit: 'months',
      },
      {
        field: 'amortizationMonths',
        label: 'Amortization period',
        valueType: 'integer',
        unit: 'months',
      },
      { field: 'termMonths', label: 'Term', valueType: 'integer', unit: 'months' },
      {
        field: 'originationFeePercent',
        label: 'Origination fee',
        valueType: 'decimal',
        unit: 'rate',
      },
      { field: 'exitFeePercent', label: 'Exit fee', valueType: 'decimal', unit: 'rate' },
      { field: 'unusedFeePercent', label: 'Unused fee', valueType: 'decimal', unit: 'rate' },
      { field: 'capitalizeInterest', label: 'Capitalize interest', valueType: 'boolean' },
      {
        field: 'minimumDscr',
        label: 'Minimum DSCR covenant',
        valueType: 'decimal',
        unit: 'multiple',
      },
      { field: 'maximumLtv', label: 'Maximum LTV covenant', valueType: 'decimal', unit: 'rate' },
      { field: 'maximumLtc', label: 'Maximum LTC covenant', valueType: 'decimal', unit: 'rate' },
      {
        field: 'minimumDebtYield',
        label: 'Minimum debt yield covenant',
        valueType: 'decimal',
        unit: 'rate',
      },
      { field: 'repayOnSale', label: 'Repaid on sale', valueType: 'boolean' },
    ],
  },
  {
    collection: 'marketLeasing',
    noun: 'a market leasing profile',
    fields: [
      { field: 'marketRent', label: 'Market rent', valueType: 'decimal', unit: 'currency' },
      {
        field: 'marketRentBasis',
        label: 'Market rent basis',
        valueType: 'enum',
        enumValues: [
          'per_area_per_year',
          'per_area_per_month',
          'annual_amount',
          'monthly_amount',
          'per_unit_per_month',
        ],
      },
      {
        field: 'renewalProbability',
        label: 'Renewal probability',
        valueType: 'decimal',
        unit: 'rate',
      },
      {
        field: 'renewalTermMonths',
        label: 'Renewal term',
        valueType: 'integer',
        unit: 'months',
      },
      {
        field: 'newLeaseTermMonths',
        label: 'New-lease term',
        valueType: 'integer',
        unit: 'months',
      },
      { field: 'downtimeMonths', label: 'Downtime', valueType: 'integer', unit: 'months' },
      {
        field: 'renewalFreeRentMonths',
        label: 'Renewal free rent',
        valueType: 'integer',
        unit: 'months',
      },
      {
        field: 'newFreeRentMonths',
        label: 'New-lease free rent',
        valueType: 'integer',
        unit: 'months',
      },
      {
        field: 'renewalTiPerArea',
        label: 'Renewal tenant improvements',
        valueType: 'decimal',
        unit: 'currency',
      },
      {
        field: 'newTiPerArea',
        label: 'New-lease tenant improvements',
        valueType: 'decimal',
        unit: 'currency',
      },
      {
        field: 'renewalLcPercent',
        label: 'Renewal leasing commission',
        valueType: 'decimal',
        unit: 'rate',
      },
      {
        field: 'newLcPercent',
        label: 'New-lease leasing commission',
        valueType: 'decimal',
        unit: 'rate',
      },
      { field: 'precedence', label: 'Precedence', valueType: 'integer', unit: 'count' },
    ],
  },
  {
    collection: 'growthCurves',
    noun: 'a growth curve',
    fields: [
      { field: 'defaultRate', label: 'Default growth rate', valueType: 'decimal', unit: 'rate' },
    ],
  },
];

/** Model-level sections a target may address, keyed by their contract prefix. */
export const MODEL_SECTIONS: Readonly<Record<string, readonly TargetDescriptor[]>> = {
  valuation: VALUATION_TARGETS,
  vacancy: VACANCY_TARGETS,
};

export const COLLECTIONS_BY_NAME: Readonly<Record<string, CollectionDescriptor>> =
  Object.fromEntries(COLLECTIONS.map((entry) => [entry.collection, entry]));

export type TargetVerdict =
  | { ok: true; descriptor: TargetDescriptor; collection?: string; code?: string }
  | { ok: false; reason: string };

/**
 * Resolves a dotted target to the descriptor that would let something write
 * it, or explains why nothing can.
 *
 * Shared by the assumption-proposal decision route (can this be applied at
 * all) and the import analyzer (what type and label does the reviewer see) —
 * one function, so the two can never answer that question differently.
 */
export function describeTarget(target: string): TargetVerdict {
  const parts = target.split('.');
  const head = parts[0] ?? '';

  if (parts.length === 2 && MODEL_SECTIONS[head]) {
    const field = parts[1] as string;
    const descriptor = MODEL_SECTIONS[head]?.find((entry) => entry.field === field);
    if (descriptor) return { ok: true, descriptor };
    return {
      ok: false,
      reason:
        `${target} is not one of the assumptions this contract can write in the ${head} ` +
        'section. The proposal is kept so you can act on it yourself.',
    };
  }

  if (head === 'leases') {
    return {
      ok: false,
      reason:
        'Lease terms are not applied through this contract. A lease is a document, and a ' +
        'change to one is a change to what was signed — open the rent roll and make it there. ' +
        'The proposal stays on the list either way.',
    };
  }

  if (parts.length >= 3 && COLLECTIONS_BY_NAME[head]) {
    const collectionDescriptor = COLLECTIONS_BY_NAME[head] as CollectionDescriptor;
    // `parts.slice(2).join('.')` would assume the code itself never contains
    // a dot — but a code is free-form text (`z.string().min(1)` on every
    // collection row's `id`), and a real one sometimes does ("Bldg A.Suite
    // 100", copied verbatim from a source document by an import). Field
    // names, by contrast, are a small known set with no dots in any of
    // them, so matching backward from the end against that set — rather
    // than forward from a fixed position — finds the real field, and
    // therefore the real code, regardless of what the code itself contains.
    const rest = target.slice(head.length + 1);
    const descriptor = collectionDescriptor.fields.find((entry) =>
      rest.endsWith(`.${entry.field}`),
    );
    if (descriptor) {
      const code = rest.slice(0, rest.length - descriptor.field.length - 1);
      return { ok: true, descriptor, collection: head, code };
    }
    return {
      ok: false,
      reason:
        `${target} is not one of the fields this contract can write on ${collectionDescriptor.noun}. ` +
        'The proposal is kept so you can act on it yourself.',
    };
  }

  return {
    ok: false,
    reason:
      `This release does not model ${target}, so there is nothing to apply it to. That is ` +
      'worth knowing on its own — the proposal is kept rather than discarded.',
  };
}
