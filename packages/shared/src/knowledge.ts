import { z } from 'zod';

/** Limits are enforced by the API and shown by the UI from this one place. */
export const KNOWLEDGE_LIMITS = {
  titleMax: 200,
  /** About 25 pages of text; a runbook longer than this should be split. */
  contentMax: 100_000,
  maxTags: 10,
  maxDocumentsPerOrganization: 500,
  searchQueryMax: 300,
  searchLimitDefault: 8,
  searchLimitMax: 20,
} as const;

const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,29}$/, 'Tags use lowercase letters, numbers and hyphens (max 30)');

const tagsSchema = z
  .array(tagSchema)
  .max(KNOWLEDGE_LIMITS.maxTags, `At most ${KNOWLEDGE_LIMITS.maxTags} tags`)
  .transform((tags) => [...new Set(tags)]);

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(KNOWLEDGE_LIMITS.titleMax, 'Title is too long');

const contentSchema = z
  .string()
  .max(KNOWLEDGE_LIMITS.contentMax, 'The document is too long (100,000 characters at most)');

export const createKnowledgeDocumentSchema = z.object({
  title: titleSchema,
  contentMd: contentSchema.default(''),
  tags: tagsSchema.default([]),
});
export type CreateKnowledgeDocumentInput = z.infer<typeof createKnowledgeDocumentSchema>;

export const updateKnowledgeDocumentSchema = z
  .object({ title: titleSchema, contentMd: contentSchema, tags: tagsSchema })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type UpdateKnowledgeDocumentInput = z.infer<typeof updateKnowledgeDocumentSchema>;

export const listKnowledgeQuerySchema = z.object({
  /** Filters by title (case-insensitive, contains). Full search is `/knowledge/search`. */
  q: z.string().trim().max(KNOWLEDGE_LIMITS.titleMax).optional(),
  tag: tagSchema.optional(),
});
export type ListKnowledgeQuery = z.infer<typeof listKnowledgeQuerySchema>;

export const searchKnowledgeQuerySchema = z.object({
  q: z.string().trim().min(1, 'Type something to search for').max(KNOWLEDGE_LIMITS.searchQueryMax),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(KNOWLEDGE_LIMITS.searchLimitMax)
    .default(KNOWLEDGE_LIMITS.searchLimitDefault),
});
export type SearchKnowledgeQuery = z.infer<typeof searchKnowledgeQuerySchema>;

export interface KnowledgeIndexStatusDto {
  chunks: number;
  /** Chunks that already have a vector for the current embedding model. */
  embedded: number;
}

export interface KnowledgeDocumentSummaryDto {
  id: string;
  title: string;
  slug: string;
  tags: string[];
  updatedAt: string;
  updatedByName: string | null;
  index: KnowledgeIndexStatusDto;
}

export interface KnowledgeDocumentDto extends KnowledgeDocumentSummaryDto {
  contentMd: string;
  createdAt: string;
  createdByName: string | null;
}

/** How a result was found. Both means the keyword and the meaning-based ranking agreed. */
export type KnowledgeMatchKind = 'keyword' | 'semantic';

export interface KnowledgeSearchHitDto {
  documentId: string;
  title: string;
  slug: string;
  tags: string[];
  /** Where in the document the best match sits, for example "Restart runbook › Rollback". */
  heading: string;
  /** Plain text. The UI escapes it and highlights the query terms. */
  snippet: string;
  score: number;
  matchedBy: KnowledgeMatchKind[];
}

export interface KnowledgeSearchResultDto {
  data: KnowledgeSearchHitDto[];
  /** `keyword` when meaning-based search was unavailable (it degrades, it does not fail). */
  mode: 'hybrid' | 'keyword';
}

/** A job that embeds the chunks of one document that do not have a vector yet. */
export const embedDocumentPayloadSchema = z.object({
  organizationId: z.uuid(),
  documentId: z.uuid(),
});
export type EmbedDocumentPayload = z.infer<typeof embedDocumentPayloadSchema>;
