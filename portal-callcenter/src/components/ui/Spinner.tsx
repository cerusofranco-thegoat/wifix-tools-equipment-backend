interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}

const sizeMap = {
  sm: 'h-4 w-4 border-2',
  md: 'h-8 w-8 border-2',
  lg: 'h-12 w-12 border-4',
};

export function Spinner({ size = 'md', label = 'Cargando...' }: SpinnerProps) {
  return (
    <div role="status" aria-label={label} className="flex items-center justify-center">
      <div
        className={`${sizeMap[size]} rounded-full border-blue-600 border-t-transparent animate-spin`}
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
    </div>
  );
}
