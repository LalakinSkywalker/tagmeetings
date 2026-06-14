import type {
  AnalysisResult,
  AnalysisTemplate,
  ReasoningEffort,
  TranscriptionResult,
} from '../types/index'

/**
 * Interface canonica para motores de analisis post-transcripcion.
 *
 * Toma una transcripcion + plantilla y produce el `AnalysisResult` con
 * resumen, bullets, action items, categoria, y campos custom conforme al
 * `output_schema` de la plantilla.
 *
 * Implementaciones previstas:
 * - `LLMAnalysisEngine` — configurable Anthropic/OpenAI/OpenRouter
 * - `MockAnalysisEngine` (este archivo) — output deterministic basado en la
 *   plantilla recibida, util para validar wiring sin pagar LLM calls.
 */
export interface AnalysisEngine {
  /**
   * Analiza `transcription` aplicando `template`. La forma de `custom_fields`
   * depende del `output_schema` de la plantilla.
   *
   * @param opts.speakerTokens Si es true, el análisis etiqueta a cada hablante
   *   con un marcador estable `{{sN}}` (en vez de "Speaker N") y se le ordena al
   *   modelo usar SIEMPRE ese marcador al referirse a un hablante. Así el
   *   consumidor puede sustituir los marcadores por nombres reales al renderizar
   * y renombrar NO requiere re-analizar (cero costo de IA).
   *   Opcional para no cambiar el comportamiento de consumidores existentes
   *   (ej. otro consumidor, que llama analyze sin opts).
   * @param opts.model Override por llamada del modelo.
   * @param opts.reasoningEffort Override por llamada del esfuerzo (modo Rapido/Profundo).
   * @param opts.contextoGlobal Contexto del proyecto (memoria del historico) a
   *   inyectar para que el analisis considere toda la relacion, no solo la sesion.
   *   Todos opcionales y aditivos — no afectan a consumidores que llaman sin ellos.
   * @throws AnalysisError si el LLM falla o la respuesta no valida contra
   *         `output_schema`.
   */
  analyze(
    transcription: TranscriptionResult,
    template: AnalysisTemplate,
    opts?: {
      speakerTokens?: boolean
      model?: string
      reasoningEffort?: ReasoningEffort
      contextoGlobal?: string
    },
  ): Promise<AnalysisResult>
}

/**
 * Stub deterministic. Produce un `AnalysisResult` plausible con `custom_fields`
 * vacios — los consumidores deben proveer su propia plantilla y validar contra
 * su schema. El mock NO procesa el schema, solo devuelve estructura valida.
 */
export class MockAnalysisEngine implements AnalysisEngine {
  async analyze(
    transcription: TranscriptionResult,
    template: AnalysisTemplate,
  ): Promise<AnalysisResult> {
    const speakerCount = new Set(
      transcription.segments.map((s) => s.speaker.id),
    ).size

    return {
      template_id: template.id,
      resumen: `[MOCK] Conversación de ${Math.round(
        transcription.duration_ms / 1000,
      )}s con ${speakerCount} hablante(s) detectado(s). Plantilla aplicada: ${
        template.name
      }.`,
      bullets: [
        '[MOCK] Punto clave 1 detectado en el segundo 0.',
        '[MOCK] Punto clave 2 detectado en el segundo 7.',
        '[MOCK] Punto clave 3 — cierre de conversación.',
      ],
      action_items: [
        {
          texto: '[MOCK] Seguimiento pendiente con Speaker 0',
          owner: 'Speaker 0',
        },
      ],
      categoria: template.id,
      custom_fields: {},
      model_used: 'mock',
      cost_usd: 0,
    }
  }
}
