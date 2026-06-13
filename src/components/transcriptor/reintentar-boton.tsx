'use client'

// =============================================================================
// ReintentarBoton — dispara el reintento manual de una transcripción (Fase 10)
// =============================================================================
// Reutilizable en la vista de detalle (estado error) y en el poller (cuando un
// job lleva demasiado tiempo). Llama al server action reintentarTranscripcion,
// muestra estado de carga y refresca al terminar. mobile-native-ui: tap-scale.
// =============================================================================

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { reintentarTranscripcion } from '@/actions/reintentar'

interface Props {
  transcripcionId: string
  /** 'primario' = botón sólido; 'suave' = chip discreto. Default 'primario'. */
  variante?: 'primario' | 'suave'
  label?: string
}

export function ReintentarBoton({
  transcripcionId,
  variante = 'primario',
  label = 'Reintentar',
}: Props) {
  const router = useRouter()
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState('')
  const [mensaje, setMensaje] = useState('')

  const onClick = async () => {
    setCargando(true)
    setError('')
    setMensaje('')
    try {
      const res = await reintentarTranscripcion(transcripcionId)
      if (!res.ok) {
        setError(res.errorMessage ?? 'No se pudo reintentar.')
        return
      }
      setMensaje(res.mensaje ?? 'Reintento lanzado.')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCargando(false)
    }
  }

  const cls =
    variante === 'primario'
      ? 'tap-scale inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/90 disabled:opacity-50'
      : 'tap-scale inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1 text-[11px] font-semibold text-brand transition hover:bg-brand-soft/70 disabled:opacity-50 dark:bg-brand-softdark'

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button type="button" onClick={onClick} disabled={cargando} className={cls}>
        {cargando ? 'Reintentando…' : label}
      </button>
      {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}
      {mensaje && !error && (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">{mensaje}</p>
      )}
    </div>
  )
}
