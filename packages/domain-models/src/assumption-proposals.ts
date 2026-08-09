import { z } from 'zod';

/**
 * The assumption input contract.
 *
 * This is the shape an outside system writes when it wants to say something
 * about an assumption in a model — a market-data service reporting rent growth
 * for a submarket, a separate research tool with a view on exit yields, an
 * import from a valuation the firm commissioned.
 *
 * ## It is a proposal, never a value
 *
 * Nothing accepted through this contract reaches the calculation engine.
 * A proposal is stored, shown beside the assumption it concerns, and applied
 * only when an analyst decides to apply it. That is not caution about data
 * quality; it is that **the analyst is the one who has to defend the model**.
 * A number they cannot account for is worse than a number they can argue with,
 * however good its provenance.
 *
 * Rejection is recorded as a decision rather than as a deletion, because "we
 * saw the market number and stayed at 3.0%" is a defensible position and only
 * exists if the tool kept it.
 *
 * ## What is deliberately loose
 *
 * `target` and `sourceKind` are free text rather than enumerations. The set of
 * addressable assumptions is the model's own shape and grows with it, and a
 * closed list of sources would force a new one to masquerade as an old one. A
 * proposal whose target this release cannot locate is still shown to the
 * analyst — information about something the product does not yet model is
 * still information, and silently dropping it would be the worst of the
 * options.
 *
 * ## What is deliberately strict
 *
 * `value` is a **decimal string**, like every other number in this system, so a
 * rate arriving from outside cannot lose precision on its way in. `confidence`
 * is nullable rather than defaulted, because most sources cannot state one and
 * a default of 1 would assert a certainty nobody claimed. `observedAt` is
 * separate from when the proposal arrived: a March comparable is a March
 * comparable in July.
 */

/**
 * How to address an assumption.
 *
 * A dotted path in the platform's own terms. The three shapes in use:
 *
 * - `valuation.<field>` — a model-level valuation input, e.g.
 *   `valuation.terminalCapRate`, `valuation.discountRate`.
 * - `vacancy.<field>` — e.g. `vacancy.generalVacancyRate`.
 * - `<collection>.<code>.<field>` — a row of a model-scoped collection, e.g.
 *   `marketLeasing.MLA-OFF.marketRent`, `expenses.OPEX-INS.amount`,
 *   `debt.SENIOR.fixedRate`.
 *
 * The path is not validated against the model on arrival. A proposal about a
 * lease that has not been entered yet is still worth keeping, and refusing it
 * would make the contract depend on the order two systems happen to run in.
 */
export const assumptionTargetSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.\-:]+$/, 'A target is a dotted path such as valuation.terminalCapRate');

export const assumptionSourceKindEnum = z.enum([
  /** A person, typing. The default provenance of anything in a model. */
  'user',
  /** Read from a file the firm supplied — a rent roll, a valuation. */
  'imported',
  /** Derived from the property's own history. */
  'historical',
  /** An outside market-data service. */
  'market_data',
  /** Computed by another system from data it holds. */
  'calculated',
  /** An explicit recommendation, with reasoning attached. */
  'recommended',
]);
export type AssumptionSourceKind = z.infer<typeof assumptionSourceKindEnum>;

/**
 * What shape `value` is in.
 *
 * `value` itself stays a single string regardless — that is what keeps this
 * table a proposal record rather than a bag of arbitrary JSON — but a sale
 * month, a funding date and an accrual convention are not decimals, and
 * pretending they were would either reject them at the door or silently
 * mis-cast them on the way into the model. `decimal` is the default and
 * remains the overwhelming majority of proposals: rates, rents, amounts,
 * shares.
 */
export const assumptionValueTypeEnum = z.enum([
  'decimal',
  'integer',
  'date',
  'boolean',
  'string',
  'enum',
]);
export type AssumptionValueType = z.infer<typeof assumptionValueTypeEnum>;

export const assumptionProposalInputSchema = z
  .object({
    target: assumptionTargetSchema,
    /**
     * The suggested value. A decimal source may send a bare JSON number, as
     * it always could — coerced to a string so the stored column, and every
     * reader of it, only ever deals in one type. `valueType` decides which
     * shape that string has to hold; the check runs below, because it needs
     * both fields at once.
     *
     * Null for a proposal that is a remark rather than a figure — "this
     * submarket has three competing developments in planning" is worth
     * recording against the rent growth assumption without proposing a
     * number for it.
     */
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .nullish()
      .transform((v) => (v === null || v === undefined ? v : String(v))),
    valueType: assumptionValueTypeEnum.default('decimal'),
    sourceKind: assumptionSourceKindEnum,
    /** The system or person, named so a reader can weigh it. */
    sourceName: z.string().min(1).max(200),
    /** 0 to 1, when the source can state one. Absent is not zero. */
    confidence: z.number().min(0).max(1).nullish(),
    /** When the source observed this, which is not when it said so. */
    observedAt: z.string().datetime().nullish(),
    /**
     * Whatever the source wants to show its working: comparables, a sample
     * size, a methodology note. Rendered as given and never parsed for
     * meaning, so a source can put anything useful here without this
     * contract having to know about it in advance.
     */
    evidence: z.record(z.unknown()).default({}),
    notes: z.string().max(4000).nullish(),
  })
  .superRefine((proposal, ctx) => {
    if (proposal.value === null || proposal.value === undefined) return;
    const problem = validateTypedValue(proposal.value, proposal.valueType);
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: problem });
    }
  });
