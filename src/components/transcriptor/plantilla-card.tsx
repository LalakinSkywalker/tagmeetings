'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { borrarPlantilla, type PlantillaUsuarioItem } from '@/actions/plantillas'

export function PlantillaCard({ plantilla }: { plantilla: PlantillaUsuarioItem }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [confirmando, setConfirmando] = useState(false)
  const [borrando, setBorrando] = useState(false)
  const [error, setError] = useState('')

  const handleBorrar = async () => {
    setBorrando(true)
    setError('')
    try {
      const res = await borrarPlantilla(plantilla.id)
      if (!res.ok) {
        setError(res.error ?? 'No se pudo borrar.')
        setBorrando(false)
        return
      }
      startTransition(() => router.refresh())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBorrando(false)
    }
  }

  return (
    <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand dark:bg-brand-softdark">
          <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
            <path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" />
            <path d="M13 4v5h5M8 13h8M8 16h5" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-stone-900 dark:text-stone-100">
            {plantilla.nombre}
          </p>
          {plantilla.descripcion && (
            <p className="mt-0.5 line-clamp-2 text-xs text-stone-500 dark:text-stone-400">
              {plantilla.descripcion}
            </p>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      <div className="mt-3 flex gap-2">
        <Link
          href={`/dashboard/plantillas/${plantilla.id}`}
          className="tap-scale flex-1 rounded-xl border border-stone-200 py-2 text-center text-xs font-semibold text-stone-600 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
        >
          Editar
        </Link>
        {confirmando ? (
          <>
            <button
              type="button"
              onClick={handleBorrar}
              disabled={borrando}
              className="tap-scale flex-1 rounded-xl bg-red-600 py-2 text-xs font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {borrando ? 'Borrando…' : 'Confirmar'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmando(false)}
              disabled={borrando}
              className="tap-scale rounded-xl border border-stone-200 px-3 py-2 text-xs font-semibold text-stone-500 transition hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
            >
              No
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmando(true)}
            className="tap-scale rounded-xl border border-stone-200 px-3 py-2 text-xs font-semibold text-red-600 transition hover:border-red-300 hover:bg-red-50 dark:border-stone-700 dark:text-red-400 dark:hover:border-red-800 dark:hover:bg-red-950/40"
          >
            Borrar
          </button>
        )}
      </div>
    </div>
  )
}
