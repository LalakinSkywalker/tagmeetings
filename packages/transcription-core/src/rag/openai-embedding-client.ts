// =============================================================================
// OpenAIEmbeddingClient — wrapper minimo del endpoint /v1/embeddings de OpenAI
// =============================================================================
// Genera embeddings vectoriales para chunks de transcripcion (indexado) y para
// preguntas del usuario (Ask). Default `text-embedding-3-small` (1536 dim) por
// coincidir con la columna `transcripcion_chunks.embedding vector(1536)` y por
// ser ~5x mas barato que `text-embedding-3-large` con calidad equivalente para
// RAG corto de transcripciones.
//
// API: https://platform.openai.com/docs/api-reference/embeddings/create
// Pricing referencia (USD por MTok input):
//   - text-embedding-3-small: $0.02 / 1M tokens
//   - text-embedding-3-large: $0.13 / 1M tokens
//   - text-embedding-ada-002: $0.10 / 1M tokens (legacy)
//
// La key NUNCA debe llegar al cliente. Este client se instancia server-side.
// =============================================================================

import { RagError } from '../types/index'

export interface EmbeddingPricing {
  /** USD per 1M input tokens. Embeddings no tienen output tokens. */
  input_per_mtok: number
  /** Dimension del vector que produce el modelo. */
  dimensions: number
}

/**
 * Tabla de precios + dimensiones por modelo. Si el modelo no esta listado se usa
 * `default` (text-embedding-3-small). Actualizar al cambiar precios o agregar modelos.
 */
export const DEFAULT_EMBEDDING_PRICES: Record<string, EmbeddingPricing> = {
  default: { input_per_mtok: 0.02, dimensions: 1536 },
  'text-embedding-3-small': { input_per_mtok: 0.02, dimensions: 1536 },
  'text-embedding-3-large': { input_per_mtok: 0.13, dimensions: 3072 },
  'text-embedding-ada-002': { input_per_mtok: 0.1, dimensions: 1536 },
}

export interface OpenAIEmbeddingClientConfig {
  /** OpenAI API key (server-side only). */
  apiKey: string
  /** Modelo de embeddings. Default 'text-embedding-3-small'. */
  model?: string
  /** Base URL del API. Default https://api.openai.com/v1. */
  baseUrl?: string
  /** fetch-like inyectable para tests. Default globalThis.fetch. */
  fetchFn?: typeof fetch
  /** Tabla de precios. Default DEFAULT_EMBEDDING_PRICES. */
  modelPrices?: Record<string, EmbeddingPricing>
}

interface OpenAIEmbeddingResponseData {
  index: number
  embedding: number[]
  object?: string
}

interface OpenAIEmbeddingResponse {
  data?: OpenAIEmbeddingResponseData[]
  model?: string
  usage?: {
    prompt_tokens?: number
    total_tokens?: number
  }
}

/**
 * Resultado de embeddear N inputs en una sola llamada. `vectors[i]` corresponde
 * al input[i] (la API garantiza orden via el campo `index`).
 */
export interface EmbeddingBatch {
  vectors: number[][]
  /** Modelo efectivamente usado segun la respuesta del provider. */
  model_used: string
  /** Costo total acumulado de esta llamada batch. */
  cost_usd: number
  /** Tokens consumidos por la llamada (solo input — embeddings no tienen output). */
  prompt_tokens: number
}

function computeCost(promptTokens: number, pricing: EmbeddingPricing): number {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return 0
  const cost = (promptTokens / 1_000_000) * pricing.input_per_mtok
  // Round to 6 decimals (sub-cent precision sufficient).
  return Math.round(cost * 1_000_000) / 1_000_000
}

export class OpenAIEmbeddingClient {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly modelPrices: Record<string, EmbeddingPricing>

