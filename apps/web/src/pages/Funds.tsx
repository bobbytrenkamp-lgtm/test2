import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { EmptyState, ErrorMessage, Field, Loading, Metric } from '../components.js';
import { formatCurrency, formatDate, formatMultiple, formatPercent } from '../format.js';
import { useMutation, useResource, useUnsavedChangesWarning, type Resource } from '../hooks.js';
import { useSession } from '../session.js';

/**
 * Funds: commitments, capital called, distributions and what they add up to.
 *
 * The screen is organised around the question an investor actually asks — how
 * much of my commitment is drawn, how much has come back, and what rate does
 * that imply — rather than around the tables the data happens to live in.
 */

interface FundRow {
  id: string;
  name: string;
  vintage_year: number | null;
  currency: string;
  portfolio_id: string | null;
  investor_count: number;
  total_commitment: string;
}

interface InvestorRow {
  id: string;
  code: string;
  name: string;
  investor_class: string;
  commitment: string;
  version: number;
}

interface TransactionRow {
  id: string;
  transaction_date: string;
  type: string;
  amount: string;
  recallable: boolean;
  investor_code: string;
  investor_name: string;
  reference: string | null;
}

type WaterfallTierType =
  'return_of_capital' | 'preferred_return' | 'irr_hurdle' | 'catch_up' | 'residual_split';

const TIER_TYPE_LABEL: Record<WaterfallTierType, string> = {
  return_of_capital: 'Return of capital',
  preferred_return: 'Preferred return',
  irr_hurdle: 'IRR hurdle',
  catch_up: 'GP catch-up',
  residual_split: 'Residual split',
};

interface WaterfallSplit {
  partnerId: string;
  share: string;
}

interface WaterfallTier {
  id: string;
  name: string;
  type: WaterfallTierType;
  hurdleRate: string | null;
  compounding: boolean;
  catchUpTargetShare: string | null;
  splits: WaterfallSplit[];
}

interface WaterfallTiersResponse {
  tiers: WaterfallTier[];
  version: number;
}

interface WaterfallAllocation {
  investorId: string;
  investorName: string;
  byTier: Array<{ tierId: string; tierName: string; amount: string }>;
  total: string;
}

interface WaterfallProposal {
  distributionDate: string;
  distributableAmount: string;
  allocations: WaterfallAllocation[];
}

interface Position {
  investorId: string;
  investorCode: string;
  investorName: string;
  investorClass: string;
  commitment: string;
  contributed: string;
  unfunded: string;
  percentCalled: string | null;
  distributed: string;
  recalled: string;
  recallableOutstanding: string;
  netAssetValue: string;
  dpi: string | null;
  rvpi: string | null;
  tvpi: string | null;
  netIrr: string | null;
}

interface SummaryResponse {
  fund: { id: string; name: string; currency: string; vintageYear: number | null };
  valuationDate: string;
  residualBasis: string;
  summary: {
    investorCount: number;
    totalCommitment: string;
    totalContributed: string;
    totalUnfunded: string;
    totalDistributed: string;
    totalRecalled: string;
    totalRecallableOutstanding: string;
    netAssetValue: string;
    percentCalled: string | null;
    dpi: string | null;
    rvpi: string | null;
    tvpi: string | null;
    netIrr: string | null;
    positions: Position[];
    cashFlows: Array<{ date: string; amount: string; label: string }>;
  };
}

function movementLabel(entry: { type: string; recallable: boolean }): string {
  if (entry.type === 'contribution') return 'Capital call';
  if (entry.type === 'recall') return 'Recall';
  return entry.recallable ? 'Distribution (recallable)' : 'Distribution';
}

