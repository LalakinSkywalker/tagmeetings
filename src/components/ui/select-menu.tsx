'use client'

// =============================================================================
// SelectMenu — menú desplegable unificado de toda la app (PRP-TT ajustes UI).
// =============================================================================
// Un solo componente para TODOS los desplegables (plantilla, idioma, filtros,
// tipo de campo). Reemplaza la mezcla de <select> nativos + combobox ad-hoc.
//
//   - MÓVIL: hoja inferior estilo app nativa de iPhone. Texto GRANDE (cómodo
//     para el dedo), ítems agrupados, palomita en el seleccionado. El label se
//     alinea en su propia columna: si ocupa 2 renglones, el 2º queda alineado
//     con el 1º (no debajo de la palomita) — arregla el desalineo del <select>.
//   - DESKTOP: popover flotante con buscador opcional, colores de acento y
//     sombras (el estilo que ya tenía el selector de idioma).
//
// Soporta: grupos (optgroups), buscador, badges por opción, y un ítem de ACCIÓN
// al final (ej. "Crear nueva con IA") que dispara un callback en vez de elegir.
// =============================================================================

import { useEffect, useRef, useState } from 'react'

export interface SelectOption {
  value: string
  label: string
  badge?: string
}

export interface SelectGroup {
  label: string
  ids: string[]
}

interface Props {
  value: string
  onChange: (v: string) => void
  options: SelectOption[]
  groups?: SelectGroup[]
  searchable?: boolean
  searchPlaceholder?: string
  /** Ítem de acción al final del menú (no selecciona; dispara onClick). */
  action?: { label: string; onClick: () => void }
  disabled?: boolean
  size?: 'sm' | 'md'
  id?: string
  ariaLabel?: string
  /** Texto del trigger cuando value no corresponde a ninguna opción. */
  placeholder?: string
}

// Rango de marcas diacríticas combinables (U+0300–U+036F). Se construye con
// fromCharCode para NO teclear los caracteres combinables en el fuente (regla
// dura del workspace: evita corrupción del archivo por bytes de control).
const DIACRITICOS = new RegExp(
  '[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']',
  'g',
)

function normalizar(s: string): string {
  return s.normalize('NFD').replace(DIACRITICOS, '').toLowerCase()
}

