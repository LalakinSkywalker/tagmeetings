import { describe, expect, it, vi } from 'vitest'
import {
  LLMAnalysisEngine,
  DEFAULT_MODEL_PRICES,
} from '../engines/llm-analysis-engine'
import { PLANTILLA_DISCOVERY, PLANTILLA_IDEA_SUELTA } from '../templates/templates'
import { AnalysisError } from '../types/index'
import type { TranscriptionResult } from '../types/index'

const SAMPLE_TRANSCRIPTION: TranscriptionResult = {
  segments: [
    {
      speaker: { id: 0 },
      text: 'Hola, gracias por el espacio. Vengo a contarte el dolor que tenemos con cotizaciones.',
      start_ms: 0,
      end_ms: 5000,
      confidence: 0.95,
    },
    {
      speaker: { id: 1 },
      text: 'Cuentame mas, cual es exactamente el problema.',
      start_ms: 5200,
      end_ms: 7800,
      confidence: 0.96,
    },
  ],
  language: 'es-MX',
  duration_ms: 7800,
  raw_text: 'Hola, gracias por el espacio. Cuentame mas.',
  provider: 'mock',
}

const VALID_DISCOVERY_JSON = {
  resumen: 'Reunion con prospecto sobre cotizaciones. Prospecto presento dolor real.',
  bullets: [
    'Speaker 0 introduce problema de cotizaciones',
    'Speaker 1 pide profundizar',
  ],
  action_items: [
    {
      texto: 'Mandar propuesta de POC al prospecto',
      due_date: null,
      owner: 'Speaker 1',
    },
  ],
  categoria: 'discovery',
  pain_points: ['Dolor con cotizaciones'],
  budget_signals: [],
  alternatives_evaluated: [],
  buy_signals: [],
  nivel_interes: 'tibio',
}

