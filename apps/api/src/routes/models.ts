import type { FastifyInstance } from 'fastify';
import type { Sql } from '@cre/database';
import { z } from 'zod';
import {
  LeaseVersionConflict,
  createModelVersion,
  buildModelInput,
  deleteLease,
  getModel,
  getProperty,
  listLeases,
  listModelVersions,
  listModels,
  upsertCapitalItem,
  upsertDebtFacility,
  upsertExpense,
  upsertGrowthCurve,
  upsertLease,
  upsertMarketLeasingProfile,
  upsertOtherRevenue,
  writeAudit,
} from '@cre/database';
import { ENGINE_VERSION } from '@cre/calculation-engine';
import {
  decimalString,
  findTransition,
  leaseStatusEnum,
  modelClassificationEnum,
  rentBasisEnum,
  roleHasCapability,
} from '@cre/domain-models';
import { HttpError, badRequest, forbidden, notFound, requireCapability } from '../context.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const modelAssumptions = z.object({
  name: z.string().min(1).max(200),
  classification: modelClassificationEnum,
  valuationDate: isoDate,
  forecastStartDate: isoDate,
  forecastMonths: z.number().int().min(1).max(600),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  prorationConvention: z.enum(['actual_days', 'thirty_360', 'full_month']).default('actual_days'),
  currency: z.string().length(3).default('USD'),
  areaUnit: z.enum(['sqft', 'sqm']).default('sqft'),
  notes: z.string().max(5000).nullish(),
  discountRate: decimalString.nullish(),
  discountingConvention: z.enum(['end_of_period', 'mid_period']).default('end_of_period'),
  terminalCapRate: decimalString.nullish(),
  terminalNoiBasis: z.enum(['forward_12', 'trailing_12']).default('forward_12'),
  saleCostPercent: decimalString.default('0'),
  saleMonth: z.number().int().min(1).nullish(),
  grossSalePriceOverride: decimalString.nullish(),
  directCapRate: decimalString.nullish(),
  directCapNoiBasis: z.enum(['year_1', 'stabilized', 'trailing_12']).default('year_1'),
  directCapAdjustments: decimalString.default('0'),
  acquisitionPrice: decimalString.nullish(),
  acquisitionCosts: decimalString.default('0'),
  acquisitionDate: isoDate.nullish(),
  generalVacancyRate: decimalString.default('0'),
  netAgainstModelledVacancy: z.boolean().default(true),
  creditLossRate: decimalString.default('0'),
  equityStructure: z.record(z.unknown()).default({ partners: [], tiers: [], fees: [] }),
});

