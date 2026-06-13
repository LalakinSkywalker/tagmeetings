import 'server-only'

// =============================================================================
// backup — respaldo solo-audio a Drive con confirmacion explicita de exito.
// =============================================================================
// El cron de almacenamiento (Bloque Almacenamiento) necesita respaldar el audio
// ANTES de liberarlo, y la salvaguarda dura exige saber con CERTEZA si el audio
// quedo en Drive. El `archivarEnDrive` (server action de UI) hace el upload del
// audio en best-effort (se traga el error) → NO sirve para la salvaguarda. Estas
// funciones son server-only (reciben el service client del cron, sin sesion) y
// devuelven `{ ok }` REAL del audio: si el upload falla, ok=false y el cron NO
// borra. Reusan los mismos helpers de Drive que el archivado manual.
//
//  - `respaldarAudioEnDrive`: sesion SINGLE (audio en transcripciones.audio_path).
//  - `respaldarFuenteEnDrive`: una fuente de una sesion MULTIFUENTE (audio en
//    transcripcion_fuentes.audio_path). Marca `archivado_en` POR FUENTE para que
//    la salvaguarda en modo manual sepa cual fuente ya fue respaldada.
// Ambas resuelven la misma estructura de carpetas via `resolverCarpetaSesion`.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { getValidAccessToken } from './store'
import { ensureFolder, uploadFile } from './client'
import { getStorageAdapter } from '@/lib/transcription'
import { PATHS_NO_REALES } from '@/lib/storage/lifecycle-rules'
import { tituloParaArchivo, CONTENIDO_LABEL, nombreArchivo } from '@/lib/export/format'

/**
 * Resuelve (creando si hace falta) la carpeta de Drive de una sesion:
 * `TagMeetings / {proyecto | Sesiones sueltas} / {titulo}`. Si la sesion
 * pertenece a un proyecto, persiste el `drive_folder_id` del proyecto. Devuelve
 * el id de la carpeta de la sesion (donde van los archivos). Compartido por el
 * respaldo single y el de fuentes multifuente para no duplicar la estructura.
 */
async function resolverCarpetaSesion(
  supabase: SupabaseClient,
  accessToken: string,
  params: { titulo: string; proyectoId: string | null },
): Promise<string> {
  const baseFolder = await ensureFolder(accessToken, 'TagMeetings')
  let parentFolder = baseFolder
  if (params.proyectoId) {
    const { data: proy } = await supabase
      .from('proyectos')
      .select('id, nombre, drive_folder_id')
      .eq('id', params.proyectoId)
      .single()
    if (proy) {
      parentFolder = await ensureFolder(accessToken, (proy.nombre as string) ?? 'Proyecto', baseFolder)
      if (proy.drive_folder_id !== parentFolder) {
        await supabase.from('proyectos').update({ drive_folder_id: parentFolder }).eq('id', proy.id)
      }
    }
  } else {
    parentFolder = await ensureFolder(accessToken, 'Sesiones sueltas', baseFolder)
  }
  return ensureFolder(accessToken, tituloParaArchivo(params.titulo), parentFolder)
}

/** Extension limpia y segura derivada de un path de R2 (fallback 'audio'). */
function extDePath(path: string): string {
  return (path.split('.').pop() ?? 'audio').toLowerCase().replace(/[^a-z0-9]/g, '') || 'audio'
}

/**
 * Sube SOLO el audio de una sesion SINGLE a Drive y confirma el exito de forma
 * explicita. Marca `archivado_en` + `drive_folder_id` solo si el upload del audio
 * realmente funciono. NO es best-effort: el `ok` refleja el resultado real.
 */
export async function respaldarAudioEnDrive(
  supabase: SupabaseClient,
  params: { transcripcionId: string; userId: string },
): Promise<{ ok: boolean; error?: string; folderId?: string }> {
  const { transcripcionId, userId } = params

  const accessToken = await getValidAccessToken(userId)
  if (!accessToken) return { ok: false, error: 'Drive no conectado para este usuario.' }

  const { data, error } = await supabase
    .from('transcripciones')
    .select('id, titulo, audio_path, proyecto_id')
    .eq('id', transcripcionId)
    .single()
  if (error || !data?.audio_path) {
    return { ok: false, error: 'Sesión o audio no encontrado.' }
  }

  try {
    // 1. Bajar el audio de R2 (signed URL server-side).
    const storage = getStorageAdapter()
    const signed = await storage.getSignedDownloadUrl(data.audio_path as string, { expiresInSec: 900 })
    const aRes = await fetch(signed)
    if (!aRes.ok) {
      return { ok: false, error: `No se pudo leer el audio de R2 (HTTP ${aRes.status}).` }
    }

    // 2. Estructura TagMeetings / {proyecto | Sesiones sueltas} / {sesion}.
    const sessionFolder = await resolverCarpetaSesion(supabase, accessToken, {
      titulo: data.titulo as string,
      proyectoId: (data.proyecto_id as string | null) ?? null,
    })

    // 3. Subir el audio. Si esto lanza, cae al catch → ok=false (salvaguarda).
    const ext = extDePath(data.audio_path as string)
    const audioName = nombreArchivo(data.titulo as string, CONTENIDO_LABEL.audio, ext)
    await uploadFile(accessToken, {
      name: audioName,
      mimeType: aRes.headers.get('content-type') ?? 'application/octet-stream',
      content: new Uint8Array(await aRes.arrayBuffer()),
      parentId: sessionFolder,
    })

    // 4. Confirmacion EXPLICITA: marcar respaldo solo tras upload exitoso del audio.
    await supabase
      .from('transcripciones')
      .update({ archivado_en: new Date().toISOString(), drive_folder_id: sessionFolder })
      .eq('id', transcripcionId)

    return { ok: true, folderId: sessionFolder }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Respaldo de audio falló.' }
  }
}

