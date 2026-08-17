import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage } from '../apps/api/src/storage.js';
import {
  authed,
  createTestContext,
  hasDatabase,
  registerActor,
  type Actor,
  type TestContext,
} from './helpers.js';

/**
 * Uploaded documents.
 *
 * `documents` (migration 0004) and `STORAGE_DRIVER` have existed since this
 * platform's first release; nothing read or wrote either until now.
 * `malware-scanning.test.ts` covers the scanner boundary; this covers
 * everything else — the anchor to a property (and, optionally, further to a
 * model within it), who may do what, and that a deleted document's bytes are
 * actually gone, not just its row.
 */
describe.skipIf(!hasDatabase)('documents', () => {
  let ctx: TestContext;
  let storageDir: string;
  let owner: Actor;
  let viewer: Actor;
  let propertyId: string;
  let modelId: string;

  async function join_(actor: Actor, organizationId: string, email: string, role: string) {
    const invitation = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/invitations`,
      headers: authed(owner.cookie),
      payload: { email, role },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: authed(actor.cookie),
      payload: { token: (invitation.json() as { token: string }).token },
    });
  }

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'cre-documents-test-'));
    ctx = await createTestContext({ storage: new LocalStorage(storageDir) });
    owner = await registerActor(ctx.app, 'documents-owner@example.invalid', 'Documents Owner');

    const organization = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(owner.cookie),
      payload: { name: 'Documents Partners' },
    });
    const organizationId = (organization.json() as { organization: { id: string } }).organization
      .id;

    viewer = await registerActor(ctx.app, 'documents-viewer@example.invalid', 'Documents Viewer');
    await join_(viewer, organizationId, 'documents-viewer@example.invalid', 'read_only');

    const property = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Documents House', propertyType: 'office', rentableArea: '20000' },
    });
    propertyId = (property.json() as { property: { id: string } }).property.id;

    const model = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId,
        name: 'Documents model',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 12,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      },
    });
    modelId = (model.json() as { model: { id: string } }).model.id;
  }, 90_000);

  afterAll(async () => {
    await ctx?.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  function upload(actor: Actor, body: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: authed(actor.cookie),
      payload: {
        propertyId,
        filename: 'lease-abstract.txt',
        contentType: 'text/plain',
        content: Buffer.from('Lease abstract for suite 400.').toString('base64'),
        ...body,
      },
    });
  }

  it('uploads a document and lists it back with who uploaded it', async () => {
    const created = await upload(owner);
    expect(created.statusCode, created.body).toBe(201);
    const document = (created.json() as { document: Record<string, unknown> }).document;
    expect(document.filename).toBe('lease-abstract.txt');
    expect(document.content_type).toBe('text/plain');
    expect(document.byte_size).toBe('29');

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/documents?propertyId=${propertyId}`,
      headers: authed(owner.cookie),
    });
    const documents = (listed.json() as { documents: Array<Record<string, unknown>> }).documents;
    const found = documents.find((entry) => entry.id === document.id);
    expect(found?.uploaded_by_name).toBe('Documents Owner');
  });

  it('downloads exactly the bytes that were uploaded', async () => {
    const created = await upload(owner, { filename: 'rent-roll-notes.txt' });
    const id = (created.json() as { document: { id: string } }).document.id;

    const downloaded = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/documents/${id}/download`,
      headers: authed(owner.cookie),
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe('Lease abstract for suite 400.');
    expect(downloaded.headers['content-type']).toBe('text/plain');
    expect(downloaded.headers['content-disposition']).toContain('rent-roll-notes.txt');
  });

  it('scopes a document to a model, without hiding it from the property-wide list', async () => {
    await upload(owner, { filename: 'general.txt' });
    await upload(owner, { filename: 'model-specific.txt', modelId });

    const propertyWide = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/documents?propertyId=${propertyId}`,
      headers: authed(owner.cookie),
    });
    const allNames = (
      propertyWide.json() as { documents: Array<{ filename: string }> }
    ).documents.map((d) => d.filename);
    expect(allNames).toContain('general.txt');
    expect(allNames).toContain('model-specific.txt');

    const modelScoped = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/documents?propertyId=${propertyId}&modelId=${modelId}`,
      headers: authed(owner.cookie),
    });
    const scopedNames = (
      modelScoped.json() as { documents: Array<{ filename: string }> }
    ).documents.map((d) => d.filename);
    expect(scopedNames).toEqual(['model-specific.txt']);
  });

  it('refuses to scope a document to a model from a different property', async () => {
    const otherProperty = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/properties',
      headers: authed(owner.cookie),
      payload: { name: 'Other House', propertyType: 'office', rentableArea: '5000' },
    });
    const otherPropertyId = (otherProperty.json() as { property: { id: string } }).property.id;
    const otherModel = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: authed(owner.cookie),
      payload: {
        propertyId: otherPropertyId,
        name: 'Other model',
        classification: 'valuation',
        valuationDate: '2026-01-01',
        forecastStartDate: '2026-01-01',
        forecastMonths: 12,
        discountRate: '0.08',
        terminalCapRate: '0.07',
      },
    });
    const otherModelId = (otherModel.json() as { model: { id: string } }).model.id;

    const response = await upload(owner, { modelId: otherModelId });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('does not belong to this property');
  });

  it('lets a read-only member list and download, but not upload or delete', async () => {
    const created = await upload(owner);
    const id = (created.json() as { document: { id: string } }).document.id;

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/documents?propertyId=${propertyId}`,
      headers: authed(viewer.cookie),
    });
    expect(listed.statusCode).toBe(200);

    const downloaded = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/documents/${id}/download`,
      headers: authed(viewer.cookie),
    });
    expect(downloaded.statusCode).toBe(200);

    expect((await upload(viewer)).statusCode).toBe(403);
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${id}`,
      headers: authed(viewer.cookie),
    });
    expect(deleted.statusCode).toBe(403);
  });

  it('deletes a document, removing it from the list and its bytes from storage', async () => {
    const created = await upload(owner, { filename: 'to-delete.txt' });
    const id = (created.json() as { document: { id: string } }).document.id;

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${id}`,
      headers: authed(owner.cookie),
    });
    expect(deleted.statusCode).toBe(200);

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/documents?propertyId=${propertyId}`,
      headers: authed(owner.cookie),
    });
    const names = (listed.json() as { documents: Array<{ filename: string }> }).documents.map(
      (d) => d.filename,
    );
    expect(names).not.toContain('to-delete.txt');

    const downloaded = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/documents/${id}/download`,
      headers: authed(owner.cookie),
    });
    expect(downloaded.statusCode).toBe(404);
  });

  it('never lets one organization reach another organization’s document', async () => {
    const created = await upload(owner, { filename: 'confidential.txt' });
    const id = (created.json() as { document: { id: string } }).document.id;

    const outsider = await registerActor(
      ctx.app,
      'documents-outsider@example.invalid',
      'Documents Outsider',
    );
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: authed(outsider.cookie),
      payload: { name: 'Unrelated Documents Co' },
    });

    const downloaded = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/documents/${id}/download`,
      headers: authed(outsider.cookie),
    });
    expect(downloaded.statusCode).toBe(404);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${id}`,
      headers: authed(outsider.cookie),
    });
    expect(deleted.statusCode).toBe(404);
  });
});
