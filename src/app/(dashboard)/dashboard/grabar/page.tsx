import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { buildTemplateSelectorData } from '@/lib/transcription/template-options'
import { resolveUserSettings } from '@/lib/settings'
import { Grabadora } from '@/components/transcriptor/grabadora'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import { AppHeader } from '@/components/shell/app-header'

export const dynamic = 'force-dynamic'
// Server actions invocadas desde la grabadora (createTranscripcionDraft +
// iniciarTranscripcion) pueden tomar hasta ~90s con Deepgram batch + LLM analisis.
// Next.js 16: maxDuration de server actions se declara a nivel page.
export const maxDuration = 300

export default async function GrabarPage() {
  const supabase = await createClient()
  const { data: jwt } = await supabase.auth.getClaims()
  const userId = jwt?.claims?.sub
  if (!userId) redirect('/login')

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
      <AppHeader title="Grabar reunión" backHref="/dashboard/capturar">
        <ThemeToggle />
      </AppHeader>

      <main className="mx-auto max-w-2xl px-4 py-4">
        <Grabadora templates={templates} grupos={grupos} defaults={defaults} />
      </main>
    </>
  )
}
