import { notFound } from 'next/navigation'
import { obtenerPlantillaSpec } from '@/actions/plantillas'
import { requireUserId } from '@/lib/supabase/auth'
import { PlantillaEditor } from '@/components/transcriptor/plantilla-editor'
import { AppHeader } from '@/components/shell/app-header'
import { ThemeToggle } from '@/components/theme/theme-toggle'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function EditarPlantillaPage({ params }: PageProps) {
  const { id } = await params
  await requireUserId()

  const res = await obtenerPlantillaSpec(id)
  if (!res.ok || !res.spec) notFound()

  return (
    <>
      <AppHeader title={res.nombre ?? 'Editar plantilla'} backHref="/dashboard/plantillas">
        <ThemeToggle />
      </AppHeader>

      <main className="mx-auto max-w-2xl px-4 py-4">
        <PlantillaEditor mode="editar" plantillaId={id} initialSpec={res.spec} />
      </main>
    </>
  )
}
