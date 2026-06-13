// =============================================================================
// Adaptador del app contra @bluntag/transcription-core.
// =============================================================================
// Fase 2 (PRP-TT-001): cambia de stubs Mock a providers reales (Deepgram +
// SupabaseStorageAdapter). Feature flag USE_MOCK_PROVIDERS=true mantiene los
// Mocks activos para tests o desarrollo offline.
//
// IMPORTANTE: este archivo SOLO se importa server-side (server actions, route
// handlers). Nunca desde Client Components — el constructor del DeepgramProvider
// requiere DEEPGRAM_API_KEY que jamas debe llegar al cliente.
// =============================================================================

import 'server-only'
import {
  DeepgramProvider,
  LLMAnalysisEngine,
  LLMTranslator,
  MockAnalysisEngine,
  MockRagIndex,
  MockStorageAdapter,
  MockTranscriptionProvider,
  OpenAIEmbeddingClient,
  OpenRouterChatClient,
  PgvectorRagIndex,
  PLANTILLAS_TAGTRANSCRIPTOR_LIST,
  PLANTILLAS_GRUPOS,
  PLANTILLA_ALIASES,
  customTemplateToAnalysisTemplate,
  customTemplateUuid,
  type AnalysisEngine,
  type AnalysisTemplate,
  type MinimalSupabaseRagClient,
  type ProjectAwareRagIndex,
  type StorageAdapter,
  type TranscriptionProvider,
} from '@bluntag/transcription-core'
import { R2StorageAdapter } from './r2-storage-adapter'

// NOTA: no se llama "useMocks" a proposito — el prefijo `use` hace que ESLint
// la confunda con un React hook (rules-of-hooks). Es solo un helper de entorno.
function shouldUseMocks(): boolean {
  return process.env.USE_MOCK_PROVIDERS === 'true'
}

/**
 * Provider real Deepgram Nova-3 (Fase 2). En modo USE_MOCK_PROVIDERS devuelve
 * MockTranscriptionProvider para tests/dev offline.
 */
export function getTranscriptionProvider(): TranscriptionProvider {
  if (shouldUseMocks()) return new MockTranscriptionProvider()

  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) {
    throw new Error(
      'getTranscriptionProvider: falta DEEPGRAM_API_KEY. Configurarla en .env.local (dev) o Vercel env (prod). Alternativa: USE_MOCK_PROVIDERS=true para tests.',
    )
  }
  return new DeepgramProvider({ apiKey })
}

/**
 * StorageAdapter real Cloudflare R2 (bucket privado, PRP-TT-004). Reemplaza a
 * Supabase Storage para librarnos del tope de 50MB/archivo del plan Free de
 * Supabase. R2 es S3-compatible: URLs firmadas SigV4 que Deepgram puede
 * descargar. En modo Mock devuelve MockStorageAdapter con URLs fake.
 */
export function getStorageAdapter(): StorageAdapter {
  if (shouldUseMocks()) return new MockStorageAdapter()

  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      'getStorageAdapter: faltan vars de R2 (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET). Configurarlas en .env.local (dev) o Vercel env (prod). Alternativa: USE_MOCK_PROVIDERS=true.',
    )
  }
  return new R2StorageAdapter({
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint: process.env.R2_ENDPOINT,
  })
}

/** Placeholders de audio_path que NUNCA corresponden a un objeto real en R2. */
const NON_REAL_AUDIO_PATHS = new Set(['placeholder', 'multifuente'])

/**
 * Borra objetos de audio del storage (al eliminar una sesion). BEST-EFFORT:
 * - En modo Mock es no-op (no hay objetos reales).
 * - Filtra placeholders ('placeholder', 'multifuente') y vacios.
 * - Usa Promise.allSettled: si un objeto no existe o R2 falla en uno, NO tumba
 *   el resto ni propaga (el borrado en BD ya se hizo; el storage es secundario).
 *
 * El metodo `deleteObject` solo existe en R2StorageAdapter (no en la interfaz
 * `StorageAdapter` del paquete core), por eso el narrowing local por capacidad.
 */
export async function deleteStorageObjects(paths: Array<string | null | undefined>): Promise<void> {
  if (shouldUseMocks()) return
  const limpios = Array.from(
    new Set(
      paths.filter(
        (p): p is string =>
          typeof p === 'string' && p.length > 0 && !NON_REAL_AUDIO_PATHS.has(p),
      ),
    ),
  )
  if (limpios.length === 0) return

  const adapter = getStorageAdapter() as unknown as {
    deleteObject?: (path: string) => Promise<void>
  }
  if (typeof adapter.deleteObject !== 'function') return

  const resultados = await Promise.allSettled(
    limpios.map((p) => adapter.deleteObject!(p)),
  )
  for (const r of resultados) {
    if (r.status === 'rejected') {
      console.error(
        `[deleteStorageObjects] no se pudo borrar un objeto de R2 (best-effort): ${
          r.reason instanceof Error ? r.reason.message : String(r.reason)
        }`,
      )
    }
  }
}

