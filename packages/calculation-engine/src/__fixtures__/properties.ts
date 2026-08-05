import type { ModelInput } from '@cre/domain-models';
import { buildModel, extendModel } from './builders.js';

/**
 * Independently designed, fictional demonstration properties used as the
 * calculation regression library. None of these represent a real property,
 * tenant or transaction.
 *
 * Each fixture is deliberately simple enough that its key outputs can be
 * derived by hand; the expected values live alongside the tests that use them.
 */

/**
 * Fixture 1 - Single-tenant industrial.
 * 100,000 sf let to one tenant at $6.00/sf/yr triple net, escalating 3% each
 * January, five-year forecast, one fully recoverable fixed expense.
 */
export function singleTenantIndustrial(): ModelInput {
  return buildModel({
    modelId: 'fx-industrial',
    modelName: 'Northgate Logistics Center (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 60,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-IND',
      name: 'Northgate Logistics Center',
      propertyType: 'industrial',
      rentableArea: '100000',
    },
    spaces: [{ id: 'S1', code: 'Building A', area: '100000', spaceType: 'warehouse' }],
    tenants: [{ id: 'T1', name: 'Cascade Freight Systems', industry: 'Logistics' }],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: '100000',
        commencementDate: '2026-01-01',
        expirationDate: '2030-12-31',
        baseRent: '6.00',
        baseRentBasis: 'per_area_per_year',
        escalation: { type: 'fixed_percent', rate: '0.03', frequencyMonths: 12, compounding: true },
        recovery: { method: 'triple_net' },
        excludeFromRollover: true,
      },
    ],
    expenses: [
      {
        id: 'E1',
        name: 'Property taxes',
        category: 'taxes',
        method: 'fixed_annual',
        amount: '50000',
        recoverableShare: '1',
        variableShare: '0',
      },
    ],
    valuation: {
      discountRate: '0.08',
      discountingConvention: 'end_of_period',
      terminalCapRate: '0.065',
      terminalNoiBasis: 'trailing_12',
      saleCostPercent: '0.01',
      saleMonth: 60,
      acquisitionPrice: '9000000',
      acquisitionCosts: '0',
    },
  });
}

/**
 * Fixture 2 - Multi-tenant office with base-year recoveries and rollover.
 * Two tenants in a 60,000 sf building; one expires inside the forecast and
 * rolls over against a market leasing profile.
 */
export function multiTenantOffice(): ModelInput {
  return buildModel({
    modelId: 'fx-office',
    modelName: 'Harborview Tower (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 84,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-OFF',
      name: 'Harborview Tower',
      propertyType: 'office',
      rentableArea: '60000',
    },
    growthCurves: [
      { id: 'CPI', name: 'Inflation', defaultRate: '0.025' },
      { id: 'MKT', name: 'Market rent growth', defaultRate: '0.03' },
    ],
    spaces: [
      {
        id: 'S-10',
        code: 'Suite 1000',
        floor: '10',
        area: '25000',
        spaceType: 'office',
        marketLeasingProfileId: 'MLA-OFFICE',
      },
      {
        id: 'S-11',
        code: 'Suite 1100',
        floor: '11',
        area: '20000',
        spaceType: 'office',
        marketLeasingProfileId: 'MLA-OFFICE',
      },
      {
        id: 'S-12',
        code: 'Suite 1200',
        floor: '12',
        area: '15000',
        spaceType: 'office',
        marketLeasingProfileId: 'MLA-OFFICE',
      },
    ],
    tenants: [
      { id: 'T-A', name: 'Meridian Actuarial Group', industry: 'Insurance' },
      { id: 'T-B', name: 'Bellweather Design Partners', industry: 'Professional services' },
    ],
    leases: [
      {
        id: 'L-A',
        tenantId: 'T-A',
        spaceIds: ['S-10'],
        status: 'occupied',
        area: '25000',
        commencementDate: '2023-07-01',
        expirationDate: '2028-06-30',
        baseRent: '32.00',
        baseRentBasis: 'per_area_per_year',
        escalation: {
          type: 'fixed_percent',
          rate: '0.03',
          frequencyMonths: 12,
          firstEscalationDate: '2026-07-01',
        },
        recovery: { method: 'base_year', baseYear: 2026, grossUpPercent: '0.95' },
        marketLeasingProfileId: 'MLA-OFFICE',
      },
      {
        id: 'L-B',
        tenantId: 'T-B',
        spaceIds: ['S-11'],
        status: 'occupied',
        area: '20000',
        commencementDate: '2024-01-01',
        expirationDate: '2033-12-31',
        baseRent: '30.00',
        baseRentBasis: 'per_area_per_year',
        escalation: {
          type: 'fixed_amount',
          amount: '0.75',
          frequencyMonths: 12,
          firstEscalationDate: '2027-01-01',
        },
        recovery: { method: 'expense_stop', expenseStopPerArea: '9.50' },
        marketLeasingProfileId: 'MLA-OFFICE',
      },
    ],
    marketLeasingProfiles: [
      {
        id: 'MLA-OFFICE',
        name: 'Harborview office standard',
        marketRent: '34.00',
        marketRentBasis: 'per_area_per_year',
        marketRentGrowthCurveId: 'MKT',
        renewalProbability: '0.70',
        renewalTermMonths: 60,
        newLeaseTermMonths: 60,
        downtimeMonths: 9,
        renewalFreeRentMonths: 1,
        newFreeRentMonths: 4,
        renewalTiPerArea: '15.00',
        newTiPerArea: '55.00',
        renewalLcPercent: '0.02',
        newLcPercent: '0.04',
        renewalEscalation: { type: 'fixed_percent', rate: '0.03', frequencyMonths: 12 },
        newEscalation: { type: 'fixed_percent', rate: '0.03', frequencyMonths: 12 },
        recovery: { method: 'base_year' },
      },
    ],
    defaultMarketLeasingProfileId: 'MLA-OFFICE',
    expenses: [
      {
        id: 'E-TAX',
        name: 'Property taxes',
        category: 'taxes',
        method: 'per_area_per_year',
        amount: '4.50',
        growthCurveId: 'CPI',
        recoverableShare: '1',
        variableShare: '0',
      },
      {
        id: 'E-INS',
        name: 'Insurance',
        category: 'insurance',
        method: 'per_area_per_year',
        amount: '0.85',
        growthCurveId: 'CPI',
        recoverableShare: '1',
        variableShare: '0',
      },
      {
        id: 'E-CAM',
        name: 'Common area maintenance',
        category: 'cam',
        method: 'per_area_per_year',
        amount: '3.20',
        growthCurveId: 'CPI',
        recoverableShare: '1',
        variableShare: '0.4',
      },
      {
        id: 'E-UTL',
        name: 'Utilities',
        category: 'utilities',
        method: 'per_area_per_year',
        amount: '2.10',
        growthCurveId: 'CPI',
        recoverableShare: '1',
        variableShare: '0.7',
      },
      {
        id: 'E-MGT',
        name: 'Management fee',
        category: 'management',
        method: 'percent_of_effective_gross_revenue',
        amount: '0.03',
        recoverableShare: '1',
        variableShare: '0',
      },
      {
        id: 'E-GA',
        name: 'General and administrative',
        category: 'admin',
        method: 'per_area_per_year',
        amount: '0.60',
        growthCurveId: 'CPI',
        recoverableShare: '0',
        variableShare: '0',
      },
    ],
    vacancy: {
      generalVacancyRate: '0.05',
      netAgainstModelledVacancy: true,
      creditLossRate: '0.005',
    },
    capital: [
      {
        id: 'C-RES',
        name: 'Replacement reserve',
        category: 'replacement_reserve',
        method: 'per_area_per_year',
        amount: '0.25',
        growthCurveId: 'CPI',
      },
    ],
    valuation: {
      discountRate: '0.0775',
      discountingConvention: 'end_of_period',
      terminalCapRate: '0.0625',
      terminalNoiBasis: 'forward_12',
      saleCostPercent: '0.0125',
      saleMonth: 72,
      directCapRate: '0.058',
      directCapNoiBasis: 'year_1',
      acquisitionPrice: '24500000',
      acquisitionCosts: '245000',
      acquisitionDate: '2026-01-01',
    },
  });
}

