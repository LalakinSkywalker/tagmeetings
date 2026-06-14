// =============================================================================
// RagIndex — interface canonica + MockRagIndex + PgvectorRagIndex
// =============================================================================
// El paquete NO conoce el schema de tablas del consumidor. El PgvectorRagIndex
// recibe via constructor el `supabaseClient` + nombre de tabla de chunks +
// nombre del RPC de search. Esto permite que TagMeetings use
// `transcripcion_chunks` + `search_chunks` y otro consumidor use otros sin tocar el
// codigo del paquete.
// =============================================================================

import {
  RagError,
  type AskCitation,
  type AskResult,
  type ProjectAskCitation,
  type ProjectAskResult,
  type TranscriptSegment,
} from '../types/index'
import type { OpenAIEmbeddingClient } from './openai-embedding-client'
import type { ChatCompletionClient } from './openrouter-chat-client'

// =============================================================================
// Interface canonica
// =============================================================================

/**
 * Opciones para index(). `ownerUserId` es REQUERIDO por PgvectorRagIndex porque
 * el INSERT a `transcripcion_chunks.user_id` necesita el uuid del owner. El
 * paquete NO asume contexto de auth — el caller lo pasa explicito. MockRagIndex
 * lo ignora.
 */
export interface RagIndexOptions {
  ownerUserId?: string
}

export interface RagIndex {
  /**
   * Indexa los segmentos de una transcripcion. Genera embeddings, chunkea,
   * y persiste en el backing store del consumidor.
   *
   * @throws RagError si falla la persistencia o el provider de embeddings.
   */
  index(
    transcriptionId: string,
    segments: TranscriptSegment[],
    options?: RagIndexOptions,
  ): Promise<RagIndexResult>

  /**
   * Responde una pregunta sobre la transcripcion indexada. Busqueda semantica
   * via similaridad coseno sobre los chunks, top-K se pasa al LLM con
   * instruccion "responde citando".
   *
   * @throws RagError si la transcripcion no existe indexada.
   *
   * @param speakerNames OPCIONAL: diccionario { "<speaker_id>": "<nombre real>" }.
   *        Cuando se pasa, los nombres se inyectan en el prompt en runtime para
   *        que el LLM entienda preguntas por nombre y las citas lleven el nombre.
   *        Retrocompatible: ausente = comportamiento original (Speaker N).
   */
  ask(
    transcriptionId: string,
    question: string,
    speakerNames?: Record<string, string>,
  ): Promise<AskResult>
}

/**
 * Extension de RagIndex con Ask a nivel PROYECTO (cross-sesion).
 * Responde preguntas sobre el HISTORICO de varias sesiones de un proyecto a la vez
 * ("¿que le promet a Mario en 3 meses?"). Cada cita recuerda de que sesion proviene.
 *
 * Aditiva: un consumidor que solo implemente/use `ask()` (ej. otro consumidor) NO se
 * afecta — esta interface es opcional y separada de RagIndex.
 */
export interface ProjectAwareRagIndex extends RagIndex {
  /**
   * @param proyectoId uuid del proyecto.
   * @param question pregunta del usuario.
   * @param speakerNamesByTranscription OPCIONAL: mapa { "<transcripcion_id>": { "<speaker_id>": "<nombre>" } }.
   *        Permite resolver el nombre del hablante POR SESION (Speaker 1 puede ser
   *        Mario en una sesion y otra persona en otra). Ausente = etiquetas Speaker N.
   */
  askProyecto(
    proyectoId: string,
    question: string,
    speakerNamesByTranscription?: Record<string, Record<string, string>>,
  ): Promise<ProjectAskResult>
}

/**
 * Resultado del index(). Util para que el caller persista cost y stats.
 */
export interface RagIndexResult {
  chunks_inserted: number
  cost_usd: number
  prompt_tokens: number
  model_used: string
}

// =============================================================================
// MockRagIndex — stub deterministic
// =============================================================================

/**
 * Stub deterministic. `index()` es no-op (registra en memoria). `ask()` devuelve
 * respuesta canned con cita al primer segmento.
 *
 * Util para tests del consumidor sin tocar pgvector ni embeddings reales.
 */
export class MockRagIndex implements ProjectAwareRagIndex {
  private readonly indexed: Map<string, TranscriptSegment[]> = new Map()

