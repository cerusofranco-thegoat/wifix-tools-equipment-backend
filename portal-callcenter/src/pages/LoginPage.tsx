import { useState, useRef, useEffect, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../lib/api/auth';
import { useAuthStore } from '../stores/auth.store';
import { Button } from '../components/ui/Button';
import { ApiError } from '../lib/api/client';

export function LoginPage() {
  const navigate = useNavigate();
  const { token, setAuth } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // Si ya está autenticado, redirigir
  useEffect(() => {
    if (token) navigate('/queue', { replace: true });
  }, [token, navigate]);

  // Foco inicial en email
  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await login(email, password);
      setAuth(res.token, res.user);
      navigate('/queue', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 401
            ? 'Correo o contraseña incorrectos.'
            : err.message,
        );
      } else {
        setError('Error de conexión. Verifica tu red e intenta de nuevo.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Wifix Call Center</h1>
          <p className="mt-1 text-sm text-gray-500">Ingresa con tus credenciales</p>
        </div>

        <form
          onSubmit={(e) => { void handleSubmit(e); }}
          className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-5"
          noValidate
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Correo electrónico
            </label>
            <input
              ref={emailRef}
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm
                         placeholder-gray-400 focus:border-blue-500 focus:outline-none
                         focus:ring-2 focus:ring-blue-500/20"
              placeholder="agente@wifix.com"
              aria-required="true"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Contraseña
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm
                         placeholder-gray-400 focus:border-blue-500 focus:outline-none
                         focus:ring-2 focus:ring-blue-500/20"
              placeholder="••••••••"
              aria-required="true"
            />
          </div>

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </div>
          )}

          <Button
            type="submit"
            loading={loading}
            className="w-full"
            aria-label="Iniciar sesión"
          >
            Ingresar
          </Button>
        </form>
      </div>
    </main>
  );
}