/**
 * Fixture 3 - Grocery-anchored retail with percentage rent.
 * Anchor tenant on a natural breakpoint plus two inline tenants.
 */
export function groceryAnchoredRetail(): ModelInput {
  return buildModel({
    modelId: 'fx-retail',
    modelName: 'Willow Creek Commons (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 60,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-RET',
      name: 'Willow Creek Commons',
      propertyType: 'retail',
      rentableArea: '85000',
    },
    growthCurves: [
      { id: 'CPI', name: 'Inflation', defaultRate: '0.025' },
      { id: 'SALES', name: 'Tenant sales growth', defaultRate: '0.02' },
    ],
    spaces: [
      { id: 'S-ANCHOR', code: 'Anchor', area: '55000', spaceType: 'anchor' },
      { id: 'S-101', code: 'Suite 101', area: '15000', spaceType: 'inline' },
      { id: 'S-102', code: 'Suite 102', area: '15000', spaceType: 'inline' },
    ],
    tenants: [
      { id: 'T-GROC', name: 'Willow Market Grocers', industry: 'Grocery', isAnchor: true },
      { id: 'T-PHARM', name: 'Creekside Pharmacy', industry: 'Retail' },
      { id: 'T-CAFE', name: 'Two Rivers Cafe', industry: 'Food service' },
    ],
    leases: [
      {
        id: 'L-GROC',
        tenantId: 'T-GROC',
        spaceIds: ['S-ANCHOR'],
        status: 'occupied',
        area: '55000',
        commencementDate: '2021-01-01',
        expirationDate: '2035-12-31',
        baseRent: '12.00',
        baseRentBasis: 'per_area_per_year',
        percentageRent: {
          enabled: true,
          baseSales: '30000000',
          salesGrowthCurveId: 'SALES',
          overagePercent: '0.015',
          breakpointType: 'natural',
        },
        recovery: { method: 'triple_net', excludedCategories: ['management'] },
        excludeFromRollover: true,
      },
      {
        id: 'L-PHARM',
        tenantId: 'T-PHARM',
        spaceIds: ['S-101'],
        status: 'occupied',
        area: '15000',
        commencementDate: '2024-03-01',
        expirationDate: '2029-02-28',
        baseRent: '22.00',
        baseRentBasis: 'per_area_per_year',
        escalation: {
          type: 'fixed_percent',
          rate: '0.025',
          frequencyMonths: 12,
          firstEscalationDate: '2027-03-01',
        },
        recovery: { method: 'triple_net', adminFeePercent: '0.15' },
        marketLeasingProfileId: 'MLA-INLINE',
      },
      {
        id: 'L-CAFE',
        tenantId: 'T-CAFE',
        spaceIds: ['S-102'],
        status: 'occupied',
        area: '15000',
        commencementDate: '2026-01-01',
        expirationDate: '2031-12-31',
        baseRent: '26.00',
        baseRentBasis: 'per_area_per_year',
        freeRent: [
          { startDate: '2026-01-01', months: 3, abatementShare: '1', appliesTo: ['base_rent'] },
        ],
        leasingCosts: { tiPerArea: '40.00', lcPercentOfRent: '0', paymentOffsetMonths: 0 },
        recovery: { method: 'triple_net', capPercent: '0.05', capIsCumulative: false },
        marketLeasingProfileId: 'MLA-INLINE',
      },
    ],
    marketLeasingProfiles: [
      {
        id: 'MLA-INLINE',
        name: 'Inline shop space',
        marketRent: '25.00',
        marketRentBasis: 'per_area_per_year',
        renewalProbability: '0.65',
        renewalTermMonths: 60,
        newLeaseTermMonths: 60,
        downtimeMonths: 6,
        newFreeRentMonths: 3,
        renewalTiPerArea: '10.00',
        newTiPerArea: '35.00',
        renewalLcPercent: '0.03',
        newLcPercent: '0.06',
        recovery: { method: 'triple_net' },
      },
    ],
    defaultMarketLeasingProfileId: 'MLA-INLINE',
    expenses: [
      {
        id: 'E-TAX',
        name: 'Property taxes',
        category: 'taxes',
        method: 'per_area_per_year',
        amount: '2.20',
        growthCurveId: 'CPI',
        recoverableShare: '1',
      },
      {
        id: 'E-CAM',
        name: 'Common area maintenance',
        category: 'cam',
        method: 'per_area_per_year',
        amount: '1.80',
        growthCurveId: 'CPI',
        recoverableShare: '1',
        variableShare: '0.3',
      },
      {
        id: 'E-INS',
        name: 'Insurance',
        category: 'insurance',
        method: 'per_area_per_year',
        amount: '0.45',
        growthCurveId: 'CPI',
        recoverableShare: '1',
      },
      {
        id: 'E-MGT',
        name: 'Management fee',
        category: 'management',
        method: 'percent_of_effective_gross_revenue',
        amount: '0.04',
        recoverableShare: '0',
      },
    ],
    vacancy: { generalVacancyRate: '0.03', creditLossRate: '0.01' },
    valuation: {
      discountRate: '0.0725',
      terminalCapRate: '0.0675',
      terminalNoiBasis: 'trailing_12',
      saleCostPercent: '0.01',
      saleMonth: 60,
      acquisitionPrice: '18000000',
    },
  });
}

