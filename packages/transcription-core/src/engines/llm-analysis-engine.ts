// =============================================================================
// LLMAnalysisEngine — implementacion real con OpenRouter chat completions
// =============================================================================
// Configurada para `openai/gpt-5-mini` por default (decision de producto 2026-05-27),
// pero el modelo y el reasoning_effort son inyectables. La plantilla puede
// declarar su propio model para sobrescribir el global.
//
// API: https://openrouter.ai/docs/api-reference/chat-completion
// Pricing referencia (USD por MTok) — actualizar tabla cuando suban precios:
//   - openai/gpt-5-mini:           $0.25 input / $2.00 output
//   - openai/gpt-5:                $1.25 / $10
//   - google/gemini-3.5-flash:     $1.50 / $9
//   - anthropic/claude-sonnet-4.6: $3 / $15
//
// La key NUNCA debe llegar al cliente. Este engine se instancia server-side.
// =============================================================================

import {
  AnalysisError,
  type ActionItem,
  type AnalysisResult,
  type AnalysisTemplate,
  type ReasoningEffort,
  type TranscriptionResult,
} from '../types/index'
import type { AnalysisEngine } from './analysis-engine'

// Re-export del hogar canonico (types/index) para no romper a los modulos que
// historicamente importan ReasoningEffort desde aqui (llm-translator,
// openrouter-chat-client). El tipo vive en types/index para evitar el ciclo
// analysis-engine ↔ llm-analysis-engine al extender la interface AnalysisEngine.
export type { ReasoningEffort } from '../types/index'

export interface ModelPricing {
  /** USD per 1M input tokens */
  input_per_mtok: number
  /** USD per 1M output tokens */
  output_per_mtok: number
}

/**
 * Tabla de precios por modelo. Si el modelo no esta listado, se asume el de
 * `default` (gpt-5-mini). Actualizar cuando cambien precios o se agreguen modelos.
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPricing> = {
  default: { input_per_mtok: 0.25, output_per_mtok: 2.0 },
  'openai/gpt-5-mini': { input_per_mtok: 0.25, output_per_mtok: 2.0 },
  'openai/gpt-5': { input_per_mtok: 1.25, output_per_mtok: 10.0 },
  'google/gemini-3.5-flash': { input_per_mtok: 1.5, output_per_mtok: 9.0 },
  'anthropic/claude-sonnet-4.6': { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  'anthropic/claude-haiku-4.5': { input_per_mtok: 1.0, output_per_mtok: 5.0 },
}

export interface LLMAnalysisEngineConfig {
  /** OpenRouter API key (server-side only). */
  apiKey: string
  /** Modelo default. Identifier OpenRouter, ej "openai/gpt-5-mini". */
  model: string
  /**
   * Esfuerzo de razonamiento default. Para summarization estructurado simple
   * "minimal" es lo recomendado (latencia ~0.95s TTFT con gpt-5-mini).
   */
  defaultReasoningEffort?: ReasoningEffort
  /** Base URL del API. Default https://openrouter.ai/api/v1. */
  baseUrl?: string
  /** fetch-like inyectable para tests. Default globalThis.fetch. */
  fetchFn?: typeof fetch
  /**
   * Tabla de precios. Default DEFAULT_MODEL_PRICES. Si el modelo no aparece,
   * se usa la entrada 'default'.
   */
  modelPrices?: Record<string, ModelPricing>
  /**
   * Headers extra para OpenRouter (HTTP-Referer + X-Title son recomendados
   * pero opcionales). Default {} — se setean por default a TagTranscriptor.
   */
  extraHeaders?: Record<string, string>
}

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OpenRouterChoice {
  message: { content: string | null }
  finish_reason?: string
}

interface OpenRouterUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[]
  usage?: OpenRouterUsage
  model?: string
}

interface ExtendedTemplate extends AnalysisTemplate {
  /** Override opcional del modelo a nivel plantilla (campo extendido, no en interface base). */
  model?: string
  /** Override opcional del reasoning_effort. */
  reasoning_effort?: ReasoningEffort
}

/**
 * Renderiza placeholders {{transcript}}, {{duration}}, {{language}}, {{template_id}}
 * en el prompt_user_template. Simple replace, no es Handlebars completo.
 */
