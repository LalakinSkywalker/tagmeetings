'use server'

// =============================================================================
// Server actions — Multi-fuente
// =============================================================================
// Flujo:
//   1. createTranscripcionMultifuenteDraft(input) → crea el padre (es_multifuente)
//      + N filas en transcripcion_fuentes + N signed upload URLs (R2).
//   2. El cliente sube cada archivo (PUT directo a R2).
//   3. iniciarTranscripcionMultifuente(id):
//        - audio/video → lanza Deepgram async con callback ?fuente=<id>
//        - pdf/doc/texto → descarga de R2 + extrae texto server-side
//        - intenta combinar (cubre el caso "solo documentos": combina ya).
//   4. Cada callback de audio persiste su fuente y dispara el combine cuando
//      TODAS terminaron (barrera en pipeline.intentarCombinarFuentes).
//
// Seguridad: RLS por user_id en transcripcion_fuentes; el padre se inserta con
// el user autenticado. Secrets de callback por-fuente (no se confunden).
// =============================================================================

import { revalidatePath } from 'next/cache'
import { createClient as createUserSupabaseClient } from '@/lib/supabase/server'
import { getStorageAdapter } from '@/lib/transcription'
import { intentarCombinarFuentes } from '@/lib/transcription/pipeline'
import { lanzarFuenteDeepgram } from '@/lib/transcription/relanzar'
import {
  extraerTextoDocumento,
  tipoDocumentoDesde,
} from '@/lib/transcription/extract-text'
import {
  type ModoAnalisis,
  normalizarModoAnalisis,
} from '@/lib/transcription/modo-analisis'
import { resolveUserSettings } from '@/lib/settings'

const MAX_FUENTES = 10
const MAX_BYTES_TOTAL = 2_147_483_648 // 2 GB sumando todas las fuentes
const MAX_BYTES_FUENTE = 2_147_483_648

export type FuenteTipo = 'audio' | 'video' | 'pdf' | 'doc' | 'texto'

export interface FuenteInput {
  nombre: string
  mime: string
  sizeBytes: number
}

export interface CrearMultifuenteInput {
  titulo: string
  templateId: string
  idioma: string
  participantesEsperados?: string[]
  numSpeakersEsperados?: number
  /** Modo de análisis para el análisis combinado. */
  modoAnalisis?: ModoAnalisis
  /** Intención de traducción: undefined=default usuario, null=no traducir, código=idioma. */
  traducirA?: string | null
  fuentes: FuenteInput[]
}

export interface CrearMultifuenteResult {
  transcripcionId: string
  fuentes: Array<{ fuenteId: string; orden: number; signedUrl: string; tipo: FuenteTipo }>
}

