// Fetch wrapper tipado con interceptor JWT y mapeo de errores.
// No usar Axios — fetch nativo según stack congelado.

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

// Importación diferida para evitar ciclo: store → client → store
// Se resuelve leyendo localStorage directamente como fuente primaria.
function getToken(): string | null {
  return localStorage.getItem('wifix_token');
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

interface ErrorBody {
  code?: string;
  message?: string;
  error?: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (!res.ok) {
    let body: ErrorBody = {};
    try {
      body = (await res.json()) as ErrorBody;
    } catch {
      // respuesta sin JSON
    }
    const code = body.code ?? body.error ?? 'UNKNOWN_ERROR';
    const message = body.message ?? `Error HTTP ${res.status}`;

    if (res.status === 401) {
      // Publicar evento global para que el router/guard pueda reaccionar
      window.dispatchEvent(new CustomEvent('wifix:unauthorized'));
    }
    throw new ApiError(code, res.status, message);
  }

  // 204 No Content
  if (res.status === 204) return undefined as unknown as T;

  return res.json() as Promise<T>;
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  let url = path;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const str = qs.toString();
    if (str) url = `${path}?${str}`;
  }
  return request<T>(url, { method: 'GET' });
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
