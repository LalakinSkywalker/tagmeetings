'use client'

// =============================================================================
// ProyectoMemoria — resumen jerarquico del proyecto
// =============================================================================
// Muestra el meta-resumen del proyecto (sintesis de los resumenes de todas sus
// sesiones) y permite generarlo / actualizarlo. Estandar mobile-native-ui.
// =============================================================================

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { generarMemoriaProyecto } from '@/actions/proyectos'
import { formatFecha } from '@/lib/format/fecha'

interface Props {
  proyectoId: string
  resumenInicial: string | null
  generadaAt: string | null
  stale: boolean
  sesionesCompletadasCount: number
}

export function ProyectoMemoria({
  proyectoId,
  resumenInicial,
  generadaAt,
  stale,
  sesionesCompletadasCount,
}: Props) {
  const [resumen, setResumen] = useState<string | null>(resumenInicial)
  const [fecha, setFecha] = useState<string | null>(generadaAt)
  const [stale_, setStale] = useState(stale)
  const [generando, setGenerando] = useState(false)
  const [error, setError] = useState('')
  const [, startTransition] = useTransition()
  const router = useRouter()

  const handleGenerar = async () => {
    setGenerando(true)
    setError('')
    try {
      const result = await generarMemoriaProyecto(proyectoId)
      if (!result.ok) {
        setError(result.errorMessage ?? 'No se pudo generar el resumen.')
      } else {
        setResumen(result.resumen ?? '')
        setFecha(result.generadaAt ?? null)
        setStale(false)
        startTransition(() => router.refresh())
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerando(false)
    }
  }

  // Sin sesiones analizadas todavia: no hay material para resumir.
  if (!resumen && sesionesCompletadasCount === 0) {
    return (
      <p className="text-sm text-stone-500 dark:text-stone-400">
        Cuando este proyecto tenga sesiones analizadas, aquí podrás generar un resumen de toda su
        historia.
      </p>
    )
  }

  // Hay material pero aun no se ha generado.
  if (!resumen) {
    return (
      <div className="space-y-2.5">
        {/* La explicación vive en el globo ⓘ del encabezado (regla mobile-native:
            nunca párrafos grises descriptivos en el flujo). */}
        <button
          type="button"
          onClick={handleGenerar}
          disabled={generando}
          className="tap-scale inline-flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand transition hover:bg-brand-soft/70 disabled:opacity-50 dark:bg-brand-softdark"
        >
          {generando ? 'Generando…' : '✦ Generar resumen'}
        </button>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    )
  }

  // Ya hay memoria.
  return (
    <div className="space-y-3">
      {stale_ && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          Hay sesiones nuevas o cambios desde el último resumen. Actualízalo para incluirlos.
        </div>
      )}
      <p className="text-sm leading-relaxed whitespace-pre-wrap text-stone-900 dark:text-stone-100">
        {resumen}
      </p>
      <div className="flex items-center justify-between gap-3 pt-1">
        {fecha && (
          <span className="text-xs text-stone-400 dark:text-stone-500">
            Actualizado {formatFecha(fecha)}
          </span>
        )}
        <button
          type="button"
          onClick={handleGenerar}
          disabled={generando}
          className="tap-scale rounded-lg px-3 py-1.5 text-xs font-semibold text-brand transition hover:bg-brand-soft disabled:opacity-50 dark:hover:bg-brand-softdark"
        >
          {generando ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
