/** Injection tokens for infrastructure singletons. */
export const ENV = Symbol('ENV');
export const PRISMA = Symbol('PRISMA');
export const REDIS = Symbol('REDIS');
/** BullMQ producer for GitHub webhook processing jobs. */
export const WEBHOOK_QUEUE = Symbol('WEBHOOK_QUEUE');
/** BullMQ producer for knowledge-base embedding jobs. */
export const KNOWLEDGE_QUEUE = Symbol('KNOWLEDGE_QUEUE');
/** BullMQ producer for AI investigation jobs. */
export const AI_QUEUE = Symbol('AI_QUEUE');