function limpiarTexto(raw: string, max: number): string {
  return Array.from(raw)
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      return c >= 32 && c !== 127
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Tipo de fuente desde mime/nombre: documento (pdf/doc/texto), video o audio. */
function tipoFuente(mime: string, nombre: string): FuenteTipo {
  const doc = tipoDocumentoDesde(mime, nombre)
  if (doc) return doc
  if ((mime || '').toLowerCase().startsWith('video/')) return 'video'
  return 'audio'
}

function extDe(nombre: string, tipo: FuenteTipo): string {
  const dot = nombre.lastIndexOf('.')
  if (dot > 0 && dot < nombre.length - 1) {
    const ext = nombre
      .slice(dot + 1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8)
    if (ext) return ext
  }
  return tipo === 'pdf' ? 'pdf' : tipo === 'doc' ? 'docx' : tipo === 'texto' ? 'txt' : 'bin'
}

export async function createTranscripcionMultifuenteDraft(
  input: CrearMultifuenteInput,
): Promise<CrearMultifuenteResult> {
  if (!input || !Array.isArray(input.fuentes) || input.fuentes.length === 0) {
    throw new Error('Se requiere al menos una fuente.')
  }
  if (input.fuentes.length > MAX_FUENTES) {
    throw new Error(`Máximo ${MAX_FUENTES} fuentes por análisis.`)
  }
  const totalBytes = input.fuentes.reduce((sum, f) => sum + (Number(f.sizeBytes) || 0), 0)
  if (totalBytes > MAX_BYTES_TOTAL) {
    throw new Error('El total de archivos supera el límite de 2 GB.')
  }
  for (const f of input.fuentes) {
    if ((Number(f.sizeBytes) || 0) > MAX_BYTES_FUENTE) {
      throw new Error(`El archivo "${f.nombre}" supera el límite de 2 GB.`)
    }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('No autenticado.')

  // Defaults del usuario: cada campo cae al default si no hay override.
  const settings = await resolveUserSettings(supabase, user.id)

  const titulo = limpiarTexto(input.titulo, 120) || 'Análisis multi-fuente'
  const idioma =
    typeof input.idioma === 'string' && input.idioma.trim().length > 0
      ? input.idioma.trim().slice(0, 20)
      : settings.idiomaDefault
  const traducirAEfectivo =
    input.traducirA !== undefined ? input.traducirA : settings.traducirA
  const modoEfectivo = normalizarModoAnalisis(input.modoAnalisis ?? settings.modoAnalisisDefault)
  const templateEfectivo = input.templateId || settings.templateIdDefault || input.templateId

  const rosterLimpio = Array.isArray(input.participantesEsperados)
    ? input.participantesEsperados
        .map((n) => (typeof n === 'string' ? limpiarTexto(n, 60) : ''))
        .filter((n) => n.length > 0)
        .slice(0, 50)
    : []
  const numEsperado =
    Number.isFinite(input.numSpeakersEsperados) && (input.numSpeakersEsperados as number) > 0
      ? Math.min(Math.floor(input.numSpeakersEsperados as number), 50)
      : null

  // ---- Padre combinado.
  const { data: padre, error: padreErr } = await supabase
    .from('transcripciones')
    .insert({
      user_id: user.id,
      titulo,
      template_id: templateEfectivo,
      estado: 'pendiente',
      idioma,
      traducir_a: traducirAEfectivo,
      es_multifuente: true,
      audio_path: 'multifuente',
      transcription_provider: 'multifuente',
      participantes_esperados: rosterLimpio.length > 0 ? rosterLimpio : null,
      num_speakers_esperados: numEsperado,
      modo_analisis: modoEfectivo,
    })
    .select('id')
    .single()
  if (padreErr || !padre) {
    throw new Error(`createMultifuenteDraft: insert padre fallo: ${padreErr?.message ?? 'sin data'}`)
  }
  const transcripcionId = padre.id as string

  // ---- Fuentes + signed upload URLs.
  const storage = getStorageAdapter()
  const fuentes: CrearMultifuenteResult['fuentes'] = []
  for (let i = 0; i < input.fuentes.length; i++) {
    const f = input.fuentes[i]!
    const tipo = tipoFuente(f.mime, f.nombre)
    const nombre = limpiarTexto(f.nombre, 200) || `Fuente ${i + 1}`

    const { data: fuenteRow, error: fuenteErr } = await supabase
      .from('transcripcion_fuentes')
      .insert({
        transcripcion_id: transcripcionId,
        user_id: user.id,
        orden: i,
        tipo,
        nombre_archivo: nombre,
        mime: f.mime,
        size_bytes: Math.floor(Number(f.sizeBytes) || 0),
        estado: 'pendiente',
        audio_path: 'placeholder',
      })
      .select('id')
      .single()
    if (fuenteErr || !fuenteRow) {
      throw new Error(`createMultifuenteDraft: insert fuente fallo: ${fuenteErr?.message ?? 'sin data'}`)
    }
    const fuenteId = fuenteRow.id as string
    const path = `${user.id}/${transcripcionId}/${fuenteId}.${extDe(nombre, tipo)}`
    await supabase.from('transcripcion_fuentes').update({ audio_path: path }).eq('id', fuenteId)

    const { url: signedUrl } = await storage.getSignedUploadUrl(path, { expiresInSec: 1800 })
    fuentes.push({ fuenteId, orden: i, signedUrl, tipo })
  }

  revalidatePath('/dashboard')
  return { transcripcionId, fuentes }
}

export interface IniciarMultifuenteResult {
  ok: boolean
  estado: string
  errorMessage?: string
}

export async function iniciarTranscripcionMultifuente(
  transcripcionId: string,
): Promise<IniciarMultifuenteResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    throw new Error('transcripcionId inválido.')
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('No autenticado.')

  const { data: padre, error: padreErr } = await supabase
    .from('transcripciones')
    .select('id, estado, idioma, es_multifuente')
    .eq('id', transcripcionId)
    .single()
  if (padreErr || !padre) throw new Error('Transcripción no encontrada o sin permisos.')
  if (!padre.es_multifuente) throw new Error('No es una transcripción multi-fuente.')
  if (padre.estado === 'completado') return { ok: true, estado: 'completado' }
  if (padre.estado === 'transcribiendo' || padre.estado === 'analizando' || padre.estado === 'indexando') {
    return { ok: true, estado: 'transcribiendo' }
  }

  const { data: fuentes, error: fuentesErr } = await supabase
    .from('transcripcion_fuentes')
    .select('id, orden, tipo, nombre_archivo, audio_path, mime')
    .eq('transcripcion_id', transcripcionId)
    .order('orden', { ascending: true })
  if (fuentesErr || !fuentes || fuentes.length === 0) {
    throw new Error('No hay fuentes para procesar.')
  }

  await supabase.from('transcripciones').update({ estado: 'transcribiendo' }).eq('id', transcripcionId)
  revalidatePath('/dashboard')

  const storage = getStorageAdapter()
  const idioma = (padre.idioma as string) ?? 'es-MX'

  for (const f of fuentes) {
    const fuenteId = f.id as string
    const tipo = f.tipo as FuenteTipo
    const nombre = (f.nombre_archivo as string) ?? 'Fuente'
    const audioPath = f.audio_path as string

    try {
      if (tipo === 'audio' || tipo === 'video') {
        // Primer lanzamiento de la fuente. Helper compartido (DRY) con el
        // watchdog y el reintento manual — una sola fuente de verdad.
        await lanzarFuenteDeepgram(supabase, { transcripcionId, fuenteId, audioPath, idioma })
      } else {
        // Documento: descargar de R2 + extraer texto server-side.
        const downloadUrl = await storage.getSignedDownloadUrl(audioPath, { expiresInSec: 600 })
        const resp = await fetch(downloadUrl)
        if (!resp.ok) throw new Error(`descarga R2 fallo: HTTP ${resp.status}`)
        const bytes = await resp.arrayBuffer()
        const ext = await extraerTextoDocumento(bytes, tipo, nombre)
        if (ext.error || ext.texto.length === 0) {
          await supabase
            .from('transcripcion_fuentes')
            .update({ estado: 'error', error_message: (ext.error ?? 'sin texto').slice(0, 500) })
            .eq('id', fuenteId)
        } else {
          await supabase
            .from('transcripcion_fuentes')
            .update({ estado: 'transcrito', texto_extraido: ext.texto, raw_text: ext.texto })
            .eq('id', fuenteId)
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await supabase
        .from('transcripcion_fuentes')
        .update({ estado: 'error', error_message: message.slice(0, 500), callback_secret: null })
        .eq('id', fuenteId)
    }
  }

  // Barrera: si no hubo audio (solo documentos) ya están todas listas → combina.
  // Si hay audio pendiente, los callbacks dispararán el combine al terminar.
  await intentarCombinarFuentes(supabase, transcripcionId)

  revalidatePath('/dashboard')
  return { ok: true, estado: 'transcribiendo' }
}
