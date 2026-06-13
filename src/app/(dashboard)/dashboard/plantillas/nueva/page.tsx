import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PlantillaEditor } from '@/components/transcriptor/plantilla-editor'
import { AppHeader } from '@/components/shell/app-header'
import { ThemeToggle } from '@/components/theme/theme-toggle'

export const dynamic = 'force-dynamic'
// El asesor (conversarAsesor / generarPlantillaPreview / guardarPlantilla) son
// server actions con llamada LLM. Next.js 16: maxDuration se declara en la page.
export const maxDuration = 120

export default async function NuevaPlantillaPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <>
      <AppHeader title="Nueva plantilla" backHref="/dashboard/plantillas">
        <ThemeToggle />
      </AppHeader>

      <main className="mx-auto max-w-2xl px-4 py-4">
        <PlantillaEditor mode="crear" />
      </main>
    </>
  )
}
