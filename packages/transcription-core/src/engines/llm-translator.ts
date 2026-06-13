// =============================================================================
// LLMTranslator — traduccion de transcripciones a un idioma destino (PRP-TT-V2 Fase 2)
// =============================================================================
// Cuando un audio no esta en espanol, Deepgram lo transcribe en su idioma
// original. Este traductor toma los segments y los traduce al espanol (o al
// idioma destino indicado) PRESERVANDO la estructura: mismo numero de segments,
// mismos timings, mismos speakers — solo cambia el `text`.
//
// Decision de diseno: traduce por LOTES (batches) acotados por numero de
// caracteres para no exceder el contexto del modelo en audios largos y para
// acotar el costo. Cada lote pide al LLM un array de strings traducidos en el
// MISMO orden; si el modelo rompe el conteo, ese lote cae a texto original
// (defensa — nunca perdemos segments).
//
// Reusa el mismo modelo barato (gpt-5-mini via OpenRouter) que el analisis.
// La key NUNCA debe llegar al cliente: se instancia server-side.
// =============================================================================

import {
  type TranscriptSegment,
} from '../types/index'
import type { ModelPricing, ReasoningEffort } from './llm-analysis-engine'
import { DEFAULT_MODEL_PRICES } from './llm-analysis-engine'

export interface LLMTranslatorConfig {
  /** OpenRouter API key (server-side only). */
  apiKey: string
  /** Modelo. Identifier OpenRouter, ej "openai/gpt-5-mini". */
  model: string
  /** Esfuerzo de razonamiento. Para traduccion "minimal" basta. */
  defaultReasoningEffort?: ReasoningEffort
  /** Base URL del API. Default https://openrouter.ai/api/v1. */
  baseUrl?: string
  /** fetch-like inyectable para tests. Default globalThis.fetch. */
  fetchFn?: typeof fetch
  /** Tabla de precios. Default DEFAULT_MODEL_PRICES. */
  modelPrices?: Record<string, ModelPricing>
  /** Headers extra para OpenRouter. */
  extraHeaders?: Record<string, string>
  /**
   * Maximo de caracteres por lote. Default 6000 — equilibra costo/latencia vs
   * numero de llamadas. Cada lote es una llamada al LLM.
   */
  maxCharsPerBatch?: number
}

export interface TranslateResult {
  /** Segments con el texto traducido. Misma longitud/timings/speakers. */
  segments: TranscriptSegment[]
  /** Texto plano traducido (concatenado), para raw_text / full-text search. */
  raw_text: string
  /** Idioma destino aplicado (nombre legible, ej "espanol"). */
  target_language: string
  model_used: string
  cost_usd: number
}

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OpenRouterUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

interface OpenRouterResponse {
  choices?: Array<{ message: { content: string | null } }>
  usage?: OpenRouterUsage
  model?: string
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
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000
}

/**
 * Agrupa los textos en lotes acotados por numero de caracteres. Cada lote
 * preserva los indices originales para reensamblar el resultado en orden.
 */
function batchByChars(
  texts: string[],
  maxChars: number,
): Array<{ from: number; items: string[] }> {
  const batches: Array<{ from: number; items: string[] }> = []
  let current: string[] = []
  let currentChars = 0
  let from = 0
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] ?? ''
    // Si el segmento solo ya excede el limite, va en su propio lote.
    if (current.length > 0 && currentChars + t.length > maxChars) {
      batches.push({ from, items: current })
      current = []
      currentChars = 0
      from = i
    }
    current.push(t)
    currentChars += t.length
  }
  if (current.length > 0) batches.push({ from, items: current })
  return batches
}

export class LLMTranslator {
  private readonly apiKey: string
  private readonly model: string
  private readonly defaultReasoningEffort: ReasoningEffort
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly modelPrices: Record<string, ModelPricing>
  private readonly extraHeaders: Record<string, string>
  private readonly maxCharsPerBatch: number

