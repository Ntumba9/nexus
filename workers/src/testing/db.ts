import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@nexus/database';

/** Worker integration tests need PostgreSQL (and, for the pipeline test, Redis). */
export const HAS_DB = Boolean(process.env.DATABASE_URL);
export const HAS_DB_AND_REDIS = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

export function testPrisma(): PrismaClient {
  return createPrismaClient(process.env.DATABASE_URL ?? 'postgresql://unused');
}

export interface SeededCheck {
  organizationId: string;
  serviceId: string;
  checkId: string;
}

type CheckOverrides = Partial<{
  url: string;
  failureThreshold: number;
  recoveryThreshold: number;
  intervalSeconds: number;
  createIncidents: boolean;
  enabled: boolean;
  incidentSeverity: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
  nextRunAt: Date;
  name: string;
}>;

/** A fresh organisation → project → service, so every test is isolated from every other. */
export async function seedService(prisma: PrismaClient, serviceName = 'Checkout API') {
  const suffix = randomUUID().slice(0, 8);
  const org = await prisma.organization.create({
    data: { name: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: { organizationId: org.id, name: 'Payments', slug: `payments-${suffix}` },
  });
  const service = await prisma.service.create({
    data: { organizationId: org.id, projectId: project.id, name: serviceName },
  });
  return { organizationId: org.id, projectId: project.id, serviceId: service.id };
}

export async function seedCheck(
  prisma: PrismaClient,
  service: { organizationId: string; serviceId: string },
  overrides: CheckOverrides = {},
): Promise<SeededCheck> {
  const check = await prisma.monitoringCheck.create({
    data: {
      organizationId: service.organizationId,
      serviceId: service.serviceId,
      name: overrides.name ?? 'Health endpoint',
      url: overrides.url ?? 'https://example.com/health',
      failureThreshold: overrides.failureThreshold ?? 3,
      recoveryThreshold: overrides.recoveryThreshold ?? 2,
      intervalSeconds: overrides.intervalSeconds ?? 60,
      createIncidents: overrides.createIncidents ?? true,
      enabled: overrides.enabled ?? true,
      incidentSeverity: overrides.incidentSeverity ?? 'SEV2',
      ...(overrides.nextRunAt ? { nextRunAt: overrides.nextRunAt } : {}),
    },
  });
  return {
    organizationId: service.organizationId,
    serviceId: service.serviceId,
    checkId: check.id,
  };
}

export async function seedCheckedService(prisma: PrismaClient, overrides: CheckOverrides = {}) {
  const service = await seedService(prisma);
  const check = await seedCheck(prisma, service, overrides);
  return { ...service, ...check };
}
