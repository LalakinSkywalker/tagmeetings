import Link from 'next/link'
import type { ProyectoListItem } from '@/actions/proyectos'

/** Tarjeta de proyecto en la lista. Enlaza al detalle del proyecto. */
export function ProyectoCard({ proyecto }: { proyecto: ProyectoListItem }) {
  const { color, nombre, descripcion, sesionesCount } = proyecto
  return (
    <Link
      href={`/dashboard/proyectos/${proyecto.id}`}
      className="tap-scale flex items-center gap-3 rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm transition hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:hover:bg-stone-800/60"
    >
      <span
        className="flex size-11 shrink-0 items-center justify-center rounded-2xl"
        style={{ backgroundColor: `${color}22` }}
      >
        <svg viewBox="0 0 24 24" fill="none" className="size-6" style={{ color }} aria-hidden="true">
          <path
            d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold text-stone-900 dark:text-stone-100">{nombre}</p>
        {descripcion && (
          <p className="truncate text-sm text-stone-500 dark:text-stone-400">{descripcion}</p>
        )}
        <p className="mt-0.5 text-xs text-stone-400 dark:text-stone-500">
          {sesionesCount} {sesionesCount === 1 ? 'sesión' : 'sesiones'}
        </p>
      </div>
      <svg viewBox="0 0 24 24" fill="none" className="size-5 shrink-0 text-stone-300 dark:text-stone-600" aria-hidden="true">
        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  )
}