  async index(
    transcriptionId: string,
    segments: TranscriptSegment[],
    _options?: RagIndexOptions,
  ): Promise<RagIndexResult> {
    this.indexed.set(transcriptionId, segments)
    return {
      chunks_inserted: segments.length,
      cost_usd: 0,
      prompt_tokens: 0,
      model_used: 'mock',
    }
  }

  async ask(
    transcriptionId: string,
    question: string,
    speakerNames?: Record<string, string>,
  ): Promise<AskResult> {
    const segments = this.indexed.get(transcriptionId)

    if (!segments || segments.length === 0) {
      return {
        answer: `[MOCK] No hay datos indexados para transcripción ${transcriptionId}. Llama index() primero.`,
        citations: [],
        model_used: 'mock',
        cost_usd: 0,
      }
    }

    const first = segments[0]!
    return {
      answer: `[MOCK] Respuesta a "${question}" sobre transcripción ${transcriptionId}. El primer hablante mencionó algo relevante al inicio.`,
      citations: [
        {
          text: first.text,
          start_ms: first.start_ms,
          end_ms: first.end_ms,
          // Retrocompat: sin speakerNames, conserva el speaker original tal cual.
          speaker: speakerNames
            ? { id: first.speaker.id, label: speakerLabelFor(first.speaker.id, speakerNames) }
            : first.speaker,
        },
      ],
      model_used: 'mock',
      cost_usd: 0,
    }
  }

  async askProyecto(
    proyectoId: string,
    question: string,
    _speakerNamesByTranscription?: Record<string, Record<string, string>>,
  ): Promise<ProjectAskResult> {
    // Stub: usa cualquier sesion indexada como origen de una cita canned.
    const firstEntry = this.indexed.entries().next().value as
      | [string, TranscriptSegment[]]
      | undefined

    if (!firstEntry || firstEntry[1].length === 0) {
      return {
        answer: `[MOCK] No hay sesiones indexadas para el proyecto ${proyectoId}.`,
        citations: [],
        model_used: 'mock',
        cost_usd: 0,
      }
    }

    const [txId, segments] = firstEntry
    const first = segments[0]!
    return {
      answer: `[MOCK] Respuesta cross-sesion a "${question}" sobre el proyecto ${proyectoId}.`,
      citations: [
        {
          text: first.text,
          start_ms: first.start_ms,
          end_ms: first.end_ms,
          speaker: first.speaker,
          transcripcion_id: txId,
          titulo_sesion: '[MOCK] Sesion',
        },
      ],
      model_used: 'mock',
      cost_usd: 0,
    }
  }
}

// =============================================================================
// Chunking por turn de speaker
// =============================================================================

export interface SpeakerChunk {
  chunk_index: number
  text: string
  start_ms: number
  end_ms: number
  speaker_id: number
}

/**
 * Heuristica conservadora: 1 token ~ 4 chars en espanol. Cap soft 2000 chars
 * (~500 tokens) por chunk evita enviar chunks gigantes al endpoint de embeddings
 * y mantiene la similaridad coseno semanticamente coherente. Si un mismo turno
 * de speaker excede el cap, se parte en sub-chunks consecutivos del mismo
 * speaker preservando la cronologia (start_ms / end_ms del rango cubierto).
 */
export const DEFAULT_MAX_CHUNK_CHARS = 2000

/**
 * Agrupa segments contiguos del mismo speaker_id en chunks. Si un grupo supera
 * `maxChars`, lo parte en sub-chunks del mismo speaker preservando timestamps.
 *
 * Salida ordenada por chunk_index ascendente comenzando en 0.
 *
 * @throws RagError si segments es vacio o si maxChars es absurdo.
 */
