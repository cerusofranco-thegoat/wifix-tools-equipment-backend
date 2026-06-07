import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="text-center">
        <p className="text-6xl font-bold text-gray-200" aria-hidden="true">404</p>
        <h1 className="mt-4 text-2xl font-semibold text-gray-900">Página no encontrada</h1>
        <p className="mt-2 text-sm text-gray-500">La dirección que visitaste no existe.</p>
        <Link
          to="/queue"
          className="mt-6 inline-flex items-center text-sm font-medium text-blue-600
                     hover:underline focus-visible:outline-none focus-visible:ring-2
                     focus-visible:ring-blue-500 rounded"
        >
          Volver a la cola
        </Link>
      </div>
    </main>
  );
}