function renderUserPrompt(
  template: AnalysisTemplate,
  transcription: TranscriptionResult,
  opts?: { speakerTokens?: boolean },
): string {
  // Modo marcador (PRP-TT-V2 Fase 5): etiquetamos cada hablante con un token
  // estable {{sN}} en vez de "Speaker N". El consumidor sustituye esos tokens
  // por los nombres reales AL RENDERIZAR, así renombrar un hablante NO requiere
  // re-analizar (cero costo de IA). Sin el flag, comportamiento clásico.
  const etiqueta = (id: number): string =>
    opts?.speakerTokens ? `{{s${id}}}` : `Speaker ${id}`

  const transcriptText = transcription.segments
    .map((s) => `[${etiqueta(s.speaker.id)}] ${s.text}`)
    .join('\n')

  return template.prompt_user_template
    .replace(/\{\{transcript\}\}/g, transcriptText || transcription.raw_text)
    .replace(/\{\{duration\}\}/g, String(Math.round(transcription.duration_ms / 1000)))
    .replace(/\{\{language\}\}/g, transcription.language)
    .replace(/\{\{template_id\}\}/g, template.id)
}

/**
 * Sanitiza el nombre para `json_schema.name` segun OpenAI: solo alfanumeric + _ - .
 */
function sanitizeSchemaName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 64) || 'analysis'
}

/**
 * Valida que el JSON parseado tenga la estructura base esperada (defense in
 * depth — OpenAI strict ya lo garantiza, pero si por bug el strict falla
 * cazamos los 4 campos base aqui).
 */
function assertBaseShape(parsed: unknown, templateId: string): void {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AnalysisError('LLM devolvio JSON no-objeto', templateId)
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.resumen !== 'string') {
    throw new AnalysisError('LLM omitio "resumen" string', templateId)
  }
  if (!Array.isArray(obj.bullets)) {
    throw new AnalysisError('LLM omitio "bullets" array', templateId)
  }
  if (!Array.isArray(obj.action_items)) {
    throw new AnalysisError('LLM omitio "action_items" array', templateId)
  }
  if (typeof obj.categoria !== 'string') {
    throw new AnalysisError('LLM omitio "categoria" string', templateId)
  }
}

function mapActionItems(raw: unknown): ActionItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null
      const obj = item as Record<string, unknown>
      if (typeof obj.texto !== 'string') return null
      const ai: ActionItem = { texto: obj.texto }
      if (typeof obj.due_date === 'string') ai.due_date = obj.due_date
      if (typeof obj.owner === 'string') ai.owner = obj.owner
      return ai
    })
    .filter((x): x is ActionItem => x !== null)
}

/**
 * Extrae custom_fields del JSON parseado excluyendo los campos base (resumen,
 * bullets, action_items, categoria) — todo lo demas que el schema definio entra
 * a custom_fields. Asi cada plantilla puede tener su propio shape sin tocar
 * la interface AnalysisResult.
 */
function extractCustomFields(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(parsed)) {
    if (key === 'resumen' || key === 'bullets' || key === 'action_items' || key === 'categoria') {
      continue
    }
    out[key] = val
  }
  return out
}

function computeCost(
  usage: OpenRouterUsage | undefined,
  pricing: ModelPricing,
): number {
  if (!usage) return 0
  const inputTokens = usage.prompt_tokens ?? 0
  const outputTokens = usage.completion_tokens ?? 0
  const inputCost = (inputTokens / 1_000_000) * pricing.input_per_mtok
  const outputCost = (outputTokens / 1_000_000) * pricing.output_per_mtok
  // Round to 6 decimals (sufficient for sub-cent precision)
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000
}

export class LLMAnalysisEngine implements AnalysisEngine {
  private readonly apiKey: string
  private readonly model: string
  private readonly defaultReasoningEffort: ReasoningEffort
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly modelPrices: Record<string, ModelPricing>
  private readonly extraHeaders: Record<string, string>

  constructor(config: LLMAnalysisEngineConfig) {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new AnalysisError(
        'LLMAnalysisEngine: apiKey vacia. Configurar OPENROUTER_API_KEY en env.',
        '<init>',
      )
    }
    if (!config.model || config.model.trim().length === 0) {
      throw new AnalysisError(
        'LLMAnalysisEngine: model vacio. Configurar OPENROUTER_MODEL en env (ej "openai/gpt-5-mini").',
        '<init>',
      )
    }
    this.apiKey = config.apiKey
    this.model = config.model
    this.defaultReasoningEffort = config.defaultReasoningEffort ?? 'minimal'
    this.baseUrl = (config.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')
    this.fetchFn = config.fetchFn ?? globalThis.fetch
    this.modelPrices = config.modelPrices ?? DEFAULT_MODEL_PRICES
    this.extraHeaders = {
      'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL ?? 'https://tagmeetings.example.com',
      'X-Title': 'TagMeetings',
      ...(config.extraHeaders ?? {}),
    }
  }

