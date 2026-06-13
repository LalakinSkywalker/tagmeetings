'use server'

// =============================================================================
// Server actions — TagTranscriptor Fase 2 + Fase 3 + Fase 7 (PRP-TT-001 + PRP-TT-002)
// =============================================================================
// Flujo end-to-end:
//   1. UI llama createTranscripcionDraft(titulo, templateId, audioMeta)
//      → inserta fila pendiente + signed upload URL.
//   2. UI sube el archivo via supabase.storage.uploadToSignedUrl(...).
//   3. UI llama iniciarTranscripcion(transcripcionId)
//      → ASYNC (PRP-TT-002): si provider soporta callback (Deepgram), dispara
//        fire-and-forget y devuelve estado='transcribiendo' al instante.
//        El resto del pipeline lo completa /api/webhooks/deepgram cuando
//        Deepgram POSTea de vuelta.
//      → SYNC (Mock/legacy): comportamiento original — espera Deepgram +
//        analiza + indexa en la misma llamada.
//   4. UI polea getEstadoTranscripcion(id) cada N segundos para reflejar
//      progreso (modo async).
//
// NOTA Next.js 16: maxDuration para server actions DEBE ir en la page que las
// invoca, no aqui. Ver src/app/(dashboard)/dashboard/grabar/page.tsx.
//
// Seguridad: NUNCA exponer service_role ni OPENROUTER_API_KEY al cliente.
// =============================================================================

import { revalidatePath } from 'next/cache'
import { randomUUID } from 'node:crypto'
import { createClient as createUserSupabaseClient } from '@/lib/supabase/server'
import {
  deleteStorageObjects,
  getAnalysisEngine,
  getRagIndex,
  getStorageAdapter,
  getTranscriptionProvider,
  resolveTemplateAsync,
  TEMPLATES_AVAILABLE,
} from '@/lib/transcription'
import { maybeTraducir } from '@/lib/transcription/idioma'
import { buildDeepgramCallbackUrl } from '@/lib/transcription/callback-url'
import { resolveUserSettings } from '@/lib/settings'
import {
  type ModoAnalisis,
  MODO_ANALISIS_DEFAULT,
  normalizarModoAnalisis,
  modoToReasoningEffort,
  modoToModel,
} from '@/lib/transcription/modo-analisis'
import {
  construirContextoProyecto,
  type ContextoProyectoScope,
} from '@/lib/transcription/contexto-proyecto'
import type { AsyncTranscriptionProvider } from '@bluntag/transcription-core'

export interface CreateTranscripcionDraftInput {
  titulo: string
  templateId: string
  audioFilename: string
  audioMime: string
  audioSizeBytes: number
  /**
   * Idioma solicitado para la transcripcion (PRP-TT-V2 Fase 2):
   * - 'es-MX' (default) → fuerza espanol (mejor precision en audios en espanol).
   * - 'auto' → el motor detecta el idioma; si no es espanol, se traduce.
   * - codigo soportado ('en','pt','fr',...) → fuerza ese idioma + traduce a espanol.
   */
  idioma?: string
  /**
   * Pre-registro ligero de participantes (PRP-TT-V2 Fase 2): nombres esperados
   * ingresados ANTES de grabar. NO es biometria — solo para asignar nombres
   * rapido al terminar + alerta de discrepancia. Opcional.
   */
  participantesEsperados?: string[]
  /** Numero de hablantes esperado (para alerta de discrepancia). Opcional. */
  numSpeakersEsperados?: number
  /**
   * Modo de analisis para esta sesion (PRP-TT-V2 Fase 5B-C, Eje 1):
   * 'rapido' (default) o 'profundo'. Se persiste y lo lee el pipeline del
   * primer analisis. Override por sesion del default (Fase 7 lo hara global).
   */
  modoAnalisis?: ModoAnalisis
  /**
   * Intencion de traduccion para esta sesion (Fase 7). Override por sesion:
   *   - `undefined` → usar el default del usuario (user_settings.traducir_a).
   *   - `null`      → no traducir (analizar en el idioma original).
   *   - codigo      → traducir a ese idioma (ej 'es-MX', 'en').
   */
  traducirA?: string | null
}

export interface CreateTranscripcionDraftResult {
  transcripcionId: string
  /** URL firmada para PUT directo del archivo a R2 (auth en query string). */
  signedUrl: string
  audioPath: string
}

export interface IniciarTranscripcionResult {
  ok: boolean
  estado: 'completado' | 'error' | 'transcribiendo'
  errorMessage?: string
  segmentsCount?: number
  durationMs?: number
  /** Set cuando el analisis tambien corrio en el mismo flujo (Fase 3). */
  analizado?: boolean
  /**
   * 'async' = se lanzo via callback Deepgram; UI debe polear getEstadoTranscripcion.
   * 'sync'  = se proceso end-to-end en esta llamada (Mock provider o legacy).
   */
  modo?: 'async' | 'sync'
}

/** Estado en vivo para polling de UI (PRP-TT-002). */
export interface EstadoTranscripcionResult {
  ok: boolean
  estado:
    | 'pendiente'
    | 'transcribiendo'
    | 'analizando'
    | 'indexando'
    | 'completado'
    | 'error'
  /** Solo set si estado='error'. */
  errorMessage?: string
  /** Solo set si estado='completado'. */
  durationMs?: number
  /** Solo set si estado='completado'. */
  categoria?: string
  /** Última actividad (ISO). La UI lo usa para detectar "lleva demasiado tiempo
   *  sin avanzar" y ofrecer reintento (Fase 10). */
  updatedAt?: string
}

export interface AnalizarTranscripcionResult {
  ok: boolean
  estado: 'completado' | 'error'
  errorMessage?: string
  categoria?: string
  costUsd?: number
  indexado?: boolean
}

export interface IndexarTranscripcionResult {
  ok: boolean
  chunks?: number
  costUsd?: number
  errorMessage?: string
}

export interface AskCitationDTO {
  text: string
  start_ms: number
  end_ms: number
  speaker_id: number | null
}

export interface AskTranscripcionResult {
  ok: boolean
  askId?: string
  answer?: string
  citations?: AskCitationDTO[]
  costUsd?: number
  modelUsed?: string
  errorMessage?: string
}

export interface AskQueryListItem {
  id: string
  question: string
  answer: string
  citations: AskCitationDTO[]
  model_used: string | null
  cost_usd: number | null
  created_at: string
}

export interface TranscripcionListItem {
  id: string
  titulo: string
  template_id: string
  estado: string
  duracion_ms: number | null
  idioma: string | null
  categoria: string | null
  created_at: string
  completed_at: string | null
  error_message: string | null
}

export interface TranscripcionesListFilters {
  /** Filtro por categoria exacta. null/undefined = todas. */
  categoria?: string | null
  /** Filtro por template_id exacto. null/undefined = todas. */
  templateId?: string | null
  /** Fecha minima (ISO YYYY-MM-DD). Filtra created_at >= desde 00:00. */
  desde?: string | null
  /** Fecha maxima (ISO YYYY-MM-DD). Filtra created_at <= hasta 23:59:59.999. */
  hasta?: string | null
  /** Texto libre para full-text search sobre titulo+raw_text. */
  searchText?: string | null
  /**
   * Si true, solo devuelve sesiones SUELTAS (proyecto_id IS NULL). La Biblioteca
   * lo usa para mantenerse limpia: las sesiones asignadas a un proyecto viven en
   * ese proyecto, no en el listado general (PRP-TT — Hueco C, biblioteca limpia).
   */
  soloSueltas?: boolean
  /** Pagina 1-based. Default 1. */
  page?: number
  /** Tamano de pagina. Default 20. Max 100. */
  pageSize?: number
}

