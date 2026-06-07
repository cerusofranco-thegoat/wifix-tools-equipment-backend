// Renderiza los datos de un heatmap multi-AP desde GET /herramientas/v1/wifi-heatmaps/:id.
// NO reimplementa diagnóstico: solo muestra lo que el backend ya almacenó.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api/client';
import { Spinner } from '../ui/Spinner';
import { ErrorMessage, EmptyState } from '../ui/ErrorMessage';
import { ApiError } from '../../lib/api/client';
import clsx from 'clsx';

// ── Tipos del shape del backend ────────────────────────────────────────────────

interface RoomApMeasurementDto {
  id: string;
  bssid: string;
  accessPointId?: string;
  apLabelSnapshot?: string;
  signalDbm: number;
  band: string;
  channel?: number;
  isConnected: boolean;
}

interface HeatmapRoomDto {
  id: string;
  roomName: string;
  floor: number;
  measurements: RoomApMeasurementDto[];
  legacyFormat: boolean;
  /** Deprecated — conservado para retrocompatibilidad */
  signalDbm?: number;
  measuredAt: string;
  notes?: string;
}

interface HeatmapDto {
  id: string;
  createdAt: string;
  label?: string;
  rooms: HeatmapRoomDto[];
  notes?: string;
}

// ── Helpers de señal ───────────────────────────────────────────────────────────

type SignalLevel = 'excellent' | 'good' | 'fair' | 'weak' | 'poor';

function getSignalLevel(dbm: number): SignalLevel {
  if (dbm >= -50) return 'excellent';
  if (dbm >= -60) return 'good';
  if (dbm >= -70) return 'fair';
  if (dbm >= -80) return 'weak';
  return 'poor';
}

const SIGNAL_STYLES: Record<SignalLevel, { bar: string; text: string; label: string }> = {
  excellent: { bar: 'bg-green-500',  text: 'text-green-700',  label: 'Excelente' },
  good:      { bar: 'bg-lime-500',   text: 'text-lime-700',   label: 'Buena'     },
  fair:      { bar: 'bg-yellow-500', text: 'text-yellow-700', label: 'Regular'   },
  weak:      { bar: 'bg-orange-500', text: 'text-orange-700', label: 'Débil'     },
  poor:      { bar: 'bg-red-500',    text: 'text-red-700',    label: 'Muy débil' },
};

