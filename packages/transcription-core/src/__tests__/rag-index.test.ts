import { describe, expect, it, vi } from 'vitest'
import {
  PgvectorRagIndex,
  chunkBySpeakerTurn,
  DEFAULT_MAX_CHUNK_CHARS,
  MockRagIndex,
} from '../rag/rag-index'
import { OpenAIEmbeddingClient } from '../rag/openai-embedding-client'
import { OpenRouterChatClient } from '../rag/openrouter-chat-client'
import { RagError } from '../types/index'
import type { TranscriptSegment } from '../types/index'
import type {
  ChatCompletionClient,
  ChatCompletionRequest,
  ChatCompletionResult,
} from '../rag/openrouter-chat-client'
import type { MinimalSupabaseRagClient } from '../rag/rag-index'

// =============================================================================
// Helpers compartidos
// =============================================================================

const VALID_UUID = '11111111-1111-1111-1111-111111111111'
const ANOTHER_UUID = '22222222-2222-2222-2222-222222222222'
const TRANSCRIPCION_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function vec(seed: number, dim = 1536): number[] {
  return Array.from({ length: dim }, (_, i) => seed + i / 100000)
}

function mockEmbeddingFetch(count: number, tokens = 50): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: Array.from({ length: count }, (_, i) => ({
            index: i,
            embedding: vec(0.001 + i / 1000),
          })),
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: tokens },
        }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch
}

function makeEmbeddingClient(fetchFn: typeof fetch): OpenAIEmbeddingClient {
  return new OpenAIEmbeddingClient({ apiKey: 'k', fetchFn })
}

function makeStubChatClient(
  answer = 'Respuesta de prueba.',
  usedChunkIndexes: number[] = [1],
): ChatCompletionClient {
  return {
    complete: vi.fn(
      async (_req: ChatCompletionRequest): Promise<ChatCompletionResult> => ({
        content: JSON.stringify({
          answer,
          used_chunk_indexes: usedChunkIndexes,
        }),
        model_used: 'openai/gpt-5-mini',
        cost_usd: 0.000123,
        prompt_tokens: 80,
        completion_tokens: 40,
      }),
    ),
  }
}

function makeStubSupabaseClient(opts?: {
  rpcRows?: Array<Record<string, unknown>>
  rpcError?: { message: string }
  insertError?: { message: string }
  deleteError?: { message: string }
  inserts?: Array<Record<string, unknown>[]>
  deletes?: Array<{ column: string; value: unknown }>
  rpcCalls?: Array<{ fn: string; args: Record<string, unknown> }>
}): MinimalSupabaseRagClient {
  const inserts = opts?.inserts ?? []
  const deletes = opts?.deletes ?? []
  const rpcCalls = opts?.rpcCalls ?? []

  const client: MinimalSupabaseRagClient = {
    from: vi.fn((_table: string) => ({
      insert: vi.fn(async (rows: Record<string, unknown>[]) => {
        inserts.push(rows)
        return { data: rows, error: opts?.insertError ?? null }
      }),
      delete: vi.fn(() => ({
        eq: vi.fn(async (column: string, value: unknown) => {
          deletes.push({ column, value })
          return { data: null, error: opts?.deleteError ?? null }
        }),
      })),
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(async () => ({ data: [], error: null })),
        })),
      })),
    })),
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return {
        data: opts?.rpcRows ?? null,
        error: opts?.rpcError ?? null,
      }
    }),
  }
  return client
}

const TWO_SPEAKER_SEGMENTS: TranscriptSegment[] = [
  {
    speaker: { id: 0 },
    text: 'Hola Daniel, gracias por aceptar la reunion.',
    start_ms: 0,
    end_ms: 3000,
    confidence: 0.97,
  },
  {
    speaker: { id: 0 },
    text: 'Queria empezar contandote que hacemos en Bluntag.',
    start_ms: 3000,
    end_ms: 7000,
    confidence: 0.97,
  },
  {
    speaker: { id: 1 },
    text: 'Claro, perfecto. Te escucho.',
    start_ms: 7200,
    end_ms: 9000,
    confidence: 0.96,
  },
  {
    speaker: { id: 0 },
    text: 'Construimos soluciones a medida con IA para empresas medianas.',
    start_ms: 9200,
    end_ms: 13000,
    confidence: 0.96,
  },
]