export interface TranscripcionesListResult {
  items: TranscripcionListItem[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

const VALID_EXTENSIONS = [
  'mp3',
  'mp4',
  'm4a',
  'wav',
  'webm',
  'ogg',
  'flac',
  'aac',
  'mov',
  'mkv',
] as const

function extractExtension(filename: string, mime: string): string {
  const dotIdx = filename.lastIndexOf('.')
  if (dotIdx > 0 && dotIdx < filename.length - 1) {
    const ext = filename.slice(dotIdx + 1).toLowerCase()
    if (VALID_EXTENSIONS.includes(ext as typeof VALID_EXTENSIONS[number])) {
      return ext
    }
  }
  // Fallback por MIME
  if (mime.includes('mp3') || mime.includes('mpeg')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('flac')) return 'flac'
  return 'bin'
}

function isValidTemplateId(id: string): boolean {
  return TEMPLATES_AVAILABLE.some((t) => t.id === id)
}

/**
 * Crea el registro inicial de una transcripcion en estado 'pendiente'
 * y genera la signed upload URL para que el cliente suba el audio directo
 * a Supabase Storage sin pasar por el server (bypassea el 4.5 MB body limit
 * de Vercel).
 */
export async function createTranscripcionDraft(
  input: CreateTranscripcionDraftInput,
): Promise<CreateTranscripcionDraftResult> {
  // ---- Validacion de input
  const titulo = input.titulo?.trim()
  if (!titulo || titulo.length > 200) {
    throw new Error('Titulo invalido (vacio o > 200 caracteres).')
  }
  if (!isValidTemplateId(input.templateId)) {
    throw new Error(`Plantilla desconocida: ${input.templateId}`)
  }
  if (!input.audioFilename || !input.audioMime) {
    throw new Error('audioFilename y audioMime son obligatorios.')
  }
  if (
    !Number.isFinite(input.audioSizeBytes) ||
    input.audioSizeBytes <= 0 ||
    input.audioSizeBytes > 2_147_483_648
  ) {
    throw new Error('audioSizeBytes invalido (0 < size <= 2 GB).')
  }

  // ---- Auth check
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    throw new Error('No autenticado.')
  }

  // ---- Defaults del usuario (Fase 7). Cada campo cae al default configurado
  //      si la sesion no trae override, asi la config REALMENTE influye.
  const settings = await resolveUserSettings(supabase, user.id)

  // ---- Insert registro inicial (usuario autenticado, RLS aplica)
  const ext = extractExtension(input.audioFilename, input.audioMime)
  // Idioma solicitado: override de sesion o default del usuario. Se acepta
  // cualquier string corto; el provider lo mapea (idioma no soportado cae a 'multi').
  const idiomaSolicitado =
    typeof input.idioma === 'string' && input.idioma.trim().length > 0
      ? input.idioma.trim().slice(0, 20)
      : settings.idiomaDefault
  // Intencion de traduccion: override de sesion (incluido null = no traducir) o default.
  const traducirAEfectivo =
    input.traducirA !== undefined ? input.traducirA : settings.traducirA
  // Modo de analisis: override de sesion o default del usuario.
  const modoEfectivo = normalizarModoAnalisis(input.modoAnalisis ?? settings.modoAnalisisDefault)
  // Plantilla: override de sesion o default del usuario (la UI ya envia una).
  const templateEfectivo = input.templateId || settings.templateIdDefault || input.templateId

  // Roster ligero de participantes (sanitizado: nombres no vacios, cap 60, max 50).
  const rosterLimpio = Array.isArray(input.participantesEsperados)
    ? input.participantesEsperados
        .map((n) =>
          typeof n === 'string'
            ? Array.from(n)
                .filter((ch) => {
                  const code = ch.charCodeAt(0)
                  return code >= 32 && code !== 127
                })
                .join('')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 60)
            : '',
        )
        .filter((n) => n.length > 0)
        .slice(0, 50)
    : []

  const numEsperado =
    Number.isFinite(input.numSpeakersEsperados) &&
    (input.numSpeakersEsperados as number) > 0
      ? Math.min(Math.floor(input.numSpeakersEsperados as number), 50)
      : null

  const { data: inserted, error: insertError } = await supabase
    .from('transcripciones')
    .insert({
      user_id: user.id,
      titulo,
      template_id: templateEfectivo,
      estado: 'pendiente',
      idioma: idiomaSolicitado,
      traducir_a: traducirAEfectivo,
      participantes_esperados: rosterLimpio.length > 0 ? rosterLimpio : null,
      num_speakers_esperados: numEsperado,
      modo_analisis: modoEfectivo,
      audio_path: 'placeholder',  // se reemplaza abajo
      audio_size_bytes: input.audioSizeBytes,
      audio_mime: input.audioMime,
      transcription_provider: 'deepgram-nova-3',
    })
    .select('id')
    .single()

  if (insertError || !inserted) {
    throw new Error(
      `createTranscripcionDraft: insert fallo: ${insertError?.message ?? 'sin data'}`,
    )
  }

  const transcripcionId = inserted.id as string
  const audioPath = `${user.id}/${transcripcionId}/audio.${ext}`

  // ---- Update con path final
  const { error: updateError } = await supabase
    .from('transcripciones')
    .update({ audio_path: audioPath })
    .eq('id', transcripcionId)

  if (updateError) {
    throw new Error(
      `createTranscripcionDraft: update audio_path fallo: ${updateError.message}`,
    )
  }

  // ---- Signed upload URL R2 (presigned PUT, server-side via adapter).
  //      La auth viaja en la query string; el cliente hace PUT directo a signedUrl.
  const storage = getStorageAdapter()
  const { url: signedUrl } = await storage.getSignedUploadUrl(audioPath, {
    expiresInSec: 1800,
  })

  revalidatePath('/dashboard')
  return {
    transcripcionId,
    signedUrl,
    audioPath,
  }
}

/**
 * Orquesta la transcripcion. PRP-TT-002: si el provider soporta modo async via
 * callback (Deepgram), dispara fire-and-forget y devuelve inmediatamente. El
 * resto del pipeline (analisis + indexado) lo completa /api/webhooks/deepgram
 * cuando Deepgram POSTea el resultado.
 *
 * Si el provider no soporta async (Mock, legacy), cae al modo sync original:
 * await Deepgram + analizar + indexar en la misma llamada.
 *
 * Idempotente — si ya esta en 'completado' o en proceso, no reintenta.
 */
