import type { Sql } from './client.js';
import { createOrganization } from './repositories/organizations.js';
import { createUser, findUserByEmail } from './repositories/auth.js';
import { createProperty, upsertSpace } from './repositories/properties.js';
import {
  createTenant,
  upsertCapitalItem,
  upsertDebtFacility,
  upsertExpense,
  upsertGrowthCurve,
  upsertLease,
  upsertMarketLeasingProfile,
  upsertOtherRevenue,
} from './repositories/leases.js';
import { runAndStoreCalculationFromInput } from './repositories/calculations.js';
import { buildModelInput, createModelVersion } from './repositories/models.js';
import { ENGINE_VERSION } from '@cre/calculation-engine';
import type { AccountCategory } from '@cre/domain-models';

/**
 * Demonstration data.
 *
 * Every property, tenant, address and figure below is fictional and invented
 * for this seed. Nothing here is a real asset, lease or transaction, and no
 * personally identifiable information is used. Property names carry a
 * "(demonstration data)" suffix in the organization name so the distinction is
 * visible in the interface, not just in this file.
 */

export interface SeedResult {
  organizationId: string;
  users: Array<{ email: string; password: string; role: string }>;
  propertyIds: Record<string, string>;
  modelIds: Record<string, string>;
  portfolioId: string;
}

const DEMO_PASSWORD = 'demo-password-2026';