export function chunkBySpeakerTurn(
  segments: TranscriptSegment[],
  maxChars: number = DEFAULT_MAX_CHUNK_CHARS,
): SpeakerChunk[] {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new RagError('chunkBySpeakerTurn: segments vacio.', '<chunk>')
  }
  if (!Number.isFinite(maxChars) || maxChars < 100) {
    throw new RagError(
      `chunkBySpeakerTurn: maxChars (${maxChars}) demasiado pequeno o invalido.`,
      '<chunk>',
    )
  }

  const out: SpeakerChunk[] = []
  let currentText = ''
  let currentStart = segments[0]!.start_ms
  let currentEnd = segments[0]!.end_ms
  let currentSpeaker = segments[0]!.speaker.id

  const pushCurrent = () => {
    if (currentText.length === 0) return
    out.push({
      chunk_index: out.length,
      text: currentText.trim(),
      start_ms: currentStart,
      end_ms: currentEnd,
      speaker_id: currentSpeaker,
    })
    currentText = ''
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const isFirst = i === 0
    const speakerChanged = !isFirst && seg.speaker.id !== currentSpeaker

    if (speakerChanged) {
      pushCurrent()
      currentStart = seg.start_ms
      currentEnd = seg.end_ms
      currentSpeaker = seg.speaker.id
    }

    // Si appendear el segment excede el cap, cerrar el chunk actual y abrir uno
    // nuevo del mismo speaker. Si el segment ESTE SOLO ya excede el cap, lo
    // partimos por chars (raro pero defensivo).
    const wouldBe = currentText.length === 0 ? seg.text : `${currentText} ${seg.text}`

    if (wouldBe.length > maxChars && currentText.length > 0) {
      pushCurrent()
      currentStart = seg.start_ms
      currentEnd = seg.end_ms
      currentSpeaker = seg.speaker.id
    }

    if (seg.text.length > maxChars) {
      // Segmento individual demasiado grande: cerrar chunk actual si tiene
      // contenido, despues partir el segmento por chars conservando rango temporal.
      pushCurrent()
      const totalLen = seg.text.length
      const partCount = Math.ceil(totalLen / maxChars)
      const partDurationMs = Math.round((seg.end_ms - seg.start_ms) / partCount)
      for (let p = 0; p < partCount; p++) {
        const sub = seg.text.slice(p * maxChars, (p + 1) * maxChars)
        out.push({
          chunk_index: out.length,
          text: sub.trim(),
          start_ms: seg.start_ms + p * partDurationMs,
          end_ms:
            p === partCount - 1 ? seg.end_ms : seg.start_ms + (p + 1) * partDurationMs,
          speaker_id: seg.speaker.id,
        })
      }
      currentStart = seg.end_ms
      currentEnd = seg.end_ms
      currentSpeaker = seg.speaker.id
      currentText = ''
      continue
    }

    currentText = currentText.length === 0 ? seg.text : `${currentText} ${seg.text}`
    currentEnd = seg.end_ms
  }

  pushCurrent()
  return out
}

// =============================================================================
// MinimalSupabaseRagClient (duck typing)
// =============================================================================

interface SupabaseRagInsertResult {
  data: unknown
  error: { message: string } | null
}

interface SupabaseRagSelectResult<T> {
  data: T | null
  error: { message: string } | null
}

interface SupabaseRagRpcResult<T> {
  data: T | null
  error: { message: string } | null
}

interface MinimalSupabaseFromBuilder {
  insert(rows: Record<string, unknown>[]): PromiseLike<SupabaseRagInsertResult>
  delete(): {
    eq(column: string, value: unknown): PromiseLike<SupabaseRagInsertResult>
  }
  select(columns: string): {
    eq(
      column: string,
      value: unknown,
    ): {
      order(
        column: string,
        opts?: { ascending: boolean },
      ): PromiseLike<SupabaseRagSelectResult<unknown[]>>
    }
  }
}

/**
 * Shape minimo del cliente Supabase consumido por PgvectorRagIndex. Compatible
 * estructuralmente con SupabaseClient v2 (`PostgrestFilterBuilder` es thenable
 * pero NO Promise estricto — por eso PromiseLike).
 */
export interface MinimalSupabaseRagClient {
  from(table: string): MinimalSupabaseFromBuilder
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<SupabaseRagRpcResult<unknown[]>>
}

// =============================================================================
// PgvectorRagIndex
// =============================================================================