export async function iniciarTranscripcion(
  transcripcionId: string,
): Promise<IniciarTranscripcionResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    throw new Error('transcripcionId invalido.')
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    throw new Error('No autenticado.')
  }

  // ---- Verificar ownership + estado actual (RLS filtra por user_id)
  const { data: transcripcion, error: fetchError } = await supabase
    .from('transcripciones')
    .select('id, estado, audio_path, idioma, traducir_a')
    .eq('id', transcripcionId)
    .single()

  if (fetchError || !transcripcion) {
    throw new Error('Transcripcion no encontrada o sin permisos.')
  }
  if (transcripcion.estado === 'completado') {
    return { ok: true, estado: 'completado' }
  }
  if (
    transcripcion.estado === 'transcribiendo' ||
    transcripcion.estado === 'analizando' ||
    transcripcion.estado === 'indexando'
  ) {
    return {
      ok: true,
      estado: 'transcribiendo',
      modo: 'async',
      errorMessage: `Ya en proceso (estado: ${transcripcion.estado}). Reanudando polling.`,
    }
  }

  // ---- Detectar modo async (provider soporta callback)
  const provider = getTranscriptionProvider() as AsyncTranscriptionProvider
  const supportsAsync = typeof provider.transcribeAsync === 'function'

  // ============================================================
  // MODO ASYNC (Deepgram con callback)
  // ============================================================
  if (supportsAsync) {
    try {
      const secret = randomUUID()
      const callbackUrl = await buildDeepgramCallbackUrl(transcripcionId, secret)

      // ---- Marcar 'transcribiendo' + persistir callback_secret ANTES de
      //      lanzar Deepgram. Si Deepgram responde rapidisimo y el callback
      //      llega antes que el UPDATE, la BD aun no tendria el secret.
      const { error: secretUpdateError } = await supabase
        .from('transcripciones')
        .update({
          estado: 'transcribiendo',
          callback_secret: secret,
        })
        .eq('id', transcripcionId)
      if (secretUpdateError) {
        throw new Error(
          `persistir callback_secret fallo: ${secretUpdateError.message}`,
        )
      }

      revalidatePath('/dashboard')

      const storage = getStorageAdapter()
      // TTL 6h: audios largos (5-6h) Deepgram puede tardar +/- el largo del
      // audio en procesar. Le damos margen amplio para descargar el archivo
      // antes que la URL firmada caduque.
      const audioUrl = await storage.getSignedDownloadUrl(
        transcripcion.audio_path,
        { expiresInSec: 21_600 },
      )

      const ack = await provider.transcribeAsync(audioUrl, {
        language: transcripcion.idioma ?? 'es-MX',
        diarize: true,
        punctuate: true,
        callbackUrl,
      })
      console.info(
        `[iniciarTranscripcion ASYNC] launched ${transcripcionId} request_id=${ack.request_id}`,
      )

      return {
        ok: true,
        estado: 'transcribiendo',
        modo: 'async',
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Limpiar callback_secret + marcar error si el launch fallo.
      await supabase
        .from('transcripciones')
        .update({
          estado: 'error',
          error_message: message.slice(0, 1000),
          callback_secret: null,
        })
        .eq('id', transcripcionId)
      revalidatePath('/dashboard')
      return {
        ok: false,
        estado: 'error',
        errorMessage: message,
      }
    }
  }

  // ============================================================
  // MODO SYNC (Mock / providers legacy sin transcribeAsync)
  // ============================================================
  await supabase
    .from('transcripciones')
    .update({ estado: 'transcribiendo' })
    .eq('id', transcripcionId)

  revalidatePath('/dashboard')

  try {
    const storage = getStorageAdapter()
    const audioUrl = await storage.getSignedDownloadUrl(transcripcion.audio_path, {
      expiresInSec: 3600,
    })

    const result = await provider.transcribe(audioUrl, {
      language: transcripcion.idioma ?? 'es-MX',
      diarize: true,
      punctuate: true,
    })

    // Traduccion segun la intencion de la sesion (Fase 7). En modo Mock siempre
    // es es-MX → no-op. Best-effort, no tumba el flujo.
    const trad = await maybeTraducir(
      result,
      (transcripcion as { traducir_a?: string | null }).traducir_a ?? null,
    )

    const { error: persistError } = await supabase
      .from('transcripciones')
      .update({
        estado: 'analizando',
        raw_text: result.raw_text,
        segments: result.segments,
        duracion_ms: result.duration_ms,
        idioma_detectado: result.detected_language ?? null,
        traducido_a: trad.traducido ? trad.traducidoA : null,
        raw_text_traducido: trad.traducido ? trad.rawTextTraducido : null,
        segments_traducido: trad.traducido ? trad.segmentsTraducido : null,
        transcription_provider: result.provider,
      })
      .eq('id', transcripcionId)

    if (persistError) {
      throw new Error(`persistencia BD fallo: ${persistError.message}`)
    }

    revalidatePath('/dashboard')

    const analysis = await analizarTranscripcion(transcripcionId)

    return {
      ok: analysis.ok,
      estado: analysis.estado,
      errorMessage: analysis.errorMessage,
      segmentsCount: result.segments.length,
      durationMs: result.duration_ms,
      analizado: analysis.ok,
      modo: 'sync',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('transcripciones')
      .update({
        estado: 'error',
        error_message: message.slice(0, 1000),
      })
      .eq('id', transcripcionId)

    revalidatePath('/dashboard')
    return {
      ok: false,
      estado: 'error',
      errorMessage: message,
    }
  }
}

/**
 * Lee el estado actual de una transcripcion en BD. Diseñado para polling
 * desde UI durante el flujo async — la UI invoca esto cada 5-10s y reacciona
 * a las transiciones (transcribiendo → analizando → indexando → completado).
 *
 * Devuelve solo columnas no-sensibles (sin raw_text ni segments ni callback_secret).
 */
export async function getEstadoTranscripcion(
  transcripcionId: string,
): Promise<EstadoTranscripcionResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    return { ok: false, estado: 'error', errorMessage: 'transcripcionId invalido.' }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, estado: 'error', errorMessage: 'No autenticado.' }
  }

  const { data, error } = await supabase
    .from('transcripciones')
    .select('estado, error_message, duracion_ms, categoria, updated_at')
    .eq('id', transcripcionId)
    .single()

  if (error || !data) {
    return {
      ok: false,
      estado: 'error',
      errorMessage: 'Transcripcion no encontrada o sin permisos.',
    }
  }

  return {
    ok: true,
    estado: data.estado as EstadoTranscripcionResult['estado'],
    errorMessage: data.error_message ?? undefined,
    durationMs: data.duracion_ms ?? undefined,
    categoria: data.categoria ?? undefined,
    updatedAt: (data.updated_at as string | null) ?? undefined,
  }
}

/**
 * Analiza una transcripcion ya transcrita (raw_text + segments persistidos) con
 * el LLMAnalysisEngine + la plantilla declarada. Idempotente: si ya esta en
 * 'completado' con analisis no-null, no reintenta.
 *
 * Llamable directamente desde UI (boton "Reanalizar") o encadenado desde
 * iniciarTranscripcion al terminar Deepgram.
 */
