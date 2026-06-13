import Link from 'next/link'

/**
 * Header estilo app nativa iOS (large title).
 * - Fila superior: boton atras (solo flecha) + acciones (children, ej. ThemeToggle).
 * - Titulo grande debajo, con slot opcional para un globo de ayuda (titleInfo).
 *   Sticky con blur + safe-area superior.
 */
export function AppHeader({
  title,
  subtitle,
  backHref,
  titleInfo,
  children,
}: {
  title: string
  subtitle?: string
  backHref?: string
  /** Globo de ayuda (InfoTooltip) que se muestra junto al titulo. */
  titleInfo?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-stone-200/70 bg-stone-50/85 backdrop-blur-lg pt-safe dark:border-stone-800/70 dark:bg-stone-950/85">
      <div className="mx-auto max-w-2xl px-4">
        <div className="flex min-h-[2.25rem] items-center justify-between gap-2 pt-2">
          {backHref ? (
            <Link
              href={backHref}
              aria-label="Atrás"
              className="tap-scale -ml-1.5 inline-flex items-center rounded-lg p-1 text-brand"
            >
              <svg viewBox="0 0 24 24" fill="none" className="size-6" aria-hidden="true">
                <path
                  d="M15 5l-7 7 7 7"
                  stroke="currentColor"
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
          <div className="flex items-center gap-1">{children}</div>
        </div>
        <div className="pt-1 pb-3">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-extrabold tracking-tight text-stone-900 dark:text-stone-50">
              {title}
            </h1>
            {titleInfo}
          </div>
          {subtitle ? (
            <p className="mt-0.5 truncate text-sm font-medium text-stone-500 dark:text-stone-400">
              {subtitle}
            </p>
          ) : null}
        </div>
      </div>
    </header>
  )
}
