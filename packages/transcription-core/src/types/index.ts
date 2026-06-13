// =============================================================================
// @bluntag/transcription-core — contrato publico de tipos
// =============================================================================
// Estos tipos son el SLA del paquete. Cambios que rompen forma o semantica
// requieren MAJOR version bump y aviso a consumidores (TagTranscriptor, otro proyecto
// scribe AI, futuros add-ons Bluntag).
//
// Fase 1 del PRP-TT-001: definicion de contrato + stubs deterministic.
// Implementaciones reales en Fase 2-5.
// =============================================================================

/**
 * Hablante detectado en una transcripcion con diarizacion.
 * El motor (Deepgram, Whisper con diarizer, etc.) asigna `id` 0..N
 * en orden de aparicion. `label` opcional para mapeo manual posterior
 * ("Speaker 0" -> "Ana", "Speaker 1" -> "Beto").
 */
export interface Speaker {
  id: number
  label?: string
}

/**
 * Segmento atomico de transcripcion. Un segmento es una porcion contigua
 * hablada por un mismo speaker. Multiples segmentos seguidos del mismo
 * speaker pueden representar pausas o cortes naturales.
 */
export interface TranscriptSegment {
  speaker: Speaker
  text: string
  start_ms: number
  end_ms: number
  /** Confianza del motor en el rango 0..1. 1 = certeza maxima. */
  confidence: number
}

/**
 * Resultado completo de una transcripcion.
 * `raw_text` es el texto plano concatenado sin diarizacion, util para
 * busqueda full-text. `segments` mantiene la diarizacion estructurada.
 */
export interface TranscriptionResult {
  segments: TranscriptSegment[]
  /** Codigo BCP-47, ej. "es-MX", "en-US". El idioma SOLICITADO al motor. */
  language: string
  /**
   * Idioma DETECTADO por el motor cuando se transcribe en modo auto/multi
   * (BCP-47, ej. "en", "pt"). Puede diferir de `language` (que es el solicitado).
   * Undefined si el motor no lo reporto (ej. se forzo un idioma fijo). Campo
   * opcional — extension Fase 2 PRP-TT-V2, no rompe consumidores existentes.
   */
  detected_language?: string
  duration_ms: number
  raw_text: string
  /** Identifica el motor que produjo este resultado. Util para auditoria. */
  provider: 'deepgram-nova-3' | 'whisper-1' | 'mock' | string
  /** Solo para debug. NO consumir como contrato — varia por proveedor. */
  raw_provider_response?: unknown
}

/**
 * Plantilla de analisis. El consumidor define una plantilla por caso de uso
 * (Discovery, reunion interna, consulta veterinaria SOAP, llamada legal, etc.).
 *
 * `output_schema` es JSON Schema que valida la respuesta del LLM. El paquete
 * NO procesa el schema en Fase 1 (los stubs ignoran), pero las implementaciones
 * reales (Fase 3) lo usan para forzar respuesta estructurada y validarla con Zod.
 *
 * `prompt_user_template` soporta placeholders mustache-like: `{{transcript}}`,
 * `{{duration}}`, `{{language}}`. El paquete los reemplaza antes de llamar al LLM.
 */
export interface AnalysisTemplate {
  id: string
  name: string
  description: string
  prompt_system: string
  prompt_user_template: string
  /** JSON Schema (object Record). El paquete lo valida en Fase 3. */
  output_schema: Record<string, unknown>
}

/**
 * Resultado de analizar una transcripcion con una plantilla.
 *
 * `custom_fields` es la salida estructurada conforme a `output_schema` de la
 * plantilla. Para Discovery puede ser {pain_points, budget_signals}; para SOAP
 * veterinario {soap: {S,O,A,P}, treatment_plan, discharge_instructions}.
 * El paquete entrega el objeto; el consumidor decide como persistirlo.
 *
 * `cost_usd` permite tracking de gasto por analisis (tipico LLM call $0.10-0.80
 * para Sonnet en transcripciones de 1h).
 */
export interface AnalysisResult {
  template_id: string
  resumen: string
  bullets: string[]
  action_items: ActionItem[]
  categoria: string
  /** Salida especifica conforme al output_schema de la plantilla. */
  custom_fields: Record<string, unknown>
  /** Modelo usado, ej. "claude-sonnet-4-6", "gpt-4o-mini", "mock". */
  model_used: string
  cost_usd: number
}

/**
 * Esfuerzo de razonamiento del LLM (reasoning_effort de OpenRouter/OpenAI).
 * Hogar canonico del tipo (lo consumen el engine de analisis, el traductor y el
 * chat client). Para summarization estructurado simple "minimal" basta; "high"
 * habilita analisis mas profundo (PRP-TT-V2 Fase 5B-C, modo Profundo).
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

/**
 * Compromiso o tarea detectada en la conversacion.
 * Si el motor logra extraer fecha o responsable, los pone aqui; si no,
 * deja `undefined`.
 */
export interface ActionItem {
  texto: string
  /** ISO 8601 date string si aplica, ej. "2026-06-15". */
  due_date?: string
  /** Nombre o speaker_id del responsable detectado. */
  owner?: string
}

