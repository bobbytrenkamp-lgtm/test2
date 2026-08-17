import { describe, expect, it } from 'vitest';
import { computeFund, type FundInput } from './fund.js';

/**
 * Fund-level investor economics.
 *
 * Every expected value here is derived by hand from the inputs, or recomputed
 * by a different method than the module uses. Nothing was produced by running
 * the code and copying its answer.
 */

/*
 * A two-investor fund, chosen so the arithmetic can be checked in the head.
 *
 *   Alder Pension  commits 8,000,000
 *   Brine Family   commits 2,000,000
 *   Total          10,000,000, split 80/20
 *
 * Called in two equal drawdowns of 50% of commitments, one at the start of
 * 2026 and one a year later. Distributed once, at the start of 2028.
 *
 *   Alder    contributed 4,000,000 (2,000,000 + 2,000,000), distributed 1,600,000
 *   Brine    contributed 1,000,000 (  500,000 +   500,000), distributed   400,000
 *   Fund     contributed 5,000,000,                          distributed 2,000,000
 *
 * Residual value 6,000,000 at 2029-01-01, split by contributed capital, which
 * here is the same 80/20: 4,800,000 and 1,200,000.
 */
function twoInvestorFund(): FundInput {
  return {
    investors: [
      { id: 'ALDER', name: 'Alder Pension', investorClass: 'lp', commitment: '8000000' },
      { id: 'BRINE', name: 'Brine Family Office', investorClass: 'lp', commitment: '2000000' },
    ],
    transactions: [
      { investorId: 'ALDER', date: '2026-01-01', type: 'contribution', amount: '2000000' },
      { investorId: 'BRINE', date: '2026-01-01', type: 'contribution', amount: '500000' },
      { investorId: 'ALDER', date: '2027-01-01', type: 'contribution', amount: '2000000' },
      { investorId: 'BRINE', date: '2027-01-01', type: 'contribution', amount: '500000' },
      { investorId: 'ALDER', date: '2028-01-01', type: 'distribution', amount: '1600000' },
      { investorId: 'BRINE', date: '2028-01-01', type: 'distribution', amount: '400000' },
    ],
    netAssetValue: '6000000',
    valuationDate: '2029-01-01',
  };
}

function position(summary: ReturnType<typeof computeFund>, id: string) {
  const found = summary.positions.find((entry) => entry.investorId === id);
  if (!found) throw new Error(`No position for ${id}`);
  return found;
}

describe('unfunded commitment', () => {
  it('reports what is committed but not yet called', () => {
    const summary = computeFund(twoInvestorFund());
    // 8,000,000 committed less 4,000,000 called.
    expect(position(summary, 'ALDER').unfunded).toBe('4000000');
    expect(position(summary, 'BRINE').unfunded).toBe('1000000');
    expect(summary.totalUnfunded).toBe('5000000');
  });

  it('reports the proportion called', () => {
    const summary = computeFund(twoInvestorFund());
    expect(Number(position(summary, 'ALDER').percentCalled)).toBeCloseTo(0.5, 12);
    expect(Number(summary.percentCalled)).toBeCloseTo(0.5, 12);
  });

  it('never reports a negative unfunded commitment', () => {
    // An investor called beyond its commitment has nothing left unfunded. A
    // negative figure would read as the fund owing it money, which it does not.
    const input = twoInvestorFund();
    input.transactions.push({
      investorId: 'BRINE',
      date: '2027-06-01',
      type: 'contribution',
      amount: '3000000',
    });
    const summary = computeFund(input);
    expect(position(summary, 'BRINE').contributed).toBe('4000000');
    expect(position(summary, 'BRINE').unfunded).toBe('0');
    expect(Number(position(summary, 'BRINE').percentCalled)).toBeCloseTo(2, 12);
  });

  it('treats an investor with no transactions as fully unfunded, not as missing', () => {
    const input = twoInvestorFund();
    input.investors.push({
      id: 'CEDAR',
      name: 'Cedar Trust',
      investorClass: 'lp',
      commitment: '1000000',
    });
    const summary = computeFund(input);
    const cedar = position(summary, 'CEDAR');
    expect(cedar.contributed).toBe('0');
    expect(cedar.unfunded).toBe('1000000');
    // Nothing contributed means no denominator, so a multiple would be a
    // division by zero. Null is the honest answer; zero would read as a loss.
    expect(cedar.dpi).toBeNull();
    expect(cedar.tvpi).toBeNull();
    expect(cedar.netIrr).toBeNull();
  });
});

