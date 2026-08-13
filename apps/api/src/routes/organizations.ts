import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  acceptInvitation,
  buildModelInput,
  createInvitation,
  createOrganization,
  getLatestCalculation,
  getMembershipRole,
  getOrganization,
  getOrganizationExportExtras,
  listAllProperties,
  listMemberships,
  listModels,
  listOrganizationMembers,
  removeMember,
  setMemberRole,
  switchSessionOrganization,
  writeAudit,
} from '@cre/database';
import { ENGINE_VERSION } from '@cre/calculation-engine';
import { toPortableDocument } from '@cre/reporting';
import { roleEnum } from '@cre/domain-models';
import type { Env } from '../env.js';
import {
  HttpError,
  badRequest,
  forbidden,
  notFound,
  queryBoolean,
  requireCapability,
  requireUser,
} from '../context.js';

export async function registerOrganizationRoutes(app: FastifyInstance, env: Env): Promise<void> {
  app.get('/organizations', async (request) => {
    const auth = requireUser(request);
    return { organizations: await listMemberships(request.db, auth.user.id) };
  });

  app.post('/organizations', async (request, reply) => {
    const auth = requireUser(request);
    const body = z
      .object({
        name: z.string().min(1).max(200),
        baseCurrency: z.string().length(3).optional(),
        areaUnit: z.enum(['sqft', 'sqm']).optional(),
      })
      .parse(request.body);

    const organization = await createOrganization(request.db, {
      name: body.name,
      ownerId: auth.user.id,
      baseCurrency: body.baseCurrency,
      areaUnit: body.areaUnit,
    });
    // The creator's session moves to the new organization immediately.
    await switchSessionOrganization(request.db, auth.session.id, organization.id);

    await writeAudit(request.db, {
      organizationId: organization.id,
      userId: auth.user.id,
      action: 'organization.created',
      entityType: 'organization',
      entityId: organization.id,
      newValue: { name: organization.name },
      ipAddress: request.ip,
    });

    return reply.status(201).send({ organization });
  });

  /**
   * Switching organizations rewrites the session's organization pointer after
   * re-verifying membership, so a user cannot select an organization they have
   * been removed from by replaying an old request.
   */
  app.post('/organizations/:id/switch', async (request) => {
    const auth = requireUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const role = await getMembershipRole(request.db, auth.user.id, id);
    if (!role) throw forbidden('You are not a member of that organization.');
    await switchSessionOrganization(request.db, auth.session.id, id);
    return { organizationId: id, role };
  });

  app.get('/organizations/:id/members', async (request) => {
    const context = requireCapability(request, 'member:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden('You can only manage members of the organization you are signed in to.');
    }
    return { members: await listOrganizationMembers(request.db, id) };
  });

  app.patch('/organizations/:id/members/:userId', async (request) => {
    const context = requireCapability(request, 'member:manage');
    const params = z
      .object({ id: z.string().uuid(), userId: z.string().uuid() })
      .parse(request.params);
    if (params.id !== context.organizationId) throw forbidden();
    const body = z.object({ role: roleEnum }).parse(request.body);

    // Only an owner may create another owner.
    if (body.role === 'organization_owner' && context.role !== 'organization_owner') {
      throw forbidden('Only an organization owner can grant the owner role.');
    }

    const ok = await setMemberRole(request.db, params.id, params.userId, body.role);
    if (!ok) {
      throw badRequest('An organization must keep at least one owner.');
    }
    await writeAudit(request.db, {
      organizationId: params.id,
      userId: context.userId,
      action: 'member.role_changed',
      entityType: 'membership',
      entityId: params.userId,
      newValue: { role: body.role },
      ipAddress: request.ip,
    });
    return { ok: true };
  });

  app.delete('/organizations/:id/members/:userId', async (request) => {
    const context = requireCapability(request, 'member:manage');
    const params = z
      .object({ id: z.string().uuid(), userId: z.string().uuid() })
      .parse(request.params);
    if (params.id !== context.organizationId) throw forbidden();
    const ok = await removeMember(request.db, params.id, params.userId);
    if (!ok) throw badRequest('An organization must keep at least one owner.');
    await writeAudit(request.db, {
      organizationId: params.id,
      userId: context.userId,
      action: 'member.removed',
      entityType: 'membership',
      entityId: params.userId,
      ipAddress: request.ip,
    });
    return { ok: true };
  });

  /**
   * Invitations. No mail provider is bundled, so in a non-production
   * environment the token is returned for the caller to deliver. A deployment
   * wires a mailer and drops the token from the response.
   */
  app.post('/organizations/:id/invitations', async (request, reply) => {
    const context = requireCapability(request, 'organization:invite');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (id !== context.organizationId) throw forbidden();
    const body = z.object({ email: z.string().email(), role: roleEnum }).parse(request.body);
    if (body.role === 'organization_owner' && context.role !== 'organization_owner') {
      throw forbidden('Only an organization owner can invite another owner.');
    }

    const invitation = await createInvitation(request.db, {
      organizationId: id,
      email: body.email,
      role: body.role,
      invitedBy: context.userId,
    });
    await writeAudit(request.db, {
      organizationId: id,
      userId: context.userId,
      action: 'invitation.created',
      entityType: 'invitation',
      entityId: invitation.id,
      newValue: { email: body.email, role: body.role },
      ipAddress: request.ip,
    });

    return reply.status(201).send({
      id: invitation.id,
      ...(env.NODE_ENV === 'production' ? {} : { token: invitation.token }),
    });
  });

  /**
   * Everything the organization owns, as one downloadable document — the
   * organization-level counterpart to a single model's portable export
   * (`GET /models/:id/export/json`). Exists for offboarding and for a
   * customer's own peace of mind about data ownership: nothing here depends
   * on staying a customer of this platform to get the data back out.
   *
   * Gated on `organization:manage` rather than a narrower capability,
   * because bulk-exporting every property and model an organization holds is
   * exactly the kind of action that should require the same authority as
   * managing the organization itself, not merely reading one property at a
   * time.
   *
   * Calculation results are included by default and can be dropped
   * (`includeResults=false`) for a faster export of structure alone. Traces
   * are never included — see `toPortableDocument`, which already strips them
   * for the single-model export this reuses.
   */
  app.get('/organizations/:id/export', async (request, reply) => {
    const context = requireCapability(request, 'organization:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden('You can only export the organization you are signed in to.');
    }
    const query = z.object({ includeResults: queryBoolean(true) }).parse(request.query);

    const organization = await getOrganization(request.db, id);
    if (!organization) throw notFound('That organization does not exist.');

    const [members, properties, models, extras] = await Promise.all([
      listOrganizationMembers(request.db, id),
      listAllProperties(request.db, id),
      listModels(request.db, id),
      getOrganizationExportExtras(request.db, id),
    ]);

    const modelDocuments = await Promise.all(
      models.map(async (model) => {
        const input = await buildModelInput(request.db, id, model.id);
        const latest = query.includeResults
          ? await getLatestCalculation(request.db, model.id)
          : null;
        return {
          modelId: model.id,
          propertyId: model.property_id,
          ...toPortableDocument(input, ENGINE_VERSION, latest?.result),
        };
      }),
    );

    await writeAudit(request.db, {
      organizationId: id,
      userId: context.userId,
      action: 'organization.exported',
      entityType: 'organization',
      entityId: id,
      metadata: { propertyCount: properties.length, modelCount: models.length },
      ipAddress: request.ip,
    });

    const document = {
      format: 'cre-platform-organization',
      // 2: adds budgets, documents, model version/approval history, comments,
      // tasks, portfolios, funds and their investors/transactions, dashboards,
      // saved views and assumption proposals — everything this document's own
      // name always claimed to hold but never actually did. See
      // `getOrganizationExportExtras`.
      formatVersion: 2,
      exportedAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        baseCurrency: organization.base_currency,
        areaUnit: organization.area_unit,
        createdAt: organization.created_at,
      },
      members,
      properties,
      models: modelDocuments,
      budgetPeriods: extras.budgetPeriods,
      budgetEntries: extras.budgetEntries,
      varianceCommentary: extras.varianceCommentary,
      documents: extras.documents,
      modelVersions: extras.modelVersions,
      modelApprovals: extras.modelApprovals,
      comments: extras.comments,
      tasks: extras.tasks,
      portfolios: extras.portfolios,
      portfolioProperties: extras.portfolioProperties,
      funds: extras.funds,
      fundInvestors: extras.fundInvestors,
      fundTransactions: extras.fundTransactions,
      dashboards: extras.dashboards,
      savedViews: extras.savedViews,
      assumptionProposals: extras.assumptionProposals,
    };

    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header(
      'content-disposition',
      `attachment; filename="${organization.slug}-export.crexport.json"`,
    );
    return document;
  });

  app.post('/invitations/accept', async (request) => {
    const auth = requireUser(request);
    const body = z.object({ token: z.string().min(10) }).parse(request.body);
    const result = await acceptInvitation(request.db, body.token, auth.user.id);
    if (!result) {
      throw new HttpError(400, 'INVITATION_INVALID', 'That invitation is invalid or has expired.');
    }
    await switchSessionOrganization(request.db, auth.session.id, result.organizationId);
    await writeAudit(request.db, {
      organizationId: result.organizationId,
      userId: auth.user.id,
      action: 'invitation.accepted',
      entityType: 'membership',
      entityId: auth.user.id,
      newValue: { role: result.role },
      ipAddress: request.ip,
    });
    return result;
  });
}