/**
 * Fixture 4 - Multifamily, modelled on a per-unit basis with unit-count rents
 * and occupancy-variable operating expenses.
 */
export function multifamily(): ModelInput {
  return buildModel({
    modelId: 'fx-multifamily',
    modelName: 'Cedar Hollow Apartments (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 60,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-MF',
      name: 'Cedar Hollow Apartments',
      propertyType: 'multifamily',
      rentableArea: '180000',
      unitCount: 200,
    },
    growthCurves: [
      { id: 'CPI', name: 'Inflation', defaultRate: '0.03' },
      { id: 'RENT', name: 'Rent growth', defaultRate: '0.035' },
    ],
    spaces: [
      {
        id: 'S-ALL',
        code: 'Residential units',
        area: '180000',
        unitCount: 200,
        spaceType: 'residential',
      },
    ],
    tenants: [{ id: 'T-POOL', name: 'Residential tenancy pool' }],
    leases: [
      {
        id: 'L-POOL',
        tenantId: 'T-POOL',
        spaceIds: ['S-ALL'],
        status: 'occupied',
        area: '180000',
        unitCount: 200,
        commencementDate: '2026-01-01',
        expirationDate: '2030-12-31',
        baseRent: '1850',
        baseRentBasis: 'per_unit_per_month',
        escalation: { type: 'index', indexCurveId: 'RENT', frequencyMonths: 12, compounding: true },
        recovery: { method: 'none' },
        excludeFromRollover: true,
      },
    ],
    otherRevenue: [
      {
        id: 'R-PARK',
        name: 'Parking',
        category: 'parking',
        method: 'per_unit_per_month',
        amount: '65',
        growthCurveId: 'CPI',
        varyWithOccupancy: true,
      },
      {
        id: 'R-PET',
        name: 'Pet fees',
        category: 'other',
        method: 'per_unit_per_month',
        amount: '18',
        growthCurveId: 'CPI',
        varyWithOccupancy: true,
      },
      {
        id: 'R-UTIL',
        name: 'Utility reimbursement',
        category: 'utility_reimbursement',
        method: 'per_unit_per_month',
        amount: '55',
        growthCurveId: 'CPI',
        varyWithOccupancy: true,
      },
    ],
    expenses: [
      {
        id: 'E-TAX',
        name: 'Property taxes',
        category: 'taxes',
        method: 'per_unit_per_year',
        amount: '2400',
        growthCurveId: 'CPI',
      },
      {
        id: 'E-PAY',
        name: 'Payroll',
        category: 'payroll',
        method: 'per_unit_per_year',
        amount: '1150',
        growthCurveId: 'CPI',
        variableShare: '0.2',
      },
      {
        id: 'E-RM',
        name: 'Repairs and maintenance',
        category: 'repairs',
        method: 'per_unit_per_year',
        amount: '950',
        growthCurveId: 'CPI',
        variableShare: '0.5',
      },
      {
        id: 'E-UTL',
        name: 'Utilities',
        category: 'utilities',
        method: 'per_unit_per_year',
        amount: '780',
        growthCurveId: 'CPI',
        variableShare: '0.6',
      },
      {
        id: 'E-MKT',
        name: 'Marketing',
        category: 'marketing',
        method: 'per_unit_per_year',
        amount: '210',
        growthCurveId: 'CPI',
      },
      {
        id: 'E-MGT',
        name: 'Management fee',
        category: 'management',
        method: 'percent_of_effective_gross_revenue',
        amount: '0.03',
      },
    ],
    vacancy: {
      generalVacancyRate: '0.055',
      netAgainstModelledVacancy: true,
      creditLossRate: '0.005',
    },
    capital: [
      {
        id: 'C-RES',
        name: 'Replacement reserve',
        category: 'replacement_reserve',
        method: 'per_unit_per_year',
        amount: '300',
        growthCurveId: 'CPI',
      },
    ],
    valuation: {
      discountRate: '0.07',
      terminalCapRate: '0.055',
      terminalNoiBasis: 'trailing_12',
      saleCostPercent: '0.015',
      saleMonth: 60,
      directCapRate: '0.05',
      acquisitionPrice: '62000000',
    },
  });
}

