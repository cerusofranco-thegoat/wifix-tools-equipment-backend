// Conector hacia Comarch / TYTAN — campos 1, 2, 3, 4, 5, 7.
// Implementaciones: mock determinista por accountNumber y esqueleto real
// con TODO. Selección por `connectorMode('comarch')`
// (CONNECTOR_MODE_COMARCH, con el global CONNECTOR_MODE como default).

import { connectorMode } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng, notImplemented, type AccountStatusName } from '../_shared.js';

export interface ClientProfile {
  accountNumber: string;
  fullName: string;
  address: string;
  phones: string[];
  planName: string;
  contractedDownloadMbps: number;
  contractedUploadMbps: number;
}

export interface ClientProfileUpdate {
  fullName?: string;
  address?: string;
  phones?: string[];
}

/**
 * FSM publica cinco estados (A/S/T/O/P) más el desconocido; el mock de Comarch
 * solo usa los tres históricos, pero el tipo es el mismo para toda la app.
 */
export type AccountStatus = AccountStatusName;

export interface ContractAccount {
  accountNumber: string;
  /** FSM no expone contrato, solo órdenes de trabajo: puede ser null. */
  contractId: string | null;
  status: AccountStatus;
}

export interface ContractStatus {
  clientName: string;
  accounts: ContractAccount[];
}

export interface ComarchConnector {
  getClientProfile(accountNumber: string): Promise<ClientProfile>;
  updateClientProfile(
    accountNumber: string,
    input: ClientProfileUpdate,
  ): Promise<ClientProfile>;
  getContractStatus(accountNumber: string): Promise<ContractStatus>;
}

// --- Datos base para los mocks (Ecuador, español realista) ---

const FIRST_NAMES = [
  'María', 'Juan', 'Andrea', 'Carlos', 'Lucía', 'Pedro', 'Sofía', 'Diego',
  'Camila', 'Esteban', 'Valentina', 'Ricardo', 'Paola', 'Javier', 'Daniela',
  'Sebastián', 'Gabriela', 'Felipe',
];
const LAST_NAMES = [
  'Cevallos', 'Mendoza', 'Suárez', 'Ramírez', 'Ortega', 'Vega', 'Andrade',
  'Yépez', 'Cabrera', 'Salazar', 'Bermeo', 'Tapia', 'Burbano', 'Castillo',
  'Vargas', 'Lara', 'Aguilar', 'Reyes',
];
const CITIES = ['Quito', 'Guayaquil', 'Cuenca', 'Ambato', 'Loja'];
const STREETS = [
  'Av. Amazonas', 'Av. 10 de Agosto', 'Av. de los Shyris', 'Calle Veintimilla',
  'Av. 6 de Diciembre', 'Av. Mariscal Sucre', 'Calle Bolívar', 'Av. República',
];
const PLANS: Array<{ name: string; down: number; up: number }> = [
  { name: 'Wifix Hogar 50', down: 50, up: 25 },
  { name: 'Wifix Hogar 100', down: 100, up: 50 },
  { name: 'Wifix Hogar 200', down: 200, up: 100 },
  { name: 'Wifix Hogar 400', down: 400, up: 200 },
  { name: 'Wifix Hogar 600', down: 600, up: 300 },
  { name: 'Wifix Business 1G', down: 1000, up: 500 },
];

