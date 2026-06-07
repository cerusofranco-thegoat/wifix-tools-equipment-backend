/**
 * Repositorio del módulo Asistencia Técnica.
 * Fase B: queries Prisma para sesiones, eventos, acciones y sesiones remotas.
 */

import { prisma } from '../../db/prisma.js';
import type {
  AssistanceSession,
  AssistanceEvent,
  RemoteAction,
  RemoteSession,
  AssistanceStatus,
  AssistanceEventType,
  RemoteActionType,
  RemoteActionStatus,
  RemoteSessionChannel,
} from '@prisma/client';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Tipos de entrada del repositorio
// ---------------------------------------------------------------------------

export interface CreateSessionData {
  accountNumber: string;
  visitId?: string;
  reason?: string;
  technicianId: string;
  consentAt: Date | null;
}

export interface CreateEventData {
  sessionId: string;
  type: AssistanceEventType;
  payload?: Record<string, unknown> | null;
  actorId?: string | null;
}

export interface CreateRemoteActionData {
  sessionId: string;
  accountNumber: string;
  action: RemoteActionType;
  request?: Record<string, unknown> | null;
  performedBy: string;
}

export interface CreateRemoteSessionData {
  sessionId: string;
  channel: RemoteSessionChannel;
  targetHost?: string;
  expiresAt: Date;
}

export interface ListSessionsFilter {
  status?: AssistanceStatus;
  accountNumber?: string;
  page: number;
  pageSize: number;
}

export interface ListEventsFilter {
  sessionId: string;
  page: number;
  pageSize: number;
}

export interface ListActionsFilter {
  sessionId: string;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

async function createSession(data: CreateSessionData): Promise<AssistanceSession> {
  return prisma.assistanceSession.create({
    data: {
      accountNumber: data.accountNumber,
      visitId: data.visitId ?? null,
      reason: data.reason ?? null,
      technicianId: data.technicianId,
      consentAt: data.consentAt,
      status: 'QUEUED',
    },
  });
}

async function findSessionById(id: string): Promise<AssistanceSession | null> {
  return prisma.assistanceSession.findUnique({ where: { id } });
}

async function listSessions(
  filter: ListSessionsFilter,
): Promise<{ items: AssistanceSession[]; total: number }> {
  const where: Prisma.AssistanceSessionWhereInput = {};
  if (filter.status) where.status = filter.status;
  if (filter.accountNumber) where.accountNumber = filter.accountNumber;

  const [items, total] = await Promise.all([
    prisma.assistanceSession.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.assistanceSession.count({ where }),
  ]);

  return { items, total };
}

async function updateSessionStatus(
  id: string,
  status: AssistanceStatus,
  extra?: {
    agentId?: string;
    resolutionNote?: string;
    closedAt?: Date;
  },
): Promise<AssistanceSession> {
  return prisma.assistanceSession.update({
    where: { id },
    data: {
      status,
      ...(extra?.agentId !== undefined ? { agentId: extra.agentId } : {}),
      ...(extra?.resolutionNote !== undefined ? { resolutionNote: extra.resolutionNote } : {}),
      ...(extra?.closedAt !== undefined ? { closedAt: extra.closedAt } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

async function createEvent(data: CreateEventData): Promise<AssistanceEvent> {
  return prisma.assistanceEvent.create({
    data: {
      sessionId: data.sessionId,
      type: data.type,
      payload: data.payload != null ? (data.payload as Prisma.InputJsonValue) : Prisma.JsonNull,
      actorId: data.actorId ?? null,
    },
  });
}

async function listEvents(
  filter: ListEventsFilter,
): Promise<{ items: AssistanceEvent[]; total: number }> {
  const where = { sessionId: filter.sessionId };
  const [items, total] = await Promise.all([
    prisma.assistanceEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.assistanceEvent.count({ where }),
  ]);
  return { items, total };
}

// ---------------------------------------------------------------------------
// Acciones remotas
// ---------------------------------------------------------------------------

async function createRemoteAction(data: CreateRemoteActionData): Promise<RemoteAction> {
  return prisma.remoteAction.create({
    data: {
      sessionId: data.sessionId,
      accountNumber: data.accountNumber,
      action: data.action,
      status: 'PENDING',
      request: data.request != null ? (data.request as Prisma.InputJsonValue) : Prisma.JsonNull,
      performedBy: data.performedBy,
    },
  });
}

async function updateRemoteActionResult(
  id: string,
  status: RemoteActionStatus,
  result: Record<string, unknown>,
): Promise<RemoteAction> {
  return prisma.remoteAction.update({
    where: { id },
    data: { status, result: result as Prisma.InputJsonValue },
  });
}

async function listActions(
  filter: ListActionsFilter,
): Promise<{ items: RemoteAction[]; total: number }> {
  const where = { sessionId: filter.sessionId };
  const [items, total] = await Promise.all([
    prisma.remoteAction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.remoteAction.count({ where }),
  ]);
  return { items, total };
}

async function findRecentActions(sessionId: string, limit = 5): Promise<RemoteAction[]> {
  return prisma.remoteAction.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

// ---------------------------------------------------------------------------
// Sesiones remotas
// ---------------------------------------------------------------------------

async function createRemoteSession(data: CreateRemoteSessionData): Promise<RemoteSession> {
  return prisma.remoteSession.create({
    data: {
      sessionId: data.sessionId,
      channel: data.channel,
      targetHost: data.targetHost ?? null,
      status: 'OPEN',
      expiresAt: data.expiresAt,
    },
  });
}

async function findActiveRemoteSession(sessionId: string): Promise<RemoteSession | null> {
  return prisma.remoteSession.findFirst({
    where: { sessionId, status: 'OPEN' },
  });
}

async function findRemoteSessionById(id: string): Promise<RemoteSession | null> {
  return prisma.remoteSession.findUnique({ where: { id } });
}

async function closeRemoteSession(id: string): Promise<RemoteSession> {
  return prisma.remoteSession.update({
    where: { id },
    data: { status: 'CLOSED', endedAt: new Date() },
  });
}

async function expireRemoteSession(id: string): Promise<RemoteSession> {
  return prisma.remoteSession.update({
    where: { id },
    data: { status: 'EXPIRED', endedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Sala de video (campo denormalizado en AssistanceSession — lo guardamos en
// un evento de tipo REMOTE_SESSION con payload videoRoom para Fase B mock)
// Para Fase B: buscamos el último evento de tipo REMOTE_SESSION con roomName.
// ---------------------------------------------------------------------------

async function findVideoRoom(
  sessionId: string,
): Promise<{ roomName: string; domain: string } | null> {
  const ev = await prisma.assistanceEvent.findFirst({
    where: {
      sessionId,
      type: 'REMOTE_SESSION',
      payload: { path: ['kind'], equals: 'video' },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!ev || !ev.payload) return null;
  const p = ev.payload as Record<string, unknown>;
  if (typeof p.roomName === 'string' && typeof p.domain === 'string') {
    return { roomName: p.roomName, domain: p.domain };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exportaciones
// ---------------------------------------------------------------------------

export const assistanceRepository = {
  // Sesiones
  createSession,
  findSessionById,
  listSessions,
  updateSessionStatus,
  // Eventos
  createEvent,
  listEvents,
  // Acciones
  createRemoteAction,
  updateRemoteActionResult,
  listActions,
  findRecentActions,
  // Sesiones remotas
  createRemoteSession,
  findActiveRemoteSession,
  findRemoteSessionById,
  closeRemoteSession,
  expireRemoteSession,
  // Video
  findVideoRoom,
};
