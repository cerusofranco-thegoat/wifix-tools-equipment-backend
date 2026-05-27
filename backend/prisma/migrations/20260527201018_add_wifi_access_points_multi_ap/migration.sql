-- AlterTable
ALTER TABLE "wifi_heatmap_rooms" ADD COLUMN     "legacy_format" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "signal_dbm" DROP NOT NULL;

-- CreateTable
CREATE TABLE "wifi_access_points" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "bssid" TEXT NOT NULL,
    "ssid" TEXT,
    "label" TEXT NOT NULL,
    "ap_type" TEXT NOT NULL DEFAULT 'unknown',
    "band" TEXT NOT NULL DEFAULT 'unknown',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wifi_access_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_ap_measurements" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "access_point_id" UUID,
    "bssid" TEXT NOT NULL,
    "ap_label_snapshot" TEXT,
    "signal_dbm" DOUBLE PRECISION NOT NULL,
    "band" TEXT NOT NULL DEFAULT 'unknown',
    "channel" INTEGER,
    "is_connected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_ap_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wifi_access_points_account_number_idx" ON "wifi_access_points"("account_number");

-- CreateIndex
CREATE UNIQUE INDEX "wifi_access_points_account_number_bssid_key" ON "wifi_access_points"("account_number", "bssid");

-- CreateIndex
CREATE INDEX "room_ap_measurements_room_id_idx" ON "room_ap_measurements"("room_id");

-- CreateIndex
CREATE INDEX "room_ap_measurements_access_point_id_idx" ON "room_ap_measurements"("access_point_id");

-- CreateIndex
CREATE INDEX "room_ap_measurements_bssid_idx" ON "room_ap_measurements"("bssid");

-- AddForeignKey
ALTER TABLE "room_ap_measurements" ADD CONSTRAINT "room_ap_measurements_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "wifi_heatmap_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_ap_measurements" ADD CONSTRAINT "room_ap_measurements_access_point_id_fkey" FOREIGN KEY ("access_point_id") REFERENCES "wifi_access_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: cada room existente con signal_dbm pasa a tener una measurement
-- sintética con BSSID 'legacy-unknown' y queda marcada como legacy_format=true.
-- Los frontends nuevos van a ver estos heatmaps con un único AP sin desglose.
INSERT INTO "room_ap_measurements" ("id", "room_id", "bssid", "ap_label_snapshot", "signal_dbm", "band", "is_connected")
SELECT
  gen_random_uuid(),
  r."id",
  'legacy-unknown',
  'Medición previa (formato anterior)',
  r."signal_dbm",
  'unknown',
  false
FROM "wifi_heatmap_rooms" r
WHERE r."signal_dbm" IS NOT NULL;

UPDATE "wifi_heatmap_rooms"
SET "legacy_format" = true
WHERE "signal_dbm" IS NOT NULL;
