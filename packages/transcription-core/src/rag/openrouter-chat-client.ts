// =============================================================================
// OpenRouterChatClient — wrapper minimalista de chat completions para Ask RAG
// =============================================================================
// El PgvectorRagIndex.ask() recupera chunks via similaridad coseno y debe
// llamar a un LLM con instruccion "responde citando timestamps". Este cliente
// hace exactamente esa llamada: text-in, text-out, sin strict json_schema.
//
// Implementacion paralela a LLMAnalysisEngine pero sin schemas — para Ask el
// modelo devuelve texto libre (la cita JSON es procesada aparte por el caller).
//
// API: https://openrouter.ai/docs/api-reference/chat-completion
// Pricing: ver DEFAULT_MODEL_PRICES en engines/llm-analysis-engine.ts.
// =============================================================================

import { RagError } from '../types/index'
import { DEFAULT_MODEL_PRICES, type ModelPricing, type ReasoningEffort } from '../engines/llm-analysis-engine'

export interface OpenRouterChatClientConfig {
  /** OpenRouter API key (server-side only). */
  apiKey: string
  /** Modelo default. Default 'openai/gpt-5-mini'. */
  model?: string
  /** Reasoning effort default. Default 'minimal'. */
  defaultReasoningEffort?: ReasoningEffort
  /** Base URL. Default https://openrouter.ai/api/v1. */
  baseUrl?: string
  /** fetch-like inyectable para tests. */
  fetchFn?: typeof fetch
  /** Pricing table. Default DEFAULT_MODEL_PRICES. */
  modelPrices?: Record<string, ModelPricing>
  /** Headers extra. Default HTTP-Referer + X-Title de TagTranscriptor. */
  extraHeaders?: Record<string, string>
}

export interface ChatJsonSchemaOption {
  /** Nombre del schema (sanitizado: solo alfanumeric + _ - .). */
  name: string
  /** JSON Schema strict-compatible: additionalProperties:false + required all + sin $defs/$ref. */
  schema: Record<string, unknown>
}

export interface ChatCompletionRequest {
  systemPrompt: string
  userPrompt: string
  /** Override del modelo a nivel llamada. */
  model?: string
  /** Override del reasoning_effort a nivel llamada. */
  reasoning_effort?: ReasoningEffort
  /**
   * Si se pasa, fuerza la respuesta a JSON matching del schema via OpenAI strict
   * mode (token masking CFG). El content sigue siendo un string parseable. El
   * caller hace JSON.parse(result.content) para obtener el objeto.
   */
  jsonSchema?: ChatJsonSchemaOption
}

export interface ChatCompletionResult {
  content: string
  model_used: string
  cost_usd: number
  prompt_tokens: number
  completion_tokens: number
}

/**
 * Interface minima que el PgvectorRagIndex consume del chat client. Permite que
 * el consumidor pase su propio cliente (ej. Anthropic directo) sin obligar a
 * usar OpenRouter. OpenRouterChatClient implementa esta interface.
 */
export interface ChatCompletionClient {
  complete(req: ChatCompletionRequest): Promise<ChatCompletionResult>
}

interface OpenRouterUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

interface OpenRouterChoice {
  message?: { content?: string | null }
  finish_reason?: string
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[]
  usage?: OpenRouterUsage
  model?: string
}

function computeCost(usage: OpenRouterUsage | undefined, pricing: ModelPricing): number {
  if (!usage) return 0
  const inputTokens = usage.prompt_tokens ?? 0
  const outputTokens = usage.completion_tokens ?? 0
  const inputCost = (inputTokens / 1_000_000) * pricing.input_per_mtok
  const outputCost = (outputTokens / 1_000_000) * pricing.output_per_mtok
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000
}

export class OpenRouterChatClient implements ChatCompletionClient {
  private readonly apiKey: string
  private readonly model: string
  private readonly defaultReasoningEffort: ReasoningEffort
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly modelPrices: Record<string, ModelPricing>
  private readonly extraHeaders: Record<string, string>

  constructor(config: OpenRouterChatClientConfig) {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new RagError(
        'OpenRouterChatClient: apiKey vacia. Configurar OPENROUTER_API_KEY en env.',
        '<init>',
      )
    }
    this.apiKey = config.apiKey
    this.model = config.model ?? 'openai/gpt-5-mini'
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

  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const modelToUse = req.model ?? this.model
    const effort = req.reasoning_effort ?? this.defaultReasoningEffort

    const body: Record<string, unknown> = {
      model: modelToUse,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt },
      ],
      reasoning_effort: effort,
    }

    if (req.jsonSchema) {
      const safeName = req.jsonSchema.name.replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 64) || 'response'
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: safeName,
          strict: true,
          schema: req.jsonSchema.schema,
        },
      }
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
      throw new RagError(
        'OpenRouterChatClient: error de red al llamar a OpenRouter',
        '<complete>',
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
      throw new RagError(
        `OpenRouterChatClient: HTTP ${response.status} ${response.statusText}. Detail: ${detail.slice(0, 500)}`,
        '<complete>',
      )
    }

    let json: OpenRouterResponse
    try {
      json = (await response.json()) as OpenRouterResponse
    } catch (cause) {
      throw new RagError(
        'OpenRouterChatClient: respuesta no es JSON valido',
        '<complete>',
        cause,
      )
    }

    const choice = json.choices?.[0]
    const content = choice?.message?.content
    if (typeof content !== 'string' || content.length === 0) {
      throw new RagError(
        'OpenRouterChatClient: response sin choices[0].message.content valido',
        '<complete>',
      )
    }

    const pricing =
      this.modelPrices[modelToUse] ??
      this.modelPrices.default ?? { input_per_mtok: 0, output_per_mtok: 0 }
    const cost_usd = computeCost(json.usage, pricing)

    return {
      content,
      model_used: json.model ?? modelToUse,
      cost_usd,
      prompt_tokens: json.usage?.prompt_tokens ?? 0,
      completion_tokens: json.usage?.completion_tokens ?? 0,
    }
  }
}