/**
 * Fixture 5 - Development project. Land and construction draws, capitalised
 * interest on a construction facility, then lease-up against a market profile.
 */
export function developmentProject(): ModelInput {
  const drawSchedule: string[] = Array.from({ length: 60 }, (_, i) =>
    i >= 3 && i < 21 ? '1200000' : '0',
  );
  return buildModel({
    modelId: 'fx-development',
    modelName: 'Ridgeline Commerce Park Phase I (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 60,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-DEV',
      name: 'Ridgeline Commerce Park Phase I',
      propertyType: 'industrial',
      rentableArea: '150000',
    },
    growthCurves: [
      { id: 'MKT', name: 'Market rent growth', defaultRate: '0.03' },
      {
        id: 'SOFR',
        name: 'Construction index path',
        defaultRate: '0.035',
        byYear: [
          { year: 1, rate: '0.045' },
          { year: 2, rate: '0.04' },
          { year: 3, rate: '0.035' },
        ],
      },
    ],
    spaces: [
      {
        id: 'S-DEV',
        code: 'Building 1',
        area: '150000',
        spaceType: 'warehouse',
        marketLeasingProfileId: 'MLA-DEV',
      },
    ],
    tenants: [{ id: 'T-DEV', name: 'Ridgeline lease-up' }],
    leases: [
      {
        id: 'L-DEV',
        tenantId: 'T-DEV',
        spaceIds: ['S-DEV'],
        status: 'future',
        area: '150000',
        commencementDate: '2027-11-01',
        expirationDate: '2037-10-31',
        baseRent: '9.50',
        baseRentBasis: 'per_area_per_year',
        escalation: { type: 'fixed_percent', rate: '0.03', frequencyMonths: 12 },
        freeRent: [
          { startDate: '2027-11-01', months: 6, abatementShare: '1', appliesTo: ['base_rent'] },
        ],
        leasingCosts: { tiPerArea: '5.00', lcPercentOfRent: '0', paymentOffsetMonths: 0 },
        recovery: { method: 'triple_net' },
        excludeFromRollover: true,
      },
    ],
    marketLeasingProfiles: [
      {
        id: 'MLA-DEV',
        name: 'Ridgeline industrial',
        marketRent: '9.50',
        marketRentBasis: 'per_area_per_year',
        marketRentGrowthCurveId: 'MKT',
        renewalProbability: '0.75',
        downtimeMonths: 6,
        recovery: { method: 'triple_net' },
      },
    ],
    expenses: [
      {
        id: 'E-TAX',
        name: 'Property taxes',
        category: 'taxes',
        method: 'per_area_per_year',
        amount: '0.65',
        recoverableShare: '1',
      },
      {
        id: 'E-INS',
        name: 'Insurance',
        category: 'insurance',
        method: 'per_area_per_year',
        amount: '0.18',
        recoverableShare: '1',
      },
      {
        id: 'E-CAM',
        name: 'Common area maintenance',
        category: 'cam',
        method: 'per_area_per_year',
        amount: '0.42',
        recoverableShare: '1',
        variableShare: '0.3',
      },
    ],
    capital: [
      {
        id: 'C-LAND',
        name: 'Land acquisition',
        category: 'development_hard_cost',
        method: 'one_time',
        amount: '4500000',
        startDate: '2026-01-01',
      },
      {
        id: 'C-HARD',
        name: 'Hard costs',
        category: 'development_hard_cost',
        method: 'custom_monthly_schedule',
        monthlySchedule: drawSchedule,
      },
      {
        id: 'C-SOFT',
        name: 'Soft costs and fees',
        category: 'development_soft_cost',
        method: 'one_time',
        amount: '3200000',
        startDate: '2026-04-01',
      },
    ],
    debt: [
      {
        id: 'D-CONST',
        name: 'Construction facility',
        type: 'construction',
        commitment: '18000000',
        initialFunding: '0',
        fundingDate: '2026-04-01',
        draws: Array.from({ length: 18 }, (_, i) => ({
          date: `${2026 + Math.floor((3 + i) / 12)}-${String(((3 + i) % 12) + 1).padStart(2, '0')}-01`,
          amount: '900000',
        })),
        rateType: 'floating',
        indexCurveId: 'SOFR',
        spread: '0.0275',
        rateFloor: '0.0375',
        interestOnlyMonths: 36,
        amortizationMonths: 0,
        termMonths: 36,
        originationFeePercent: '0.01',
        capitalizeInterest: true,
        repayOnSale: true,
      },
    ],
    valuation: {
      discountRate: '0.09',
      terminalCapRate: '0.06',
      terminalNoiBasis: 'trailing_12',
      saleCostPercent: '0.01',
      saleMonth: 60,
      acquisitionPrice: '0',
      acquisitionCosts: '0',
    },
  });
}

