import type { ActorType, Prisma } from '@prisma/client';
import { redactForAudit, type AuditAction } from '@nexus/shared';
import type { Tx } from './incident-writes';

export interface AuditEntry {
  organizationId: string;
  actor: {
    type: ActorType;
    id: string | null;
    /** A snapshot of who acted ("Alex Admin", "NEXUS automation"), so the entry outlives renames. */
    label: string;
  };
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  /** Redacted (secrets, query strings, oversized values) before it is written. */
  metadata?: Record<string, unknown>;
  requestId?: string | null;
}

/**
 * Append an entry to the audit log. Always call this INSIDE the transaction that makes the change it
 * describes: a change that rolls back leaves no entry, and a change that commits always has one.
 * The table is append-only in the database, so what is written here can never be altered.
 */
export async function writeAuditLog(tx: Tx, entry: AuditEntry): Promise<string> {
  const created = await tx.auditLog.create({
    data: {
      organizationId: entry.organizationId,
      actorType: entry.actor.type,
      actorId: entry.actor.id,
      actorLabel: entry.actor.label.slice(0, 200),
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      metadata: redactForAudit(entry.metadata) as Prisma.InputJsonObject,
      requestId: entry.requestId ?? null,
    },
    select: { id: true },
  });
  return created.id;
}
