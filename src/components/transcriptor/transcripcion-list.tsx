'use client'

// =============================================================================
// Biblioteca — lista de sesiones con MODO SELECCIÓN para borrado bulk
// =============================================================================
// PRP-TT — Hueco A (bulk selectivo): un toggle "Seleccionar" convierte cada fila
// en seleccionable; una barra inferior (overlay sobre el tab bar mientras se
// selecciona, patrón nativo) ofrece "Eliminar (N)" con confirmación obligatoria.
// Fuera de modo selección, cada fila es un Link a su detalle (comportamiento
// original intacto).
// =============================================================================

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { TranscripcionListItem } from '@/actions/transcripciones'
import { borrarTranscripcionesBulk } from '@/actions/transcripciones'
import { EliminarDialog } from './eliminar-dialog'

interface TranscripcionListProps {
  items: TranscripcionListItem[]
  /** True si hay algun filtro/busqueda activo. Cambia el empty state. */
  hasActiveFilters?: boolean
}

// Estado -> color del dot indicador + label. Procesando (transcribiendo/
// analizando/indexando) comparte el naranja Bluntag con pulso.
const ESTADO_DOT: Record<string, string> = {
  pendiente: 'bg-stone-400',
  transcribiendo: 'bg-brand animate-pulse',
  analizando: 'bg-brand animate-pulse',
  indexando: 'bg-brand animate-pulse',
  completado: 'bg-emerald-500',
  error: 'bg-red-500',
}

const ESTADO_LABEL: Record<string, string> = {
  pendiente: 'Pendiente',
  transcribiendo: 'Transcribiendo…',
  analizando: 'Analizando…',
  indexando: 'Indexando…',
  completado: 'Completado',
  error: 'Error',
}