export async function analizarTranscripcion(
  transcripcionId: string,
  opts?: {
    /**
     * Fuerza re-análisis aunque ya esté completado. Re-genera el `analisis`
     * inyectando los nombres reales de hablantes actuales (Idea 2) y/o con una
     * plantilla distinta — SIN re-transcribir ni re-indexar (PRP-TT-V2 Fase 5).
     */
    forzar?: boolean
    /** Cambiar la plantilla de análisis al re-analizar. Default: la actual. */
    nuevoTemplateId?: string
    /**
     * Modo de análisis para ESTE re-análisis (PRP-TT-V2 Fase 5B-C, Eje 1):
     * 'rapido' (reasoning bajo) o 'profundo' (reasoning alto). Si se pasa, se
     * persiste como el modo de la sesión. Default: el modo persistido de la sesión.
     */
    modo?: ModoAnalisis
    /**
     * Alcance del contexto del proyecto a inyectar (PRP-TT-V2 Fase 5B-C, Eje 2):
     * 'ninguno' (default), 'memoria' (síntesis del histórico) o 'detallado'
     * (memoria + resúmenes de últimas sesiones). Solo aplica si la sesión
     * pertenece a un proyecto. Da continuidad al análisis con la relación completa.
     */
    contextoProyecto?: ContextoProyectoScope
  },
): Promise<AnalizarTranscripcionResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    throw new Error('transcripcionId invalido.')
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    throw new Error('No autenticado.')
  }

  // ---- Recuperar transcripcion completa (RLS filtra por user_id)
  const { data: transcripcion, error: fetchError } = await supabase
    .from('transcripciones')
    .select(
      'id, estado, raw_text, segments, raw_text_traducido, segments_traducido, idioma_detectado, traducido_a, duracion_ms, idioma, template_id, analisis, cost_usd_total, modo_analisis, proyecto_id',
    )
    .eq('id', transcripcionId)
    .single()

  if (fetchError || !transcripcion) {
    throw new Error('Transcripcion no encontrada o sin permisos.')
  }

  if (!transcripcion.raw_text || !Array.isArray(transcripcion.segments)) {
    return {
      ok: false,
      estado: 'error',
      errorMessage: 'No hay transcripcion procesada todavia (raw_text vacio).',
    }
  }

  if (
    !opts?.forzar &&
    transcripcion.estado === 'completado' &&
    transcripcion.analisis !== null &&
    transcripcion.analisis !== undefined
  ) {
    return {
      ok: true,
      estado: 'completado',
      categoria: undefined,
      costUsd: undefined,
    }
  }

  // Plantilla a usar: la nueva si se pidió cambiarla, si no la actual.
  const templateIdEfectivo =
    typeof opts?.nuevoTemplateId === 'string' && opts.nuevoTemplateId.trim().length > 0
      ? opts.nuevoTemplateId.trim()
      : (transcripcion.template_id as string)

  // Modo de análisis efectivo (Eje 1): el pedido en este re-análisis, si no el
  // persistido de la sesión, si no el default. Determina el reasoning_effort.
  const modoEfectivo: ModoAnalisis = opts?.modo
    ? normalizarModoAnalisis(opts.modo)
    : normalizarModoAnalisis(transcripcion.modo_analisis)

  // ---- Marcar 'analizando' si aun no lo esta
  if (transcripcion.estado !== 'analizando') {
    await supabase
      .from('transcripciones')
      .update({ estado: 'analizando' })
      .eq('id', transcripcionId)
    revalidatePath('/dashboard')
  }

  try {
    const plantilla = await resolveTemplateAsync(
      supabase,
      templateIdEfectivo,
      user.id,
    )
    if (!plantilla) {
      throw new Error(
        `Plantilla desconocida: "${templateIdEfectivo}". Predefinidas validas: ${TEMPLATES_AVAILABLE.map((t) => t.id).join(', ')} (o una plantilla custom del usuario).`,
      )
    }

    const engine = getAnalysisEngine()

    type SegArr = Array<{
      speaker: { id: number; label?: string }
      text: string
      start_ms: number
      end_ms: number
      confidence: number
    }>

    // Preferir la version traducida al espanol cuando existe (PRP-TT-V2 Fase 2):
    // asi el resumen sale siempre en espanol aunque el audio fuera en otro idioma.
    const hayTraduccion =
      typeof transcripcion.raw_text_traducido === 'string' &&
      transcripcion.raw_text_traducido.length > 0 &&
      Array.isArray(transcripcion.segments_traducido)

    const segments = (
      hayTraduccion ? transcripcion.segments_traducido : transcripcion.segments
    ) as SegArr
    const rawTextAnalisis = hayTraduccion
      ? (transcripcion.raw_text_traducido as string)
      : transcripcion.raw_text
    const langAnalisis = hayTraduccion
      ? (transcripcion.traducido_a ?? 'es-MX')
      : (transcripcion.idioma ?? 'es-MX')

    // Contexto global del proyecto (Eje 2): solo si la sesión pertenece a un
    // proyecto y se pidió un alcance != 'ninguno'. Usa resúmenes (no transcripciones
    // completas) para respetar el límite de tokens.
    let contextoGlobal: string | undefined
    const proyectoIdSesion = transcripcion.proyecto_id as string | null
    if (opts?.contextoProyecto && opts.contextoProyecto !== 'ninguno' && proyectoIdSesion) {
      try {
        const ctx = await construirContextoProyecto(supabase, {
          proyectoId: proyectoIdSesion,
          excluirTranscripcionId: transcripcionId,
          scope: opts.contextoProyecto,
        })
        contextoGlobal = ctx.contexto ?? undefined
      } catch (ctxErr) {
        // Best-effort: si falla construir el contexto, re-analizamos sin él
        // (no rompemos el re-análisis por un problema del histórico).
        const msg = ctxErr instanceof Error ? ctxErr.message : String(ctxErr)
        console.error(`[analizarTranscripcion] contexto de proyecto fallo: ${msg}`)
      }
    }

    const analisis = await engine.analyze(
      {
        segments,
        language: langAnalisis,
        duration_ms: transcripcion.duracion_ms ?? 0,
        raw_text: rawTextAnalisis,
        provider: 'deepgram-nova-3',
      },
      plantilla,
      {
        speakerTokens: true,
        reasoningEffort: modoToReasoningEffort(modoEfectivo),
        model: modoToModel(modoEfectivo),
        contextoGlobal,
      },
    )

    const newCostTotal =
      (Number(transcripcion.cost_usd_total) || 0) + (analisis.cost_usd || 0)

    const { error: persistError } = await supabase
      .from('transcripciones')
      .update({
        estado: 'completado',
        analisis,
        categoria: analisis.categoria,
        template_id: templateIdEfectivo,
        modo_analisis: modoEfectivo,
        cost_usd_total: newCostTotal,
        completed_at: new Date().toISOString(),
      })
      .eq('id', transcripcionId)

    if (persistError) {
      throw new Error(`persistencia BD fallo: ${persistError.message}`)
    }

    revalidatePath('/dashboard')
    revalidatePath(`/dashboard/transcripcion/${transcripcionId}`)

    // ---- Indexar para Ask. Best-effort — si falla, la transcripcion sigue
    //      completada (analisis ya persistido). En un RE-ANÁLISIS forzado el
    //      texto de los segments NO cambió (solo el prompt del análisis con
    //      nombres/plantilla), así que los embeddings son idénticos: omitimos
    //      el re-indexado para no gastar de más (los nombres se inyectan al Ask
    //      en runtime, no viven en los embeddings).
    let indexado = false
    if (!opts?.forzar) {
      try {
        const indexResult = await indexarTranscripcion(transcripcionId)
        indexado = indexResult.ok
      } catch (indexErr) {
        const msg = indexErr instanceof Error ? indexErr.message : String(indexErr)
        console.error(`[analizarTranscripcion] index post-analyze fallo silenciosamente: ${msg}`)
      }
    }

    return {
      ok: true,
      estado: 'completado',
      categoria: analisis.categoria,
      costUsd: analisis.cost_usd,
      indexado,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('transcripciones')
      .update({
        estado: 'error',
        error_message: message.slice(0, 1000),
      })
      .eq('id', transcripcionId)

    revalidatePath('/dashboard')
    revalidatePath(`/dashboard/transcripcion/${transcripcionId}`)

    return {
      ok: false,
      estado: 'error',
      errorMessage: message,
    }
  }
}

