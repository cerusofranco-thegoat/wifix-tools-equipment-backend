-- CreateEnum
CREATE TYPE "equipment_category" AS ENUM ('DECODIFICADOR', 'DECODIFICADOR_HD', 'MTA', 'ONU', 'ONT', 'ROUTER');

-- CreateEnum
CREATE TYPE "equipment_serial_field_type" AS ENUM ('SN', 'HOST-SN', 'PON-SN', 'GPON-SN', 'D-SN');

-- CreateEnum
CREATE TYPE "removal_reason_code" AS ENUM ('DANO_FISICO', 'NO_ENCIENDE', 'PUERTO_DANADO', 'EQUIPO_INHIBIDO', 'NO_DA_SERVICIO', 'NO_SE_APROVISIONA', 'EQUIPO_OK_CANCELACION', 'OTROS');

-- CreateEnum
CREATE TYPE "network_server_type" AS ENUM ('DNS', 'GATEWAY', 'CDN', 'GENERIC');

-- CreateTable
CREATE TABLE "equipment_models" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "equipment_category" NOT NULL,
    "serial_field_type" "equipment_serial_field_type" NOT NULL,
    "brand" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "equipment_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "removal_reasons" (
    "code" "removal_reason_code" NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "removal_reasons_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "speedtest_servers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "speedtest_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_servers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "type" "network_server_type" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "network_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_files" (
    "id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distance_measurements" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "client_id" TEXT,
    "contract_id" TEXT,
    "visit_id" TEXT,
    "technician_id" TEXT,
    "distance_meters" DOUBLE PRECISION NOT NULL,
    "start_lat" DOUBLE PRECISION,
    "start_lng" DOUBLE PRECISION,
    "end_lat" DOUBLE PRECISION,
    "end_lng" DOUBLE PRECISION,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "distance_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "speedtests" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "client_id" TEXT,
    "contract_id" TEXT,
    "visit_id" TEXT,
    "technician_id" TEXT,
    "download_mbps" DOUBLE PRECISION NOT NULL,
    "upload_mbps" DOUBLE PRECISION NOT NULL,
    "latency_ms" DOUBLE PRECISION,
    "jitter_ms" DOUBLE PRECISION,
    "packet_loss_percent" DOUBLE PRECISION,
    "server_id" TEXT,
    "server_name" TEXT,
    "isp_name" TEXT,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "speedtests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wifi_heatmaps" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "client_id" TEXT,
    "contract_id" TEXT,
    "visit_id" TEXT,
    "technician_id" TEXT,
    "label" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wifi_heatmaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wifi_heatmap_rooms" (
    "id" UUID NOT NULL,
    "heatmap_id" UUID NOT NULL,
    "room_name" TEXT NOT NULL,
    "floor" INTEGER NOT NULL DEFAULT 1,
    "signal_dbm" DOUBLE PRECISION NOT NULL,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "notes" TEXT,

    CONSTRAINT "wifi_heatmap_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ping_tests" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "client_id" TEXT,
    "contract_id" TEXT,
    "visit_id" TEXT,
    "technician_id" TEXT,
    "target" TEXT NOT NULL,
    "server_id" TEXT,
    "packets_sent" INTEGER,
    "packets_received" INTEGER,
    "packet_loss_percent" DOUBLE PRECISION,
    "min_latency_ms" DOUBLE PRECISION,
    "avg_latency_ms" DOUBLE PRECISION,
    "max_latency_ms" DOUBLE PRECISION,
    "continuous" BOOLEAN NOT NULL DEFAULT false,
    "heatmap_id" UUID,
    "room_name" TEXT,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ping_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traceroute_tests" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "client_id" TEXT,
    "contract_id" TEXT,
    "visit_id" TEXT,
    "technician_id" TEXT,
    "target" TEXT NOT NULL,
    "server_id" TEXT,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traceroute_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traceroute_hops" (
    "id" UUID NOT NULL,
    "traceroute_test_id" UUID NOT NULL,
    "hop_number" INTEGER NOT NULL,
    "host" TEXT,
    "latency_ms" DOUBLE PRECISION,

    CONSTRAINT "traceroute_hops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retired_equipment" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "client_id" TEXT,
    "contract_id" TEXT,
    "visit_id" TEXT,
    "technician_id" TEXT,
    "equipment_model_id" UUID NOT NULL,
    "serial_value" TEXT NOT NULL,
    "serial_field_type" "equipment_serial_field_type" NOT NULL,
    "barcode_photo_id" UUID,
    "removal_reason_code" "removal_reason_code" NOT NULL,
    "observations" TEXT,
    "retired_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retired_equipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "distance_measurements_account_number_idx" ON "distance_measurements"("account_number");

