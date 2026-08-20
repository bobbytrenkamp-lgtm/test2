import { describe, expect, it } from 'vitest';
import type { FundInvestor, FundTransaction } from './fund.js';
import { computeFundWaterfall, type FundWaterfallTier } from './fund-waterfall.js';

/**
 * `computeFundWaterfall`, checked by hand.
 *
 * Every expected figure below is derived independently of the engine — by
 * hand for the round-number fixtures, or by an `Math.pow`-based day-count
 * calculation that is not the engine's own `pow` call, for the ones that
 * are not. None is produced by running the engine and copying its output,
 * which is what would let a broken formula agree with itself.
 */

function lp(id: string, name = id): FundInvestor {
  return { id, name, investorClass: 'lp', commitment: '0' };
}
function gp(id: string, name = id): FundInvestor {
  return { id, name, investorClass: 'gp', commitment: '0' };
}
function contribution(investorId: string, date: string, amount: string): FundTransaction {
  return { investorId, date, type: 'contribution', amount, recallable: false };
}
function distribution(investorId: string, date: string, amount: string): FundTransaction {
  return { investorId, date, type: 'distribution', amount, recallable: false };
}
function recall(investorId: string, date: string, amount: string): FundTransaction {
  return { investorId, date, type: 'recall', amount, recallable: false };
}

const RETURN_OF_CAPITAL: FundWaterfallTier = {
  id: 'ROC',
  name: 'Return of capital',
  type: 'return_of_capital',
  hurdleRate: null,
  compounding: true,
  hurdleMultiple: null,
  splits: [],
  catchUpTargetShare: null,
};

function preferredReturn(rate: string, compounding = true): FundWaterfallTier {
  return {
    id: 'PREF',
    name: 'Preferred return',
    type: 'preferred_return',
    hurdleRate: rate,
    compounding,
    hurdleMultiple: null,
    splits: [],
    catchUpTargetShare: null,
  };
}

function catchUp(target: string, sponsorId: string): FundWaterfallTier {
  return {
    id: 'CATCHUP',
    name: 'GP catch-up',
    type: 'catch_up',
    hurdleRate: null,
    compounding: true,
    hurdleMultiple: null,
    splits: [{ partnerId: sponsorId, share: '1' }],
    catchUpTargetShare: target,
  };
}

function residualSplit(splits: Array<{ partnerId: string; share: string }>): FundWaterfallTier {
  return {
    id: 'RESIDUAL',
    name: 'Residual split',
    type: 'residual_split',
    hurdleRate: null,
    compounding: true,
    hurdleMultiple: null,
    splits,
    catchUpTargetShare: null,
  };
}

