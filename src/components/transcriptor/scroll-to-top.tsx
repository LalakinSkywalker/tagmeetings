'use client'

// =============================================================================
// ScrollToTop — botón flotante "volver arriba"
// =============================================================================
// Aparece al bajar en una página larga (ej. una transcripción con muchos
// segmentos) y, al tocarlo, regresa al inicio. Vive en la esquina inferior
// derecha, por encima de la barra de navegación (respeta safe-area).
// =============================================================================

import { useEffect, useState } from 'react'

export function ScrollToTop() {
  const [show, setShow] = useState(false)

  // El setState va en el callback del evento (no en el cuerpo del efecto). La
  // página arranca arriba → show=false es el estado inicial correcto.
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 500)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!show) return null

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Volver arriba"
      className="tap-scale fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+5rem)] z-40 flex size-11 items-center justify-center rounded-full border border-stone-200 bg-white/90 text-stone-700 shadow-lg backdrop-blur-md transition hover:bg-white dark:border-stone-700 dark:bg-stone-900/90 dark:text-stone-200 dark:hover:bg-stone-900"
    >
      <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
        <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
