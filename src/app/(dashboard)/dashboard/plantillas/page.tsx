import Link from 'next/link'
import { listarPlantillasUsuario } from '@/actions/plantillas'
import { requireUserId } from '@/lib/supabase/auth'
import { PlantillaCard } from '@/components/transcriptor/plantilla-card'
import { AppHeader } from '@/components/shell/app-header'
import { ThemeToggle } from '@/components/theme/theme-toggle'

export const dynamic = 'force-dynamic'

export default async function PlantillasPage() {
  await requireUserId()

  const plantillas = await listarPlantillasUsuario()

  return (
    <>
      <AppHeader title="Mis plantillas" backHref="/dashboard/ajustes">
        <ThemeToggle />
      </AppHeader>

      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        <Link
          href="/dashboard/plantillas/nueva"
          className="tap-scale flex items-center gap-4 rounded-2xl bg-brand p-4 text-white shadow-sm transition hover:bg-brand-strong"
        >
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/20">
            <svg viewBox="0 0 24 24" fill="none" className="size-6" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-bold">Crear plantilla con IA</p>
            <p className="text-xs text-white/85">
              Describe tu caso y el asesor te arma la plantilla
            </p>
          </div>
          <svg viewBox="0 0 24 24" fill="none" className="size-5 shrink-0 text-white/80" aria-hidden="true">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>

        <p className="px-1 text-xs text-stone-500 dark:text-stone-400">
          Tus plantillas aparecen junto a las predefinidas al grabar o subir audio,
          bajo el grupo “Mis plantillas”. Toda plantilla extrae resumen, puntos clave
          y tareas; aquí defines qué más extraer.
        </p>

        {plantillas.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-300 px-4 py-10 text-center dark:border-stone-700">
            <p className="text-sm font-semibold text-stone-700 dark:text-stone-200">
              Aún no tienes plantillas propias
            </p>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Crea la primera con el asesor de IA.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {plantillas.map((p) => (
              <PlantillaCard key={p.id} plantilla={p} />
            ))}
          </div>
        )}
      </main>
    </>
  )
}
