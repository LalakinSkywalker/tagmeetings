import { describe, expect, it, vi } from 'vitest'
import { DeepgramProvider } from '../providers/deepgram-provider'
import { TranscriptionError } from '../types/index'

// Respuesta canonica que Deepgram Nova-3 devuelve con diarize+utterances+smart_format
const SAMPLE_DEEPGRAM_RESPONSE = {
  metadata: {
    duration: 13.5,
    request_id: 'req-test-1',
    model_info: { name: 'nova-3' },
  },
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: 'Hola buenos dias. Igualmente cuentame.',
            confidence: 0.97,
          },
        ],
      },
    ],
    utterances: [
      { start: 0, end: 4.2, confidence: 0.98, speaker: 0, transcript: 'Hola buenos dias' },
      { start: 4.4, end: 7.1, confidence: 0.97, speaker: 1, transcript: 'Igualmente cuentame' },
    ],
  },
}

// Respuesta con idioma detectado por canal (modo multi/auto, PRP-TT-V2 Fase 2)
const RESPONSE_CON_DETECTED = {
  metadata: { duration: 5 },
  results: {
    channels: [
      {
        detected_language: 'en',
        language_confidence: 0.98,
        alternatives: [{ transcript: 'Hello world', confidence: 0.95 }],
      },
    ],
    utterances: [
      { start: 0, end: 5, confidence: 0.95, speaker: 0, transcript: 'Hello world' },
    ],
  },
}

function mockFetchOk(body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

/** fetch que captura la URL llamada para asertar sobre el query string. */
function captureFetch(): { fetchFn: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url))
    return new Response(JSON.stringify(SAMPLE_DEEPGRAM_RESPONSE), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchFn, urls }
}