/**
 * Lista las transcripciones del usuario autenticado, ordenadas mas reciente
 * primero. Soporta paginacion, filtros (categoria, plantilla, rango fechas) y
 * busqueda full-text sobre titulo+raw_text (columna generada `search_vector`
 * con config spanish, indice GIN).
 *
 * Columnas explicitas (regla del workspace: NO SELECT *).
 *
 * @returns paginado: items + total + page + pageSize + pageCount.
 */
/**
 * Valida que un string sea una fecha de calendario REAL en formato YYYY-MM-DD,
 * no solo que matchee el patron. El regex `\d{4}-\d{2}-\d{2}` acepta basura
 * semantica como `9999-99-99` o `2026-02-31` que, al construir un timestamp y
 * pasarla a Postgres (.gte/.lte), revienta la query y produce un 500.
 * Aqui rechazamos meses/dias imposibles verificando que el Date construido en
 * UTC conserve exactamente los componentes parseados.
 */
function esFechaCalendarioValida(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  )
}

// Vista estructural minima del query builder de PostgREST para aplicar los
// filtros del listado sin arrastrar los generics profundos de SupabaseClient
// v2 (que explotan en "type instantiation excessively deep" si se anotan). El
// helper se reutiliza en la query de count y en la de data — una sola fuente
// de verdad para la cadena de filtros.
interface QueryListadoFiltrable {
  eq(column: string, value: string): QueryListadoFiltrable
  is(column: string, value: null): QueryListadoFiltrable
  gte(column: string, value: string): QueryListadoFiltrable
  lte(column: string, value: string): QueryListadoFiltrable
  textSearch(
    column: string,
    query: string,
    options: { type: 'plain'; config: string },
  ): QueryListadoFiltrable
}

function aplicarFiltrosListado(
  query: QueryListadoFiltrable,
  filters: TranscripcionesListFilters,
): QueryListadoFiltrable {
  let q = query
  if (filters.soloSueltas) {
    q = q.is('proyecto_id', null)
  }
  if (filters.categoria && filters.categoria.trim().length > 0) {
    q = q.eq('categoria', filters.categoria.trim())
  }
  if (filters.templateId && filters.templateId.trim().length > 0) {
    q = q.eq('template_id', filters.templateId.trim())
  }
  if (filters.desde && esFechaCalendarioValida(filters.desde)) {
    q = q.gte('created_at', `${filters.desde}T00:00:00.000Z`)
  }
  if (filters.hasta && esFechaCalendarioValida(filters.hasta)) {
    q = q.lte('created_at', `${filters.hasta}T23:59:59.999Z`)
  }
  if (filters.searchText && filters.searchText.trim().length > 0) {
    // PostgREST .textSearch usa to_tsquery — type 'plain' mapea a
    // plainto_tsquery (tokeniza palabras separadas con AND, ignora sintaxis
    // especial). Config 'spanish' = stemming + stop words espanol.
    q = q.textSearch('search_vector', filters.searchText.trim(), {
      type: 'plain',
      config: 'spanish',
    })
  }
  return q
}

export async function listTranscripcionesDelUser(
  filters: TranscripcionesListFilters = {},
): Promise<TranscripcionesListResult> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { items: [], total: 0, page: 1, pageSize: 20, pageCount: 0 }
  }

  // ---- Normalizar paginacion
  const pageRaw = filters.page ?? 1
  const pageSizeRaw = filters.pageSize ?? 20
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1
      ? Math.min(Math.floor(pageSizeRaw), 100)
      : 20
  const pagePedida =
    Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1

  // ---- Paso 1: count primero (head, barato). Permite clampar la pagina al
  // rango real ANTES de pedir el range. Sin esto, un ?page=999 con pocos
  // registros genera un offset que excede el total y PostgREST responde 416
  // (Range Not Satisfiable) -> throw -> 500 en el server component.
  const countBase = supabase
    .from('transcripciones')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
  const { count, error: countError } = await (aplicarFiltrosListado(
    countBase as unknown as QueryListadoFiltrable,
    filters,
  ) as unknown as PromiseLike<{
    count: number | null
    error: { message: string } | null
  }>)

  if (countError) {
    throw new Error(`listTranscripcionesDelUser (count) fallo: ${countError.message}`)
  }

  const total = count ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(pagePedida, pageCount) // clamp a la ultima pagina real
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  // ---- Paso 2: data con el range ya seguro
  const dataBase = supabase
    .from('transcripciones')
    .select(
      'id, titulo, template_id, estado, duracion_ms, idioma, categoria, created_at, completed_at, error_message',
    )
    .eq('user_id', user.id)
  const dataFiltrada = aplicarFiltrosListado(
    dataBase as unknown as QueryListadoFiltrable,
    filters,
  ) as unknown as {
    order(
      column: string,
      options: { ascending: boolean },
    ): {
      range(
        from: number,
        to: number,
      ): PromiseLike<{
        data: unknown[] | null
        error: { message: string } | null
      }>
    }
  }
  const { data, error } = await dataFiltrada
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) {
    throw new Error(`listTranscripcionesDelUser fallo: ${error.message}`)
  }

  return {
    items: (data ?? []) as TranscripcionListItem[],
    total,
    page,
    pageSize,
    pageCount,
  }
}

/**
 * Devuelve las categorias distintas que el user tiene actualmente en sus
 * transcripciones. Util para popular el selector de filtro por categoria sin
 * mostrar opciones vacias. Solo categorias != null.
 */
export async function getCategoriasDelUser(): Promise<string[]> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from('transcripciones')
    .select('categoria')
    .eq('user_id', user.id)
    .not('categoria', 'is', null)
    .limit(500)

  if (error) {
    throw new Error(`getCategoriasDelUser fallo: ${error.message}`)
  }

  const set = new Set<string>()
  for (const row of data ?? []) {
    const c = (row as { categoria: string | null }).categoria
    if (typeof c === 'string' && c.trim().length > 0) {
      set.add(c.trim())
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'))
}

/**
 * Devuelve la transcripcion completa con segments y raw_text para vista detalle.
 * (Aun NO se renderiza pagina detalle en Fase 2 — preparada para Fase 3.)
 */
export async function getTranscripcionConSegments(
  transcripcionId: string,
): Promise<{
  id: string
  titulo: string
  template_id: string
  estado: string
  raw_text: string | null
  segments: unknown
  duracion_ms: number | null
  created_at: string
  completed_at: string | null
} | null> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data, error } = await supabase
    .from('transcripciones')
    .select(
      'id, titulo, template_id, estado, raw_text, segments, duracion_ms, created_at, completed_at',
    )
    .eq('id', transcripcionId)
    .single()

  if (error || !data) return null
  return data
}