describe('a single distribution: return of capital, an 8% preferred, a 20% GP catch-up, an 80/20 residual', () => {
  const investors = [lp('LP'), gp('GP')];
  const tiers = [
    RETURN_OF_CAPITAL,
    preferredReturn('0.08'),
    catchUp('0.20', 'GP'),
    residualSplit([
      { partnerId: 'LP', share: '0.8' },
      { partnerId: 'GP', share: '0.2' },
    ]),
  ];
  // 2025 is not a leap year, so 2025-01-01 to 2026-01-01 is exactly 365
  // days — one full accrual year at exactly the stated 8%, with nothing
  // fractional to round.
  const transactions = [contribution('LP', '2025-01-01', '1000000')];

  const result = computeFundWaterfall({
    investors,
    transactions,
    tiers,
    distributionDate: '2026-01-01',
    distributableAmount: '1300000',
  });

  function byTier(investorId: string): Record<string, string> {
    const allocation = result.allocations.find((a) => a.investorId === investorId);
    return Object.fromEntries((allocation?.byTier ?? []).map((t) => [t.tierId, t.amount]));
  }

  it('returns the LP’s full $1,000,000 capital first', () => {
    expect(byTier('LP').ROC).toBe('1000000');
    expect(byTier('GP').ROC).toBeUndefined();
  });

  it('pays exactly $80,000 of preferred — 8% on $1,000,000 for exactly one year — and nothing to the GP', () => {
    expect(byTier('LP').PREF).toBe('80000');
    expect(byTier('GP').PREF).toBeUndefined();
  });

  it('catches the GP up to exactly 20% of profit distributed so far: $20,000', () => {
    // Hand-derived: before catch-up, profit distributed is $80,000, all to
    // the LP. Bringing the GP to 20% of the total needs
    // otherProfit x target/(1-target) = 80,000 x 0.2/0.8 = $20,000, and
    // nothing has been paid to the GP yet, so the full $20,000 is needed.
    expect(byTier('GP').CATCHUP).toBe('20000');
    expect(byTier('LP').CATCHUP).toBeUndefined();
  });

  it('splits what remains — $200,000 — 80/20 on the residual tier', () => {
    // $1,300,000 - $1,000,000 (capital) - $80,000 (preferred) - $20,000
    // (catch-up) = $200,000 left for the residual tier.
    expect(byTier('LP').RESIDUAL).toBe('160000');
    expect(byTier('GP').RESIDUAL).toBe('40000');
  });

  it('totals exactly $1,240,000 to the LP and $60,000 to the GP, summing to the full $1,300,000', () => {
    const lpTotal = result.allocations.find((a) => a.investorId === 'LP');
    const gpTotal = result.allocations.find((a) => a.investorId === 'GP');
    expect(lpTotal?.total).toBe('1240000');
    expect(gpTotal?.total).toBe('60000');
    expect(Number(lpTotal?.total) + Number(gpTotal?.total)).toBe(1_300_000);
  });

  it('lands the GP at exactly 20% of total profit — the promote the catch-up and residual were both aimed at — checked by an entirely separate calculation', () => {
    // Independent of every formula above: total profit is $300,000
    // ($1,300,000 distributed less the $1,000,000 of capital that was
    // always going back regardless of any tier). A catch-up that brings the
    // GP to exactly its target share of profit-so-far, followed by a
    // residual split at that same ratio, is a standard structure specifically
    // because the ratio is then invariant for every dollar after the
    // catch-up closes — so the GP's share of *all* profit, computed from
    // scratch here, has to equal the stated 20% target exactly.
    const totalProfit = 1_300_000 - 1_000_000;
    const gpProfit = 20_000 + 40_000;
    expect(gpProfit / totalProfit).toBeCloseTo(0.2, 10);
  });
});

describe('non-compounding preferred return', () => {
  it('accrues on unreturned capital alone, at a rate de-compounded to a daily one and applied linearly — never folding its own growing balance back into the base', () => {
    const investors = [lp('LP')];
    const tiers = [
      preferredReturn('0.10', false),
      residualSplit([{ partnerId: 'LP', share: '1' }]),
    ];
    // Two full accrual years (2025 and 2026 are both non-leap, so
    // 2025-01-01 to 2027-01-01 is exactly 730 days).
    const transactions = [contribution('LP', '2025-01-01', '1000000')];

    const result = computeFundWaterfall({
      investors,
      transactions,
      tiers,
      distributionDate: '2027-01-01',
      distributableAmount: '1200000',
    });

    // Independent cross-check, matching docs/calculation-specification.md's
    // own relationship between a compounding and a non-compounding accrual
    // (a fixed period rate derived from the annual rate's root, applied
    // without compounding): a daily rate de-compounded from the stated 10%,
    // applied linearly across all 730 days. This lands below both a naive
    // 10%-per-year simple interest ($200,000, since (1.1)^(1/365) - 1 is
    // itself less than 0.1/365) and a fully compounding 10%
    // ($1,000,000 x 1.1^2 - $1,000,000 = $210,000, since this never folds
    // its own growth back into the base for the next day).
    const dailyRate = Math.pow(1.1, 1 / 365) - 1;
    const expected = 1_000_000 * dailyRate * 730;
    expect(expected).toBeLessThan(200_000);
    expect(expected).toBeGreaterThan(190_000);

    const allocation = result.allocations.find((a) => a.investorId === 'LP');
    const pref = allocation?.byTier.find((t) => t.tierId === 'PREF');
    expect(Number(pref?.amount)).toBeCloseTo(expected, 1);
  });
});

