// Punto único de acceso a los conectores. Cada factory respeta
// `CONNECTOR_MODE` (mock | real) del env, con override por conector.

export {
  getComarchConnector,
  getClientProfileOverrides,
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
  type FsmStatusCode,
  type AccountOrders,
  type AccountOrder,
  type AccountOrdersClient,
  type AccountStatusResult,
  type StatusBatchResult,
  type StatusBatchItem,
  type WorkOrderTasks,
  type WorkOrderTask,
  type PreviousVisitsResult,
  type UnsatisfactoryTasksResult,
} from './fsm/index.js';

export type { FsmBrand } from './http/fsm-token.js';

export type { Degraded, DegradedReason, AccountStatusCode, AccountStatusName } from './_shared.js';

export {
  getIspMonitorConnector,
  type NetworkMetrics,
  type Technology,
  type SignalLevels,
  type TerminalSnapshot,
  type TerminalHistoryEntry,
  type Series24h,
  type SeriesScope,
  type SeriesMetric,
  type TerminalDiagnostics,
} from './ispmonitor/index.js';

export {
  getAcsConnector,
  type LanDevice,
  type WifiDevice,
  type WifiConfig,
  type WifiConfigUpdate,
  type WifiBandConfig,
  type WifiBand,
} from './acs/index.js';

export {
  getTecConnector,
  type Coordinates,
  type NearbyNap,
  type NapPort,
  type NapPorts,
  type NapSource,
  type StatusFanOut,
} from './tec/index.js';

// Política de fuente de NAPs (FSM primaria, TEC de respaldo). Ver ADR-04.
export { getNearbyNaps, getNapPortsByRef } from './naps.js';

export {
  getRmsConnector,
  type NodeEvent,
  type NodeEventStatus,
} from './rms/index.js';