// =============================================================================
// FASE 5 — RAG indexing + Ask TagTranscriptor
// =============================================================================

/**
 * Indexa los segments de una transcripcion completa en transcripcion_chunks via
 * embeddings text-embedding-3-small. Es la condicion previa para que el tab
 * "Ask TagTranscriptor" funcione.
 *
 * Idempotente: borra chunks previos y reinserta. Suma el costo del embedding
 * a cost_usd_total de la transcripcion. Estado va 'analizando'/'completado' ->
 * 'indexando' -> 'completado'.
 *
 * Si falla, la transcripcion vuelve a 'completado' (analisis sigue intacto) y
 * el error se loguea para reintentos manuales.
 */
export async function indexarTranscripcion(
  transcripcionId: string,
): Promise<IndexarTranscripcionResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    throw new Error('transcripcionId invalido.')
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    throw new Error('No autenticado.')
  }

  // ---- Recuperar segments + cost previo + estado (RLS filtra por user_id)
  const { data: transcripcion, error: fetchError } = await supabase
    .from('transcripciones')
    .select('id, estado, segments, segments_traducido, cost_usd_total')
    .eq('id', transcripcionId)
    .single()

  if (fetchError || !transcripcion) {
    throw new Error('Transcripcion no encontrada o sin permisos.')
  }

  // Indexar la version en espanol cuando existe, para que el Ask responda en
  // espanol (PRP-TT-V2 Fase 2). Si no, indexar el original.
  const segmentsAIndexar =
    Array.isArray(transcripcion.segments_traducido) &&
    transcripcion.segments_traducido.length > 0
      ? transcripcion.segments_traducido
      : transcripcion.segments

  if (!Array.isArray(segmentsAIndexar) || segmentsAIndexar.length === 0) {
    return {
      ok: false,
      errorMessage: 'No hay segments para indexar (raw_text vacio o transcripcion no completada).',
    }
  }

  const estadoPrevio = transcripcion.estado as string

  // ---- Marcar 'indexando' transitorio
  await supabase
    .from('transcripciones')
    .update({ estado: 'indexando' })
    .eq('id', transcripcionId)

  revalidatePath(`/dashboard/transcripcion/${transcripcionId}`)

  try {
    const ragIndex = getRagIndex(supabase)

    const segments = segmentsAIndexar as Array<{
      speaker: { id: number; label?: string }
      text: string
      start_ms: number
      end_ms: number
      confidence: number
    }>

    const result = await ragIndex.index(transcripcionId, segments, {
      ownerUserId: user.id,
    })

    const newCostTotal =
      (Number(transcripcion.cost_usd_total) || 0) + (result.cost_usd || 0)

    const { error: persistError } = await supabase
      .from('transcripciones')
      .update({
        estado: 'completado',
        cost_usd_total: newCostTotal,
      })
      .eq('id', transcripcionId)

    if (persistError) {
      throw new Error(`persistencia cost fallo: ${persistError.message}`)
    }

    revalidatePath('/dashboard')
    revalidatePath(`/dashboard/transcripcion/${transcripcionId}`)

    return {
      ok: true,
      chunks: result.chunks_inserted,
      costUsd: result.cost_usd,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Revertir a estado previo (NO marcar como 'error' — el analisis sigue valido)
    await supabase
      .from('transcripciones')
      .update({
        estado: estadoPrevio === 'indexando' ? 'completado' : estadoPrevio,
      })
      .eq('id', transcripcionId)

    revalidatePath('/dashboard')
    revalidatePath(`/dashboard/transcripcion/${transcripcionId}`)

    return {
      ok: false,
      errorMessage: message,
    }
  }
}

/**
 * Responde una pregunta sobre la transcripcion via RAG. Embebe la pregunta,
 * busca top-K=8 chunks por similaridad coseno (RPC `search_chunks` filtra por
 * `auth.uid()` interno), y llama al LLM con los chunks para responder con citas.
 *
 * Persiste el Q&A en `ask_queries` para mantener historial.
 */
export async function askTranscripcion(
  transcripcionId: string,
  question: string,
): Promise<AskTranscripcionResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    return { ok: false, errorMessage: 'transcripcionId invalido.' }
  }
  const cleanQuestion = (question ?? '').trim()
  if (cleanQuestion.length === 0) {
    return { ok: false, errorMessage: 'La pregunta esta vacia.' }
  }
  if (cleanQuestion.length > 2000) {
    return {
      ok: false,
      errorMessage: 'La pregunta es demasiado larga (max 2000 caracteres).',
    }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, errorMessage: 'No autenticado.' }
  }

  // ---- Verificar ownership de la transcripcion antes de embedar la pregunta
  //      (ahorra costo si el id no es del user — RLS lo bloquearia mas tarde
  //      pero gastariamos en el embedding).
  const { data: transcripcion, error: fetchError } = await supabase
    .from('transcripciones')
    .select('id, estado, speaker_names')
    .eq('id', transcripcionId)
    .single()
  if (fetchError || !transcripcion) {
    return { ok: false, errorMessage: 'Transcripcion no encontrada o sin permisos.' }
  }

  // Diccionario de nombres reales (PRP-TT-003): se inyecta en runtime al prompt
  // del RAG para que el LLM entienda preguntas por nombre. NO re-indexa nada.
  const speakerNames =
    transcripcion.speaker_names && typeof transcripcion.speaker_names === 'object'
      ? (transcripcion.speaker_names as Record<string, string>)
      : undefined

  try {
    const ragIndex = getRagIndex(supabase)
    const result = await ragIndex.ask(transcripcionId, cleanQuestion, speakerNames)

    const citationsDTO: AskCitationDTO[] = result.citations.map((c) => ({
      text: c.text,
      start_ms: c.start_ms,
      end_ms: c.end_ms,
      speaker_id: c.speaker?.id ?? null,
    }))

    // ---- Persistir el Ask en BD (RLS auth.uid()=user_id)
    const { data: inserted, error: insertError } = await supabase
      .from('ask_queries')
      .insert({
        transcripcion_id: transcripcionId,
        user_id: user.id,
        question: cleanQuestion,
        answer: result.answer,
        citations: citationsDTO,
        model_used: result.model_used,
        cost_usd: result.cost_usd,
      })
      .select('id')
      .single()

    if (insertError || !inserted) {
      throw new Error(
        `askTranscripcion: insert ask_queries fallo: ${insertError?.message ?? 'sin data'}`,
      )
    }

    // ---- Sumar el costo del Ask a cost_usd_total
    const { data: transcripcionRefresh } = await supabase
      .from('transcripciones')
      .select('cost_usd_total')
      .eq('id', transcripcionId)
      .single()

    const prevTotal = Number(transcripcionRefresh?.cost_usd_total ?? 0) || 0
    await supabase
      .from('transcripciones')
      .update({ cost_usd_total: prevTotal + (result.cost_usd || 0) })
      .eq('id', transcripcionId)

    revalidatePath(`/dashboard/transcripcion/${transcripcionId}`)

    return {
      ok: true,
      askId: inserted.id as string,
      answer: result.answer,
      citations: citationsDTO,
      costUsd: result.cost_usd,
      modelUsed: result.model_used,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, errorMessage: message }
  }
}