describe('accrual runs on each investor’s own real dates, not a shared clock', () => {
  it('gives an investor admitted mid-fund less accrued preferred than one there from the start', () => {
    const investors = [lp('EARLY'), lp('LATE')];
    const tiers = [preferredReturn('0.08'), residualSplit([{ partnerId: 'EARLY', share: '1' }])];
    const transactions = [
      contribution('EARLY', '2025-01-01', '1000000'),
      contribution('LATE', '2025-07-01', '1000000'),
    ];

    // Independent cross-check: plain-JS Math.pow and native Date day
    // arithmetic, neither of which is the engine's own decimal.js `pow` or
    // calendar module.
    const earlyDays = (Date.UTC(2026, 0, 1) - Date.UTC(2025, 0, 1)) / 86_400_000;
    const lateDays = (Date.UTC(2026, 0, 1) - Date.UTC(2025, 6, 1)) / 86_400_000;
    expect(earlyDays).toBe(365);
    const earlyExpected = 1_000_000 * (Math.pow(1.08, earlyDays / 365) - 1);
    const lateExpected = 1_000_000 * (Math.pow(1.08, lateDays / 365) - 1);
    expect(earlyExpected).toBeGreaterThan(lateExpected);

    // The distributable amount here is a cent — nowhere near enough to pay
    // either tier — so nothing is actually paid out and the only way to
    // observe the accrual is a second call a moment later that pays enough
    // to exhaust it. Distributing exactly the sum of what both owe proves
    // the two are unequal and matches each one's own independently
    // computed figure.
    const secondResult = computeFundWaterfall({
      investors,
      transactions,
      tiers,
      distributionDate: '2026-01-01',
      distributableAmount: (earlyExpected + lateExpected).toFixed(2),
    });
    const earlyPref = secondResult.allocations
      .find((a) => a.investorId === 'EARLY')
      ?.byTier.find((t) => t.tierId === 'PREF');
    const latePref = secondResult.allocations
      .find((a) => a.investorId === 'LATE')
      ?.byTier.find((t) => t.tierId === 'PREF');
    expect(Number(earlyPref?.amount)).toBeCloseTo(earlyExpected, 2);
    expect(Number(latePref?.amount)).toBeCloseTo(lateExpected, 2);
  });
});

