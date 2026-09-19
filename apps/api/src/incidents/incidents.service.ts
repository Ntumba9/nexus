import { Inject, Injectable } from '@nestjs/common';
import { createIncidentRecord, type Prisma, type PrismaClient } from '@nexus/database';
import {
  canTransition,
  permissionForTransition,
  type ActorType,
  type AddCommentInput,
  type CreateIncidentInput,
  type IncidentDetailDto,
  type IncidentEventDto,
  type IncidentEventType,
  type IncidentPageDto,
  type ListIncidentsQuery,
  type SetAssigneesInput,
  type TransitionIncidentInput,
  type UpdateIncidentInput,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { TenantContext } from '../common/request-context';
import { PRISMA } from '../infrastructure/tokens';
import { assertPermission } from '../rbac/permission';
import {
  detailSelect,
  eventSelect,
  summarySelect,
  toDetailDto,
  toEventDto,
  toSummaryDto,
} from './incident-mapper';

const UNIQUE_VIOLATION = 'P2002';
const isCode = (error: unknown, code: string) => (error as { code?: string }).code === code;
const STALE = () =>
  ApiError.conflict(
    'STALE_STATE',
    'The incident was changed by someone else. Refresh and try again.',
  );

type Tx = Prisma.TransactionClient;
type Actor = { type: ActorType; id: string | null };

/**
 * All incident behaviour. Rules that matter:
 *  - every query is scoped by the verified `tenant.organizationId`; an incident, service or user id
 *    from another organisation matches nothing and is indistinguishable from a nonexistent one;
 *  - every meaningful change writes a timeline event in the SAME transaction as the change, so the
 *    timeline can never disagree with the state;
 *  - status changes follow the shared state machine and are applied with an optimistic check, so two
 *    simultaneous transitions cannot both succeed.
 */
@Injectable()
export class IncidentsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  // ---- Queries ----------------------------------------------------------------------------

  async list(tenant: TenantContext, query: ListIncidentsQuery): Promise<IncidentPageDto> {
    const where: Prisma.IncidentWhereInput = { organizationId: tenant.organizationId };
    if (query.status) where.status = { in: query.status };
    if (query.severity) where.severity = { in: query.severity };
    if (query.serviceId) where.serviceId = query.serviceId;
    if (query.cursor) where.number = { lt: query.cursor };
    if (query.q) {
      // "42" or "INC-42" finds incident 42; anything else searches titles.
      const numeric = /^(?:inc-?)?(\d{1,9})$/i.exec(query.q);
      where.OR = [
        { title: { contains: query.q, mode: 'insensitive' } },
        ...(numeric ? [{ number: Number(numeric[1]) }] : []),
      ];
    }

    const rows = await this.prisma.incident.findMany({
      where,
      orderBy: { number: 'desc' },
      take: query.limit + 1,
      select: summarySelect,
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map(toSummaryDto),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.number : null,
    };
  }

  async get(tenant: TenantContext, id: string): Promise<IncidentDetailDto> {
    return this.load(this.prisma, tenant, id);
  }

  async events(tenant: TenantContext, id: string): Promise<IncidentEventDto[]> {
    await this.requireIncident(this.prisma, tenant, id);
    const rows = await this.prisma.incidentEvent.findMany({
      where: { incidentId: id, organizationId: tenant.organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
      select: eventSelect,
    });
    return rows.map(toEventDto);
  }

  // ---- Commands ---------------------------------------------------------------------------

  async create(tenant: TenantContext, input: CreateIncidentInput): Promise<IncidentDetailDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      if (input.serviceId) {
        const service = await tx.service.findFirst({
          where: { id: input.serviceId, organizationId: tenant.organizationId, archivedAt: null },
          select: { id: true },
        });
        if (!service) throw ApiError.notFound('Service not found');
      }

      // Shared with the monitoring worker so number allocation and the CREATED event exist once.
      const incident = await createIncidentRecord(tx, {
        organizationId: tenant.organizationId,
        title: input.title,
        description: input.description,
        severity: input.severity,
        serviceId: input.serviceId ?? null,
        source: 'MANUAL',
        createdById: tenant.userId,
        tags: input.tags,
        actor: this.user(tenant),
      });
      return incident.id;
    });
    return this.get(tenant, id);
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: UpdateIncidentInput,
  ): Promise<IncidentDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.incident.findFirst({
        where: { id, organizationId: tenant.organizationId },
        select: { title: true, description: true, severity: true, tags: { select: { tag: true } } },
      });
      if (!current) throw ApiError.notFound('Incident not found');

      const data: Prisma.IncidentUncheckedUpdateManyInput = {};
      const changed: string[] = [];
      if (input.title !== undefined && input.title !== current.title) {
        data.title = input.title;
        changed.push('title');
      }
      if (input.description !== undefined && input.description !== current.description) {
        data.description = input.description;
        changed.push('description');
      }
      const severityChanged = input.severity !== undefined && input.severity !== current.severity;
      if (severityChanged) data.severity = input.severity;

      if (Object.keys(data).length > 0) {
        await tx.incident.updateMany({
          where: { id, organizationId: tenant.organizationId },
          data,
        });
      }

      if (input.tags !== undefined) {
        const existing = new Set(current.tags.map((t) => t.tag));
        const wanted = new Set(input.tags);
        const remove = [...existing].filter((t) => !wanted.has(t));
        const add = [...wanted].filter((t) => !existing.has(t));
        if (remove.length > 0) {
          await tx.incidentTag.deleteMany({
            where: { incidentId: id, organizationId: tenant.organizationId, tag: { in: remove } },
          });
        }
        if (add.length > 0) {
          await tx.incidentTag.createMany({
            data: add.map((tag) => ({
              organizationId: tenant.organizationId,
              incidentId: id,
              tag,
            })),
          });
        }
        if (remove.length > 0 || add.length > 0) changed.push('tags');
      }

      if (severityChanged) {
        await this.recordEvent(tx, tenant, id, 'SEVERITY_CHANGED', this.user(tenant), {
          from: current.severity,
          to: input.severity,
        });
      }
      if (changed.length > 0) {
        await this.recordEvent(tx, tenant, id, 'UPDATED', this.user(tenant), { fields: changed });
      }
    });
    return this.get(tenant, id);
  }

  async transition(
    tenant: TenantContext,
    id: string,
    input: TransitionIncidentInput,
  ): Promise<IncidentDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.incident.findFirst({
        where: { id, organizationId: tenant.organizationId },
        select: { status: true },
      });
      if (!current) throw ApiError.notFound('Incident not found');

      const from = current.status;
      const to = input.to;
      if (!canTransition(from, to)) {
        throw ApiError.conflict(
          'INVALID_TRANSITION',
          `An incident cannot move from ${from} to ${to}`,
        );
      }
      assertPermission(tenant.role, permissionForTransition(from, to));

      const now = new Date();
      const data: Prisma.IncidentUncheckedUpdateManyInput = { status: to };
      if (to === 'ACKNOWLEDGED') data.acknowledgedAt = now;
      if (to === 'MITIGATED') data.mitigatedAt = now;
      if (to === 'RESOLVED') data.resolvedAt = now;
      if (to === 'CANCELLED') data.cancelledAt = now;
      if (from === 'RESOLVED') data.resolvedAt = null; // reopened

      // Optimistic concurrency: only apply if the status is still what we validated against.
      const result = await tx.incident.updateMany({
        where: { id, organizationId: tenant.organizationId, status: from },
        data,
      });
      if (result.count === 0) throw STALE();

      await this.recordEvent(tx, tenant, id, 'STATUS_CHANGED', this.user(tenant), {
        from,
        to,
        ...(input.note ? { note: input.note } : {}),
      });
    });
    return this.get(tenant, id);
  }

  async addComment(
    tenant: TenantContext,
    id: string,
    input: AddCommentInput,
  ): Promise<IncidentEventDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.requireIncident(tx, tenant, id);
      const comment = await tx.incidentComment.create({
        data: {
          organizationId: tenant.organizationId,
          incidentId: id,
          authorId: tenant.userId,
          body: input.body,
        },
        select: { id: true },
      });
      const event = await this.recordEvent(tx, tenant, id, 'COMMENT_ADDED', this.user(tenant), {
        commentId: comment.id,
        body: input.body,
      });
      return toEventDto(event);
    });
  }

  /** Replaces the set of assignees: adds the new ones, ends the removed ones, records each change. */
  async setAssignees(
    tenant: TenantContext,
    id: string,
    input: SetAssigneesInput,
  ): Promise<IncidentDetailDto> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.requireIncident(tx, tenant, id);

        // Assignees must belong to THIS organisation (checked against membership, not just users).
        const members = await tx.organizationMember.findMany({
          where: { organizationId: tenant.organizationId, userId: { in: input.userIds } },
          select: { userId: true, user: { select: { name: true } } },
        });
        if (members.length !== input.userIds.length) {
          throw ApiError.badRequest(
            'ASSIGNEE_NOT_MEMBER',
            'Every assignee must be a member of this organization',
          );
        }
        const names = new Map(members.map((m) => [m.userId, m.user.name]));

        const active = await tx.incidentAssignment.findMany({
          where: { incidentId: id, organizationId: tenant.organizationId, unassignedAt: null },
          select: { userId: true, user: { select: { name: true } } },
        });
        const activeIds = new Set(active.map((a) => a.userId));
        const wanted = new Set(input.userIds);
        const toAdd = input.userIds.filter((userId) => !activeIds.has(userId));
        const toRemove = active.filter((a) => !wanted.has(a.userId));

        if (toAdd.length > 0) {
          await tx.incidentAssignment.createMany({
            data: toAdd.map((userId) => ({
              organizationId: tenant.organizationId,
              incidentId: id,
              userId,
              assignedById: tenant.userId,
            })),
          });
        }
        if (toRemove.length > 0) {
          await tx.incidentAssignment.updateMany({
            where: {
              incidentId: id,
              organizationId: tenant.organizationId,
              unassignedAt: null,
              userId: { in: toRemove.map((a) => a.userId) },
            },
            data: { unassignedAt: new Date() },
          });
        }
        for (const userId of toAdd) {
          await this.recordEvent(tx, tenant, id, 'ASSIGNED', this.user(tenant), {
            userId,
            name: names.get(userId),
          });
        }
        for (const removed of toRemove) {
          await this.recordEvent(tx, tenant, id, 'UNASSIGNED', this.user(tenant), {
            userId: removed.userId,
            name: removed.user.name,
          });
        }
      });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) throw STALE(); // concurrent identical assignment
      throw error;
    }
    return this.get(tenant, id);
  }

  // ---- Helpers ----------------------------------------------------------------------------

  private user(tenant: TenantContext): Actor {
    return { type: 'USER', id: tenant.userId };
  }

  private async requireIncident(
    db: Pick<PrismaClient, 'incident'> | Tx,
    tenant: TenantContext,
    id: string,
  ): Promise<void> {
    const found = await db.incident.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: { id: true },
    });
    if (!found) throw ApiError.notFound('Incident not found');
  }

  private async load(
    db: Pick<PrismaClient, 'incident'> | Tx,
    tenant: TenantContext,
    id: string,
  ): Promise<IncidentDetailDto> {
    const row = await db.incident.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: detailSelect,
    });
    if (!row) throw ApiError.notFound('Incident not found');
    return toDetailDto(row, tenant.role);
  }

  private recordEvent(
    tx: Tx,
    tenant: TenantContext,
    incidentId: string,
    type: IncidentEventType,
    actor: Actor,
    data: Prisma.InputJsonObject,
  ) {
    return tx.incidentEvent.create({
      data: {
        organizationId: tenant.organizationId,
        incidentId,
        type,
        actorType: actor.type,
        actorId: actor.id,
        data,
      },
      select: eventSelect,
    });
  }
}
