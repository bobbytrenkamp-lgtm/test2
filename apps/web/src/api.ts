import type {
  Capability,
  Diagnostic,
  Entitlements,
  ModelResult,
  Role,
  TraceEntry,
} from '@cre/domain-models';

/**
 * API client.
 *
 * Every state-changing request carries the X-Requested-With header the server
 * requires, which is what makes the SameSite=Lax session cookie safe against
 * cross-site form posts. Credentials are always included so the cookie travels
 * with the request.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /**
     * A short, speakable id ("ERR-482910") for an unexpected server fault —
     * present only for those, never for an ordinary validation or permission
     * refusal, which already explain themselves. Lets a customer quote
     * something to support instead of a stack trace they were never shown.
     */
    readonly reference?: string | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'include',
    headers: {
      'X-Requested-With': 'cre-platform',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    let code = 'REQUEST_FAILED';
    let message = `Request failed (${response.status}).`;
    let details: unknown;
    let reference: string | null | undefined;
    try {
      const payload = (await response.json()) as {
        error?: { code: string; message: string; details?: unknown; reference?: string | null };
      };
      if (payload.error) {
        code = payload.error.code;
        message = payload.error.message;
        details = payload.error.details;
        reference = payload.error.reference;
      }
    } catch {
      // A non-JSON error body (a proxy error page, for example) keeps the
      // generic message rather than surfacing raw HTML to the user.
    }
    throw new ApiError(response.status, code, message, details, reference);
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return (await response.text()) as unknown as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

export interface Session {
  user: { id: string; email: string; name: string; mfaEnrolled: boolean };
  organizationId: string | null;
  role: Role | null;
  capabilities: Capability[];
  organizations: Array<{ organization_id: string; name: string; slug: string; role: Role }>;
  entitlements: Entitlements | null;
}

export interface Property {
  id: string;
  name: string;
  property_type: string;
  property_subtype: string | null;
  city: string | null;
  state_region: string | null;
  market: string | null;
  submarket: string | null;
  rentable_area: string | null;
  unit_count: number;
  currency: string;
  area_unit: string;
  year_built: number | null;
  acquisition_price: string | null;
  acquisition_date: string | null;
  tags: string[];
}

export interface Space {
  id: string;
  code: string;
  floor: string | null;
  space_type: string;
  area: string;
  unit_count: number;
  is_non_revenue: boolean;
}

export interface Model {
  id: string;
  property_id: string;
  name: string;
  classification: string;
  status: string;
  valuation_date: string;
  forecast_start_date: string;
  forecast_months: number;
  fiscal_year_start_month: number;
  proration_convention: string;
  currency: string;
  area_unit: string;
  notes: string | null;
  discount_rate: string | null;
  discounting_convention: string;
  terminal_cap_rate: string | null;
  terminal_noi_basis: string;
  sale_cost_percent: string;
  sale_month: number | null;
  direct_cap_rate: string | null;
  acquisition_price: string | null;
  acquisition_costs: string;
  general_vacancy_rate: string;
  credit_loss_rate: string;
  /** Incremented on every write; sent back on save to detect a collision. */
  version: number;
}

export interface Lease {
  id: string;
  code: string;
  tenant_id: string;
  tenant_name: string;
  status: string;
  area: string;
  unit_count: number;
  space_codes: string[];
  commencement_date: string;
  rent_start_date: string | null;
  expiration_date: string;
  base_rent: string;
  base_rent_basis: string;
  rent_steps: Array<{ startDate: string; amount: string; basis: string }>;
  escalation: Record<string, unknown>;
  recovery: Record<string, unknown>;
  notes: string | null;
  /** Incremented on every write; sent back on save to detect a collision. */
  version: number;
}

export interface Tenant {
  id: string;
  name: string;
  industry: string | null;
  is_anchor: boolean;
}

export type CashFlowResponse = Pick<
  ModelResult,
  | 'periods'
  | 'annual'
  | 'monthly'
  | 'occupancy'
  | 'valuations'
  | 'returns'
  | 'diagnostics'
  | 'debtSchedules'
  | 'waterfall'
  | 'recoveryDetail'
  | 'leaseCashFlows'
> & {
  runId: string;
  engineVersion: string;
  calculatedAt: string;
  currency: string;
  areaUnit: string;
};

export interface WorkflowStep {
  key: string;
  label: string;
  tab: string;
  optional: boolean;
  done: boolean;
  detail: string;
}

export interface WorkflowResponse {
  steps: WorkflowStep[];
}

export interface CalculateResponse {
  runId: string;
  engineVersion: string;
  diagnostics: Diagnostic[];
  annual: ModelResult['annual'];
  returns: ModelResult['returns'];
  valuations: ModelResult['valuations'];
}

export interface TraceResponse {
  runId: string;
  total: number;
  entries: TraceEntry[];
}

export interface PortfolioSummary {
  id: string;
  name: string;
  description: string | null;
  strategy: string | null;
  property_count: number;
}

export interface BudgetPeriod {
  id: string;
  property_id: string;
  model_id: string | null;
  kind: string;
  fiscal_year: number;
  label: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  entry_count?: number;
}

export interface BudgetEntry {
  id: string;
  account_code: string;
  account_name: string;
  account_category: string;
  period_month: string;
  amount: string;
  department: string | null;
  commentary: string | null;
}

export interface VarianceRow {
  accountCode: string;
  accountName: string;
  category: string;
  base: string;
  comparison: string;
  variance: string;
  variancePercent: string | null;
  designation: 'favourable' | 'unfavourable' | 'neutral';
}

export interface VarianceGroup {
  category: string;
  rows: VarianceRow[];
  base: string;
  comparison: string;
  variance: string;
  variancePercent: string | null;
  designation: VarianceRow['designation'];
}

export interface VarianceReport {
  fromMonth: string | null;
  toMonth: string | null;
  groups: VarianceGroup[];
  rows: VarianceRow[];
  totalBase: string;
  totalComparison: string;
  totalVariance: string;
  totalVariancePercent: string | null;
  totalDesignation: 'favourable' | 'unfavourable' | 'neutral';
  unmatchedAccounts: string[];
}

export interface VarianceResponse {
  base: { id: string; label: string };
  comparison: { label: string };
  report: VarianceReport;
}

export interface VarianceCommentary {
  id: string;
  property_id: string;
  fiscal_year: number;
  period_month: string;
  account_code: string;
  commentary: string;
  approved_text: string | null;
  author_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
}