function formatDuration(ms: number | null): string {
  if (!ms) return '—'
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${String(sec).padStart(2, '0')}`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-5 text-brand" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth={1.8} />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  )
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={1.8} />
      <path d="m8.5 12 2.4 2.4L15.5 9.5" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  )
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 px-6 py-12 text-center dark:border-stone-700 dark:bg-stone-900/40">
      <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-brand-soft dark:bg-brand-softdark">
        <svg viewBox="0 0 24 24" fill="none" className="size-6 text-brand" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth={1.8} />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-sm font-semibold text-stone-700 dark:text-stone-200">
        {filtered ? 'Sin resultados' : 'Aún no tienes transcripciones'}
      </p>
      <p className="mx-auto mt-1 max-w-xs text-xs text-stone-500 dark:text-stone-400">
        {filtered
          ? 'Ajusta o limpia la búsqueda para ver más.'
          : 'Toca Capturar para grabar o subir tu primer audio.'}
      </p>
    </div>
  )
}

/** Contenido interno de una fila (icono + título + meta + estado). Reutilizado
 *  por la fila-Link (navegación) y la fila-botón (selección). */
function FilaContenido({
  item,
  modoSeleccion,
  checked,
}: {
  item: TranscripcionListItem
  modoSeleccion: boolean
  checked: boolean
}) {
  const dot = ESTADO_DOT[item.estado] ?? ESTADO_DOT.pendiente
  const estadoLabel = ESTADO_LABEL[item.estado] ?? item.estado
  const isError = item.estado === 'error'

  return (
    <>
      {/* Casilla de selección (modo selección) o icono de marca (normal) */}
      {modoSeleccion ? (
        <div
          className={`flex size-11 shrink-0 items-center justify-center rounded-xl transition ${
            checked ? 'text-brand' : 'text-stone-300 dark:text-stone-600'
          }`}
        >
          {checked ? (
            <CheckCircleIcon className="size-6" />
          ) : (
            <span className="size-6 rounded-full border-2 border-current" />
          )}
        </div>
      ) : (
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft dark:bg-brand-softdark">
          <TagIcon />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-stone-900 dark:text-stone-100">
          {item.titulo}
        </p>
        <p className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">
          {(item.categoria ?? item.template_id)} · {formatDate(item.created_at)} · {formatDuration(item.duracion_ms)}
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
          <span
            className={`text-[11px] font-medium ${
              isError ? 'text-red-600 dark:text-red-400' : 'text-stone-500 dark:text-stone-400'
            }`}
          >
            {isError && item.error_message ? item.error_message : estadoLabel}
          </span>
        </div>
      </div>

      {/* Chevron solo en modo navegación */}
      {!modoSeleccion && (
        <svg viewBox="0 0 24 24" fill="none" className="size-5 shrink-0 text-stone-300 dark:text-stone-600" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </>
  )
}

export function TranscripcionList({
  items,
  hasActiveFilters = false,
}: TranscripcionListProps) {
  const router = useRouter()
  const [seleccionando, setSeleccionando] = useState(false)
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)

  if (items.length === 0) {
    return <EmptyState filtered={hasActiveFilters} />
  }

  const count = seleccionados.size
  const todasSeleccionadas = count > 0 && count === items.length

  function toggle(id: string) {
    setSeleccionados((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function salirSeleccion() {
    setSeleccionando(false)
    setSeleccionados(new Set())
  }

  function toggleTodas() {
    setSeleccionados(todasSeleccionadas ? new Set() : new Set(items.map((i) => i.id)))
  }

  const filaBase =
    'tap-scale flex w-full items-center gap-3 rounded-2xl border bg-white p-3.5 text-left shadow-sm transition dark:bg-stone-900'

  return (
    <div>
      {/* Toolbar superior: activar selección / cancelar + contador + todas */}
      <div className="mb-2.5 flex h-7 items-center justify-between gap-2 px-0.5">
        {seleccionando ? (
          <>
            <button
              type="button"
              onClick={salirSeleccion}
              className="tap-scale text-sm font-semibold text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
            >
              Cancelar
            </button>
            <span className="text-sm font-medium text-stone-500 dark:text-stone-400">
              {count === 0 ? 'Selecciona sesiones' : `${count} seleccionada${count === 1 ? '' : 's'}`}
            </span>
            <button
              type="button"
              onClick={toggleTodas}
              className="tap-scale text-sm font-semibold text-brand hover:text-brand-strong"
            >
              {todasSeleccionadas ? 'Ninguna' : 'Todas'}
            </button>
          </>
        ) : (
          <>
            <span aria-hidden="true" />
            <button
              type="button"
              onClick={() => setSeleccionando(true)}
              className="tap-scale inline-flex items-center gap-1.5 text-sm font-semibold text-stone-500 transition hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
            >
              <CheckCircleIcon className="size-4" />
              Seleccionar
            </button>
          </>
        )}
      </div>

      <ul className="space-y-2.5">
        {items.map((item) => {
          const checked = seleccionados.has(item.id)
          if (seleccionando) {
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => toggle(item.id)}
                  aria-pressed={checked}
                  className={`${filaBase} ${
                    checked
                      ? 'border-brand ring-1 ring-brand dark:border-brand'
                      : 'border-stone-200/80 hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-700'
                  }`}
                >
                  <FilaContenido item={item} modoSeleccion checked={checked} />
                </button>
              </li>
            )
          }
          return (
            <li key={item.id}>
              <Link
                href={`/dashboard/transcripcion/${item.id}`}
                className={`${filaBase} border-stone-200/80 hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-700`}
              >
                <FilaContenido item={item} modoSeleccion={false} checked={false} />
              </Link>
            </li>
          )
        })}
      </ul>

      {/* Barra de acción inferior (overlay sobre el tab bar mientras se selecciona) */}
      {seleccionando && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-stone-200/80 bg-stone-50/95 backdrop-blur-lg pb-safe dark:border-stone-800/80 dark:bg-stone-950/95">
          <div className="mx-auto max-w-2xl px-4 py-3">
            <button
              type="button"
              disabled={count === 0}
              onClick={() => setDialogOpen(true)}
              className="tap-scale flex w-full items-center justify-center gap-2 rounded-2xl bg-red-600 py-3.5 text-base font-semibold text-white transition hover:bg-red-700 disabled:opacity-40"
            >
              <TrashIcon className="size-5" />
              {count === 0 ? 'Eliminar' : `Eliminar (${count})`}
            </button>
          </div>
        </div>
      )}

      <EliminarDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        count={count}
        onConfirm={() => borrarTranscripcionesBulk(Array.from(seleccionados))}
        onDeleted={() => {
          setDialogOpen(false)
          salirSeleccion()
          router.refresh()
        }}
      />
    </div>
  )
}
