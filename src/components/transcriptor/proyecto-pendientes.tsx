'use client'

// =============================================================================
// ProyectoPendientes — tablero de pendientes VIVO del proyecto
// =============================================================================
// Agrega los action_items de todas las sesiones del proyecto. La IA propone el
// estado (pendiente/en_curso/hecho) por la linea de tiempo; el usuario confirma,
// edita el estado, agrega pendientes manuales o los borra. Estandar mobile-native:
// etiqueta + valor en el flujo, explicaciones en globo ⓘ, control de estado como
// hoja inferior (SelectMenu), acento de color por estado.
// =============================================================================

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  generarTableroPendientes,
  actualizarEstadoPendiente,
  agregarPendienteManual,
  borrarPendiente,
  type PendienteDTO,
  type EstadoPendiente,
} from '@/actions/proyectos'
import { SelectMenu, type SelectOption } from '@/components/ui/select-menu'
import { InfoTooltip } from '@/components/ui/info-tooltip'

interface Props {
  proyectoId: string
  pendientesInicial: PendienteDTO[]
  generadosAt: string | null
  stale: boolean
  sesionesCompletadasCount: number
}

const ESTADO_LABEL: Record<EstadoPendiente, string> = {
  pendiente: 'Pendiente',
  en_curso: 'En curso',
  hecho: 'Hecho',
}

// Acento de color del borde izquierdo de cada tarjeta segun estado.
const ESTADO_BORDE: Record<EstadoPendiente, string> = {
  pendiente: 'border-l-stone-300 dark:border-l-stone-600',
  en_curso: 'border-l-amber-400 dark:border-l-amber-500',
  hecho: 'border-l-emerald-500 dark:border-l-emerald-500',
}

const ESTADO_OPTIONS: SelectOption[] = [
  { value: 'pendiente', label: ESTADO_LABEL.pendiente },
  { value: 'en_curso', label: ESTADO_LABEL.en_curso },
  { value: 'hecho', label: ESTADO_LABEL.hecho },
]

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function esEstado(v: string): v is EstadoPendiente {
  return v === 'pendiente' || v === 'en_curso' || v === 'hecho'
}

