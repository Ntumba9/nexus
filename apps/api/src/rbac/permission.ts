import { roleHasPermission, type Permission, type Role } from '@nexus/shared';
import { ApiError } from '../common/api-error';

/**
 * For the rare case where the permission needed depends on the request itself (for example
 * resolving an incident needs a stronger permission than acknowledging it), so it cannot be a
 * static `@RequirePermission` on the route. It still consults the one shared permission matrix.
 */
export function assertPermission(role: Role, permission: Permission): void {
  if (!roleHasPermission(role, permission)) throw ApiError.forbidden();
}