/** Fixture 6 - Mixed-use: ground-floor retail over office floors. */
export function mixedUse(): ModelInput {
  return buildModel({
    modelId: 'fx-mixed-use',
    modelName: 'Foundry Row (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 72,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: { id: 'P-MU', name: 'Foundry Row', propertyType: 'mixed_use', rentableArea: '70000' },
    growthCurves: [{ id: 'CPI', name: 'Inflation', defaultRate: '0.025' }],
    spaces: [
      {
        id: 'S-RET',
        code: 'Ground floor retail',
        floor: '1',
        area: '12000',
        spaceType: 'retail',
        marketLeasingProfileId: 'MLA-RET',
      },
      {
        id: 'S-OFF',
        code: 'Floors 2-5 office',
        area: '58000',
        spaceType: 'office',
        marketLeasingProfileId: 'MLA-OFF',
      },
    ],
    tenants: [
      { id: 'T-SHOP', name: 'Foundry Provisions' },
      { id: 'T-TECH', name: 'Kestrel Analytics' },
    ],
    leases: [
      {
        id: 'L-SHOP',
        tenantId: 'T-SHOP',
        spaceIds: ['S-RET'],
        status: 'occupied',
        area: '12000',
        commencementDate: '2025-06-01',
        expirationDate: '2030-05-31',
        baseRent: '38.00',
        baseRentBasis: 'per_area_per_year',
        escalation: {
          type: 'fixed_percent',
          rate: '0.03',
          frequencyMonths: 12,
          firstEscalationDate: '2026-06-01',
        },
        recovery: { method: 'triple_net' },
        marketLeasingProfileId: 'MLA-RET',
      },
      {
        id: 'L-TECH',
        tenantId: 'T-TECH',
        spaceIds: ['S-OFF'],
        status: 'occupied',
        area: '58000',
        commencementDate: '2024-09-01',
        expirationDate: '2029-08-31',
        baseRent: '29.50',
        baseRentBasis: 'per_area_per_year',
        escalation: {
          type: 'fixed_percent',
          rate: '0.025',
          frequencyMonths: 12,
          firstEscalationDate: '2026-09-01',
        },
        recovery: { method: 'base_year', baseYear: 2026 },
        marketLeasingProfileId: 'MLA-OFF',
      },
    ],
    marketLeasingProfiles: [
      {
        id: 'MLA-RET',
        name: 'Foundry retail',
        marketRent: '40.00',
        marketRentBasis: 'per_area_per_year',
        renewalProbability: '0.6',
        downtimeMonths: 9,
        newTiPerArea: '60.00',
        renewalTiPerArea: '15.00',
        newLcPercent: '0.05',
        renewalLcPercent: '0.025',
        recovery: { method: 'triple_net' },
        precedence: 10,
      },
      {
        id: 'MLA-OFF',
        name: 'Foundry office',
        marketRent: '31.00',
        marketRentBasis: 'per_area_per_year',
        renewalProbability: '0.7',
        downtimeMonths: 6,
        newTiPerArea: '50.00',
        renewalTiPerArea: '12.00',
        newLcPercent: '0.04',
        renewalLcPercent: '0.02',
        recovery: { method: 'base_year' },
        precedence: 10,
      },
    ],
    expenses: [
      {
        id: 'E-TAX',
        name: 'Property taxes',
        category: 'taxes',
        method: 'per_area_per_year',
        amount: '5.10',
        growthCurveId: 'CPI',
        recoverableShare: '1',
      },
      {
        id: 'E-OPS',
        name: 'Building operations',
        category: 'cam',
        method: 'per_area_per_year',
        amount: '6.40',
        growthCurveId: 'CPI',
        recoverableShare: '1',
        variableShare: '0.35',
      },
      {
        id: 'E-MGT',
        name: 'Management fee',
        category: 'management',
        method: 'percent_of_effective_gross_revenue',
        amount: '0.03',
      },
    ],
    vacancy: { generalVacancyRate: '0.05', creditLossRate: '0.005' },
    valuation: {
      discountRate: '0.08',
      terminalCapRate: '0.065',
      terminalNoiBasis: 'forward_12',
      saleCostPercent: '0.0125',
      saleMonth: 60,
      acquisitionPrice: '28000000',
    },
  });
}

/**
 * Fixture 7 - Base-year recovery in isolation.
 * One tenant occupying the whole building so the pro-rata share is exactly 1,
 * and a single expense that grows at a known rate.
 */
export function baseYearRecovery(): ModelInput {
  return buildModel({
    modelId: 'fx-base-year',
    modelName: 'Base-year recovery test property (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 48,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: { id: 'P-BY', name: 'Base-year test', propertyType: 'office', rentableArea: '50000' },
    growthCurves: [{ id: 'G10', name: 'Ten percent growth', defaultRate: '0.10' }],
    spaces: [{ id: 'S1', code: 'Whole building', area: '50000' }],
    tenants: [{ id: 'T1', name: 'Single occupant' }],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: '50000',
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '20.00',
        baseRentBasis: 'per_area_per_year',
        recovery: { method: 'base_year', baseYear: 2026 },
        excludeFromRollover: true,
      },
    ],
    expenses: [
      {
        id: 'E1',
        name: 'Operating expenses',
        category: 'cam',
        method: 'fixed_annual',
        amount: '500000',
        growthCurveId: 'G10',
        recoverableShare: '1',
        variableShare: '0',
      },
    ],
    valuation: {
      discountRate: '0.08',
      terminalCapRate: '0.07',
      terminalNoiBasis: 'trailing_12',
      saleMonth: 48,
    },
  });
}

