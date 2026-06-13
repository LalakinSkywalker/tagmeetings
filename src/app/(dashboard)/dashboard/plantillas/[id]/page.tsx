import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { obtenerPlantillaSpec } from '@/actions/plantillas'
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
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

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