// =============================================================================
// chunkBySpeakerTurn
// =============================================================================

describe('chunkBySpeakerTurn', () => {
  it('lanza RagError si segments vacio', () => {
    expect(() => chunkBySpeakerTurn([])).toThrow(RagError)
  })

  it('lanza RagError si maxChars absurdo', () => {
    expect(() => chunkBySpeakerTurn(TWO_SPEAKER_SEGMENTS, 50)).toThrow(RagError)
  })

  it('agrupa segments contiguos del mismo speaker', () => {
    const chunks = chunkBySpeakerTurn(TWO_SPEAKER_SEGMENTS)
    expect(chunks).toHaveLength(3)
    // Chunk 0: Speaker 0 con los dos primeros segments coalesced
    expect(chunks[0]?.speaker_id).toBe(0)
    expect(chunks[0]?.text).toContain('gracias por aceptar')
    expect(chunks[0]?.text).toContain('contandote que hacemos')
    expect(chunks[0]?.start_ms).toBe(0)
    expect(chunks[0]?.end_ms).toBe(7000)
    expect(chunks[0]?.chunk_index).toBe(0)
    // Chunk 1: Speaker 1
    expect(chunks[1]?.speaker_id).toBe(1)
    expect(chunks[1]?.text).toBe('Claro, perfecto. Te escucho.')
    expect(chunks[1]?.chunk_index).toBe(1)
    // Chunk 2: Speaker 0 de nuevo (turn distinto)
    expect(chunks[2]?.speaker_id).toBe(0)
    expect(chunks[2]?.text).toContain('soluciones a medida')
    expect(chunks[2]?.chunk_index).toBe(2)
  })

  it('parte mismo speaker si excede cap soft', () => {
    const longText = 'a'.repeat(800)
    const segs: TranscriptSegment[] = [
      { speaker: { id: 0 }, text: longText, start_ms: 0, end_ms: 1000, confidence: 1 },
      { speaker: { id: 0 }, text: longText, start_ms: 1000, end_ms: 2000, confidence: 1 },
      { speaker: { id: 0 }, text: longText, start_ms: 2000, end_ms: 3000, confidence: 1 },
    ]
    // maxChars = 1000 -> primer chunk acumula 800, +800 = 1600 supera cap -> nuevo chunk
    const chunks = chunkBySpeakerTurn(segs, 1000)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    chunks.forEach((c) => {
      expect(c.text.length).toBeLessThanOrEqual(1000)
      expect(c.speaker_id).toBe(0)
    })
  })

  it('parte segment individual demasiado grande conservando rango', () => {
    const huge = 'x'.repeat(5000)
    const segs: TranscriptSegment[] = [
      { speaker: { id: 0 }, text: huge, start_ms: 0, end_ms: 10000, confidence: 1 },
    ]
    const chunks = chunkBySpeakerTurn(segs, 1000)
    expect(chunks.length).toBe(5)
    expect(chunks[0]?.start_ms).toBe(0)
    expect(chunks[4]?.end_ms).toBe(10000)
    chunks.forEach((c) => {
      expect(c.text.length).toBeLessThanOrEqual(1000)
    })
  })

  it('chunk_index secuencial desde 0', () => {
    const chunks = chunkBySpeakerTurn(TWO_SPEAKER_SEGMENTS)
    chunks.forEach((c, i) => {
      expect(c.chunk_index).toBe(i)
    })
  })

  it('cap default 2000 chars', () => {
    expect(DEFAULT_MAX_CHUNK_CHARS).toBe(2000)
  })
})

// =============================================================================
// PgvectorRagIndex — constructor
// =============================================================================