/**
 * Lista las Q&A historicas de una transcripcion para popular el chat history.
 * Orden cronologico ascendente (la mas antigua arriba) para UX tipo chat.
 */
export async function listAsksDelTranscripcion(
  transcripcionId: string,
): Promise<AskQueryListItem[]> {
  if (!transcripcionId || transcripcionId.length < 10) return []

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from('ask_queries')
    .select('id, question, answer, citations, model_used, cost_usd, created_at')
    .eq('transcripcion_id', transcripcionId)
    .order('created_at', { ascending: true })
    .limit(200)

  if (error) {
    throw new Error(`listAsksDelTranscripcion fallo: ${error.message}`)
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    question: row.question as string,
    answer: row.answer as string,
    citations: Array.isArray(row.citations) ? (row.citations as AskCitationDTO[]) : [],
    model_used: (row.model_used as string | null) ?? null,
    cost_usd: row.cost_usd === null ? null : Number(row.cost_usd),
    created_at: row.created_at as string,
  }))
}

/**
 * Checa si una transcripcion tiene chunks indexados (>0). Usado por la UI para
 * decidir si mostrar el tab Ask como disponible o como "indexar primero".
 */
export async function transcripcionEstaIndexada(
  transcripcionId: string,
): Promise<boolean> {
  if (!transcripcionId || transcripcionId.length < 10) return false

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return false

  const { count, error } = await supabase
    .from('transcripcion_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('transcripcion_id', transcripcionId)

  if (error) return false
  return (count ?? 0) > 0
}

// =============================================================================
// PRP-TT-003 — Edicion de speakers (nombres reales de hablantes)
// =============================================================================

export interface GuardarNombresSpeakersResult {
  ok: boolean
  /** Diccionario ya sanitizado tal como quedo persistido. */
  speakerNames?: Record<string, string>
  errorMessage?: string
}

/** Cap de longitud de un nombre de hablante (defensa anti-inyeccion de prompt). */
const SPEAKER_NAME_MAX_LEN = 60
/** Cap de hablantes nombrables por transcripcion (defensa payload abusivo). */
const SPEAKER_NAMES_MAX_KEYS = 50

/**
 * Sanitiza un nombre de hablante antes de persistirlo y antes de que llegue al
 * prompt del LLM del Ask. Quita saltos de linea / caracteres de control (para
 * que un nombre no pueda "hacerse pasar" por una instruccion del sistema) y
 * colapsa espacios. Devuelve '' si tras limpiar queda vacio.
 */
function sanitizeSpeakerName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001F\u007F]+/g, ' ') // control chars + saltos de linea + tabs
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SPEAKER_NAME_MAX_LEN)
}

/**
 * Guarda el diccionario de nombres reales de hablantes de una transcripcion.
 * - Auth + ownership (RLS de transcripciones filtra por user_id; ademas validamos
 *   que la fila exista para el usuario antes del UPDATE).
 * - Sanitiza cada nombre (cap de longitud + strip control chars / saltos de linea).
 * - Las claves no numericas se descartan; un nombre vacio borra la clave (revierte
 *   ese hablante a "Speaker N").
 * - NO reprocesa audio ni re-indexa embeddings (PRP-TT-003): el diccionario se
 *   inyecta en runtime al render y al prompt del Ask.
 */
export async function guardarNombresSpeakers(
  transcripcionId: string,
  nombres: Record<string, string>,
): Promise<GuardarNombresSpeakersResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    return { ok: false, errorMessage: 'transcripcionId invalido.' }
  }
  if (nombres === null || typeof nombres !== 'object' || Array.isArray(nombres)) {
    return { ok: false, errorMessage: 'Formato de nombres invalido.' }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, errorMessage: 'No autenticado.' }
  }

  // ---- Ownership: la fila debe existir para este usuario (RLS por user_id).
  const { data: transcripcion, error: fetchError } = await supabase
    .from('transcripciones')
    .select('id')
    .eq('id', transcripcionId)
    .single()
  if (fetchError || !transcripcion) {
    return { ok: false, errorMessage: 'Transcripcion no encontrada o sin permisos.' }
  }

  // ---- Construir diccionario limpio: clave = entero no-negativo; valor sanitizado.
  //      Nombre vacio => se omite la clave (revierte ese hablante a "Speaker N").
  const limpio: Record<string, string> = {}
  for (const [rawKey, rawVal] of Object.entries(nombres)) {
    if (!/^\d+$/.test(rawKey)) continue
    const nombre = sanitizeSpeakerName(rawVal)
    if (nombre.length === 0) continue
    limpio[rawKey] = nombre
    if (Object.keys(limpio).length >= SPEAKER_NAMES_MAX_KEYS) break
  }

  const { error: updateError } = await supabase
    .from('transcripciones')
    .update({ speaker_names: limpio })
    .eq('id', transcripcionId)

  if (updateError) {
    return {
      ok: false,
      errorMessage: `No se pudieron guardar los nombres: ${updateError.message}`,
    }
  }

  revalidatePath(`/dashboard/transcripcion/${transcripcionId}`)
  revalidatePath('/dashboard')

  return { ok: true, speakerNames: limpio }
}

// =============================================================================
// Renombrar transcripcion (PRP-TT-V2 Fase 1, quick win)
// =============================================================================

export interface RenombrarResult {
  ok: boolean
  titulo?: string
  errorMessage?: string
}

const TITULO_MAX = 120

/**
 * Renombra el titulo de una transcripcion ya creada.
 * Auth + ownership (RLS por user_id). Sanitiza con charCodeAt (SIN regex de
 * control chars — evita el bug feedback_regex_control_chars_unicode_escape):
 * descarta chars de control (< 32 y DEL 127), colapsa espacios, cap a TITULO_MAX.
 */
export async function renombrarTranscripcion(
  transcripcionId: string,
  nuevoTitulo: string,
): Promise<RenombrarResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    return { ok: false, errorMessage: 'transcripcionId invalido.' }
  }

  const limpio = Array.from(nuevoTitulo ?? '')
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITULO_MAX)

  if (limpio.length === 0) {
    return { ok: false, errorMessage: 'El nombre no puede estar vacio.' }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, errorMessage: 'No autenticado.' }
  }

  const { data: transcripcion, error: fetchError } = await supabase
    .from('transcripciones')
    .select('id')
    .eq('id', transcripcionId)
    .single()
  if (fetchError || !transcripcion) {
    return { ok: false, errorMessage: 'Transcripcion no encontrada o sin permisos.' }
  }

  const { error: updateError } = await supabase
    .from('transcripciones')
    .update({ titulo: limpio })
    .eq('id', transcripcionId)

  if (updateError) {
    return { ok: false, errorMessage: `No se pudo renombrar: ${updateError.message}` }
  }

  revalidatePath(`/dashboard/transcripcion/${transcripcionId}`)
  revalidatePath('/dashboard')

  return { ok: true, titulo: limpio }
}

