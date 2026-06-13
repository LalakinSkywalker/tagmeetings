import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import {
  getCategoriasDelUser,
  listTranscripcionesDelUser,
} from '@/actions/transcripciones'
import { buildTemplateSelectorData } from '@/lib/transcription/template-options'
import { TranscripcionList } from '@/components/transcriptor/transcripcion-list'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import { LibrarySearch } from '@/components/transcriptor/library-search'
import { DashboardFilters } from '@/components/transcriptor/dashboard-filters'
import { Paginator } from '@/components/transcriptor/paginator'
import { AppHeader } from '@/components/shell/app-header'

export const dynamic = 'force-dynamic'
// Next.js 16: maxDuration de server actions se declara a nivel page.
export const maxDuration = 300

const PAGE_SIZE = 20

interface PageProps {
  // Next.js 15+: searchParams es Promise<...>
  searchParams: Promise<{
    q?: string
    cat?: string
    tpl?: string
    desde?: string
    hasta?: string
    page?: string
  }>
}

function pickString(val: string | string[] | undefined): string | undefined {
  if (typeof val === 'string') return val
  if (Array.isArray(val) && val.length > 0) return val[0]
  return undefined
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const params = await searchParams
  const q = pickString(params.q) ?? ''
  const cat = pickString(params.cat) ?? ''
  const tpl = pickString(params.tpl) ?? ''
  const desde = pickString(params.desde) ?? ''
  const hasta = pickString(params.hasta) ?? ''
  const pageParam = pickString(params.page)
  const pageNum = pageParam ? parseInt(pageParam, 10) : 1
  const page = Number.isFinite(pageNum) && pageNum >= 1 ? pageNum : 1

  const hasActiveFilters = Boolean(q || cat || tpl || desde || hasta)

  const [listResult, categorias, { templates }] = await Promise.all([
    listTranscripcionesDelUser({
      searchText: q || null,
      categoria: cat || null,
      templateId: tpl || null,
      desde: desde || null,
      hasta: hasta || null,
      // Biblioteca limpia (Hueco C): solo sesiones sueltas. Las asignadas a un
      // proyecto viven dentro de ese proyecto, no en el listado general.
      soloSueltas: true,
      page,
      pageSize: PAGE_SIZE,
    }),
    getCategoriasDelUser(),
    buildTemplateSelectorData(),
  ])

  const conteo =
    listResult.total === 1 ? '1 transcripción' : `${listResult.total} transcripciones`

  return (
    <>
      <AppHeader title="Biblioteca" subtitle={conteo}>
        <ThemeToggle />
      </AppHeader>

      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        <LibrarySearch />

        <DashboardFilters
          categorias={categorias}
          templates={templates.map((t) => ({ id: t.id, name: t.name }))}
          hideSearch
        />

        <TranscripcionList
          items={listResult.items}
          hasActiveFilters={hasActiveFilters}
        />

        <Paginator
          total={listResult.total}
          page={listResult.page}
          pageSize={listResult.pageSize}
          pageCount={listResult.pageCount}
        />
      </main>
    </>
  )
}
