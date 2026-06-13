import { describe, expect, it } from 'vitest'
import {
  MockAnalysisEngine,
  MockRagIndex,
  MockStorageAdapter,
  MockTranscriptionProvider,
  PLANTILLAS_TAGTRANSCRIPTOR,
  PLANTILLAS_TAGTRANSCRIPTOR_LIST,
  PLANTILLA_DISCOVERY,
} from '../index'

describe('@bluntag/transcription-core — contrato + stubs', () => {
  describe('MockTranscriptionProvider', () => {
    it('retorna transcripcion deterministic con 2 speakers en es-MX', async () => {
      const provider = new MockTranscriptionProvider()
      const result = await provider.transcribe('mock://audio.mp3')

      expect(result.provider).toBe('mock')
      expect(result.language).toBe('es-MX')
      expect(result.duration_ms).toBe(13500)

      // Diarizacion: 2 speakers distintos en los segmentos
      const speakerIds = new Set(result.segments.map((s) => s.speaker.id))
      expect(speakerIds.size).toBe(2)

      // raw_text es concatenacion plana de segments
      expect(result.raw_text.length).toBeGreaterThan(0)
      expect(result.raw_text).toContain('buenos días')
    })

    it('respeta language opt si se pasa explicito', async () => {
      const provider = new MockTranscriptionProvider()
      const result = await provider.transcribe('mock://audio.mp3', {
        language: 'en-US',
      })
      expect(result.language).toBe('en-US')
    })
  })

  describe('MockAnalysisEngine', () => {
    it('produce AnalysisResult valido con template_id de la plantilla', async () => {
      const engine = new MockAnalysisEngine()
      const provider = new MockTranscriptionProvider()
      const transcription = await provider.transcribe('mock://audio.mp3')

      const result = await engine.analyze(transcription, PLANTILLA_DISCOVERY)

      expect(result.template_id).toBe('discovery')
      expect(result.resumen).toContain('Plantilla aplicada')
      expect(Array.isArray(result.bullets)).toBe(true)
      expect(result.bullets.length).toBeGreaterThan(0)
      expect(Array.isArray(result.action_items)).toBe(true)
      expect(result.cost_usd).toBe(0)
      expect(result.model_used).toBe('mock')
    })
  })

  describe('MockRagIndex', () => {
    it('index + ask devuelve respuesta con cita al primer segmento', async () => {
      const rag = new MockRagIndex()
      const provider = new MockTranscriptionProvider()
      const transcription = await provider.transcribe('mock://audio.mp3')

      await rag.index('transcription-123', transcription.segments)
      const ask = await rag.ask('transcription-123', '¿De qué se habló al inicio?')

      expect(ask.citations).toHaveLength(1)
      expect(ask.citations[0]!.start_ms).toBe(0)
      expect(ask.citations[0]!.speaker?.id).toBe(0)
      expect(ask.cost_usd).toBe(0)
    })

    it('ask sin index previo retorna respuesta indicando que falta indexar', async () => {
      const rag = new MockRagIndex()
      const ask = await rag.ask('inexistente', 'cualquier cosa')
      expect(ask.citations).toHaveLength(0)
      expect(ask.answer).toContain('No hay datos indexados')
    })
  })

  describe('MockStorageAdapter', () => {
    it('genera signed URLs con expiracion calculada', async () => {
      const storage = new MockStorageAdapter()

      const upload = await storage.getSignedUploadUrl(
        'user-123/transcription-456/audio.opus',
        { expiresInSec: 600 },
      )
      expect(upload.url).toContain('mock-storage.bluntag.local')
      expect(upload.url).toContain('upload')
      expect(upload.url).toMatch(/expires=\d+/)

      const download = await storage.getSignedDownloadUrl(
        'user-123/transcription-456/audio.opus',
        { expiresInSec: 600 },
      )
      expect(download).toContain('mock-storage.bluntag.local')
      expect(download).toContain('download')
    })
  })

  describe('Plantillas TagTranscriptor', () => {
    it('exporta 9 plantillas con ids unicos (5 negocio + 4 genericas, PRP-TT-V2 Fase 2)', () => {
      // presencial-prospecto se fusiono en discovery (decision de producto 2026-05-30)
      expect(PLANTILLAS_TAGTRANSCRIPTOR_LIST).toHaveLength(9)
      const ids = PLANTILLAS_TAGTRANSCRIPTOR_LIST.map((p) => p.id)
      const unique = new Set(ids)
      expect(unique.size).toBe(9)
    })

    it('incluye las 4 plantillas genericas multi-tema', () => {
      const ids = PLANTILLAS_TAGTRANSCRIPTOR_LIST.map((p) => p.id)
      expect(ids).toContain('reunion-general')
      expect(ids).toContain('clase-conferencia')
      expect(ids).toContain('entrevista')
      expect(ids).toContain('medios-noticiero')
    })

    it('discovery (fusionada) extrae fortalezas de ambas: diagnostico + relacion', () => {
      const req = PLANTILLA_DISCOVERY.output_schema.required as string[]
      // del discovery original
      expect(req).toContain('pain_points')
      expect(req).toContain('budget_signals')
      expect(req).toContain('alternatives_evaluated')
      // absorbidas de presencial-prospecto
      expect(req).toContain('compromisos_explicitos')
      expect(req).toContain('proximo_paso')
      expect(req).toContain('temas_personales_relevantes')
    })

    it('ya no existe presencial-prospecto como plantilla separada', () => {
      const ids = PLANTILLAS_TAGTRANSCRIPTOR_LIST.map((p) => p.id)
      expect(ids).not.toContain('presencial-prospecto')
    })

    it('cada plantilla tiene prompt_system, prompt_user_template, output_schema', () => {
      for (const plantilla of PLANTILLAS_TAGTRANSCRIPTOR_LIST) {
        expect(plantilla.id).toBeTruthy()
        expect(plantilla.name).toBeTruthy()
        expect(plantilla.description).toBeTruthy()
        expect(plantilla.prompt_system).toBeTruthy()
        expect(plantilla.prompt_user_template).toContain('{{transcript}}')
        expect(plantilla.output_schema).toBeTruthy()
      }
    })

    it('PLANTILLAS_TAGTRANSCRIPTOR mapea por id correctamente', () => {
      expect(PLANTILLAS_TAGTRANSCRIPTOR.discovery).toBe(PLANTILLA_DISCOVERY)
      expect(PLANTILLAS_TAGTRANSCRIPTOR.discovery.id).toBe('discovery')
    })
  })
})
