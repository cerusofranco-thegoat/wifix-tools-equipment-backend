import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { addNote } from '../../lib/api/assistance';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { ApiError } from '../../lib/api/client';

interface NoteFormProps {
  sessionId: string;
}

export function NoteForm({ sessionId }: NoteFormProps) {
  const [text, setText] = useState('');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => addNote(sessionId, text.trim()),
    onSuccess: () => {
      setText('');
      queryClient.invalidateQueries({ queryKey: ['events', sessionId] });
      toast('Nota guardada.', 'success');
    },
    onError: (err) => {
      if (err instanceof ApiError) toast(err.message, 'error');
      else toast('Error al guardar la nota.', 'error');
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    mutation.mutate();
  }

  return (
    <form
      onSubmit={(e) => { void handleSubmit(e); }}
      className="space-y-2"
      aria-label="Agregar nota a la sesión"
    >
      <label htmlFor="note-text" className="block text-sm font-medium text-gray-700">
        Nueva nota
      </label>
      <textarea
        id="note-text"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Escribe una nota sobre esta sesión..."
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm
                   placeholder-gray-400 focus:border-blue-500 focus:outline-none
                   focus:ring-2 focus:ring-blue-500/20 resize-none"
        aria-required="true"
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          loading={mutation.isPending}
          disabled={!text.trim()}
          aria-label="Guardar nota"
        >
          Guardar nota
        </Button>
      </div>
    </form>
  );
}
