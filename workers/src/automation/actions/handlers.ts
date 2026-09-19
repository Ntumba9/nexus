import type { ActionHandler } from '../executor';
import type { SafePoster } from '../safe-post';
import { runCreateIncident } from './create-incident';
import { createWebhookHandler } from './webhook';

/**
 * The actions beyond `notify`, keyed by action type. Adding an action means writing its handler and
 * registering it here (and adding its schema in @nexus/shared); the executor stays unchanged.
 */
export function createActionHandlers(deps: {
  key: Buffer | undefined;
  post: SafePoster;
}): Record<'webhook' | 'create_incident', ActionHandler> {
  return {
    webhook: createWebhookHandler(deps) as ActionHandler,
    create_incident: runCreateIncident as ActionHandler,
  };
}