export async function seedDemonstrationData(sql: Sql): Promise<SeedResult> {
  const owner =
    (await findUserByEmail(sql, 'owner@example.invalid')) ??
    (await createUser(sql, {
      email: 'owner@example.invalid',
      name: 'Dana Whitfield',
      password: DEMO_PASSWORD,
    }));

  const analyst =
    (await findUserByEmail(sql, 'analyst@example.invalid')) ??
    (await createUser(sql, {
      email: 'analyst@example.invalid',
      name: 'Rowan Estrada',
      password: DEMO_PASSWORD,
    }));

  const reviewer =
    (await findUserByEmail(sql, 'reviewer@example.invalid')) ??
    (await createUser(sql, {
      email: 'reviewer@example.invalid',
      name: 'Priya Ramanathan',
      password: DEMO_PASSWORD,
    }));

  const organization = await createOrganization(sql, {
    name: 'Meridian Real Estate Partners (demonstration data)',
    ownerId: owner.id,
  });

  await sql`
    INSERT INTO memberships (organization_id, user_id, role)
    VALUES (${organization.id}, ${analyst.id}, 'analyst'),
           (${organization.id}, ${reviewer.id}, 'reviewer')
    ON CONFLICT (organization_id, user_id) DO NOTHING
  `;

  const propertyIds: Record<string, string> = {};
  const modelIds: Record<string, string> = {};

  /* ---------------------------------------------------------------------- */
  /* 1. Industrial - single tenant, triple net                              */
  /* ---------------------------------------------------------------------- */

  const industrial = await createProperty(sql, {
    organizationId: organization.id,
    name: 'Northgate Logistics Center',
    propertyType: 'industrial',
    propertySubtype: 'Warehouse and distribution',
    addressLine1: '4400 Corridor Way',
    city: 'Fairvale',
    stateRegion: 'OH',
    postalCode: '43001',
    market: 'Fairvale',
    submarket: 'North Corridor',
    yearBuilt: 2018,
    rentableArea: '212000',
    landArea: '540000',
    buildingCount: 1,
    acquisitionDate: '2026-01-01',
    acquisitionPrice: '29400000',
    tags: ['core-plus', 'demonstration'],
    createdBy: owner.id,
  });
  propertyIds.industrial = industrial.id;
  await upsertSpace(sql, {
    propertyId: industrial.id,
    code: 'BLDG-A',
    spaceType: 'warehouse',
    area: '212000',
    sortOrder: 1,
  });

  const industrialModel = await createModel(sql, {
    organizationId: organization.id,
    propertyId: industrial.id,
    name: 'Acquisition underwriting - base case',
    classification: 'acquisition',
    ownerId: analyst.id,
    forecastStartDate: '2026-01-01',
    forecastMonths: 84,
    discountRate: '0.0725',
    terminalCapRate: '0.0575',
    terminalNoiBasis: 'forward_12',
    saleCostPercent: '0.01',
    saleMonth: 60,
    directCapRate: '0.055',
    acquisitionPrice: '29400000',
    acquisitionCosts: '294000',
  });
  modelIds.industrial = industrialModel;

  await upsertGrowthCurve(sql, {
    modelId: industrialModel,
    code: 'CPI',
    name: 'Inflation',
    defaultRate: '0.025',
  });
  await upsertGrowthCurve(sql, {
    modelId: industrialModel,
    code: 'MKT-IND',
    name: 'Industrial market rent growth',
    defaultRate: '0.035',
  });
  await upsertMarketLeasingProfile(sql, {
    modelId: industrialModel,
    code: 'MLA-IND',
    name: 'Fairvale bulk warehouse',
    marketRent: '8.25',
    marketRentGrowthCurve: 'MKT-IND',
    renewalProbability: '0.75',
    renewalTermMonths: 84,
    newLeaseTermMonths: 84,
    downtimeMonths: 6,
    newFreeRentMonths: 3,
    renewalTiPerArea: '1.50',
    newTiPerArea: '6.00',
    renewalLcPercent: '0.02',
    newLcPercent: '0.045',
    recovery: { method: 'triple_net' },
  });
  await sql`
    UPDATE models SET default_market_leasing_profile_id =
      (SELECT id FROM market_leasing_profiles WHERE model_id = ${industrialModel} AND code = 'MLA-IND')
    WHERE id = ${industrialModel}
  `;

  const cascade = await createTenant(sql, {
    organizationId: organization.id,
    propertyId: industrial.id,
    name: 'Cascade Freight Systems',
    industry: 'Logistics',
    creditRating: 'BBB',
  });
  await upsertLease(sql, {
    modelId: industrialModel,
    code: 'L-CASCADE',
    tenantId: cascade.id,
    status: 'occupied',
    area: '212000',
    spaceIds: ['BLDG-A'],
    commencementDate: '2022-04-01',
    expirationDate: '2029-03-31',
    baseRent: '7.10',
    baseRentBasis: 'per_area_per_year',
    escalation: {
      type: 'fixed_percent',
      rate: '0.03',
      frequencyMonths: 12,
      firstEscalationDate: '2026-04-01',
    },
    recovery: { method: 'triple_net', adminFeePercent: '0.03' },
  });

  await upsertExpense(sql, {
    modelId: industrialModel,
    code: 'TAX',
    name: 'Property taxes',
    category: 'taxes',
    method: 'per_area_per_year',
    amount: '0.72',
    growthCurve: 'CPI',
    recoverableShare: '1',
  });
  await upsertExpense(sql, {
    modelId: industrialModel,
    code: 'INS',
    name: 'Insurance',
    category: 'insurance',
    method: 'per_area_per_year',
    amount: '0.16',
    growthCurve: 'CPI',
    recoverableShare: '1',
  });
  await upsertExpense(sql, {
    modelId: industrialModel,
    code: 'CAM',
    name: 'Common area maintenance',
    category: 'cam',
    method: 'per_area_per_year',
    amount: '0.38',
    growthCurve: 'CPI',
    recoverableShare: '1',
    variableShare: '0.25',
  });
  await upsertExpense(sql, {
    modelId: industrialModel,
    code: 'MGT',
    name: 'Management fee',
    category: 'management',
    method: 'percent_of_effective_gross_revenue',
    amount: '0.025',
    recoverableShare: '1',
  });
  await upsertCapitalItem(sql, {
    modelId: industrialModel,
    code: 'RESERVE',
    name: 'Replacement reserve',
    category: 'replacement_reserve',
    method: 'per_area_per_year',
    amount: '0.12',
    growthCurve: 'CPI',
  });
  await upsertDebtFacility(sql, {
    modelId: industrialModel,
    code: 'SENIOR',
    name: 'Senior acquisition mortgage',
    type: 'acquisition',
    commitment: '17640000',
    initialFunding: '17640000',
    fundingDate: '2026-01-01',
    rateType: 'fixed',
    fixedRate: '0.0585',
    interestOnlyMonths: 24,
    amortizationMonths: 360,
    termMonths: 84,
    originationFeePercent: '0.005',
    minimumDscr: '1.25',
    maximumLtv: '0.65',
  });

  /* ---------------------------------------------------------------------- */
  /* 2. Office - multi tenant, base year recoveries, rollover               */
  /* ---------------------------------------------------------------------- */

  const office = await createProperty(sql, {
    organizationId: organization.id,
    name: 'Harborview Tower',
    propertyType: 'office',
    propertySubtype: 'Central business district',
    addressLine1: '1 Harborview Plaza',
    city: 'Port Alden',
    stateRegion: 'WA',
    postalCode: '98001',
    market: 'Port Alden',
    submarket: 'Waterfront',
    yearBuilt: 2005,
    yearRenovated: 2021,
    rentableArea: '186500',
    buildingCount: 1,
    parkingCount: 340,
    acquisitionDate: '2026-01-01',
    acquisitionPrice: '47500000',
    tags: ['value-add', 'demonstration'],
    createdBy: owner.id,
  });
  propertyIds.office = office.id;
  for (const [index, space] of [
    ['SUITE-1200', '12', '42500'],
    ['SUITE-1400', '14', '38200'],
    ['SUITE-1600', '16', '51300'],
    ['SUITE-1800', '18', '54500'],
  ].entries()) {
    await upsertSpace(sql, {
      propertyId: office.id,
      code: space[0] as string,
      floor: space[1] as string,
      spaceType: 'office',
      area: space[2] as string,
      sortOrder: index,
    });
  }

  const officeModel = await createModel(sql, {
    organizationId: organization.id,
    propertyId: office.id,
    name: 'Valuation - 31 December 2026',
    classification: 'valuation',
    ownerId: analyst.id,
    forecastStartDate: '2026-01-01',
    forecastMonths: 120,
    discountRate: '0.0825',
    terminalCapRate: '0.0675',
    terminalNoiBasis: 'forward_12',
    saleCostPercent: '0.0125',
    saleMonth: 84,
    directCapRate: '0.0625',
    acquisitionPrice: '47500000',
    acquisitionCosts: '475000',
    generalVacancyRate: '0.05',
    creditLossRate: '0.005',
  });
  modelIds.office = officeModel;

  await upsertGrowthCurve(sql, {
    modelId: officeModel,
    code: 'CPI',
    name: 'Inflation',
    defaultRate: '0.025',
  });
  await upsertGrowthCurve(sql, {
    modelId: officeModel,
    code: 'MKT-OFF',
    name: 'Office market rent growth',
    defaultRate: '0.03',
    byYear: [
      { year: 2, rate: '0.01' },
      { year: 3, rate: '0.02' },
    ],
  });
  await upsertMarketLeasingProfile(sql, {
    modelId: officeModel,
    code: 'MLA-OFF',
    name: 'Harborview office standard',
    marketRent: '36.50',
    marketRentGrowthCurve: 'MKT-OFF',
    renewalProbability: '0.68',
    renewalTermMonths: 60,
    newLeaseTermMonths: 84,
    downtimeMonths: 9,
    renewalFreeRentMonths: 2,
    newFreeRentMonths: 6,
    renewalTiPerArea: '18.00',
    newTiPerArea: '65.00',
    renewalLcPercent: '0.02',
    newLcPercent: '0.045',
    renewalEscalation: { type: 'fixed_percent', rate: '0.03', frequencyMonths: 12 },
    newEscalation: { type: 'fixed_percent', rate: '0.03', frequencyMonths: 12 },
    recovery: { method: 'base_year', grossUpPercent: '0.95' },
  });
  await sql`
    UPDATE models SET default_market_leasing_profile_id =
      (SELECT id FROM market_leasing_profiles WHERE model_id = ${officeModel} AND code = 'MLA-OFF')
    WHERE id = ${officeModel}
  `;

  const officeTenants = [
    {
      name: 'Meridian Actuarial Group',
      industry: 'Insurance',
      space: 'SUITE-1200',
      area: '42500',
      start: '2021-07-01',
      end: '2028-06-30',
      rent: '33.75',
      recovery: { method: 'base_year', baseYear: 2026, grossUpPercent: '0.95' },
    },
    {
      name: 'Bellweather Design Partners',
      industry: 'Professional services',
      space: 'SUITE-1400',
      area: '38200',
      start: '2023-01-01',
      end: '2032-12-31',
      rent: '35.00',
      recovery: { method: 'expense_stop', expenseStopPerArea: '11.25' },
    },
    {
      name: 'Kestrel Analytics',
      industry: 'Technology',
      space: 'SUITE-1600',
      area: '51300',
      start: '2024-09-01',
      end: '2031-08-31',
      rent: '37.25',
      recovery: { method: 'base_year', baseYear: 2026 },
    },
  ];
  for (const tenant of officeTenants) {
    const record = await createTenant(sql, {
      organizationId: organization.id,
      propertyId: office.id,
      name: tenant.name,
      industry: tenant.industry,
    });
    await upsertLease(sql, {
      modelId: officeModel,
      code: `L-${tenant.space}`,
      tenantId: record.id,
      status: 'occupied',
      area: tenant.area,
      spaceIds: [tenant.space],
      commencementDate: tenant.start,
      expirationDate: tenant.end,
      baseRent: tenant.rent,
      baseRentBasis: 'per_area_per_year',
      escalation: { type: 'fixed_percent', rate: '0.0275', frequencyMonths: 12 },
      recovery: tenant.recovery,
      leasingCosts: { tiPerArea: '0', lcPercentOfRent: '0' },
    });
  }
  // SUITE-1800 is deliberately left vacant so lease-up and downtime are visible.

  for (const expense of [
    ['TAX', 'Property taxes', 'taxes', '5.85', '1', '0'],
    ['INS', 'Insurance', 'insurance', '0.95', '1', '0'],
    ['CAM', 'Common area maintenance', 'cam', '3.60', '1', '0.35'],
    ['UTL', 'Utilities', 'utilities', '2.45', '1', '0.70'],
    ['JAN', 'Janitorial', 'janitorial', '1.35', '1', '0.85'],
    ['SEC', 'Security', 'security', '0.90', '1', '0.10'],
    ['GA', 'General and administrative', 'admin', '0.75', '0', '0'],
  ]) {
    await upsertExpense(sql, {
      modelId: officeModel,
      code: expense[0] as string,
      name: expense[1] as string,
      category: expense[2] as string,
      method: 'per_area_per_year',
      amount: expense[3] as string,
      growthCurve: 'CPI',
      recoverableShare: expense[4] as string,
      variableShare: expense[5] as string,
    });
  }
  await upsertExpense(sql, {
    modelId: officeModel,
    code: 'MGT',
    name: 'Management fee',
    category: 'management',
    method: 'percent_of_effective_gross_revenue',
    amount: '0.03',
    recoverableShare: '1',
  });
  await upsertOtherRevenue(sql, {
    modelId: officeModel,
    code: 'PARK',
    name: 'Parking income',
    category: 'parking',
    method: 'fixed_annual',
    amount: '612000',
    growthCurve: 'CPI',
    varyWithOccupancy: true,
  });
  await upsertOtherRevenue(sql, {
    modelId: officeModel,
    code: 'ANT',
    name: 'Rooftop antenna licences',
    category: 'antenna',
    method: 'fixed_annual',
    amount: '48000',
    growthCurve: 'CPI',
  });
  await upsertCapitalItem(sql, {
    modelId: officeModel,
    code: 'RESERVE',
    name: 'Replacement reserve',
    category: 'replacement_reserve',
    method: 'per_area_per_year',
    amount: '0.30',
    growthCurve: 'CPI',
  });
  await upsertCapitalItem(sql, {
    modelId: officeModel,
    code: 'LOBBY',
    name: 'Lobby and amenity repositioning',
    category: 'major_project',
    method: 'custom_monthly_schedule',
    amount: '1',
    monthlySchedule: Array.from({ length: 120 }, (_, i) => (i >= 2 && i < 10 ? '325000' : '0')),
  });
  await upsertDebtFacility(sql, {
    modelId: officeModel,
    code: 'SENIOR',
    name: 'Senior mortgage',
    type: 'permanent',
    commitment: '28500000',
    initialFunding: '28500000',
    fundingDate: '2026-01-01',
    rateType: 'floating',
    indexCurve: 'SOFR',
    spread: '0.0235',
    rateFloor: '0.045',
    interestOnlyMonths: 36,
    amortizationMonths: 360,
    termMonths: 84,
    originationFeePercent: '0.0075',
    minimumDscr: '1.20',
    maximumLtv: '0.60',
    minimumDebtYield: '0.085',
  });
  await upsertGrowthCurve(sql, {
    modelId: officeModel,
    code: 'SOFR',
    name: 'Forward index path',
    defaultRate: '0.033',
    byYear: [
      { year: 1, rate: '0.043' },
      { year: 2, rate: '0.038' },
      { year: 3, rate: '0.034' },
    ],
  });

  /* ---------------------------------------------------------------------- */
  /* 3. Retail - grocery anchored with percentage rent                      */
  /* ---------------------------------------------------------------------- */

  const retail = await createProperty(sql, {
    organizationId: organization.id,
    name: 'Willow Creek Commons',
    propertyType: 'retail',
    propertySubtype: 'Grocery-anchored neighbourhood centre',
    addressLine1: '900 Willow Creek Road',
    city: 'Brightwater',
    stateRegion: 'NC',
    postalCode: '27001',
    market: 'Brightwater',
    submarket: 'West',
    yearBuilt: 2009,
    rentableArea: '124000',
    parkingCount: 620,
    acquisitionDate: '2026-01-01',
    acquisitionPrice: '28800000',
    tags: ['core', 'demonstration'],
    createdBy: owner.id,
  });
  propertyIds.retail = retail.id;
  for (const [index, space] of [
    ['ANCHOR', '62000', 'anchor'],
    ['SHOP-101', '18500', 'inline'],
    ['SHOP-102', '22000', 'inline'],
    ['PAD-A', '21500', 'pad'],
  ].entries()) {
    await upsertSpace(sql, {
      propertyId: retail.id,
      code: space[0] as string,
      spaceType: space[2] as string,
      area: space[1] as string,
      sortOrder: index,
    });
  }

  const retailModel = await createModel(sql, {
    organizationId: organization.id,
    propertyId: retail.id,
    name: 'Business plan 2026',
    classification: 'business_plan',
    ownerId: analyst.id,
    forecastStartDate: '2026-01-01',
    forecastMonths: 96,
    discountRate: '0.0775',
    terminalCapRate: '0.0700',
    terminalNoiBasis: 'forward_12',
    saleCostPercent: '0.01',
    saleMonth: 84,
    acquisitionPrice: '28800000',
    generalVacancyRate: '0.03',
    creditLossRate: '0.0075',
  });
  modelIds.retail = retailModel;

  await upsertGrowthCurve(sql, {
    modelId: retailModel,
    code: 'CPI',
    name: 'Inflation',
    defaultRate: '0.025',
  });
  await upsertGrowthCurve(sql, {
    modelId: retailModel,
    code: 'SALES',
    name: 'Tenant sales growth',
    defaultRate: '0.022',
  });
  await upsertMarketLeasingProfile(sql, {
    modelId: retailModel,
    code: 'MLA-INLINE',
    name: 'Inline shop space',
    marketRent: '27.50',
    renewalProbability: '0.65',
    downtimeMonths: 7,
    newFreeRentMonths: 4,
    renewalTiPerArea: '12.00',
    newTiPerArea: '42.00',
    renewalLcPercent: '0.03',
    newLcPercent: '0.06',
    recovery: { method: 'triple_net', adminFeePercent: '0.15' },
  });
  await sql`
    UPDATE models SET default_market_leasing_profile_id =
      (SELECT id FROM market_leasing_profiles WHERE model_id = ${retailModel} AND code = 'MLA-INLINE')
    WHERE id = ${retailModel}
  `;

  const grocer = await createTenant(sql, {
    organizationId: organization.id,
    propertyId: retail.id,
    name: 'Willow Market Grocers',
    industry: 'Grocery',
    isAnchor: true,
  });
  await upsertLease(sql, {
    modelId: retailModel,
    code: 'L-ANCHOR',
    tenantId: grocer.id,
    status: 'occupied',
    area: '62000',
    spaceIds: ['ANCHOR'],
    commencementDate: '2019-02-01',
    expirationDate: '2039-01-31',
    baseRent: '13.25',
    baseRentBasis: 'per_area_per_year',
    percentageRent: {
      enabled: true,
      baseSales: '41000000',
      salesGrowthCurveId: 'SALES',
      overagePercent: '0.0125',
      breakpointType: 'natural',
    },
    recovery: { method: 'triple_net', excludedCategories: ['management'] },
    excludeFromRollover: true,
  });

  for (const shop of [
    {
      code: 'SHOP-101',
      name: 'Creekside Pharmacy',
      area: '18500',
      rent: '24.00',
      start: '2023-03-01',
      end: '2028-02-29',
    },
    {
      code: 'SHOP-102',
      name: 'Two Rivers Cafe',
      area: '22000',
      rent: '28.50',
      start: '2025-06-01',
      end: '2032-05-31',
    },
    {
      code: 'PAD-A',
      name: 'Brightwater Bank',
      area: '21500',
      rent: '31.00',
      start: '2022-01-01',
      end: '2027-12-31',
    },
  ]) {
    const record = await createTenant(sql, {
      organizationId: organization.id,
      propertyId: retail.id,
      name: shop.name,
      industry: 'Retail',
    });
    await upsertLease(sql, {
      modelId: retailModel,
      code: `L-${shop.code}`,
      tenantId: record.id,
      status: 'occupied',
      area: shop.area,
      spaceIds: [shop.code],
      commencementDate: shop.start,
      expirationDate: shop.end,
      baseRent: shop.rent,
      baseRentBasis: 'per_area_per_year',
      escalation: { type: 'fixed_percent', rate: '0.025', frequencyMonths: 12 },
      recovery: { method: 'triple_net', adminFeePercent: '0.15', capPercent: '0.05' },
    });
  }

  for (const expense of [
    ['TAX', 'Property taxes', 'taxes', '2.45', '1', '0'],
    ['CAM', 'Common area maintenance', 'cam', '2.10', '1', '0.30'],
    ['INS', 'Insurance', 'insurance', '0.52', '1', '0'],
  ]) {
    await upsertExpense(sql, {
      modelId: retailModel,
      code: expense[0] as string,
      name: expense[1] as string,
      category: expense[2] as string,
      method: 'per_area_per_year',
      amount: expense[3] as string,
      growthCurve: 'CPI',
      recoverableShare: expense[4] as string,
      variableShare: expense[5] as string,
    });
  }
  await upsertExpense(sql, {
    modelId: retailModel,
    code: 'MGT',
    name: 'Management fee',
    category: 'management',
    method: 'percent_of_effective_gross_revenue',
    amount: '0.04',
    recoverableShare: '0',
  });

  /* ---------------------------------------------------------------------- */
  /* 4. Multifamily                                                         */
  /* ---------------------------------------------------------------------- */

  const multifamily = await createProperty(sql, {
    organizationId: organization.id,
    name: 'Cedar Hollow Apartments',
    propertyType: 'multifamily',
    propertySubtype: 'Garden style',
    addressLine1: '3200 Cedar Hollow Drive',
    city: 'Lakemont',
    stateRegion: 'CO',
    postalCode: '80001',
    market: 'Lakemont',
    submarket: 'South Lakes',
    yearBuilt: 2016,
    rentableArea: '241000',
    unitCount: 264,
    parkingCount: 410,
    acquisitionDate: '2026-01-01',
    acquisitionPrice: '91500000',
    tags: ['core-plus', 'demonstration'],
    createdBy: owner.id,
  });
  propertyIds.multifamily = multifamily.id;
  await upsertSpace(sql, {
    propertyId: multifamily.id,
    code: 'RESIDENTIAL',
    spaceType: 'residential',
    area: '241000',
    unitCount: 264,
  });

  const multifamilyModel = await createModel(sql, {
    organizationId: organization.id,
    propertyId: multifamily.id,
    name: 'Reforecast - 2026',
    classification: 'reforecast',
    ownerId: analyst.id,
    forecastStartDate: '2026-01-01',
    forecastMonths: 72,
    discountRate: '0.0700',
    terminalCapRate: '0.0525',
    terminalNoiBasis: 'forward_12',
    saleCostPercent: '0.015',
    saleMonth: 60,
    directCapRate: '0.05',
    acquisitionPrice: '91500000',
    generalVacancyRate: '0.055',
    creditLossRate: '0.005',
  });
  modelIds.multifamily = multifamilyModel;

  await upsertGrowthCurve(sql, {
    modelId: multifamilyModel,
    code: 'CPI',
    name: 'Inflation',
    defaultRate: '0.03',
  });
  await upsertGrowthCurve(sql, {
    modelId: multifamilyModel,
    code: 'RENT',
    name: 'Residential rent growth',
    defaultRate: '0.034',
  });
  const residents = await createTenant(sql, {
    organizationId: organization.id,
    propertyId: multifamily.id,
    name: 'Residential tenancy pool',
  });
  await upsertLease(sql, {
    modelId: multifamilyModel,
    code: 'L-RESIDENTIAL',
    tenantId: residents.id,
    status: 'occupied',
    area: '241000',
    unitCount: 264,
    spaceIds: ['RESIDENTIAL'],
    commencementDate: '2026-01-01',
    expirationDate: '2031-12-31',
    baseRent: '1985',
    baseRentBasis: 'per_unit_per_month',
    escalation: { type: 'index', indexCurveId: 'RENT', frequencyMonths: 12, compounding: true },
    recovery: { method: 'none' },
    excludeFromRollover: true,
  });
  for (const revenue of [
    ['PARK', 'Parking', 'parking', '72'],
    ['PET', 'Pet fees', 'other', '21'],
    ['UTIL', 'Utility reimbursement', 'utility_reimbursement', '61'],
    ['STOR', 'Storage', 'storage', '28'],
  ]) {
    await upsertOtherRevenue(sql, {
      modelId: multifamilyModel,
      code: revenue[0] as string,
      name: revenue[1] as string,
      category: revenue[2] as string,
      method: 'per_unit_per_month',
      amount: revenue[3] as string,
      growthCurve: 'CPI',
      varyWithOccupancy: true,
    });
  }
  for (const expense of [
    ['TAX', 'Property taxes', 'taxes', '2680', '0'],
    ['PAY', 'Payroll', 'payroll', '1240', '0.2'],
    ['RM', 'Repairs and maintenance', 'repairs', '1010', '0.5'],
    ['UTL', 'Utilities', 'utilities', '840', '0.6'],
    ['MKT', 'Marketing', 'marketing', '235', '0'],
    ['ADM', 'Administrative', 'admin', '310', '0'],
  ]) {
    await upsertExpense(sql, {
      modelId: multifamilyModel,
      code: expense[0] as string,
      name: expense[1] as string,
      category: expense[2] as string,
      method: 'per_unit_per_year',
      amount: expense[3] as string,
      growthCurve: 'CPI',
      variableShare: expense[4] as string,
    });
  }
  await upsertExpense(sql, {
    modelId: multifamilyModel,
    code: 'MGT',
    name: 'Management fee',
    category: 'management',
    method: 'percent_of_effective_gross_revenue',
    amount: '0.03',
  });
  await upsertCapitalItem(sql, {
    modelId: multifamilyModel,
    code: 'RESERVE',
    name: 'Replacement reserve',
    category: 'replacement_reserve',
    method: 'per_unit_per_year',
    amount: '325',
    growthCurve: 'CPI',
  });

  /* ---------------------------------------------------------------------- */
  /* 5. Development project                                                 */
  /* ---------------------------------------------------------------------- */

  const development = await createProperty(sql, {
    organizationId: organization.id,
    name: 'Ridgeline Commerce Park Phase I',
    propertyType: 'industrial',
    propertySubtype: 'Development',
    addressLine1: 'Ridgeline Parkway',
    city: 'Fairvale',
    stateRegion: 'OH',
    postalCode: '43002',
    market: 'Fairvale',
    submarket: 'South Corridor',
    rentableArea: '165000',
    landArea: '820000',
    tags: ['development', 'demonstration'],
    createdBy: owner.id,
  });
  propertyIds.development = development.id;
  await upsertSpace(sql, {
    propertyId: development.id,
    code: 'BLDG-1',
    spaceType: 'warehouse',
    area: '165000',
  });

  const developmentModel = await createModel(sql, {
    organizationId: organization.id,
    propertyId: development.id,
    name: 'Development case',
    classification: 'development_case',
    ownerId: analyst.id,
    forecastStartDate: '2026-01-01',
    forecastMonths: 84,
    discountRate: '0.0950',
    terminalCapRate: '0.0600',
    terminalNoiBasis: 'forward_12',
    saleCostPercent: '0.01',
    saleMonth: 72,
    acquisitionPrice: '0',
  });
  modelIds.development = developmentModel;

  await upsertGrowthCurve(sql, {
    modelId: developmentModel,
    code: 'MKT-IND',
    name: 'Industrial market rent growth',
    defaultRate: '0.035',
  });
  await upsertGrowthCurve(sql, {
    modelId: developmentModel,
    code: 'SOFR',
    name: 'Forward index path',
    defaultRate: '0.033',
    byYear: [
      { year: 1, rate: '0.043' },
      { year: 2, rate: '0.038' },
    ],
  });
  await upsertMarketLeasingProfile(sql, {
    modelId: developmentModel,
    code: 'MLA-DEV',
    name: 'Ridgeline industrial',
    marketRent: '10.75',
    marketRentGrowthCurve: 'MKT-IND',
    renewalProbability: '0.75',
    downtimeMonths: 6,
    newTiPerArea: '5.00',
    recovery: { method: 'triple_net' },
  });
  await sql`
    UPDATE models SET default_market_leasing_profile_id =
      (SELECT id FROM market_leasing_profiles WHERE model_id = ${developmentModel} AND code = 'MLA-DEV')
    WHERE id = ${developmentModel}
  `;
  const preLease = await createTenant(sql, {
    organizationId: organization.id,
    propertyId: development.id,
    name: 'Ridgeline pre-lease (speculative)',
  });
  await upsertLease(sql, {
    modelId: developmentModel,
    code: 'L-BLDG1',
    tenantId: preLease.id,
    status: 'future',
    area: '165000',
    spaceIds: ['BLDG-1'],
    commencementDate: '2027-10-01',
    expirationDate: '2037-09-30',
    baseRent: '10.75',
    baseRentBasis: 'per_area_per_year',
    escalation: { type: 'fixed_percent', rate: '0.03', frequencyMonths: 12 },
    freeRent: [
      { startDate: '2027-10-01', months: 6, abatementShare: '1', appliesTo: ['base_rent'] },
    ],
    leasingCosts: { tiPerArea: '5.00', lcPercentOfRent: '0' },
    recovery: { method: 'triple_net' },
    excludeFromRollover: true,
  });
  await upsertExpense(sql, {
    modelId: developmentModel,
    code: 'TAX',
    name: 'Property taxes',
    category: 'taxes',
    method: 'per_area_per_year',
    amount: '0.70',
    recoverableShare: '1',
  });
  await upsertExpense(sql, {
    modelId: developmentModel,
    code: 'CAM',
    name: 'Common area maintenance',
    category: 'cam',
    method: 'per_area_per_year',
    amount: '0.45',
    recoverableShare: '1',
    variableShare: '0.3',
  });
  await upsertCapitalItem(sql, {
    modelId: developmentModel,
    code: 'LAND',
    name: 'Land acquisition',
    category: 'development_hard_cost',
    method: 'one_time',
    amount: '5100000',
    startDate: '2026-01-01',
  });
  await upsertCapitalItem(sql, {
    modelId: developmentModel,
    code: 'HARD',
    name: 'Hard costs',
    category: 'development_hard_cost',
    method: 'custom_monthly_schedule',
    amount: '1',
    monthlySchedule: Array.from({ length: 84 }, (_, i) => (i >= 4 && i < 22 ? '850000' : '0')),
  });
  await upsertCapitalItem(sql, {
    modelId: developmentModel,
    code: 'SOFT',
    name: 'Soft costs and fees',
    category: 'development_soft_cost',
    method: 'one_time',
    amount: '2600000',
    startDate: '2026-04-01',
  });
  await upsertDebtFacility(sql, {
    modelId: developmentModel,
    code: 'CONSTRUCTION',
    name: 'Construction facility',
    type: 'construction',
    commitment: '14000000',
    initialFunding: '0',
    fundingDate: '2026-05-01',
    draws: Array.from({ length: 18 }, (_, i) => ({
      date: `${2026 + Math.floor((4 + i) / 12)}-${String(((4 + i) % 12) + 1).padStart(2, '0')}-01`,
      amount: '700000',
    })),
    rateType: 'floating',
    indexCurve: 'SOFR',
    spread: '0.0300',
    rateFloor: '0.0400',
    interestOnlyMonths: 72,
    amortizationMonths: 0,
    termMonths: 72,
    originationFeePercent: '0.01',
    capitalizeInterest: true,
  });

  /* ---------------------------------------------------------------------- */
  /* Portfolio and initial calculations                                     */
  /* ---------------------------------------------------------------------- */

  const portfolioRows = (await sql`
    INSERT INTO portfolios (organization_id, name, description, strategy)
    VALUES (${organization.id}, 'Meridian Diversified Fund I',
            'Demonstration portfolio spanning industrial, office, retail, multifamily and development assets.',
            'Diversified core-plus')
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  const portfolioId = (portfolioRows[0] as { id: string }).id;
  for (const propertyId of Object.values(propertyIds)) {
    await sql`
      INSERT INTO portfolio_properties (portfolio_id, property_id, ownership_percent)
      VALUES (${portfolioId}, ${propertyId}, 1)
      ON CONFLICT DO NOTHING
    `;
  }

  // Calculate every model so the demonstration portfolio aggregates on first
  // load rather than showing an empty dashboard.
  //
  // Each calculation is run against a frozen version rather than against the
  // live tables, which is how the platform is meant to be used: a figure anyone
  // relies on should be reproducible from an input that cannot be edited
  // afterwards. It also means the demonstration data actually demonstrates
  // versioning instead of showing an empty Versions tab, and it gives
  // `pnpm drill:restore` a stored valuation to reproduce.
  for (const modelId of Object.values(modelIds)) {
    const modelInput = await buildModelInput(sql, organization.id, modelId);
    const version = await createModelVersion(sql, {
      modelId,
      modelInput,
      engineVersion: ENGINE_VERSION,
      label: 'Initial underwriting',
      notes: 'Created by the demonstration seed. All figures are fictional.',
      createdBy: analyst.id,
    });
    await runAndStoreCalculationFromInput(sql, modelId, modelInput, {
      withTrace: true,
      requestedBy: analyst.id,
      modelVersionId: version.id,
    });
  }

  // An approved budget and six months of actuals against it, so the variance
  // screen shows a real comparison rather than an empty form. The actuals are
  // invented and deliberately imperfect: rent slightly ahead in some months and
  // behind in others, repairs overspent once. A demonstration where everything
  // lands exactly on budget teaches nothing about what the screen is for.
  await seedBudgets(sql, organization.id, office.id, officeModel, analyst.id, reviewer.id);

  // A fund holding the demonstration portfolio, with two investors part-way
  // through their commitments. Half-called is deliberate: a fund shown fully
  // drawn hides the unfunded figure, which is the one an investor relations
  // team is asked about most often.
  await seedFund(sql, organization.id, portfolioId);

  return {
    organizationId: organization.id,
    users: [
      { email: 'owner@example.invalid', password: DEMO_PASSWORD, role: 'organization_owner' },
      { email: 'analyst@example.invalid', password: DEMO_PASSWORD, role: 'analyst' },
      { email: 'reviewer@example.invalid', password: DEMO_PASSWORD, role: 'reviewer' },
    ],
    propertyIds,
    modelIds,
    portfolioId,
  };
}

interface CreateModelInput {
  organizationId: string;
  propertyId: string;
  name: string;
  classification: string;
  ownerId: string;
  forecastStartDate: string;
  forecastMonths: number;
  discountRate: string;
  terminalCapRate: string;
  terminalNoiBasis: 'forward_12' | 'trailing_12';
  saleCostPercent: string;
  saleMonth: number;
  directCapRate?: string;
  acquisitionPrice: string;
  acquisitionCosts?: string;
  generalVacancyRate?: string;
  creditLossRate?: string;
}

async function createModel(sql: Sql, input: CreateModelInput): Promise<string> {
  const rows = (await sql`
    INSERT INTO models (
      organization_id, property_id, name, classification, owner_id, valuation_date,
      forecast_start_date, forecast_months, discount_rate, terminal_cap_rate,
      terminal_noi_basis, sale_cost_percent, sale_month, direct_cap_rate,
      acquisition_price, acquisition_costs, acquisition_date,
      general_vacancy_rate, credit_loss_rate, created_by
    ) VALUES (
      ${input.organizationId}, ${input.propertyId}, ${input.name}, ${input.classification},
      ${input.ownerId}, ${input.forecastStartDate}, ${input.forecastStartDate},
      ${input.forecastMonths}, ${input.discountRate}, ${input.terminalCapRate},
      ${input.terminalNoiBasis}, ${input.saleCostPercent}, ${input.saleMonth},
      ${input.directCapRate ?? null}, ${input.acquisitionPrice}, ${input.acquisitionCosts ?? '0'},
      ${input.forecastStartDate}, ${input.generalVacancyRate ?? '0'},
      ${input.creditLossRate ?? '0'}, ${input.ownerId}
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return (rows[0] as { id: string }).id;
}

/**
 * An approved budget for the office asset, and six months of actuals.
 *
 * Amounts follow the cash-flow convention the variance calculation depends on:
 * money in positive, money out negative. The actuals deviate from budget in
 * both directions on purpose — a demonstration where everything lands exactly
 * on budget teaches nothing about what the screen is for.
 */
async function seedBudgets(
  sql: Sql,
  organizationId: string,
  propertyId: string,
  modelId: string,
  authorId: string,
  reviewerId: string,
): Promise<void> {
  const months = [
    '2026-01-01',
    '2026-02-01',
    '2026-03-01',
    '2026-04-01',
    '2026-05-01',
    '2026-06-01',
  ];

  const accounts: Array<{
    code: string;
    name: string;
    category: AccountCategory;
    budget: string;
    /** Actual per month, in the same order as `months`. */
    actual: string[];
  }> = [
    {
      code: '4000',
      name: 'Base rent',
      category: 'revenue',
      budget: '412000',
      actual: ['412000', '412000', '408500', '415000', '415000', '415000'],
    },
    {
      code: '4200',
      name: 'Expense recoveries',
      category: 'revenue',
      budget: '96000',
      actual: ['94100', '94100', '94100', '97800', '97800', '97800'],
    },
    {
      code: '4300',
      name: 'Parking income',
      category: 'revenue',
      budget: '31000',
      actual: ['29500', '30100', '31400', '32200', '33100', '33800'],
    },
    {
      code: '5100',
      name: 'Repairs and maintenance',
      category: 'operating_expense',
      budget: '-48000',
      actual: ['-46200', '-45900', '-91300', '-47100', '-46800', '-47500'],
    },
    {
      code: '5200',
      name: 'Utilities',
      category: 'operating_expense',
      budget: '-64000',
      actual: ['-71400', '-69800', '-63200', '-58900', '-55100', '-54600'],
    },
    {
      code: '5300',
      name: 'Property taxes',
      category: 'operating_expense',
      budget: '-97000',
      actual: ['-97000', '-97000', '-97000', '-97000', '-97000', '-97000'],
    },
    {
      code: '5400',
      name: 'Management fee',
      category: 'operating_expense',
      budget: '-27000',
      actual: ['-26800', '-26800', '-26600', '-27200', '-27200', '-27200'],
    },
  ];

  const createPeriod = async (kind: string, label: string): Promise<string> => {
    const rows = (await sql`
      INSERT INTO budget_periods (organization_id, property_id, model_id, kind, fiscal_year, label)
      VALUES (${organizationId}, ${propertyId}, ${modelId}, ${kind}, 2026, ${label})
      ON CONFLICT (property_id, kind, fiscal_year, label) DO UPDATE SET label = EXCLUDED.label
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    return (rows[0] as { id: string }).id;
  };

  const budgetId = await createPeriod('approved_budget', 'FY2026 approved budget');
  const actualId = await createPeriod('actual', 'FY2026 actuals to June');

  const write = async (
    periodId: string,
    pick: (account: (typeof accounts)[number], index: number) => string | null,
  ): Promise<void> => {
    const rows: Array<Record<string, unknown>> = [];
    for (const account of accounts) {
      for (const [index, month] of months.entries()) {
        const amount = pick(account, index);
        if (amount === null) continue;
        rows.push({
          budget_period_id: periodId,
          account_code: account.code,
          account_name: account.name,
          account_category: account.category,
          period_month: month,
          amount,
        });
      }
    }
    await sql`DELETE FROM budget_entries WHERE budget_period_id = ${periodId}`;
    if (rows.length > 0) await sql`INSERT INTO budget_entries ${sql(rows as never)}`;
  };

  await write(budgetId, (account) => account.budget);
  await write(actualId, (account, index) => account.actual[index] ?? null);

  await sql`
    UPDATE budget_periods SET approved_by = ${reviewerId}, approved_at = now()
    WHERE id = ${budgetId} AND approved_at IS NULL
  `;

  // The overspend in March has an explanation attached, written by the analyst
  // and signed off by the reviewer, so the approval workflow is visible in the
  // demonstration data rather than only in the tests.
  const commentary = (await sql`
    INSERT INTO variance_commentary
      (property_id, fiscal_year, period_month, account_code, commentary, author_id)
    VALUES (
      ${propertyId}, 2026, '2026-03-01', '5100',
      ${'Roof membrane replaced after storm damage. Insurance recovery of 32,000 expected in Q3 and not yet recognised.'},
      ${authorId}
    )
    ON CONFLICT (property_id, fiscal_year, period_month, account_code) DO NOTHING
    RETURNING id
  `) as unknown as Array<{ id: string }>;

  const commentaryId = commentary[0]?.id;
  if (commentaryId) {
    await sql`
      UPDATE variance_commentary
      SET approved_by = ${reviewerId}, approved_at = now(), approved_text = commentary
      WHERE id = ${commentaryId}
    `;
  }
}

/**
 * A demonstration fund over the seeded portfolio.
 *
 * Figures are fictional and chosen so the screen shows something an investor
 * would recognise: two commitments of different sizes, called in two drawdowns,
 * one distribution returned, and half the capital still unfunded.
 */
async function seedFund(sql: Sql, organizationId: string, portfolioId: string): Promise<void> {
  const fundRows = (await sql`
    INSERT INTO funds (organization_id, name, vintage_year, committed_capital, currency, portfolio_id)
    VALUES (${organizationId}, 'Meridian Value Fund I (demonstration)', 2026, 50000000, 'USD',
            ${portfolioId})
    ON CONFLICT (organization_id, name) DO NOTHING
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  const fundId = fundRows[0]?.id;
  if (!fundId) return;

  const investors: Array<{ code: string; name: string; kind: string; commitment: string }> = [
    {
      code: 'LP-ALDER',
      name: 'Alder State Pension (fictional)',
      kind: 'lp',
      commitment: '35000000',
    },
    {
      code: 'LP-BRINE',
      name: 'Brine Family Office (fictional)',
      kind: 'lp',
      commitment: '12500000',
    },
    {
      code: 'GP-MERIDIAN',
      name: 'Meridian GP Co-invest (fictional)',
      kind: 'gp',
      commitment: '2500000',
    },
  ];

  const idByCode = new Map<string, string>();
  for (const investor of investors) {
    const rows = (await sql`
      INSERT INTO fund_investors (fund_id, organization_id, code, name, investor_class, commitment)
      VALUES (${fundId}, ${organizationId}, ${investor.code}, ${investor.name},
              ${investor.kind}, ${investor.commitment})
      ON CONFLICT (fund_id, code) DO NOTHING
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const id = rows[0]?.id;
    if (id) idByCode.set(investor.code, id);
  }

  // Two drawdowns of 25% each, then a first distribution. Every investor is
  // called the same proportion, which is how a fund normally draws.
  const schedule: Array<{ date: string; type: string; share: number }> = [
    { date: '2026-03-31', type: 'contribution', share: 0.25 },
    { date: '2026-09-30', type: 'contribution', share: 0.25 },
    { date: '2027-06-30', type: 'distribution', share: 0.06 },
  ];

  for (const entry of schedule) {
    for (const investor of investors) {
      const investorId = idByCode.get(investor.code);
      if (!investorId) continue;
      const amount = (Number(investor.commitment) * entry.share).toFixed(2);
      await sql`
        INSERT INTO fund_transactions (fund_id, investor_id, transaction_date, type, amount, reference)
        VALUES (${fundId}, ${investorId}, ${entry.date}, ${entry.type}, ${amount},
                ${entry.type === 'contribution' ? 'Capital call notice' : 'Distribution notice'})
      `;
    }
  }
}
