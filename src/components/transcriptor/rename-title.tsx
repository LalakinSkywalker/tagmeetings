'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { renombrarTranscripcion } from '@/actions/transcripciones'

/**
 * Dialog para renombrar la transcripcion (Fase 1, quick win). Controlado: el
 * trigger vive afuera (el menu de acciones del header). Llama al server action
 * renombrarTranscripcion (auth + ownership + sanitizacion).
 */
export function RenameDialog({
  transcripcionId,
  tituloActual,
  open,
  onClose,
}: {
  transcripcionId: string
  tituloActual: string
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [value, setValue] = useState(tituloActual)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Al abrir, resetea el valor al titulo actual y limpia el error.
  useEffect(() => {
    if (open) {
      setValue(tituloActual)
      setError('')
    }
  }, [open, tituloActual])

  async function save() {
    setSaving(true)
    setError('')
    try {
      const res = await renombrarTranscripcion(transcripcionId, value)
      if (!res.ok) {
        setError(res.errorMessage ?? 'No se pudo renombrar.')
        return
      }
      onClose()
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  // Portal al body: el header tiene backdrop-blur (containing block) que atrapa
  // overlays `fixed`. El portal lo ancla a la pantalla de verdad.
  return createPortal(
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-stone-950/40 p-4 backdrop-blur-sm"
      onClick={() => !saving && onClose()}
    >
      <div
        className="animate-fade-in-up w-full max-w-sm rounded-3xl border border-stone-200 bg-white p-5 shadow-xl dark:border-stone-800 dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-stone-900 dark:text-stone-100">Renombrar</h2>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !saving) save()
          }}
          maxLength={120}
          className="mt-3 h-11 w-full rounded-2xl border border-stone-200 bg-stone-50 px-3.5 text-sm text-stone-900 transition focus:border-brand focus:ring-2 focus:ring-brand-ring/50 focus:outline-none dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
          placeholder="Nombre de la transcripción"
        />
        {error && (
          <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">{error}</p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="tap-scale flex-1 rounded-2xl border border-stone-200 py-2.5 text-sm font-semibold text-stone-600 transition hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || value.trim().length === 0}
            className="tap-scale flex-1 rounded-2xl bg-brand py-2.5 text-sm font-semibold text-white transition hover:bg-brand-strong disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
