// ---------------------------------------------------------------------------
// Validación de equipo vs plan contratado.
//
// El técnico escanea el equipo que va a instalar (Instalaciones, Migraciones,
// Visita técnica) y el servidor decide si soporta la velocidad del plan del
// cliente (`evaluateDeviceValidation`, regla pura compartida con la webapp).
//
// - Append-only: se guardan TODOS los intentos (ok, bloqueados, sin plan). Un
//   BLOCKED es una alerta para el gerente (`GET /device-validations`).
// - planMbps NO viene del cliente: sale de la misma fuente que alimenta
//   `contractedDownloadMbps` de client-profile (hoy el mock de Comarch →
//   `planSource: 'simulated'`). Si esa fuente falla → `unknown_plan`.
// - `taskId` opcional, igual que los demás registros por visita: si no viene,
//   `/visits?include=records` lo asocia por ventana de tiempo.
// - Al guardar se toma una FOTO del equipo del catálogo y de las razones: el
//   historial no cambia si después se actualiza el catálogo.
// ---------------------------------------------------------------------------

import type { Prisma } from '@prisma/client';
import { connectorMode } from '../../config/env.js';
import { getComarchConnector } from '../../connectors/index.js';
import { toPageInfo, type PageInfo } from '../../lib/pagination.js';
import { accountVariants, storedAccountNumber } from '../client-location/client-location.service.js';
import { deviceCatalogRepository, deviceValidationRepository } from './device-validation.repository.js';
import {
  toCatalogItem,
  toDeviceValidationDto,
  toPrismaCategory,
  toPrismaResult,
  type DeviceValidationDto,
  type PlanSource,
} from './device-validation.mappers.js';
import {
  evaluateDeviceValidation,
  findCatalogItem,
  type DeviceCatalogItem,
} from './device-validation.rules.js';
import type { DeviceValidationInput, DeviceValidationListQuery } from './device-validation.schemas.js';

export interface ValidatedBy {
  id: string;
  email: string;
  name?: string | null;
}

export interface ContractedPlan {
  planMbps: number | null;
  planSource: PlanSource;
}

export interface DeviceValidationPage {
  items: DeviceValidationDto[];
  page: PageInfo;
}

/**
 * Velocidad de bajada contratada: la MISMA fuente que `contractedDownloadMbps`
 * del perfil del cliente. Nunca lanza: si la fuente falla, `planMbps: null`.
 */
export async function resolveContractedPlan(accountNumber: string): Promise<ContractedPlan> {
  const planSource: PlanSource = connectorMode('comarch') === 'real' ? 'real' : 'simulated';
  try {
    const profile = await getComarchConnector().getClientProfile(accountNumber);
    const mbps = profile.contractedDownloadMbps;
    return {
      planMbps: Number.isFinite(mbps) && mbps > 0 ? Math.round(mbps) : null,
      planSource,
    };
  } catch {
    return { planMbps: null, planSource };
  }
}

export const deviceValidationService = {
  async listCatalog(): Promise<{ items: DeviceCatalogItem[] }> {
    const rows = await deviceCatalogRepository.listActive();
    return { items: rows.map(toCatalogItem) };
  },

  async create(
    accountNumber: string,
    input: DeviceValidationInput,
    validatedBy: ValidatedBy,
  ): Promise<DeviceValidationDto> {
    const account = accountNumber.trim();
    const [rows, plan] = await Promise.all([
      deviceCatalogRepository.listActive(),
      resolveContractedPlan(account),
    ]);
    const match = findCatalogItem(rows, input.model);
    const device = match ? toCatalogItem(match) : null;
    const verdict = evaluateDeviceValidation(device, plan.planMbps, input.model);

    const row = await deviceValidationRepository.create({
      accountNumber: storedAccountNumber(account),
      category: toPrismaCategory(input.category),
      taskId: input.taskId ?? null,
      serial: input.serial,
      serialSource: input.serialSource ?? null,
      model: input.model,
      deviceModelId: match?.id ?? null,
      result: toPrismaResult(verdict.result),
      planMbps: plan.planMbps,
      planSource: plan.planSource,
      ...(device ? { device: device as unknown as Prisma.InputJsonObject } : {}),
      reasons: verdict.reasons as unknown as Prisma.InputJsonArray,
      message: verdict.message,
      validatedById: validatedBy.id,
      validatedByEmail: validatedBy.email,
      validatedByName: validatedBy.name ?? null,
    });
    return toDeviceValidationDto(row);
  },

  /** Historial de la cuenta (más reciente primero, máx. 50). */
  async listByAccount(accountNumber: string): Promise<{ items: DeviceValidationDto[] }> {
    const rows = await deviceValidationRepository.listByAccount(accountVariants(accountNumber));
    return { items: rows.map(toDeviceValidationDto) };
  },

  /** Lista para el gerente, paginada. Solo lee la base propia. */
  async list(query: DeviceValidationListQuery): Promise<DeviceValidationPage> {
    const { items, totalItems } = await deviceValidationRepository.list({
      ...(query.accountNumber ? { accountNumbers: accountVariants(query.accountNumber) } : {}),
      ...(query.result ? { result: toPrismaResult(query.result) } : {}),
      ...(query.category ? { category: toPrismaCategory(query.category) } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      items: items.map(toDeviceValidationDto),
      page: toPageInfo({ page: query.page, pageSize: query.limit }, totalItems),
    };
  },
};
