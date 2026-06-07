import { ApiError } from '../../lib/api/client';

interface ErrorMessageProps {
  error: unknown;
  fallback?: string;
}

export function ErrorMessage({
  error,
  fallback = 'Ocurrió un error inesperado.',
}: ErrorMessageProps) {
  const message = error instanceof ApiError ? error.message : fallback;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      {message}
    </div>
  );
}

interface EmptyStateProps {
  message: string;
}

export function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-10 text-center text-sm text-gray-500">
      {message}
    </div>
  );
}