function mockFetchOk(body: unknown, usage = { prompt_tokens: 500, completion_tokens: 200 }): typeof fetch {
  const openrouterResponse = {
    model: 'openai/gpt-5-mini',
    usage,
    choices: [
      {
        message: { content: JSON.stringify(body) },
        finish_reason: 'stop',
      },
    ],
  }
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(openrouterResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as unknown as typeof fetch
  return fn
}

describe('LLMAnalysisEngine', () => {
  describe('constructor', () => {
    it('lanza AnalysisError si apiKey vacia', () => {
      expect(() => new LLMAnalysisEngine({ apiKey: '', model: 'openai/gpt-5-mini' })).toThrow(
        AnalysisError,
      )
      expect(() => new LLMAnalysisEngine({ apiKey: '   ', model: 'openai/gpt-5-mini' })).toThrow(
        AnalysisError,
      )
    })

    it('lanza AnalysisError si model vacio', () => {
      expect(() => new LLMAnalysisEngine({ apiKey: 'k', model: '' })).toThrow(AnalysisError)
    })

    it('acepta config minima', () => {
      const e = new LLMAnalysisEngine({ apiKey: 'k', model: 'openai/gpt-5-mini' })
      expect(e).toBeDefined()
    })
  })

  describe('analyze — happy path', () => {
    it('parsea respuesta OpenRouter y mapea a AnalysisResult con custom_fields', async () => {
      const fetchFn = mockFetchOk(VALID_DISCOVERY_JSON)
      const engine = new LLMAnalysisEngine({
        apiKey: 'k',
        model: 'openai/gpt-5-mini',
        fetchFn,
      })

      const result = await engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY)

      expect(result.template_id).toBe('discovery')
      expect(result.resumen).toBe(VALID_DISCOVERY_JSON.resumen)
      expect(result.bullets).toHaveLength(2)
      expect(result.action_items).toHaveLength(1)
      expect(result.action_items[0]?.texto).toBe('Mandar propuesta de POC al prospecto')
      expect(result.action_items[0]?.owner).toBe('Speaker 1')
      expect(result.categoria).toBe('discovery')
      expect(result.model_used).toBe('openai/gpt-5-mini')
      expect(result.custom_fields.pain_points).toEqual(['Dolor con cotizaciones'])
      expect(result.custom_fields.nivel_interes).toBe('tibio')
      // Base fields NO deben aparecer dentro de custom_fields
      expect(result.custom_fields.resumen).toBeUndefined()
      expect(result.custom_fields.bullets).toBeUndefined()
    })

    it('calcula cost_usd correctamente desde usage', async () => {
      // 1M input tokens * $0.25 + 1M output tokens * $2.00 = $2.25
      const fetchFn = mockFetchOk(VALID_DISCOVERY_JSON, {
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
      })
      const engine = new LLMAnalysisEngine({
        apiKey: 'k',
        model: 'openai/gpt-5-mini',
        fetchFn,
      })

      const result = await engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY)

      expect(result.cost_usd).toBeCloseTo(2.25, 4)
    })

    it('cost_usd = 0 si usage falta', async () => {
      const openrouterResponse = {
        model: 'openai/gpt-5-mini',
        choices: [
          {
            message: { content: JSON.stringify(VALID_DISCOVERY_JSON) },
            finish_reason: 'stop',
          },
        ],
      }
      const fetchFn = vi.fn(
        async () =>
          new Response(JSON.stringify(openrouterResponse), {
            status: 200,
          }),
      ) as unknown as typeof fetch

      const engine = new LLMAnalysisEngine({
        apiKey: 'k',
        model: 'openai/gpt-5-mini',
        fetchFn,
      })

      const result = await engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY)
      expect(result.cost_usd).toBe(0)
    })

    it('descarta action_items con texto invalido pero conserva los validos', async () => {
      const malformed = {
        ...VALID_DISCOVERY_JSON,
        action_items: [
          { texto: 'Item valido' },
          { texto: 123 },  // invalido — texto no es string
          'string-suelta',  // invalido — no es object
          { texto: 'Otro valido', due_date: '2026-06-01' },
        ],
      }
      const fetchFn = mockFetchOk(malformed)
      const engine = new LLMAnalysisEngine({
        apiKey: 'k',
        model: 'openai/gpt-5-mini',
        fetchFn,
      })

      const result = await engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY)
      expect(result.action_items).toHaveLength(2)
      expect(result.action_items[0]?.texto).toBe('Item valido')
      expect(result.action_items[1]?.due_date).toBe('2026-06-01')
    })
  })

  describe('analyze — request shape', () => {
    it('arma request con strict json_schema + reasoning_effort minimal default', async () => {
      let captured: { url: string; init: RequestInit } = { url: '', init: {} }
      const openrouterResponse = {
        model: 'openai/gpt-5-mini',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        choices: [{ message: { content: JSON.stringify(VALID_DISCOVERY_JSON) } }],
      }
      const fetchFn = vi.fn(async (url, init) => {
        captured = { url: String(url), init: init ?? {} }
        return new Response(JSON.stringify(openrouterResponse), { status: 200 })
      }) as unknown as typeof fetch

      const engine = new LLMAnalysisEngine({
        apiKey: 'mykey',
        model: 'openai/gpt-5-mini',
        fetchFn,
      })

      await engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY)

      expect(captured.url).toContain('/chat/completions')
      const headers = captured.init.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer mykey')
      expect(headers['HTTP-Referer']).toBeTruthy()
      expect(headers['X-Title']).toBe('TagMeetings')

      const body = JSON.parse(captured.init.body as string)
      expect(body.model).toBe('openai/gpt-5-mini')
      expect(body.reasoning_effort).toBe('minimal')
      expect(body.response_format.type).toBe('json_schema')
      expect(body.response_format.json_schema.strict).toBe(true)
      expect(body.response_format.json_schema.name).toBe('discovery')
      expect(body.messages).toHaveLength(2)
      expect(body.messages[0].role).toBe('system')
      expect(body.messages[1].role).toBe('user')
      expect(body.messages[1].content).toContain('Speaker 0')
      expect(body.messages[1].content).toContain('cotizaciones')
    })

    it('respeta override de modelo en plantilla', async () => {
      let capturedBody = ''
      const openrouterResponse = {
        model: 'anthropic/claude-haiku-4.5',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        choices: [{ message: { content: JSON.stringify({ ...VALID_DISCOVERY_JSON, categoria: 'idea-suelta' }) } }],
      }
      const fetchFn = vi.fn(async (_url, init) => {
        capturedBody = init?.body as string
        return new Response(JSON.stringify(openrouterResponse), { status: 200 })
      }) as unknown as typeof fetch

      const engine = new LLMAnalysisEngine({
        apiKey: 'k',
        model: 'openai/gpt-5-mini',
        fetchFn,
      })

      // Forzar override usando el campo extendido `model` en el template
      const templateConOverride = {
        ...PLANTILLA_IDEA_SUELTA,
        model: 'anthropic/claude-haiku-4.5',
      }

      const result = await engine.analyze(SAMPLE_TRANSCRIPTION, templateConOverride as never)

      const body = JSON.parse(capturedBody)
      expect(body.model).toBe('anthropic/claude-haiku-4.5')
      expect(result.model_used).toBe('anthropic/claude-haiku-4.5')
    })

    it('respeta defaultReasoningEffort del constructor', async () => {
      let capturedBody = ''
      const openrouterResponse = {
        model: 'openai/gpt-5-mini',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        choices: [{ message: { content: JSON.stringify(VALID_DISCOVERY_JSON) } }],
      }
      const fetchFn = vi.fn(async (_url, init) => {
        capturedBody = init?.body as string
        return new Response(JSON.stringify(openrouterResponse), { status: 200 })
      }) as unknown as typeof fetch

      const engine = new LLMAnalysisEngine({
        apiKey: 'k',
        model: 'openai/gpt-5-mini',
        fetchFn,
        defaultReasoningEffort: 'medium',
      })

      await engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY)

      const body = JSON.parse(capturedBody)
      expect(body.reasoning_effort).toBe('medium')
    })
  })

  describe('analyze — errores', () => {
    it('HTTP 401 -> AnalysisError con detalle', async () => {
      const fetchFn = vi.fn(
        async () =>
          new Response('{"error":"invalid_api_key"}', {
            status: 401,
            statusText: 'Unauthorized',
          }),
      ) as unknown as typeof fetch

      const engine = new LLMAnalysisEngine({ apiKey: 'k', model: 'openai/gpt-5-mini', fetchFn })

      await expect(
        engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY),
      ).rejects.toThrowError(/HTTP 401.*invalid_api_key/)
    })

    it('HTTP 500 -> AnalysisError', async () => {
      const fetchFn = vi.fn(
        async () => new Response('internal error', { status: 500 }),
      ) as unknown as typeof fetch

      const engine = new LLMAnalysisEngine({ apiKey: 'k', model: 'openai/gpt-5-mini', fetchFn })

      await expect(engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY)).rejects.toThrow(
        AnalysisError,
      )
    })

    it('network error -> AnalysisError', async () => {
      const fetchFn = vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch

      const engine = new LLMAnalysisEngine({ apiKey: 'k', model: 'openai/gpt-5-mini', fetchFn })

      await expect(
        engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY),
      ).rejects.toThrowError(/error de red/)
    })

    it('response sin choices -> AnalysisError', async () => {
      const fetchFn = vi.fn(
        async () => new Response('{"choices":[]}', { status: 200 }),
      ) as unknown as typeof fetch

      const engine = new LLMAnalysisEngine({ apiKey: 'k', model: 'openai/gpt-5-mini', fetchFn })

      await expect(
        engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY),
      ).rejects.toThrowError(/sin choices/)
    })

    it('content NO JSON parseable -> AnalysisError', async () => {
      const fetchFn = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: 'openai/gpt-5-mini',
              choices: [{ message: { content: 'esto no es JSON' } }],
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch

      const engine = new LLMAnalysisEngine({ apiKey: 'k', model: 'openai/gpt-5-mini', fetchFn })

      await expect(
        engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY),
      ).rejects.toThrowError(/no es JSON parseable/)
    })

    it('JSON con shape invalida (falta resumen) -> AnalysisError', async () => {
      const malformed = {
        bullets: ['a'],
        action_items: [],
        categoria: 'discovery',
      }
      const fetchFn = mockFetchOk(malformed)
      const engine = new LLMAnalysisEngine({ apiKey: 'k', model: 'openai/gpt-5-mini', fetchFn })

      await expect(
        engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY),
      ).rejects.toThrowError(/resumen/)
    })

    it('JSON con bullets no-array -> AnalysisError', async () => {
      const fetchFn = mockFetchOk({ resumen: 'x', bullets: 'no es array', action_items: [], categoria: 'd' })
      const engine = new LLMAnalysisEngine({ apiKey: 'k', model: 'openai/gpt-5-mini', fetchFn })

      await expect(
        engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY),
      ).rejects.toThrowError(/bullets/)
    })
  })

  describe('pricing table', () => {
    it('DEFAULT_MODEL_PRICES tiene gpt-5-mini', () => {
      expect(DEFAULT_MODEL_PRICES['openai/gpt-5-mini']).toBeDefined()
      expect(DEFAULT_MODEL_PRICES['openai/gpt-5-mini']?.input_per_mtok).toBe(0.25)
    })

    it('modelo desconocido cae a default', async () => {
      const fetchFn = mockFetchOk(VALID_DISCOVERY_JSON, { prompt_tokens: 1_000_000, completion_tokens: 0 })
      const engine = new LLMAnalysisEngine({
        apiKey: 'k',
        model: 'modelo/no-existe',
        fetchFn,
      })

      const result = await engine.analyze(SAMPLE_TRANSCRIPTION, PLANTILLA_DISCOVERY)
      // 1M * $0.25 (default) = $0.25
      expect(result.cost_usd).toBeCloseTo(0.25, 4)
    })
  })
})
