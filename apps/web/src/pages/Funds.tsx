import { useState } from 'react';
import { api } from '../api.js';
import { EmptyState, ErrorMessage, Field, Loading, Metric } from '../components.js';
import { formatCurrency, formatDate, formatMultiple, formatPercent } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
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
