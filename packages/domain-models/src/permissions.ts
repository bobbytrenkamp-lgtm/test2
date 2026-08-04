import type { Role } from './enums.js';

/**
 * Capability model.
 *
 * Roles are mapped to capabilities in one place so that the API, the worker and
 * the web client cannot drift apart on what a role may do. The server is
 * always the authority: the client uses this table only to decide what to show,
 * and every protected route re-checks it against the session.
 */
export const CAPABILITIES = [
  'organization:manage',
  'organization:invite',
  'member:manage',
  'property:read',
  'property:write',
  'property:delete',
  'portfolio:read',
  'portfolio:write',
  'model:read',
  'model:write',
  'model:delete',
  'model:calculate',
  'model:submit',
  'model:approve',
  'model:publish',
  'import:run',
  'export:run',
  'report:read',
  'budget:write',
  'task:write',
  'comment:write',
  'audit:read',
  'diagnostic:acknowledge',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const READ_ONLY: Capability[] = ['property:read', 'portfolio:read', 'model:read', 'report:read'];

const ANALYST: Capability[] = [
  ...READ_ONLY,
  'property:write',
  'model:write',
  'model:calculate',
  'model:submit',
  'import:run',
  'export:run',
  'task:write',
  'comment:write',
];

const REVIEWER: Capability[] = [
  ...READ_ONLY,
  'model:calculate',
  'export:run',
  'task:write',
  'comment:write',
  'model:approve',
  'diagnostic:acknowledge',
  'audit:read',
];

const MANAGER: Capability[] = [
  ...ANALYST,
  'portfolio:write',
  'model:approve',
  'model:publish',
  'model:delete',
  'budget:write',
  'diagnostic:acknowledge',
  'audit:read',
];

const ADMINISTRATOR: Capability[] = [
  ...MANAGER,
  'organization:invite',
  'member:manage',
  'property:delete',
];

const OWNER: Capability[] = [...ADMINISTRATOR, 'organization:manage'];

const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  organization_owner: OWNER,
  administrator: ADMINISTRATOR,
  portfolio_manager: MANAGER,
  asset_manager: MANAGER,
  acquisitions: ANALYST,
  valuation: [...ANALYST, 'model:approve', 'diagnostic:acknowledge'],
  analyst: ANALYST,
  reviewer: REVIEWER,
  read_only: READ_ONLY,
};

export function capabilitiesForRole(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role] ?? [];
}

export function roleHasCapability(role: Role | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return capabilitiesForRole(role).includes(capability);
}

/** Human-readable role labels for the administration screens. */
export const ROLE_LABELS: Record<Role, string> = {
  organization_owner: 'Organization owner',
  administrator: 'Administrator',
  portfolio_manager: 'Portfolio manager',
  asset_manager: 'Asset manager',
  acquisitions: 'Acquisitions',
  valuation: 'Valuation',
  analyst: 'Analyst',
  reviewer: 'Reviewer',
  read_only: 'Read-only viewer',
};

/**
 * Approval transitions. A model can only move between statuses along an edge
 * defined here, and each edge names the capability required to travel it.
 */
export const APPROVAL_TRANSITIONS: Array<{
  from: string;
  to: string;
  capability: Capability;
  decision: 'submitted' | 'approved' | 'rejected' | 'withdrawn';
}> = [
  { from: 'draft', to: 'analyst_review', capability: 'model:submit', decision: 'submitted' },
  {
    from: 'analyst_review',
    to: 'manager_review',
    capability: 'model:submit',
    decision: 'submitted',
  },
  { from: 'analyst_review', to: 'draft', capability: 'model:approve', decision: 'rejected' },
  { from: 'manager_review', to: 'approved', capability: 'model:approve', decision: 'approved' },
  { from: 'manager_review', to: 'draft', capability: 'model:approve', decision: 'rejected' },
  { from: 'approved', to: 'published', capability: 'model:publish', decision: 'approved' },
  { from: 'approved', to: 'draft', capability: 'model:approve', decision: 'withdrawn' },
  { from: 'published', to: 'superseded', capability: 'model:publish', decision: 'approved' },
  { from: 'published', to: 'archived', capability: 'model:publish', decision: 'approved' },
  { from: 'superseded', to: 'archived', capability: 'model:publish', decision: 'approved' },
];

export function findTransition(from: string, to: string) {
  return APPROVAL_TRANSITIONS.find((edge) => edge.from === from && edge.to === to) ?? null;
}