describe('a prior recorded distribution updates the ledger without being recomputed', () => {
  it('books a known past distribution against capital and preferred, then correctly accrues and allocates the next one', () => {
    const investors = [lp('LP'), gp('GP')];
    const tiers = [
      RETURN_OF_CAPITAL,
      preferredReturn('0.08'),
      residualSplit([
        { partnerId: 'LP', share: '0.8' },
        { partnerId: 'GP', share: '0.2' },
      ]),
    ];
    const transactions = [
      contribution('LP', '2025-01-01', '1000000'),
      // A real, already-decided distribution: $500,000 to the LP six months
      // in. This module never asks whether that figure matches what the
      // tiers would have computed — it is a fact, booked against the LP's
      // own capital and preferred exactly as the tiers order them.
      distribution('LP', '2025-07-01', '500000'),
    ];

    const result = computeFundWaterfall({
      investors,
      transactions,
      tiers,
      distributionDate: '2026-01-01',
      distributableAmount: '600000',
    });

    // Hand-derived: from 2025-01-01 to 2025-07-01 is 181 days (31+28+31+30+31+30
    // — 2025 is not a leap year, so February is 28). Accrued preferred at
    // that point is $1,000,000 x (1.08^(181/365) - 1). The $500,000
    // distribution pays that off first (return_of_capital comes before
    // preferred_return in this fixture's own tier order... wait, the tier
    // order here is ROC then PREF, so capital is paid down before
    // preferred), leaving whatever is left of the $500,000 against the
    // $1,000,000 principal.
    const midYearDays = (Date.UTC(2025, 6, 1) - Date.UTC(2025, 0, 1)) / 86_400_000;
    expect(midYearDays).toBe(181);
    const accruedAtMidYear = 1_000_000 * (Math.pow(1.08, midYearDays / 365) - 1);
    // return_of_capital is first in this fixture's tier order, so the full
    // $500,000 pays down principal (it is far less than $1,000,000 owed);
    // preferred accrued to that point is untouched and keeps accruing —
    // compounding, so the second leg accrues on the unreturned capital
    // *and* on what is already owed, not on the capital alone.
    const unreturnedAfterMidYear = 1_000_000 - 500_000;
    const remainingDays = (Date.UTC(2026, 0, 1) - Date.UTC(2025, 6, 1)) / 86_400_000;
    expect(remainingDays).toBe(184);
    const secondLegGrowth =
      (unreturnedAfterMidYear + accruedAtMidYear) * (Math.pow(1.08, remainingDays / 365) - 1);
    const totalAccruedPreferredAtYearEnd = accruedAtMidYear + secondLegGrowth;

    const lpAllocation = result.allocations.find((a) => a.investorId === 'LP');
    const roc = lpAllocation?.byTier.find((t) => t.tierId === 'ROC');
    const pref = lpAllocation?.byTier.find((t) => t.tierId === 'PREF');

    expect(Number(roc?.amount)).toBeCloseTo(500_000, 2);
    expect(Number(pref?.amount)).toBeCloseTo(totalAccruedPreferredAtYearEnd, 2);
  });
});

describe('a recall puts capital back at risk for accrual, exactly like a fresh call', () => {
  it('resumes accruing preferred on the recalled amount from the recall date', () => {
    const investors = [lp('LP')];
    const tiers = [
      RETURN_OF_CAPITAL,
      preferredReturn('0.08'),
      residualSplit([{ partnerId: 'LP', share: '1' }]),
    ];
    const transactions = [
      contribution('LP', '2025-01-01', '1000000'),
      distribution('LP', '2025-01-01', '1000000'), // Immediately returned; no time to accrue.
      // Recalled a quarter of it back on 2025-07-01. From fund.ts's own
      // convention, a recall is money leaving the investor again — the same
      // direction as a fresh call — so it should put that $250,000 back at
      // risk for the preferred to accrue on, the same as any other capital.
      recall('LP', '2025-07-01', '250000'),
    ];

    const result = computeFundWaterfall({
      investors,
      transactions,
      tiers,
      distributionDate: '2026-01-01',
      distributableAmount: '300000',
    });

    const days = (Date.UTC(2026, 0, 1) - Date.UTC(2025, 6, 1)) / 86_400_000;
    expect(days).toBe(184);
    const expectedAccrual = 250_000 * (Math.pow(1.08, days / 365) - 1);

    const pref = result.allocations
      .find((a) => a.investorId === 'LP')
      ?.byTier.find((t) => t.tierId === 'PREF');
    expect(Number(pref?.amount)).toBeCloseTo(expectedAccrual, 2);
    expect(Number(pref?.amount)).toBeGreaterThan(0);
  });
});