export interface PgvectorRagIndexConfig {
  /** Cliente Supabase (user-authed via cookies recomendado). */
  supabaseClient: MinimalSupabaseRagClient
  /** Cliente de embeddings para chunks + preguntas. */
  embeddingClient: OpenAIEmbeddingClient
  /** Cliente de chat completions para responder con citas. */
  chatClient: ChatCompletionClient
  /** Tabla de chunks. Default 'transcripcion_chunks'. */
  tableName?: string
  /** RPC de search por similaridad coseno. Default 'search_chunks'. */
  searchRpcName?: string
  /** RPC de search cross-sesion a nivel proyecto. Default 'search_chunks_proyecto'. */
  searchProjectRpcName?: string
  /** Cap por chunk en chars. Default DEFAULT_MAX_CHUNK_CHARS (2000 ~ 500 tokens). */
  maxChunkChars?: number
  /** K para search top-K (Ask de una sesion). Default 8. */
  defaultTopK?: number
  /** K para search top-K en Ask de proyecto (abarca varias sesiones). Default 12. */
  defaultProjectTopK?: number
}

interface SearchChunkRow {
  chunk_id: string
  text: string
  start_ms: number
  end_ms: number
  similarity: number
  /** Opcional — la migracion incluye speaker_id pero el contrato es flexible. */
  speaker_id?: number | null
}

const ASK_SYSTEM_PROMPT = [
  'Eres un asistente que responde preguntas sobre una transcripcion de audio en espanol mexicano.',
  'IMPORTANTE: responde SOLO basandote en los CHUNKS proporcionados.',
  'Si los chunks no contienen la informacion suficiente para responder con certeza, en "answer" responde "No encuentro esa informacion en la transcripcion" y deja "used_chunk_indexes" vacio.',
  'Tu respuesta debe ser CONCISA y DIRECTA. Maximo 120 palabras.',
  'En "used_chunk_indexes" lista SOLO los indices (1-based) de los chunks que REALMENTE sustentan tu respuesta — los momentos exactos donde se menciona lo preguntado.',
  'NO listes chunks que recuperaste como contexto pero que no responden a la pregunta. Si solo 1 chunk responde, "used_chunk_indexes" tiene 1 elemento.',
  'Cuando hagas afirmaciones, cita textualmente porciones entre comillas.',
].join(' ')

const ASK_PROYECTO_SYSTEM_PROMPT = [
  'Eres un asistente que responde preguntas sobre un PROYECTO: el historial de varias reuniones/sesiones con un mismo cliente o relacion a traves del tiempo, en espanol mexicano.',
  'IMPORTANTE: responde SOLO basandote en los CHUNKS proporcionados (fragmentos de DISTINTAS sesiones del proyecto).',
  'Cada chunk indica de que SESION proviene y en que momento. Integra informacion de las distintas sesiones cuando aplique, y se claro sobre en que sesion se dijo cada cosa si es relevante.',
  'Si los chunks no contienen informacion suficiente para responder con certeza, en "answer" responde "No encuentro esa informacion en las sesiones del proyecto" y deja "used_chunk_indexes" vacio.',
  'Tu respuesta debe ser CONCISA y DIRECTA. Maximo 150 palabras.',
  'En "used_chunk_indexes" lista SOLO los indices (1-based) de los chunks que REALMENTE sustentan tu respuesta — no todos los recuperados.',
  'Cuando hagas afirmaciones, cita textualmente porciones entre comillas.',
].join(' ')

const ASK_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'used_chunk_indexes'],
  properties: {
    answer: {
      type: 'string',
      description: 'Respuesta directa a la pregunta del usuario en espanol mexicano. Maximo 120 palabras.',
    },
    used_chunk_indexes: {
      type: 'array',
      description:
        'Indices 1-based de los chunks que REALMENTE sustentan la respuesta. SOLO los que mencionan lo preguntado, no todos los recuperados.',
      items: { type: 'integer', minimum: 1 },
    },
  },
}

/**
 * Resuelve el nombre a mostrar de un hablante. Defensa en
 * profundidad: aunque el caller (server action) ya sanitiza al guardar, aqui
 * re-limpiamos saltos de linea / control chars y capeamos longitud antes de que
 * el nombre llegue al prompt del LLM — un nombre NO debe poder hacerse pasar por
 * instruccion del sistema.
 */
function speakerLabelFor(
  speakerId: number | null | undefined,
  names?: Record<string, string>,
): string {
  if (speakerId === undefined || speakerId === null) return 'Speaker ?'
  const raw = names?.[String(speakerId)]
  if (typeof raw === 'string') {
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    if (clean.length > 0) return clean
  }
  return `Speaker ${speakerId}`
}

/**
 * Construye una linea-roster de participantes para el system prompt, solo con
 * los hablantes presentes en los chunks recuperados que tengan nombre real.
 * Vacio si no hay nombres aplicables.
 */
