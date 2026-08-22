import type { Sql } from '../client.js';

export interface PropertyRow {
  id: string;
  organization_id: string;
  name: string;
  property_type: string;
  property_subtype: string | null;
  address_line1: string | null;
  city: string | null;
  state_region: string | null;
  postal_code: string | null;
  country: string;
  market: string | null;
  submarket: string | null;
  currency: string;
  area_unit: 'sqft' | 'sqm';
  year_built: number | null;
  rentable_area: string | null;
  gross_building_area: string | null;
  land_area: string | null;
  unit_count: number;
  parking_count: number;
  building_count: number;
  ownership_percent: string;
  acquisition_date: string | null;
  acquisition_price: string | null;
  tags: string[];
  created_at: Date;
  updated_at: Date;
}

export interface PropertyListFilters {
  search?: string;
  propertyType?: string;
  market?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

/**
 * Every property in the organization, unpaginated.
 *
 * `listProperties` caps at 200 rows because it backs a browsing screen; an
 * offboarding export cannot silently drop the properties past the cap, so
 * this is a separate, deliberately unbounded query for that one use.
 */
export async function listAllProperties(sql: Sql, organizationId: string): Promise<PropertyRow[]> {
  return (await sql`
    SELECT * FROM properties
    WHERE organization_id = ${organizationId} AND deleted_at IS NULL
    ORDER BY name
  `) as unknown as PropertyRow[];
}

export async function listProperties(
  sql: Sql,
  organizationId: string,
  filters: PropertyListFilters = {},
): Promise<{ rows: PropertyRow[]; total: number }> {
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;
  const search = filters.search?.trim() ? `%${filters.search.trim()}%` : null;

  const rows = (await sql`
    SELECT * FROM properties
    WHERE organization_id = ${organizationId}
      AND deleted_at IS NULL
      AND (${search}::text IS NULL OR name ILIKE ${search}::text OR city ILIKE ${search}::text)
      AND (${filters.propertyType ?? null}::text IS NULL OR property_type = ${filters.propertyType ?? null}::text)
      AND (${filters.market ?? null}::text IS NULL OR market = ${filters.market ?? null}::text)
      AND (${filters.tags ?? null}::text[] IS NULL OR tags && ${filters.tags ?? null}::text[])
    ORDER BY name
    LIMIT ${limit} OFFSET ${offset}
  `) as unknown as PropertyRow[];

  const counted = (await sql`
    SELECT count(*)::int AS total FROM properties
    WHERE organization_id = ${organizationId}
      AND deleted_at IS NULL
      AND (${search}::text IS NULL OR name ILIKE ${search}::text OR city ILIKE ${search}::text)
      AND (${filters.propertyType ?? null}::text IS NULL OR property_type = ${filters.propertyType ?? null}::text)
      AND (${filters.market ?? null}::text IS NULL OR market = ${filters.market ?? null}::text)
      AND (${filters.tags ?? null}::text[] IS NULL OR tags && ${filters.tags ?? null}::text[])
  `) as unknown as Array<{ total: number }>;

  return { rows, total: counted[0]?.total ?? 0 };
}

export async function getProperty(
  sql: Sql,
  organizationId: string,
  propertyId: string,
): Promise<PropertyRow | null> {
  const rows = (await sql`
    SELECT * FROM properties
    WHERE id = ${propertyId} AND organization_id = ${organizationId} AND deleted_at IS NULL
  `) as unknown as PropertyRow[];
  return rows[0] ?? null;
}

export interface CreatePropertyInput {
  organizationId: string;
  name: string;
  propertyType: string;
  propertySubtype?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  stateRegion?: string | null;
  postalCode?: string | null;
  country?: string;
  market?: string | null;
  submarket?: string | null;
  currency?: string;
  areaUnit?: 'sqft' | 'sqm';
  yearBuilt?: number | null;
  yearRenovated?: number | null;
  rentableArea?: string | null;
  grossBuildingArea?: string | null;
  landArea?: string | null;
  unitCount?: number;
  parkingCount?: number;
  buildingCount?: number;
  ownershipPercent?: string;
  acquisitionDate?: string | null;
  acquisitionPrice?: string | null;
  tags?: string[];
  createdBy?: string | null;
}

export async function createProperty(sql: Sql, input: CreatePropertyInput): Promise<PropertyRow> {
  const rows = (await sql`
    INSERT INTO properties (
      organization_id, name, property_type, property_subtype, address_line1, city,
      state_region, postal_code, country, market, submarket, currency, area_unit,
      year_built, year_renovated, rentable_area, gross_building_area, land_area, unit_count,
      parking_count, building_count, ownership_percent, acquisition_date,
      acquisition_price, tags, created_by
    ) VALUES (
      ${input.organizationId}, ${input.name.trim()}, ${input.propertyType},
      ${input.propertySubtype ?? null}, ${input.addressLine1 ?? null}, ${input.city ?? null},
      ${input.stateRegion ?? null}, ${input.postalCode ?? null}, ${input.country ?? 'US'},
      ${input.market ?? null}, ${input.submarket ?? null}, ${input.currency ?? 'USD'},
      ${input.areaUnit ?? 'sqft'}, ${input.yearBuilt ?? null}, ${input.yearRenovated ?? null},
      ${input.rentableArea ?? null},
      ${input.grossBuildingArea ?? null}, ${input.landArea ?? null}, ${input.unitCount ?? 0},
      ${input.parkingCount ?? 0}, ${input.buildingCount ?? 1}, ${input.ownershipPercent ?? '1'},
      ${input.acquisitionDate ?? null}, ${input.acquisitionPrice ?? null},
      ${input.tags ?? []}, ${input.createdBy ?? null}
    )
    RETURNING *
  `) as unknown as PropertyRow[];
  return rows[0] as PropertyRow;
}

export async function updateProperty(
  sql: Sql,
  organizationId: string,
  propertyId: string,
  patch: Partial<CreatePropertyInput>,
): Promise<PropertyRow | null> {
  /*
   * Every optional field follows the same rule `models.ts`'s task PATCH
   * does: an absent key leaves the column alone, an explicit `null` clears
   * it. `COALESCE(new, old)` cannot tell those apart -- it treats an
   * explicit `null` exactly like "not sent" and silently keeps the old
   * value -- which is exactly the bug this route had: a client clearing
   * `submarket` (or any other nullish field here) by sending `null` got a
   * 200 back and the field never actually changed. `field === undefined`
   * is checked against the *patch*, not against SQL, so it survives being
   * sent through as a bound parameter either way; the branch not taken is a
   * bare column reference, not a value, so it is never coerced through the
   * parameter path at all.
   */
  const keep = (column: string) => sql.unsafe(column);
  const rows = (await sql`
    UPDATE properties SET
      name = ${patch.name === undefined ? keep('name') : patch.name},
      property_type = ${patch.propertyType === undefined ? keep('property_type') : patch.propertyType},
      property_subtype = ${patch.propertySubtype === undefined ? keep('property_subtype') : patch.propertySubtype},
      address_line1 = ${patch.addressLine1 === undefined ? keep('address_line1') : patch.addressLine1},
      city = ${patch.city === undefined ? keep('city') : patch.city},
      state_region = ${patch.stateRegion === undefined ? keep('state_region') : patch.stateRegion},
      postal_code = ${patch.postalCode === undefined ? keep('postal_code') : patch.postalCode},
      market = ${patch.market === undefined ? keep('market') : patch.market},
      submarket = ${patch.submarket === undefined ? keep('submarket') : patch.submarket},
      year_built = ${patch.yearBuilt === undefined ? keep('year_built') : patch.yearBuilt},
      year_renovated = ${patch.yearRenovated === undefined ? keep('year_renovated') : patch.yearRenovated},
      rentable_area = ${patch.rentableArea === undefined ? keep('rentable_area') : patch.rentableArea},
      gross_building_area = ${patch.grossBuildingArea === undefined ? keep('gross_building_area') : patch.grossBuildingArea},
      land_area = ${patch.landArea === undefined ? keep('land_area') : patch.landArea},
      unit_count = ${patch.unitCount === undefined ? keep('unit_count') : patch.unitCount},
      parking_count = ${patch.parkingCount === undefined ? keep('parking_count') : patch.parkingCount},
      building_count = ${patch.buildingCount === undefined ? keep('building_count') : patch.buildingCount},
      ownership_percent = ${patch.ownershipPercent === undefined ? keep('ownership_percent') : patch.ownershipPercent},
      acquisition_date = ${patch.acquisitionDate === undefined ? keep('acquisition_date') : patch.acquisitionDate},
      acquisition_price = ${patch.acquisitionPrice === undefined ? keep('acquisition_price') : patch.acquisitionPrice},
      tags = ${patch.tags === undefined ? keep('tags') : patch.tags},
      updated_at = now()
    WHERE id = ${propertyId} AND organization_id = ${organizationId} AND deleted_at IS NULL
    RETURNING *
  `) as unknown as PropertyRow[];
  return rows[0] ?? null;
}

/**
 * Soft deletion. Property records are retained because models, audit entries
 * and valuations reference them and must remain explainable after the asset
 * leaves the portfolio.
 */
export async function softDeleteProperty(
  sql: Sql,
  organizationId: string,
  propertyId: string,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE properties SET deleted_at = now()
    WHERE id = ${propertyId} AND organization_id = ${organizationId} AND deleted_at IS NULL
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

export interface SpaceRow {
  id: string;
  property_id: string;
  building_id: string | null;
  code: string;
  floor: string | null;
  space_type: string;
  area: string;
  unit_count: number;
  is_non_revenue: boolean;
  sort_order: number;
}

export async function listSpaces(sql: Sql, propertyId: string): Promise<SpaceRow[]> {
  return (await sql`
    SELECT id, property_id, building_id, code, floor, space_type, area, unit_count,
           is_non_revenue, sort_order
    FROM spaces WHERE property_id = ${propertyId}
    ORDER BY sort_order, code
  `) as unknown as SpaceRow[];
}

export async function upsertSpace(
  sql: Sql,
  input: {
    propertyId: string;
    code: string;
    buildingId?: string | null;
    floor?: string | null;
    spaceType?: string;
    area: string;
    unitCount?: number;
    isNonRevenue?: boolean;
    sortOrder?: number;
  },
): Promise<SpaceRow> {
  const rows = (await sql`
    INSERT INTO spaces (property_id, building_id, code, floor, space_type, area, unit_count, is_non_revenue, sort_order)
    VALUES (
      ${input.propertyId}, ${input.buildingId ?? null}, ${input.code}, ${input.floor ?? null},
      ${input.spaceType ?? 'office'}, ${input.area}, ${input.unitCount ?? 0},
      ${input.isNonRevenue ?? false}, ${input.sortOrder ?? 0}
    )
    ON CONFLICT (property_id, code) DO UPDATE SET
      building_id = EXCLUDED.building_id,
      floor = EXCLUDED.floor,
      space_type = EXCLUDED.space_type,
      area = EXCLUDED.area,
      unit_count = EXCLUDED.unit_count,
      is_non_revenue = EXCLUDED.is_non_revenue,
      sort_order = EXCLUDED.sort_order,
      updated_at = now()
    RETURNING id, property_id, building_id, code, floor, space_type, area, unit_count,
              is_non_revenue, sort_order
  `) as unknown as SpaceRow[];
  return rows[0] as SpaceRow;
}

export async function deleteSpace(sql: Sql, propertyId: string, spaceId: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM spaces WHERE id = ${spaceId} AND property_id = ${propertyId} RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}
