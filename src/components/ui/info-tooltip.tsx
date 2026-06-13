'use client'

// =============================================================================
// InfoTooltip — ícono ⓘ que abre un globo con la explicación bajo demanda.
// =============================================================================
// Reemplaza los párrafos grises que ensuciaban la UI: la info útil queda a un
// toque de distancia (tap en móvil, click en desktop) sin ocupar la pantalla.
// El globo se ancla al ícono y, tras abrir, se corrige horizontalmente para no
// salirse del viewport (importante cuando el ⓘ está a media pantalla, ej. junto
// a un título). Cierra al tocar fuera o con Escape.
// =============================================================================

import { useEffect, useRef, useState } from 'react'

export function InfoTooltip({
  children,
  label = 'Más información',
}: {
  children: React.ReactNode
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [shift, setShift] = useState(0)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent | TouchEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Corrige la posición horizontal para que el globo nunca se salga de pantalla.
  useEffect(() => {
    if (!open) {
      setShift(0)
      return
    }
    const el = popRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    let dx = 0
    if (rect.left < margin) dx = margin - rect.left
    else if (rect.right > window.innerWidth - margin) dx = window.innerWidth - margin - rect.right
    if (dx !== 0) setShift(dx)
  }, [open])

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          // Evita que el clic burbujee a un contenedor clicable (ej. el botón
          // colapsable de Participantes) y lo abra/cierre por accidente.
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        aria-label={label}
        aria-expanded={open}
        className={`tap-scale inline-flex size-5 items-center justify-center rounded-full transition ${
          open
            ? 'bg-brand-soft text-brand dark:bg-brand-softdark'
            : 'text-stone-400 hover:text-stone-600 dark:hover:text-stone-200'
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" className="size-[18px]" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={1.7} />
          <path d="M12 11v5" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
          <circle cx="12" cy="7.75" r="1" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <span
          ref={popRef}
          role="tooltip"
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          className="absolute right-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-stone-200 bg-white p-3.5 text-left text-base leading-relaxed font-normal text-stone-600 shadow-lg dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
        >
          {children}
        </span>
      )}
    </span>
  )
}
