// =============================================================================
// DeepgramProvider — implementacion real de TranscriptionProvider con Deepgram Nova-3
// =============================================================================
// API: https://developers.deepgram.com/reference/listen-file
// Endpoint batch (URL-based): POST https://api.deepgram.com/v1/listen
// Costo referencia: ~$0.0043 USD/min en Nova-3 multi (2026-Q2).
//
// La key NUNCA debe llegar al cliente. Este provider se instancia server-side.
// =============================================================================

import {
  TranscriptionError,
  type Speaker,
  type TranscribeAsyncOptions,
  type TranscribeAsyncResult,
  type TranscribeOptions,
  type TranscriptionResult,
  type TranscriptSegment,
} from '../types/index'
import type { AsyncTranscriptionProvider } from './transcription-provider'

export interface DeepgramProviderConfig {
  /** Deepgram API key. Server-side ONLY. */
  apiKey: string
  /** Modelo. Default 'nova-3'. */
  model?: string
  /**
   * fetch-like inyectable para tests. Default globalThis.fetch.
   * Acepta cualquier funcion compatible con el contrato fetch del runtime.
   */
  fetchFn?: typeof fetch
  /** Base URL del API. Default 'https://api.deepgram.com'. Util para tests/mocks. */
  baseUrl?: string
}

interface DeepgramUtterance {
  start: number
  end: number
  confidence: number
  speaker?: number
  transcript: string
}

interface DeepgramListenResponse {
  metadata?: {
    duration?: number
    request_id?: string
    model_info?: Record<string, unknown>
  }
  results?: {
    channels?: Array<{
      /**
       * Idioma detectado por canal cuando se transcribe en modo multi/auto.
       * Nova-3 multilingue lo reporta como tag BCP-47 (ej. "en", "pt").
       */
      detected_language?: string
      language_confidence?: number
      alternatives?: Array<{
        transcript?: string
        confidence?: number
      }>
    }>
    utterances?: DeepgramUtterance[]
  }
}

/**
 * Respuesta inmediata al lanzar un request con `callback` query param.
 * Deepgram responde 200 con solo el request_id; el resultado llega luego
 * al callback URL.
 */
interface DeepgramAsyncAck {
  request_id?: string
}

/**
 * Idiomas que Deepgram Nova-3 soporta en modo MONOLINGUE (forzando el codigo).
 * Lista completa verificada contra la doc oficial de Deepgram (models-languages-
 * overview, 2026). Cualquier codigo fuera de este set cae a 'multi' (auto-
 * deteccion). OJO: 'multi' solo auto-detecta 10 idiomas (es/en/fr/de/it/pt/nl/
 * ru/ja/hi); para el resto hay que forzar el codigo monolingue desde la UI.
 * Si Deepgram agrega uno nuevo, agregarlo aqui tras confirmar en su doc.
 */
const DEEPGRAM_SUPPORTED_LANGS = new Set([
  // Europa occidental
  'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ca',
  // Europa del este / eslavas / balticas
  'ru', 'uk', 'be', 'pl', 'cs', 'sk', 'sl', 'hr', 'sr', 'bs', 'bg', 'mk',
  'ro', 'hu', 'el', 'et', 'lv', 'lt',
  // Nordicas
  'sv', 'da', 'no', 'fi',
  // Asia oriental / sudeste
  'ja', 'ko', 'zh', 'th', 'vi', 'id', 'ms', 'tl',
  // Sur de Asia
  'hi', 'bn', 'gu', 'kn', 'mr', 'ta', 'te', 'ur',
  // Medio oriente
  'ar', 'he', 'fa', 'tr',
])

/**
 * Mapea codigo BCP-47 del consumidor al parametro `language` de Deepgram Nova-3.
 * - undefined → 'multi' (auto-deteccion)
 * - 'multi' / 'auto' → 'multi' (auto-deteccion explicita)
 * - 'es-MX' / 'es-419' / 'es' → 'es'; 'en-US' / 'en' → 'en'; etc. (base soportada)
 * - idioma NO soportado por Nova-3 → 'multi' (mejor auto-detectar que forzar mal)
 */
function toDeepgramLanguage(input?: string): string {
  if (!input) return 'multi'
  const lower = input.toLowerCase()
  if (lower === 'multi' || lower === 'auto') return 'multi'
  const base = lower.split('-')[0] ?? lower
  if (DEEPGRAM_SUPPORTED_LANGS.has(base)) return base
  return 'multi'
}