describe('PgvectorRagIndex constructor', () => {
  const emb = makeEmbeddingClient(mockEmbeddingFetch(1))
  const chat = makeStubChatClient()

  it('lanza RagError si supabaseClient invalido', () => {
    expect(
      () =>
        new PgvectorRagIndex({
          supabaseClient: {} as MinimalSupabaseRagClient,
          embeddingClient: emb,
          chatClient: chat,
        }),
    ).toThrow(RagError)
  })

  it('lanza RagError si embeddingClient ausente', () => {
    expect(
      () =>
        new PgvectorRagIndex({
          supabaseClient: makeStubSupabaseClient(),
          embeddingClient: undefined as unknown as OpenAIEmbeddingClient,
          chatClient: chat,
        }),
    ).toThrow(RagError)
  })

  it('lanza RagError si chatClient invalido', () => {
    expect(
      () =>
        new PgvectorRagIndex({
          supabaseClient: makeStubSupabaseClient(),
          embeddingClient: emb,
          chatClient: {} as ChatCompletionClient,
        }),
    ).toThrow(RagError)
  })

  it('acepta config minima', () => {
    const idx = new PgvectorRagIndex({
      supabaseClient: makeStubSupabaseClient(),
      embeddingClient: emb,
      chatClient: chat,
    })
    expect(idx).toBeDefined()
  })
})

// =============================================================================
// PgvectorRagIndex.index() — happy path + errores
// =============================================================================

describe('PgvectorRagIndex.index', () => {
  it('rechaza transcriptionId invalido', async () => {
    const idx = new PgvectorRagIndex({
      supabaseClient: makeStubSupabaseClient(),
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: makeStubChatClient(),
    })
    await expect(idx.index('x', TWO_SPEAKER_SEGMENTS, { ownerUserId: VALID_UUID })).rejects.toThrow(
      RagError,
    )
  })

  it('rechaza si ownerUserId ausente', async () => {
    const idx = new PgvectorRagIndex({
      supabaseClient: makeStubSupabaseClient(),
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: makeStubChatClient(),
    })
    await expect(idx.index(TRANSCRIPCION_UUID, TWO_SPEAKER_SEGMENTS)).rejects.toThrowError(
      /ownerUserId/,
    )
  })

  it('chunkea + embebe + inserta con user_id correcto', async () => {
    const inserts: Array<Record<string, unknown>[]> = []
    const deletes: Array<{ column: string; value: unknown }> = []
    const client = makeStubSupabaseClient({ inserts, deletes })

    // 3 chunks esperados con TWO_SPEAKER_SEGMENTS
    const emb = makeEmbeddingClient(mockEmbeddingFetch(3, 120))
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: emb,
      chatClient: makeStubChatClient(),
    })

    const res = await idx.index(TRANSCRIPCION_UUID, TWO_SPEAKER_SEGMENTS, {
      ownerUserId: VALID_UUID,
    })

    // Result shape
    expect(res.chunks_inserted).toBe(3)
    expect(res.prompt_tokens).toBe(120)
    expect(res.model_used).toBe('text-embedding-3-small')
    expect(res.cost_usd).toBeGreaterThan(0)

    // Delete previo idempotente
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toEqual({ column: 'transcripcion_id', value: TRANSCRIPCION_UUID })

    // Insert con user_id propagado + speaker_id propagado
    expect(inserts).toHaveLength(1)
    const rows = inserts[0]!
    expect(rows).toHaveLength(3)
    rows.forEach((row, i) => {
      expect(row.transcripcion_id).toBe(TRANSCRIPCION_UUID)
      expect(row.user_id).toBe(VALID_UUID)
      expect(row.chunk_index).toBe(i)
      expect(row.embedding).toBeDefined()
      expect(Array.isArray(row.embedding)).toBe(true)
      expect(typeof row.speaker_id).toBe('number')
    })
    // Speakers de los chunks coalesced
    expect(rows[0]?.speaker_id).toBe(0)
    expect(rows[1]?.speaker_id).toBe(1)
    expect(rows[2]?.speaker_id).toBe(0)
  })

  it('si delete previo falla -> RagError', async () => {
    const client = makeStubSupabaseClient({
      deleteError: { message: 'permiso denegado' },
    })
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(3)),
      chatClient: makeStubChatClient(),
    })
    await expect(
      idx.index(TRANSCRIPCION_UUID, TWO_SPEAKER_SEGMENTS, { ownerUserId: VALID_UUID }),
    ).rejects.toThrowError(/delete previo fallo/)
  })

  it('si insert falla -> RagError', async () => {
    const client = makeStubSupabaseClient({
      insertError: { message: 'check constraint failed' },
    })
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(3)),
      chatClient: makeStubChatClient(),
    })
    await expect(
      idx.index(TRANSCRIPCION_UUID, TWO_SPEAKER_SEGMENTS, { ownerUserId: VALID_UUID }),
    ).rejects.toThrowError(/insert fallo/)
  })

  it('si embedding API falla -> RagError', async () => {
    const failingFetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch

    const idx = new PgvectorRagIndex({
      supabaseClient: makeStubSupabaseClient(),
      embeddingClient: new OpenAIEmbeddingClient({ apiKey: 'k', fetchFn: failingFetch }),
      chatClient: makeStubChatClient(),
    })
    await expect(
      idx.index(TRANSCRIPCION_UUID, TWO_SPEAKER_SEGMENTS, { ownerUserId: VALID_UUID }),
    ).rejects.toThrow(RagError)
  })
})

