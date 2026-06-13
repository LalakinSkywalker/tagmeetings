import { describe, expect, it, vi } from 'vitest'
import { LLMTranslator } from '../engines/llm-translator'
import type { TranscriptSegment } from '../types/index'

const SEGMENTS: TranscriptSegment[] = [
  { speaker: { id: 0 }, text: 'Hello, how are you?', start_ms: 0, end_ms: 2000, confidence: 0.95 },
  { speaker: { id: 1 }, text: 'I am fine, thank you.', start_ms: 2100, end_ms: 4000, confidence: 0.96 },
]

function mockTranslateOk(translations: string[], usage = { prompt_tokens: 100, completion_tokens: 50 }): typeof fetch {
  const response = {
    model: 'openai/gpt-5-mini',
    usage,
    choices: [{ message: { content: JSON.stringify({ translations }) } }],
  }
  return vi.fn(
    async () => new Response(JSON.stringify(response), { status: 200 }),
  ) as unknown as typeof fetch
}

describe('LLMTranslator', () => {
  it('lanza si apiKey o model vacios', () => {
    expect(() => new LLMTranslator({ apiKey: '', model: 'm' })).toThrow()
    expect(() => new LLMTranslator({ apiKey: 'k', model: '' })).toThrow()
  })

  it('traduce segments preservando estructura (timings/speakers), solo cambia text', async () => {
    const fetchFn = mockTranslateOk(['Hola, ¿cómo estás?', 'Estoy bien, gracias.'])
    const t = new LLMTranslator({ apiKey: 'k', model: 'openai/gpt-5-mini', fetchFn })

    const result = await t.translateSegments(SEGMENTS, 'espanol')

    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]?.text).toBe('Hola, ¿cómo estás?')
    expect(result.segments[0]?.start_ms).toBe(0)
    expect(result.segments[0]?.speaker.id).toBe(0)
    expect(result.segments[1]?.text).toBe('Estoy bien, gracias.')
    expect(result.raw_text).toContain('Hola')
    expect(result.cost_usd).toBeGreaterThan(0)
  })

  it('si el modelo rompe el conteo, cae a textos originales (no pierde segments)', async () => {
    // Devuelve solo 1 traduccion para 2 segments → defensa: originales
    const fetchFn = mockTranslateOk(['solo una'])
    const t = new LLMTranslator({ apiKey: 'k', model: 'openai/gpt-5-mini', fetchFn })

    const result = await t.translateSegments(SEGMENTS, 'espanol')

    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]?.text).toBe('Hello, how are you?')
    expect(result.segments[1]?.text).toBe('I am fine, thank you.')
  })

  it('lista vacia → resultado vacio sin llamar al LLM', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const t = new LLMTranslator({ apiKey: 'k', model: 'openai/gpt-5-mini', fetchFn })

    const result = await t.translateSegments([], 'espanol')

    expect(result.segments).toHaveLength(0)
    expect(result.cost_usd).toBe(0)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('error de red → devuelve originales (best-effort, no lanza)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const t = new LLMTranslator({ apiKey: 'k', model: 'openai/gpt-5-mini', fetchFn })

    const result = await t.translateSegments(SEGMENTS, 'espanol')

    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]?.text).toBe('Hello, how are you?')
  })

  it('divide en varios lotes cuando excede maxCharsPerBatch', async () => {
    const fetchFn = vi.fn(
      async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? '{}')
        const items = body.messages?.[1]?.content
          ? (JSON.parse(body.messages[1].content).items as string[])
          : []
        // Echo: devuelve los mismos textos prefijados (simula traduccion)
        return new Response(
          JSON.stringify({
            model: 'openai/gpt-5-mini',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            choices: [
              { message: { content: JSON.stringify({ translations: items.map((s) => `ES:${s}`) }) } },
            ],
          }),
          { status: 200 },
        )
      },
    ) as unknown as typeof fetch

    const t = new LLMTranslator({
      apiKey: 'k',
      model: 'openai/gpt-5-mini',
      fetchFn,
      maxCharsPerBatch: 10, // fuerza 1 segment por lote
    })

    const result = await t.translateSegments(SEGMENTS, 'espanol')

    expect(fetchFn).toHaveBeenCalledTimes(2) // 2 lotes (1 por segment)
    expect(result.segments[0]?.text).toBe('ES:Hello, how are you?')
    expect(result.segments[1]?.text).toBe('ES:I am fine, thank you.')
  })
})