describe('DeepgramProvider', () => {
  describe('constructor', () => {
    it('lanza TranscriptionError si apiKey esta vacia', () => {
      expect(() => new DeepgramProvider({ apiKey: '' })).toThrow(TranscriptionError)
      expect(() => new DeepgramProvider({ apiKey: '   ' })).toThrow(TranscriptionError)
    })

    it('acepta apiKey valida y usa fetch global por default', () => {
      const provider = new DeepgramProvider({ apiKey: 'test-key' })
      expect(provider).toBeDefined()
    })
  })

  describe('transcribe — happy path', () => {
    it('mapea utterances a TranscriptSegment con start_ms/end_ms en ms y speaker.id', async () => {
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn: mockFetchOk(SAMPLE_DEEPGRAM_RESPONSE) })
      const result = await provider.transcribe('https://example.com/audio.mp3', { language: 'es-MX' })

      expect(result.provider).toBe('deepgram-nova-3')
      expect(result.language).toBe('es-MX')
      expect(result.duration_ms).toBe(13500)
      expect(result.raw_text).toContain('Hola buenos dias')
      expect(result.segments).toHaveLength(2)
      expect(result.segments[0]).toMatchObject({
        speaker: { id: 0 },
        text: 'Hola buenos dias',
        start_ms: 0,
        end_ms: 4200,
        confidence: 0.98,
      })
      expect(result.segments[1]).toMatchObject({ speaker: { id: 1 }, start_ms: 4400, end_ms: 7100 })
    })

    it('preserva raw_provider_response para auditoria', async () => {
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn: mockFetchOk(SAMPLE_DEEPGRAM_RESPONSE) })
      const result = await provider.transcribe('https://example.com/a.mp3')
      expect(result.raw_provider_response).toEqual(SAMPLE_DEEPGRAM_RESPONSE)
    })

    it('usa fallback cuando no hay utterances', async () => {
      const provider = new DeepgramProvider({
        apiKey: 'k',
        fetchFn: mockFetchOk({
          metadata: { duration: 5 },
          results: {
            channels: [{ alternatives: [{ transcript: 'Audio corto sin utterances', confidence: 0.95 }] }],
            utterances: [],
          },
        }),
      })
      const result = await provider.transcribe('https://example.com/x.mp3')
      expect(result.segments).toHaveLength(1)
      expect(result.segments[0]?.text).toBe('Audio corto sin utterances')
      expect(result.segments[0]?.start_ms).toBe(0)
      expect(result.segments[0]?.end_ms).toBe(5000)
      expect(result.segments[0]?.confidence).toBe(0.95)
    })
  })

  describe('transcribe — mapeo de idioma', () => {
    it('es-MX -> language=es', async () => {
      const { fetchFn, urls } = captureFetch()
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await provider.transcribe('https://example.com/a.mp3', { language: 'es-MX' })
      expect(urls[0]).toContain('language=es')
      expect(urls[0]).not.toContain('language=es-MX')
    })

    it('sin language -> multi', async () => {
      const { fetchFn, urls } = captureFetch()
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await provider.transcribe('https://example.com/a.mp3')
      expect(urls[0]).toContain('language=multi')
    })

    it('en-US -> en', async () => {
      const { fetchFn, urls } = captureFetch()
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await provider.transcribe('https://example.com/a.mp3', { language: 'en-US' })
      expect(urls[0]).toContain('language=en')
    })
  })

  describe('transcribe — errores', () => {
    it('lanza TranscriptionError si audioUrl no es HTTP', async () => {
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn: mockFetchOk(SAMPLE_DEEPGRAM_RESPONSE) })
      await expect(provider.transcribe('file:///local/audio.mp3')).rejects.toThrow(TranscriptionError)
    })

    it('lanza TranscriptionError con detalle si Deepgram responde 4xx', async () => {
      const fetchFn = vi.fn(
        async () => new Response('{"err":"INVALID_AUTH"}', { status: 401, statusText: 'Unauthorized' }),
      ) as unknown as typeof fetch
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await expect(provider.transcribe('https://example.com/a.mp3')).rejects.toThrowError(/HTTP 401.*INVALID_AUTH/)
    })

    it('lanza TranscriptionError si fetch falla por red', async () => {
      const fetchFn = vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await expect(provider.transcribe('https://example.com/a.mp3')).rejects.toThrowError(/red al llamar a Deepgram/)
    })
  })

  describe('transcribe — query string', () => {
    it('incluye model=nova-3 + diarize_model=latest + utterances + punctuate + smart_format por default', async () => {
      const { fetchFn, urls } = captureFetch()
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await provider.transcribe('https://example.com/a.mp3')
      // PRP-TT-V2 Fase 2: diarize_model=latest reemplaza al flag legacy diarize=true
      expect(urls[0]).toContain('model=nova-3')
      expect(urls[0]).toContain('diarize_model=latest')
      expect(urls[0]).toContain('utterances=true')
      expect(urls[0]).toContain('punctuate=true')
      expect(urls[0]).toContain('smart_format=true')
    })

    it('permite pinear el diarizeModel (v1 legacy) via opts', async () => {
      const { fetchFn, urls } = captureFetch()
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await provider.transcribe('https://example.com/a.mp3', { diarizeModel: 'v1' })
      expect(urls[0]).toContain('diarize_model=v1')
    })

    it('respeta diarize=false del opts (no setea diarize_model)', async () => {
      const { fetchFn, urls } = captureFetch()
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await provider.transcribe('https://example.com/a.mp3', { diarize: false })
      expect(urls[0]).not.toContain('diarize_model')
    })
  })

  describe('transcribe — idioma multi + detected_language (PRP-TT-V2 Fase 2)', () => {
    it('auto / multi / codigo-inexistente -> language=multi', async () => {
      const { fetchFn, urls } = captureFetch()
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })

      await provider.transcribe('https://e.com/a.mp3', { language: 'auto' })
      expect(urls[0]).toContain('language=multi')

      await provider.transcribe('https://e.com/a.mp3', { language: 'multi' })
      expect(urls[1]).toContain('language=multi')

      // codigo inventado que Deepgram NO soporta -> cae a multi (auto-deteccion)
      await provider.transcribe('https://e.com/a.mp3', { language: 'zz' })
      expect(urls[2]).toContain('language=multi')
    })

    it('idiomas soportados se fuerzan: pt-BR->pt, fa->fa, ja->ja, ru->ru', async () => {
      const { fetchFn, urls } = captureFetch()
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })

      await provider.transcribe('https://e.com/a.mp3', { language: 'pt-BR' })
      expect(urls[0]).toContain('language=pt')

      // farsi SI esta soportado por Nova-3 en modo monolingue (verificado en doc Deepgram)
      await provider.transcribe('https://e.com/a.mp3', { language: 'fa' })
      expect(urls[1]).toContain('language=fa')

      await provider.transcribe('https://e.com/a.mp3', { language: 'ja' })
      expect(urls[2]).toContain('language=ja')

      await provider.transcribe('https://e.com/a.mp3', { language: 'ru' })
      expect(urls[3]).toContain('language=ru')
    })

    it('captura detected_language del canal en modo multi', async () => {
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn: mockFetchOk(RESPONSE_CON_DETECTED) })
      const result = await provider.transcribe('https://e.com/a.mp3', { language: 'auto' })
      expect(result.detected_language).toBe('en')
    })

    it('detected_language undefined cuando el canal no lo reporta', async () => {
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn: mockFetchOk(SAMPLE_DEEPGRAM_RESPONSE) })
      const result = await provider.transcribe('https://e.com/a.mp3', { language: 'es-MX' })
      expect(result.detected_language).toBeUndefined()
    })
  })

  // ==========================================================================
  // PRP-TT-002 — flujo async via callback
  // ==========================================================================
  describe('transcribeAsync — happy path', () => {
    it('agrega callback URL al query string y retorna request_id del ack', async () => {
      const urls: string[] = []
      const fetchFn = vi.fn(async (url: string | URL | Request) => {
        urls.push(String(url))
        return new Response(JSON.stringify({ request_id: 'req-async-123' }), { status: 200 })
      }) as unknown as typeof fetch

      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      const result = await provider.transcribeAsync('https://example.com/audio.mp3', {
        language: 'es-MX',
        diarize: true,
        punctuate: true,
        callbackUrl: 'https://tagtranscriptor.example.com/api/webhooks/deepgram?id=abc&secret=xyz',
      })

      expect(result.request_id).toBe('req-async-123')
      expect(urls[0]).toContain('callback=')
      expect(urls[0]).toContain(
        encodeURIComponent('https://tagtranscriptor.example.com/api/webhooks/deepgram?id=abc&secret=xyz'),
      )
      expect(urls[0]).toContain('language=es')
      expect(urls[0]).toContain('diarize_model=latest')
      expect(urls[0]).toContain('model=nova-3')
    })
  })

  describe('transcribeAsync — validaciones', () => {
    it('lanza TranscriptionError si callbackUrl no es HTTPS', async () => {
      const fetchFn = vi.fn() as unknown as typeof fetch
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await expect(
        provider.transcribeAsync('https://example.com/a.mp3', { callbackUrl: 'http://localhost:3050/webhook' }),
      ).rejects.toThrow(TranscriptionError)
      await expect(
        provider.transcribeAsync('https://example.com/a.mp3', { callbackUrl: '' }),
      ).rejects.toThrow(TranscriptionError)
    })

    it('lanza TranscriptionError si audioUrl no es HTTP', async () => {
      const fetchFn = vi.fn() as unknown as typeof fetch
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await expect(
        provider.transcribeAsync('file:///local/audio.mp3', { callbackUrl: 'https://example.com/webhook' }),
      ).rejects.toThrow(TranscriptionError)
    })

    it('lanza TranscriptionError si Deepgram responde 4xx al lanzar el job', async () => {
      const fetchFn = vi.fn(
        async () => new Response('{"err":"BAD"}', { status: 400, statusText: 'Bad Request' }),
      ) as unknown as typeof fetch
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await expect(
        provider.transcribeAsync('https://example.com/a.mp3', { callbackUrl: 'https://example.com/webhook' }),
      ).rejects.toThrowError(/async: HTTP 400/)
    })

    it('lanza TranscriptionError si ack viene sin request_id', async () => {
      const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
      const provider = new DeepgramProvider({ apiKey: 'k', fetchFn })
      await expect(
        provider.transcribeAsync('https://example.com/a.mp3', { callbackUrl: 'https://example.com/webhook' }),
      ).rejects.toThrowError(/sin request_id/)
    })
  })

  describe('parseCallbackPayload', () => {
    it('mapea body del callback identico a transcribe() sync', () => {
      const provider = new DeepgramProvider({ apiKey: 'k' })
      const result = provider.parseCallbackPayload(SAMPLE_DEEPGRAM_RESPONSE, 'es-MX')
      expect(result.provider).toBe('deepgram-nova-3')
      expect(result.language).toBe('es-MX')
      expect(result.duration_ms).toBe(13500)
      expect(result.segments).toHaveLength(2)
      expect(result.segments[0]).toMatchObject({ speaker: { id: 0 }, start_ms: 0, end_ms: 4200 })
      expect(result.raw_text).toContain('Hola buenos dias')
    })

    it('usa default es-MX cuando no se pasa language', () => {
      const provider = new DeepgramProvider({ apiKey: 'k' })
      const result = provider.parseCallbackPayload(SAMPLE_DEEPGRAM_RESPONSE)
      expect(result.language).toBe('es-MX')
    })

    it('lanza TranscriptionError si body no es objeto', () => {
      const provider = new DeepgramProvider({ apiKey: 'k' })
      expect(() => provider.parseCallbackPayload(null)).toThrow(TranscriptionError)
      expect(() => provider.parseCallbackPayload('not-json')).toThrow(TranscriptionError)
      expect(() => provider.parseCallbackPayload(42)).toThrow(TranscriptionError)
    })

    it('lanza TranscriptionError si body no tiene results ni metadata', () => {
      const provider = new DeepgramProvider({ apiKey: 'k' })
      expect(() => provider.parseCallbackPayload({ unrelated: 'thing' })).toThrow(/results ni metadata/)
    })

    it('soporta fallback cuando no hay utterances en el callback', () => {
      const provider = new DeepgramProvider({ apiKey: 'k' })
      const result = provider.parseCallbackPayload(
        {
          metadata: { duration: 5 },
          results: {
            channels: [{ alternatives: [{ transcript: 'Audio sin utterances', confidence: 0.95 }] }],
            utterances: [],
          },
        },
        'es-MX',
      )
      expect(result.segments).toHaveLength(1)
      expect(result.segments[0]?.text).toBe('Audio sin utterances')
    })
  })
})