-- CreateIndex
CREATE INDEX "distance_measurements_client_id_idx" ON "distance_measurements"("client_id");

-- CreateIndex
CREATE INDEX "distance_measurements_visit_id_idx" ON "distance_measurements"("visit_id");

-- CreateIndex
CREATE INDEX "distance_measurements_measured_at_idx" ON "distance_measurements"("measured_at");

-- CreateIndex
CREATE INDEX "speedtests_account_number_idx" ON "speedtests"("account_number");

-- CreateIndex
CREATE INDEX "speedtests_client_id_idx" ON "speedtests"("client_id");

-- CreateIndex
CREATE INDEX "speedtests_visit_id_idx" ON "speedtests"("visit_id");

-- CreateIndex
CREATE INDEX "speedtests_measured_at_idx" ON "speedtests"("measured_at");

-- CreateIndex
CREATE INDEX "wifi_heatmaps_account_number_idx" ON "wifi_heatmaps"("account_number");

-- CreateIndex
CREATE INDEX "wifi_heatmaps_client_id_idx" ON "wifi_heatmaps"("client_id");

-- CreateIndex
CREATE INDEX "wifi_heatmaps_visit_id_idx" ON "wifi_heatmaps"("visit_id");

-- CreateIndex
CREATE INDEX "wifi_heatmaps_created_at_idx" ON "wifi_heatmaps"("created_at");

-- CreateIndex
CREATE INDEX "wifi_heatmap_rooms_heatmap_id_idx" ON "wifi_heatmap_rooms"("heatmap_id");

-- CreateIndex
CREATE INDEX "ping_tests_account_number_idx" ON "ping_tests"("account_number");

-- CreateIndex
CREATE INDEX "ping_tests_client_id_idx" ON "ping_tests"("client_id");

-- CreateIndex
CREATE INDEX "ping_tests_visit_id_idx" ON "ping_tests"("visit_id");

-- CreateIndex
CREATE INDEX "ping_tests_measured_at_idx" ON "ping_tests"("measured_at");

-- CreateIndex
CREATE INDEX "ping_tests_heatmap_id_idx" ON "ping_tests"("heatmap_id");

-- CreateIndex
CREATE INDEX "traceroute_tests_account_number_idx" ON "traceroute_tests"("account_number");

-- CreateIndex
CREATE INDEX "traceroute_tests_client_id_idx" ON "traceroute_tests"("client_id");

-- CreateIndex
CREATE INDEX "traceroute_tests_visit_id_idx" ON "traceroute_tests"("visit_id");

-- CreateIndex
CREATE INDEX "traceroute_tests_measured_at_idx" ON "traceroute_tests"("measured_at");

-- CreateIndex
CREATE INDEX "traceroute_hops_traceroute_test_id_idx" ON "traceroute_hops"("traceroute_test_id");

-- CreateIndex
CREATE INDEX "retired_equipment_account_number_idx" ON "retired_equipment"("account_number");

-- CreateIndex
CREATE INDEX "retired_equipment_client_id_idx" ON "retired_equipment"("client_id");

-- CreateIndex
CREATE INDEX "retired_equipment_visit_id_idx" ON "retired_equipment"("visit_id");

-- CreateIndex
CREATE INDEX "retired_equipment_serial_value_idx" ON "retired_equipment"("serial_value");

-- CreateIndex
CREATE INDEX "retired_equipment_retired_at_idx" ON "retired_equipment"("retired_at");

-- AddForeignKey
ALTER TABLE "wifi_heatmap_rooms" ADD CONSTRAINT "wifi_heatmap_rooms_heatmap_id_fkey" FOREIGN KEY ("heatmap_id") REFERENCES "wifi_heatmaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ping_tests" ADD CONSTRAINT "ping_tests_heatmap_id_fkey" FOREIGN KEY ("heatmap_id") REFERENCES "wifi_heatmaps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traceroute_hops" ADD CONSTRAINT "traceroute_hops_traceroute_test_id_fkey" FOREIGN KEY ("traceroute_test_id") REFERENCES "traceroute_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retired_equipment" ADD CONSTRAINT "retired_equipment_equipment_model_id_fkey" FOREIGN KEY ("equipment_model_id") REFERENCES "equipment_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retired_equipment" ADD CONSTRAINT "retired_equipment_removal_reason_code_fkey" FOREIGN KEY ("removal_reason_code") REFERENCES "removal_reasons"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retired_equipment" ADD CONSTRAINT "retired_equipment_barcode_photo_id_fkey" FOREIGN KEY ("barcode_photo_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