function buildSpeakerRoster(
  chunks: SearchChunkRow[],
  names?: Record<string, string>,
): string {
  if (!names) return ''
  const ids = new Set<number>()
  for (const c of chunks) {
    if (typeof c.speaker_id === 'number' && Number.isFinite(c.speaker_id)) {
      ids.add(c.speaker_id)
    }
  }
  const entries = Array.from(ids)
    .sort((a, b) => a - b)
    .map((id) => ({ id, label: speakerLabelFor(id, names) }))
    .filter((e) => e.label !== `Speaker ${e.id}`)
    .map((e) => `Speaker ${e.id} = ${e.label}`)
  if (entries.length === 0) return ''
  return `PARTICIPANTES: cuando el usuario mencione un nombre, mapealo a su hablante y atribuye correctamente lo que dijo cada quien. Mapa: ${entries.join('; ')}.`
}

function formatChunksForPrompt(
  chunks: SearchChunkRow[],
  speakerNames?: Record<string, string>,
): string {
  return chunks
    .map((c, i) => {
      const startSec = Math.round((c.start_ms ?? 0) / 1000)
      const endSec = Math.round((c.end_ms ?? 0) / 1000)
      const minS = Math.floor(startSec / 60)
      const secS = startSec % 60
      const minE = Math.floor(endSec / 60)
      const secE = endSec % 60
      const stamp = `[${String(minS).padStart(2, '0')}:${String(secS).padStart(2, '0')}-${String(minE).padStart(2, '0')}:${String(secE).padStart(2, '0')}]`
      const speakerLabel = speakerLabelFor(c.speaker_id, speakerNames)
      return `CHUNK ${i + 1} ${stamp} ${speakerLabel}:\n${c.text}`
    })
    .join('\n\n')
}

/** Fila del RPC cross-sesion: incluye la sesion de origen (id + titulo). */
interface SearchProjectChunkRow extends SearchChunkRow {
  transcripcion_id: string
  titulo: string | null
}

/**
 * Formatea chunks de VARIAS sesiones para el prompt. Cada chunk se etiqueta con
 * su sesion de origen + timestamp + hablante, resolviendo el nombre con el
 * speaker_names de ESA transcripcion (Speaker 1 puede ser distinto entre sesiones).
 */
function formatProjectChunksForPrompt(
  chunks: SearchProjectChunkRow[],
  namesByTx?: Record<string, Record<string, string>>,
): string {
  return chunks
    .map((c, i) => {
      const startSec = Math.round((c.start_ms ?? 0) / 1000)
      const endSec = Math.round((c.end_ms ?? 0) / 1000)
      const minS = Math.floor(startSec / 60)
      const secS = startSec % 60
      const minE = Math.floor(endSec / 60)
      const secE = endSec % 60
      const stamp = `[${String(minS).padStart(2, '0')}:${String(secS).padStart(2, '0')}-${String(minE).padStart(2, '0')}:${String(secE).padStart(2, '0')}]`
      const speakerLabel = speakerLabelFor(c.speaker_id, namesByTx?.[c.transcripcion_id])
      const sesion = (c.titulo ?? 'Sesion').slice(0, 80)
      return `CHUNK ${i + 1} [Sesion: ${sesion} · ${stamp}] ${speakerLabel}:\n${c.text}`
    })
    .join('\n\n')
}

export class PgvectorRagIndex implements ProjectAwareRagIndex {
  private readonly client: MinimalSupabaseRagClient
  private readonly embeddingClient: OpenAIEmbeddingClient
  private readonly chatClient: ChatCompletionClient
  private readonly tableName: string
  private readonly searchRpcName: string
  private readonly searchProjectRpcName: string
  private readonly maxChunkChars: number
  private readonly defaultTopK: number
  private readonly defaultProjectTopK: number

