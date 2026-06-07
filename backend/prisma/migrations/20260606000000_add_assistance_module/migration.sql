-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('TECHNICIAN', 'AGENT', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "assistance_status" AS ENUM ('REQUESTED', 'QUEUED', 'ASSIGNED', 'ACTIVE', 'ON_HOLD', 'RESOLVED', 'UNRESOLVED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "assistance_event_type" AS ENUM ('STATE_CHANGE', 'NOTE', 'ACTION', 'REMOTE_SESSION', 'CHAT', 'CONSENT');

-- CreateEnum
CREATE TYPE "remote_action_type" AS ENUM ('REBOOT', 'SET_WIFI', 'SET_CHANNEL', 'FACTORY_RESET', 'REPROVISION', 'RUN_DIAGNOSTIC');

-- CreateEnum
CREATE TYPE "remote_action_status" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "remote_session_channel" AS ENUM ('BROKER_TUNNEL', 'COBROWSE');

-- CreateEnum
CREATE TYPE "remote_session_status" AS ENUM ('OPEN', 'CLOSED', 'EXPIRED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "user_role" NOT NULL DEFAULT 'TECHNICIAN';

-- CreateTable
CREATE TABLE "assistance_sessions" (
    "id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "visit_id" TEXT,
    "technician_id" TEXT,
    "agent_id" TEXT,
    "status" "assistance_status" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "consent_at" TIMESTAMPTZ(6),
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assistance_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistance_events" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "type" "assistance_event_type" NOT NULL,
    "payload" JSONB,
    "actor_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_actions" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "account_number" TEXT NOT NULL,
    "action" "remote_action_type" NOT NULL,
    "status" "remote_action_status" NOT NULL DEFAULT 'PENDING',
    "request" JSONB,
    "result" JSONB,
    "performed_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "remote_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_sessions" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "channel" "remote_session_channel" NOT NULL,
    "status" "remote_session_status" NOT NULL DEFAULT 'OPEN',
    "target_host" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "recording_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "remote_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_call_logs" (
    "id" UUID NOT NULL,
    "connector" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "account_number" TEXT,
    "status" INTEGER,
    "request" JSONB,
    "response" JSONB,
    "duration_ms" INTEGER,
    "actor_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legacy_scans" (
    "id" UUID NOT NULL,
    "legacy_id" TEXT,
    "scan_code" TEXT,
    "account_number" TEXT,
    "ssid" TEXT,
    "bssid" TEXT,
    "download_mbps" DOUBLE PRECISION,
    "upload_mbps" DOUBLE PRECISION,
    "signal_dbm" INTEGER,
    "payload" JSONB NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistance_sessions_account_number_idx" ON "assistance_sessions"("account_number");

-- CreateIndex
CREATE INDEX "assistance_sessions_status_idx" ON "assistance_sessions"("status");

-- CreateIndex
CREATE INDEX "assistance_sessions_requested_at_idx" ON "assistance_sessions"("requested_at");

-- CreateIndex
CREATE INDEX "assistance_sessions_agent_id_idx" ON "assistance_sessions"("agent_id");

-- CreateIndex
CREATE INDEX "assistance_events_session_id_idx" ON "assistance_events"("session_id");

-- CreateIndex
CREATE INDEX "assistance_events_created_at_idx" ON "assistance_events"("created_at");

-- CreateIndex
CREATE INDEX "remote_actions_session_id_idx" ON "remote_actions"("session_id");

-- CreateIndex
CREATE INDEX "remote_actions_account_number_idx" ON "remote_actions"("account_number");

-- CreateIndex
CREATE INDEX "remote_actions_status_idx" ON "remote_actions"("status");

-- CreateIndex
CREATE INDEX "remote_sessions_session_id_idx" ON "remote_sessions"("session_id");

-- CreateIndex
CREATE INDEX "remote_sessions_status_idx" ON "remote_sessions"("status");

-- CreateIndex
CREATE INDEX "connector_call_logs_connector_idx" ON "connector_call_logs"("connector");

-- CreateIndex
CREATE INDEX "connector_call_logs_account_number_idx" ON "connector_call_logs"("account_number");

-- CreateIndex
CREATE INDEX "connector_call_logs_created_at_idx" ON "connector_call_logs"("created_at");

-- CreateIndex
CREATE INDEX "legacy_scans_account_number_idx" ON "legacy_scans"("account_number");

-- CreateIndex
CREATE INDEX "legacy_scans_captured_at_idx" ON "legacy_scans"("captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "legacy_scans_legacy_id_key" ON "legacy_scans"("legacy_id");

-- AddForeignKey
ALTER TABLE "assistance_events" ADD CONSTRAINT "assistance_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "assistance_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_actions" ADD CONSTRAINT "remote_actions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "assistance_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "assistance_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