describe('the multiples', () => {
  it('computes DPI, RVPI and TVPI from contributions', () => {
    const summary = computeFund(twoInvestorFund());
    // Fund: 2,000,000 distributed and 6,000,000 residual on 5,000,000 called.
    expect(Number(summary.dpi)).toBeCloseTo(0.4, 12);
    expect(Number(summary.rvpi)).toBeCloseTo(1.2, 12);
    expect(Number(summary.tvpi)).toBeCloseTo(1.6, 12);
  });

  it('gives each investor the same multiples when they were called alike', () => {
    // Both were called half their commitment on the same dates and distributed
    // pro rata, so their multiples must be identical even though the amounts
    // differ four to one.
    const summary = computeFund(twoInvestorFund());
    expect(Number(position(summary, 'ALDER').tvpi)).toBeCloseTo(1.6, 12);
    expect(Number(position(summary, 'BRINE').tvpi)).toBeCloseTo(1.6, 12);
  });

  it('does not average investor multiples into the fund multiple', () => {
    /*
     * Alder is called 4,000,000 and gets 400,000 back: DPI 0.10.
     * Brine is called   100,000 and gets 100,000 back: DPI 1.00.
     *
     * The average of the two is 0.55. The fund's DPI is 500,000 over
     * 4,100,000 = 0.1220, because Brine's excellent small position cannot
     * carry a fund forty times its size.
     */
    const summary = computeFund({
      investors: [
        { id: 'ALDER', name: 'Alder Pension', investorClass: 'lp', commitment: '8000000' },
        { id: 'BRINE', name: 'Brine Family Office', investorClass: 'lp', commitment: '2000000' },
      ],
      transactions: [
        { investorId: 'ALDER', date: '2026-01-01', type: 'contribution', amount: '4000000' },
        { investorId: 'BRINE', date: '2026-01-01', type: 'contribution', amount: '100000' },
        { investorId: 'ALDER', date: '2028-01-01', type: 'distribution', amount: '400000' },
        { investorId: 'BRINE', date: '2028-01-01', type: 'distribution', amount: '100000' },
      ],
      netAssetValue: '0',
      valuationDate: '2029-01-01',
    });

    expect(Number(position(summary, 'ALDER').dpi)).toBeCloseTo(0.1, 12);
    expect(Number(position(summary, 'BRINE').dpi)).toBeCloseTo(1, 12);
    expect(Number(summary.dpi)).toBeCloseTo(500000 / 4100000, 12);
    expect(Number(summary.dpi)).not.toBeCloseTo(0.55, 4);
  });
});

