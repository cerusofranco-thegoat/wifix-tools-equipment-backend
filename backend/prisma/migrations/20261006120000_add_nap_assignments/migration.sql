-- NAP elegida por el técnico en Instalación (append-only). 100 % ADITIVA:
-- tipo, tabla e índices nuevos; ningún dato existente cambia.

-- CreateEnum
CREATE TYPE "nap_assignment_source" AS ENUM ('FSM', 'TEC', 'MOCK');

-- CreateTable
CREATE TABLE "nap_assignments" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "nap_id" TEXT,
    "nap_code" TEXT NOT NULL,
    "nap_name" TEXT,
    "port" INTEGER,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "distance_meters" DOUBLE PRECISION,
    "source" "nap_assignment_source" NOT NULL,
    "task_id" TEXT,
    "work_order" TEXT,
    "technician_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nap_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nap_assignments_account_number_created_at_idx" ON "nap_assignments"("account_number", "created_at");

-- CreateIndex
CREATE INDEX "nap_assignments_account_number_task_id_idx" ON "nap_assignments"("account_number", "task_id");

-- CreateIndex
CREATE INDEX "nap_assignments_created_at_id_idx" ON "nap_assignments"("created_at", "id");
