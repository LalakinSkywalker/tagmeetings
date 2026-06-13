// =============================================================================
// Webhook receiver — Deepgram callback async (PRP-TT-002 + Fase 4 multi-fuente).
// =============================================================================
// Endpoint publico (sin auth de usuario). Protegido por secret-per-request:
//   1. Al lanzar Deepgram async generamos un UUID v4 y lo persistimos:
//        - single-audio: en transcripciones.callback_secret
//        - multi-fuente: en transcripcion_fuentes.callback_secret (1 por fuente)
//   2. La callback URL incluye ?id=...&secret=...  (+ &fuente=<id> si multi-fuente)
//   3. Al POSTear Deepgram, validamos (id[, fuente], secret) contra BD.
//   4. Single-audio: claim + persist de la transcripcion, luego analisis+indexado.
//      Multi-fuente: persistimos la fuente, e intentamos combinar cuando TODAS
//      las fuentes del padre terminaron (barrera con compare-and-swap).
//   5. Anulamos el secret tras procesar para prevenir replay.
//
// ROBUSTEZ — fast-200 + background (Fase 10, 2026-06-04):
//   El trabajo PESADO (traducir + LLM + indexar, o combinar N fuentes) NO corre
//   antes de responderle a Deepgram. Hacemos un claim/persist LIVIANO y SINCRONO
//   (compare-and-swap que tambien dedupea retries), respondemos 200 al instante,
//   y el procesamiento pesado va en `after()` (corre tras enviar la respuesta,
//   dentro del presupuesto de la funcion). Antes, el analisis sincrono podia
//   tardar minutos: Deepgram no recibia el ACK a tiempo y reintentaba (hasta 10x);
//   un payload grande (audio largo, ~1.8h) podia ademas reventar el handler antes
//   de guardar, dejando la fuente HUERFANA en 'transcribiendo' para siempre. El
//   archivo grande del discovery de Daniel (2026-06-03) quedo colgado asi 42h.
//
// Retry policy Deepgram: 10 intentos / 30s si no-2xx. Orden de evaluacion:
//   a. Registro inexistente            -> 200 ACK (Deepgram no reintenta; ademas
//                                          la respuesta es identica para todo id,
//                                          asi no se pueden enumerar sesiones).
//   b. Sesion ya NO espera el callback -> 200 ACK idempotente. Cubre los retries
//      (estado mas alla de 'transcribiendo') que llegan TRAS el claim/procesamiento, cuando el
//                                          secret ya fue anulado.
//   c. Sesion AUN espera + secret malo -> 401 (bloquea inyeccion de un resultado
//                                          falso por quien adivine el id).
//   d. Sesion AUN espera + secret ok   -> claim sincrono; 200 inmediato; pesado en after().
// =============================================================================

import 'server-only'
import { NextResponse, after } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getTranscriptionProvider } from '@/lib/transcription'
import { analizarYCompletar, intentarCombinarFuentes } from '@/lib/transcription/pipeline'
import { normalizarModoAnalisis } from '@/lib/transcription/modo-analisis'
import type {
  AsyncTranscriptionProvider,
  TranscriptionResult,
} from '@bluntag/transcription-core'

export const maxDuration = 300
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface UrlParams {
  id: string
  secret: string
  fuente: string | null
}

function extractParams(url: URL): UrlParams | { error: string } {
  const id = url.searchParams.get('id')
  const secret = url.searchParams.get('secret')
  const fuente = url.searchParams.get('fuente')
  if (!id || id.length < 10) return { error: 'param `id` ausente o invalido' }
  if (!secret || secret.length < 16) {
    return { error: 'param `secret` ausente o invalido' }
  }
  return { id, secret, fuente: fuente && fuente.length >= 10 ? fuente : null }
}

function parsearBody(
  provider: AsyncTranscriptionProvider,
  body: unknown,
  idioma: string,
): TranscriptionResult {
  return provider.parseCallbackPayload!(body, idioma)
}