export type AssumptionProposalInput = z.infer<typeof assumptionProposalInputSchema>;

/**
 * Whether `raw` is a valid serialisation of `valueType`, and if not, why.
 *
 * Exported so the import analyzer can run the identical check before a value
 * ever reaches this schema — the same rule stated once, not approximated a
 * second time in the layer that produces proposals from imported data.
 *
 * Deliberately strict rather than helpful. `6.25` arriving for a `decimal`
 * rate target is refused rather than guessed at, because guessing whether
 * someone meant `6.25%` or `625%` is exactly the kind of silent error this
 * whole contract exists to prevent.
 */
export function validateTypedValue(raw: string, valueType: AssumptionValueType): string | null {
  switch (valueType) {
    case 'decimal':
      return /^-?(\d+(\.\d+)?|\.\d+)$/.test(raw)
        ? null
        : `Expected a decimal number such as "0.0625", not "${raw}".`;
    case 'integer':
      return /^-?\d+$/.test(raw) ? null : `Expected a whole number such as "60", not "${raw}".`;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? null
        : `Expected a date formatted as YYYY-MM-DD, not "${raw}".`;
    case 'boolean':
      return raw === 'true' || raw === 'false' ? null : `Expected "true" or "false", not "${raw}".`;
    case 'string':
    case 'enum':
      return raw.length > 0 && raw.length <= 200 ? null : 'Expected non-empty text.';
  }
}

/** A batch, so a source can report a whole model in one call. */
export const assumptionProposalBatchSchema = z.object({
  proposals: z.array(assumptionProposalInputSchema).min(1).max(200),
});

export const assumptionDecisionEnum = z.enum(['accepted', 'rejected']);
export type AssumptionDecision = z.infer<typeof assumptionDecisionEnum>;

/** A proposal as the platform stores and returns it. */
export interface AssumptionProposal {
  id: string;
  model_id: string;
  target: string;
  value: string | null;
  value_type: AssumptionValueType;
  source_kind: AssumptionSourceKind;
  source_name: string;
  confidence: string | null;
  observed_at: string | null;
  evidence: Record<string, unknown>;
  notes: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  /** Set when this proposal was produced by an import rather than posted directly. */
  import_session_id: string | null;
}

/**
 * The model's own value for a target, so a proposal can be shown beside it.
 *
 * Resolved from `ModelInput` rather than from the database, because the input
 * is what the engine actually reads — a comparison against anything else would
 * be a comparison with a number the model does not use.
 */
export function resolveAssumptionValue(
  input: Record<string, unknown>,
  target: string,
): string | null {
  const parts = target.split('.');
  if (parts.length < 2) return null;

  const [head, ...rest] = parts as [string, ...string[]];

  // Model-level: `valuation.terminalCapRate`, `vacancy.generalVacancyRate`.
  if (rest.length === 1) {
    const section = input[head];
    if (section && typeof section === 'object') {
      const value = (section as Record<string, unknown>)[rest[0] as string];
      return value === null || value === undefined ? null : String(value);
    }
    return null;
  }

  // Collection row: `<collection>.<code>.<field>`.
  const [code, field] = [rest[0] as string, rest.slice(1).join('.')];
  const collection = input[COLLECTION_KEYS[head] ?? head];
  if (!Array.isArray(collection)) return null;
  const row = collection.find(
    (entry) => entry && typeof entry === 'object' && (entry as { id?: string }).id === code,
  );
  if (!row) return null;
  const value = (row as Record<string, unknown>)[field];
  return value === null || value === undefined ? null : String(value);
}

/**
 * Target prefixes to the `ModelInput` array they address.
 *
 * The contract's names are the ones an analyst would use; the input's are the
 * ones the engine uses, and they are not always the same word. Mapping them
 * here keeps the contract readable without renaming anything in the engine.
 */
export const COLLECTION_KEYS: Record<string, string> = {
  marketLeasing: 'marketLeasingProfiles',
  expenses: 'expenses',
  capital: 'capital',
  debt: 'debt',
  otherRevenue: 'otherRevenue',
  growthCurves: 'growthCurves',
  leases: 'leases',
};
