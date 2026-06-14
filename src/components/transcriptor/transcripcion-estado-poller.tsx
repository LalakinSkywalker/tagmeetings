'use client'

// =============================================================================
// TranscripcionEstadoPoller — UI de progreso en vivo durante el flujo async.
// =============================================================================
// cuando una transcripcion esta en 'transcribiendo'/'analizando'/
// 'indexando', Deepgram esta procesando async via callback. Este componente
// hace polling cada N segundos al server action getEstadoTranscripcion y
// refresca la pagina cuando detecta 'completado' o 'error'.
//
// Diseñado para audios largos (5-6h): el polling es lightweight (un SELECT
// pequeño con RLS) y el intervalo se ajusta segun el estado:
//   - 'transcribiendo': 15s (Deepgram tarda minutos en audios largos)
//   - 'analizando' / 'indexando': 5s (LLM + embeddings son rapidos, ~30-90s)
//   - 'completado' / 'error': para polling y refresca pagina
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getEstadoTranscripcion } from '@/actions/transcripciones'
import { ReintentarBoton } from './reintentar-boton'

type Estado =
  | 'pendiente'
  | 'transcribiendo'
  | 'analizando'
  | 'indexando'
  | 'completado'
  | 'error'

/** Si un job lleva más de esto SIN avanzar (updated_at viejo), mostramos el aviso
 *  honesto + "Reintentar ahora". 18 min: un poco antes que el watchdog (20 min),
 *  para darle la opción al usuario antes de que el sistema reintente solo. */
const LENTO_MS = 18 * 60_000

function esIntermedio(e: Estado): boolean {
  return e === 'pendiente' || e === 'transcribiendo' || e === 'analizando' || e === 'indexando'
}

interface Props {
  transcripcionId: string
  estadoInicial: Estado
}

function intervalForEstado(estado: Estado): number {
  if (estado === 'transcribiendo' || estado === 'pendiente') return 15_000
  if (estado === 'analizando' || estado === 'indexando') return 5_000
  return 0 // completado / error: stop
}

function labelForEstado(estado: Estado): string {
  switch (estado) {
    case 'pendiente':
      return 'En cola para procesamiento'
    case 'transcribiendo':
      return 'Transcribiendo con Deepgram'
    case 'analizando':
      return 'Analizando con IA'
    case 'indexando':
      return 'Indexando para búsqueda semántica'
    case 'completado':
      return 'Completado'
    case 'error':
      return 'Error'
  }
}

function descripcionForEstado(estado: Estado): string {
  switch (estado) {
    case 'pendiente':
      return 'Tu archivo está esperando ser tomado por el motor de transcripción. Esto suele tardar pocos segundos.'
    case 'transcribiendo':
      return 'Deepgram está convirtiendo el audio en texto e identificando quién habla. En audios largos (varias horas) este paso puede tardar de 5 a 15 minutos. Puedes cerrar esta pestaña — el procesamiento sigue en el servidor y la transcripción aparecerá lista cuando vuelvas.'
    case 'analizando':
      return 'El modelo de IA está leyendo la transcripción y generando resumen, bullets y action items según la plantilla que elegiste. Suele tardar 30 a 90 segundos.'
    case 'indexando':
      return 'Indexando la transcripción en vectores para que puedas hacerle preguntas en lenguaje natural más adelante. Casi termina.'
    case 'completado':
      return 'Listo. Refrescando vista…'
    case 'error':
      return 'Algo falló durante el procesamiento. Revisa el detalle abajo.'
  }
}

function progressPercent(estado: Estado): number {
  switch (estado) {
    case 'pendiente':
      return 5
    case 'transcribiendo':
      return 35
    case 'analizando':
      return 70
    case 'indexando':
      return 90
    case 'completado':
      return 100
    case 'error':
      return 0
  }
}