describe('the net internal rate of return', () => {
  it('solves a single-drawdown fund to a rate that can be checked in closed form', () => {
    /*
     * One contribution of 1,000,000 on 2026-01-01, one distribution of
     * 1,500,000 on 2029-01-01. XIRR counts actual days on a 365-day year:
     * 2026-01-01 to 2029-01-01 is 1,096 days (2028 is a leap year), so the
     * exponent is 1096/365 = 3.00274.
     *
     *   rate = 1.5 ^ (365/1096) - 1 = 0.144565…
     *
     * Computed here from Math.pow, which shares no code with the engine's
     * decimal bisection.
     */
    const summary = computeFund({
      investors: [{ id: 'ONE', name: 'Sole investor', investorClass: 'lp', commitment: '1000000' }],
      transactions: [
        { investorId: 'ONE', date: '2026-01-01', type: 'contribution', amount: '1000000' },
        { investorId: 'ONE', date: '2029-01-01', type: 'distribution', amount: '1500000' },
      ],
      netAssetValue: '0',
      valuationDate: '2029-01-01',
    });

    const expected = Math.pow(1.5, 365 / 1096) - 1;
    expect(Number(summary.netIrr)).toBeCloseTo(expected, 9);
  });

  it('counts residual value as a final inflow', () => {
    // Without it an unrealised fund would show a loss for as long as it holds
    // its assets, which is not a return, it is an accounting artefact.
    const withNav = computeFund(twoInvestorFund());
    const withoutNav = computeFund({ ...twoInvestorFund(), netAssetValue: '0' });

    expect(Number(withNav.netIrr)).toBeGreaterThan(0);
    expect(Number(withoutNav.netIrr)).toBeLessThan(0);
  });

  it('gives the same rate to two investors whose flows differ only in scale', () => {
    // A rate is scale-free. Alder's flows are four times Brine's on identical
    // dates, so the two rates must agree.
    const summary = computeFund(twoInvestorFund());
    expect(Number(position(summary, 'ALDER').netIrr)).toBeCloseTo(
      Number(position(summary, 'BRINE').netIrr),
      12,
    );
  });

  it('refuses a rate when the flows never change sign', () => {
    // Capital called and never returned has no internal rate of return. Null,
    // not zero and not minus one hundred percent.
    const summary = computeFund({
      investors: [{ id: 'ONE', name: 'Sole investor', investorClass: 'lp', commitment: '1000000' }],
      transactions: [
        { investorId: 'ONE', date: '2026-01-01', type: 'contribution', amount: '1000000' },
      ],
      netAssetValue: '0',
      valuationDate: '2029-01-01',
    });
    expect(summary.netIrr).toBeNull();
  });
});

describe('residual value allocation', () => {
  it('splits by contributed capital, not by commitment', () => {
    /*
     * Both commit 1,000,000, but only one has been called:
     *
     *   Alder contributed 1,000,000, Brine contributed 0.
     *
     * Alder therefore owns all of the assets. Splitting by commitment would
     * hand half the fund's value to an investor whose money never went in.
     */
    const summary = computeFund({
      investors: [
        { id: 'ALDER', name: 'Alder', investorClass: 'lp', commitment: '1000000' },
        { id: 'BRINE', name: 'Brine', investorClass: 'lp', commitment: '1000000' },
      ],
      transactions: [
        { investorId: 'ALDER', date: '2026-01-01', type: 'contribution', amount: '1000000' },
      ],
      netAssetValue: '1200000',
      valuationDate: '2029-01-01',
    });

    expect(position(summary, 'ALDER').netAssetValue).toBe('1200000');
    expect(position(summary, 'BRINE').netAssetValue).toBe('0');
  });

  it('allocates nothing when nothing has been contributed', () => {
    const summary = computeFund({
      investors: [{ id: 'ALDER', name: 'Alder', investorClass: 'lp', commitment: '1000000' }],
      transactions: [],
      netAssetValue: '500000',
      valuationDate: '2029-01-01',
    });
    expect(position(summary, 'ALDER').netAssetValue).toBe('0');
    // The fund still reports the value it holds; it simply has no one to
    // attribute it to yet.
    expect(summary.netAssetValue).toBe('500000');
  });

  it('allocates the whole residual and no more', () => {
    const summary = computeFund(twoInvestorFund());
    const allocated = summary.positions.reduce(
      (sum, entry) => sum + Number(entry.netAssetValue),
      0,
    );
    expect(allocated).toBeCloseTo(6000000, 6);
    expect(position(summary, 'ALDER').netAssetValue).toBe('4800000');
    expect(position(summary, 'BRINE').netAssetValue).toBe('1200000');
  });
});

