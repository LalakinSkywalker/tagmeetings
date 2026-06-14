import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { obtenerProyectoDetalle, listarAskProyecto } from '@/actions/proyectos'
import { ProyectoAcciones } from '@/components/transcriptor/proyecto-acciones'
import { ProyectoAskPanel } from '@/components/transcriptor/proyecto-ask-panel'
import { ProyectoMemoria } from '@/components/transcriptor/proyecto-memoria'
import { ProyectoPendientes } from '@/components/transcriptor/proyecto-pendientes'
import { AppHeader } from '@/components/shell/app-header'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import { InfoTooltip } from '@/components/ui/info-tooltip'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

const ESTADO_DOT: Record<string, string> = {
  pendiente: 'bg-stone-400',
  transcribiendo: 'bg-brand animate-pulse',
  analizando: 'bg-brand animate-pulse',
  indexando: 'bg-brand animate-pulse',
  completado: 'bg-emerald-500',
  error: 'bg-red-500',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(ms: number | null): string {
  if (!ms) return '—'
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${String(sec).padStart(2, '0')}`
}

export default async function ProyectoDetallePage({ params }: PageProps) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const proyecto = await obtenerProyectoDetalle(id)
  if (!proyecto) notFound()

  // Memoria del proyecto (Ask cross-sesion): solo tiene sentido con >=1 sesion.
  const askHistory = proyecto.sesiones.length > 0 ? await listarAskProyecto(id) : []

  return (
    <>
      <AppHeader title={proyecto.nombre} backHref="/dashboard/proyectos">
        <ThemeToggle />
      </AppHeader>

      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        <ProyectoAcciones
          proyecto={{
            id: proyecto.id,
            nombre: proyecto.nombre,
            descripcion: proyecto.descripcion,
            color: proyecto.color,
          }}
        />

        {/* Directorio de participantes (union de hablantes de las sesiones) */}
        {proyecto.participantes.length > 0 && (
          <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <h3 className="text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
                Participantes ({proyecto.participantes.length})
              </h3>
              <InfoTooltip label="Qué son estos participantes">
                Nombres de hablantes que ya nombraste en las sesiones de este proyecto.
              </InfoTooltip>
            </div>
            <div className="flex flex-wrap gap-2">
              {proyecto.participantes.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center rounded-full bg-stone-100 px-3 py-1 text-sm font-medium text-stone-700 dark:bg-stone-800 dark:text-stone-200"
                >
                  {p}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Memoria del histórico — resumen jerárquico */}
        {proyecto.sesiones.length > 0 && (
          <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
                Memoria del proyecto
              </h3>
              <InfoTooltip label="Qué es la memoria del proyecto">
                Un resumen de toda la historia del proyecto: sintetiza los resúmenes de todas sus
                sesiones en un solo panorama. Lo generas cuando quieras y lo actualizas al sumar
                reuniones.
              </InfoTooltip>
            </div>
            <ProyectoMemoria
              proyectoId={proyecto.id}
              resumenInicial={proyecto.memoriaResumen}
              generadaAt={proyecto.memoriaGeneradaAt}
              stale={proyecto.memoriaStale}
              sesionesCompletadasCount={proyecto.sesionesCompletadasCount}
            />
          </section>
        )}

        {/* Tablero de pendientes vivo */}
        {proyecto.sesiones.length > 0 && (
          <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
                Pendientes del proyecto
              </h3>
              <InfoTooltip label="Qué es el tablero de pendientes">
                Junta los compromisos y tareas detectados en todas las reuniones de este proyecto.
                La IA propone si cada uno sigue pendiente, va en curso o ya se hizo —revisando si una
                sesión posterior lo resolvió— y tú lo confirmas o ajustas. También puedes agregar
                pendientes a mano.
              </InfoTooltip>
            </div>
            <ProyectoPendientes
              proyectoId={proyecto.id}
              pendientesInicial={proyecto.pendientes}
              generadosAt={proyecto.pendientesGeneradosAt}
              stale={proyecto.pendientesStale}
              sesionesCompletadasCount={proyecto.sesionesCompletadasCount}
            />
          </section>
        )}

        {/* Pregúntale al proyecto — Ask cross-sesion */}
        {proyecto.sesiones.length > 0 && (
          <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
                Pregúntale al proyecto
              </h3>
              <InfoTooltip label="Cómo funciona preguntarle al proyecto">
                Pregunta sobre todas las sesiones de este proyecto a la vez. Busco en cada reunión
                y te respondo citando en qué sesión y momento se dijo. Las sesiones deben estar
                indexadas (su tab Ask disponible).
              </InfoTooltip>
            </div>
            <ProyectoAskPanel proyectoId={proyecto.id} initialHistory={askHistory} />
          </section>
        )}

        {/* Sesiones del proyecto */}
        <section>
          <h3 className="mb-2.5 px-1 text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
            Sesiones ({proyecto.sesiones.length})
          </h3>

          {proyecto.sesiones.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-stone-300 px-4 py-10 text-center dark:border-stone-700">
              <p className="text-sm font-semibold text-stone-700 dark:text-stone-200">
                Este proyecto no tiene sesiones todavía
              </p>
              <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                Abre cualquier reunión y asígnala a este proyecto.
              </p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {proyecto.sesiones.map((s) => {
                const dot = ESTADO_DOT[s.estado] ?? ESTADO_DOT.pendiente
                return (
                  <li key={s.id}>
                    <Link
                      href={`/dashboard/transcripcion/${s.id}`}
                      className="tap-scale flex items-center gap-3 rounded-2xl border border-stone-200/80 bg-white p-3.5 shadow-sm transition hover:border-stone-300 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-700"
                    >
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft dark:bg-brand-softdark">
                        <svg viewBox="0 0 24 24" fill="none" className="size-5 text-brand" aria-hidden="true">
                          <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth={1.8} />
                          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold text-stone-900 dark:text-stone-100">
                          {s.titulo}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">
                          {(s.categoria ?? s.template_id)} · {formatDate(s.created_at)} · {formatDuration(s.duracion_ms)}
                        </p>
                        <div className="mt-1.5 flex items-center gap-1.5">
                          <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                        </div>
                      </div>
                      <svg viewBox="0 0 24 24" fill="none" className="size-5 shrink-0 text-stone-300 dark:text-stone-600" aria-hidden="true">
                        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </main>
    </>
  )
}