// =============================================================================
// PgvectorRagIndex.ask() — happy path + errores + cross-tenant
// =============================================================================

describe('PgvectorRagIndex.ask', () => {
  it('rechaza pregunta vacia', async () => {
    const idx = new PgvectorRagIndex({
      supabaseClient: makeStubSupabaseClient(),
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: makeStubChatClient(),
    })
    await expect(idx.ask(TRANSCRIPCION_UUID, '   ')).rejects.toThrow(RagError)
  })

  it('rechaza pregunta > 2000 chars', async () => {
    const idx = new PgvectorRagIndex({
      supabaseClient: makeStubSupabaseClient(),
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: makeStubChatClient(),
    })
    await expect(idx.ask(TRANSCRIPCION_UUID, 'x'.repeat(2001))).rejects.toThrow(RagError)
  })

  it('si rpc devuelve 0 chunks -> respuesta "no encuentro informacion"', async () => {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
    const client = makeStubSupabaseClient({ rpcRows: [], rpcCalls })
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: makeStubChatClient(),
    })
    const res = await idx.ask(TRANSCRIPCION_UUID, 'cual fue el budget?')
    expect(res.answer.toLowerCase()).toContain('no encuentro')
    expect(res.citations).toHaveLength(0)
    expect(rpcCalls[0]?.fn).toBe('search_chunks')
    expect(rpcCalls[0]?.args.p_transcripcion_id).toBe(TRANSCRIPCION_UUID)
    expect(rpcCalls[0]?.args.p_match_count).toBe(8)
  })

  it('happy path: solo cita los chunks que el LLM declara como sustento (filtra el ruido)', async () => {
    const stubRows = [
      {
        chunk_id: 'c1',
        text: 'El budget mencionado fue 50 mil pesos.',
        start_ms: 1000,
        end_ms: 4000,
        speaker_id: 1,
        similarity: 0.92,
      },
      {
        chunk_id: 'c2',
        text: 'Tambien hablaron de 80 mil pero descartado.',
        start_ms: 8000,
        end_ms: 11000,
        speaker_id: 0,
        similarity: 0.71,
      },
      {
        chunk_id: 'c3',
        text: 'Saludo inicial sin relacion al budget.',
        start_ms: 0,
        end_ms: 500,
        speaker_id: 0,
        similarity: 0.5,
      },
    ]
    const client = makeStubSupabaseClient({ rpcRows: stubRows })
    // LLM declara solo chunk 1 como sustento (NO chunks 2 ni 3 que son ruido).
    const chat = makeStubChatClient(
      'El budget mencionado fue "50 mil pesos" segun Speaker 1.',
      [1],
    )
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1, 30)),
      chatClient: chat,
    })

    const res = await idx.ask(TRANSCRIPCION_UUID, 'cual fue el budget mencionado?')

    expect(res.answer).toContain('50 mil pesos')
    // SOLO 1 cita — la que el LLM realmente uso, no las 3 recuperadas
    expect(res.citations).toHaveLength(1)
    expect(res.citations[0]).toEqual({
      text: 'El budget mencionado fue 50 mil pesos.',
      start_ms: 1000,
      end_ms: 4000,
      speaker: { id: 1 },
    })
    expect(res.model_used).toBe('openai/gpt-5-mini')
    expect(res.cost_usd).toBeGreaterThan(0)
  })

  it('multiples chunks usados se devuelven todos pero filtrados', async () => {
    const stubRows = [
      { chunk_id: 'c1', text: 'A', start_ms: 0, end_ms: 100, speaker_id: 0, similarity: 0.9 },
      { chunk_id: 'c2', text: 'B', start_ms: 100, end_ms: 200, speaker_id: 1, similarity: 0.85 },
      { chunk_id: 'c3', text: 'C ruido', start_ms: 200, end_ms: 300, speaker_id: 0, similarity: 0.6 },
      { chunk_id: 'c4', text: 'D', start_ms: 300, end_ms: 400, speaker_id: 1, similarity: 0.55 },
    ]
    const client = makeStubSupabaseClient({ rpcRows: stubRows })
    // LLM dice que uso chunks 1, 2, 4 (no 3 que es ruido)
    const chat = makeStubChatClient('respuesta usando A, B, D', [1, 2, 4])
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: chat,
    })
    const res = await idx.ask(TRANSCRIPCION_UUID, 'pregunta')
    expect(res.citations).toHaveLength(3)
    expect(res.citations.map((c) => c.text)).toEqual(['A', 'B', 'D'])
  })

  it('citations vacias si el LLM declara used_chunk_indexes vacio (no encuentra info)', async () => {
    const stubRows = [
      { chunk_id: 'c1', text: 'Algo irrelevante', start_ms: 0, end_ms: 1000, speaker_id: 0, similarity: 0.4 },
    ]
    const client = makeStubSupabaseClient({ rpcRows: stubRows })
    const chat = makeStubChatClient('No encuentro esa informacion en la transcripcion.', [])
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: chat,
    })
    const res = await idx.ask(TRANSCRIPCION_UUID, 'pregunta sin respuesta')
    expect(res.citations).toHaveLength(0)
    expect(res.answer).toContain('No encuentro')
  })

  it('indexes fuera de rango se descartan silenciosamente', async () => {
    const stubRows = [
      { chunk_id: 'c1', text: 'A', start_ms: 0, end_ms: 100, speaker_id: 0, similarity: 0.9 },
    ]
    const client = makeStubSupabaseClient({ rpcRows: stubRows })
    // LLM alucina indices 5 y 99 que no existen
    const chat = makeStubChatClient('respuesta', [1, 5, 99])
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: chat,
    })
    const res = await idx.ask(TRANSCRIPCION_UUID, 'pregunta')
    expect(res.citations).toHaveLength(1)
    expect(res.citations[0]?.text).toBe('A')
  })

  it('indexes duplicados se deduplican', async () => {
    const stubRows = [
      { chunk_id: 'c1', text: 'A', start_ms: 0, end_ms: 100, speaker_id: 0, similarity: 0.9 },
      { chunk_id: 'c2', text: 'B', start_ms: 100, end_ms: 200, speaker_id: 1, similarity: 0.85 },
    ]
    const client = makeStubSupabaseClient({ rpcRows: stubRows })
    const chat = makeStubChatClient('respuesta', [1, 1, 2, 2])
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: chat,
    })
    const res = await idx.ask(TRANSCRIPCION_UUID, 'pregunta')
    expect(res.citations).toHaveLength(2)
  })

  it('citations sin speaker si la fila no trae speaker_id', async () => {
    const stubRows = [
      {
        chunk_id: 'c1',
        text: 'Solo texto sin speaker.',
        start_ms: 0,
        end_ms: 1000,
        similarity: 0.5,
      },
    ]
    const client = makeStubSupabaseClient({ rpcRows: stubRows })
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: makeStubChatClient('respuesta', [1]),
    })
    const res = await idx.ask(TRANSCRIPCION_UUID, 'pregunta')
    expect(res.citations[0]?.speaker).toBeUndefined()
  })

  it('pasa jsonSchema al chat client en el request', async () => {
    const stubRows = [
      { chunk_id: 'c1', text: 'A', start_ms: 0, end_ms: 100, speaker_id: 0, similarity: 0.9 },
    ]
    const client = makeStubSupabaseClient({ rpcRows: stubRows })
    let capturedReq: ChatCompletionRequest | null = null
    const chat: ChatCompletionClient = {
      complete: vi.fn(async (req: ChatCompletionRequest) => {
        capturedReq = req
        return {
          content: JSON.stringify({ answer: 'r', used_chunk_indexes: [1] }),
          model_used: 'openai/gpt-5-mini',
          cost_usd: 0.0001,
          prompt_tokens: 50,
          completion_tokens: 10,
        }
      }),
    }
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: chat,
    })
    await idx.ask(TRANSCRIPCION_UUID, 'pregunta')
    expect(capturedReq).not.toBeNull()
    const req = capturedReq as unknown as ChatCompletionRequest
    expect(req.jsonSchema).toBeDefined()
    expect(req.jsonSchema?.name).toBe('ask_response')
    expect(req.jsonSchema?.schema).toHaveProperty('properties.answer')
    expect(req.jsonSchema?.schema).toHaveProperty('properties.used_chunk_indexes')
  })

  it('JSON LLM no parseable -> RagError', async () => {
    const stubRows = [
      { chunk_id: 'c1', text: 'A', start_ms: 0, end_ms: 100, speaker_id: 0, similarity: 0.9 },
    ]
    const client = makeStubSupabaseClient({ rpcRows: stubRows })
    const chat: ChatCompletionClient = {
      complete: vi.fn(async () => ({
        content: 'esto no es json',
        model_used: 'm',
        cost_usd: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
      })),
    }
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: chat,
    })
    await expect(idx.ask(TRANSCRIPCION_UUID, 'pregunta')).rejects.toThrowError(/JSON no parseable/)
  })

  it('answer vacio del LLM -> RagError', async () => {
    const stubRows = [
      { chunk_id: 'c1', text: 'A', start_ms: 0, end_ms: 100, speaker_id: 0, similarity: 0.9 },
    ]
    const client = makeStubSupabaseClient({ rpcRows: stubRows })
    const chat: ChatCompletionClient = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ answer: '   ', used_chunk_indexes: [] }),
        model_used: 'm',
        cost_usd: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
      })),
    }
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: chat,
    })
    await expect(idx.ask(TRANSCRIPCION_UUID, 'pregunta')).rejects.toThrowError(/answer vacio/)
  })

  it('si rpc retorna error -> RagError', async () => {
    const client = makeStubSupabaseClient({
      rpcError: { message: 'function does not exist' },
    })
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: makeStubChatClient(),
    })
    await expect(idx.ask(TRANSCRIPCION_UUID, 'que paso?')).rejects.toThrowError(
      /rpc search_chunks fallo/,
    )
  })

  it('respeta searchRpcName + tableName custom (otro proyecto-style)', async () => {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
    const client = makeStubSupabaseClient({ rpcRows: [], rpcCalls })
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: makeStubChatClient(),
      tableName: 'consulta_chunks',
      searchRpcName: 'buscar_consulta',
    })
    await idx.ask(TRANSCRIPCION_UUID, 'que paso?')
    expect(rpcCalls[0]?.fn).toBe('buscar_consulta')
  })
})

