// ISP Monitor por número de cuenta (SIMULADO). Junta las fuentes y delega en
// el generador puro:
//
//   - plan: el MISMO de client-profile (`getComarchConnector().getClientProfile`,
//     hoy el mock de Comarch, simétrico) → `RES-<kbps>/<kbps>-I`.
//   - estado de la cuenta, ciudad y nombre: whitelist de clientes de la
//     operadora si la cuenta está; si no, simulados.
//   - 404 si la whitelist está en modo bloqueo (`WHITELIST_ENFORCE`) y la cuenta
//     no está en ella: la operadora no tendría equipo para esa cuenta.
//
// NO consulta TEC ni ISP Monitor real (la operadora pidió no consultar de más y
// TEC está bloqueado desde Quasar). TODO(tec-real): mapeo cuenta → serial real.

import type { FastifyBaseLogger } from 'fastify';
import { getComarchConnector } from '../../connectors/index.js';
import { canonicalAccount } from '../../connectors/ispmonitor/account-simulation.js';
import { ApiError } from '../../middleware/error-handler.js';
import { checkWhitelist, findWhitelistFullName, type WhitelistCheck } from '../whitelist/whitelist.service.js';
import {
  buildAccessNetwork,
  buildIspMonitorAccount,
  planFromContract,
  type IspAccessNetwork,
  type IspAccountStatus,
  type IspClientInput,
  type IspMonitorAccount,
} from './isp-monitor.generator.js';

/** ACTIVO → A, SUSPENDIDO → S; ORDENADO/PENDIENTE no tienen código propio en ISP Monitor → A. */
function statusFromWhitelist(check: WhitelistCheck | null): IspAccountStatus {
  if (check && check.listed === true && check.status === 'SUSPENDIDO') return 'S';
  return 'A';
}

async function safeWhitelist(
  account: string,
  log?: FastifyBaseLogger,
): Promise<WhitelistCheck | null> {
  try {
    return await checkWhitelist(account);
  } catch (err) {
    log?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'isp-monitor: no se pudo leer la whitelist; se sigue con datos simulados',
    );
    return null;
  }
}

async function resolveClientInput(
  rawAccount: string,
  log?: FastifyBaseLogger,
): Promise<IspClientInput> {
  const account = canonicalAccount(rawAccount);
  const whitelist = await safeWhitelist(account, log);
  if (whitelist && whitelist.listed === false && whitelist.enforce) {
    throw ApiError.notFound(
      `ISP Monitor no tiene equipos para la cuenta ${account}: no está en la lista de clientes de la operadora.`,
    );
  }

  // Misma fuente que `contractedDownloadMbps` de client-profile.
  const profile = await getComarchConnector().getClientProfile(account);
  const whitelistName = await findWhitelistFullName(account, (err) =>
    log?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'isp-monitor: no se pudo leer el nombre de la whitelist',
    ),
  );

  return {
    accountNumber: account,
    clientName: (whitelistName ?? profile.fullName).toUpperCase(),
    accountStatus: statusFromWhitelist(whitelist),
    city: whitelist && whitelist.listed === true ? whitelist.city : null,
    plan: planFromContract(profile),
  };
}

export async function getIspMonitorAccount(
  accountNumber: string,
  log?: FastifyBaseLogger,
  now: Date = new Date(),
): Promise<IspMonitorAccount> {
  return buildIspMonitorAccount(await resolveClientInput(accountNumber, log), now);
}

export async function getIspAccessNetwork(
  accountNumber: string,
  log?: FastifyBaseLogger,
): Promise<IspAccessNetwork> {
  return buildAccessNetwork(await resolveClientInput(accountNumber, log));
}
