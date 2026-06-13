'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Barra de navegacion inferior estilo app nativa iOS.
 * Fija al fondo, respeta safe-area, tab activo en naranja Bluntag.
 * Las 4 secciones estan pensadas para TODO el roadmap (Proyectos y Ajustes
 * se completan en fases posteriores; aqui ya existen como destino).
 */

interface TabDef {
  href: string
  label: string
  // match: como decidir si el tab esta activo segun el pathname
  match: (path: string) => boolean
  icon: (active: boolean) => React.ReactNode
}

const TABS: TabDef[] = [
  {
    href: '/dashboard/capturar',
    label: 'Capturar',
    match: (p) => p.startsWith('/dashboard/capturar') || p.startsWith('/dashboard/grabar'),
    icon: (active) => (
      <svg viewBox="0 0 24 24" fill="none" className="size-6" aria-hidden="true">
        <rect
          x="9"
          y="3"
          width="6"
          height="11"
          rx="3"
          stroke="currentColor"
          strokeWidth={active ? 2.2 : 1.8}
        />
        <path
          d="M5 11a7 7 0 0 0 14 0M12 18v3"
          stroke="currentColor"
          strokeWidth={active ? 2.2 : 1.8}
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    href: '/dashboard',
    label: 'Biblioteca',
    match: (p) =>
      p === '/dashboard' || p.startsWith('/dashboard/transcripcion'),
    icon: (active) => (
      <svg viewBox="0 0 24 24" fill="none" className="size-6" aria-hidden="true">
        <path
          d="M4 5h11M4 12h11M4 19h7"
          stroke="currentColor"
          strokeWidth={active ? 2.2 : 1.8}
          strokeLinecap="round"
        />
        <circle cx="19" cy="17" r="2.5" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} />
      </svg>
    ),
  },
  {
    href: '/dashboard/proyectos',
    label: 'Proyectos',
    match: (p) => p.startsWith('/dashboard/proyectos'),
    icon: (active) => (
      <svg viewBox="0 0 24 24" fill="none" className="size-6" aria-hidden="true">
        <path
          d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
          stroke="currentColor"
          strokeWidth={active ? 2.2 : 1.8}
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    href: '/dashboard/ajustes',
    label: 'Ajustes',
    match: (p) => p.startsWith('/dashboard/ajustes'),
    icon: (active) => (
      <svg viewBox="0 0 24 24" fill="none" className="size-6" aria-hidden="true">
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} />
        <path
          d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.04.04a1.5 1.5 0 1 1-2.12 2.12l-.04-.04a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V19a1.5 1.5 0 0 1-3 0v-.06a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.04.04a1.5 1.5 0 1 1-2.12-2.12l.04-.04a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H5a1.5 1.5 0 0 1 0-3h.06a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.04-.04a1.5 1.5 0 1 1 2.12-2.12l.04.04a1.65 1.65 0 0 0 1.82.33H11a1.65 1.65 0 0 0 1-1.51V5a1.5 1.5 0 0 1 3 0v.06a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.04-.04a1.5 1.5 0 1 1 2.12 2.12l-.04.04a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a1.5 1.5 0 0 1 0 3h-.06a1.65 1.65 0 0 0-1.51 1Z"
          stroke="currentColor"
          strokeWidth={active ? 2 : 1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
]

export function BottomNav() {
  const pathname = usePathname()

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-stone-200/80 bg-stone-50/90 backdrop-blur-lg pb-safe dark:border-stone-800/80 dark:bg-stone-950/90"
      aria-label="Navegación principal"
    >
      <div className="mx-auto flex max-w-2xl items-stretch justify-around px-2">
        {TABS.map((tab) => {
          const active = tab.match(pathname)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={`tap-scale flex flex-1 flex-col items-center gap-1 px-1 pt-2.5 pb-2 text-[10px] font-semibold tracking-wide transition-colors ${
                active
                  ? 'text-brand'
                  : 'text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300'
              }`}
            >
              {tab.icon(active)}
              <span>{tab.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
