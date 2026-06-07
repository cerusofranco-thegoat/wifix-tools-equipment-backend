import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from './router';
import { useAuthStore } from './stores/auth.store';
import { assistanceSocket } from './lib/ws/AssistanceSocket';
import { ToastContainer } from './components/ui/Toast';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // No reintentar en 401/403/404
        if (
          error &&
          typeof error === 'object' &&
          'status' in error &&
          typeof error.status === 'number' &&
          [401, 403, 404].includes(error.status)
        ) {
          return false;
        }
        return failureCount < 2;
      },
      staleTime: 10_000,
    },
  },
});

function AuthBridge() {
  const { token, logout } = useAuthStore();

  // Conectar socket al recargar si ya hay token en localStorage
  useEffect(() => {
    if (token) {
      assistanceSocket.connect(token);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Escuchar evento global de 401 (token expirado o inválido)
  useEffect(() => {
    const handler = () => {
      queryClient.clear();
      logout();
    };
    window.addEventListener('wifix:unauthorized', handler);
    return () => window.removeEventListener('wifix:unauthorized', handler);
  }, [logout]);

  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthBridge />
      <RouterProvider router={router} />
      <ToastContainer />
    </QueryClientProvider>
  );
}

export default App;