  constructor(config: PgvectorRagIndexConfig) {
    if (!config.supabaseClient || typeof config.supabaseClient.from !== 'function') {
      throw new RagError(
        'PgvectorRagIndex: supabaseClient invalido (falta .from).',
        '<init>',
      )
    }
    if (!config.embeddingClient) {
      throw new RagError(
        'PgvectorRagIndex: embeddingClient requerido.',
        '<init>',
      )
    }
    if (!config.chatClient || typeof config.chatClient.complete !== 'function') {
      throw new RagError(
        'PgvectorRagIndex: chatClient invalido (falta .complete).',
        '<init>',
      )
    }
    this.client = config.supabaseClient
    this.embeddingClient = config.embeddingClient
    this.chatClient = config.chatClient
    this.tableName = config.tableName ?? 'transcripcion_chunks'
    this.searchRpcName = config.searchRpcName ?? 'search_chunks'
    this.searchProjectRpcName = config.searchProjectRpcName ?? 'search_chunks_proyecto'
    this.maxChunkChars = config.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS
    this.defaultTopK = config.defaultTopK ?? 8
    this.defaultProjectTopK = config.defaultProjectTopK ?? 12
  }

  async index(
    transcriptionId: string,
    segments: TranscriptSegment[],
    options?: RagIndexOptions,
  ): Promise<RagIndexResult> {
    if (!transcriptionId || transcriptionId.length < 10) {
      throw new RagError('PgvectorRagIndex.index: transcriptionId invalido.', transcriptionId)
    }
    const ownerUserId = options?.ownerUserId
    if (!ownerUserId || ownerUserId.length < 10) {
      throw new RagError(
        'PgvectorRagIndex.index: options.ownerUserId es requerido (uuid del owner).',
        transcriptionId,
      )
    }

    const chunks = chunkBySpeakerTurn(segments, this.maxChunkChars)

    // Limpieza idempotente: si ya habia chunks (reindex), borrarlos antes.
    const { error: delError } = await this.client
      .from(this.tableName)
      .delete()
      .eq('transcripcion_id', transcriptionId)
    if (delError) {
      throw new RagError(
        `PgvectorRagIndex.index: delete previo fallo: ${delError.message}`,
        transcriptionId,
        delError,
      )
    }

    const texts = chunks.map((c) => c.text)
    const embeddingBatch = await this.embeddingClient.embedBatch(texts)

    if (embeddingBatch.vectors.length !== chunks.length) {
      throw new RagError(
        `PgvectorRagIndex.index: mismatch vectors (${embeddingBatch.vectors.length}) vs chunks (${chunks.length}).`,
        transcriptionId,
      )
    }

    const rows = chunks.map((c, i) => ({
      transcripcion_id: transcriptionId,
      user_id: ownerUserId,
      chunk_index: c.chunk_index,
      text: c.text,
      start_ms: c.start_ms,
      end_ms: c.end_ms,
      speaker_id: c.speaker_id,
      embedding: embeddingBatch.vectors[i],
    }))

    const { error: insertError } = await this.client.from(this.tableName).insert(rows)
    if (insertError) {
      throw new RagError(
        `PgvectorRagIndex.index: insert fallo: ${insertError.message}`,
        transcriptionId,
        insertError,
      )
    }

    return {
      chunks_inserted: chunks.length,
      cost_usd: embeddingBatch.cost_usd,
      prompt_tokens: embeddingBatch.prompt_tokens,
      model_used: embeddingBatch.model_used,
    }
  }

