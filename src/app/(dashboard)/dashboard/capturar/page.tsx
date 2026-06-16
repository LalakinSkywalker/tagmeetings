import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { buildTemplateSelectorData } from '@/lib/transcription/template-options'
import { resolveUserSettings } from '@/lib/settings'
import { SubirArchivos } from '@/components/transcriptor/subir-archivos'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import { AppHeader } from '@/components/shell/app-header'

export const dynamic = 'force-dynamic'
// Las server actions de subida (simple + combinada) se invocan desde el uploader
// embebido en esta página; Next 16: maxDuration a nivel page.
export const maxDuration = 300

export default async function CapturarPage() {
  const supabase = await createClient()
  const { data: jwt } = await supabase.auth.getClaims()
  const userId = jwt?.claims?.sub
  if (!userId) {
    redirect('/login')
  }

  const { templates, grupos } = await buildTemplateSelectorData()
  const settings = await resolveUserSettings(supabase, userId)
  const defaults = {
    idioma: settings.idiomaDefault,
    traducirA: settings.traducirA,
    modo: settings.modoAnalisisDefault,
    templateId: settings.templateIdDefault,
  }

  return (
    <>
      <AppHeader title="Capturar">
        <ThemeToggle />
      </AppHeader>

      <main className="mx-auto max-w-2xl space-y-5 px-4 py-4">
        {/* Opción principal: grabar en vivo (la única que redirige a su pantalla) */}
        <Link
          href="/dashboard/grabar"
          className="tap-scale flex items-center gap-4 rounded-2xl bg-brand p-4 text-white shadow-sm transition hover:bg-brand-strong"
        >
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/20">
            <svg viewBox="0 0 24 24" fill="none" className="size-6" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth={2} />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-base font-bold">Grabar reunión</p>
          </div>
          <svg viewBox="0 0 24 24" fill="none" className="size-5 shrink-0 text-white/80" aria-hidden="true">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>

        {/* Separador */}
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-stone-200 dark:bg-stone-800" />
          <span className="text-sm font-medium text-stone-400">o sube uno o varios archivos</span>
          <span className="h-px flex-1 bg-stone-200 dark:bg-stone-800" />
        </div>

        {/* Uploader unificado embebido: corre el análisis aquí mismo (sin redirigir).
            1 audio/video → motor simple; 2+ archivos o documentos → motor combinado. */}
        <SubirArchivos templates={templates} grupos={grupos} defaults={defaults} />
      </main>
    </>
  )
}