// =============================================================================
// MockRagIndex (sigue existiendo y funcional)
// =============================================================================

describe('MockRagIndex backward-compat', () => {
  it('index + ask funcionan deterministic', async () => {
    const m = new MockRagIndex()
    const res = await m.index('tid', TWO_SPEAKER_SEGMENTS, { ownerUserId: VALID_UUID })
    expect(res.chunks_inserted).toBe(4)
    expect(res.model_used).toBe('mock')

    const ask = await m.ask('tid', 'cual fue el budget?')
    expect(ask.citations).toHaveLength(1)
    expect(ask.answer.startsWith('[MOCK]')).toBe(true)
  })

  it('ask sin index previo devuelve mensaje canned', async () => {
    const m = new MockRagIndex()
    const ask = await m.ask('no-existe', 'pregunta')
    expect(ask.citations).toHaveLength(0)
    expect(ask.answer).toContain('No hay datos indexados')
  })
})

// =============================================================================
// OpenRouterChatClient — smoke (la mayoria de la lógica es paralela a
// LLMAnalysisEngine ya cubierto en su propio test).
// =============================================================================

describe('OpenRouterChatClient', () => {
  it('lanza RagError si apiKey vacia', () => {
    expect(() => new OpenRouterChatClient({ apiKey: '' })).toThrow(RagError)
  })

  it('complete() arma request + parsea respuesta + calcula cost', async () => {
    let capturedBody = ''
    const fetchFn = vi.fn(async (_url, init) => {
      capturedBody = init?.body as string
      return new Response(
        JSON.stringify({
          model: 'openai/gpt-5-mini',
          usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
          choices: [{ message: { content: 'respuesta corta' } }],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const c = new OpenRouterChatClient({ apiKey: 'k', fetchFn })
    const res = await c.complete({ systemPrompt: 'sys', userPrompt: 'user' })

    expect(res.content).toBe('respuesta corta')
    expect(res.model_used).toBe('openai/gpt-5-mini')
    // 1M input * $0.25 = $0.25
    expect(res.cost_usd).toBeCloseTo(0.25, 4)
    expect(res.prompt_tokens).toBe(1_000_000)

    const body = JSON.parse(capturedBody)
    expect(body.model).toBe('openai/gpt-5-mini')
    expect(body.reasoning_effort).toBe('minimal')
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1].content).toBe('user')
  })

  it('HTTP 401 -> RagError', async () => {
    const fetchFn = vi.fn(
      async () => new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }),
    ) as unknown as typeof fetch
    const c = new OpenRouterChatClient({ apiKey: 'k', fetchFn })
    await expect(
      c.complete({ systemPrompt: 's', userPrompt: 'u' }),
    ).rejects.toThrowError(/HTTP 401/)
  })

  it('content no-string -> RagError', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: 'openai/gpt-5-mini',
            choices: [{ message: { content: null } }],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch
    const c = new OpenRouterChatClient({ apiKey: 'k', fetchFn })
    await expect(
      c.complete({ systemPrompt: 's', userPrompt: 'u' }),
    ).rejects.toThrowError(/content valido/)
  })
})

