import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who and what the code running right now is serving. Set once per request by a middleware and
 * filled in by the guards, so logging and auditing can say which request (and person, and
 * organization) something belongs to without every function having to be handed those ids.
 */
export interface RequestScope {
  requestId?: string;
  userId?: string;
  organizationId?: string;
}

export const requestStore = new AsyncLocalStorage<RequestScope>();

export const currentRequestId = (): string | undefined => requestStore.getStore()?.requestId;

/** Record who the current request is for. A no-op outside a request (workers, tests). */
export function noteRequestScope(scope: Partial<RequestScope>): void {
  const store = requestStore.getStore();
  if (store) Object.assign(store, scope);
}
