-- Vínculo de los registros de Herramientas / Equipos Retirados con la visita
-- FSM (tarea `TASK/…` u orden `ORDER/…`) y speedtest de dispositivo externo.
-- 100 % ADITIVA: columnas nullable o con default; ningún dato existente cambia.

-- CreateEnum
CREATE TYPE "speedtest_source" AS ENUM ('app', 'external-device');

-- AlterTable
ALTER TABLE "distance_measurements" ADD COLUMN "task_id" TEXT;

-- AlterTable
ALTER TABLE "ping_tests" ADD COLUMN "task_id" TEXT;

-- AlterTable
ALTER TABLE "retired_equipment" ADD COLUMN "task_id" TEXT;

-- AlterTable
ALTER TABLE "speedtests" ADD COLUMN "device_id" TEXT,
ADD COLUMN "device_name" TEXT,
ADD COLUMN "simulated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "source" "speedtest_source" NOT NULL DEFAULT 'app',
ADD COLUMN "task_id" TEXT;

-- AlterTable
ALTER TABLE "traceroute_tests" ADD COLUMN "task_id" TEXT;

-- AlterTable
ALTER TABLE "wifi_heatmaps" ADD COLUMN "task_id" TEXT;

-- CreateIndex
CREATE INDEX "distance_measurements_account_number_task_id_idx" ON "distance_measurements"("account_number", "task_id");

-- CreateIndex
CREATE INDEX "ping_tests_account_number_task_id_idx" ON "ping_tests"("account_number", "task_id");

-- CreateIndex
CREATE INDEX "retired_equipment_account_number_task_id_idx" ON "retired_equipment"("account_number", "task_id");

-- CreateIndex
CREATE INDEX "speedtests_account_number_task_id_idx" ON "speedtests"("account_number", "task_id");

-- CreateIndex
CREATE INDEX "traceroute_tests_account_number_task_id_idx" ON "traceroute_tests"("account_number", "task_id");

-- CreateIndex
CREATE INDEX "wifi_heatmaps_account_number_task_id_idx" ON "wifi_heatmaps"("account_number", "task_id");
