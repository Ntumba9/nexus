-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "contentMd" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "heading" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(384),
    "embeddingModel" TEXT,
    "embeddedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_organizationId_slug_key" ON "KnowledgeDocument"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_organizationId_id_key" ON "KnowledgeDocument"("organizationId", "id");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_organizationId_updatedAt_idx" ON "KnowledgeDocument"("organizationId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "KnowledgeChunk_organizationId_documentId_ordinal_idx" ON "KnowledgeChunk"("organizationId", "documentId", "ordinal");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_organizationId_embeddingModel_idx" ON "KnowledgeChunk"("organizationId", "embeddingModel");

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation: a chunk can only belong to a document of its OWN organization, whatever the
-- application does. Deleting a document deletes its chunks.
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "KnowledgeDocument"("organizationId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Constraints Prisma cannot express.
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_title_check" CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_content_check" CHECK (char_length("contentMd") <= 100000);
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_slug_check" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,79}$');
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_tags_check" CHECK (cardinality("tags") <= 10);
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_ordinal_check" CHECK ("ordinal" >= 0);
-- A vector and the model that made it are both present or both absent.
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_embedding_pair_check" CHECK (("embedding" IS NULL) = ("embeddingModel" IS NULL));

-- Keyword search: a GIN index on the same expression the queries use.
CREATE INDEX "KnowledgeChunk_fts_idx" ON "KnowledgeChunk"
  USING GIN (to_tsvector('english', "heading" || ' ' || "content"));

-- Meaning-based search: approximate nearest neighbours by cosine distance, over chunks that have a
-- vector. Every query filters by organization as well; with a per-organization corpus that is cheap.
-- It is partial on purpose: Prisma ignores partial indexes, so `migrate dev` never tries to drop it.
-- Queries must repeat the predicate ("embedding" IS NOT NULL) for the planner to use it.
CREATE INDEX "KnowledgeChunk_embedding_idx" ON "KnowledgeChunk"
  USING hnsw ("embedding" vector_cosine_ops) WHERE "embedding" IS NOT NULL;
