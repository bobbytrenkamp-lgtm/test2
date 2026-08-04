/**
 * Presentation formatting.
 *
 * Values arrive from the API as exact decimal strings. Formatting is the only
 * place they become JavaScript numbers, and that conversion happens purely for
 * display: nothing formatted here is ever sent back or used in a calculation.
 */

export function formatCurrency(
  value: string | number | null | undefined,
  currency = 'USD',
  options: { compact?: boolean; decimals?: number } = {},
): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    notation: options.compact ? 'compact' : 'standard',
    minimumFractionDigits: options.decimals ?? (options.compact ? 1 : 0),
    maximumFractionDigits: options.decimals ?? (options.compact ? 1 : 0),
  }).format(numeric);
}

export function formatPercent(value: string | number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(numeric);
}

export function formatNumber(value: string | number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(numeric);
}

export function formatMultiple(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${numeric.toFixed(2)}x`;
}

/** Formats an ISO date without letting the browser shift it by timezone. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parts = iso.slice(0, 10).split('-');
  if (parts.length !== 3) return iso;
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function formatMonth(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parts = iso.slice(0, 10).split('-');
  if (parts.length < 2) return iso;
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, 1));
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
}

export function titleCase(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}

export function isNegative(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return Number(value) < 0;
}