/** Fixture 8 - Expense stop in isolation, at a half-building pro-rata share. */
export function expenseStopRecovery(): ModelInput {
  return buildModel({
    modelId: 'fx-expense-stop',
    modelName: 'Expense-stop test property (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 36,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-ES',
      name: 'Expense-stop test',
      propertyType: 'office',
      rentableArea: '100000',
    },
    spaces: [
      { id: 'S1', code: 'Suite 1', area: '50000' },
      { id: 'S2', code: 'Suite 2', area: '50000' },
    ],
    tenants: [
      { id: 'T1', name: 'Stop tenant' },
      { id: 'T2', name: 'Gross tenant' },
    ],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: '50000',
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '25.00',
        baseRentBasis: 'per_area_per_year',
        recovery: { method: 'expense_stop', expenseStopPerArea: '8.00' },
        excludeFromRollover: true,
      },
      {
        id: 'L2',
        tenantId: 'T2',
        spaceIds: ['S2'],
        status: 'occupied',
        area: '50000',
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '28.00',
        baseRentBasis: 'per_area_per_year',
        recovery: { method: 'full_service_gross' },
        excludeFromRollover: true,
      },
    ],
    expenses: [
      {
        id: 'E1',
        name: 'Operating expenses',
        category: 'cam',
        method: 'per_area_per_year',
        amount: '10.00',
        recoverableShare: '1',
        variableShare: '0',
      },
    ],
    valuation: {
      discountRate: '0.08',
      terminalCapRate: '0.07',
      terminalNoiBasis: 'trailing_12',
      saleMonth: 36,
    },
  });
}

/** Fixture 9 - Percentage rent on a natural breakpoint, in isolation. */
export function percentageRentProperty(): ModelInput {
  return buildModel({
    modelId: 'fx-percentage-rent',
    modelName: 'Percentage-rent test property (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 24,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-PR',
      name: 'Percentage-rent test',
      propertyType: 'retail',
      rentableArea: '20000',
    },
    growthCurves: [{ id: 'SALES', name: 'Sales growth', defaultRate: '0.05' }],
    spaces: [{ id: 'S1', code: 'Store', area: '20000' }],
    tenants: [{ id: 'T1', name: 'Test retailer' }],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: '20000',
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '15.00',
        baseRentBasis: 'per_area_per_year',
        percentageRent: {
          enabled: true,
          baseSales: '8000000',
          salesGrowthCurveId: 'SALES',
          overagePercent: '0.05',
          breakpointType: 'natural',
        },
        recovery: { method: 'none' },
        excludeFromRollover: true,
      },
    ],
    valuation: {
      discountRate: '0.08',
      terminalCapRate: '0.07',
      terminalNoiBasis: 'trailing_12',
      saleMonth: 24,
    },
  });
}

/** Fixture 10 - Floating-rate debt with a rate floor and an index path. */
export function floatingRateDebt(): ModelInput {
  return extendModel(baseYearRecovery(), {
    modelId: 'fx-floating-debt',
    modelName: 'Floating-rate debt test property (fictional)',
    growthCurves: [
      { id: 'G10', name: 'Ten percent growth', defaultRate: '0.10' },
      {
        id: 'SOFR',
        name: 'Forward index path',
        defaultRate: '0.04',
        byYear: [
          { year: 1, rate: '0.05' },
          { year: 2, rate: '0.045' },
          { year: 3, rate: '0.035' },
          { year: 4, rate: '0.03' },
        ],
      },
    ],
    debt: [
      {
        id: 'D1',
        name: 'Floating bridge loan',
        type: 'bridge',
        commitment: '6000000',
        initialFunding: '6000000',
        fundingDate: '2026-01-01',
        rateType: 'floating',
        indexCurveId: 'SOFR',
        spread: '0.025',
        rateFloor: '0.065',
        interestOnlyMonths: 48,
        amortizationMonths: 0,
        termMonths: 48,
        originationFeePercent: '0.01',
        repayOnSale: true,
      },
    ],
  });
}

/** Fixture 11 - Amortizing loan repaid and replaced by a refinancing. */
export function refinanceScenario(): ModelInput {
  return extendModel(baseYearRecovery(), {
    modelId: 'fx-refinance',
    modelName: 'Refinance test property (fictional)',
    debt: [
      {
        id: 'D-INITIAL',
        name: 'Original mortgage',
        type: 'permanent',
        commitment: '5000000',
        initialFunding: '5000000',
        fundingDate: '2026-01-01',
        rateType: 'fixed',
        fixedRate: '0.06',
        interestOnlyMonths: 0,
        amortizationMonths: 360,
        termMonths: 24,
        repayOnSale: true,
      },
      {
        id: 'D-REFI',
        name: 'Replacement mortgage',
        type: 'permanent',
        commitment: '6500000',
        initialFunding: '6500000',
        fundingDate: '2028-01-01',
        rateType: 'fixed',
        fixedRate: '0.055',
        interestOnlyMonths: 12,
        amortizationMonths: 360,
        termMonths: 24,
        originationFeePercent: '0.0075',
        repayOnSale: true,
      },
    ],
  });
}