// =============================================================================
// Marcador semantico de cross-tenant: el RPC search_chunks tiene auth.uid()
// interno; los tests anteriores comprueban que el PgvectorRagIndex.ask() pasa
// p_transcripcion_id pero NO p_user_id. La defense in depth es responsabilidad
// del DB (RLS + filtro RPC). El test cross-tenant REAL contra el RPC se hace
// en Sub-fase D con 2 usuarios reales.
// =============================================================================

describe('cross-tenant defense in depth (contract)', () => {
  it('ask() NO pasa user_id al RPC — depende de auth.uid() del cliente', async () => {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
    const client = makeStubSupabaseClient({ rpcRows: [], rpcCalls })
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(1)),
      chatClient: makeStubChatClient(),
    })
    await idx.ask(TRANSCRIPCION_UUID, 'que paso?')
    expect(rpcCalls[0]?.args.p_user_id).toBeUndefined()
    expect(rpcCalls[0]?.args).toHaveProperty('p_transcripcion_id')
    expect(rpcCalls[0]?.args).toHaveProperty('p_query_embedding')
    expect(rpcCalls[0]?.args).toHaveProperty('p_match_count')
  })

  it('index() requiere ownerUserId explicito y NO lo deriva de un default', async () => {
    const inserts: Array<Record<string, unknown>[]> = []
    const client = makeStubSupabaseClient({ inserts })
    const idx = new PgvectorRagIndex({
      supabaseClient: client,
      embeddingClient: makeEmbeddingClient(mockEmbeddingFetch(3)),
      chatClient: makeStubChatClient(),
    })
    await idx.index(TRANSCRIPCION_UUID, TWO_SPEAKER_SEGMENTS, { ownerUserId: ANOTHER_UUID })
    expect(inserts[0]?.[0]?.user_id).toBe(ANOTHER_UUID)
  })
})
