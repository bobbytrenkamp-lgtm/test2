import type { Sql } from '../client.js';

/**
 * Properties and models somebody chose to keep at hand.
 *
 * Every query is scoped by user *and* organization. The user scope is obvious;
 * the organization scope is what stops a list assembled in one organization
 * from showing an asset the person can only see in another, which would leak a
 * name across a boundary the rest of the platform is careful about.
 *
 * The read resolves each entry against the table its type names and drops the
 * ones whose target is gone. A deleted model therefore disappears from the
 * dashboard on its own, without a cleanup job and without a foreign key that
 * could only point at one of the two tables.
 */

export interface FavouriteRow {
  entity_type: 'property' | 'model';
  entity_id: string;
  name: string;
  /** For a model, the property it belongs to; for a property, its market. */
  context: string | null;
  created_at: Date;
}

export async function listFavourites(
  sql: Sql,
  userId: string,
  organizationId: string,
): Promise<FavouriteRow[]> {
  return (await sql`
    SELECT f.entity_type, f.entity_id, p.name, p.market AS context, f.created_at
    FROM user_favourites f
    JOIN properties p ON p.id = f.entity_id AND p.organization_id = f.organization_id
    WHERE f.user_id = ${userId}
      AND f.organization_id = ${organizationId}
      AND f.entity_type = 'property'

    UNION ALL

    SELECT f.entity_type, f.entity_id, m.name, p.name AS context, f.created_at
    FROM user_favourites f
    JOIN models m ON m.id = f.entity_id AND m.organization_id = f.organization_id
    JOIN properties p ON p.id = m.property_id
    WHERE f.user_id = ${userId}
      AND f.organization_id = ${organizationId}
      AND f.entity_type = 'model'

    ORDER BY created_at DESC
  `) as unknown as FavouriteRow[];
}

/**
 * Pins something, or does nothing if it is already pinned.
 *
 * Idempotent because the control is a toggle and a double click is a double
 * click, not an error worth showing somebody.
 */
export async function addFavourite(
  sql: Sql,
  input: {
    userId: string;
    organizationId: string;
    entityType: 'property' | 'model';
    entityId: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO user_favourites (user_id, organization_id, entity_type, entity_id)
    VALUES (${input.userId}, ${input.organizationId}, ${input.entityType}, ${input.entityId})
    ON CONFLICT (user_id, organization_id, entity_type, entity_id) DO NOTHING
  `;
}

export async function removeFavourite(
  sql: Sql,
  input: {
    userId: string;
    organizationId: string;
    entityType: 'property' | 'model';
    entityId: string;
  },
): Promise<void> {
  await sql`
    DELETE FROM user_favourites
    WHERE user_id = ${input.userId}
      AND organization_id = ${input.organizationId}
      AND entity_type = ${input.entityType}
      AND entity_id = ${input.entityId}
  `;
}
