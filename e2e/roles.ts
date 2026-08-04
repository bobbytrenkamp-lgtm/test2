import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The accounts created by the demonstration seed.
 *
 * These are fictional credentials for a local development database. They are
 * the same three the seed prints, and they exist so the suite can prove that
 * what a role may do is decided by its capabilities and not by the screen.
 */
export const ROLES = {
  owner: {
    email: 'owner@example.invalid',
    name: 'Dana Whitfield',
    role: 'organization owner',
  },
  analyst: {
    email: 'analyst@example.invalid',
    name: 'Rowan Estrada',
    role: 'analyst',
  },
  reviewer: {
    email: 'reviewer@example.invalid',
    name: 'Priya Ramanathan',
    role: 'reviewer',
  },
} as const;

export type RoleKey = keyof typeof ROLES;

export const SEED_PASSWORD = 'demo-password-2026';

/** Where a signed-in session is cached between tests. */
export function sessionFile(role: RoleKey): string {
  return join(here, '.auth', `${role}.json`);
}

/** Fixtures from the seed that the assertions refer to by name. */
export const SEED = {
  organization: 'Meridian Real Estate Partners (demonstration data)',
  industrial: {
    property: 'Northgate Logistics Center',
    model: 'Acquisition underwriting - base case',
  },
  office: {
    property: 'Harborview Tower',
    model: 'Valuation - 31 December 2026',
  },
} as const;