  async analyze(
    transcription: TranscriptionResult,
    template: AnalysisTemplate,
    opts?: {
      speakerTokens?: boolean
      /** Override por LLAMADA del modelo (PRP-TT-V2 Fase 5B-C, modo Profundo). */
      model?: string
      /** Override por LLAMADA del reasoning_effort (modo Rapido/Profundo por sesion). */
      reasoningEffort?: ReasoningEffort
      /**
       * Contexto del proyecto (memoria + resumenes del historico) a inyectar al
       * prompt para que el analisis considere la relacion completa, no solo la
       * sesion de hoy (PRP-TT-V2 Fase 5B-C, re-analisis con contexto global).
       */
      contextoGlobal?: string
    },
  ): Promise<AnalysisResult> {
    const ext = template as ExtendedTemplate
    // Precedencia: override por llamada (sesion) > override de plantilla > default del engine.
    const modelToUse = opts?.model ?? ext.model ?? this.model
    const effortToUse = opts?.reasoningEffort ?? ext.reasoning_effort ?? this.defaultReasoningEffort

    // Modo marcador (PRP-TT-V2 Fase 5): cuando el consumidor pide tokens, las
    // plantillas instruyen "referencia speakers como Speaker 0/1"; anexamos una
    // directiva de PRIORIDAD para que el modelo escriba el token literal {{sN}}.
    // El consumidor luego sustituye {{sN}} por el nombre real al renderizar, así
    // renombrar es gratis (no re-analiza).
    const systemContent = opts?.speakerTokens
      ? `${template.prompt_system}\n\nIMPORTANTE (PRIORIDAD MÁXIMA): Para referirte a un hablante escribe EXACTAMENTE su marcador tal como aparece entre corchetes en la transcripción: {{s0}}, {{s1}}, etc. NUNCA uses nombres propios, "Speaker N", ni descripciones como "el cliente"/"el primero" — SIEMPRE el marcador {{sN}}. Ejemplo: "{{s1}} le pregunta a {{s0}} por el precio." Esta instrucción tiene prioridad sobre cualquier indicación previa sobre cómo nombrar a los hablantes.`
      : template.prompt_system

    // Contexto global del proyecto (re-analisis con memoria del historico): se
    // antepone al prompt de la sesion. El modelo debe USARLO para dar continuidad
    // pero seguir analizando PRINCIPALMENTE la sesion de hoy.
    const userBase = renderUserPrompt(template, transcription, opts)
    const userContent =
      typeof opts?.contextoGlobal === 'string' && opts.contextoGlobal.trim().length > 0
        ? `CONTEXTO DEL PROYECTO (historico de la relacion con esta contraparte a lo largo del tiempo). Usalo para dar continuidad y enriquecer tu analisis (referencia acuerdos previos, pendientes que vienen de antes, evolucion de la relacion), pero analiza PRINCIPALMENTE la sesion de HOY que viene despues:\n\n${opts.contextoGlobal.trim()}\n\n=====\n\nSESION A ANALIZAR:\n\n${userBase}`
        : userBase

    const messages: OpenRouterMessage[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ]

    const body = {
      model: modelToUse,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: sanitizeSchemaName(template.id),
          strict: true,
          schema: template.output_schema,
        },
      },
      reasoning_effort: effortToUse,
    }

    let response: Response
    try {
      response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      throw new AnalysisError(
        'LLMAnalysisEngine: error de red al llamar a OpenRouter',
        template.id,
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
      throw new AnalysisError(
        `LLMAnalysisEngine: HTTP ${response.status} ${response.statusText}. Detail: ${detail.slice(0, 500)}`,
        template.id,
      )
    }

    let json: OpenRouterResponse
    try {
      json = (await response.json()) as OpenRouterResponse
    } catch (cause) {
      throw new AnalysisError(
        'LLMAnalysisEngine: respuesta no es JSON valido',
        template.id,
        cause,
      )
    }

    const choice = json.choices?.[0]
    if (!choice || !choice.message || typeof choice.message.content !== 'string') {
      throw new AnalysisError(
        'LLMAnalysisEngine: response sin choices[0].message.content',
        template.id,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(choice.message.content)
    } catch (cause) {
      throw new AnalysisError(
        `LLMAnalysisEngine: choices[0].message.content no es JSON parseable: ${choice.message.content.slice(0, 200)}`,
        template.id,
        cause,
      )
    }

    assertBaseShape(parsed, template.id)
    const parsedObj = parsed as Record<string, unknown>

    const pricing =
      this.modelPrices[modelToUse] ??
      this.modelPrices.default ?? { input_per_mtok: 0, output_per_mtok: 0 }
    const cost_usd = computeCost(json.usage, pricing)

    return {
      template_id: template.id,
      resumen: parsedObj.resumen as string,
      bullets: parsedObj.bullets as string[],
      action_items: mapActionItems(parsedObj.action_items),
      categoria: parsedObj.categoria as string,
      custom_fields: extractCustomFields(parsedObj),
      model_used: json.model ?? modelToUse,
      cost_usd,
    }
  }
}
