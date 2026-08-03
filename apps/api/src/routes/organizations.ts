import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  acceptInvitation,
  createInvitation,
  createOrganization,
  getMembershipRole,
  listMemberships,
  listOrganizationMembers,
  removeMember,
  setMemberRole,
  switchSessionOrganization,
  writeAudit,
} from '@cre/database';
import { roleEnum } from '@cre/domain-models';
import type { Env } from '../env.js';
import { HttpError, badRequest, forbidden, requireCapability, requireUser } from '../context.js';

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
