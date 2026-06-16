import { PlantillaEditor } from '@/components/transcriptor/plantilla-editor'
import { requireUserId } from '@/lib/supabase/auth'
import { AppHeader } from '@/components/shell/app-header'
import { ThemeToggle } from '@/components/theme/theme-toggle'

export const dynamic = 'force-dynamic'
// El asesor (conversarAsesor / generarPlantillaPreview / guardarPlantilla) son
// server actions con llamada LLM. Next.js 16: maxDuration se declara en la page.
export const maxDuration = 120

export default async function NuevaPlantillaPage() {
  await requireUserId()

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