// -----------------------------------------------------------------------------
// SINGLE-AUDIO: callback de 1 transcripción (flujo PRP-TT-002).
// -----------------------------------------------------------------------------
async function handleSingle(
  supabase: ReturnType<typeof createServiceClient>,
  provider: AsyncTranscriptionProvider,
  id: string,
  secret: string,
  body: unknown,
): Promise<NextResponse> {
  const { data, error } = await supabase
    .from('transcripciones')
    .select('id, user_id, estado, idioma, template_id, callback_secret, modo_analisis, traducir_a')
    .eq('id', id)
    .single()

  // (a) Registro inexistente: ACK 200 (no 401) — Deepgram no debe reintentar
  // sobre un id que no existe, y la respuesta es identica para cualquier id, lo
  // que evita enumerar transcripciones.
  if (error || !data) {
    return NextResponse.json({ ok: true, skipped: 'unknown' }, { status: 200 })
  }

  // (b) Idempotencia ANTES de validar el secret. Si la sesion ya avanzo mas alla
  // de 'transcribiendo', este POST es un RETRY de Deepgram que llega DESPUES del
  // claim/procesamiento, cuando el secret ya fue anulado (anti-replay).
  if (data.estado !== 'pendiente' && data.estado !== 'transcribiendo') {
    return NextResponse.json({ ok: true, skipped: true }, { status: 200 })
  }

  // (c) Solo cuando la sesion AUN espera el callback exigimos secret valido: esto
  // bloquea que alguien que adivine el id inyecte un resultado de transcripcion
  // falso (proteccion real del webhook, intacta).
  if (data.callback_secret !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let transcription: TranscriptionResult
  try {
    transcription = parsearBody(provider, body, data.idioma ?? 'es-MX')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('transcripciones')
      .update({ estado: 'error', error_message: `parse callback fallo: ${message}`.slice(0, 1000), callback_secret: null })
      .eq('id', id)
    return NextResponse.json({ ok: false, message }, { status: 200 })
  }

  // Claim SINCRONO (compare-and-swap): pasa la fila a 'analizando', guarda la
  // transcripcion y anula el secret EN UN SOLO UPDATE condicionado a que siga
  // esperando. Solo un callback gana; los retries concurrentes ven 0 filas y
  // caen en idempotencia. Liviano: no bloquea el ACK.
  const persistInicial = {
    raw_text: transcription.raw_text,
    segments: transcription.segments,
    duracion_ms: transcription.duration_ms,
    idioma_detectado: transcription.detected_language ?? null,
    transcription_provider: transcription.provider,
    callback_secret: null as string | null,
  }
  const { data: claim, error: claimErr } = await supabase
    .from('transcripciones')
    .update({ estado: 'analizando', ...persistInicial })
    .eq('id', id)
    .in('estado', ['pendiente', 'transcribiendo'])
    .select('id')
  if (claimErr) {
    return NextResponse.json({ ok: false, error: claimErr.message }, { status: 500 })
  }
  if (!claim || claim.length === 0) {
    // Otro callback ya tomo el procesamiento (retry concurrente).
    return NextResponse.json({ ok: true, skipped: true }, { status: 200 })
  }

  // Trabajo PESADO en background: respondemos 200 a Deepgram al instante para que
  // NO reintente por timeout del ACK. La fila ya quedo en 'analizando' con la
  // transcripcion guardada; analizarYCompletar continua desde ahi (su persist
  // inicial es idempotente). Si falla, marca la fila en 'error'.
  after(async () => {
    try {
      await analizarYCompletar(
        supabase,
        id,
        data.user_id as string,
        data.template_id as string,
        transcription,
        persistInicial,
        normalizarModoAnalisis((data as { modo_analisis?: unknown }).modo_analisis),
        (data as { traducir_a?: string | null }).traducir_a ?? null,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await supabase
        .from('transcripciones')
        .update({ estado: 'error', error_message: `analisis bg fallo: ${message}`.slice(0, 1000) })
        .eq('id', id)
    }
  })

  return NextResponse.json({ ok: true, queued: true }, { status: 200 })
}

// -----------------------------------------------------------------------------
// MULTI-FUENTE: callback de 1 fuente de un padre combinado (Fase 4).
// -----------------------------------------------------------------------------
async function handleFuente(
  supabase: ReturnType<typeof createServiceClient>,
  provider: AsyncTranscriptionProvider,
  transcripcionId: string,
  fuenteId: string,
  secret: string,
  body: unknown,
): Promise<NextResponse> {
  const { data: fuente, error } = await supabase
    .from('transcripcion_fuentes')
    .select('id, transcripcion_id, estado, callback_secret')
    .eq('id', fuenteId)
    .eq('transcripcion_id', transcripcionId)
    .single()

  // (a) Registro inexistente: ACK 200 (mismo criterio que single-audio).
  if (error || !fuente) {
    return NextResponse.json({ ok: true, skipped: 'unknown' }, { status: 200 })
  }

  // (b) Idempotencia ANTES del secret: si la fuente ya se proceso ('transcrito'
  // o 'error'), este POST es un RETRY de Deepgram con el secret ya anulado.
  // ACK 200 e intentamos combinar en background (por si fue el ultimo callback).
  if (fuente.estado === 'transcrito' || fuente.estado === 'error') {
    after(() => intentarCombinarFuentes(supabase, transcripcionId).catch(logCombineErr))
    return NextResponse.json({ ok: true, skipped: true }, { status: 200 })
  }

  // (c) Fuente AUN esperando callback -> exigir secret valido (proteccion real).
  if (fuente.callback_secret !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let transcription: TranscriptionResult
  try {
    transcription = parsearBody(provider, body, 'es-MX')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('transcripcion_fuentes')
      .update({ estado: 'error', error_message: `parse fallo: ${message}`.slice(0, 500), callback_secret: null })
      .eq('id', fuenteId)
    // Aun con una fuente en error, intentamos combinar las utiles (background).
    after(() => intentarCombinarFuentes(supabase, transcripcionId).catch(logCombineErr))
    return NextResponse.json({ ok: false, message }, { status: 200 })
  }

  // Persist SINCRONO de la fuente (compare-and-swap sobre 'transcribiendo'):
  // liviano, dedupea retries (la rama (b) los atrapa luego) y no bloquea el ACK.
  const { error: persistErr } = await supabase
    .from('transcripcion_fuentes')
    .update({
      estado: 'transcrito',
      raw_text: transcription.raw_text,
      segments: transcription.segments,
      duracion_ms: transcription.duration_ms,
      idioma_detectado: transcription.detected_language ?? null,
      callback_secret: null,
    })
    .eq('id', fuenteId)
    .eq('estado', 'transcribiendo')
  if (persistErr) {
    return NextResponse.json({ ok: false, error: persistErr.message }, { status: 500 })
  }

  // Barrera (combina + analiza + indexa) en BACKGROUND: ACK inmediato a Deepgram.
  // intentarCombinarFuentes hace su propio compare-and-swap sobre el padre, asi
  // que correrla en after() (o concurrente con otros callbacks) es seguro.
  after(() => intentarCombinarFuentes(supabase, transcripcionId).catch(logCombineErr))
  return NextResponse.json({ ok: true, fuente: 'transcrita', queued: true }, { status: 200 })
}

function logCombineErr(err: unknown): void {
  console.error(
    `[webhook deepgram] combine background fallo: ${err instanceof Error ? err.message : String(err)}`,
  )
}

export async function POST(request: Request) {
  const url = new URL(request.url)
  const params = extractParams(url)
  if ('error' in params) {
    return NextResponse.json({ error: params.error }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'body no es JSON valido' }, { status: 400 })
  }

  const provider = getTranscriptionProvider() as AsyncTranscriptionProvider
  if (!provider.parseCallbackPayload) {
    return NextResponse.json(
      { error: 'provider configurado no soporta callback (parseCallbackPayload ausente)' },
      { status: 500 },
    )
  }

  const supabase = createServiceClient()

  if (params.fuente) {
    return handleFuente(supabase, provider, params.id, params.fuente, params.secret, body)
  }
  return handleSingle(supabase, provider, params.id, params.secret, body)
}
