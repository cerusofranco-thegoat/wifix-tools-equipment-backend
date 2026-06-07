// Hook de focus-trap sin dependencias externas.
// Mantiene el foco dentro del contenedor mientras está activo,
// gestiona Tab/Shift+Tab cíclico y cierra con Escape.

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface UseFocusTrapOptions {
  /** Si es false/undefined el trap no se activa. */
  active: boolean;
  /** Callback invocado cuando el usuario presiona Escape. */
  onEscape: () => void;
}

/**
 * Activa un focus-trap en el elemento referenciado por `containerRef`.
 * Cuando `active` pasa a true:
 *   - Guarda el elemento que tenía el foco y lo restaura al desactivarse.
 *   - Tab/Shift+Tab cicla entre los focusables del contenedor.
 *   - Escape llama a `onEscape`.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  { active, onEscape }: UseFocusTrapOptions,
): void {
  // Guardamos el elemento enfocado antes de abrir el trap
  const previouslyFocused = useRef<Element | null>(null);

  useEffect(() => {
    if (!active) return;

    // Guardar foco actual
    previouslyFocused.current = document.activeElement;

    // Enfocar el primer elemento focusable del contenedor
    const container = containerRef.current;
    if (container) {
      const first = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)[0];
      first?.focus();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (!containerRef.current) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
        return;
      }

      if (e.key !== 'Tab') return;

      const focusables = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
      ).filter((el) => !el.closest('[aria-hidden="true"]'));

      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }

      const first: HTMLElement | undefined = focusables[0];
      const last: HTMLElement | undefined = focusables[focusables.length - 1];

      if (!first || !last) return;

      if (e.shiftKey) {
        // Shift+Tab: si el foco está en el primero, salta al último
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab: si el foco está en el último, salta al primero
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Restaurar foco al elemento previo al desmontar/desactivar
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  // onEscape se estabiliza con useCallback en el sitio de uso; lo incluimos de todos modos.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, onEscape]);
}