/**
 * Construye query string para el endpoint /v1/listen.
 * Activa diarizacion (modelo next-gen `diarize_model=latest`) + utterances +
 * punctuate + smart_format por default para devolver segmentos limpios listos
 * para mapear a TranscriptSegment.
 *
 * Fase 2: usamos `diarize_model=latest` (diarizador entrenado con
 * 100k+ voces, mejor separacion de voces parecidas) en vez del flag legacy
 * `diarize=true` (que enruta al diarizador v1). Segun la doc de Deepgram,
 * especificar `diarize_model` habilita la diarizacion Y selecciona la version;
 * no hace falta tambien `diarize=true`.
 */
function buildQueryString(opts: TranscribeOptions, model: string): string {
  const params = new URLSearchParams()
  params.set('model', model)
  params.set('language', toDeepgramLanguage(opts.language))
  if (opts.diarize ?? true) {
    params.set('diarize_model', opts.diarizeModel ?? 'latest')
  }
  params.set('punctuate', String(opts.punctuate ?? true))
  params.set('utterances', 'true')
  params.set('smart_format', 'true')
  return params.toString()
}

/**
 * Reagrupa palabras por speaker cuando Deepgram no devuelve utterances
 * (raro, solo si diarize=false o el audio es muy corto).
 * Fallback de seguridad para no entregar segments vacios.
 */
function fallbackSegmentFromTranscript(
  transcript: string,
  durationMs: number,
  confidence: number,
): TranscriptSegment[] {
  if (!transcript.trim()) return []
  return [
    {
      speaker: { id: 0 },
      text: transcript.trim(),
      start_ms: 0,
      end_ms: durationMs,
      confidence,
    },
  ]
}

function mapUtterancesToSegments(
  utterances: DeepgramUtterance[],
): TranscriptSegment[] {
  return utterances.map((u) => {
    const speaker: Speaker = { id: u.speaker ?? 0 }
    return {
      speaker,
      text: u.transcript.trim(),
      start_ms: Math.round(u.start * 1000),
      end_ms: Math.round(u.end * 1000),
      confidence: u.confidence,
    }
  })
}

/**
 * Mapea una respuesta cruda de Deepgram (sync o callback) a TranscriptionResult.
 * Compartido entre transcribe() sync y parseCallbackPayload() async para garantizar
 * salida identica sin importar el modo de invocacion.
 */
function deepgramResponseToResult(
  json: DeepgramListenResponse,
  language: string,
): TranscriptionResult {
  const durationSec = json.metadata?.duration ?? 0
  const durationMs = Math.round(durationSec * 1000)
  const utterances = json.results?.utterances ?? []
  const channel = json.results?.channels?.[0]
  const alt = channel?.alternatives?.[0]
  const transcript = alt?.transcript ?? ''
  const confidence = alt?.confidence ?? 0

  // Idioma detectado por el canal (modo multi/auto). Puede venir undefined si
  // se forzo un idioma fijo o si el modelo no lo reporto en esta respuesta.
  const detected =
    typeof channel?.detected_language === 'string' &&
    channel.detected_language.trim().length > 0
      ? channel.detected_language.trim()
      : undefined

  const segments =
    utterances.length > 0
      ? mapUtterancesToSegments(utterances)
      : fallbackSegmentFromTranscript(transcript, durationMs, confidence)

  return {
    segments,
    language,
    detected_language: detected,
    duration_ms: durationMs,
    raw_text: transcript,
    provider: 'deepgram-nova-3',
    raw_provider_response: json,
  }
}

export class DeepgramProvider implements AsyncTranscriptionProvider {
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchFn: typeof fetch
  private readonly baseUrl: string

