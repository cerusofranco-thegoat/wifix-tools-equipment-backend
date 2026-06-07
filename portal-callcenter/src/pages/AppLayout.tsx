import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/auth.store';
import { assistanceSocket } from '../lib/ws/AssistanceSocket';
import clsx from 'clsx';

function WsIndicator() {
  const [connected, setConnected] = useState(assistanceSocket.isConnected);

  useEffect(() => {
    const interval = setInterval(() => {
      setConnected(assistanceSocket.isConnected);
    }, 2_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <span
      title={connected ? 'Conexión en tiempo real activa' : 'Sin conexión en tiempo real'}
      aria-label={connected ? 'Conectado' : 'Desconectado'}
      className="flex items-center gap-1.5 text-xs text-gray-500"
    >
      <span
        className={clsx('h-2 w-2 rounded-full', connected ? 'bg-green-500' : 'bg-red-400')}
        aria-hidden="true"
      />
      {connected ? 'En línea' : 'Sin conexión'}
    </span>
  );
}

export function AppLayout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Skip link para navegación por teclado */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50
                   focus:rounded focus:bg-blue-600 focus:text-white focus:px-4 focus:py-2 focus:text-sm"
      >
        Ir al contenido principal
      </a>

      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="font-bold text-blue-700 text-lg select-none">Wifix CC</span>
          <nav aria-label="Navegación principal">
            <ul className="flex gap-1 list-none m-0 p-0">
              <li>
                <NavLink
                  to="/queue"
                  className={({ isActive }) =>
                    clsx(
                      'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-600 hover:bg-gray-100',
                    )
                  }
                >
                  Cola de solicitudes
                </NavLink>
              </li>
            </ul>
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <WsIndicator />
          {user && (
            <span className="text-sm text-gray-700 hidden sm:block" aria-label="Usuario actual">
              <span className="font-medium">{user.name}</span>{' '}
              <span className="text-gray-400">({user.role === 'SUPERVISOR' ? 'Supervisor' : 'Agente'})</span>
            </span>
          )}
          <button
            onClick={handleLogout}
            className="text-sm text-gray-500 hover:text-gray-900 focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-2 py-1"
            aria-label="Cerrar sesión"
          >
            Salir
          </button>
        </div>
      </header>

      {/* Contenido */}
      <main id="main-content" className="flex-1 p-4 md:p-6 max-w-7xl mx-auto w-full">
        <Outlet />
      </main>
    </div>
  );
}