/**
 * AnalysisEngine real (Fase 3): LLMAnalysisEngine via OpenRouter con
 * `openai/gpt-5-mini` por default. En modo USE_MOCK_PROVIDERS devuelve
 * MockAnalysisEngine para tests/dev offline.
 *
 * Decision de modelo (2026-05-27): gpt-5-mini por strict mode con
 * enforcement matematico, 6x mas barato que Gemini 3.5 Flash, latencia
 * empatada en modo minimal. Cambiar con OPENROUTER_MODEL sin tocar codigo.
 */
export function getAnalysisEngine(): AnalysisEngine {
  if (shouldUseMocks()) return new MockAnalysisEngine()

  const apiKey = process.env.OPENROUTER_API_KEY
  const model = process.env.OPENROUTER_MODEL ?? 'openai/gpt-5-mini'
  if (!apiKey) {
    throw new Error(
      'getAnalysisEngine: falta OPENROUTER_API_KEY. Configurarla en .env.local (dev) o Vercel env (prod). Alternativa: USE_MOCK_PROVIDERS=true para tests.',
    )
  }
  return new LLMAnalysisEngine({
    apiKey,
    model,
    defaultReasoningEffort: 'minimal',
  })
}

/**
 * RagIndex real (Fase 5): PgvectorRagIndex con OpenAI text-embedding-3-small
 * + OpenRouter chat completions para Ask. Recibe el supabaseClient del caller
 * — debe ser user-authed (cookies) tanto para index() como ask() porque:
 *   - index() inserta a transcripcion_chunks con RLS auth.uid()=user_id
 *   - ask() llama RPC search_chunks que filtra por auth.uid() interno
 *
 * En modo USE_MOCK_PROVIDERS devuelve MockRagIndex para tests/dev offline.
 */
export function getRagIndex(
  // Accepts unknown porque SupabaseClient v2 tiene generics demasiado profundos
  // para checar estructuralmente contra MinimalSupabaseRagClient (bug TS).
  // El cast es seguro: el client de @supabase/ssr/@supabase/supabase-js v2
  // implementa .from(table).insert/.delete/.select + .rpc(fn, args).
  supabaseClient: unknown,
): ProjectAwareRagIndex {
  if (shouldUseMocks()) return new MockRagIndex()

  const openrouterKey = process.env.OPENROUTER_API_KEY
  if (!openrouterKey) {
    throw new Error(
      'getRagIndex: falta OPENROUTER_API_KEY. Necesaria para responder Asks con LLM.',
    )
  }

  // Embeddings (BYOK self-host): si el usuario trae su propia OPENAI_API_KEY se
  // usa el endpoint nativo de OpenAI; si NO la trae, los embeddings se piden a
  // OpenRouter (endpoint /embeddings OpenAI-compatible) reusando OPENROUTER_API_KEY.
  // Asi OPENAI_API_KEY deja de ser obligatoria: 4 servicios core en vez de 5.
  const openaiKey = process.env.OPENAI_API_KEY
  const embeddingClient = openaiKey
    ? new OpenAIEmbeddingClient({
        apiKey: openaiKey,
        model: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      })
    : new OpenAIEmbeddingClient({
        apiKey: openrouterKey,
        baseUrl: 'https://openrouter.ai/api/v1',
        model: process.env.OPENAI_EMBEDDING_MODEL ?? 'openai/text-embedding-3-small',
      })
  const chatClient = new OpenRouterChatClient({
    apiKey: openrouterKey,
    model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-5-mini',
    defaultReasoningEffort: 'minimal',
  })

  return new PgvectorRagIndex({
    supabaseClient: supabaseClient as MinimalSupabaseRagClient,
    embeddingClient,
    chatClient,
    tableName: 'transcripcion_chunks',
    searchRpcName: 'search_chunks',
  })
}

/**
 * Traductor LLM (PRP-TT-V2 Fase 2): traduce transcripciones que no estan en
 * espanol al espanol, reusando el modelo barato gpt-5-mini via OpenRouter. En
 * modo USE_MOCK_PROVIDERS devuelve null (el flujo Mock siempre es es-MX, no
 * necesita traduccion). Devuelve null si falta la key — el caller trata null
 * como "no traducir" (degrada con gracia: el audio queda en su idioma original).
 */
export function getTranslator(): LLMTranslator | null {
  if (shouldUseMocks()) return null

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return null
  const model = process.env.OPENROUTER_MODEL ?? 'openai/gpt-5-mini'
  return new LLMTranslator({
    apiKey,
    model,
    defaultReasoningEffort: 'minimal',
  })
}