/** Barra visual de intensidad proporcional entre -100 dBm (0%) y -30 dBm (100%). */
function SignalBar({ dbm }: { dbm: number }) {
  const pct = Math.min(Math.max(((dbm + 100) / 70) * 100, 0), 100);
  const level = getSignalLevel(dbm);
  const { bar } = SIGNAL_STYLES[level];
  return (
    <div
      className="h-2 w-24 bg-gray-200 rounded-full overflow-hidden"
      role="img"
      aria-label={`Señal: ${dbm} dBm`}
    >
      <div className={clsx('h-full rounded-full', bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Chip de nivel de señal con color y etiqueta. */
function SignalChip({ dbm }: { dbm: number }) {
  const level = getSignalLevel(dbm);
  const { bar, label } = SIGNAL_STYLES[level];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={clsx('h-2.5 w-2.5 rounded-full flex-shrink-0', bar)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

// ── Leyenda ────────────────────────────────────────────────────────────────────

function HeatmapLegend() {
  const levels: SignalLevel[] = ['excellent', 'good', 'fair', 'weak', 'poor'];
  const ranges: Record<SignalLevel, string> = {
    excellent: '≥ −50 dBm',
    good:      '−60 a −51',
    fair:      '−70 a −61',
    weak:      '−80 a −71',
    poor:      '< −80 dBm',
  };
  return (
    <div
      className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500"
      aria-label="Leyenda de niveles de señal"
    >
      {levels.map((level) => {
        const { bar, label } = SIGNAL_STYLES[level];
        return (
          <span key={level} className="inline-flex items-center gap-1.5">
            <span className={clsx('h-2.5 w-2.5 rounded-full flex-shrink-0', bar)} aria-hidden="true" />
            <span>{label} ({ranges[level]})</span>
          </span>
        );
      })}
    </div>
  );
}

// ── Tabla de mediciones por habitación ────────────────────────────────────────

function RoomCard({ room }: { room: HeatmapRoomDto }) {
  const sortedMeasurements = [...room.measurements].sort(
    (a, b) => b.signalDbm - a.signalDbm,
  );

  return (
    <div className="bg-gray-50 rounded-lg border border-gray-100 overflow-hidden">
      <div className="px-4 py-2.5 bg-white border-b border-gray-100 flex items-center justify-between gap-3">
        <div>
          <span className="font-medium text-gray-900 text-sm">{room.roomName}</span>
          <span className="ml-2 text-xs text-gray-400">Piso {room.floor}</span>
        </div>
        <span className="text-xs text-gray-400">
          {new Date(room.measuredAt).toLocaleString('es-EC', {
            dateStyle: 'short',
            timeStyle: 'short',
          })}
        </span>
      </div>

      {sortedMeasurements.length > 0 ? (
        <table className="w-full text-sm" aria-label={`Mediciones en ${room.roomName}`}>
          <thead>
            <tr className="text-xs text-gray-400 uppercase border-b border-gray-100 bg-white">
              <th scope="col" className="px-4 py-2 text-left font-medium">AP / BSSID</th>
              <th scope="col" className="px-4 py-2 text-left font-medium">Banda</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Señal</th>
              <th scope="col" className="px-4 py-2 text-left font-medium">Nivel</th>
              <th scope="col" className="px-4 py-2 text-center font-medium">Conectado</th>
            </tr>
          </thead>
          <tbody>
            {sortedMeasurements.map((m) => (
              <tr key={m.id} className="border-b border-gray-100 last:border-0 hover:bg-white/60">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-gray-800 text-xs">
                    {m.apLabelSnapshot ?? m.bssid}
                  </div>
                  {m.apLabelSnapshot && (
                    <div className="text-gray-400 font-mono text-xs">{m.bssid}</div>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-gray-700 text-xs">{m.band}</span>
                  {m.channel != null && (
                    <span className="ml-1 text-gray-400 text-xs">ch.{m.channel}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className={clsx('font-semibold tabular-nums text-sm', SIGNAL_STYLES[getSignalLevel(m.signalDbm)].text)}>
                    {m.signalDbm} dBm
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-col gap-1">
                    <SignalChip dbm={m.signalDbm} />
                    <SignalBar dbm={m.signalDbm} />
                  </div>
                </td>
                <td className="px-4 py-2.5 text-center">
                  {m.isConnected ? (
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" aria-label="Conectado" />
                  ) : (
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-gray-300" aria-label="No conectado" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        /* Formato legacy: la habitación sólo trae signalDbm raíz */
        room.signalDbm != null ? (
          <div className="px-4 py-3 flex items-center gap-4">
            <span className="text-xs text-gray-500">Señal (legacy):</span>
            <span className={clsx('font-semibold text-sm', SIGNAL_STYLES[getSignalLevel(room.signalDbm)].text)}>
              {room.signalDbm} dBm
            </span>
            <SignalChip dbm={room.signalDbm} />
            <SignalBar dbm={room.signalDbm} />
          </div>
        ) : (
          <p className="px-4 py-3 text-xs text-gray-400">Sin mediciones registradas.</p>
        )
      )}

      {room.notes && (
        <div className="px-4 py-2 bg-amber-50 border-t border-amber-100 text-xs text-amber-700">
          Nota: {room.notes}
        </div>
      )}
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

interface HeatmapViewProps {
  heatmapId: string;
}

export function HeatmapView({ heatmapId }: HeatmapViewProps) {
  const { data, isLoading, error } = useQuery<HeatmapDto>({
    queryKey: ['heatmap', heatmapId],
    queryFn: () =>
      apiGet<HeatmapDto>(`${API_BASE}/herramientas/v1/wifi-heatmaps/${heatmapId}`),
    enabled: Boolean(heatmapId),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className="py-6 flex justify-center">
        <Spinner label="Cargando mapa de calor WiFi..." />
      </div>
    );
  }

  if (error) {
    if (error instanceof ApiError && error.status === 404) {
      return <EmptyState message="El mapa de calor no está disponible." />;
    }
    return (
      <ErrorMessage
        error={error}
        fallback="No se pudo cargar el mapa de calor. Intenta de nuevo."
      />
    );
  }

  if (!data || data.rooms.length === 0) {
    return <EmptyState message="El mapa de calor no contiene habitaciones registradas." />;
  }

  // Agrupar habitaciones por piso para la presentación
  const byFloor = data.rooms.reduce<Record<number, HeatmapRoomDto[]>>((acc, room) => {
    const f = room.floor;
    if (!acc[f]) acc[f] = [];
    acc[f].push(room);
    return acc;
  }, {});
  const floors = Object.keys(byFloor)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <div className="space-y-4">
      {/* Cabecera del heatmap */}
      <div className="flex items-start justify-between gap-2">
        <div>
          {data.label && (
            <p className="text-sm font-medium text-gray-700">{data.label}</p>
          )}
          <p className="text-xs text-gray-400">
            Registrado:{' '}
            {new Date(data.createdAt).toLocaleString('es-EC', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </p>
        </div>
        <span className="text-xs bg-gray-100 text-gray-500 rounded px-2 py-0.5">
          {data.rooms.length} {data.rooms.length === 1 ? 'habitación' : 'habitaciones'}
        </span>
      </div>

      {/* Leyenda de colores */}
      <HeatmapLegend />

      {/* Habitaciones agrupadas por piso */}
      {floors.map((floor) => (
        <div key={floor} className="space-y-2">
          {floors.length > 1 && (
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Piso {floor}
            </p>
          )}
          {(byFloor[floor] ?? []).map((room) => (
            <RoomCard key={room.id} room={room} />
          ))}
        </div>
      ))}

      {data.notes && (
        <p className="text-xs text-gray-500 border-t border-gray-100 pt-3">{data.notes}</p>
      )}
    </div>
  );
}
