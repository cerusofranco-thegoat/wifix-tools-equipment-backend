-- CreateEnum
CREATE TYPE "whitelist_status" AS ENUM ('ACTIVO', 'SUSPENDIDO', 'ORDENADO', 'PENDIENTE');

-- CreateTable
CREATE TABLE "customer_whitelist" (
    "account_number" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "document_normalized" BOOLEAN NOT NULL,
    "cparty_id" TEXT,
    "status" "whitelist_status" NOT NULL,
    "city" TEXT,
    "node" TEXT,
    "business_type" TEXT,
    "account_type" TEXT,
    "access_type" TEXT,
    "imported_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_whitelist_pkey" PRIMARY KEY ("account_number")
);

-- CreateTable
CREATE TABLE "whitelist_imports" (
    "id" UUID NOT NULL,
    "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_files" TEXT[],
    "rows" INTEGER NOT NULL,
    "accounts" INTEGER NOT NULL,
    "by_status" JSONB NOT NULL,

    CONSTRAINT "whitelist_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_whitelist_document_id_idx" ON "customer_whitelist"("document_id");

-- CreateIndex
CREATE INDEX "whitelist_imports_imported_at_idx" ON "whitelist_imports"("imported_at");