/**
 * Cliente de chat OpenRouter (PRP-TT-V2 Fase 3): usado por el asesor de
 * plantillas para (a) conversar en texto libre guiando al usuario y (b) generar
 * la PlantillaSpec en JSON strict. Reusa la misma key + modelo gpt-5-mini que el
 * resto del motor. Lanza si falta la key (no degrada — el asesor no tiene sentido
 * sin LLM). Server-side only.
 */
export function getChatClient(): OpenRouterChatClient {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new Error(
      'getChatClient: falta OPENROUTER_API_KEY. Configurarla en .env.local (dev) o Vercel env (prod).',
    )
  }
  const model = process.env.OPENROUTER_MODEL ?? 'openai/gpt-5-mini'
  return new OpenRouterChatClient({ apiKey, model, defaultReasoningEffort: 'minimal' })
}

/**
 * Plantillas disponibles para el selector de UI antes de subir audio.
 * Reexport del paquete para que el resto del app no tenga que importar
 * directo de @bluntag/transcription-core.
 */
export const TEMPLATES_AVAILABLE: AnalysisTemplate[] =
  PLANTILLAS_TAGTRANSCRIPTOR_LIST

/**
 * Resuelve una plantilla por id, aplicando aliases de plantillas legacy
 * (PRP-TT-V2 Fase 2): si el id ya no existe pero tiene alias (ej.
 * 'presencial-prospecto' → 'discovery' tras la fusion), devuelve la vigente.
 * Devuelve undefined si no hay plantilla ni alias. Usar en TODO lugar que
 * resuelva template_id de una transcripcion (re-analisis, webhook).
 */
export function resolveTemplate(id: string): AnalysisTemplate | undefined {
  const direct = TEMPLATES_AVAILABLE.find((t) => t.id === id)
  if (direct) return direct
  const aliased = PLANTILLA_ALIASES[id]
  if (aliased) return TEMPLATES_AVAILABLE.find((t) => t.id === aliased)
  return undefined
}

// Interface minima del cliente Supabase que necesita resolveTemplateAsync (igual
// patron que MinimalSupabaseRagClient: los generics de supabase-js v2 son muy
// profundos para checar estructuralmente, asi que casteamos a esta forma simple).
interface TemplateQuery {
  eq(col: string, val: string): TemplateQuery
  maybeSingle(): Promise<{ data: unknown; error: unknown }>
}
interface TemplateLookupClient {
  from(table: string): { select(cols: string): TemplateQuery }
}

interface PlantillaUsuarioRow {
  nombre: string
  descripcion: string | null
  prompt_system: string
  prompt_user_template: string
  output_schema: Record<string, unknown>
}

/**
 * Resuelve una plantilla por template_id cubriendo AMBOS casos (PRP-TT-V2 Fase 3):
 *   - predefinidas (sincrono, via resolveTemplate / aliases), y
 *   - de usuario (`custom:<uuid>`): lee `plantillas_usuario` con el cliente dado.
 *
 * `userId` es OBLIGATORIO en contextos service-role (webhook) porque el service
 * client bypassa RLS — sin el filtro explicito por user_id un template_id custom
 * de otro usuario seria resoluble. Con cliente user-authed (server action) RLS ya
 * filtra, pero pasarlo igual es defensa en profundidad. Devuelve undefined si no
 * existe / no es del usuario.
 */
export async function resolveTemplateAsync(
  supabaseClient: unknown,
  templateId: string,
  userId?: string,
): Promise<AnalysisTemplate | undefined> {
  const direct = resolveTemplate(templateId)
  if (direct) return direct

  const uuid = customTemplateUuid(templateId)
  if (!uuid) return undefined

  const client = supabaseClient as TemplateLookupClient
  let query = client
    .from('plantillas_usuario')
    .select('nombre, descripcion, prompt_system, prompt_user_template, output_schema')
    .eq('id', uuid)
  if (userId) query = query.eq('user_id', userId)

  const { data, error } = await query.maybeSingle()
  if (error || !data) return undefined

  const row = data as PlantillaUsuarioRow
  return customTemplateToAnalysisTemplate({
    id: templateId,
    nombre: row.nombre,
    descripcion: row.descripcion,
    prompt_system: row.prompt_system,
    prompt_user_template: row.prompt_user_template,
    output_schema: row.output_schema,
  })
}

/**
 * Agrupacion de plantillas (General vs Ventas y negocio) para el selector de UI.
 * Reexport del paquete — mejor guia, PRP-TT-V2 Fase 2.
 */
export const TEMPLATE_GRUPOS: Array<{ label: string; ids: string[] }> =
  PLANTILLAS_GRUPOS
