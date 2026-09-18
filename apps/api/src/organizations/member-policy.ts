import type { Role } from '@nexus/shared';
import { ApiError } from '../common/api-error';

/**
 * Who may grant, change or remove which roles. Permissions (users.manage) say whether someone may
 * manage members at all; this policy adds the rule that keeps ownership safe:
 * only an OWNER may create, modify or remove an OWNER.
 */
export function assertMayAssignRole(actor: Role, newRole: Role): void {
  if (newRole === 'OWNER' && actor !== 'OWNER') {
    throw ApiError.forbidden('OWNER_ONLY', 'Only an owner can grant the owner role');
  }
}

export function assertMayModifyMember(actor: Role, targetCurrentRole: Role): void {
  if (targetCurrentRole === 'OWNER' && actor !== 'OWNER') {
    throw ApiError.forbidden('OWNER_ONLY', 'Only an owner can change or remove an owner');
  }
}

/** An organisation must always keep at least one OWNER. */
export function assertKeepsAnOwner(
  ownerCount: number,
  target: Role,
  willRemainOwner: boolean,
): void {
  if (target === 'OWNER' && !willRemainOwner && ownerCount <= 1) {
    throw ApiError.conflict('LAST_OWNER', 'An organization must have at least one owner');
  }
}