/**
 * Chunk indexado para RAG semantico. El RagIndex divide la transcripcion
 * en chunks (por ventana de tokens o turno de speaker, decision del impl).
 */
export interface RagChunk {
  transcription_id: string
  chunk_index: number
  text: string
  start_ms: number
  end_ms: number
  /** Vector de embedding. Dimension depende del modelo (1536 para text-embedding-3-small). */
  embedding?: number[]
}

/**
 * Respuesta a una pregunta hecha contra una transcripcion (Ask Plaud / Ask TagTranscriptor).
 * El motor recupera chunks relevantes via similaridad coseno y los pasa al LLM
 * con instruccion "responde citando".
 *
 * Las citas deben ser literales y verificables — el consumidor las puede mostrar
 * con timestamps clickeables que llevan al momento exacto de la grabacion.
 */
export interface AskResult {
  answer: string
  citations: AskCitation[]
  model_used: string
  cost_usd: number
}

export interface AskCitation {
  /** Texto literal del segmento citado. */
  text: string
  start_ms: number
  end_ms: number
  speaker?: Speaker
}

/**
 * Respuesta a una pregunta hecha contra TODAS las sesiones de un proyecto
 * (Ask cross-sesion — PRP-TT-V2 Fase 5B). Igual que AskResult pero cada cita
 * recuerda de que SESION proviene, para que el consumidor pueda mostrar
 * "esto se dijo en la sesion X" con link al momento exacto.
 */
export interface ProjectAskResult {
  answer: string
  citations: ProjectAskCitation[]
  model_used: string
  cost_usd: number
}

export interface ProjectAskCitation extends AskCitation {
  /** Id de la sesion (transcripcion) de origen de la cita. */
  transcripcion_id: string
  /** Titulo de la sesion de origen, para mostrarlo junto a la cita. */
  titulo_sesion: string
}

// =============================================================================
// Errores tipados
// =============================================================================
// Los consumidores deben hacer instanceof check para distinguir clases de error.

export class TranscriptionError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'TranscriptionError'
  }
}

export class AnalysisError extends Error {
  constructor(
    message: string,
    public readonly template_id: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AnalysisError'
  }
}

export class RagError extends Error {
  constructor(
    message: string,
    public readonly transcription_id: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'RagError'
  }
}

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'StorageError'
  }
}

// =============================================================================
// Opciones de invocacion de las interfaces
// =============================================================================

export interface TranscribeOptions {
  /**
   * BCP-47, default "es-MX". Valores especiales:
   * - "multi" / "auto" → el motor detecta el idioma (Nova-3 multilingue con
   *   code-switching). El idioma detectado se devuelve en
   *   `TranscriptionResult.detected_language`.
   * - Codigo de idioma soportado (es, en, pt, fr, de, it, ru, ja, nl, hi, ...)
   *   → fuerza ese idioma.
   * - Idioma no soportado por el motor → cae a "multi" (auto-deteccion).
   */
  language?: string
  /** Activar separacion de hablantes. Default true. */
  diarize?: boolean
  /**
   * Version del modelo de diarizacion de Deepgram. Default "latest" (modelo
   * next-gen entrenado con 100k+ voces, mejor separacion de voces parecidas).
   * "v1" usa el diarizador legacy. Solo aplica si diarize !== false. Campo
   * opcional — extension Fase 2 PRP-TT-V2, no rompe consumidores existentes.
   */
  diarizeModel?: 'latest' | 'v2' | 'v1'
  /** Agregar puntuacion + capitalizacion. Default true. */
  punctuate?: boolean
}

/**
 * Opciones para invocacion asincrona (modo callback / webhook).
 *
 * El provider envia el request al motor con la URL del callback. El motor
 * procesa async y hace POST a `callbackUrl` con el resultado. El consumidor
 * implementa un endpoint que reciba ese POST y use `parseCallbackPayload()`
 * del provider para mapear el body a `TranscriptionResult`.
 *
 * Util para audios largos donde el procesamiento puede exceder el timeout
 * del runtime serverless (e.g. Vercel maxDuration 300s).
 */
export interface TranscribeAsyncOptions extends TranscribeOptions {
  /**
   * URL absoluta HTTPS publica que recibira el POST con el resultado.
   * Incluye cualquier secret/identificador en query string para que el
   * endpoint pueda validar y enrutar (e.g. `?secret=UUID&id=TRANSCRIPCION_ID`).
   */
  callbackUrl: string
}

/**
 * Resultado de un lanzamiento asincrono. Solo confirma que el motor acepto
 * el job — el resultado real llega via callback.
 */
export interface TranscribeAsyncResult {
  /** ID del request asignado por el motor. Util para audit / debug. */
  request_id: string
}

export interface SignedUrlOptions {
  /** TTL en segundos. Maximo recomendado 3600 (60 min). */
  expiresInSec: number
}

export interface SignedUploadUrl {
  url: string
  /** Algunos providers (Supabase Storage resumable) requieren fields adicionales. */
  fields?: Record<string, string>
}