export async function registerModelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/models', async (request) => {
    const context = requireCapability(request, 'model:read');
    const query = z.object({ propertyId: z.string().uuid().optional() }).parse(request.query);
    return { models: await listModels(request.db, context.organizationId, query.propertyId) };
  });

  app.post('/models', async (request, reply) => {
    const context = requireCapability(request, 'model:write');
    const body = modelAssumptions.extend({ propertyId: z.string().uuid() }).parse(request.body);

    const property = await getProperty(request.db, context.organizationId, body.propertyId);
    if (!property) throw notFound('That property does not exist in this organization.');

    const rows = (await request.db`
      INSERT INTO models (
        organization_id, property_id, name, classification, owner_id, valuation_date,
        forecast_start_date, forecast_months, fiscal_year_start_month, proration_convention,
        currency, area_unit, notes, discount_rate, discounting_convention, terminal_cap_rate,
        terminal_noi_basis, sale_cost_percent, sale_month, gross_sale_price_override,
        direct_cap_rate, direct_cap_noi_basis, direct_cap_adjustments, acquisition_price,
        acquisition_costs, acquisition_date, general_vacancy_rate,
        net_against_modelled_vacancy, credit_loss_rate, equity_structure, created_by
      ) VALUES (
        ${context.organizationId}, ${body.propertyId}, ${body.name}, ${body.classification},
        ${context.userId}, ${body.valuationDate}, ${body.forecastStartDate}, ${body.forecastMonths},
        ${body.fiscalYearStartMonth}, ${body.prorationConvention}, ${body.currency}, ${body.areaUnit},
        ${body.notes ?? null}, ${body.discountRate ?? null}, ${body.discountingConvention},
        ${body.terminalCapRate ?? null}, ${body.terminalNoiBasis}, ${body.saleCostPercent},
        ${body.saleMonth ?? null}, ${body.grossSalePriceOverride ?? null},
        ${body.directCapRate ?? null}, ${body.directCapNoiBasis}, ${body.directCapAdjustments},
        ${body.acquisitionPrice ?? null}, ${body.acquisitionCosts}, ${body.acquisitionDate ?? null},
        ${body.generalVacancyRate}, ${body.netAgainstModelledVacancy}, ${body.creditLossRate},
        ${request.db.json(body.equityStructure as never)}, ${context.userId}
      )
      RETURNING *
    `) as unknown as Array<Record<string, unknown>>;

    const model = rows[0] as Record<string, unknown>;
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'model.created',
      entityType: 'model',
      entityId: model.id as string,
      propertyId: body.propertyId,
      modelId: model.id as string,
      newValue: { name: body.name, classification: body.classification },
      ipAddress: request.ip,
    });
    return reply.status(201).send({ model });
  });

  app.get('/models/:id', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound('That model does not exist in this organization.');
    const property = await getProperty(request.db, context.organizationId, model.property_id);
    return { model, property };
  });

  app.patch('/models/:id', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();
    assertEditable(model.status);

    const body = modelAssumptions.partial().parse(request.body);
    const rows = (await request.db`
      UPDATE models SET
        name = COALESCE(${body.name ?? null}, name),
        classification = COALESCE(${body.classification ?? null}, classification),
        valuation_date = COALESCE(${body.valuationDate ?? null}::date, valuation_date),
        forecast_start_date = COALESCE(${body.forecastStartDate ?? null}::date, forecast_start_date),
        forecast_months = COALESCE(${body.forecastMonths ?? null}, forecast_months),
        fiscal_year_start_month = COALESCE(${body.fiscalYearStartMonth ?? null}, fiscal_year_start_month),
        proration_convention = COALESCE(${body.prorationConvention ?? null}, proration_convention),
        notes = COALESCE(${body.notes ?? null}, notes),
        discount_rate = COALESCE(${body.discountRate ?? null}::numeric, discount_rate),
        discounting_convention = COALESCE(${body.discountingConvention ?? null}, discounting_convention),
        terminal_cap_rate = COALESCE(${body.terminalCapRate ?? null}::numeric, terminal_cap_rate),
        terminal_noi_basis = COALESCE(${body.terminalNoiBasis ?? null}, terminal_noi_basis),
        sale_cost_percent = COALESCE(${body.saleCostPercent ?? null}::numeric, sale_cost_percent),
        sale_month = COALESCE(${body.saleMonth ?? null}, sale_month),
        gross_sale_price_override = COALESCE(${body.grossSalePriceOverride ?? null}::numeric, gross_sale_price_override),
        direct_cap_rate = COALESCE(${body.directCapRate ?? null}::numeric, direct_cap_rate),
        direct_cap_noi_basis = COALESCE(${body.directCapNoiBasis ?? null}, direct_cap_noi_basis),
        direct_cap_adjustments = COALESCE(${body.directCapAdjustments ?? null}::numeric, direct_cap_adjustments),
        acquisition_price = COALESCE(${body.acquisitionPrice ?? null}::numeric, acquisition_price),
        acquisition_costs = COALESCE(${body.acquisitionCosts ?? null}::numeric, acquisition_costs),
        acquisition_date = COALESCE(${body.acquisitionDate ?? null}::date, acquisition_date),
        general_vacancy_rate = COALESCE(${body.generalVacancyRate ?? null}::numeric, general_vacancy_rate),
        net_against_modelled_vacancy = COALESCE(${body.netAgainstModelledVacancy ?? null}, net_against_modelled_vacancy),
        credit_loss_rate = COALESCE(${body.creditLossRate ?? null}::numeric, credit_loss_rate),
        equity_structure = COALESCE(${body.equityStructure ? request.db.json(body.equityStructure as never) : null}, equity_structure),
        updated_at = now()
      WHERE id = ${id} AND organization_id = ${context.organizationId}
      RETURNING *
    `) as unknown as Array<Record<string, unknown>>;

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'model.updated',
      entityType: 'model',
      entityId: id,
      modelId: id,
      propertyId: model.property_id,
      newValue: body,
      ipAddress: request.ip,
    });
    return { model: rows[0] };
  });

  /* ---------------------------------------------------------------------- */
  /* Leases                                                                 */
  /* ---------------------------------------------------------------------- */

  app.get('/models/:id/leases', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireModel(request, context.organizationId, id);
    return { leases: await listLeases(request.db, id) };
  });

  app.put('/models/:id/leases/:code', async (request) => {
    const context = requireCapability(request, 'model:write');
    const params = z
      .object({ id: z.string().uuid(), code: z.string().min(1).max(60) })
      .parse(request.params);
    const model = await requireModel(request, context.organizationId, params.id);
    assertEditable(model.status);

    const body = z
      .object({
        tenantId: z.string().uuid(),
        status: leaseStatusEnum,
        area: decimalString,
        unitCount: z.number().int().min(0).default(0),
        spaceIds: z.array(z.string().max(60)).default([]),
        commencementDate: isoDate,
        rentStartDate: isoDate.nullish(),
        expirationDate: isoDate,
        baseRent: decimalString,
        baseRentBasis: rentBasisEnum,
        rentSteps: z
          .array(z.object({ startDate: isoDate, amount: decimalString, basis: rentBasisEnum }))
          .default([]),
        escalation: z.record(z.unknown()).default({}),
        freeRent: z.array(z.record(z.unknown())).default([]),
        percentageRent: z.record(z.unknown()).default({}),
        recovery: z.record(z.unknown()).default({}),
        options: z.array(z.record(z.unknown())).default([]),
        leasingCosts: z.record(z.unknown()).default({}),
        otherRevenue: z.array(z.record(z.unknown())).default([]),
        marketLeasingProfileId: z.string().uuid().nullish(),
        excludeFromRollover: z.boolean().default(false),
        notes: z.string().max(5000).nullish(),
        /**
         * The version the caller read. Supplied by the editor, which loaded the
         * lease before showing it. Omitting it accepts last-write-wins, which
         * is what bulk import deliberately wants.
         */
        expectedVersion: z.number().int().min(1).nullish(),
      })
      .parse(request.body);

    if (body.expirationDate < body.commencementDate) {
      throw badRequest('A lease cannot expire before it commences.');
    }

    let lease;
    try {
      lease = await upsertLease(request.db, {
        ...body,
        modelId: params.id,
        code: params.code,
      });
    } catch (error) {
      if (error instanceof LeaseVersionConflict) {
        // 409, not 400: the request was well formed and would have been valid a
        // moment ago. The current version goes back so the client can reload
        // and show what changed rather than guessing.
        throw new HttpError(409, 'LEASE_VERSION_CONFLICT', error.message, {
          code: error.code,
          expectedVersion: error.expected,
          currentVersion: error.actual,
        });
      }
      throw error;
    }
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'lease.saved',
      entityType: 'lease',
      entityId: params.code,
      modelId: params.id,
      propertyId: model.property_id,
      newValue: {
        area: body.area,
        baseRent: body.baseRent,
        commencementDate: body.commencementDate,
        expirationDate: body.expirationDate,
      },
      ipAddress: request.ip,
    });
    return { lease };
  });

  app.delete('/models/:id/leases/:code', async (request) => {
    const context = requireCapability(request, 'model:write');
    const params = z
      .object({ id: z.string().uuid(), code: z.string().min(1) })
      .parse(request.params);
    const model = await requireModel(request, context.organizationId, params.id);
    assertEditable(model.status);
    const ok = await deleteLease(request.db, params.id, params.code);
    if (!ok) throw notFound('That lease does not exist on this model.');
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'lease.deleted',
      entityType: 'lease',
      entityId: params.code,
      modelId: params.id,
      ipAddress: request.ip,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------------- */
  /* Assumption collections                                                 */
  /* ---------------------------------------------------------------------- */

  registerCollection(app, 'expenses', 'operating_expenses', (db, modelId, body) =>
    upsertExpense(db, { ...body, modelId } as Parameters<typeof upsertExpense>[1]),
  );
  registerCollection(app, 'other-revenue', 'other_revenue_items', (db, modelId, body) =>
    upsertOtherRevenue(db, { ...body, modelId } as Parameters<typeof upsertOtherRevenue>[1]),
  );
  registerCollection(app, 'capital', 'capital_items', (db, modelId, body) =>
    upsertCapitalItem(db, { ...body, modelId } as Parameters<typeof upsertCapitalItem>[1]),
  );
  registerCollection(app, 'debt', 'debt_facilities', (db, modelId, body) =>
    upsertDebtFacility(db, { ...body, modelId } as Parameters<typeof upsertDebtFacility>[1]),
  );
  registerCollection(app, 'growth-curves', 'growth_curves', (db, modelId, body) =>
    upsertGrowthCurve(db, { ...body, modelId } as Parameters<typeof upsertGrowthCurve>[1]),
  );
  registerCollection(app, 'market-leasing', 'market_leasing_profiles', (db, modelId, body) =>
    upsertMarketLeasingProfile(db, { ...body, modelId } as Parameters<
      typeof upsertMarketLeasingProfile
    >[1]),
  );

  /* ---------------------------------------------------------------------- */
  /* Versions, cloning and approvals                                        */
  /* ---------------------------------------------------------------------- */

  app.get('/models/:id/versions', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireModel(request, context.organizationId, id);
    return { versions: await listModelVersions(request.db, id) };
  });

  app.post('/models/:id/versions', async (request, reply) => {
    const context = requireCapability(request, 'model:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireModel(request, context.organizationId, id);
    const body = z
      .object({ label: z.string().max(120).nullish(), notes: z.string().max(5000).nullish() })
      .parse(request.body ?? {});

    const modelInput = await buildModelInput(request.db, context.organizationId, id);
    const version = await createModelVersion(request.db, {
      modelId: id,
      modelInput,
      engineVersion: ENGINE_VERSION,
      label: body.label,
      notes: body.notes,
      createdBy: context.userId,
    });
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'model.version_created',
      entityType: 'model_version',
      entityId: version.id,
      modelId: id,
      newValue: { versionNumber: version.version_number, engineVersion: ENGINE_VERSION },
      ipAddress: request.ip,
    });
    return reply.status(201).send({ version });
  });

  /**
   * Clones a model. Only the scenario-scoped rows are copied; the property,
   * its buildings and its spaces are shared, so a scenario costs a handful of
   * rows rather than a duplicate of the whole asset.
   */
  app.post('/models/:id/clone', async (request, reply) => {
    const context = requireCapability(request, 'model:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const source = await requireModel(request, context.organizationId, id);
    const body = z
      .object({
        name: z.string().min(1).max(200),
        classification: modelClassificationEnum.optional(),
      })
      .parse(request.body);

    const newId = (await request.db.begin(async (tx) => {
      const rows = (await tx`
        INSERT INTO models (
          organization_id, property_id, name, classification, status, owner_id, valuation_date,
          forecast_start_date, forecast_months, fiscal_year_start_month, proration_convention,
          currency, area_unit, assumption_date, notes, discount_rate, discounting_convention,
          terminal_cap_rate, terminal_noi_basis, sale_cost_percent, sale_month,
          gross_sale_price_override, direct_cap_rate, direct_cap_noi_basis,
          direct_cap_adjustments, acquisition_price, acquisition_costs, acquisition_date,
          general_vacancy_rate, net_against_modelled_vacancy, credit_loss_rate,
          equity_structure, created_by
        )
        SELECT
          organization_id, property_id, ${body.name},
          ${body.classification ?? source.classification}, 'draft', ${context.userId},
          valuation_date, forecast_start_date, forecast_months, fiscal_year_start_month,
          proration_convention, currency, area_unit, assumption_date, notes, discount_rate,
          discounting_convention, terminal_cap_rate, terminal_noi_basis, sale_cost_percent,
          sale_month, gross_sale_price_override, direct_cap_rate, direct_cap_noi_basis,
          direct_cap_adjustments, acquisition_price, acquisition_costs, acquisition_date,
          general_vacancy_rate, net_against_modelled_vacancy, credit_loss_rate,
          equity_structure, ${context.userId}
        FROM models WHERE id = ${id}
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      const cloneId = (rows[0] as { id: string }).id;

      await tx`
        INSERT INTO growth_curves (model_id, code, name, default_rate, by_year)
        SELECT ${cloneId}, code, name, default_rate, by_year FROM growth_curves WHERE model_id = ${id}
      `;
      await tx`
        INSERT INTO market_leasing_profiles (
          model_id, code, name, market_rent, market_rent_basis, market_rent_growth_curve,
          renewal_probability, renewal_term_months, new_lease_term_months, downtime_months,
          renewal_free_rent_months, new_free_rent_months, renewal_ti_per_area, new_ti_per_area,
          renewal_lc_percent, new_lc_percent, renewal_escalation, new_escalation, recovery, precedence)
        SELECT ${cloneId}, code, name, market_rent, market_rent_basis, market_rent_growth_curve,
          renewal_probability, renewal_term_months, new_lease_term_months, downtime_months,
          renewal_free_rent_months, new_free_rent_months, renewal_ti_per_area, new_ti_per_area,
          renewal_lc_percent, new_lc_percent, renewal_escalation, new_escalation, recovery, precedence
        FROM market_leasing_profiles WHERE model_id = ${id}
      `;
      await tx`
        INSERT INTO operating_expenses (
          model_id, code, name, category, account_code, method, amount, growth_curve,
          recoverable_share, variable_share, monthly_schedule, is_capitalized, sort_order)
        SELECT ${cloneId}, code, name, category, account_code, method, amount, growth_curve,
          recoverable_share, variable_share, monthly_schedule, is_capitalized, sort_order
        FROM operating_expenses WHERE model_id = ${id}
      `;
      await tx`
        INSERT INTO other_revenue_items (
          model_id, code, name, category, method, amount, growth_curve, vary_with_occupancy,
          monthly_schedule, sort_order)
        SELECT ${cloneId}, code, name, category, method, amount, growth_curve, vary_with_occupancy,
          monthly_schedule, sort_order
        FROM other_revenue_items WHERE model_id = ${id}
      `;
      await tx`
        INSERT INTO capital_items (
          model_id, code, name, category, method, amount, start_date, end_date, growth_curve,
          monthly_schedule, capitalized, funding_source, approval_status, useful_life_years, sort_order)
        SELECT ${cloneId}, code, name, category, method, amount, start_date, end_date, growth_curve,
          monthly_schedule, capitalized, funding_source, approval_status, useful_life_years, sort_order
        FROM capital_items WHERE model_id = ${id}
      `;
      await tx`
        INSERT INTO debt_facilities (
          model_id, code, name, type, commitment, initial_funding, funding_date, draws, rate_type,
          fixed_rate, index_curve, spread, rate_floor, rate_cap, interest_only_months,
          amortization_months, term_months, origination_fee_percent, exit_fee_percent,
          unused_fee_percent, capitalize_interest, minimum_dscr, maximum_ltv, maximum_ltc,
          minimum_debt_yield, repay_on_sale, sort_order)
        SELECT ${cloneId}, code, name, type, commitment, initial_funding, funding_date, draws, rate_type,
          fixed_rate, index_curve, spread, rate_floor, rate_cap, interest_only_months,
          amortization_months, term_months, origination_fee_percent, exit_fee_percent,
          unused_fee_percent, capitalize_interest, minimum_dscr, maximum_ltv, maximum_ltc,
          minimum_debt_yield, repay_on_sale, sort_order
        FROM debt_facilities WHERE model_id = ${id}
      `;

      // Leases carry child rows, so they are copied one at a time to remap ids.
      const leaseRows = (await tx`SELECT * FROM leases WHERE model_id = ${id}`) as unknown as Array<
        Record<string, unknown>
      >;
      for (const lease of leaseRows) {
        const inserted = (await tx`
          INSERT INTO leases (
            model_id, tenant_id, code, status, area, unit_count, execution_date, possession_date,
            commencement_date, rent_start_date, expiration_date, base_rent, base_rent_basis,
            escalation, free_rent, percentage_rent, recovery, options, leasing_costs, other_revenue,
            security_deposit, market_leasing_profile_id, exclude_from_rollover, notes)
          SELECT ${cloneId}, tenant_id, code, status, area, unit_count, execution_date, possession_date,
            commencement_date, rent_start_date, expiration_date, base_rent, base_rent_basis,
            escalation, free_rent, percentage_rent, recovery, options, leasing_costs, other_revenue,
            security_deposit,
            (SELECT p2.id FROM market_leasing_profiles p1
               JOIN market_leasing_profiles p2 ON p2.code = p1.code AND p2.model_id = ${cloneId}
             WHERE p1.id = leases.market_leasing_profile_id),
            exclude_from_rollover, notes
          FROM leases WHERE id = ${lease.id as string}
          RETURNING id
        `) as unknown as Array<{ id: string }>;
        const newLeaseId = (inserted[0] as { id: string }).id;
        await tx`
          INSERT INTO lease_rent_steps (lease_id, start_date, amount, basis, sort_order)
          SELECT ${newLeaseId}, start_date, amount, basis, sort_order
          FROM lease_rent_steps WHERE lease_id = ${lease.id as string}
        `;
        await tx`
          INSERT INTO lease_spaces (lease_id, space_id)
          SELECT ${newLeaseId}, space_id FROM lease_spaces WHERE lease_id = ${lease.id as string}
        `;
      }

      await tx`
        UPDATE models SET default_market_leasing_profile_id = (
          SELECT p2.id FROM market_leasing_profiles p1
          JOIN market_leasing_profiles p2 ON p2.code = p1.code AND p2.model_id = ${cloneId}
          WHERE p1.id = (SELECT default_market_leasing_profile_id FROM models WHERE id = ${id})
        )
        WHERE id = ${cloneId}
      `;

      return cloneId;
    })) as string;

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'model.cloned',
      entityType: 'model',
      entityId: newId,
      modelId: newId,
      propertyId: source.property_id,
      metadata: { clonedFrom: id },
      ipAddress: request.ip,
    });

    const model = await getModel(request.db, context.organizationId, newId);
    return reply.status(201).send({ model });
  });

  /**
   * Moves a model along the approval workflow. Transitions are validated
   * against the shared transition table, and reaching `approved` snapshots the
   * model so the approved numbers can never be edited out from under the
   * approval.
   */
  app.post('/models/:id/transition', async (request) => {
    const auth = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const model = await requireModel(request, auth.organizationId, id);
    const body = z
      .object({ to: z.string().min(1), comment: z.string().max(2000).nullish() })
      .parse(request.body);

    const transition = findTransition(model.status, body.to);
    if (!transition) {
      throw badRequest(`A model cannot move from "${model.status}" to "${body.to}".`);
    }
    if (!roleHasCapability(auth.role, transition.capability)) {
      throw forbidden(`Your role cannot perform "${transition.capability}".`);
    }

    let versionId: string | null = null;
    if (body.to === 'approved') {
      const modelInput = await buildModelInput(request.db, auth.organizationId, id);
      const version = await createModelVersion(request.db, {
        modelId: id,
        modelInput,
        engineVersion: ENGINE_VERSION,
        label: `Approved ${new Date().toISOString().slice(0, 10)}`,
        createdBy: auth.userId,
      });
      versionId = version.id;
      await request.db`
        UPDATE model_versions SET status = 'approved', approved_by = ${auth.userId}, approved_at = now()
        WHERE id = ${versionId}
      `;
    }

    await request.db`
      UPDATE models SET status = ${body.to}, updated_at = now()
      WHERE id = ${id} AND organization_id = ${auth.organizationId}
    `;
    await request.db`
      INSERT INTO model_approvals (model_id, model_version_id, from_status, to_status, decision, comment, actor_id)
      VALUES (${id}, ${versionId}, ${model.status}, ${body.to}, ${transition.decision}, ${body.comment ?? null}, ${auth.userId})
    `;
    await writeAudit(request.db, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: `model.${transition.decision}`,
      entityType: 'model',
      entityId: id,
      modelId: id,
      previousValue: { status: model.status },
      newValue: { status: body.to },
      ipAddress: request.ip,
    });

    return { status: body.to, versionId };
  });
}

/** Approved and published models are frozen; edits require a new draft. */
function assertEditable(status: string): void {
  if (['approved', 'published', 'superseded', 'archived'].includes(status)) {
    throw badRequest(
      `This model is ${status} and cannot be edited. Clone it to continue working, or move it back to draft.`,
    );
  }
}

async function requireModel(
  request: Parameters<typeof requireCapability>[0],
  organizationId: string,
  modelId: string,
) {
  const model = await getModel(request.db, organizationId, modelId);
  if (!model) throw notFound('That model does not exist in this organization.');
  return model;
}

/**
 * Registers list/upsert/delete routes for a model-scoped assumption table.
 * Every collection follows the same shape, so defining them from one place
 * keeps the authorization and audit behaviour identical across all of them.
 */
function registerCollection(
  app: FastifyInstance,
  segment: string,
  table: string,
  upsert: (db: Sql, modelId: string, body: Record<string, unknown>) => Promise<{ id: string }>,
): void {
  app.get(`/models/:id/${segment}`, async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireModel(request, context.organizationId, id);
    const rows = await request.db.unsafe(
      `SELECT * FROM ${table} WHERE model_id = $1 ORDER BY code`,
      [id],
    );
    return { items: rows };
  });

  app.put(`/models/:id/${segment}/:code`, async (request) => {
    const context = requireCapability(request, 'model:write');
    const params = z
      .object({ id: z.string().uuid(), code: z.string().min(1).max(60) })
      .parse(request.params);
    const model = await requireModel(request, context.organizationId, params.id);
    assertEditable(model.status);
    const body = z.record(z.unknown()).parse(request.body);

    const saved = await upsert(request.db, params.id, { ...body, code: params.code });
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: `${segment}.saved`,
      entityType: segment,
      entityId: params.code,
      modelId: params.id,
      newValue: body,
      ipAddress: request.ip,
    });
    return { item: saved };
  });

  app.delete(`/models/:id/${segment}/:code`, async (request) => {
    const context = requireCapability(request, 'model:write');
    const params = z
      .object({ id: z.string().uuid(), code: z.string().min(1).max(60) })
      .parse(request.params);
    const model = await requireModel(request, context.organizationId, params.id);
    assertEditable(model.status);
    const rows = await request.db.unsafe(
      `DELETE FROM ${table} WHERE model_id = $1 AND code = $2 RETURNING id`,
      [params.id, params.code],
    );
    if ((rows as unknown[]).length === 0) throw notFound();
    return { ok: true };
  });
}
