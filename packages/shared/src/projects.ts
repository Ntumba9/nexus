import { z } from 'zod';

export const SERVICE_ENVIRONMENTS = ['PRODUCTION', 'STAGING', 'DEVELOPMENT'] as const;
export const serviceEnvironmentSchema = z.enum(SERVICE_ENVIRONMENTS);
export type ServiceEnvironment = z.infer<typeof serviceEnvironmentSchema>;

export const SERVICE_HEALTH = ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'DOWN'] as const;
export type ServiceHealth = (typeof SERVICE_HEALTH)[number];

const nameSchema = z.string().trim().min(1, 'Name is required').max(100, 'Name is too long');
const descriptionSchema = z.string().trim().max(1000, 'Description is too long');

export const createProjectSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.default(''),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({ name: nameSchema, description: descriptionSchema })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const createServiceSchema = z.object({
  name: nameSchema,
  environment: serviceEnvironmentSchema.default('PRODUCTION'),
  description: descriptionSchema.default(''),
});
export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = z
  .object({
    name: nameSchema,
    environment: serviceEnvironmentSchema,
    description: descriptionSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

export const listQuerySchema = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const listServicesQuerySchema = listQuerySchema.extend({ projectId: z.uuid().optional() });

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  description: string;
  archivedAt: string | null;
  serviceCount: number;
  createdAt: string;
}

export interface ServiceDto {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  environment: ServiceEnvironment;
  healthStatus: ServiceHealth;
  /** When the health status last changed; null if it has never been assessed. */
  healthChangedAt: string | null;
  description: string;
  archivedAt: string | null;
  createdAt: string;
}