/**
 * Sube SOLO el audio de UNA fuente de una sesion MULTIFUENTE a Drive y confirma
 * el exito de forma explicita. El archivo se nombra con un sufijo de fuente
 * (`orden` + nombre original) para no colisionar con otras fuentes de la misma
 * sesion, y va a la MISMA carpeta de sesion que el respaldo single. Marca
 * `transcripcion_fuentes.archivado_en` SOLO si el upload del audio funciono — la
 * salvaguarda en modo manual lee esa marca POR FUENTE. NO es best-effort.
 */
export async function respaldarFuenteEnDrive(
  supabase: SupabaseClient,
  params: { fuenteId: string; userId: string },
): Promise<{ ok: boolean; error?: string; folderId?: string }> {
  const { fuenteId, userId } = params

  const accessToken = await getValidAccessToken(userId)
  if (!accessToken) return { ok: false, error: 'Drive no conectado para este usuario.' }

  // Columnas explicitas (regla no_select_star_tablas_secrets: NO callback_secret).
  const { data: fuente, error: fErr } = await supabase
    .from('transcripcion_fuentes')
    .select('id, transcripcion_id, audio_path, nombre_archivo, orden, tipo')
    .eq('id', fuenteId)
    .single()
  if (fErr || !fuente) return { ok: false, error: 'Fuente no encontrada.' }

  const fuentePath = (fuente.audio_path as string | null) ?? ''
  if (!fuentePath || PATHS_NO_REALES.has(fuentePath)) {
    return { ok: false, error: 'La fuente no tiene audio real en R2.' }
  }

  const { data: padre, error: pErr } = await supabase
    .from('transcripciones')
    .select('id, titulo, proyecto_id')
    .eq('id', fuente.transcripcion_id as string)
    .single()
  if (pErr || !padre) return { ok: false, error: 'Sesión padre no encontrada.' }

  try {
    // 1. Bajar el audio de la fuente de R2.
    const storage = getStorageAdapter()
    const signed = await storage.getSignedDownloadUrl(fuentePath, { expiresInSec: 900 })
    const aRes = await fetch(signed)
    if (!aRes.ok) {
      return { ok: false, error: `No se pudo leer el audio de la fuente en R2 (HTTP ${aRes.status}).` }
    }

    // 2. Misma estructura de carpetas que la sesion single.
    const sessionFolder = await resolverCarpetaSesion(supabase, accessToken, {
      titulo: padre.titulo as string,
      proyectoId: (padre.proyecto_id as string | null) ?? null,
    })

    // 3. Nombre con sufijo de fuente: `orden` (unico por sesion) garantiza no
    //    colisionar; el nombre original lo hace reconocible.
    const ext = extDePath(fuentePath)
    const orden = typeof fuente.orden === 'number' ? fuente.orden : 0
    const nombreOriginal = tituloParaArchivo((fuente.nombre_archivo as string) ?? '')
      .replace(/\.[a-z0-9]{1,8}$/i, '')
      .trim()
    const etiqueta = nombreOriginal
      ? `${CONTENIDO_LABEL.audio} ${orden + 1} (${nombreOriginal})`
      : `${CONTENIDO_LABEL.audio} ${orden + 1}`
    const audioName = nombreArchivo(padre.titulo as string, etiqueta, ext)
    await uploadFile(accessToken, {
      name: audioName,
      mimeType: aRes.headers.get('content-type') ?? 'application/octet-stream',
      content: new Uint8Array(await aRes.arrayBuffer()),
      parentId: sessionFolder,
    })

    // 4. Confirmacion EXPLICITA POR FUENTE: marca archivado_en solo tras upload ok.
    await supabase
      .from('transcripcion_fuentes')
      .update({ archivado_en: new Date().toISOString() })
      .eq('id', fuenteId)

    return { ok: true, folderId: sessionFolder }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Respaldo de audio de la fuente falló.' }
  }
}
