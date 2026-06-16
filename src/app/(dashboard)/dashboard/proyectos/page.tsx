import { listarProyectos } from '@/actions/proyectos'
import { requireUserId } from '@/lib/supabase/auth'
import { ProyectoCard } from '@/components/transcriptor/proyecto-card'
import { CrearProyecto } from '@/components/transcriptor/crear-proyecto'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import { AppHeader } from '@/components/shell/app-header'
import { InfoTooltip } from '@/components/ui/info-tooltip'

export const dynamic = 'force-dynamic'

export default async function ProyectosPage() {
  await requireUserId()

  const proyectos = await listarProyectos()

  return (
    <>
      <AppHeader
        title="Proyectos"
        titleInfo={
          <InfoTooltip label="Qué es un proyecto">
            Un proyecto agrupa todas las reuniones de un mismo cliente o relación a
            través del tiempo: sus sesiones, sus participantes y lo que se acordó.
          </InfoTooltip>
        }
      >
        <ThemeToggle />
      </AppHeader>

      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        <CrearProyecto />

        {proyectos.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-300 px-4 py-10 text-center dark:border-stone-700">
            <p className="text-sm font-semibold text-stone-700 dark:text-stone-200">
              Aún no tienes proyectos
            </p>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Crea el primero y empieza a asignarle reuniones.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {proyectos.map((p) => (
              <ProyectoCard key={p.id} proyecto={p} />
            ))}
          </div>
        )}
      </main>
    </>
  )
}
