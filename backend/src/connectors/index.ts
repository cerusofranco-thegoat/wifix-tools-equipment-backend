// Punto único de acceso a los conectores. Cada factory respeta
// `CONNECTOR_MODE` (mock | real) del env.

export {
  getComarchConnector,
  type ClientProfile,
  type ClientProfileUpdate,
  type ContractStatus,
  type ContractAccount,
  type AccountStatus,
} from './comarch/index.js';

export {
  getFsmConnector,
  type ClosedTask,
  type TaskResult,
  // Fase F — órdenes Vistec
  type FsmOrden,
  type FsmOrdenStatus,
  type FsmOrdenType,
  type FsmVistecParams,
  type CancelarOrdenParams,
  type CancelarOrdenResult,
} from './fsm/index.js';

export {
  getIspMonitorConnector,
  type NetworkMetrics,
  type Technology,
  type SignalLevels,
  // Fase F — telemetría de planta
  type PlantTelemetry,
} from './ispmonitor/index.js';

export {
  getAcsConnector,
  type LanDevice,
  type WifiDevice,
  type WifiConfig,
  type WifiConfigUpdate,
  type WifiBandConfig,
  type WifiBand,
  type RebootResult,
  type SetChannelParams,
  type SetChannelResult,
  type FactoryResetResult,
  type ReprovisionResult,
  type DiagnosticResult,
  type DiagnosticHop,
  type RunDiagnosticParams,
} from './acs/index.js';

export {
  getTecConnector,
  type NearbyNap,
  type NapPort,
  type NapPorts,
} from './tec/index.js';

export {
  getRmsConnector,
  type NodeEvent,
  type NodeEventStatus,
} from './rms/index.js';

// Fase F — conectores nuevos de operadora (ADR-0005)

export {
  getTicketingConnector,
  type TicketingConnector,
  type TicketResult,
  type TicketStatus,
  type TicketPriority,
  type GenerarTicketParams,
  type BackOfficeAction,
  type RetiroAnticipadoParams,
  type RetiroAnticipadoResult,
  ticketingMock,
  ticketingReal,
} from './ticketing/index.js';

export {
  getSchedulingConnector,
  type SchedulingConnector,
  type TurnoResult,
  type TurnoStatus,
  type AgendarTurnoParams,
  type CancelarTurnoParams,
  type CancelarTurnoResult,
  schedulingMock,
  schedulingReal,
} from './scheduling/index.js';