export function TranscripcionEstadoPoller({
  transcripcionId,
  estadoInicial,
}: Props) {
  const router = useRouter()
  const [estado, setEstado] = useState<Estado>(estadoInicial)
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [llevaMucho, setLlevaMucho] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedAtRef = useRef<number>(0)
  const lastFetchAtRef = useRef<number>(0)

  // Lazy-init mountedAt sin usar Date.now en module-eval (sirve para mostrar
  // "lleva X minutos") — Date.now en useEffect es seguro.
  useEffect(() => {
    mountedAtRef.current = Date.now()
  }, [])

  const poll = useCallback(async () => {
    lastFetchAtRef.current = Date.now()
    try {
      const result = await getEstadoTranscripcion(transcripcionId)
      if (!result.ok) {
        setErrorMsg(result.errorMessage ?? 'Error desconocido al consultar estado.')
        return
      }
      const next = result.estado
      setEstado(next)
      // ¿Lleva demasiado tiempo sin avanzar? (updated_at viejo en estado intermedio)
      const lento =
        esIntermedio(next) && result.updatedAt
          ? Date.now() - new Date(result.updatedAt).getTime() > LENTO_MS
          : false
      setLlevaMucho(lento)
      if (next === 'error') {
        setErrorMsg(result.errorMessage ?? '')
      } else {
        setErrorMsg('')
      }
      if (next === 'completado' || next === 'error') {
        // Pequeño delay para que el usuario vea el "Completado" antes de refrescar
        setTimeout(() => {
          router.refresh()
        }, 800)
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }, [transcripcionId, router])

  useEffect(() => {
    const interval = intervalForEstado(estado)
    if (interval === 0) return // stop polling

    timerRef.current = setTimeout(() => {
      void poll()
    }, interval)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [estado, poll])

  // Primer poll en T+2s para detectar transiciones rapidas (Mock provider sync
  // ya estaria completado).
  useEffect(() => {
    const id = setTimeout(() => {
      void poll()
    }, 2_000)
    return () => clearTimeout(id)
  }, [poll])

  const isError = estado === 'error'
  const percent = progressPercent(estado)

  return (
    <div className="space-y-6">
      <div
        className={`rounded-lg border p-6 ${
          isError
            ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950'
            : 'border-brand/30 bg-brand-soft dark:border-brand/50 dark:bg-brand-softdark'
        }`}
      >
        <div className="flex items-center gap-3">
          {!isError && (
            <div
              className="h-3 w-3 animate-pulse rounded-full bg-brand"
              aria-hidden
            />
          )}
          <h2
            className={`text-lg font-semibold ${
              isError
                ? 'text-red-900 dark:text-red-100'
                : 'text-brand'
            }`}
          >
            {labelForEstado(estado)}
          </h2>
        </div>

        <p
          className={`mt-2 text-sm ${
            isError
              ? 'text-red-800 dark:text-red-200'
              : 'text-brand'
          }`}
        >
          {descripcionForEstado(estado)}
        </p>

        {!isError && (
          <div className="mt-5">
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-brand-soft dark:bg-brand-softdark"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Progreso de procesamiento"
            >
              <div
                className="h-full bg-brand transition-all duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-brand">
              Esta página se actualiza sola. No es necesario refrescar.
            </p>
          </div>
        )}

        {isError && errorMsg && (
          <div className="mt-4 rounded border border-red-300 bg-white p-3 font-mono text-xs text-red-900 dark:border-red-800 dark:bg-red-900/50 dark:text-red-100">
            {errorMsg}
          </div>
        )}
      </div>

      {llevaMucho && !isError && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800/60 dark:bg-amber-950/40">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            Esto está tardando más de lo normal
          </p>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
            El procesamiento lleva un rato sin avanzar. El sistema lo reintenta solo en unos
            minutos — pero si prefieres, puedes reintentarlo ahora.
          </p>
          <div className="mt-3">
            <ReintentarBoton
              transcripcionId={transcripcionId}
              variante="suave"
              label="Reintentar ahora"
            />
          </div>
        </div>
      )}

      <div className="rounded-md border border-stone-200 bg-white p-4 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400">
        <p>
          <strong>¿Por qué tarda?</strong> Para audios largos (5-6 horas) el
          motor de transcripción procesa de forma asíncrona. Puedes cerrar esta
          pestaña y volver más tarde: la transcripción aparecerá lista en tu
          dashboard cuando termine.
        </p>
      </div>
    </div>
  )
}