  constructor(config: OpenAIEmbeddingClientConfig) {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new RagError(
        'OpenAIEmbeddingClient: apiKey vacia. Configurar OPENAI_API_KEY en env.',
        '<init>',
      )
    }
    this.apiKey = config.apiKey
    this.model = config.model ?? 'text-embedding-3-small'
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    this.fetchFn = config.fetchFn ?? globalThis.fetch
    this.modelPrices = config.modelPrices ?? DEFAULT_EMBEDDING_PRICES
  }

  /**
   * Devuelve la dimension declarada del modelo (segun la tabla de precios) o
   * fallback a default si no esta listado. Util para validar contra el schema
   * de la tabla `transcripcion_chunks.embedding vector(N)` antes de insertar.
   */
  get expectedDimensions(): number {
    return (
      this.modelPrices[this.model]?.dimensions ??
      this.modelPrices.default?.dimensions ??
      1536
    )
  }

  /**
   * Embebe un input simple. Wrapper sobre embedBatch con un solo elemento.
   * Util para embedear la pregunta del usuario en askTranscripcion().
   */
  async embed(input: string): Promise<EmbeddingBatch> {
    if (typeof input !== 'string' || input.length === 0) {
      throw new RagError(
        'OpenAIEmbeddingClient.embed: input vacio.',
        '<embed>',
      )
    }
    return this.embedBatch([input])
  }

  /**
   * Embebe un batch de inputs en una sola llamada al API. OpenAI soporta hasta
   * 2048 inputs por request (limite del provider).
   *
   * @throws RagError si el batch esta vacio, si la API responde con error, o
   *   si la dimension del vector retornado no coincide con `expectedDimensions`.
   */
  async embedBatch(inputs: string[]): Promise<EmbeddingBatch> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new RagError(
        'OpenAIEmbeddingClient.embedBatch: inputs vacio.',
        '<embedBatch>',
      )
    }
    if (inputs.length > 2048) {
      throw new RagError(
        `OpenAIEmbeddingClient.embedBatch: ${inputs.length} inputs excede limite de 2048 por request.`,
        '<embedBatch>',
      )
    }
    for (let i = 0; i < inputs.length; i++) {
      if (typeof inputs[i] !== 'string' || inputs[i]!.length === 0) {
        throw new RagError(
          `OpenAIEmbeddingClient.embedBatch: input[${i}] no es string no-vacio.`,
          '<embedBatch>',
        )
      }
    }

    let response: Response
    try {
      response = await this.fetchFn(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: inputs,
        }),
      })
    } catch (cause) {
      throw new RagError(
        'OpenAIEmbeddingClient: error de red al llamar al endpoint /embeddings',
        '<embedBatch>',
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
        `OpenAIEmbeddingClient: HTTP ${response.status} ${response.statusText}. Detail: ${detail.slice(0, 500)}`,
        '<embedBatch>',
      )
    }

    let json: OpenAIEmbeddingResponse
    try {
      json = (await response.json()) as OpenAIEmbeddingResponse
    } catch (cause) {
      throw new RagError(
        'OpenAIEmbeddingClient: respuesta no es JSON valido',
        '<embedBatch>',
        cause,
      )
    }

    if (!Array.isArray(json.data) || json.data.length === 0) {
      throw new RagError(
        'OpenAIEmbeddingClient: response sin data[]',
        '<embedBatch>',
      )
    }

    if (json.data.length !== inputs.length) {
      throw new RagError(
        `OpenAIEmbeddingClient: cantidad de embeddings (${json.data.length}) no coincide con inputs (${inputs.length})`,
        '<embedBatch>',
      )
    }

    // Reordenar por `index` ascendente para garantizar correspondencia con inputs[i].
    const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))

    const expectedDim = this.expectedDimensions
    const vectors: number[][] = []
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i]!
      if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
        throw new RagError(
          `OpenAIEmbeddingClient: embedding[${i}] vacio o invalido`,
          '<embedBatch>',
        )
      }
      if (item.embedding.length !== expectedDim) {
        throw new RagError(
          `OpenAIEmbeddingClient: embedding[${i}] tiene ${item.embedding.length} dimensiones, esperaba ${expectedDim} para modelo ${this.model}`,
          '<embedBatch>',
        )
      }
      vectors.push(item.embedding)
    }

    const pricing =
      this.modelPrices[this.model] ??
      this.modelPrices.default ?? { input_per_mtok: 0, dimensions: expectedDim }
    const promptTokens = json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0
    const cost_usd = computeCost(promptTokens, pricing)

    return {
      vectors,
      model_used: json.model ?? this.model,
      cost_usd,
      prompt_tokens: promptTokens,
    }
  }
}