export function ProyectoPendientes({
  proyectoId,
  pendientesInicial,
  generadosAt,
  stale,
  sesionesCompletadasCount,
}: Props) {
  const [pendientes, setPendientes] = useState<PendienteDTO[]>(pendientesInicial)
  const [generadosAt_, setGeneradosAt] = useState<string | null>(generadosAt)
  const [stale_, setStale] = useState(stale)
  const [generando, setGenerando] = useState(false)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [nuevoTexto, setNuevoTexto] = useState('')
  const [nuevoOwner, setNuevoOwner] = useState('')
  const [agregando, setAgregando] = useState(false)
  const [, startTransition] = useTransition()
  const router = useRouter()

  // Sincroniza el estado local con los props del servidor cuando cambian (tras
  // router.refresh()/revalidatePath). Sin esto, useState congela el valor inicial
  // y los pendientes recién agregados o generados nunca aparecen (los cambios
  // optimistas de estado/borrar siguen funcionando; el servidor manda al refrescar).
  useEffect(() => {
    setPendientes(pendientesInicial)
    setGeneradosAt(generadosAt)
    setStale(stale)
  }, [pendientesInicial, generadosAt, stale])

  const refrescar = () => startTransition(() => router.refresh())

  const handleGenerar = async () => {
    setGenerando(true)
    setError('')
    try {
      const result = await generarTableroPendientes(proyectoId)
      if (!result.ok) {
        setError(result.errorMessage ?? 'No se pudo generar el tablero.')
      } else {
        setStale(false)
        setGeneradosAt(new Date().toISOString())
        refrescar()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerando(false)
    }
  }

  const handleEstado = async (id: string, estado: EstadoPendiente) => {
    // Optimista: refleja el cambio al instante.
    setPendientes((prev) =>
      prev.map((p) => (p.id === id ? { ...p, estado, estadoOrigen: 'usuario' } : p)),
    )
    const result = await actualizarEstadoPendiente(id, estado)
    if (!result.ok) {
      setError(result.error ?? 'No se pudo actualizar el estado.')
      refrescar()
    }
  }

  const handleBorrar = async (id: string) => {
    setPendientes((prev) => prev.filter((p) => p.id !== id))
    const result = await borrarPendiente(id)
    if (!result.ok) {
      setError(result.error ?? 'No se pudo borrar.')
      refrescar()
    }
  }

  const handleAgregar = async () => {
    if (nuevoTexto.trim().length === 0) return
    setAgregando(true)
    setError('')
    try {
      const result = await agregarPendienteManual({
        proyectoId,
        texto: nuevoTexto,
        owner: nuevoOwner.trim() || undefined,
      })
      if (!result.ok) {
        setError(result.error ?? 'No se pudo agregar.')
      } else {
        setNuevoTexto('')
        setNuevoOwner('')
        setShowAdd(false)
        refrescar()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAgregando(false)
    }
  }

  const yaGenerado = generadosAt_ !== null
  const vacio = pendientes.length === 0

  // Sin sesiones analizadas y sin pendientes manuales: nada que mostrar aun.
  if (vacio && !yaGenerado && sesionesCompletadasCount === 0) {
    return (
      <p className="text-sm text-stone-500 dark:text-stone-400">
        Cuando este proyecto tenga sesiones analizadas, aquí se juntarán los pendientes de todas las
        reuniones y la IA propondrá su estado.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {stale_ && yaGenerado && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          Hay sesiones nuevas o cambios desde el último tablero. Actualízalo para incluir sus
          pendientes.
        </div>
      )}

      {/* Lista de pendientes */}
      {!vacio && (
        <ul className="space-y-2.5">
          {pendientes.map((p) => (
            <li
              key={p.id}
              className={`rounded-2xl border border-l-4 border-stone-200/80 bg-white p-3.5 shadow-sm dark:border-stone-800 dark:bg-stone-900 ${ESTADO_BORDE[p.estado]}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 flex-1 text-sm leading-relaxed text-stone-900 dark:text-stone-100">
                  {p.texto}
                </p>
                <button
                  type="button"
                  onClick={() => handleBorrar(p.id)}
                  aria-label="Borrar pendiente"
                  className="tap-scale -mr-1 -mt-0.5 shrink-0 rounded-lg p-1 text-stone-300 transition hover:bg-stone-100 hover:text-stone-500 dark:text-stone-600 dark:hover:bg-stone-800 dark:hover:text-stone-300"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="size-4" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              {/* Meta: origen + responsable + fecha límite */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                {p.transcripcionId ? (
                  <Link
                    href={`/dashboard/transcripcion/${p.transcripcionId}`}
                    className="tap-scale inline-flex items-center gap-1 rounded-md bg-stone-100 px-1.5 py-0.5 font-medium text-stone-600 transition hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700"
                  >
                    {p.tituloSesion ?? 'Sesión'}
                  </Link>
                ) : (
                  <span className="rounded-md bg-stone-100 px-1.5 py-0.5 font-medium text-stone-500 dark:bg-stone-800 dark:text-stone-400">
                    Manual
                  </span>
                )}
                {p.owner && <span>· {p.owner}</span>}
                {p.dueDate && <span>· vence {formatFecha(p.dueDate)}</span>}
              </div>

              {/* Nota de la IA (por qué propuso ese estado) */}
              {p.notaIa && p.estadoOrigen === 'ia' && (
                <p className="mt-1.5 text-xs italic text-stone-400 dark:text-stone-500">
                  IA: {p.notaIa}
                </p>
              )}

              {/* Control de estado (hoja inferior en móvil) */}
              <div className="mt-2.5 w-40">
                <SelectMenu
                  value={p.estado}
                  onChange={(v) => esEstado(v) && handleEstado(p.id, v)}
                  options={ESTADO_OPTIONS}
                  size="sm"
                  ariaLabel="Estado del pendiente"
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {vacio && yaGenerado && (
        <p className="rounded-2xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
          No se detectaron pendientes en las sesiones de este proyecto. Puedes agregar uno
          manualmente.
        </p>
      )}

      {/* Formulario de pendiente manual */}
      {showAdd ? (
        <div className="space-y-2 rounded-2xl border border-stone-200 p-3 dark:border-stone-800">
          <textarea
            value={nuevoTexto}
            onChange={(e) => setNuevoTexto(e.target.value)}
            placeholder="¿Qué quedó pendiente?"
            rows={2}
            maxLength={600}
            className="block w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
          />
          <input
            type="text"
            value={nuevoOwner}
            onChange={(e) => setNuevoOwner(e.target.value)}
            placeholder="Responsable (opcional)"
            maxLength={80}
            className="block w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAgregar}
              disabled={agregando || nuevoTexto.trim().length === 0}
              className="tap-scale flex-1 rounded-xl bg-brand py-2 text-sm font-semibold text-white transition hover:bg-brand-strong disabled:opacity-50"
            >
              {agregando ? 'Agregando…' : 'Agregar'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAdd(false)
                setNuevoTexto('')
                setNuevoOwner('')
              }}
              className="tap-scale rounded-xl px-3 py-2 text-sm font-semibold text-stone-500 transition hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5 pt-1">
          {/* La explicación vive en el globo ⓘ del encabezado (regla mobile-native:
              nunca párrafos grises descriptivos en el flujo). */}
          <div className="flex items-center justify-between gap-3">
            {/* Acción secundaria, discreta. */}
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="tap-scale inline-flex items-center gap-1 text-xs font-medium text-stone-500 transition hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
            >
              <svg viewBox="0 0 24 24" fill="none" className="size-3.5" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
              </svg>
              Agregar pendiente
            </button>

            {/* Acción principal: pastilla suave (no bloque sólido). */}
            <button
              type="button"
              onClick={handleGenerar}
              disabled={generando}
              className="tap-scale inline-flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand transition hover:bg-brand-soft/70 disabled:opacity-50 dark:bg-brand-softdark"
            >
              {generando
                ? yaGenerado
                  ? 'Actualizando…'
                  : 'Generando…'
                : yaGenerado
                  ? 'Actualizar'
                  : '✦ Generar tablero'}
            </button>
          </div>
          {generadosAt_ && (
            <span className="block text-xs text-stone-400 dark:text-stone-500">
              Actualizado {formatFecha(generadosAt_)}
            </span>
          )}
        </div>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
