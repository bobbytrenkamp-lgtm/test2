import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * The read-only surface of the PDF-assumption import pipeline: the target
 * dictionary an extraction tool addresses fields with, and the analyzer that
 * turns a paste into a preview against a real model.
 *
 * Both routes are read-only by contract. The tests that matter most here
 * confirm that: analyzing the same paste twice changes nothing, and a
 * pasted document — however large its numbers — never touches the model
 * until a proposal is explicitly accepted through the existing decision
 * route (`tests/assumption-proposals.test.ts` covers that boundary; this
 * file only has to prove the analyzer never gets there itself).
 */
describe.skipIf(!hasDatabase)('assumption import: targets and analyze', () => {
  let ctx: TestContext;
  let owner: Actor;
  let orgId: string;
  let modelId: string;

  const importDoc = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      format: 'cre-assumption-import',
      version: 1,
      source: { kind: 'imported', system: 'Claude Skill', documentName: 'Raleigh Industrial OM.pdf' },
      property: { name: 'Raleigh Industrial Center' },
      assumptions: [],
      records: [],
      ...overrides,
    });

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await registerActor(ctx.app, 'import@example.invalid', 'Import Owner');

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Raleigh Industrial Partners' },
    });
    orgId = (organization.json() as { organization: { id: string } }).organization.id;

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Raleigh Industrial Center', propertyType: 'industrial', rentableArea: '250000' },
    });
    const propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Base case',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 60,
        discountRate: '0.08',
        terminalCapRate: '0.065',
        generalVacancyRate: '0.05',
        saleMonth: 60,
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/models/${modelId}/market-leasing/INDUSTRIAL_STD`,
      headers: authed(owner.cookie),
      payload: {
        name: 'Industrial Standard',
        marketRent: '11.00',
        marketRentBasis: 'per_area_per_year',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function targets(actor: Actor = owner): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/assumption-import/targets`,
      headers: authed(actor.cookie),
    });
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
  }

  async function analyze(
    paste: string,
    actor: Actor = owner,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/assumption-import/analyze`,
      headers: authed(actor.cookie),
      payload: { paste },
    });
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
  }

  async function modelRow(): Promise<Record<string, unknown>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}`,
      headers: authed(owner.cookie),
    });
    return (response.json() as { model: Record<string, unknown> }).model;
  }

  /* ---------------------------------------------------------------------- */
  /* Target dictionary                                                      */
  /* ---------------------------------------------------------------------- */

  it('lists the writable model-level targets with their type and unit', async () => {
    const { statusCode, body } = await targets();
    expect(statusCode).toBe(200);
    const modelLevel = body.modelLevel as Array<Record<string, unknown>>;
    const capRate = modelLevel.find((entry) => entry.target === 'valuation.terminalCapRate');
    expect(capRate).toMatchObject({ label: 'Exit capitalization rate', valueType: 'decimal', unit: 'rate', writable: true });
  });

  it('lists each collection with this model’s actual business codes', async () => {
    const { body } = await targets();
    const collections = body.collections as Array<Record<string, unknown>>;
    const marketLeasing = collections.find((entry) => entry.collection === 'marketLeasing');
    expect(marketLeasing?.codes).toEqual(['INDUSTRIAL_STD']);
    const fields = marketLeasing?.fields as Array<Record<string, unknown>>;
    expect(fields.some((f) => f.field === 'marketRent' && f.unit === 'currency')).toBe(true);
  });

  it('refuses the target dictionary to another organization’s model', async () => {
    const stranger = await registerActor(ctx.app, 'stranger-import@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings' },
    });
    const { statusCode } = await targets(stranger);
    expect(statusCode).toBe(404);
  });

  /* ---------------------------------------------------------------------- */
  /* Analyze: parsing                                                       */
  /* ---------------------------------------------------------------------- */

  it('explains a malformed paste in plain language, without erasing it server-side', async () => {
    const { statusCode, body } = await analyze('{ this is not json');
    expect(statusCode).toBe(422);
    expect((body as { error: { message: string } }).error.message).toContain('not valid JSON');
  });

  it('refuses an unsupported version rather than misreading it', async () => {
    const { statusCode, body } = await analyze(importDoc({ version: 2 }));
    expect(statusCode).toBe(422);
    expect((body as { error: { message: string } }).error.message).toContain('version');
  });

  it('tolerates a markdown code fence around the paste', async () => {
    const fenced = '```json\n' + importDoc() + '\n```';
    const { statusCode } = await analyze(fenced);
    expect(statusCode).toBe(200);
  });

  /* ---------------------------------------------------------------------- */
  /* Analyze: comparison                                                    */
  /* ---------------------------------------------------------------------- */

  it('finds a new assumption with no current value', async () => {
    const { statusCode, body } = await analyze(
      importDoc({
        assumptions: [
          {
            target: 'valuation.acquisitionPrice',
            value: '48500000',
            valueType: 'decimal',
            displayValue: '$48,500,000',
            confidence: 0.95,
            extraction: { method: 'explicit' },
            evidence: [{ page: 4, label: 'Purchase Price', sourceValue: '$48,500,000' }],
          },
        ],
      }),
    );
    expect(statusCode).toBe(200);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'new', currentValue: null, extractedValue: '48500000' });
  });

  it('finds a changed assumption against the model’s real value', async () => {
    const { body } = await analyze(
      importDoc({
        assumptions: [{ target: 'valuation.terminalCapRate', value: '0.0625', valueType: 'decimal' }],
      }),
    );
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0]?.status).toBe('changed');
    expect(Number(items[0]?.currentValue)).toBeCloseTo(0.065, 8);
    expect(items[0]?.extractedValue).toBe('0.0625');
  });

  it('confirms agreement rather than reporting a failure', async () => {
    const { body } = await analyze(
      importDoc({
        assumptions: [{ target: 'valuation.terminalCapRate', value: '0.065', valueType: 'decimal' }],
      }),
    );
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0]?.status).toBe('same');
  });

  it('flattens a record bundle for an existing market leasing profile field by field', async () => {
    const { body } = await analyze(
      importDoc({
        records: [
          {
            collection: 'marketLeasing',
            code: 'INDUSTRIAL_STD',
            fields: { marketRent: '12.50' },
            evidence: { marketRent: [{ page: 28, sourceValue: '$12.50/SF' }] },
          },
        ],
      }),
    );
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.target).toBe('marketLeasing.INDUSTRIAL_STD.marketRent');
    expect(items[0]?.status).toBe('changed');
    expect(Number(items[0]?.currentValue)).toBeCloseTo(11.0, 6);
    expect(items[0]?.extractedValue).toBe('12.50');
  });

  it('reports a bundle whose code does not exist as a missing collection record', async () => {
    const { body } = await analyze(
      importDoc({
        records: [
          { collection: 'marketLeasing', code: 'RETAIL_SMALL_SHOP', fields: { marketRent: '24.00' }, evidence: {} },
        ],
      }),
    );
    const missing = body.missingCollectionRecords as Array<Record<string, unknown>>;
    expect(missing).toEqual([
      expect.objectContaining({ collection: 'marketLeasing', code: 'RETAIL_SMALL_SHOP' }),
    ]);
  });

  it('merges the same value reported on two pages, and conflicts two different ones', async () => {
    const { body: merged } = await analyze(
      importDoc({
        assumptions: [
          { target: 'valuation.discountRate', value: '0.09', valueType: 'decimal', evidence: [{ page: 5 }] },
          { target: 'valuation.discountRate', value: '0.09', valueType: 'decimal', evidence: [{ page: 40 }] },
        ],
      }),
    );
    const mergedItems = merged.items as Array<{ evidence: unknown[] }>;
    expect(mergedItems).toHaveLength(1);
    expect(mergedItems[0]?.evidence).toHaveLength(2);

    const { body: conflicting } = await analyze(
      importDoc({
        assumptions: [
          { target: 'valuation.discountRate', value: '0.09', valueType: 'decimal', evidence: [{ page: 5 }] },
          { target: 'valuation.discountRate', value: '0.10', valueType: 'decimal', evidence: [{ page: 40 }] },
        ],
      }),
    );
    const conflictItems = conflicting.items as Array<Record<string, unknown>>;
    expect(conflictItems[0]?.status).toBe('conflict');
    expect(conflictItems[0]?.extractedValue).toBeNull();
  });

  it('flags an unsupported target and lease terms by name, never dropping them', async () => {
    const { body } = await analyze(
      importDoc({
        assumptions: [
          { target: 'tenant_credit_score', value: '82', valueType: 'integer' },
          { target: 'leases.L-1.baseRent', value: '38.00', valueType: 'decimal' },
        ],
      }),
    );
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.status).toBe('unsupported');
    const lease = items.find((item) => item.target === 'leases.L-1.baseRent');
    expect(lease?.reason).toContain('rent roll');
  });

  it('warns on a property mismatch without failing the analysis', async () => {
    const { statusCode, body } = await analyze(importDoc({ property: { name: 'A Different Warehouse Entirely' } }));
    expect(statusCode).toBe(200);
    expect(body.propertyMismatch).toBe(true);
  });

  it('never writes to the model, no matter what it analyzes', async () => {
    const before = await modelRow();
    await analyze(
      importDoc({
        assumptions: [{ target: 'valuation.terminalCapRate', value: '0.0625', valueType: 'decimal' }],
      }),
    );
    // Twice, since the endpoint has to be safe to call repeatedly.
    await analyze(
      importDoc({
        assumptions: [{ target: 'valuation.terminalCapRate', value: '0.0625', valueType: 'decimal' }],
      }),
    );
    const after = await modelRow();
    expect(after).toEqual(before);
  });

  it('cannot be analyzed against another organization’s model', async () => {
    const stranger = await registerActor(ctx.app, 'stranger-analyze@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings 2' },
    });
    const { statusCode } = await analyze(importDoc(), stranger);
    expect(statusCode).toBe(404);
  });

  /* ---------------------------------------------------------------------- */
  /* Apply: bulk accept through the existing proposal write path             */
  /* ---------------------------------------------------------------------- */

  async function apply(
    paste: string,
    targetsToApply: string[],
    actor: Actor = owner,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/models/${modelId}/assumption-import/apply`,
      headers: authed(actor.cookie),
      payload: { paste, targets: targetsToApply },
    });
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
  }

  async function sessions(actor: Actor = owner): Promise<Array<Record<string, unknown>>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/assumption-import/sessions`,
      headers: authed(actor.cookie),
    });
    return (response.json() as { sessions: Array<Record<string, unknown>> }).sessions;
  }

  it('applies selected assumptions into the actual model, through an accepted proposal each', async () => {
    const before = await modelRow();
    expect(before.acquisition_price).toBeNull();

    const paste = importDoc({
      assumptions: [
        {
          target: 'valuation.acquisitionPrice',
          value: '48500000',
          valueType: 'decimal',
          confidence: 0.95,
          extraction: { method: 'explicit' },
          evidence: [{ page: 4, label: 'Purchase Price', sourceValue: '$48,500,000' }],
        },
      ],
      records: [
        {
          collection: 'marketLeasing',
          code: 'INDUSTRIAL_STD',
          fields: { marketRent: '12.50' },
          evidence: { marketRent: [{ page: 28, sourceValue: '$12.50/SF' }] },
        },
      ],
    });

    const before2 = await sessions();
    const { statusCode, body } = await apply(paste, [
      'valuation.acquisitionPrice',
      'marketLeasing.INDUSTRIAL_STD.marketRent',
    ]);
    expect(statusCode).toBe(200);
    expect(body.applied).toHaveLength(2);
    const importSession = body.importSession as Record<string, unknown>;
    expect(importSession.applied_count).toBe(2);
    expect(importSession.document_name).toBe('Raleigh Industrial OM.pdf');

    const after = await modelRow();
    expect(Number(after.acquisition_price)).toBeCloseTo(48500000, 2);

    const rent = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/market-leasing`,
      headers: authed(owner.cookie),
    });
    const profile = (rent.json() as { items: Array<Record<string, unknown>> }).items.find(
      (item) => item.code === 'INDUSTRIAL_STD',
    );
    expect(Number(profile?.market_rent)).toBeCloseTo(12.5, 6);

    // A new session appeared, expandable into the two proposals it produced.
    const after2 = await sessions();
    expect(after2).toHaveLength(before2.length + 1);
    const proposalsForSession = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/models/${modelId}/assumption-proposals?importSessionId=${importSession.id}`,
      headers: authed(owner.cookie),
    });
    const proposals = (proposalsForSession.json() as { proposals: Array<Record<string, unknown>> })
      .proposals;
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.status === 'accepted')).toBe(true);
  });

  it('refuses to apply a target whose status does not allow it, and writes nothing at all', async () => {
    const before = await modelRow();
    const beforeSessions = await sessions();

    const paste = importDoc({
      assumptions: [
        // Would-be-fine on its own...
        { target: 'valuation.saleCostPercent', value: '0.02', valueType: 'decimal' },
      ],
      records: [
        // ...but bundled with a target the analysis marks unresolvable.
        {
          collection: 'marketLeasing',
          code: 'RETAIL_SMALL_SHOP',
          fields: { marketRent: '24.00' },
          evidence: {},
        },
      ],
    });

    const { statusCode, body } = await apply(paste, [
      'valuation.saleCostPercent',
      'marketLeasing.RETAIL_SMALL_SHOP.marketRent',
    ]);
    expect(statusCode).toBe(422);
    expect((body as { error: { message: string } }).error.message).toContain(
      'marketLeasing.RETAIL_SMALL_SHOP.marketRent',
    );

    // Atomic: the field that *would* have been fine was not applied either,
    // and no session was left behind for a batch that never went through.
    const after = await modelRow();
    expect(after).toEqual(before);
    expect(await sessions()).toHaveLength(beforeSessions.length);
  });

  it('refuses to re-apply a target that already matches, rather than writing a no-op proposal', async () => {
    const paste = importDoc({
      assumptions: [{ target: 'valuation.terminalCapRate', value: '0.065', valueType: 'decimal' }],
    });
    const { statusCode, body } = await apply(paste, ['valuation.terminalCapRate']);
    expect(statusCode).toBe(422);
    expect((body as { error: { message: string } }).error.message).toContain('valuation.terminalCapRate');
  });

  it('refuses to apply a target that was not part of the analyzed paste', async () => {
    const { statusCode, body } = await apply(importDoc(), ['valuation.discountRate']);
    expect(statusCode).toBe(422);
    expect((body as { error: { message: string } }).error.message).toContain('not part of the analyzed import');
  });

  it('cannot be applied by a read-only member of the same organization', async () => {
    const viewer = await registerActor(ctx.app, 'import-viewer@example.invalid', 'Import Viewer');
    const invitation = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${orgId}/invitations`,
      headers: authed(owner.cookie),
      payload: { email: 'import-viewer@example.invalid', role: 'read_only' },
    });
    expect(invitation.statusCode).toBe(201);
    const token = (invitation.json() as { token: string }).token;
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: authed(viewer.cookie),
      payload: { token },
    });

    const paste = importDoc({
      assumptions: [{ target: 'valuation.discountRate', value: '0.09', valueType: 'decimal' }],
    });
    const { statusCode } = await apply(paste, ['valuation.discountRate'], viewer);
    expect(statusCode).toBe(403);
  });

  it('cannot be applied against another organization’s model', async () => {
    const stranger = await registerActor(ctx.app, 'stranger-apply@example.invalid', 'Stranger');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(stranger.cookie),
      payload: { name: 'Unrelated Holdings 3' },
    });
    const { statusCode } = await apply(importDoc(), ['valuation.discountRate'], stranger);
    expect(statusCode).toBe(404);
  });
});