export function FundsPage(): JSX.Element {
  const { can } = useSession();
  const funds = useResource<{ funds: FundRow[] }>('/funds');
  const [selected, setSelected] = useState<string | null>(null);

  const fund = funds.data?.funds.find((entry) => entry.id === selected) ?? null;

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Funds</h1>
          <p>
            A fund&rsquo;s return is solved from its own dated cash flows, never averaged from the
            assets it holds. Unrealised value comes from the roll-up of the portfolio the fund
            holds, so the two cannot disagree about what the same assets are worth.
          </p>
        </div>
      </div>

      <ErrorMessage error={funds.error} />
      {funds.loading && <Loading label="Loading funds" />}

      {funds.data && funds.data.funds.length === 0 && (
        <EmptyState title="No funds">
          A fund records who committed capital, what has been called and what has been returned.
          Create one to report investor positions.
        </EmptyState>
      )}

      {funds.data && funds.data.funds.length > 0 && (
        <div className="card">
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">Funds</caption>
              <thead>
                <tr>
                  <th scope="col">Fund</th>
                  <th scope="col">Vintage</th>
                  <th scope="col" className="numeric">
                    Investors
                  </th>
                  <th scope="col" className="numeric">
                    Committed
                  </th>
                  <th scope="col">Position</th>
                </tr>
              </thead>
              <tbody>
                {funds.data.funds.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{entry.name}</th>
                    <td>{entry.vintage_year ?? '—'}</td>
                    <td className="numeric">{entry.investor_count}</td>
                    <td className="numeric">
                      {formatCurrency(entry.total_commitment, entry.currency, { compact: true })}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="subtle"
                        onClick={() => setSelected(entry.id)}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {fund && (
        <FundDetail
          fund={fund}
          editable={can('portfolio:write')}
          onChanged={() => funds.reload()}
        />
      )}
    </>
  );
}

function FundDetail({
  fund,
  editable,
  onChanged,
}: {
  fund: FundRow;
  editable: boolean;
  onChanged: () => void;
}): JSX.Element {
  // Defaults to today, and is editable so a report can be reproduced at the
  // date it was written rather than drifting each time it is opened.
  const [valuationDate, setValuationDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reloadKey, setReloadKey] = useState(0);

  const summary = useResource<SummaryResponse>(
    `/funds/${fund.id}/summary?valuationDate=${valuationDate}`,
    [fund.id, valuationDate, reloadKey],
  );
  const investors = useResource<{ investors: InvestorRow[] }>(`/funds/${fund.id}/investors`, [
    fund.id,
    reloadKey,
  ]);
  const transactions = useResource<{ transactions: TransactionRow[] }>(
    `/funds/${fund.id}/transactions`,
    [fund.id, reloadKey],
  );

  function refresh(): void {
    setReloadKey((key) => key + 1);
    onChanged();
  }

  const currency = fund.currency;
  const position = summary.data?.summary;

  return (
    <>
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{fund.name}</h2>
          <div className="spacer" />
          <Field label="Valued at" hint="Unrealised value is treated as received on this date.">
            <input
              type="date"
              value={valuationDate}
              onChange={(event) => setValuationDate(event.target.value)}
            />
          </Field>
        </div>

        <ErrorMessage error={summary.error} />
        {summary.loading && <Loading label="Loading the fund position" />}

        {position && (
          <>
            <dl className="metric-grid">
              <Metric
                label="Committed"
                value={formatCurrency(position.totalCommitment, currency, { compact: true })}
                note={`${position.investorCount} investor${position.investorCount === 1 ? '' : 's'}`}
              />
              <Metric
                label="Called"
                value={formatCurrency(position.totalContributed, currency, { compact: true })}
                note={`${formatPercent(position.percentCalled)} of commitments`}
              />
              <Metric
                label="Unfunded"
                value={formatCurrency(position.totalUnfunded, currency, { compact: true })}
                note="Committed but not yet drawn"
              />
              <Metric
                label="Distributed"
                value={formatCurrency(position.totalDistributed, currency, { compact: true })}
                note={`DPI ${formatMultiple(position.dpi)}`}
              />
              <Metric
                label="Recallable outstanding"
                value={formatCurrency(position.totalRecallableOutstanding, currency, {
                  compact: true,
                })}
                note="Recall right still live; already counted inside distributed"
              />
              <Metric
                label="Unrealised value"
                value={formatCurrency(position.netAssetValue, currency, { compact: true })}
                note={`RVPI ${formatMultiple(position.rvpi)}`}
              />
              <Metric
                label="Total value"
                value={formatMultiple(position.tvpi)}
                note="Distributed plus unrealised, over called"
              />
              <Metric
                label="Net IRR"
                value={formatPercent(position.netIrr)}
                note="Solved from the fund's own dated flows"
              />
            </dl>

            {/* Where the unrealised figure came from. A residual value with no
                stated basis is the one number in a fund report nobody can
                check, so the sentence the API returns is shown rather than
                summarised. */}
            <p className="field-hint">{summary.data?.residualBasis}</p>
          </>
        )}
      </div>

      {position && position.positions.length > 0 && (
        <div className="card">
          <h2>Investor positions</h2>
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">
                Investor positions in {fund.name} at {formatDate(valuationDate)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Investor</th>
                  <th scope="col">Class</th>
                  <th scope="col" className="numeric">
                    Committed
                  </th>
                  <th scope="col" className="numeric">
                    Called
                  </th>
                  <th scope="col" className="numeric">
                    Unfunded
                  </th>
                  <th scope="col" className="numeric">
                    Distributed
                  </th>
                  <th scope="col" className="numeric">
                    Recallable outstanding
                  </th>
                  <th scope="col" className="numeric">
                    Unrealised
                  </th>
                  <th scope="col" className="numeric">
                    DPI
                  </th>
                  <th scope="col" className="numeric">
                    TVPI
                  </th>
                  <th scope="col" className="numeric">
                    Net IRR
                  </th>
                </tr>
              </thead>
              <tbody>
                {position.positions.map((entry) => (
                  <tr key={entry.investorId}>
                    <th scope="row">{entry.investorName}</th>
                    <td>{entry.investorClass.toUpperCase()}</td>
                    <td className="numeric">{formatCurrency(entry.commitment, currency)}</td>
                    <td className="numeric">{formatCurrency(entry.contributed, currency)}</td>
                    <td className="numeric">{formatCurrency(entry.unfunded, currency)}</td>
                    <td className="numeric">{formatCurrency(entry.distributed, currency)}</td>
                    <td className="numeric">
                      {formatCurrency(entry.recallableOutstanding, currency)}
                    </td>
                    <td className="numeric">{formatCurrency(entry.netAssetValue, currency)}</td>
                    <td className="numeric">{formatMultiple(entry.dpi)}</td>
                    <td className="numeric">{formatMultiple(entry.tvpi)}</td>
                    <td className="numeric">{formatPercent(entry.netIrr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editable && (
        <>
          <InvestorForm
            fundId={fund.id}
            investors={investors.data?.investors ?? []}
            onSaved={refresh}
          />
          <TransactionForm
            fundId={fund.id}
            investors={investors.data?.investors ?? []}
            currency={currency}
            onSaved={refresh}
          />
          <WaterfallSection
            fundId={fund.id}
            investors={investors.data?.investors ?? []}
            currency={currency}
            onApplied={refresh}
          />
        </>
      )}

      {transactions.data && transactions.data.transactions.length > 0 && (
        <div className="card">
          <h2>Capital record</h2>
          <p className="field-hint" style={{ marginTop: 0 }}>
            Every call and distribution, in the order they happened. These are the flows the net IRR
            above is solved from.
          </p>
          <div className="table-scroll" tabIndex={0} style={{ maxHeight: 340 }}>
            <table>
              <caption className="visually-hidden">Capital calls and distributions</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Investor</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="numeric">
                    Amount
                  </th>
                  <th scope="col">Reference</th>
                </tr>
              </thead>
              <tbody>
                {transactions.data.transactions.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{formatDate(entry.transaction_date)}</th>
                    <td>{entry.investor_name}</td>
                    <td>{movementLabel(entry)}</td>
                    <td
                      className={`numeric ${entry.type === 'contribution' || entry.type === 'recall' ? 'negative' : ''}`}
                    >
                      {formatCurrency(entry.amount, currency)}
                    </td>
                    <td>{entry.reference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function InvestorForm({
  fundId,
  investors,
  onSaved,
}: {
  fundId: string;
  investors: InvestorRow[];
  onSaved: () => void;
}): JSX.Element {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [investorClass, setInvestorClass] = useState('lp');
  const [commitment, setCommitment] = useState('');

  const existing = investors.find((entry) => entry.code === code.trim());

  const save = useMutation(async () =>
    api.put(`/funds/${fundId}/investors/${encodeURIComponent(code.trim())}`, {
      name,
      investorClass,
      commitment,
      // The version this screen last read. Null for an investor that does not
      // exist yet, which nobody can have changed.
      expectedVersion: existing?.version ?? null,
    }),
  );

  const [showProblems, setShowProblems] = useState(false);
  const problems = {
    code: code.trim() ? undefined : 'Investor reference is required.',
    name: name.trim() ? undefined : 'Name is required.',
    commitment: commitment.trim() ? undefined : 'Commitment is required.',
  };

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (Object.values(problems).some(Boolean)) {
      setShowProblems(true);
      return;
    }
    if (await save.run()) {
      setCode('');
      setName('');
      setCommitment('');
      onSaved();
    }
  }

  return (
    <form className="card" onSubmit={submit} noValidate>
      <h2>Add or update an investor</h2>
      {save.error?.status === 409 ? (
        <div className="message error" role="alert">
          <strong>{save.error.message}</strong>
          <p style={{ marginBottom: 0 }}>
            Nothing has been saved. Reload and reapply your change; saving over theirs would discard
            a commitment you cannot see from here.
          </p>
        </div>
      ) : (
        <ErrorMessage error={save.error} />
      )}

      <div className="form-grid">
        <Field
          label="Investor reference"
          hint="Stable identifier used in reports."
          {...(showProblems && problems.code ? { error: problems.code } : {})}
        >
          <input maxLength={60} value={code} onChange={(event) => setCode(event.target.value)} />
        </Field>
        <Field label="Name" {...(showProblems && problems.name ? { error: problems.name } : {})}>
          <input maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Class">
          <select value={investorClass} onChange={(event) => setInvestorClass(event.target.value)}>
            <option value="lp">Limited partner</option>
            <option value="gp">General partner</option>
          </select>
        </Field>
        <Field
          label="Commitment"
          hint="Total capital committed, in the fund's currency."
          {...(showProblems && problems.commitment ? { error: problems.commitment } : {})}
        >
          <input
            inputMode="decimal"
            value={commitment}
            onChange={(event) => setCommitment(event.target.value)}
          />
        </Field>
      </div>

      <button type="submit" className="primary" disabled={save.pending}>
        {save.pending ? 'Saving…' : existing ? 'Update investor' : 'Add investor'}
      </button>
    </form>
  );
}

function TransactionForm({
  fundId,
  investors,
  currency,
  onSaved,
}: {
  fundId: string;
  investors: InvestorRow[];
  currency: string;
  onSaved: () => void;
}): JSX.Element {
  const [investorCode, setInvestorCode] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [type, setType] = useState('contribution');
  const [amount, setAmount] = useState('');
  const [recallable, setRecallable] = useState(false);
  const [reference, setReference] = useState('');

  const save = useMutation(async () =>
    api.post(`/funds/${fundId}/transactions`, {
      investorCode,
      date,
      type,
      amount,
      recallable,
      reference: reference || null,
    }),
  );

  const [showProblems, setShowProblems] = useState(false);
  const problems = {
    investorCode: investorCode ? undefined : 'Choose an investor.',
    date: date ? undefined : 'Date is required.',
    amount: amount.trim() ? undefined : 'Amount is required.',
  };

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (Object.values(problems).some(Boolean)) {
      setShowProblems(true);
      return;
    }
    if (await save.run()) {
      setAmount('');
      setReference('');
      onSaved();
    }
  }

  if (investors.length === 0) {
    return (
      <div className="card">
        <h2>Record capital</h2>
        <EmptyState title="No investors yet">
          Capital is always recorded against an investor, so add one first. A transaction with
          nobody to attribute it to would leave the fund&rsquo;s records disagreeing with its
          bank&rsquo;s.
        </EmptyState>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit} noValidate>
      <h2>Record capital</h2>
      <p className="field-hint" style={{ marginTop: 0 }}>
        Amounts are always positive. Whether money is going out or coming back is decided by the
        type, so a mistyped sign cannot turn a call into a distribution.
      </p>
      <ErrorMessage error={save.error} />

      <div className="form-grid">
        <Field
          label="Investor"
          {...(showProblems && problems.investorCode ? { error: problems.investorCode } : {})}
        >
          <select value={investorCode} onChange={(event) => setInvestorCode(event.target.value)}>
            <option value="">Choose an investor</option>
            {investors.map((investor) => (
              <option key={investor.id} value={investor.code}>
                {investor.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Type">
          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="contribution">Capital call</option>
            <option value="distribution">Distribution</option>
            <option value="recall">Recall</option>
          </select>
        </Field>
        <Field label="Date" {...(showProblems && problems.date ? { error: problems.date } : {})}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <Field
          label={`Amount (${currency})`}
          {...(showProblems && problems.amount ? { error: problems.amount } : {})}
        >
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label="Reference" hint="Optional. The notice or wire reference.">
          <input
            maxLength={120}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </Field>
      </div>

      {type === 'distribution' && (
        <label className="row" style={{ gap: 6, fontSize: 13, marginTop: 12 }}>
          <input
            type="checkbox"
            checked={recallable}
            onChange={(event) => setRecallable(event.target.checked)}
          />
          The governing document lets the GP draw this back later
        </label>
      )}

      <button type="submit" className="primary" style={{ marginTop: 12 }} disabled={save.pending}>
        {save.pending ? 'Recording…' : 'Record'}
      </button>
    </form>
  );
}

function newTierId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tier-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function blankTier(): WaterfallTier {
  return {
    id: newTierId(),
    name: '',
    type: 'return_of_capital',
    hurdleRate: null,
    compounding: true,
    catchUpTargetShare: null,
    splits: [],
  };
}

function blankSplit(): WaterfallSplit {
  return { partnerId: '', share: '' };
}

const USES_HURDLE_RATE = new Set<WaterfallTierType>(['preferred_return', 'irr_hurdle']);
const USES_SPLITS = new Set<WaterfallTierType>(['catch_up', 'residual_split']);

/**
 * A tier's own validation problem, or `undefined` if it is ready to save.
 *
 * Checked client-side so a GP finds a blank hurdle rate or an unassigned
 * split before the round trip, not after — the server checks the same shape
 * again regardless, since a form can always be bypassed.
 */
function tierProblem(tier: WaterfallTier): string | undefined {
  if (!tier.name.trim()) return 'Name the tier.';
  if (USES_HURDLE_RATE.has(tier.type) && !tier.hurdleRate?.trim()) {
    return 'A hurdle rate is required for this tier type.';
  }
  if (tier.type === 'catch_up' && !tier.catchUpTargetShare?.trim()) {
    return 'A catch-up target share is required.';
  }
  if (USES_SPLITS.has(tier.type)) {
    if (tier.splits.length === 0) return 'Add at least one split.';
    for (const split of tier.splits) {
      if (!split.partnerId) return 'Every split needs an investor.';
      if (!split.share.trim()) return 'Every split needs a share.';
    }
  }
  return undefined;
}

/**
 * Fund-level waterfall: the tiers a distribution is proposed against, and a
 * panel to preview and apply one.
 *
 * Order is the whole point of a tier list — the same tiers reordered pay
 * different amounts, since each tier consumes from what the one before it
 * left over. The editor keeps that order explicit (numbered, with move
 * controls) rather than letting it fall out of whatever order rows were
 * added in.
 */
function WaterfallSection({
  fundId,
  investors,
  currency,
  onApplied,
}: {
  fundId: string;
  investors: InvestorRow[];
  currency: string;
  onApplied: () => void;
}): JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const tiersResource = useResource<WaterfallTiersResponse>(`/funds/${fundId}/waterfall-tiers`, [
    fundId,
    reloadKey,
  ]);

  return (
    <>
      <WaterfallTierEditor
        investors={investors}
        tiersResource={tiersResource}
        onSaved={() => setReloadKey((key) => key + 1)}
        save={(tiers, expectedVersion) =>
          api.put<WaterfallTiersResponse>(`/funds/${fundId}/waterfall-tiers`, {
            tiers,
            expectedVersion,
          })
        }
      />
      <WaterfallDistributionPanel
        fundId={fundId}
        currency={currency}
        tiers={tiersResource.data?.tiers ?? []}
        onApplied={() => {
          setReloadKey((key) => key + 1);
          onApplied();
        }}
      />
    </>
  );
}

function WaterfallTierEditor({
  investors,
  tiersResource,
  onSaved,
  save: saveTiers,
}: {
  investors: InvestorRow[];
  tiersResource: Resource<WaterfallTiersResponse>;
  onSaved: () => void;
  save: (tiers: WaterfallTier[], expectedVersion: number | null) => Promise<WaterfallTiersResponse>;
}): JSX.Element {
  const [draft, setDraft] = useState<WaterfallTier[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesWarning(dirty);

  // Loads whatever the server holds into the editable draft — on first load,
  // and again after a successful save elsewhere changes the resource — but
  // never on a keystroke, since the draft's own state is what keystrokes
  // update.
  useEffect(() => {
    if (!tiersResource.data) return;
    setDraft(tiersResource.data.tiers);
    setVersion(tiersResource.data.version);
    setDirty(false);
    // Deps are listed deliberately; see the comment above.
  }, [tiersResource.data]);

  const save = useMutation(async () => saveTiers(draft, version));
  const [showProblems, setShowProblems] = useState(false);

  function updateTier(index: number, patch: Partial<WaterfallTier>): void {
    setDirty(true);
    setDraft((current) => current.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));
  }

  function addTier(): void {
    setDirty(true);
    setDraft((current) => [...current, blankTier()]);
  }

  function removeTier(index: number): void {
    setDirty(true);
    setDraft((current) => current.filter((_, i) => i !== index));
  }

  function moveTier(index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= draft.length) return;
    setDirty(true);
    setDraft((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved as WaterfallTier);
      return next;
    });
  }

  function addSplit(tierIndex: number): void {
    setDirty(true);
    setDraft((current) =>
      current.map((tier, i) =>
        i === tierIndex ? { ...tier, splits: [...tier.splits, blankSplit()] } : tier,
      ),
    );
  }

  function updateSplit(
    tierIndex: number,
    splitIndex: number,
    patch: Partial<WaterfallSplit>,
  ): void {
    setDirty(true);
    setDraft((current) =>
      current.map((tier, i) =>
        i === tierIndex
          ? {
              ...tier,
              splits: tier.splits.map((split, j) =>
                j === splitIndex ? { ...split, ...patch } : split,
              ),
            }
          : tier,
      ),
    );
  }

  function removeSplit(tierIndex: number, splitIndex: number): void {
    setDirty(true);
    setDraft((current) =>
      current.map((tier, i) =>
        i === tierIndex
          ? { ...tier, splits: tier.splits.filter((_, j) => j !== splitIndex) }
          : tier,
      ),
    );
  }

  const problems = draft.map(tierProblem);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (problems.some(Boolean)) {
      setShowProblems(true);
      return;
    }
    const result = await save.run();
    if (result) {
      setDirty(false);
      onSaved();
    }
  }

  if (investors.length === 0) {
    return (
      <div className="card">
        <h2>Waterfall tiers</h2>
        <EmptyState title="No investors yet">
          A tier's split names an investor, so add at least one before configuring a waterfall.
        </EmptyState>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={submit} noValidate>
      <h2>Waterfall tiers</h2>
      <p className="field-hint" style={{ marginTop: 0 }}>
        The order below is the payment order: return of capital, then a preferred return, then a GP
        catch-up, then a residual split is the usual shape, but this fund&rsquo;s own governing
        document decides it. Each tier pays what it is owed from what the tiers above it left over.
      </p>

      {save.error?.status === 409 ? (
        <div className="message error" role="alert">
          <strong>{save.error.message}</strong>
          <p style={{ marginBottom: 0 }}>
            Nothing has been saved. Reload to see the current tiers before reapplying your change.
          </p>
        </div>
      ) : (
        <ErrorMessage error={save.error} />
      )}

      {draft.length === 0 && <p className="field-hint">No tiers configured yet. Add one below.</p>}

      {draft.map((tier, index) => (
        <div
          key={tier.id}
          className="card"
          style={{ background: 'var(--surface-sunken)', marginBottom: 12 }}
        >
          <div className="row" style={{ marginBottom: 8 }}>
            <strong>Tier {index + 1}</strong>
            <div className="spacer" />
            <button
              type="button"
              className="subtle"
              disabled={index === 0}
              onClick={() => moveTier(index, -1)}
              aria-label={`Move tier ${index + 1} up`}
            >
              ↑
            </button>
            <button
              type="button"
              className="subtle"
              disabled={index === draft.length - 1}
              onClick={() => moveTier(index, 1)}
              aria-label={`Move tier ${index + 1} down`}
            >
              ↓
            </button>
            <button
              type="button"
              className="subtle"
              aria-label={`Remove tier ${index + 1}`}
              onClick={() => removeTier(index)}
            >
              Remove
            </button>
          </div>

          <div className="form-grid">
            <Field label="Name">
              <input
                value={tier.name}
                onChange={(event) => updateTier(index, { name: event.target.value })}
              />
            </Field>
            <Field label="Type">
              <select
                value={tier.type}
                onChange={(event) => {
                  // Clearing fields the new type does not use avoids a stray
                  // blank string (invalid: a decimal field is either a real
                  // number or null, never "") surviving a type change and
                  // failing validation on save for a reason no longer shown
                  // on screen.
                  const nextType = event.target.value as WaterfallTierType;
                  updateTier(index, {
                    type: nextType,
                    hurdleRate: USES_HURDLE_RATE.has(nextType) ? tier.hurdleRate : null,
                    catchUpTargetShare: nextType === 'catch_up' ? tier.catchUpTargetShare : null,
                  });
                }}
              >
                {Object.entries(TIER_TYPE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            {USES_HURDLE_RATE.has(tier.type) && (
              <>
                <Field label="Annual hurdle rate" hint="e.g. 0.08 for 8%">
                  <input
                    inputMode="decimal"
                    value={tier.hurdleRate ?? ''}
                    onChange={(event) => updateTier(index, { hurdleRate: event.target.value })}
                  />
                </Field>
                <Field label="Compounding">
                  <select
                    value={tier.compounding ? 'yes' : 'no'}
                    onChange={(event) =>
                      updateTier(index, { compounding: event.target.value === 'yes' })
                    }
                  >
                    <option value="yes">Compounding</option>
                    <option value="no">Non-compounding</option>
                  </select>
                </Field>
              </>
            )}
            {tier.type === 'catch_up' && (
              <Field label="GP catch-up target share" hint="e.g. 0.20 for 20% of profit">
                <input
                  inputMode="decimal"
                  value={tier.catchUpTargetShare ?? ''}
                  onChange={(event) =>
                    updateTier(index, { catchUpTargetShare: event.target.value })
                  }
                />
              </Field>
            )}
          </div>

          {USES_SPLITS.has(tier.type) && (
            <div style={{ marginTop: 8 }}>
              <div className="row">
                <span className="field-hint" style={{ margin: 0 }}>
                  Splits
                </span>
                <div className="spacer" />
                <button type="button" className="subtle" onClick={() => addSplit(index)}>
                  Add split
                </button>
              </div>
              {tier.splits.map((split, splitIndex) => (
                <div key={splitIndex} className="row" style={{ gap: 8, marginTop: 6 }}>
                  <select
                    aria-label={`Tier ${index + 1} split ${splitIndex + 1} investor`}
                    value={split.partnerId}
                    onChange={(event) =>
                      updateSplit(index, splitIndex, { partnerId: event.target.value })
                    }
                  >
                    <option value="">Choose an investor</option>
                    {investors.map((investor) => (
                      <option key={investor.id} value={investor.id}>
                        {investor.name}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={`Tier ${index + 1} split ${splitIndex + 1} share`}
                    inputMode="decimal"
                    style={{ maxWidth: 100 }}
                    placeholder="Share"
                    value={split.share}
                    onChange={(event) =>
                      updateSplit(index, splitIndex, { share: event.target.value })
                    }
                  />
                  <button
                    type="button"
                    className="subtle"
                    aria-label={`Remove tier ${index + 1} split ${splitIndex + 1}`}
                    onClick={() => removeSplit(index, splitIndex)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {showProblems && problems[index] && (
            <p className="field-error" role="alert">
              {problems[index]}
            </p>
          )}
        </div>
      ))}

      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="subtle" onClick={addTier}>
          Add tier
        </button>
        <div className="spacer" />
        <button type="submit" className="primary" disabled={save.pending}>
          {save.pending ? 'Saving…' : 'Save tiers'}
        </button>
      </div>
    </form>
  );
}

function WaterfallDistributionPanel({
  fundId,
  currency,
  tiers,
  onApplied,
}: {
  fundId: string;
  currency: string;
  tiers: WaterfallTier[];
  onApplied: () => void;
}): JSX.Element {
  const [distributionDate, setDistributionDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [distributableAmount, setDistributableAmount] = useState('');
  const [proposal, setProposal] = useState<WaterfallProposal | null>(null);

  const preview = useMutation(async () =>
    api.post<{ proposal: WaterfallProposal }>(`/funds/${fundId}/waterfall/preview`, {
      distributionDate,
      distributableAmount,
    }),
  );
  const apply = useMutation(async () =>
    api.post<{ transactions: unknown[]; proposal: WaterfallProposal }>(
      `/funds/${fundId}/waterfall/apply`,
      { distributionDate, distributableAmount },
    ),
  );

  function clearProposal(): void {
    setProposal(null);
    apply.clearError();
  }

  async function runPreview(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const result = await preview.run();
    if (result) setProposal(result.proposal);
  }

  async function runApply(): Promise<void> {
    const result = await apply.run();
    if (result) {
      setProposal(null);
      setDistributableAmount('');
      onApplied();
    }
  }

  if (tiers.length === 0) {
    return (
      <div className="card">
        <h2>Propose a distribution</h2>
        <EmptyState title="No waterfall tiers yet">
          Add at least one tier above — typically return of capital, then a preferred return, then a
          residual split — before a distribution can be proposed.
        </EmptyState>
      </div>
    );
  }

  const payable = proposal?.allocations.filter((allocation) => Number(allocation.total) > 0) ?? [];

  return (
    <form className="card" onSubmit={runPreview} noValidate>
      <h2>Propose a distribution</h2>
      <p className="field-hint" style={{ marginTop: 0 }}>
        Preview recomputes the split from the fund&rsquo;s tiers and every transaction recorded
        before this date. Nothing is recorded until you apply it.
      </p>

      <div className="form-grid">
        <Field label="Distribution date">
          <input
            type="date"
            value={distributionDate}
            onChange={(event) => {
              setDistributionDate(event.target.value);
              clearProposal();
            }}
          />
        </Field>
        <Field label={`Distributable amount (${currency})`}>
          <input
            inputMode="decimal"
            value={distributableAmount}
            onChange={(event) => {
              setDistributableAmount(event.target.value);
              clearProposal();
            }}
          />
        </Field>
      </div>
      <ErrorMessage error={preview.error} />
      <button
        type="submit"
        className="subtle"
        disabled={preview.pending || !distributableAmount.trim()}
      >
        {preview.pending ? 'Calculating…' : 'Preview'}
      </button>

      {proposal && (
        <>
          <div className="table-scroll" tabIndex={0} style={{ marginTop: 16 }}>
            <table>
              <caption className="visually-hidden">
                Proposed distribution of {formatCurrency(proposal.distributableAmount, currency)} on{' '}
                {formatDate(proposal.distributionDate)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Investor</th>
                  <th scope="col">By tier</th>
                  <th scope="col" className="numeric">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {payable.length === 0 && (
                  <tr>
                    <td colSpan={3}>This distribution would pay nobody.</td>
                  </tr>
                )}
                {payable.map((allocation) => (
                  <tr key={allocation.investorId}>
                    <th scope="row">{allocation.investorName}</th>
                    <td>
                      {allocation.byTier
                        .map(
                          (entry) => `${entry.tierName}: ${formatCurrency(entry.amount, currency)}`,
                        )
                        .join(', ')}
                    </td>
                    <td className="numeric">{formatCurrency(allocation.total, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ErrorMessage error={apply.error} />
          <button
            type="button"
            className="primary"
            style={{ marginTop: 12 }}
            disabled={apply.pending || payable.length === 0}
            onClick={runApply}
          >
            {apply.pending
              ? 'Recording…'
              : `Apply: record ${payable.length} distribution${payable.length === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    </form>
  );
}
