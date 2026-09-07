// Campos 1-5 y 7 — respuesta COMPUESTA (ver ADR-07).
//
// La identidad (nombres, dirección, teléfonos, email, coordenada) sale de FSM
// `/account/process`; el plan y la velocidad contratada siguen viniendo del
// mock de Comarch, porque `fsm-data-ms` no los expone y quitarlos de la pantalla
// sería una regresión visible. El bloque `sources` dice, campo por campo, de
// dónde salió cada dato para que la UI marque lo simulado.
//
// El PUT no cambia: FSM es de solo lectura y sigue escribiendo en Comarch.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import { brandFromRequest } from '../../lib/brand.js';
import { getAuthUser } from '../../middleware/authenticate.js';
import { ApiError } from '../../middleware/error-handler.js';
import {
  getClientProfileOverrides,
  getComarchConnector,
  getFsmConnector,
  type AccountOrders,
  type ClientProfile,
} from '../../connectors/index.js';
import type { FsmBrand } from '../../connectors/http/fsm-token.js';

const accountParamsSchema = z.object({
  accountNumber: z.string().min(1, 'accountNumber es obligatorio.'),
});

const brandQuerySchema = z.object({
  brand: z.string().optional(),
});

const clientProfileUpdateSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    phones: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (v) => v.fullName !== undefined || v.address !== undefined || v.phones !== undefined,
    { message: 'Indica al menos un campo a actualizar (fullName, address o phones).' },
  );

/** De dónde salió cada campo del perfil. */
type FieldSource = 'FSM' | 'MOCK' | 'COMARCH';

interface ComposedClientProfile extends ClientProfile {
  email: string | null;
  latitude: number | null;
  longitude: number | null;
  sources: Record<string, FieldSource>;
}

/**
 * Compone el perfil: lo editado a mano (PUT) manda sobre FSM, y FSM manda sobre
 * el mock de Comarch. El plan y las velocidades son siempre del mock.
 */
function composeProfile(
  base: ClientProfile,
  fsm: AccountOrders | null,
  edited: { fullName?: boolean; address?: boolean; phones?: boolean },
): ComposedClientProfile {
  const client = fsm?.client ?? null;
  const sources: Record<string, FieldSource> = {};

  const useFsmName = !edited.fullName && Boolean(client?.names);
  const fullName = useFsmName ? (client?.names as string) : base.fullName;
  sources.fullName = useFsmName ? 'FSM' : 'MOCK';

  const useFsmAddress = !edited.address && Boolean(client?.address);
  const address = useFsmAddress ? (client?.address as string) : base.address;
  sources.address = useFsmAddress ? 'FSM' : 'MOCK';

  // FSM solo trae `phoneNumber`: se expone como array de un elemento. Nunca null.
  const useFsmPhones = !edited.phones && Boolean(client?.phoneNumber);
  const phones = useFsmPhones ? [client?.phoneNumber as string] : (base.phones ?? []);
  sources.phones = useFsmPhones ? 'FSM' : 'MOCK';

  sources.email = client ? 'FSM' : 'MOCK';
  sources.latitude = client ? 'FSM' : 'MOCK';
  sources.longitude = client ? 'FSM' : 'MOCK';
  sources.planName = 'MOCK';
  sources.contractedDownloadMbps = 'MOCK';
  sources.contractedUploadMbps = 'MOCK';

  return {
    accountNumber: base.accountNumber,
    fullName,
    address,
    phones,
    planName: base.planName,
    contractedDownloadMbps: base.contractedDownloadMbps,
    contractedUploadMbps: base.contractedUploadMbps,
    email: client?.email ?? null,
    latitude: client?.latitude ?? null,
    longitude: client?.longitude ?? null,
    sources,
  };
}

/** Órdenes de la cuenta en FSM. Una sola llamada, cacheada 60 s. */
function fetchFsmOrders(accountNumber: string, brand: FsmBrand): Promise<AccountOrders> {
  return getFsmConnector().getAccountOrders(accountNumber, { brand, estado: 'Todas' });
}

export async function registerClientDataRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts/:accountNumber/client-profile', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const { brand } = parseQuery(brandQuerySchema, request.query);
    const effectiveBrand = brandFromRequest(request, brand);

    const fsm = await fetchFsmOrders(accountNumber, effectiveBrand);
    if (fsm.client === null && fsm.orders.length === 0) {
      throw ApiError.notFound(
        `FSM no tiene órdenes para la cuenta ${accountNumber} (marca ${effectiveBrand}).`,
      );
    }

    const base = await getComarchConnector().getClientProfile(accountNumber);
    const override = getClientProfileOverrides(accountNumber);
    return composeProfile(base, fsm, {
      fullName: override?.fullName !== undefined,
      address: override?.address !== undefined,
      phones: override?.phones !== undefined,
    });
  });

  app.put('/accounts/:accountNumber/client-profile', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const body = parseBody(clientProfileUpdateSchema, request.body);
    const user = getAuthUser(request);
    request.log.info(
      { user: user.id, accountNumber, action: 'updateClientProfile', fields: Object.keys(body) },
      'PUT client-profile',
    );
    // FSM es de solo lectura: la edición se guarda en Comarch y se refleja
    // como `MOCK` en `sources`. El cambio NO viaja a la operadora.
    const updated = await getComarchConnector().updateClientProfile(accountNumber, body);
    const override = getClientProfileOverrides(accountNumber);
    return composeProfile(updated, null, {
      fullName: override?.fullName !== undefined,
      address: override?.address !== undefined,
      phones: override?.phones !== undefined,
    });
  });

  app.get('/accounts/:accountNumber/contract-status', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const { brand } = parseQuery(brandQuerySchema, request.query);
    const effectiveBrand = brandFromRequest(request, brand);
    const connector = getFsmConnector();

    // Dos llamadas: estado (cache 5 min) + órdenes (cache 60 s, ya calentado
    // por client-profile si el técnico pasó antes por Datos Personales).
    const [status, orders] = await Promise.all([
      connector.getAccountStatus(accountNumber, { brand: effectiveBrand }),
      connector.getAccountOrders(accountNumber, { brand: effectiveBrand, estado: 'Todas' }),
    ]);

    if (status.statusCode === null && orders.orders.length === 0 && orders.client === null) {
      throw ApiError.notFound(
        `FSM no conoce la cuenta ${accountNumber} (marca ${effectiveBrand}).`,
      );
    }

    return {
      clientName: orders.client?.names ?? '',
      accounts: [
        {
          accountNumber,
          // FSM no expone contrato, solo órdenes de trabajo.
          contractId: null,
          status: status.status ?? 'DESCONOCIDA',
          statusCode: status.statusCode,
          statusDescription: status.statusDescription,
          lastWorkOrder: orders.orders[0]?.workOrder ?? null,
        },
      ],
      brand: effectiveBrand,
    };
  });
}
