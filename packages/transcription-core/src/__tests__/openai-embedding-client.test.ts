import { describe, expect, it, vi } from 'vitest'
import {
  OpenAIEmbeddingClient,
  DEFAULT_EMBEDDING_PRICES,
} from '../rag/openai-embedding-client'
import { RagError } from '../types/index'

function makeFakeVector(dim: number, seed = 0.1): number[] {
  return Array.from({ length: dim }, (_, i) => seed + i / 10000)
}

function mockEmbedOk(
  inputsCount: number,
  options?: {
    dim?: number
    model?: string
    promptTokens?: number
    randomizeOrder?: boolean
  },
): typeof fetch {
  const dim = options?.dim ?? 1536
  const model = options?.model ?? 'text-embedding-3-small'
  const promptTokens = options?.promptTokens ?? 100
  const indices = Array.from({ length: inputsCount }, (_, i) => i)
  const finalOrder = options?.randomizeOrder ? [...indices].reverse() : indices

  const data = finalOrder.map((index) => ({
    index,
    embedding: makeFakeVector(dim, 0.01 + index / 1000),
    object: 'embedding',
  }))

  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          object: 'list',
          data,
          model,
          usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  ) as unknown as typeof fetch
}

describe('OpenAIEmbeddingClient', () => {
  describe('constructor', () => {
    it('lanza RagError si apiKey vacia', () => {
      expect(() => new OpenAIEmbeddingClient({ apiKey: '' })).toThrow(RagError)
      expect(() => new OpenAIEmbeddingClient({ apiKey: '   ' })).toThrow(RagError)
    })

    it('default model = text-embedding-3-small con 1536 dim', () => {
      const c = new OpenAIEmbeddingClient({ apiKey: 'k' })
      expect(c.expectedDimensions).toBe(1536)
    })

    it('respeta modelo override', () => {
      const c = new OpenAIEmbeddingClient({ apiKey: 'k', model: 'text-embedding-3-large' })
      expect(c.expectedDimensions).toBe(3072)
    })

    it('modelo desconocido cae a default dim', () => {
      const c = new OpenAIEmbeddingClient({ apiKey: 'k', model: 'modelo/no-existe' })
      expect(c.expectedDimensions).toBe(1536)
    })
  })

  describe('embedBatch — happy path', () => {
    it('mapea N inputs a N vectores con orden preservado', async () => {
      const fetchFn = mockEmbedOk(3)
      const c = new OpenAIEmbeddingClient({ apiKey: 'k', fetchFn })
      const res = await c.embedBatch(['hola', 'mundo', 'tres'])
      expect(res.vectors).toHaveLength(3)
      expect(res.vectors[0]?.length).toBe(1536)
      expect(res.model_used).toBe('text-embedding-3-small')
    })

    it('reordena la respuesta por index ASC', async () => {
      const fetchFn = mockEmbedOk(3, { randomizeOrder: true })
      const c = new OpenAIEmbeddingClient({ apiKey: 'k', fetchFn })
      const res = await c.embedBatch(['a', 'b', 'c'])
      // index 0 corresponde a 'a', su seed era 0.01
      expect(res.vectors[0]?.[0]).toBeCloseTo(0.01, 5)
      expect(res.vectors[1]?.[0]).toBeCloseTo(0.011, 5)
      expect(res.vectors[2]?.[0]).toBeCloseTo(0.012, 5)
    })

    it('calcula cost_usd correctamente', async () => {
      const fetchFn = mockEmbedOk(1, { promptTokens: 1_000_000 })
      const c = new OpenAIEmbeddingClient({ apiKey: 'k', fetchFn })
      const res = await c.embedBatch(['x'])
      // 1M * $0.02 / 1M = $0.02
      expect(res.cost_usd).toBeCloseTo(0.02, 5)
      expect(res.prompt_tokens).toBe(1_000_000)
    })

    it('embed() simple wrapper sobre embedBatch', async () => {
      const fetchFn = mockEmbedOk(1)
      const c = new OpenAIEmbeddingClient({ apiKey: 'k', fetchFn })
      const res = await c.embed('pregunta sola')
      expect(res.vectors).toHaveLength(1)
    })

    it('arma request con auth header + modelo + array de inputs', async () => {
      let captured: { url: string; body: string; headers: Record<string, string> } = {
        url: '',
        body: '',
        headers: {},
      }
      const fetchFn = vi.fn(async (url, init) => {
        captured = {
          url: String(url),
          body: (init?.body as string) ?? '',
          headers: (init?.headers as Record<string, string>) ?? {},
        }
        return new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: makeFakeVector(1536) }],
            model: 'text-embedding-3-small',
            usage: { prompt_tokens: 10 },
          }),
          { status: 200 },
        )
      }) as unknown as typeof fetch

      const c = new OpenAIEmbeddingClient({ apiKey: 'mykey', fetchFn })
      await c.embed('hola')

      expect(captured.url).toContain('/embeddings')
      expect(captured.headers.Authorization).toBe('Bearer mykey')
      const body = JSON.parse(captured.body)
      expect(body.model).toBe('text-embedding-3-small')
      expect(body.input).toEqual(['hola'])
    })
  })

  describe('embedBatch — validacion de input', () => {
    it('lanza RagError con array vacio', async () => {
      const c = new OpenAIEmbeddingClient({ apiKey: 'k' })
      await expect(c.embedBatch([])).rejects.toThrow(RagError)
    })

    it('lanza RagError con input no-string', async () => {
      const c = new OpenAIEmbeddingClient({ apiKey: 'k' })
      // @ts-expect-error testing runtime guard
      await expect(c.embedBatch([123, 'ok'])).rejects.toThrow(RagError)
    })

    it('lanza RagError con string vacio', async () => {
      const c = new OpenAIEmbeddingClient({ apiKey: 'k' })
      await expect(c.embedBatch(['', 'ok'])).rejects.toThrow(RagError)
    })

    it('lanza RagError con > 2048 inputs', async () => {
      const c = new OpenAIEmbeddingClient({ apiKey: 'k' })
      const big = Array.from({ length: 2049 }, () => 'x')
      await expect(c.embedBatch(big)).rejects.toThrow(RagError)
    })

    it('embed() rechaza string vacio', async () => {
      const c = new OpenAIEmbeddingClient({ apiKey: 'k' })
      await expect(c.embed('')).rejects.toThrow(RagError)
    })
  })

  describe('embedBatch — errores', () => {
    it('HTTP 401 -> RagError con detalle', async () => {
      const fetchFn = vi.fn(
        async () =>
          new Response('{"error":"invalid_api_key"}', {
            status: 401,
            statusText: 'Unauthorized',
          }),
      ) as unknown as typeof fetch
      const c = new OpenAIEmbeddingClient({ apiKey: 'k', fetchFn })
      await expect(c.embed('hola')).rejects.toThrowError(/HTTP 401.*invalid_api_key/)
    })

    it('network error -> RagError', async () => {
      const fetchFn = vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch
      const c = new OpenAIEmbeddingClient({ apiKey: 'k', fetchFn })
      await expect(c.embed('hola')).rejects.toThrowError(/error de red/)
    })

    it('response sin data -> RagError', async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ model: 'm' }), { status: 200 }),
      ) as unknown as typeof fetch
      const c = new OpenAIEmbeddingClient({ apiKey: 'k', fetchFn })
      await expect(c.embed('hola')).rejects.toThrowError(/sin data/)
    })

    it('embedding con dim distinta lanza RagError', async () => {
      const fetchFn = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ index: 0, embedding: makeFakeVector(512) }],
              model: 'text-embedding-3-small',
              usage: { prompt_tokens: 1 },
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch
      const c = new OpenAIEmbeddingClient({ apiKey: 'k', fetchFn })
      await expect(c.embed('hola')).rejects.toThrowError(/512 dimensiones, esperaba 1536/)
    })

    it('cantidad de embeddings distinta a inputs lanza RagError', async () => {
      const fetchFn = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ index: 0, embedding: makeFakeVector(1536) }],
              model: 'text-embedding-3-small',
              usage: { prompt_tokens: 1 },
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch
      const c = new OpenAIEmbeddingClient({ apiKey: 'k', fetchFn })
      await expect(c.embedBatch(['a', 'b'])).rejects.toThrowError(/no coincide con inputs/)
    })
  })

  describe('pricing table', () => {
    it('text-embedding-3-small tiene precio $0.02/MTok', () => {
      expect(DEFAULT_EMBEDDING_PRICES['text-embedding-3-small']?.input_per_mtok).toBe(0.02)
    })

    it('text-embedding-3-large tiene dim 3072', () => {
      expect(DEFAULT_EMBEDDING_PRICES['text-embedding-3-large']?.dimensions).toBe(3072)
    })
  })
})