export function SelectMenu({
  value,
  onChange,
  options,
  groups,
  searchable = false,
  searchPlaceholder = 'Buscar…',
  action,
  disabled = false,
  size = 'md',
  id,
  ariaLabel,
  placeholder = 'Seleccionar…',
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selected = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent | TouchEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        close()
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open && searchable) {
      // En desktop el buscador toma foco; en móvil no, para no abrir el teclado
      // de golpe sobre la hoja inferior.
      if (window.matchMedia('(min-width: 640px)').matches) searchRef.current?.focus()
    }
  }, [open, searchable])

  function close() {
    setOpen(false)
    setQuery('')
  }

  function pick(v: string) {
    onChange(v)
    close()
  }

  const padY = size === 'sm' ? 'py-2' : 'py-2.5'
  const textSize = size === 'sm' ? 'text-sm' : 'text-base'
  const triggerClass = `flex w-full items-center justify-between gap-2 rounded-md border border-stone-300 bg-white px-3 ${padY} ${textSize} text-left shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100`

  const q = normalizar(query.trim())
  const filtrando = q.length > 0
  const filtered = filtrando
    ? options.filter(
        (o) => normalizar(o.label).includes(q) || o.value.toLowerCase().includes(q),
      )
    : options

  // Estructura a renderizar: lista plana (buscando o sin grupos) o agrupada.
  const byId = (vid: string) => options.find((o) => o.value === vid)
  const renderGroups = !filtrando && groups && groups.length > 0

  function OptionButton({ o }: { o: SelectOption }) {
    const active = o.value === value
    return (
      <button
        type="button"
        role="option"
        aria-selected={active}
        onClick={() => pick(o.value)}
        className={`flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left text-base transition sm:py-2 sm:text-sm ${
          active
            ? 'bg-brand-soft font-semibold text-brand dark:bg-brand-softdark'
            : 'text-stone-700 hover:bg-stone-50 dark:text-stone-200 dark:hover:bg-stone-800'
        }`}
      >
        <span className="min-w-0 flex-1">{o.label}</span>
        {o.badge && (
          <span className="shrink-0 rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-stone-400 dark:bg-stone-800">
            {o.badge}
          </span>
        )}
        <span className="size-5 shrink-0">
          {active && (
            <svg viewBox="0 0 24 24" fill="none" className="size-5 text-brand" aria-hidden="true">
              <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      </button>
    )
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={triggerClass}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className={`size-4 shrink-0 text-stone-400 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <>
          {/* Telón oscuro: solo móvil (la hoja inferior flota sobre el contenido). */}
          <div
            className="fixed inset-0 z-40 bg-black/40 sm:hidden"
            onClick={close}
            aria-hidden="true"
          />

          {/* Panel: hoja inferior en móvil, popover en desktop. */}
          <div
            role="listbox"
            className="fixed inset-x-0 bottom-0 z-50 max-h-[78vh] overflow-hidden rounded-t-3xl border-t border-stone-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900 sm:absolute sm:inset-x-0 sm:bottom-auto sm:top-full sm:z-40 sm:mt-1 sm:max-h-80 sm:rounded-2xl sm:border sm:shadow-lg"
          >
            {/* Asa de la hoja (solo móvil). */}
            <div className="flex justify-center pt-2.5 sm:hidden">
              <span className="h-1.5 w-10 rounded-full bg-stone-300 dark:bg-stone-700" />
            </div>

            {searchable && (
              <div className="border-b border-stone-100 p-2 dark:border-stone-800">
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && filtered.length > 0) {
                      e.preventDefault()
                      pick(filtered[0]!.value)
                    }
                  }}
                  placeholder={searchPlaceholder}
                  className="block w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5 text-base text-stone-900 outline-none placeholder:text-stone-400 focus:border-brand focus:ring-2 focus:ring-brand-ring/40 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100 sm:py-1.5 sm:text-sm"
                />
              </div>
            )}

            <div className="max-h-[64vh] overflow-auto overscroll-contain py-1.5 sm:max-h-72 sm:py-1">
              {filtered.length === 0 && (
                <div className="px-4 py-3 text-sm text-stone-400">Sin resultados</div>
              )}

              {renderGroups
                ? groups!.map((g) => {
                    const items = g.ids
                      .map(byId)
                      .filter((o): o is SelectOption => Boolean(o))
                    if (items.length === 0) return null
                    return (
                      <div key={g.label}>
                        <div className="px-4 pb-1 pt-2.5 text-xs font-semibold uppercase tracking-wide text-stone-400">
                          {g.label}
                        </div>
                        {items.map((o) => (
                          <OptionButton key={o.value} o={o} />
                        ))}
                      </div>
                    )
                  })
                : filtered.map((o) => <OptionButton key={o.value} o={o} />)}

              {action && !filtrando && (
                <button
                  type="button"
                  onClick={() => {
                    close()
                    action.onClick()
                  }}
                  className="mt-1 flex w-full items-center gap-2 border-t border-stone-100 px-4 py-3.5 text-left text-base font-semibold text-brand transition hover:bg-brand-soft dark:border-stone-800 dark:hover:bg-brand-softdark sm:py-2.5 sm:text-sm"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="size-5 shrink-0" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
                  </svg>
                  {action.label}
                </button>
              )}
            </div>

            {/* Respeta el área segura inferior en móvil (notch / barra gestos). */}
            <div className="pb-safe sm:hidden" />
          </div>
        </>
      )}
    </div>
  )
}