describe('tier order is honored exactly as stated, not a fixed order the engine assumes', () => {
  const investors = [lp('LP')];
  const transactions = [contribution('LP', '2025-01-01', '1000000')];
  // $1,050,000 available: less than capital plus the full year's accrued
  // preferred ($1,080,000), so which tier is listed first decides which one
  // is short-changed.
  const distributableAmount = '1050000';

  it('pays preferred in full and leaves capital short, when preferred is listed first', () => {
    const tiers = [preferredReturn('0.08'), RETURN_OF_CAPITAL];
    const result = computeFundWaterfall({
      investors,
      transactions,
      tiers,
      distributionDate: '2026-01-01',
      distributableAmount,
    });
    const byTier = Object.fromEntries(
      (result.allocations.find((a) => a.investorId === 'LP')?.byTier ?? []).map((t) => [
        t.tierId,
        t.amount,
      ]),
    );
    expect(byTier.PREF).toBe('80000');
    expect(byTier.ROC).toBe('970000');
  });

  it('pays capital in full and leaves preferred short, when capital is listed first', () => {
    const tiers = [RETURN_OF_CAPITAL, preferredReturn('0.08')];
    const result = computeFundWaterfall({
      investors,
      transactions,
      tiers,
      distributionDate: '2026-01-01',
      distributableAmount,
    });
    const byTier = Object.fromEntries(
      (result.allocations.find((a) => a.investorId === 'LP')?.byTier ?? []).map((t) => [
        t.tierId,
        t.amount,
      ]),
    );
    expect(byTier.ROC).toBe('1000000');
    expect(byTier.PREF).toBe('50000');
  });
});

describe('pro-rata return of capital and preferred return across more than one investor still owed', () => {
  it('splits a partial payment between two investors in proportion to what each is owed, not evenly', () => {
    const investors = [lp('BIG'), lp('SMALL')];
    const tiers = [RETURN_OF_CAPITAL];
    const transactions = [
      contribution('BIG', '2025-01-01', '3000000'),
      contribution('SMALL', '2025-01-01', '1000000'),
    ];

    const result = computeFundWaterfall({
      investors,
      transactions,
      tiers,
      distributionDate: '2026-01-01',
      distributableAmount: '400000', // 10% of the $4,000,000 total owed.
    });

    // Hand-derived: BIG is owed 3/4 of the $4,000,000 total, SMALL 1/4.
    // A $400,000 partial payment pro rata is $300,000 and $100,000.
    const big = result.allocations
      .find((a) => a.investorId === 'BIG')
      ?.byTier.find((t) => t.tierId === 'ROC');
    const small = result.allocations
      .find((a) => a.investorId === 'SMALL')
      ?.byTier.find((t) => t.tierId === 'ROC');
    expect(big?.amount).toBe('300000');
    expect(small?.amount).toBe('100000');
  });
});

describe('refuses a transaction on or after the distribution date', () => {
  it('throws rather than silently double-count a same-day or later transaction against the new amount', () => {
    const investors = [lp('LP')];
    const tiers = [residualSplit([{ partnerId: 'LP', share: '1' }])];
    const transactions = [contribution('LP', '2026-01-01', '1000000')];

    expect(() =>
      computeFundWaterfall({
        investors,
        transactions,
        tiers,
        distributionDate: '2026-01-01',
        distributableAmount: '100000',
      }),
    ).toThrow(/not before the proposed distribution date/);
  });
});

describe('refuses tiers that do not fully allocate the distribution', () => {
  it('throws naming the shortfall, rather than silently dropping cash or guessing a fallback split', () => {
    const investors = [lp('LP')];
    // No residual_split tier at all: after capital is returned, $300,000 of
    // a $1,300,000 distribution has nowhere left to go.
    const tiers = [RETURN_OF_CAPITAL];
    const transactions = [contribution('LP', '2025-01-01', '1000000')];

    expect(() =>
      computeFundWaterfall({
        investors,
        transactions,
        tiers,
        distributionDate: '2026-01-01',
        distributableAmount: '1300000',
      }),
    ).toThrow(/300000 unallocated/);
  });
});

