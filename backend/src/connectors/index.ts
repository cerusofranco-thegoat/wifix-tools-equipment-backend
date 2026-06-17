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

export { getFsmConnector, type ClosedTask, type TaskResult } from './fsm/index.js';

export {
  getIspMonitorConnector,
  type NetworkMetrics,
  type Technology,
  type SignalLevels,
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
  type NearbyNap,
  type NapPort,
  type NapPorts,
} from './tec/index.js';

export {
  getRmsConnector,
  type NodeEvent,
  type NodeEventStatus,
} from './rms/index.js';