  constructor(config: DeepgramProviderConfig) {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new TranscriptionError(
        'DeepgramProvider: apiKey vacia. Configurar DEEPGRAM_API_KEY en server env.',
        'deepgram-nova-3',
      )
    }
    this.apiKey = config.apiKey
    this.model = config.model ?? 'nova-3'
    this.fetchFn = config.fetchFn ?? globalThis.fetch
    this.baseUrl = (config.baseUrl ?? 'https://api.deepgram.com').replace(/\/$/, '')
  }

  async transcribe(
    audioUrl: string,
    opts: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    if (!audioUrl || !audioUrl.startsWith('http')) {
      throw new TranscriptionError(
        'DeepgramProvider: audioUrl debe ser HTTP(S). Para batch se requiere URL publica firmada.',
        'deepgram-nova-3',
      )
    }

    const url = `${this.baseUrl}/v1/listen?${buildQueryString(opts, this.model)}`

    let response: Response
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: audioUrl }),
      })
    } catch (cause) {
      throw new TranscriptionError(
        'DeepgramProvider: error de red al llamar a Deepgram',
        'deepgram-nova-3',
        cause,
      )
    }

    if (!response.ok) {
      let detail = ''
      try {
        detail = await response.text()
      } catch {
        // ignore
      }
      throw new TranscriptionError(
        `DeepgramProvider: HTTP ${response.status} ${response.statusText}. Detail: ${detail.slice(0, 500)}`,
        'deepgram-nova-3',
      )
    }

    let json: DeepgramListenResponse
    try {
      json = (await response.json()) as DeepgramListenResponse
    } catch (cause) {
      throw new TranscriptionError(
        'DeepgramProvider: respuesta no es JSON valido',
        'deepgram-nova-3',
        cause,
      )
    }

    return deepgramResponseToResult(json, opts.language ?? 'es-MX')
  }

  /**
   * Lanza el job a Deepgram en modo callback. Deepgram responde 200 inmediato
   * con `{request_id}` y procesa async. Cuando termina, hace POST al `callbackUrl`
   * con el body identico al de `transcribe()` sync — pasarlo a `parseCallbackPayload`.
   *
   * Retry policy de Deepgram: si el callback endpoint devuelve no-2xx, reintenta
   * hasta 10 veces con 30s de delay (doc oficial Deepgram).
   */
  async transcribeAsync(
    audioUrl: string,
    opts: TranscribeAsyncOptions,
  ): Promise<TranscribeAsyncResult> {
    if (!audioUrl || !audioUrl.startsWith('http')) {
      throw new TranscriptionError(
        'DeepgramProvider: audioUrl debe ser HTTP(S). Para batch se requiere URL publica firmada.',
        'deepgram-nova-3',
      )
    }
    if (!opts.callbackUrl || !opts.callbackUrl.startsWith('https://')) {
      throw new TranscriptionError(
        'DeepgramProvider: callbackUrl debe ser HTTPS publica. Deepgram rechaza HTTP plano.',
        'deepgram-nova-3',
      )
    }

    const baseQs = buildQueryString(opts, this.model)
    const url =
      `${this.baseUrl}/v1/listen?${baseQs}` +
      `&callback=${encodeURIComponent(opts.callbackUrl)}`

    let response: Response
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: audioUrl }),
      })
    } catch (cause) {
      throw new TranscriptionError(
        'DeepgramProvider: error de red al lanzar job async',
        'deepgram-nova-3',
        cause,
      )
    }

    if (!response.ok) {
      let detail = ''
      try {
        detail = await response.text()
      } catch {
        // ignore
      }
      throw new TranscriptionError(
        `DeepgramProvider async: HTTP ${response.status} ${response.statusText}. Detail: ${detail.slice(0, 500)}`,
        'deepgram-nova-3',
      )
    }

    let ack: DeepgramAsyncAck
    try {
      ack = (await response.json()) as DeepgramAsyncAck
    } catch (cause) {
      throw new TranscriptionError(
        'DeepgramProvider async: ack no es JSON valido',
        'deepgram-nova-3',
        cause,
      )
    }

    if (!ack.request_id) {
      throw new TranscriptionError(
        'DeepgramProvider async: ack sin request_id (Deepgram rompio contrato).',
        'deepgram-nova-3',
      )
    }

    return { request_id: ack.request_id }
  }

  /**
   * Parsea el body recibido en el endpoint del callback a TranscriptionResult.
   * El body de Deepgram en modo callback es identico al de la respuesta sync.
   *
   * El language no viene en el callback — se pasa el declarado al lanzar el job.
   */
  parseCallbackPayload(body: unknown, language = 'es-MX'): TranscriptionResult {
    if (!body || typeof body !== 'object') {
      throw new TranscriptionError(
        'DeepgramProvider: callback payload no es objeto',
        'deepgram-nova-3',
      )
    }
    const json = body as DeepgramListenResponse
    if (!json.results && !json.metadata) {
      throw new TranscriptionError(
        'DeepgramProvider: callback payload sin results ni metadata — formato inesperado',
        'deepgram-nova-3',
      )
    }
    return deepgramResponseToResult(json, language)
  }
}
