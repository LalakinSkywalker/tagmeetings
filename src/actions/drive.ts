'use server'

// =============================================================================
// Server actions — Google Drive
// =============================================================================
// Estado de conexion (con correo) + desconectar + archivar una sesion en Drive
// bajo TagMeetings/{proyecto|Sesiones sueltas}/{sesion}, eligiendo QUE se
// guarda y en QUE formato. Scope minimo drive.file; tokens cifrados (store.ts);
// upload server-side (no toca el CSP del navegador).
//
// Seguridad: auth + RLS. El estado NUNCA lee las columnas *_encrypted (regla:
// no SELECT * en tablas con tokens). Los tokens solo se descifran server-side
// para la llamada a Google.
// =============================================================================

import { createClient } from '@/lib/supabase/server'
import { deleteConnection, getValidAccessToken } from '@/lib/drive/store'
import { ensureFolder, uploadFile } from '@/lib/drive/client'
import { buildExportData } from '@/lib/export/export-data'
import { generateDocServer } from '@/lib/export/server-generate'
import { resolveBrandingForPdf } from '@/lib/export/branding'
import { getStorageAdapter, resolveTemplateAsync } from '@/lib/transcription'
import {
  tituloParaArchivo,
  CONTENIDO_LABEL,
  nombreArchivo,
  type ExportFormat,
} from '@/lib/export/format'

const SELECT =
  'id, titulo, template_id, raw_text, raw_text_traducido, segments, segments_traducido, analisis, categoria, duracion_ms, idioma, idioma_detectado, traducido_a, cost_usd_total, created_at, completed_at, speaker_names, modo_analisis, audio_path, proyecto_id'

/**
 * Qué guardar en Drive y en qué formato. El usuario decide en la hoja de
 * archivar (transparencia + control, igual que la descarga).
 */
export interface ArchivarSeleccion {
  analisis: { incluir: boolean; formato: ExportFormat }
  transcripcion: {
    incluir: boolean
    formato: ExportFormat
    incluirTimestamps: boolean
    incluirHablantes: boolean
  }
  audio: boolean
}

/** ¿El usuario tiene Drive conectado? Devuelve también el correo de la cuenta. */
export async function getDriveStatus(): Promise<{ connected: boolean; email: string | null }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { connected: false, email: null }
  const { data } = await supabase
    .from('drive_connections')
    .select('user_id, connected_email')
    .eq('user_id', user.id)
    .maybeSingle()
  return { connected: Boolean(data), email: (data?.connected_email as string | null) ?? null }
}

/** Desconecta Drive (borra los tokens). */
export async function disconnectDrive(): Promise<{ ok: boolean }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false }
  await deleteConnection(user.id)
  return { ok: true }
}

/**
 * Archiva una sesion en Drive segun la seleccion del usuario: crea (o reusa) la
 * estructura de carpetas y sube SOLO lo elegido, en el formato elegido. Marca
 * archivado_en + drive_folder_id. Idempotente: re-archivar reemplaza, no duplica
 * (uploadFile hace upsert por nombre). Devuelve la carpeta y los nombres subidos.
 */