  constructor(config: LLMTranslatorConfig) {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new Error(
        'LLMTranslator: apiKey vacia. Configurar OPENROUTER_API_KEY en env.',
      )
    }
    if (!config.model || config.model.trim().length === 0) {
      throw new Error('LLMTranslator: model vacio.')
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
    this.maxCharsPerBatch = config.maxCharsPerBatch ?? 6000
  }

  /**
   * Traduce un lote de textos. Devuelve el array traducido en el MISMO orden y
   * longitud. Si el modelo rompe el conteo o falla el parseo, devuelve los
   * textos originales del lote (defensa — nunca perdemos contenido) con costo
   * de ese lote igualmente sumado.
   */
  private async translateBatch(
    items: string[],
    targetLanguage: string,
  ): Promise<{ translated: string[]; cost: number; model: string }> {
    const system =
      `Eres un traductor profesional. Traduce CADA elemento del arreglo de entrada al ${targetLanguage}, ` +
      `preservando el sentido, el tono y los nombres propios. ` +
      `Devuelve EXACTAMENTE el mismo numero de elementos, en el MISMO orden, sin agregar ni quitar. ` +
      `Si un elemento ya esta en ${targetLanguage}, devuelvelo igual. No agregues comentarios.`

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ items }) },
      ] as OpenRouterMessage[],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'translation',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['translations'],
            properties: {
              translations: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      reasoning_effort: this.defaultReasoningEffort,
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
    } catch {
      // Error de red: devolver originales para no perder el lote.
      return { translated: items, cost: 0, model: this.model }
    }

    if (!response.ok) {
      return { translated: items, cost: 0, model: this.model }
    }

    let json: OpenRouterResponse
    try {
      json = (await response.json()) as OpenRouterResponse
    } catch {
      return { translated: items, cost: 0, model: this.model }
    }

    const pricing =
      this.modelPrices[this.model] ??
      this.modelPrices.default ?? { input_per_mtok: 0, output_per_mtok: 0 }
    const cost = computeCost(json.usage, pricing)
    const modelUsed = json.model ?? this.model

    const content = json.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      return { translated: items, cost, model: modelUsed }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return { translated: items, cost, model: modelUsed }
    }

    const translations = (parsed as { translations?: unknown }).translations
    if (
      !Array.isArray(translations) ||
      translations.length !== items.length ||
      !translations.every((t) => typeof t === 'string')
    ) {
      // El modelo rompio el conteo: defensa, devolver originales.
      return { translated: items, cost, model: modelUsed }
    }

    return { translated: translations as string[], cost, model: modelUsed }
  }

  /**
   * Traduce los segments al idioma destino (default espanol) preservando
   * estructura. Procesa por lotes secuenciales acotados por caracteres.
   */
  async translateSegments(
    segments: TranscriptSegment[],
    targetLanguage = 'espanol',
  ): Promise<TranslateResult> {
    if (segments.length === 0) {
      return {
        segments: [],
        raw_text: '',
        target_language: targetLanguage,
        model_used: this.model,
        cost_usd: 0,
      }
    }

    const texts = segments.map((s) => s.text)
    const batches = batchByChars(texts, this.maxCharsPerBatch)

    const translatedTexts: string[] = new Array(texts.length).fill('')
    let totalCost = 0
    let modelUsed = this.model

    for (const batch of batches) {
      const { translated, cost, model } = await this.translateBatch(
        batch.items,
        targetLanguage,
      )
      modelUsed = model
      totalCost += cost
      for (let j = 0; j < translated.length; j++) {
        translatedTexts[batch.from + j] = translated[j] ?? batch.items[j] ?? ''
      }
    }

    const outSegments: TranscriptSegment[] = segments.map((s, i) => ({
      ...s,
      text: translatedTexts[i] ?? s.text,
    }))

    return {
      segments: outSegments,
      raw_text: outSegments.map((s) => s.text).join(' ').trim(),
      target_language: targetLanguage,
      model_used: modelUsed,
      cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
    }
  }
}
