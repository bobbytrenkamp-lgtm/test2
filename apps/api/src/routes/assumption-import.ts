import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '@cre/database';
import {
  buildModelInput,
  createImportSession,
  getModel,
  insertDecidedImportProposal,
  listImportSessions,
  writeAudit,
} from '@cre/database';
import type { AnalyzedAssumption, ImportSource } from '@cre/domain-models';
import {
  analyzeImport,
  COLLECTIONS,
  COLLECTION_KEYS,
  describeTarget,
  MODEL_SECTIONS,
  parseImportPayload,
} from '@cre/domain-models';
import { notFound, requireCapability, unprocessable } from '../context.js';
import { assertEditable } from './models.js';
import { applyAssumption, AssumptionApplyError } from '../assumption-write.js';

/** Statuses an analyst may actually choose to apply. Everything else needs resolving first. */
const APPLICABLE_STATUSES = new Set(['new', 'changed', 'needsReview']);

function describeSourceName(source: ImportSource): string {
  const system = [source.system, source.skill].filter((part): part is string => Boolean(part)).join(' — ');
  const label = system || 'Imported assumptions';
  return source.documentName ? `${label} (${source.documentName})` : label;
}

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

  /**
   * Applies the assumptions an analyst selected on the review screen.
   *
   * The paste is re-analyzed here rather than trusting a client-supplied
   * preview, so what gets written is always exactly what a fresh analysis of
   * this same paste against this model's current state says — the same
   * guarantee `assumption-proposals.ts`'s decision route makes by reading
   * `ModelInput` at decision time rather than trusting a stale figure. Every
   * selected item becomes an already-accepted proposal and is applied through
   * the same write path a person's edit or a single proposal's acceptance
   * uses; nothing here writes to a model table directly. The whole batch is
   * one transaction — a partial import is a position nobody selected, so one
   * unwritable field refuses the whole request rather than applying the rest
   * and reporting the one that failed after the fact.
   */
  app.post('/models/:id/assumption-import/apply', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        paste: z.string().max(2_000_000),
        targets: z.array(z.string().min(1)).min(1).max(500),
      })
      .parse(request.body);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound('That model does not exist in this organization.');
    assertEditable(model.status);

    const parsed = parseImportPayload(body.paste);
    if (!parsed.ok) throw unprocessable(parsed.error);

    const input = await buildModelInput(request.db, context.organizationId, id);
    const analysis = analyzeImport(parsed.data, input);
    const byTarget = new Map(analysis.items.map((item) => [item.target, item]));

    const selected: AnalyzedAssumption[] = body.targets.map((target) => {
      const item = byTarget.get(target);
      if (!item) {
        throw unprocessable(
          `${target} was not part of the analyzed import. Re-analyze the paste and try again.`,
        );
      }
      if (!APPLICABLE_STATUSES.has(item.status)) {
        throw unprocessable(
          `${target} cannot be applied: ${item.reason ?? `its status is "${item.status}".`}`,
        );
      }
      if (item.extractedValue === null || item.valueType === null) {
        throw unprocessable(`${target} has no value to apply.`);
      }
      return item;
    });

    const sourceName = describeSourceName(analysis.source);

    const { session, applied } = await request.db.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;
      const createdSession = await createImportSession(tx, {
        organizationId: context.organizationId,
        modelId: id,
        sourceSystem: analysis.source.system ?? null,
        sourceSkill: analysis.source.skill ?? null,
        documentName: analysis.source.documentName ?? null,
        documentDate: analysis.source.documentDate ?? null,
        receivedCount: analysis.summary.received,
        recognizedCount: analysis.summary.recognized,
        appliedCount: selected.length,
        keptCount: analysis.summary.same,
        unresolvedCount:
          analysis.summary.needsReview + analysis.summary.conflicts + analysis.summary.missingTarget,
        unsupportedCount: analysis.summary.unsupported,
        createdBy: context.userId,
      });

      const appliedItems: Array<{ target: string; proposalId: string }> = [];
      for (const item of selected) {
        const resolved = describeTarget(item.target);
        if (!resolved.ok) throw unprocessable(`${item.target}: ${resolved.reason}`);

        const proposal = await insertDecidedImportProposal(tx, {
          organizationId: context.organizationId,
          modelId: id,
          target: item.target,
          value: item.extractedValue as string,
          valueType: item.valueType as NonNullable<typeof item.valueType>,
          sourceName,
          confidence: item.confidence,
          evidence: { evidence: item.evidence, extraction: item.extraction },
          notes: item.notes,
          createdBy: context.userId,
          importSessionId: createdSession.id,
        });

        try {
          await applyAssumption(
            tx,
            id,
            item.target,
            item.extractedValue as string,
            item.valueType as NonNullable<typeof item.valueType>,
          );
        } catch (error) {
          if (error instanceof AssumptionApplyError) {
            throw unprocessable(`${item.target}: ${error.message}`);
          }
          throw error;
        }

        appliedItems.push({ target: item.target, proposalId: proposal.id });
      }

      return { session: createdSession, applied: appliedItems };
    });

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'assumption_import.applied',
      entityType: 'import_session',
      entityId: session.id,
      modelId: id,
      propertyId: model.property_id,
      metadata: {
        documentName: session.document_name,
        sourceName,
        appliedTargets: applied.map((entry) => entry.target),
      },
      ipAddress: request.ip,
    });

    return { importSession: session, applied, summary: analysis.summary };
  });

  /**
   * Import sessions, newest first — the provenance screen's entry point for
   * "what did this document change." Each session expands into its own
   * proposals via `GET /assumption-proposals?importSessionId=...`, which
   * already carries every field-level detail; this list only needs to say
   * which sessions exist.
   */
  app.get('/models/:id/assumption-import/sessions', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound('That model does not exist in this organization.');

    return { sessions: await listImportSessions(request.db, context.organizationId, id) };
  });
}