// =============================================================================
// Eliminar sesiones (PRP-TT — Hueco A: borrado 1x1 + bulk selectivo)
// =============================================================================
// ALCANCE DEL BORRADO (decidido con Eduardo 2026-06-02):
//   - Se borra la fila `transcripciones`. La BD cascada en automatico:
//       · transcripcion_chunks (embeddings RAG) → ON DELETE CASCADE
//       · transcripcion_fuentes (fuentes multi-fuente)  → ON DELETE CASCADE
//       · ask_queries (historial de preguntas)          → ON DELETE CASCADE
//   - `pendientes.transcripcion_id` es ON DELETE SET NULL: los pendientes que la
//     sesion aporto al tablero del proyecto SE CONSERVAN (quedan "sin sesion de
//     origen"). Decision de producto: un compromiso no deja de existir porque se
//     borre la grabacion.
//   - El audio fisico en R2 (audio_path de la sesion + de cada fuente) NO lo
//     cubre la cascada de BD → se borra best-effort con deleteStorageObjects.
//   - El respaldo en Google Drive (si la sesion estaba archivada) NO se toca.
// Operacion destructiva: la UI SIEMPRE confirma antes de invocar estas actions.
// =============================================================================

export interface BorrarTranscripcionResult {
  ok: boolean
  error?: string
}

export interface BorrarTranscripcionesBulkResult {
  ok: boolean
  borradas: number
  error?: string
}

/**
 * Recolecta los audio_path en R2 asociados a un conjunto de sesiones del usuario:
 * el audio principal de cada sesion + el audio de cada fuente multi-fuente. Debe
 * llamarse ANTES del DELETE (la cascada elimina las filas de fuentes, pero no los
 * objetos en R2). Filtra por user_id como defensa en profundidad.
 */
async function recolectarAudioPaths(
  supabase: Awaited<ReturnType<typeof createUserSupabaseClient>>,
  userId: string,
  transcripcionIds: string[],
  audioPathsSesion: Array<string | null>,
): Promise<Array<string | null>> {
  const paths: Array<string | null> = [...audioPathsSesion]
  const { data: fuentes } = await supabase
    .from('transcripcion_fuentes')
    .select('audio_path')
    .in('transcripcion_id', transcripcionIds)
    .eq('user_id', userId)
  for (const f of fuentes ?? []) {
    paths.push((f as { audio_path: string | null }).audio_path)
  }
  return paths
}

/**
 * Elimina UNA sesion del usuario. Auth + ownership (RLS + filtro explicito por
 * user_id). Recolecta los audios antes de borrar, borra la fila (la cascada
 * limpia chunks/fuentes/asks; los pendientes quedan sin sesion de origen), y
 * limpia los audios de R2 best-effort. Destructivo: la UI confirma antes.
 */
export async function borrarTranscripcion(
  transcripcionId: string,
): Promise<BorrarTranscripcionResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    return { ok: false, error: 'Sesion invalida.' }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  // ---- Ownership + datos necesarios antes de borrar.
  const { data: transcripcion, error: fetchError } = await supabase
    .from('transcripciones')
    .select('id, audio_path, proyecto_id')
    .eq('id', transcripcionId)
    .eq('user_id', user.id)
    .single()
  if (fetchError || !transcripcion) {
    return { ok: false, error: 'Sesion no encontrada o sin permisos.' }
  }

  const audioPaths = await recolectarAudioPaths(
    supabase,
    user.id,
    [transcripcionId],
    [transcripcion.audio_path as string | null],
  )

  // ---- Borrar la fila (CASCADE en BD hace el resto; pendientes → SET NULL).
  const { error: deleteError } = await supabase
    .from('transcripciones')
    .delete()
    .eq('id', transcripcionId)
    .eq('user_id', user.id)
  if (deleteError) {
    return { ok: false, error: `No se pudo eliminar: ${deleteError.message}` }
  }

  // ---- Limpieza de R2 best-effort (la sesion ya se borro de BD).
  try {
    await deleteStorageObjects(audioPaths)
  } catch (err) {
    console.error(
      `[borrarTranscripcion] limpieza R2 fallo (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  revalidatePath('/dashboard')
  revalidatePath('/dashboard/proyectos')
  const proyectoId = transcripcion.proyecto_id as string | null
  if (proyectoId) revalidatePath(`/dashboard/proyectos/${proyectoId}`)
  return { ok: true }
}

/** Cap defensivo de cuantas sesiones se pueden borrar de un jalon. */
const BULK_DELETE_MAX = 200

/**
 * Elimina VARIAS sesiones del usuario en una operacion (bulk selectivo de la
 * Biblioteca). Mismo alcance y reglas que borrarTranscripcion. Solo borra las
 * que realmente son del usuario (ownership efectivo). Destructivo: la UI confirma
 * y muestra el conteo antes.
 */
export async function borrarTranscripcionesBulk(
  ids: string[],
): Promise<BorrarTranscripcionesBulkResult> {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, borradas: 0, error: 'No hay sesiones seleccionadas.' }
  }
  const idsLimpios = Array.from(
    new Set(ids.filter((id) => typeof id === 'string' && id.length >= 10)),
  ).slice(0, BULK_DELETE_MAX)
  if (idsLimpios.length === 0) {
    return { ok: false, borradas: 0, error: 'Seleccion invalida.' }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, borradas: 0, error: 'No autenticado.' }

  // ---- Ownership efectivo: solo las del usuario (RLS + filtro explicito).
  const { data: propias } = await supabase
    .from('transcripciones')
    .select('id, audio_path, proyecto_id')
    .in('id', idsLimpios)
    .eq('user_id', user.id)

  const idsPropios = (propias ?? []).map((t) => t.id as string)
  if (idsPropios.length === 0) {
    return { ok: false, borradas: 0, error: 'Las sesiones no existen o no son tuyas.' }
  }

  const audioPaths = await recolectarAudioPaths(
    supabase,
    user.id,
    idsPropios,
    (propias ?? []).map((t) => (t as { audio_path: string | null }).audio_path),
  )

  const proyectosAfectados = new Set<string>()
  for (const t of propias ?? []) {
    const pid = (t as { proyecto_id: string | null }).proyecto_id
    if (pid) proyectosAfectados.add(pid)
  }

  // ---- Borrar (CASCADE en BD; pendientes → SET NULL).
  const { error: deleteError } = await supabase
    .from('transcripciones')
    .delete()
    .in('id', idsPropios)
    .eq('user_id', user.id)
  if (deleteError) {
    return { ok: false, borradas: 0, error: `No se pudieron eliminar: ${deleteError.message}` }
  }

  // ---- Limpieza de R2 best-effort.
  try {
    await deleteStorageObjects(audioPaths)
  } catch (err) {
    console.error(
      `[borrarTranscripcionesBulk] limpieza R2 fallo (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  revalidatePath('/dashboard')
  revalidatePath('/dashboard/proyectos')
  for (const pid of proyectosAfectados) revalidatePath(`/dashboard/proyectos/${pid}`)
  return { ok: true, borradas: idsPropios.length }
}
