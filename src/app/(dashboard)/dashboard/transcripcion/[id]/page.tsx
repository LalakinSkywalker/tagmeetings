import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TranscripcionDetalle } from '@/components/transcriptor/transcripcion-detalle'
import { TranscripcionEstadoPoller } from '@/components/transcriptor/transcripcion-estado-poller'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import { AppHeader } from '@/components/shell/app-header'
import {
  listAsksDelTranscripcion,
  transcripcionEstaIndexada,
} from '@/actions/transcripciones'
import { listarProyectos } from '@/actions/proyectos'
import { resolveTemplateAsync } from '@/lib/transcription'
import { buildTemplateSelectorData } from '@/lib/transcription/template-options'
import { AccionesMenu } from '@/components/transcriptor/acciones-menu'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface PageProps {
  params: Promise<{ id: string }>
}

type Estado =
  | 'pendiente'
  | 'transcribiendo'
  | 'analizando'
  | 'indexando'
  | 'completado'
  | 'error'

export default async function TranscripcionDetallePage({ params }: PageProps) {
  const { id } = await params
  const supabase = await createClient()
  const { data: jwt } = await supabase.auth.getClaims()
  const userId = jwt?.claims?.sub
  if (!userId) {
    redirect('/login')
  }

  // Columnas explicitas (regla workspace: no SELECT *).
  // RLS de transcripciones filtra por user_id automaticamente.
  // NOTA: NO incluir callback_secret aqui — es server-only y publicarlo seria
  // permitir falsificar callbacks de Deepgram.
  const { data, error } = await supabase
    .from('transcripciones')
    .select(
      'id, titulo, template_id, estado, raw_text, segments, analisis, categoria, duracion_ms, idioma, idioma_detectado, traducido_a, raw_text_traducido, segments_traducido, participantes_esperados, num_speakers_esperados, cost_usd_total, created_at, completed_at, error_message, speaker_names, es_multifuente, proyecto_id, modo_analisis, audio_path, archivado_en, drive_folder_id, texto_editado_en, audio_liberado_en',
    )
    .eq('id', id)
    .single()

  if (error || !data) {
    notFound()
  }

  const estado = data.estado as Estado
  const isProcesando =
    estado === 'pendiente' ||
    estado === 'transcribiendo' ||
    estado === 'analizando' ||
    estado === 'indexando'

  // Solo cargar Ask history + indexada cuando la transcripcion esta completada.
  // Mientras procesa, esos datos no existen aun.
  const [asksHistory, indexada] = isProcesando
    ? [[] as Awaited<ReturnType<typeof listAsksDelTranscripcion>>, false]
    : await Promise.all([
        listAsksDelTranscripcion(id),
        transcripcionEstaIndexada(id),
      ])

  // Nombre legible de la plantilla (predefinida o custom del usuario). Para
  // custom el chip mostraria "custom:<uuid>" sin esto.
  const plantilla = await resolveTemplateAsync(supabase, data.template_id, userId)
  const plantillaNombre = plantilla?.name ?? data.template_id

  // Proyectos del usuario para el selector de asignación.
  const proyectos = (await listarProyectos()).map((p) => ({ id: p.id, nombre: p.nombre }))

  // Plantillas disponibles para re-analizar con otra plantilla.
  const { templates, grupos } = await buildTemplateSelectorData()

  // Fuentes que componen un analisis multi-fuente.
  const fuentes = data.es_multifuente
    ? (
        await supabase
          .from('transcripcion_fuentes')
          .select('orden, tipo, nombre_archivo, estado, audio_liberado_en')
          .eq('transcripcion_id', id)
          .order('orden', { ascending: true })
      ).data ?? []
    : []

  // El motor de export vive en /api/.../export (server). Aqui solo pasamos lo
  // minimo para armar la hoja de descarga.
  // Para multifuente, audio_path es el placeholder 'multifuente' (no un archivo
  // real): no hay UN audio unico que descargar/archivar, asi que no se ofrece.
  // El audio liberado (Bloque Almacenamiento) ya no existe en R2: no se ofrece
  // descargar/archivar (la transcripcion sigue intacta).
  const audioDisponible =
    Boolean(data.audio_path) && data.audio_path !== 'multifuente' && !data.audio_liberado_en

  // ¿Drive conectado?. Query directa: el user ya está resuelto. RLS
  // de drive_connections filtra por auth.uid(); no leemos las columnas de tokens.
  const { data: driveConn } = await supabase
    .from('drive_connections')
    .select('user_id, connected_email')
    .eq('user_id', userId)
    .maybeSingle()
  const driveConnected = Boolean(driveConn)
  const driveEmail = (driveConn?.connected_email as string | null) ?? null

  // Para la hoja de archivar: nombre del proyecto contenedor (o null = suelta) y
  // extensión real del audio, para mostrar la ruta y los nombres de preview.
  const carpetaProyecto = data.proyecto_id
    ? (proyectos.find((p) => p.id === data.proyecto_id)?.nombre ?? null)
    : null
  const audioExt =
    (data.audio_path?.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'audio'

  return (
    <>
      <AppHeader title={data.titulo} backHref="/dashboard">
        <ThemeToggle />
        <AccionesMenu
          transcripcionId={data.id}
          titulo={data.titulo}
          hayAnalisis={Boolean(data.analisis)}
          audioDisponible={audioDisponible}
          audioExt={audioExt}
          listo={!isProcesando}
          driveConnected={driveConnected}
          driveEmail={driveEmail}
          carpetaProyecto={carpetaProyecto}
          archivadoEn={data.archivado_en ?? null}
          driveFolderId={data.drive_folder_id ?? null}
        />
      </AppHeader>

      <main className="mx-auto max-w-2xl px-4 py-4">
        {isProcesando ? (
          <TranscripcionEstadoPoller
            transcripcionId={id}
            estadoInicial={estado}
          />
        ) : (
          <TranscripcionDetalle
            transcripcion={data}
            asksHistory={asksHistory}
            indexada={indexada}
            plantillaNombre={plantillaNombre}
            fuentes={fuentes}
            proyectoId={data.proyecto_id ?? null}
            proyectos={proyectos}
            templates={templates}
            grupos={grupos}
          />
        )}
      </main>
    </>
  )
}
