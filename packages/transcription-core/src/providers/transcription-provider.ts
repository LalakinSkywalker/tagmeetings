import type {
  TranscribeAsyncOptions,
  TranscribeAsyncResult,
  TranscribeOptions,
  TranscriptionResult,
} from '../types/index'

/**
 * Interface canonica para motores de transcripcion (speech-to-text).
 *
 * Implementaciones previstas:
 * - `DeepgramProvider` (Fase 2) — Deepgram Nova-3 batch + streaming + callback async (PRP-TT-002)
 * - `WhisperProvider` (alternativa retrofit) — OpenAI Whisper API
 * - `MockTranscriptionProvider` (este archivo) — datos deterministic para tests/dev
 *
 * El paquete NO conoce el origen del audio. El consumidor pasa una URL
 * (signed download URL de Supabase Storage, URL publica, etc.) y el provider
 * la descarga internamente.
 *
 * Los metodos `transcribeAsync` y `parseCallbackPayload` son OPCIONALES — solo
 * los providers que soportan callback async los implementan (e.g. Deepgram).
 * Consumidores que requieren async deben hacer `if (provider.transcribeAsync)`
 * o castear a `AsyncTranscriptionProvider` antes de invocar.
 */
export interface TranscriptionProvider {
  /**
   * Transcribe el audio en `audioUrl`. Resultado completo con diarizacion
   * si `opts.diarize === true`.
   *
   * Modo SINCRONO: espera la respuesta completa del motor. Util para audios
   * cortos. Para audios largos usar `transcribeAsync` si el provider lo soporta.
   *
   * @throws TranscriptionError si el motor falla o el audio es invalido.
   */
  transcribe(
    audioUrl: string,
    opts?: TranscribeOptions,
  ): Promise<TranscriptionResult>

  /**
   * Lanza la transcripcion en modo asincrono y retorna inmediatamente.
   * El motor procesa en background y hace POST a `opts.callbackUrl` con
   * el resultado cuando termina.
   *
   * El consumidor debe implementar un endpoint que reciba ese POST y use
   * `parseCallbackPayload()` para mapear el body a TranscriptionResult.
   *
   * Diseñado para audios largos donde el procesamiento puede exceder el
   * timeout del runtime serverless.
   *
   * @throws TranscriptionError si el motor rechaza el job (URL invalida,
   *         callback URL no HTTPS publica, etc.).
   */
  transcribeAsync?(
    audioUrl: string,
    opts: TranscribeAsyncOptions,
  ): Promise<TranscribeAsyncResult>

  /**
   * Parsea el body raw recibido en el endpoint del callback (POST de Deepgram,
   * etc.) a una `TranscriptionResult` canonica.
   *
   * Util para que el consumidor no tenga que conocer el formato especifico del
   * provider. El paquete entrega resultados normalizados.
   *
   * @param language BCP-47 declarado al lanzar el job (el callback no siempre
   *                 lo incluye y `TranscriptionResult.language` lo requiere).
   * @throws TranscriptionError si el body no se puede parsear al contrato.
   */
  parseCallbackPayload?(body: unknown, language?: string): TranscriptionResult
}

/**
 * Refinamiento de `TranscriptionProvider` que GARANTIZA soporte de modo async.
 * El consumidor que solo trabaja con audios largos puede tipar contra esta y
 * evitar checks defensivos en cada llamada.
 */
export interface AsyncTranscriptionProvider extends TranscriptionProvider {
  transcribeAsync(
    audioUrl: string,
    opts: TranscribeAsyncOptions,
  ): Promise<TranscribeAsyncResult>
  parseCallbackPayload(body: unknown, language?: string): TranscriptionResult
}

/**
 * Stub deterministic para tests, dev y validacion del contrato sin pagar
 * llamadas reales a Deepgram. Retorna la MISMA respuesta siempre — util
 * para que el Claudio de otro proyecto valide su integracion sin coste.
 *
 * Hardcoded a una conversacion de 2 speakers en es-MX de 15 segundos.
 */
export class MockTranscriptionProvider implements TranscriptionProvider {
  async transcribe(
    _audioUrl: string,
    opts?: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const segments = [
      {
        speaker: { id: 0, label: 'Speaker 0' },
        text: 'Hola, buenos días. Te agradezco que me hayas dado este espacio.',
        start_ms: 0,
        end_ms: 4200,
        confidence: 0.98,
      },
      {
        speaker: { id: 1, label: 'Speaker 1' },
        text: 'Igualmente. Cuéntame en qué te puedo ayudar.',
        start_ms: 4400,
        end_ms: 7100,
        confidence: 0.97,
      },
      {
        speaker: { id: 0, label: 'Speaker 0' },
        text: 'Quería platicarte sobre el proyecto que tengo en mente.',
        start_ms: 7300,
        end_ms: 10800,
        confidence: 0.96,
      },
      {
        speaker: { id: 1, label: 'Speaker 1' },
        text: 'Perfecto, te escucho con atención.',
        start_ms: 11000,
        end_ms: 13500,
        confidence: 0.99,
      },
    ]

    return {
      segments,
      language: opts?.language ?? 'es-MX',
      duration_ms: 13500,
      raw_text: segments.map((s) => s.text).join(' '),
      provider: 'mock',
    }
  }
}