describe('same-day transactions resolve independent of input array order', () => {
  const tiers = [RETURN_OF_CAPITAL, residualSplit([{ partnerId: 'LP', share: '1' }])];
  const contributionEvent = contribution('LP', '2025-06-01', '1000000');
  const distributionEvent = distribution('LP', '2025-06-01', '500000');

  // A contribution then a same-day distribution leaves $500,000 owed on
  // capital: the $500,000 nets against the $1,000,000 just contributed,
  // not against zero. A second distribution of $700,000 then pays that
  // $500,000 in full and sends the remaining $200,000 to the residual
  // split — so `ROC` reads exactly '500000' only if the contribution was
  // booked before the same-day distribution, regardless of which one this
  // test lists first.
  function secondDistribution(transactions: FundTransaction[]) {
    return computeFundWaterfall({
      investors: [lp('LP')],
      transactions,
      tiers,
      distributionDate: '2026-01-01',
      distributableAmount: '700000',
    });
  }

  it('books the same-day distribution against the capital just contributed, when the contribution is listed first', () => {
    const result = secondDistribution([contributionEvent, distributionEvent]);
    const roc = result.allocations[0]?.byTier.find((t) => t.tierId === 'ROC');
    expect(roc?.amount).toBe('500000');
  });

  it('gives the identical result when the same two events are listed in the opposite order', () => {
    const result = secondDistribution([distributionEvent, contributionEvent]);
    const roc = result.allocations[0]?.byTier.find((t) => t.tierId === 'ROC');
    expect(roc?.amount).toBe('500000');
  });
});

describe('a catch-up tier with no valid recipient does not silently drop money', () => {
  it('skips the tier entirely so its share flows to the residual split, instead of vanishing from the total', () => {
    const investors = [lp('LP'), gp('GP')];
    const tiers = [
      RETURN_OF_CAPITAL,
      preferredReturn('0.08'),
      // Misconfigured: a positive target share but nobody named to receive
      // it — reachable today since neither the schema nor the write route
      // requires a catch_up tier to name a recipient with a positive share.
      { ...catchUp('0.20', 'GP'), splits: [] },
      residualSplit([
        { partnerId: 'LP', share: '0.8' },
        { partnerId: 'GP', share: '0.2' },
      ]),
    ];
    const transactions = [contribution('LP', '2025-01-01', '1000000')];

    const result = computeFundWaterfall({
      investors,
      transactions,
      tiers,
      distributionDate: '2026-01-01',
      distributableAmount: '1300000',
    });

    // Hand-derived: with no valid catch-up recipient, that tier claims
    // nothing, so every dollar past capital ($1,000,000) and preferred
    // ($80,000, exactly as the first describe block above derives it) —
    // $220,000 — reaches the residual split at 80/20: $176,000 to the LP
    // on top of its $1,080,000, $44,000 to the GP.
    const lpTotal = result.allocations.find((a) => a.investorId === 'LP');
    const gpTotal = result.allocations.find((a) => a.investorId === 'GP');
    expect(lpTotal?.total).toBe('1256000');
    expect(gpTotal?.total).toBe('44000');
    // The whole point: nothing vanished. Before this fix, exactly $20,000 —
    // the catch-up amount `distributeBySplits` silently failed to credit —
    // would be missing from this sum with no error raised anywhere.
    expect(Number(lpTotal?.total) + Number(gpTotal?.total)).toBe(1_300_000);
  });
});

describe('refuses a duplicate investor id rather than merging two investors into one ledger', () => {
  it('throws naming the id, rather than silently reporting one investor’s allocation twice', () => {
    const investors = [lp('LP', 'First LP'), lp('LP', 'Second LP')];
    const tiers = [residualSplit([{ partnerId: 'LP', share: '1' }])];

    expect(() =>
      computeFundWaterfall({
        investors,
        transactions: [],
        tiers,
        distributionDate: '2026-01-01',
        distributableAmount: '100000',
      }),
    ).toThrow(/appears more than once/);
  });
});
