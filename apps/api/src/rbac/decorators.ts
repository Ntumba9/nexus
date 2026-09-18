import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@nexus/shared';

export const IS_PUBLIC_KEY = 'nexus:isPublic';
export const PERMISSION_KEY = 'nexus:permission';
export const AUTHENTICATED_ONLY_KEY = 'nexus:authenticatedOnly';

/** Opt a route out of authentication (register, login, health). Everything else is protected. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Require the caller's role in the route's organisation (`:orgId`) to grant `permission`.
 * This is the only way controllers express authorization; roles are never inspected directly.
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);

/**
 * For authenticated routes that are not scoped to an organisation (e.g. "list my organisations").
 * Explicit on purpose: an organisation-scoped route with no permission declared is denied.
 */
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY_KEY, true);
