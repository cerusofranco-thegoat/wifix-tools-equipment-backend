-- Validación de equipo vs plan contratado. 100 % ADITIVA: tipos, tablas e
-- índices nuevos; ningún dato existente cambia.
--
-- `device_models`: catálogo de equipos homologados. Se siembra acá con los 19
-- modelos 'Moderno' de la planilla "Velocidades por modelos de equipos GPON"
-- (misma data que `prisma/catalogs/device-catalog.json`) para que el módulo
-- funcione apenas se migra, sin la planilla en el servidor. Actualizaciones
-- posteriores: `npm run device-catalog:import` (upsert por `model`).
--
-- `device_validations`: APPEND-ONLY. Cada intento del técnico es una fila; un
-- BLOCKED es una alerta para el gerente.

-- CreateEnum
CREATE TYPE "device_wifi_status" AS ENUM ('ENABLED', 'NONE', 'DISABLED');

-- CreateEnum
CREATE TYPE "device_validation_category" AS ENUM ('INSTALACIONES', 'MIGRACIONES', 'VISITAS');

-- CreateEnum
CREATE TYPE "device_validation_result" AS ENUM ('OK', 'BLOCKED', 'UNKNOWN_PLAN');

-- CreateTable
CREATE TABLE "device_models" (
    "id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "device_type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "wifi_tech" TEXT,
    "ethernet_max_mbps" INTEGER NOT NULL,
    "wifi_max_mbps" INTEGER,
    "wifi_status" "device_wifi_status" NOT NULL,
    "serial_prefixes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "device_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_validations" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "category" "device_validation_category" NOT NULL,
    "task_id" TEXT,
    "serial" TEXT NOT NULL,
    "serial_source" TEXT,
    "model" TEXT NOT NULL,
    "device_model_id" UUID,
    "result" "device_validation_result" NOT NULL,
    "plan_mbps" INTEGER,
    "plan_source" TEXT NOT NULL,
    "device" JSONB,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "message" TEXT NOT NULL,
    "validated_by_id" TEXT NOT NULL,
    "validated_by_email" TEXT NOT NULL,
    "validated_by_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_validations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_models_model_key" ON "device_models"("model");

-- CreateIndex
CREATE INDEX "device_models_active_idx" ON "device_models"("active");

-- CreateIndex
CREATE INDEX "device_validations_account_number_created_at_idx" ON "device_validations"("account_number", "created_at");

-- CreateIndex
CREATE INDEX "device_validations_account_number_task_id_idx" ON "device_validations"("account_number", "task_id");

-- CreateIndex
CREATE INDEX "device_validations_result_created_at_idx" ON "device_validations"("result", "created_at");

-- CreateIndex
CREATE INDEX "device_validations_created_at_idx" ON "device_validations"("created_at");

-- AddForeignKey
ALTER TABLE "device_validations" ADD CONSTRAINT "device_validations_device_model_id_fkey" FOREIGN KEY ("device_model_id") REFERENCES "device_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Restricciones de dominio (Prisma no las modela).
ALTER TABLE "device_models" ADD CONSTRAINT "device_models_ethernet_max_mbps_check" CHECK ("ethernet_max_mbps" > 0);
ALTER TABLE "device_models" ADD CONSTRAINT "device_models_wifi_max_mbps_check" CHECK ("wifi_max_mbps" IS NULL OR "wifi_max_mbps" > 0);
ALTER TABLE "device_validations" ADD CONSTRAINT "device_validations_plan_mbps_check" CHECK ("plan_mbps" IS NULL OR "plan_mbps" > 0);

-- Catálogo inicial (19 modelos 'Moderno'). Idempotente.
INSERT INTO "device_models" ("id", "model", "display_name", "brand", "device_type", "category", "wifi_tech", "ethernet_max_mbps", "wifi_max_mbps", "wifi_status", "serial_prefixes", "active", "created_at", "updated_at") VALUES
    (gen_random_uuid(), 'ROUTER ZXHN H3601P V9 WIFI 6', 'ROUTER ZXHN H3601P V9 WIFI 6', 'ZTE', 'ROUTER', 'Router WiFi', 'WIFI 6', 1000, 1200, 'ENABLED'::"device_wifi_status", ARRAY['ZTEL']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'AX3 DUAL CORE WIFI 6', 'AX3 DUAL CORE WIFI 6', 'HUAWEI', 'ROUTER', 'Router WiFi', 'WIFI 6', 1000, 1000, 'ENABLED'::"device_wifi_status", ARRAY['BWH']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'AX3 QUAD CORE WIFI 6', 'AX3 QUAD CORE WIFI 6', 'HUAWEI', 'ROUTER', 'Router WiFi', 'WIFI 6', 1000, 1000, 'ENABLED'::"device_wifi_status", ARRAY['BWH']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'POWER LINE TP-LINK TLWPA4220 STARTER KIT', 'POWER LINE TP-LINK TLWPA4220 STARTER KIT', 'TP-LINK', 'REPETIDOR POWERLINE', 'Accesorio (Power Line)', 'WIFI 4', 100, 300, 'ENABLED'::"device_wifi_status", ARRAY[]::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ONT HUR 2001', 'ONT HUR 2001', 'INTELLEGO', 'ONT', 'ONT / ONU (GPON)', 'SIN WIFI', 1000, NULL, 'NONE'::"device_wifi_status", ARRAY['STGU']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ONU Bridge TXG-B2000', 'ONU Bridge TXG-B2000', 'ONU', 'ONT', 'ONT / ONU (GPON)', 'SIN WIFI', 1000, NULL, 'NONE'::"device_wifi_status", ARRAY['XPON']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ONU HUR4101XR', 'ONU HUR4101XR', 'INTELLEGO', 'ONT', 'ONT / ONU (GPON)', 'SIN WIFI', 1000, NULL, 'NONE'::"device_wifi_status", ARRAY['STGU']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ONU300G-1G', 'ONU300G-1G', 'Blik Telecom', 'ONT', 'ONT / ONU (GPON)', 'SIN WIFI', 1000, NULL, 'NONE'::"device_wifi_status", ARRAY['STGU']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ZXHN F601', 'ZXHN F601', 'ZTE', 'ONT', 'ONT / ONU (GPON)', 'SIN WIFI', 1000, NULL, 'NONE'::"device_wifi_status", ARRAY['ZTEG']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ZXHN F612C', 'ZXHN F612C', 'ZTE', 'ONT', 'ONT / ONU (GPON)', 'SIN WIFI', 1000, NULL, 'NONE'::"device_wifi_status", ARRAY['ZTEG']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ZXHN F660', 'ZXHN F660', 'ZTE', 'ONT', 'ONT / ONU (GPON)', 'WIFI 4', 1000, 300, 'DISABLED'::"device_wifi_status", ARRAY['ZTEG']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ZXHN F670L', 'ZXHN F670L', 'ZTE', 'ONT', 'ONT / ONU (GPON)', 'WIFI 5', 1000, 500, 'ENABLED'::"device_wifi_status", ARRAY['ZTEG']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ZXHN F670Y', 'ZXHN F670Y', 'ZTE', 'ONT', 'ONT / ONU (GPON)', 'WIFI 5', 1000, 500, 'ENABLED'::"device_wifi_status", ARRAY['ZTEG']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ZXHN F688 V9.0', 'ZXHN F688 V9.0', 'ZTE', 'ONT', 'ONT / ONU (GPON)', 'WIFI 5', 1000, 500, 'ENABLED'::"device_wifi_status", ARRAY['ZTEG']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ONT OptiXstar HG8145X6', 'ONT OptiXstar HG8145X6', 'HUAWEI', 'ONT', 'ONT / ONU (GPON)', 'WIFI 6', 1000, 1000, 'ENABLED'::"device_wifi_status", ARRAY['HWTC']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ONT ZTE ZXHN F6600 WIFI 6', 'ONT ZTE ZXHN F6600 WIFI 6', 'ZTE', 'ONT', 'ONT / ONU (GPON)', 'WIFI 6', 1000, 1000, 'ENABLED'::"device_wifi_status", ARRAY['ZTEG']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ONT ZTE ZXHN F6600P', 'ONT ZTE ZXHN F6600P', 'ZTE', 'ONT', 'ONT / ONU (GPON)', 'WIFI 6', 1000, 1000, 'ENABLED'::"device_wifi_status", ARRAY['ZTEG']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ONT ZXHN F1611A-1FXS', 'ONT ZXHN F1611A-1FXS', 'ZTE', 'ONT', 'ONT / ONU (GPON)', 'WIFI 6', 1000, 1200, 'ENABLED'::"device_wifi_status", ARRAY['ZTEG']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'ONT ZTE XGS-PON ZXHN F8605P', 'ONT XGS-PON ZXHN F8605P', 'ZTE', 'ONT', 'ONT / ONU (XGS-PON)', 'WIFI 6', 2500, 1800, 'ENABLED'::"device_wifi_status", ARRAY['ZTEG']::TEXT[], true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("model") DO NOTHING;