  async ask(
    transcriptionId: string,
    question: string,
    speakerNames?: Record<string, string>,
  ): Promise<AskResult> {
    if (!transcriptionId || transcriptionId.length < 10) {
      throw new RagError('PgvectorRagIndex.ask: transcriptionId invalido.', transcriptionId)
    }
    const cleanQuestion = (question ?? '').trim()
    if (cleanQuestion.length === 0) {
      throw new RagError('PgvectorRagIndex.ask: question vacia.', transcriptionId)
    }
    if (cleanQuestion.length > 2000) {
      throw new RagError(
        `PgvectorRagIndex.ask: question demasiado larga (${cleanQuestion.length} chars, max 2000).`,
        transcriptionId,
      )
    }

    const questionEmbedding = await this.embeddingClient.embed(cleanQuestion)
    const queryVector = questionEmbedding.vectors[0]
    if (!queryVector) {
      throw new RagError(
        'PgvectorRagIndex.ask: embedding de la pregunta vacio.',
        transcriptionId,
      )
    }

    const { data: rpcData, error: rpcError } = await this.client.rpc(this.searchRpcName, {
      p_transcripcion_id: transcriptionId,
      p_query_embedding: queryVector,
      p_match_count: this.defaultTopK,
    })

    if (rpcError) {
      throw new RagError(
        `PgvectorRagIndex.ask: rpc ${this.searchRpcName} fallo: ${rpcError.message}`,
        transcriptionId,
        rpcError,
      )
    }

    const chunks = (Array.isArray(rpcData) ? rpcData : []) as SearchChunkRow[]

    if (chunks.length === 0) {
      return {
        answer:
          'No encuentro información en la transcripción indexada para responder esa pregunta. Confirma que ya esté indexada.',
        citations: [],
        model_used: questionEmbedding.model_used,
        cost_usd: questionEmbedding.cost_usd,
      }
    }

    // Roster de participantes con nombres reales: se inyecta en el
    // system prompt para que el LLM mapee "¿que dijo Fulano?" al speaker correcto.
    const roster = buildSpeakerRoster(chunks, speakerNames)
    const systemPrompt = roster ? `${ASK_SYSTEM_PROMPT} ${roster}` : ASK_SYSTEM_PROMPT

    const userPrompt = [
      `PREGUNTA DEL USUARIO: "${cleanQuestion}"`,
      '',
      'CHUNKS RECUPERADOS DE LA TRANSCRIPCION (por similaridad descendente):',
      '',
      formatChunksForPrompt(chunks, speakerNames),
      '',
      'Responde a la pregunta con maxima precision. En used_chunk_indexes lista SOLO los CHUNKS que mencionan lo preguntado (1-based), no todos los recuperados.',
    ].join('\n')

    const chatResult = await this.chatClient.complete({
      systemPrompt,
      userPrompt,
      jsonSchema: {
        name: 'ask_response',
        schema: ASK_RESPONSE_SCHEMA,
      },
    })

    // Parse strict JSON response
    let parsed: { answer?: unknown; used_chunk_indexes?: unknown }
    try {
      parsed = JSON.parse(chatResult.content) as {
        answer?: unknown
        used_chunk_indexes?: unknown
      }
    } catch (cause) {
      throw new RagError(
        `PgvectorRagIndex.ask: LLM devolvio JSON no parseable: ${chatResult.content.slice(0, 200)}`,
        transcriptionId,
        cause,
      )
    }

    const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : ''
    if (answer.length === 0) {
      throw new RagError(
        'PgvectorRagIndex.ask: LLM devolvio answer vacio.',
        transcriptionId,
      )
    }

    const rawIndexes = Array.isArray(parsed.used_chunk_indexes)
      ? parsed.used_chunk_indexes
      : []
    // Convertir a 0-based, validar rango, deduplicar
    const usedIndexes = new Set<number>()
    for (const raw of rawIndexes) {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n) || !Number.isInteger(n)) continue
      const zeroBased = n - 1
      if (zeroBased >= 0 && zeroBased < chunks.length) {
        usedIndexes.add(zeroBased)
      }
    }

    // Citations: solo las que el LLM identifico como sustento real
    const filteredChunks = Array.from(usedIndexes)
      .sort((a, b) => a - b)
      .map((i) => chunks[i]!)

    const citations: AskCitation[] = filteredChunks.map((c) => {
      if (c.speaker_id === undefined || c.speaker_id === null) {
        return { text: c.text, start_ms: c.start_ms, end_ms: c.end_ms, speaker: undefined }
      }
      const label = speakerLabelFor(c.speaker_id, speakerNames)
      const hasRealName = label !== `Speaker ${c.speaker_id}`
      return {
        text: c.text,
        start_ms: c.start_ms,
        end_ms: c.end_ms,
        speaker: hasRealName ? { id: c.speaker_id, label } : { id: c.speaker_id },
      }
    })

    return {
      answer,
      citations,
      model_used: chatResult.model_used,
      cost_usd: Math.round((chatResult.cost_usd + questionEmbedding.cost_usd) * 1_000_000) / 1_000_000,
    }
  }

  async askProyecto(
    proyectoId: string,
    question: string,
    speakerNamesByTranscription?: Record<string, Record<string, string>>,
  ): Promise<ProjectAskResult> {
    if (!proyectoId || proyectoId.length < 10) {
      throw new RagError('PgvectorRagIndex.askProyecto: proyectoId invalido.', proyectoId)
    }
    const cleanQuestion = (question ?? '').trim()
    if (cleanQuestion.length === 0) {
      throw new RagError('PgvectorRagIndex.askProyecto: question vacia.', proyectoId)
    }
    if (cleanQuestion.length > 2000) {
      throw new RagError(
        `PgvectorRagIndex.askProyecto: question demasiado larga (${cleanQuestion.length} chars, max 2000).`,
        proyectoId,
      )
    }

    const questionEmbedding = await this.embeddingClient.embed(cleanQuestion)
    const queryVector = questionEmbedding.vectors[0]
    if (!queryVector) {
      throw new RagError('PgvectorRagIndex.askProyecto: embedding de la pregunta vacio.', proyectoId)
    }

    const { data: rpcData, error: rpcError } = await this.client.rpc(this.searchProjectRpcName, {
      p_proyecto_id: proyectoId,
      p_query_embedding: queryVector,
      p_match_count: this.defaultProjectTopK,
    })
    if (rpcError) {
      throw new RagError(
        `PgvectorRagIndex.askProyecto: rpc ${this.searchProjectRpcName} fallo: ${rpcError.message}`,
        proyectoId,
        rpcError,
      )
    }

    const chunks = (Array.isArray(rpcData) ? rpcData : []) as SearchProjectChunkRow[]
    if (chunks.length === 0) {
      return {
        answer:
          'No encuentro información en las sesiones del proyecto para responder esa pregunta. Asegúrate de que sus sesiones estén indexadas.',
        citations: [],
        model_used: questionEmbedding.model_used,
        cost_usd: questionEmbedding.cost_usd,
      }
    }

    const userPrompt = [
      `PREGUNTA DEL USUARIO: "${cleanQuestion}"`,
      '',
      'CHUNKS RECUPERADOS DE LAS SESIONES DEL PROYECTO (por similaridad descendente):',
      '',
      formatProjectChunksForPrompt(chunks, speakerNamesByTranscription),
      '',
      'Responde con máxima precisión. En used_chunk_indexes lista SOLO los CHUNKS que sustentan la respuesta (1-based).',
    ].join('\n')

    const chatResult = await this.chatClient.complete({
      systemPrompt: ASK_PROYECTO_SYSTEM_PROMPT,
      userPrompt,
      jsonSchema: { name: 'ask_response', schema: ASK_RESPONSE_SCHEMA },
    })

    let parsed: { answer?: unknown; used_chunk_indexes?: unknown }
    try {
      parsed = JSON.parse(chatResult.content) as {
        answer?: unknown
        used_chunk_indexes?: unknown
      }
    } catch (cause) {
      throw new RagError(
        `PgvectorRagIndex.askProyecto: LLM devolvió JSON no parseable: ${chatResult.content.slice(0, 200)}`,
        proyectoId,
        cause,
      )
    }

    const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : ''
    if (answer.length === 0) {
      throw new RagError('PgvectorRagIndex.askProyecto: LLM devolvió answer vacío.', proyectoId)
    }

    const rawIndexes = Array.isArray(parsed.used_chunk_indexes) ? parsed.used_chunk_indexes : []
    const usedIndexes = new Set<number>()
    for (const raw of rawIndexes) {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n) || !Number.isInteger(n)) continue
      const zeroBased = n - 1
      if (zeroBased >= 0 && zeroBased < chunks.length) usedIndexes.add(zeroBased)
    }

    const filteredChunks = Array.from(usedIndexes)
      .sort((a, b) => a - b)
      .map((i) => chunks[i]!)

    const citations: ProjectAskCitation[] = filteredChunks.map((c) => {
      const names = speakerNamesByTranscription?.[c.transcripcion_id]
      const cita: ProjectAskCitation = {
        text: c.text,
        start_ms: c.start_ms,
        end_ms: c.end_ms,
        transcripcion_id: c.transcripcion_id,
        titulo_sesion: c.titulo ?? 'Sesión',
      }
      if (typeof c.speaker_id === 'number') {
        const label = speakerLabelFor(c.speaker_id, names)
        const hasRealName = label !== `Speaker ${c.speaker_id}`
        cita.speaker = hasRealName ? { id: c.speaker_id, label } : { id: c.speaker_id }
      }
      return cita
    })

    return {
      answer,
      citations,
      model_used: chatResult.model_used,
      cost_usd:
        Math.round((chatResult.cost_usd + questionEmbedding.cost_usd) * 1_000_000) / 1_000_000,
    }
  }
}
