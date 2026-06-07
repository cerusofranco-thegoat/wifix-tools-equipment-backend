// Solo consume GET /sessions/{id}/study. NO reimplementa diagnóstico.
import { useQuery } from '@tanstack/react-query';
import { getStudy } from '../../lib/api/assistance';
import { Spinner } from '../ui/Spinner';
import { ErrorMessage, EmptyState } from '../ui/ErrorMessage';
import { ApiError } from '../../lib/api/client';
import { HeatmapView } from './HeatmapView';
import clsx from 'clsx';

interface StudyPanelProps {
  sessionId: string;
}

function SpeedBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-gray-600">
        <span>{label}</span>
        <span className="font-semibold">{value.toFixed(1)} Mbps</span>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden" role="progressbar"
           aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}
           aria-label={`${label}: ${value.toFixed(1)} Mbps`}>
        <div
          className="h-full bg-blue-500 rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function SnrBullet({ snr }: { snr: number }) {
  const color =
    snr >= 30 ? 'bg-green-500' : snr >= 20 ? 'bg-yellow-500' : 'bg-red-500';
  const label =
    snr >= 30 ? 'Buena' : snr >= 20 ? 'Regular' : 'Mala';
  return (
    <span className="flex items-center gap-1.5 text-sm">
      <span className={clsx('h-3 w-3 rounded-full', color)} aria-hidden="true" />
      {snr.toFixed(1)} dB ({label})
    </span>
  );
}

export function StudyPanel({ sessionId }: StudyPanelProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['study', sessionId],
    queryFn: () => getStudy(sessionId),
    enabled: Boolean(sessionId),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="py-12 flex justify-center">
        <Spinner label="Cargando estudio WiFi..." />
      </div>
    );
  }

  if (error) {
    if (error instanceof ApiError && error.status === 404) {
      return <EmptyState message="Aún no hay estudio disponible para esta cuenta." />;
    }
    return <ErrorMessage error={error} fallback="Error al cargar el estudio." />;
  }

  if (!data) return null;

  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-400">Cuenta: {data.accountNumber}</p>

      {/* Speedtest */}
      <section aria-labelledby="speedtest-heading" className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h2 id="speedtest-heading" className="font-semibold text-gray-900 text-sm">Velocidad</h2>
        {data.latestSpeedtest ? (
          <>
            <SpeedBar value={data.latestSpeedtest.downloadMbps} max={1000} label="Descarga" />
            <SpeedBar value={data.latestSpeedtest.uploadMbps} max={500} label="Subida" />
            <p className="text-xs text-gray-400">
              Medido: {new Date(data.latestSpeedtest.measuredAt).toLocaleString('es-EC')}
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-500">Sin datos de velocidad.</p>
        )}
      </section>

      {/* Pings */}
      {data.pings.length > 0 && (
        <section aria-labelledby="pings-heading" className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 id="pings-heading" className="font-semibold text-gray-900 text-sm mb-3">Latencia</h2>
          <table className="w-full text-sm" aria-label="Resultados de ping">
            <thead>
              <tr className="text-xs text-gray-400 uppercase border-b border-gray-100">
                <th scope="col" className="pb-2 text-left font-medium">Destino</th>
                <th scope="col" className="pb-2 text-right font-medium">Latencia</th>
                <th scope="col" className="pb-2 text-right font-medium">Pérdida</th>
              </tr>
            </thead>
            <tbody>
              {data.pings.map((ping) => (
                <tr key={ping.target} className="border-b border-gray-50">
                  <td className="py-1.5 font-mono text-gray-700">{ping.target}</td>
                  <td className="py-1.5 text-right text-gray-700">
                    {ping.avgLatencyMs !== null ? `${ping.avgLatencyMs} ms` : '—'}
                  </td>
                  <td className={clsx('py-1.5 text-right',
                    ping.packetLossPercent !== null && ping.packetLossPercent > 5
                      ? 'text-red-600 font-semibold' : 'text-gray-700'
                  )}>
                    {ping.packetLossPercent !== null ? `${ping.packetLossPercent}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Dispositivos */}
      <section aria-labelledby="devices-heading" className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 id="devices-heading" className="font-semibold text-gray-900 text-sm mb-3">Dispositivos</h2>
        <div className="flex gap-6 text-sm">
          <div>
            <p className="text-gray-400 text-xs">LAN</p>
            <p className="font-bold text-2xl text-gray-900">{data.lanDeviceCount ?? '—'}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs">WiFi</p>
            <p className="font-bold text-2xl text-gray-900">{data.wifiDeviceCount ?? '—'}</p>
          </div>
        </div>
      </section>

      {/* Telemetría de planta */}
      {data.plant && (
        <section aria-labelledby="plant-heading" className="bg-white rounded-xl border border-gray-200 p-5 space-y-2">
          <h2 id="plant-heading" className="font-semibold text-gray-900 text-sm">Planta ({data.plant.source})</h2>
          {data.plant.onuRxPower !== undefined && (
            <div className="text-sm">
              <span className="text-gray-400 text-xs block">ONU Rx Power</span>
              <span className={clsx('font-semibold',
                data.plant.onuRxPower < -27 ? 'text-red-600' :
                data.plant.onuRxPower < -20 ? 'text-yellow-600' : 'text-green-700'
              )}>
                {data.plant.onuRxPower} dBm
              </span>
            </div>
          )}
          {data.plant.snr !== undefined && (
            <div className="text-sm">
              <span className="text-gray-400 text-xs block">SNR</span>
              <SnrBullet snr={data.plant.snr} />
            </div>
          )}
        </section>
      )}

      {/* Mapa de calor WiFi — datos desde GET /herramientas/v1/wifi-heatmaps/:id */}
      {data.latestHeatmapId && (
        <section aria-labelledby="heatmap-heading" className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 id="heatmap-heading" className="font-semibold text-gray-900 text-sm mb-4">
            Mapa de calor WiFi
          </h2>
          <HeatmapView heatmapId={data.latestHeatmapId} />
        </section>
      )}
    </div>
  );
}
