import type { Role } from '@nexus/shared';
import type { Request } from 'express';

export interface AuthContext {
  sessionId: string;
  user: { id: string; email: string; name: string };
}

/** Resolved by the org access guard: who is acting, in which organisation, with which role. */
export interface TenantContext {
  organizationId: string;
  userId: string;
  memberId: string;
  role: Role;
}

export interface AppRequest extends Request {
  id?: string;
  auth?: AuthContext;
  tenant?: TenantContext;
}
