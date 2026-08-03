import type { Diagnostic, DiagnosticSeverity, TraceEntry } from '@cre/domain-models';
import { Decimal, type DecimalInput, d } from './decimal.js';

/**
 * Recording of the engine's reasoning. Traces are how a user answers "where did
 * this number come from?" — the calculation inspector reads them directly.
 *
 * Tracing is opt-in per run because a 240-month model with several hundred
 * leases would otherwise emit millions of entries. Callers ask for the subset
 * they need via a target filter.
 */
export interface TraceOptions {
  enabled: boolean;
  /** When set, only targets whose prefix matches one of these are recorded. */
  targetPrefixes?: string[];
  /** Hard ceiling so a runaway model cannot exhaust memory. */
  maxEntries?: number;
}

export class TraceRecorder {
  private readonly entries: TraceEntry[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private truncated = false;

  constructor(private readonly options: TraceOptions) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  record(entry: Omit<TraceEntry, 'formulaVersion'> & { formulaVersion?: string }): void {
    if (!this.options.enabled) return;
    const prefixes = this.options.targetPrefixes;
    if (prefixes && prefixes.length > 0 && !prefixes.some((p) => entry.target.startsWith(p))) {
      return;
    }
    const max = this.options.maxEntries ?? 200_000;
    if (this.entries.length >= max) {
      if (!this.truncated) {
        this.truncated = true;
        this.diagnostics.push({
          code: 'TRACE_TRUNCATED',
          severity: 'informational',
          message: `Calculation trace stopped after ${max} entries. Narrow the trace filter to inspect a specific value.`,
        });
      }
      return;
    }
    this.entries.push({ formulaVersion: '1', ...entry });
  }

  diagnostic(
    code: string,
    severity: DiagnosticSeverity,
    message: string,
    subject?: string,
    field?: string,
  ): void {
    // Diagnostics are deduplicated on (code, subject, field) so a per-period
    // loop cannot flood the model health panel with the same finding.
    const exists = this.diagnostics.some(
      (existing) =>
        existing.code === code && existing.subject === subject && existing.field === field,
    );
    if (exists) return;
    this.diagnostics.push({ code, severity, message, subject, field });
  }

  error(code: string, message: string, subject?: string, field?: string): void {
    this.diagnostic(code, 'error', message, subject, field);
  }

  warn(code: string, message: string, subject?: string, field?: string): void {
    this.diagnostic(code, 'warning', message, subject, field);
  }

  getTrace(): TraceEntry[] {
    return this.entries;
  }

  getDiagnostics(): Diagnostic[] {
    return this.diagnostics;
  }

  hasErrors(): boolean {
    return this.diagnostics.some((entry) => entry.severity === 'error');
  }
}

/** Convenience for building the `inputs` map of a trace entry. */
export function traceInputs(values: Record<string, DecimalInput | string | number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) {
      out[key] = '';
    } else if (value instanceof Decimal) {
      out[key] = value.toString();
    } else if (typeof value === 'string' && !/^-?\d*\.?\d+$/.test(value)) {
      out[key] = value;
    } else {
      out[key] = d(value as DecimalInput).toString();
    }
  }
  return out;
}

/**
 * Thrown for input problems the engine cannot forecast through at all, as
 * distinct from diagnostics, which describe a model that still produces
 * numbers. The API converts this into a 422 with the diagnostic list attached.
 */
export class CalculationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = 'CalculationError';
  }
}
