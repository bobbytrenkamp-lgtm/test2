import { leaseStatusEnum, rentBasisEnum } from '@cre/domain-models';
import type { Lease } from '../api.js';
import {
  parseDate,
  parseDecimal,
  parseLeaseStatus,
  parseText,
  type ColumnDef,
} from '../grid/columns.js';
import { formatCurrency, formatDate, formatNumber, titleCase } from '../format.js';

/**
 * The rent roll's columns.
 *
 * Kept apart from the tab that renders them because this is the part worth
 * reading on its own: it is the whole statement of what an analyst may edit in
 * the grid, what each field will accept, and what the default view shows.
 *
 * ## Which fields are editable here
 *
 * The ones whose meaning is complete in a single cell. Area, rent, the term
 * dates, status and basis are each a single number or a single choice, and the
 * batch endpoint validates the term across the pair before writing.
 *
 * Escalations, recoveries, rent steps, options and leasing costs are *not*
 * here. Each is a structured record — an escalation has a type, a rate, a
 * frequency and a compounding rule that only make sense together — and
 * flattening one into a cell would either lose part of it or invent a syntax
 * for typing it. Those stay in the lease editor, which the grid opens on
 * demand. The column list says so rather than leaving the analyst to discover
 * that a column they expected is missing.
 */

/** Columns whose values the batch endpoint accepts. */
export const EDITABLE_LEASE_FIELDS = [
  'status',
  'area',
  'commencementDate',
  'expirationDate',
  'baseRent',
  'baseRentBasis',
] as const;

export function leaseColumns(options: {
  currency: string;
  areaUnit: string;
}): Array<ColumnDef<Lease>> {
  const { currency, areaUnit } = options;

  return [
    {
      key: 'code',
      label: 'Lease',
      width: 140,
      frozen: true,
      editable: false,
      value: (lease) => lease.code,
      help: 'The lease reference. Used in traces and reports, so it cannot be edited here.',
    },
    {
      key: 'tenantName',
      label: 'Tenant',
      width: 200,
      frozen: true,
      editable: false,
      value: (lease) => lease.tenant_name ?? '',
      help: 'Change the tenant in the lease editor — it is a link to a tenant record, not text.',
    },
    {
      key: 'spaces',
      label: 'Suite',
      width: 110,
      editable: false,
      value: (lease) => lease.space_codes.join(', '),
      display: (_lease, value) => value || '—',
    },
    {
      key: 'status',
      label: 'Status',
      width: 120,
      value: (lease) => lease.status,
      display: (_lease, value) => titleCase(value),
      parse: parseLeaseStatus(leaseStatusEnum.options),
      options: leaseStatusEnum.options.map((option) => ({
        value: option,
        label: titleCase(option),
      })),
    },
    {
      key: 'area',
      label: `Area (${areaUnit})`,
      width: 110,
      numeric: true,
      value: (lease) => lease.area,
      display: (_lease, value) => formatNumber(value, 0),
      parse: parseDecimal({ min: 0, label: 'Area' }),
      help: 'Accepts 12,500 or 12500. Negative area is refused.',
    },
    {
      key: 'commencementDate',
      label: 'Commences',
      width: 120,
      value: (lease) => lease.commencement_date?.slice(0, 10) ?? '',
      display: (_lease, value) => formatDate(value),
      parse: parseDate,
      help: 'Enter 2026-03-04 or 4 Mar 2026. An ambiguous 03/04/2026 is refused rather than guessed.',
    },
    {
      key: 'expirationDate',
      label: 'Expires',
      width: 120,
      value: (lease) => lease.expiration_date?.slice(0, 10) ?? '',
      display: (_lease, value) => formatDate(value),
      parse: parseDate,
      help: 'Must be after the commencement date; the server refuses the save otherwise.',
    },
    {
      key: 'baseRent',
      label: `Base rent (${currency})`,
      width: 140,
      numeric: true,
      value: (lease) => lease.base_rent,
      display: (_lease, value) => formatCurrency(value, currency, { decimals: 2 }),
      parse: parseDecimal({ min: 0, label: 'Base rent' }),
      help: 'On the basis in the next column. Accepts $1,234.50 and (500) for a negative.',
    },
    {
      key: 'baseRentBasis',
      label: 'Basis',
      width: 160,
      value: (lease) => lease.base_rent_basis,
      display: (_lease, value) => titleCase(value),
      parse: (raw) => {
        const value = raw
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_');
        const allowed: readonly string[] = rentBasisEnum.options;
        return allowed.includes(value)
          ? { ok: true, value }
          : { ok: false, reason: `“${raw.trim()}” is not one of: ${allowed.join(', ')}.` };
      },
      options: rentBasisEnum.options.map((option) => ({
        value: option,
        label: titleCase(option),
      })),
      help: 'Changing the basis reinterprets the rent beside it; it does not convert the figure.',
    },
    {
      key: 'steps',
      label: 'Steps',
      width: 80,
      numeric: true,
      editable: false,
      value: (lease) => String(lease.rent_steps.length),
      display: (_lease, value) => (value === '0' ? '—' : value),
      help: 'A rent step is a dated schedule. Edit it in the lease editor.',
    },
    {
      key: 'escalation',
      label: 'Escalation',
      width: 150,
      editable: false,
      hiddenByDefault: true,
      value: (lease) => describeEscalation(lease.escalation),
      help: 'A structured record — type, rate, frequency. Edit it in the lease editor.',
    },
    {
      key: 'recovery',
      label: 'Recovery',
      width: 150,
      editable: false,
      hiddenByDefault: true,
      value: (lease) => {
        const method = lease.recovery?.['method'];
        return typeof method === 'string' ? titleCase(method) : '—';
      },
      help: 'Base years, stops and caps travel together. Edit them in the lease editor.',
    },
  ];
}

