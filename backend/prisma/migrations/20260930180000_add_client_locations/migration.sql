-- Ubicación "Casa cliente" capturada por el técnico (GPS o manual), vinculada
-- a la NAP del cliente. APPEND-ONLY. 100 % ADITIVA: tipos, tabla e índices
-- nuevos; ningún dato existente cambia.

-- CreateEnum
CREATE TYPE "client_location_label" AS ENUM ('CASA_CLIENTE');

-- CreateEnum
CREATE TYPE "client_location_source" AS ENUM ('GPS', 'MANUAL');

-- CreateTable
CREATE TABLE "client_locations" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "label" "client_location_label" NOT NULL DEFAULT 'CASA_CLIENTE',
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy_meters" DOUBLE PRECISION,
    "source" "client_location_source" NOT NULL,
    "nap_code" TEXT,
    "nap_port" TEXT,
    "nap_latitude" DOUBLE PRECISION,
    "nap_longitude" DOUBLE PRECISION,
    "nap_simulated" BOOLEAN,
    "task_id" TEXT,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "notes" TEXT,
    "captured_by_id" TEXT NOT NULL,
    "captured_by_email" TEXT NOT NULL,
    "registered_latitude" DOUBLE PRECISION,
    "registered_longitude" DOUBLE PRECISION,
    "registered_source" TEXT,
    "distance_to_registered_meters" DOUBLE PRECISION,
    "distance_to_nap_meters" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_locations_account_number_captured_at_idx" ON "client_locations"("account_number", "captured_at");

-- CreateIndex
CREATE INDEX "client_locations_account_number_task_id_idx" ON "client_locations"("account_number", "task_id");

-- CreateIndex
CREATE INDEX "client_locations_captured_at_idx" ON "client_locations"("captured_at");