function buildProfile(accountNumber: string): ClientProfile {
  const rng = seededRng(`comarch:profile:${accountNumber}`);
  const fullName = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)} ${rng.pick(LAST_NAMES)}`;
  const city = rng.pick(CITIES);
  const street = rng.pick(STREETS);
  const houseNumber = rng.intBetween(100, 9999);
  const apt = rng.bool(0.4) ? `, Edificio ${rng.pick(LAST_NAMES)} dpto ${rng.intBetween(101, 1205)}` : '';
  const phones = [
    `09${rng.intBetween(80000000, 99999999)}`,
    ...(rng.bool(0.6) ? [`02${rng.intBetween(2000000, 2999999)}`] : []),
  ];
  const plan = rng.pick(PLANS);
  return {
    accountNumber,
    fullName,
    address: `${street} N${houseNumber}${apt}, ${city}`,
    phones,
    planName: plan.name,
    contractedDownloadMbps: plan.down,
    contractedUploadMbps: plan.up,
  };
}

// Cache de overrides en memoria: el PUT en modo mock no persiste en BD,
// pero sí refleja el cambio durante el ciclo de vida del proceso para que
// el frontend vea coherencia GET → PUT → GET. Se borra al reiniciar.
const profileOverrides = new Map<string, ClientProfileUpdate>();

/**
 * Campos que el técnico editó a mano en esta cuenta, si los hay. Lo usa la ruta
 * compuesta de `client-profile` para que lo editado mande sobre el dato de FSM
 * y se marque como `MOCK` en `sources`.
 */
export function getClientProfileOverrides(
  accountNumber: string,
): ClientProfileUpdate | undefined {
  return profileOverrides.get(accountNumber);
}

const STATUS_VALUES: AccountStatus[] = ['ACTIVA', 'SUSPENDIDA', 'TERMINADA'];

export const comarchMock: ComarchConnector = {
  async getClientProfile(accountNumber) {
    const base = buildProfile(accountNumber);
    const override = profileOverrides.get(accountNumber);
    if (!override) return base;
    return {
      ...base,
      ...(override.fullName !== undefined ? { fullName: override.fullName } : {}),
      ...(override.address !== undefined ? { address: override.address } : {}),
      ...(override.phones !== undefined ? { phones: override.phones } : {}),
    };
  },

  async updateClientProfile(accountNumber, input) {
    const current = profileOverrides.get(accountNumber) ?? {};
    profileOverrides.set(accountNumber, { ...current, ...input });
    return this.getClientProfile(accountNumber);
  },

  async getContractStatus(accountNumber) {
    const profile = await this.getClientProfile(accountNumber);
    const rng = seededRng(`comarch:status:${accountNumber}`);
    const extraAccounts = rng.intBetween(0, 2);
    const accounts: ContractAccount[] = [
      {
        accountNumber,
        contractId: `TASK/${rng.intBetween(100000, 999999)}/2026`,
        status: STATUS_VALUES[0] as AccountStatus,
      },
    ];
    for (let i = 0; i < extraAccounts; i++) {
      accounts.push({
        accountNumber: `${accountNumber}-${i + 2}`,
        contractId: `TASK/${rng.intBetween(100000, 999999)}/2026`,
        status: rng.pick(STATUS_VALUES),
      });
    }
    return { clientName: profile.fullName, accounts };
  },
};

export const comarchReal: ComarchConnector = {
  async getClientProfile(_accountNumber) {
    // TODO: llamar a TYTAN/Comarch CM cuando entreguen credenciales.
    notImplemented('comarch.getClientProfile');
  },
  async updateClientProfile(_accountNumber, _input) {
    // TODO: invocar PUT sobre la API de TYTAN/Comarch CM.
    notImplemented('comarch.updateClientProfile');
  },
  async getContractStatus(_accountNumber) {
    // TODO: consultar status del contrato en TYTAN/Comarch CM.
    notImplemented('comarch.getContractStatus');
  },
};

export function getComarchConnector(): ComarchConnector {
  // `connectorMode('comarch')` y NO `env.CONNECTOR_MODE`: el conector real es
  // un esqueleto (`notImplemented()` → 502), así que un `CONNECTOR_MODE=real`
  // global no puede arrastrarlo. Se enciende solo con CONNECTOR_MODE_COMARCH.
  const mode = connectorMode('comarch');
  switch (mode) {
    case 'mock':
      return comarchMock;
    case 'real':
      return comarchReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${mode}`);
  }
}