describe('transparency', () => {
  it('publishes the flows the rate was solved from', () => {
    // A return nobody can check is not an answer. Six transactions plus the
    // residual value, with contributions negative.
    const summary = computeFund(twoInvestorFund());
    expect(summary.cashFlows).toHaveLength(7);
    expect(summary.cashFlows.filter((flow) => flow.label === 'contribution')).toHaveLength(4);
    expect(summary.cashFlows.every((flow) => flow.date.length === 10)).toBe(true);

    const net = summary.cashFlows.reduce((sum, flow) => sum + Number(flow.amount), 0);
    // -5,000,000 called, +2,000,000 distributed, +6,000,000 residual.
    expect(net).toBeCloseTo(3000000, 6);
  });

  it('omits the residual flow entirely when there is none', () => {
    const summary = computeFund({ ...twoInvestorFund(), netAssetValue: '0' });
    expect(summary.cashFlows.some((flow) => flow.label === 'residual value')).toBe(false);
  });
});

describe('recallable distributions', () => {
  /*
   * A sole investor, so the netting can be checked in the head.
   *
   *   Commitment            10,000,000
   *   Contribution            6,000,000  on 2026-01-01
   *   Distribution (recallable) 2,000,000  on 2027-01-01
   *   Distribution (not recallable) 500,000  on 2027-06-01
   *   Recall                   800,000  on 2028-01-01
   *
   * Gross distributed 2,500,000 less the 800,000 recall is 1,700,000 kept.
   * Of the 2,000,000 marked recallable, 800,000 has been drawn back, leaving
   * 1,200,000 of recall right still live. The non-recallable 500,000 was
   * never exposed to the recall right at all.
   */
  function recallFund(recallAmount: string): FundInput {
    return {
      investors: [
        { id: 'ONE', name: 'Sole investor', investorClass: 'lp', commitment: '10000000' },
      ],
      transactions: [
        { investorId: 'ONE', date: '2026-01-01', type: 'contribution', amount: '6000000' },
        {
          investorId: 'ONE',
          date: '2027-01-01',
          type: 'distribution',
          amount: '2000000',
          recallable: true,
        },
        { investorId: 'ONE', date: '2027-06-01', type: 'distribution', amount: '500000' },
        { investorId: 'ONE', date: '2028-01-01', type: 'recall', amount: recallAmount },
      ],
      netAssetValue: '0',
      valuationDate: '2029-01-01',
    };
  }

  it('nets a recall against distributed and against the recallable balance', () => {
    const summary = computeFund(recallFund('800000'));
    const one = position(summary, 'ONE');

    expect(one.contributed).toBe('6000000');
    expect(one.unfunded).toBe('4000000');
    expect(one.recalled).toBe('800000');
    expect(one.distributed).toBe('1700000');
    expect(one.recallableOutstanding).toBe('1200000');
    // distributed plus recalled reconstructs gross distributions.
    expect(Number(one.distributed) + Number(one.recalled)).toBe(2500000);

    expect(summary.totalRecalled).toBe('800000');
    expect(summary.totalRecallableOutstanding).toBe('1200000');
    expect(Number(one.dpi)).toBeCloseTo(1700000 / 6000000, 12);
  });

  it('leaves unfunded commitment untouched by a recall', () => {
    // A recall is not fresh calling capacity: this module deliberately does
    // not restore or expand what can still be called beyond commitment.
    const summary = computeFund(recallFund('800000'));
    expect(position(summary, 'ONE').unfunded).toBe('4000000');
  });

  it('floors both distributed and the recallable balance at zero when a recall exceeds them', () => {
    // A recall larger than what was ever marked recallable is a data
    // anomaly, not grounds to report a negative "still live" figure or a
    // negative "money that stayed out" figure.
    const summary = computeFund(recallFund('2500000'));
    const one = position(summary, 'ONE');
    expect(one.recalled).toBe('2500000');
    expect(one.recallableOutstanding).toBe('0');
    expect(one.distributed).toBe('0');
  });

  it('publishes the recall as its own negative cash flow', () => {
    const summary = computeFund(recallFund('800000'));
    const recallFlow = summary.cashFlows.find((flow) => flow.label === 'recall');
    expect(recallFlow).toBeDefined();
    expect(Number(recallFlow?.amount)).toBe(-800000);
  });
});