/**
 * A one-line reading of an escalation.
 *
 * Read-only and deliberately lossy: it exists so an analyst scanning the grid
 * can see *that* a lease escalates and roughly how, and knows to open the
 * editor when the detail matters. Presenting it as editable text would invite
 * someone to type into it and lose the compounding rule.
 */
function describeEscalation(escalation: Record<string, unknown>): string {
  const type = escalation?.['type'];
  if (typeof type !== 'string' || type === 'none') return '—';
  const rate = escalation['rate'];
  if (type === 'fixed_percent' && (typeof rate === 'string' || typeof rate === 'number')) {
    return `${(Number(rate) * 100).toFixed(2)}% p.a.`;
  }
  if (type === 'fixed_amount' && (typeof rate === 'string' || typeof rate === 'number')) {
    return `+${rate} p.a.`;
  }
  return titleCase(type);
}

/** Maps a grid column key to the field name the batch endpoint expects. */
export function fieldForColumn(key: string): (typeof EDITABLE_LEASE_FIELDS)[number] | null {
  return (EDITABLE_LEASE_FIELDS as readonly string[]).includes(key)
    ? (key as (typeof EDITABLE_LEASE_FIELDS)[number])
    : null;
}

/** A lease with its pending edits applied, for display and for saving. */
export function withPending(lease: Lease, pending: Record<string, string> | undefined): Lease {
  if (!pending) return lease;
  const next = { ...lease };
  if (pending['status'] !== undefined) next.status = pending['status'];
  if (pending['area'] !== undefined) next.area = pending['area'];
  if (pending['commencementDate'] !== undefined) {
    next.commencement_date = pending['commencementDate'];
  }
  if (pending['expirationDate'] !== undefined) next.expiration_date = pending['expirationDate'];
  if (pending['baseRent'] !== undefined) next.base_rent = pending['baseRent'];
  if (pending['baseRentBasis'] !== undefined) next.base_rent_basis = pending['baseRentBasis'];
  return next;
}

export { parseText };
