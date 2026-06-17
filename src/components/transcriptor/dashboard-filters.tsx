'use client'

import { useState, useTransition, useEffect, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { SelectMenu } from '@/components/ui/select-menu'
import { formatCategoria } from '@/lib/export/format'

interface TemplateOption {
  id: string
  name: string
}

interface Props {
  categorias: string[]
  templates: TemplateOption[]
  /** Oculta el buscador interno (cuando la página ya tiene LibrarySearch) y
   *  muestra categoría/plantilla/fechas en un panel colapsable. */
  hideSearch?: boolean
}

/**
 * Valida que un string sea una fecha de calendario REAL en YYYY-MM-DD (espejo
 * del guard del server). Evita que un valor basura en la URL (ej. 2026-02-31)
 * llegue al `<input type=date>` y dispare un warning del navegador.
 */
function fechaValida(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** Devuelve la fecha del param solo si es válida; si no, ''. */
function soloFecha(s: string | null): string {
  return s && fechaValida(s) ? s : ''
}

/**
 * Filtros del dashboard sincronizados con URL params (URL es la fuente de
 * verdad — refresh, share, deep link funcionan). Patrón Next.js 16:
 * useSearchParams + router.replace para mantener el server component como
 * único responsable de la query a BD.
 *
 * Params soportados: q (search text), cat (categoria), tpl (template id),
 * desde (YYYY-MM-DD), hasta (YYYY-MM-DD), page (1-based).
 */
export function DashboardFilters({ categorias, templates, hideSearch = false }: Props) {
  const router = useRouter()
  const params = useSearchParams()
  const [, startTransition] = useTransition()

  // Estado local sincronizado con URL para inputs controlados sin "lag".
  const [q, setQ] = useState(params.get('q') ?? '')
  const [cat, setCat] = useState(params.get('cat') ?? '')
  const [tpl, setTpl] = useState(params.get('tpl') ?? '')
  const [desde, setDesde] = useState(soloFecha(params.get('desde')))
  const [hasta, setHasta] = useState(soloFecha(params.get('hasta')))

  // Panel colapsable (modo hideSearch): abierto si hay algún filtro activo en URL.
  const [abierto, setAbierto] = useState(() =>
    ['cat', 'tpl', 'desde', 'hasta'].some((k) => Boolean(params.get(k))),
  )

  // Si los params de URL cambian (ej: usuario navega "Anterior"), sincronizar.
  useEffect(() => {
    setQ(params.get('q') ?? '')
    setCat(params.get('cat') ?? '')
    setTpl(params.get('tpl') ?? '')
    setDesde(soloFecha(params.get('desde')))
    setHasta(soloFecha(params.get('hasta')))
  }, [params])

  function buildSearch(
    overrides: Partial<{
      q: string
      cat: string
      tpl: string
      desde: string
      hasta: string
      page: string
    }>,
  ): string {
    const next = new URLSearchParams(params.toString())
    const setOrDelete = (key: string, val: string) => {
      if (val && val.trim().length > 0) next.set(key, val.trim())
      else next.delete(key)
    }
    setOrDelete('q', overrides.q ?? q)
    setOrDelete('cat', overrides.cat ?? cat)
    setOrDelete('tpl', overrides.tpl ?? tpl)
    setOrDelete('desde', overrides.desde ?? desde)
    setOrDelete('hasta', overrides.hasta ?? hasta)
    // Cualquier cambio de filtro resetea page a 1 — el offset cambia.
    next.delete('page')
    return next.toString()
  }

  function applyFilters(overrides?: Parameters<typeof buildSearch>[0]) {
    const search = buildSearch(overrides ?? {})
    startTransition(() => {
      router.replace(search ? `/dashboard?${search}` : '/dashboard')
    })
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    applyFilters()
  }

  function handleReset() {
    setQ('')
    setCat('')
    setTpl('')
    setDesde('')
    setHasta('')
    startTransition(() => router.replace('/dashboard'))
  }

  const hasActive =
    q.length > 0 ||
    cat.length > 0 ||
    tpl.length > 0 ||
    desde.length > 0 ||
    hasta.length > 0

  const filtrosActivos = [cat, tpl, desde, hasta].filter((v) => v.length > 0).length
  const gridVisible = !hideSearch || abierto

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
    >
      {/* Línea de búsqueda full-width (se oculta si la página ya tiene LibrarySearch) */}
      {!hideSearch && (
        <div>
          <label className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
            Búsqueda en transcripciones
          </label>
          <div className="flex gap-2">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Palabras clave en título o contenido…"
              className="flex-1 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none placeholder:text-stone-400 focus:border-brand focus:ring-2 focus:ring-brand-ring/50 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
            />
            <button
              type="submit"
              className="tap-scale shrink-0 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-strong"
            >
              Buscar
            </button>
          </div>
        </div>
      )}

      {/* Toggle del panel de filtros (modo hideSearch) */}
      {hideSearch && (
        <button
          type="button"
          onClick={() => setAbierto((a) => !a)}
          aria-expanded={abierto}
          className="tap-scale flex w-full items-center justify-between rounded-md py-0.5 text-sm font-semibold text-stone-600 dark:text-stone-300"
        >
          <span className="inline-flex items-center gap-2">
            Filtros
            {filtrosActivos > 0 && (
              <span className="rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-bold text-white">
                {filtrosActivos}
              </span>
            )}
          </span>
          <span className="text-stone-400" aria-hidden>
            {abierto ? '▴' : '▾'}
          </span>
        </button>
      )}

      {/* Grilla de selectores */}
      {gridVisible && (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
            Categoría
          </label>
          <SelectMenu
            value={cat}
            onChange={(v) => {
              setCat(v)
              applyFilters({ cat: v })
            }}
            options={[{ value: '', label: 'Todas' }, ...categorias.map((c) => ({ value: c, label: formatCategoria(c) }))]}
            size="sm"
            ariaLabel="Categoría"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
            Plantilla
          </label>
          <SelectMenu
            value={tpl}
            onChange={(v) => {
              setTpl(v)
              applyFilters({ tpl: v })
            }}
            options={[{ value: '', label: 'Todas' }, ...templates.map((t) => ({ value: t.id, label: t.name }))]}
            size="sm"
            ariaLabel="Plantilla"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
            Desde
          </label>
          <input
            type="date"
            value={desde}
            onChange={(e) => {
              setDesde(e.target.value)
              applyFilters({ desde: e.target.value })
            }}
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-brand dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-400">
            Hasta
          </label>
          <input
            type="date"
            value={hasta}
            onChange={(e) => {
              setHasta(e.target.value)
              applyFilters({ hasta: e.target.value })
            }}
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-brand dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
          />
        </div>
      </div>
      )}

      {hasActive && gridVisible && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleReset}
            className="text-xs font-medium text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
          >
            Limpiar filtros
          </button>
        </div>
      )}
    </form>
  )
}
