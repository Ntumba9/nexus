import { z } from 'zod';

export const ROLES = ['OWNER', 'ADMIN', 'DEVELOPER', 'SUPPORT', 'VIEWER'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const PERMISSIONS = [
  'organization.read',
  'organization.update',
  'users.read',
  'users.manage',
  'projects.read',
  'projects.manage',
  'incidents.read',
  'incidents.create',
  'incidents.update',
  'incidents.resolve',
  'services.manage',
  'integrations.manage',
  'automation.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER_PERMISSIONS: readonly Permission[] = [
  'organization.read',
  'users.read',
  'projects.read',
  'incidents.read',
];

const SUPPORT_PERMISSIONS: readonly Permission[] = [
  ...VIEWER_PERMISSIONS,
  'incidents.create',
  'incidents.update',
];

const DEVELOPER_PERMISSIONS: readonly Permission[] = [
  ...SUPPORT_PERMISSIONS,
  'incidents.resolve',
  'projects.manage',
  'services.manage',
];

const ADMIN_PERMISSIONS: readonly Permission[] = PERMISSIONS;

/**
 * The single source of truth for authorization. Controllers declare the permission they need;
 * nothing else in the codebase inspects roles directly. OWNER and ADMIN currently share the same
 * permission set; the difference is enforced by member-management policy (only an OWNER may
 * grant, change or remove the OWNER role).
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  OWNER: new Set(PERMISSIONS),
  ADMIN: new Set(ADMIN_PERMISSIONS),
  DEVELOPER: new Set(DEVELOPER_PERMISSIONS),
  SUPPORT: new Set(SUPPORT_PERMISSIONS),
  VIEWER: new Set(VIEWER_PERMISSIONS),
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsForRole(role: Role): Permission[] {
  return PERMISSIONS.filter((permission) => roleHasPermission(role, permission));
}
