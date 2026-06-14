'use client'

// =============================================================================
// — Hueco A · Diálogo de confirmación de borrado (1x1 y bulk)
// =============================================================================
// Modal centrado, controlado, vía createPortal al body (el backdrop-blur del
// header atrapa overlays `fixed`). Operación destructiva → SIEMPRE confirma.
// Mensaje conciso de consecuencia (qué se borra / qué se conserva) — es estado
// de acción destructiva, no párrafo descriptivo de feature.
// =============================================================================

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  open: boolean
  onClose: () => void
  /** Cuántas sesiones se van a borrar (1 = individual). */
  count: number
  /** Título de la sesión cuando count === 1 (personaliza el encabezado). */
  titulo?: string
  /** Ejecuta el borrado. Devuelve ok + error opcional. */
  onConfirm: () => Promise<{ ok: boolean; error?: string }>
  /** Se invoca tras un borrado exitoso (navegar / refrescar / salir de modo). */
  onDeleted: () => void
}

export function EliminarDialog({ open, onClose, count, titulo, onConfirm, onDeleted }: Props) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  // Cerrar limpia el error (así el próximo abrir arranca limpio) — sin efecto.
  const handleClose = () => {
    if (pending) return
    setError('')
    onClose()
  }

  // Cierra con Escape (salvo mientras borra). El setState va en el callback del
  // evento, NO en el cuerpo del efecto (permitido por react-hooks).
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) {
        setError('')
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, pending, onClose])

  // `open` arranca en false → el portal nunca se evalúa en SSR (document existe
  // siempre que llega aquí, igual que descargar-sheet/archivar-sheet).
  if (!open) return null

  const esIndividual = count <= 1
  const encabezado = esIndividual ? '¿Eliminar esta sesión?' : `¿Eliminar ${count} sesiones?`
  const labelBoton = pending
    ? 'Eliminando…'
    : esIndividual
      ? 'Eliminar sesión'
      : `Eliminar ${count}`

  async function handleConfirm() {
    setPending(true)
    setError('')
    try {
      const res = await onConfirm()
      if (!res.ok) {
        setError(res.error ?? 'No se pudo eliminar.')
        setPending(false)
        return
      }
      setPending(false)
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPending(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-60 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Cerrar"
        onClick={handleClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="animate-fade-in-up relative w-full max-w-sm overflow-hidden rounded-3xl border border-stone-200 bg-white p-5 shadow-2xl dark:border-stone-700 dark:bg-stone-900">
        {/* Ícono de advertencia */}
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-red-50 dark:bg-red-950/40">
          <svg viewBox="0 0 24 24" fill="none" className="size-6 text-red-600 dark:text-red-400" aria-hidden="true">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
          </svg>
        </div>

        <h2 className="text-center text-xl font-extrabold tracking-tight text-stone-900 dark:text-stone-50">
          {encabezado}
        </h2>

        {esIndividual && titulo && (
          <p className="mt-1 truncate text-center text-sm font-medium text-stone-500 dark:text-stone-400">
            {titulo}
          </p>
        )}

        {/* Consecuencia del borrado (acción destructiva, no descripción de feature). */}
        <div className="mt-4 space-y-2 rounded-2xl bg-stone-50 p-3.5 text-sm dark:bg-stone-800/60">
          <p className="flex items-start gap-2 text-stone-700 dark:text-stone-200">
            <span aria-hidden="true" className="mt-0.5 text-red-500">✕</span>
            <span>Se {esIndividual ? 'elimina la sesión' : 'eliminan las sesiones'} y su audio. No se puede deshacer.</span>
          </p>
          <p className="flex items-start gap-2 text-stone-700 dark:text-stone-200">
            <span aria-hidden="true" className="mt-0.5 text-emerald-500">✓</span>
            <span>Los pendientes del proyecto y el respaldo en Drive se conservan.</span>
          </p>
        </div>

        {error && (
          <p className="mt-3 text-center text-sm font-medium text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            onClick={handleClose}
            disabled={pending}
            className="tap-scale flex-1 rounded-2xl border border-stone-200 bg-white py-3 text-base font-semibold text-stone-700 transition hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            className="tap-scale flex-1 rounded-2xl bg-red-600 py-3 text-base font-semibold text-white transition hover:bg-red-700 disabled:opacity-60"
          >
            {labelBoton}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
