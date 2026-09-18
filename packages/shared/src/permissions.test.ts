import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLES,
  permissionsForRole,
  roleHasPermission,
  type Permission,
  type Role,
} from './index';

/** Hand-written expectation, deliberately independent of the implementation. */
const EXPECTED: Record<Role, Permission[]> = {
  OWNER: [...PERMISSIONS],
  ADMIN: [...PERMISSIONS],
  DEVELOPER: [
    'organization.read',
    'users.read',
    'projects.read',
    'projects.manage',
    'incidents.read',
    'incidents.create',
    'incidents.update',
    'incidents.resolve',
    'services.manage',
  ],
  SUPPORT: [
    'organization.read',
    'users.read',
    'projects.read',
    'incidents.read',
    'incidents.create',
    'incidents.update',
  ],
  VIEWER: ['organization.read', 'users.read', 'projects.read', 'incidents.read'],
};

describe('permission matrix', () => {
  for (const role of ROLES) {
    it(`${role} has exactly the expected permissions`, () => {
      expect(new Set(permissionsForRole(role))).toEqual(new Set(EXPECTED[role]));
    });
  }

  it('is monotonic: each lower role is a subset of the one above', () => {
    const order: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER', 'SUPPORT', 'VIEWER'];
    for (let i = 1; i < order.length; i++) {
      const upper = new Set(permissionsForRole(order[i - 1]!));
      for (const permission of permissionsForRole(order[i]!))
        expect(upper.has(permission)).toBe(true);
    }
  });

  it('only OWNER and ADMIN can manage users, update the organisation or read audit logs', () => {
    for (const permission of ['users.manage', 'organization.update', 'audit.read'] as const) {
      expect(ROLES.filter((role) => roleHasPermission(role, permission))).toEqual([
        'OWNER',
        'ADMIN',
      ]);
    }
  });

  it('SUPPORT cannot resolve incidents; DEVELOPER can', () => {
    expect(roleHasPermission('SUPPORT', 'incidents.resolve')).toBe(false);
    expect(roleHasPermission('DEVELOPER', 'incidents.resolve')).toBe(true);
  });

  it('VIEWER has no write permissions', () => {
    expect(permissionsForRole('VIEWER').every((permission) => permission.endsWith('.read'))).toBe(
      true,
    );
  });
});