/** Fixture 12 - LP/GP waterfall with a preferred return, catch-up and promote. */
export function lpGpWaterfall(): ModelInput {
  return extendModel(baseYearRecovery(), {
    modelId: 'fx-waterfall',
    modelName: 'LP/GP waterfall test property (fictional)',
    valuation: {
      discountRate: '0.08',
      terminalCapRate: '0.055',
      terminalNoiBasis: 'trailing_12',
      saleMonth: 48,
      saleCostPercent: '0.01',
      acquisitionPrice: '7000000',
      acquisitionCosts: '0',
    },
    equity: {
      partners: [
        { id: 'LP', name: 'Institutional investor', role: 'lp', contributionShare: '0.90' },
        { id: 'GP', name: 'Sponsor', role: 'gp', contributionShare: '0.10' },
      ],
      tiers: [
        {
          id: 'T-PREF',
          name: '8% preferred return',
          type: 'preferred_return',
          hurdleRate: '0.08',
          compounding: true,
          splits: [
            { partnerId: 'LP', share: '0.90' },
            { partnerId: 'GP', share: '0.10' },
          ],
        },
        {
          id: 'T-ROC',
          name: 'Return of capital',
          type: 'return_of_capital',
          splits: [
            { partnerId: 'LP', share: '0.90' },
            { partnerId: 'GP', share: '0.10' },
          ],
        },
        {
          id: 'T-CATCHUP',
          name: 'Sponsor catch-up to 20%',
          type: 'catch_up',
          catchUpTargetShare: '0.20',
          splits: [{ partnerId: 'GP', share: '1' }],
        },
        {
          id: 'T-RESIDUAL',
          name: '80/20 residual split',
          type: 'residual_split',
          splits: [
            { partnerId: 'LP', share: '0.80' },
            { partnerId: 'GP', share: '0.20' },
          ],
        },
      ],
      fees: [],
    },
  });
}

/**
 * Fixtures 13-15 - Lease options.
 *
 * Deliberately arithmetically plain so every expected figure can be derived in
 * one line: 10,000 sf at $24.00/sf/yr is $240,000 a year and exactly $20,000 a
 * month, with no escalation, no recoveries and no expenses to obscure it. The
 * lease is excluded from rollover so that what the test sees is the option's
 * effect alone and not a market-leasing branch layered on top.
 */
function optionBase(options: unknown[], expiration: string): ModelInput {
  return buildModel({
    modelId: 'fx-options',
    modelName: 'Kingsbridge Court (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 60,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-OPT',
      name: 'Kingsbridge Court',
      propertyType: 'office',
      rentableArea: '10000',
    },
    spaces: [{ id: 'S1', code: 'Whole building', area: '10000', spaceType: 'office' }],
    tenants: [{ id: 'T1', name: 'Halloway Reinsurance', industry: 'Insurance' }],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: '10000',
        commencementDate: '2026-01-01',
        expirationDate: expiration,
        baseRent: '24.00',
        baseRentBasis: 'per_area_per_year',
        escalation: { type: 'none' },
        recovery: { method: 'none' },
        excludeFromRollover: true,
        options,
      },
    ],
    valuation: {
      discountRate: '0.08',
      discountingConvention: 'end_of_period',
      terminalCapRate: '0.07',
      saleCostPercent: '0',
      saleMonth: 60,
      acquisitionPrice: '3000000',
      acquisitionCosts: '0',
    },
  } as Parameters<typeof buildModel>[0]);
}

/** A renewal option at 60%, extending a three-year term by two years at $30.00/sf. */
export function renewalOption(): ModelInput {
  return optionBase(
    [
      {
        id: 'OPT-RENEW',
        type: 'renewal',
        exerciseDate: '2028-07-01',
        noticeDate: '2028-01-01',
        probability: '0.60',
        termMonths: 24,
        rentMethod: 'fixed',
        rentAmount: '30.00',
        rentBasis: 'per_area_per_year',
      },
    ],
    '2028-12-31',
  );
}

/** A termination option at 25%, ending a five-year term half way through 2028. */
export function terminationOption(): ModelInput {
  return optionBase(
    [
      {
        id: 'OPT-TERM',
        type: 'termination',
        exerciseDate: '2028-06-30',
        probability: '0.25',
        // Negative because `cost` is a landlord cost: a fee received from the
        // tenant on termination is a negative cost.
        cost: '-150000',
      },
    ],
    '2030-12-31',
  );
}

/** A contraction option at 50%, handing back 4,000 of 10,000 sf from 2028. */
export function contractionOption(): ModelInput {
  return optionBase(
    [
      {
        id: 'OPT-CONTRACT',
        type: 'contraction',
        exerciseDate: '2028-01-01',
        probability: '0.50',
        areaChange: '4000',
      },
    ],
    '2030-12-31',
  );
}

/** An expansion option, which the engine deliberately refuses to model. */
export function expansionOption(): ModelInput {
  return optionBase(
    [
      {
        id: 'OPT-EXPAND',
        type: 'expansion',
        exerciseDate: '2028-01-01',
        probability: '0.50',
        areaChange: '5000',
      },
    ],
    '2030-12-31',
  );
}

/**
 * Fixture 16 - Two recovery pools on one lease, settling on different terms.
 *
 * Operating costs on an expense stop with a 5% annual cap; taxes triple net and
 * uncapped. This is an ordinary office lease and it cannot be expressed as a
 * single pool: one entitlement forces a choice between capping the taxes and
 * uncapping the operating costs, and both are wrong.
 *
 * The half-building tenant makes the pro-rata share exactly 0.5, and the second
 * tenant is full-service gross so it contributes no recovery of its own.
 */