export async function archivarEnDrive(
  transcripcionId: string,
  seleccion: ArchivarSeleccion,
): Promise<{ ok: boolean; error?: string; folderUrl?: string; archivos?: string[] }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const accessToken = await getValidAccessToken(user.id)
  if (!accessToken) {
    return { ok: false, error: 'Google Drive no está conectado. Conéctalo en Ajustes.' }
  }

  const { data, error } = await supabase.from('transcripciones').select(SELECT).eq('id', transcripcionId).single()
  if (error || !data) return { ok: false, error: 'Sesión no encontrada.' }

  // Nada seleccionado → no hay qué hacer.
  const quiereAnalisis = seleccion.analisis.incluir && Boolean(data.analisis)
  const quiereTranscripcion = seleccion.transcripcion.incluir
  const quiereAudio = seleccion.audio && Boolean(data.audio_path)
  if (!quiereAnalisis && !quiereTranscripcion && !quiereAudio) {
    return { ok: false, error: 'Elige al menos un archivo para guardar.' }
  }

  try {
    const plantilla = await resolveTemplateAsync(supabase, data.template_id, user.id)
    const exportData = buildExportData(data, plantilla?.name ?? data.template_id)
    // Marca del usuario: color + logo en el PDF archivado a Drive.
    const branding = await resolveBrandingForPdf(supabase, user.id)
    const archivos: string[] = []

    // TagMeetings / {proyecto | Sesiones sueltas} / {sesion}
    const baseFolder = await ensureFolder(accessToken, 'TagMeetings')
    let parentFolder = baseFolder
    if (data.proyecto_id) {
      const { data: proy } = await supabase
        .from('proyectos')
        .select('id, nombre, drive_folder_id')
        .eq('id', data.proyecto_id)
        .single()
      if (proy) {
        parentFolder = await ensureFolder(accessToken, proy.nombre ?? 'Proyecto', baseFolder)
        if (proy.drive_folder_id !== parentFolder) {
          await supabase.from('proyectos').update({ drive_folder_id: parentFolder }).eq('id', proy.id)
        }
      }
    } else {
      parentFolder = await ensureFolder(accessToken, 'Sesiones sueltas', baseFolder)
    }
    const sessionFolder = await ensureFolder(accessToken, tituloParaArchivo(data.titulo), parentFolder)

    // Análisis (en el formato elegido).
    if (quiereAnalisis) {
      const doc = await generateDocServer(exportData, 'analisis', seleccion.analisis.formato, {
        incluirTimestamps: true,
        incluirHablantes: true,
      }, branding)
      await uploadFile(accessToken, {
        name: doc.filename,
        mimeType: doc.contentType,
        content: doc.body,
        parentId: sessionFolder,
      })
      archivos.push(doc.filename)
    }

    // Transcripción (en el formato elegido, con sus toggles).
    if (quiereTranscripcion) {
      const doc = await generateDocServer(exportData, 'transcripcion', seleccion.transcripcion.formato, {
        incluirTimestamps: seleccion.transcripcion.incluirTimestamps,
        incluirHablantes: seleccion.transcripcion.incluirHablantes,
      }, branding)
      await uploadFile(accessToken, {
        name: doc.filename,
        mimeType: doc.contentType,
        content: doc.body,
        parentId: sessionFolder,
      })
      archivos.push(doc.filename)
    }

    // Audio original (best-effort: si falla, el resto ya quedó archivado).
    if (quiereAudio && data.audio_path) {
      try {
        const storage = getStorageAdapter()
        const signed = await storage.getSignedDownloadUrl(data.audio_path, { expiresInSec: 900 })
        const aRes = await fetch(signed)
        if (aRes.ok) {
          const ext =
            (data.audio_path.split('.').pop() ?? 'audio').toLowerCase().replace(/[^a-z0-9]/g, '') ||
            'audio'
          const audioName = nombreArchivo(data.titulo, CONTENIDO_LABEL.audio, ext)
          await uploadFile(accessToken, {
            name: audioName,
            mimeType: aRes.headers.get('content-type') ?? 'application/octet-stream',
            content: new Uint8Array(await aRes.arrayBuffer()),
            parentId: sessionFolder,
          })
          archivos.push(audioName)
        }
      } catch {
        // audio best-effort
      }
    }

    if (archivos.length === 0) {
      return { ok: false, error: 'No se pudo generar ningún archivo para guardar.' }
    }

    await supabase
      .from('transcripciones')
      .update({ archivado_en: new Date().toISOString(), drive_folder_id: sessionFolder })
      .eq('id', transcripcionId)

    return {
      ok: true,
      folderUrl: `https://drive.google.com/drive/folders/${sessionFolder}`,
      archivos,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'No se pudo archivar en Drive.',
    }
  }
}
