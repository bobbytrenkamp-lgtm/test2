import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildModelInput, getModel } from '@cre/database';
import {
  analyzeImport,
  COLLECTIONS,
  COLLECTION_KEYS,
  MODEL_SECTIONS,
  parseImportPayload,
} from '@cre/domain-models';
import { notFound, requireCapability, unprocessable } from '../context.js';

/**
 * The PDF-assumption import pipeline's read-only surface: what this release
 * can be told (the target dictionary), and what a specific paste would mean
 * for this specific model (the analyzer preview).
 *
 * Neither route writes anything. Turning a preview into a change is a
 * separate, later step through the existing assumption-proposal machinery —
 * see `docs/claude-assumption-import.md`.
 */
export async function registerAssumptionImportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The target dictionary: every field this release can write, in the terms
   * an external extraction tool has to use to address one. Model-scoped
   * rather than global so a collection's `codes` reflects what actually
   * exists on this model, not a hypothetical.
   */
  app.get('/models/:id/assumption-import/targets', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound('That model does not exist in this organization.');

    const input = await buildModelInput(request.db, context.organizationId, id);

    const modelLevel = Object.entries(MODEL_SECTIONS).flatMap(([section, fields]) =>
      fields.map((field) => ({
        target: `${section}.${field.field}`,
        label: field.label,
        valueType: field.valueType,
        unit: field.unit ?? null,
        enumValues: field.enumValues ?? null,
        writable: true,
      })),
    );

    const collections = COLLECTIONS.map((collection) => {
      const key = COLLECTION_KEYS[collection.collection] ?? collection.collection;
      const rows = (input as unknown as Record<string, unknown>)[key];
      const codes = Array.isArray(rows)
        ? rows
            .filter((row): row is { id: string } => Boolean(row) && typeof row === 'object' && 'id' in row)
            .map((row) => row.id)
        : [];

      return {
        collection: collection.collection,
        noun: collection.noun,
        /** Business codes this model actually has for this collection today. */
        codes,
        fields: collection.fields.map((field) => ({
          target: `${collection.collection}.<code>.${field.field}`,
          field: field.field,
          label: field.label,
          valueType: field.valueType,
          unit: field.unit ?? null,
          enumValues: field.enumValues ?? null,
          writable: true,
        })),
      };
    });

    return { modelLevel, collections };
  });

  /**
   * Turns pasted `cre-assumption-import` output into a full preview of what
   * accepting it would mean for this model. Performs zero writes and is safe
   * to call repeatedly — see `analyzeImport`'s doc comment for the pipeline
   * this runs.
   */
  app.post('/models/:id/assumption-import/analyze', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ paste: z.string().max(2_000_000) }).parse(request.body);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound('That model does not exist in this organization.');

    const parsed = parseImportPayload(body.paste);
    if (!parsed.ok) throw unprocessable(parsed.error);

    const input = await buildModelInput(request.db, context.organizationId, id);
    return analyzeImport(parsed.data, input);
  });
}