export function multiplePoolRecovery(): ModelInput {
  return buildModel({
    modelId: 'fx-recovery-pools',
    modelName: 'Multiple recovery pool test property (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 36,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-POOL',
      name: 'Recovery pool test',
      propertyType: 'office',
      rentableArea: '100000',
    },
    growthCurves: [{ id: 'G10', name: 'Ten percent growth', defaultRate: '0.10' }],
    spaces: [
      { id: 'S1', code: 'Suite 1', area: '50000' },
      { id: 'S2', code: 'Suite 2', area: '50000' },
    ],
    tenants: [
      { id: 'T1', name: 'Pooled tenant' },
      { id: 'T2', name: 'Gross tenant' },
    ],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: '50000',
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '25.00',
        baseRentBasis: 'per_area_per_year',
        recovery: {
          pools: [
            {
              code: 'OPEX',
              name: 'Operating costs',
              method: 'expense_stop',
              includedCategories: ['cam'],
              expenseStopPerArea: '2.00',
              capPercent: '0.05',
            },
            {
              code: 'TAX',
              name: 'Property taxes',
              method: 'triple_net',
              includedCategories: ['taxes'],
            },
          ],
        },
        excludeFromRollover: true,
      },
      {
        id: 'L2',
        tenantId: 'T2',
        spaceIds: ['S2'],
        status: 'occupied',
        area: '50000',
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '28.00',
        baseRentBasis: 'per_area_per_year',
        recovery: { method: 'full_service_gross' },
        excludeFromRollover: true,
      },
    ],
    expenses: [
      {
        id: 'E1',
        name: 'Operating costs',
        category: 'cam',
        method: 'fixed_annual',
        amount: '400000',
        growthCurveId: 'G10',
        recoverableShare: '1',
        variableShare: '0',
      },
      {
        id: 'E2',
        name: 'Property taxes',
        category: 'taxes',
        method: 'fixed_annual',
        amount: '300000',
        growthCurveId: 'G10',
        recoverableShare: '1',
        variableShare: '0',
      },
    ],
    valuation: {
      discountRate: '0.08',
      terminalCapRate: '0.07',
      terminalNoiBasis: 'trailing_12',
      saleMonth: 36,
    },
  });
}

/**
 * Fixture 17 - Recoveries estimated on the prior year and reconciled in arrears.
 *
 * The tenant pays last year's settled amount monthly and the difference is
 * billed three months after the year closes. That moves cash between years,
 * which moves the return, so it is not presentation. The final year's true-up
 * falls beyond the forecast on purpose: the engine has to say so rather than
 * quietly lose a receivable.
 */
export function reconciledRecovery(): ModelInput {
  return buildModel({
    modelId: 'fx-reconciliation',
    modelName: 'Recovery reconciliation test property (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 48,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-REC',
      name: 'Reconciliation test',
      propertyType: 'office',
      rentableArea: '50000',
    },
    growthCurves: [{ id: 'G10', name: 'Ten percent growth', defaultRate: '0.10' }],
    spaces: [{ id: 'S1', code: 'Whole building', area: '50000' }],
    tenants: [{ id: 'T1', name: 'Single occupant' }],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: '50000',
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '20.00',
        baseRentBasis: 'per_area_per_year',
        recovery: {
          method: 'triple_net',
          estimateBasis: 'prior_year_actual',
          reconciliationLagMonths: 3,
        },
        excludeFromRollover: true,
      },
    ],
    expenses: [
      {
        id: 'E1',
        name: 'Operating expenses',
        category: 'cam',
        method: 'fixed_annual',
        amount: '500000',
        growthCurveId: 'G10',
        recoverableShare: '1',
        variableShare: '0',
      },
    ],
    valuation: {
      discountRate: '0.08',
      terminalCapRate: '0.07',
      terminalNoiBasis: 'trailing_12',
      saleMonth: 48,
    },
  });
}

/**
 * Fixture 18 - A lease covering part of a space, with recoveries.
 *
 * The case no earlier fixture had: every one of them let whole spaces, which is
 * why a defect in exactly this configuration went unnoticed through two engine
 * versions. The tenant holds 40,000 of a single 100,000 sqft space, so its
 * pro-rata share and its share of the space it sits on are different numbers
 * and confusing them is visible.
 */
export function partialSpaceRecovery(): ModelInput {
  return buildModel({
    modelId: 'fx-partial-space',
    modelName: 'Partial-space recovery test property (fictional)',
    forecast: {
      startDate: '2026-01-01',
      months: 12,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P-PART',
      name: 'Partial-space test',
      propertyType: 'office',
      rentableArea: '100000',
    },
    spaces: [{ id: 'S1', code: 'Whole floor', area: '100000' }],
    tenants: [{ id: 'T1', name: 'Part-floor tenant' }],
    leases: [
      {
        id: 'L1',
        tenantId: 'T1',
        spaceIds: ['S1'],
        status: 'occupied',
        area: '40000',
        commencementDate: '2026-01-01',
        expirationDate: '2035-12-31',
        baseRent: '20.00',
        baseRentBasis: 'per_area_per_year',
        recovery: { method: 'triple_net' },
        excludeFromRollover: true,
      },
    ],
    expenses: [
      {
        id: 'E1',
        name: 'Operating expenses',
        category: 'cam',
        method: 'fixed_annual',
        amount: '500000',
        recoverableShare: '1',
        variableShare: '0',
      },
    ],
    valuation: {
      discountRate: '0.08',
      terminalCapRate: '0.07',
      terminalNoiBasis: 'trailing_12',
      saleMonth: 12,
    },
  });
}

export const ALL_FIXTURES: Record<string, () => ModelInput> = {
  singleTenantIndustrial,
  multiTenantOffice,
  groceryAnchoredRetail,
  multifamily,
  developmentProject,
  mixedUse,
  baseYearRecovery,
  expenseStopRecovery,
  percentageRentProperty,
  floatingRateDebt,
  refinanceScenario,
  lpGpWaterfall,
  renewalOption,
  terminationOption,
  contractionOption,
  multiplePoolRecovery,
  reconciledRecovery,
  partialSpaceRecovery,
};
