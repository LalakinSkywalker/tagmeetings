// =============================================================================
// @bluntag/transcription-core — API publica
// =============================================================================
// Esta es la unica fuente de imports para consumidores del paquete.
// Cualquier cambio que rompa lo aqui exportado requiere MAJOR version bump.
// =============================================================================

// ---- Tipos publicos -------------------------------------------------------
export type {
  ActionItem,
  AnalysisResult,
  AnalysisTemplate,
  AskCitation,
  AskResult,
  ProjectAskCitation,
  ProjectAskResult,
  RagChunk,
  ReasoningEffort,
  SignedUploadUrl,
  SignedUrlOptions,
  Speaker,
  TranscribeAsyncOptions,
  TranscribeAsyncResult,
  TranscribeOptions,
  TranscriptSegment,
  TranscriptionResult,
} from './types/index'

// ---- Errores tipados ------------------------------------------------------
export {
  AnalysisError,
  RagError,
  StorageError,
  TranscriptionError,
} from './types/index'

// ---- Interfaces (lo que cada consumidor implementa o inyecta) -------------
export type { AnalysisEngine } from './engines/analysis-engine'
export type {
  RagIndex,
  ProjectAwareRagIndex,
  RagIndexOptions,
  RagIndexResult,
} from './rag/rag-index'
export type { StorageAdapter } from './storage/storage-adapter'
export type {
  AsyncTranscriptionProvider,
  TranscriptionProvider,
} from './providers/transcription-provider'

// ---- Stubs deterministic -------------------------------------------------
// Utiles para dev/tests y para que el consumidor valide su wiring sin pagar
// llamadas reales. Permanecen exportados aun con providers reales disponibles.
export { MockAnalysisEngine } from './engines/analysis-engine'
export { MockRagIndex } from './rag/rag-index'
export { MockStorageAdapter } from './storage/storage-adapter'
export { MockTranscriptionProvider } from './providers/transcription-provider'

// ---- Implementaciones reales -------------------------
export { DeepgramProvider } from './providers/deepgram-provider'
export type { DeepgramProviderConfig } from './providers/deepgram-provider'
export { SupabaseStorageAdapter } from './storage/supabase-storage-adapter'
export type {
  MinimalSupabaseClient,
  SupabaseStorageAdapterConfig,
} from './storage/supabase-storage-adapter'

// ---- Implementaciones reales -------------------------
export { LLMAnalysisEngine, DEFAULT_MODEL_PRICES } from './engines/llm-analysis-engine'
export type {
  LLMAnalysisEngineConfig,
  ModelPricing,
} from './engines/llm-analysis-engine'

// ---- Traductor -----------------
export { LLMTranslator } from './engines/llm-translator'
export type {
  LLMTranslatorConfig,
  TranslateResult,
} from './engines/llm-translator'

// ---- Implementaciones reales -------------------------
export {
  PgvectorRagIndex,
  chunkBySpeakerTurn,
  DEFAULT_MAX_CHUNK_CHARS,
} from './rag/rag-index'
export type {
  MinimalSupabaseRagClient,
  PgvectorRagIndexConfig,
  SpeakerChunk,
} from './rag/rag-index'
export {
  OpenAIEmbeddingClient,
  DEFAULT_EMBEDDING_PRICES,
} from './rag/openai-embedding-client'
export type {
  EmbeddingBatch,
  EmbeddingPricing,
  OpenAIEmbeddingClientConfig,
} from './rag/openai-embedding-client'
export { OpenRouterChatClient } from './rag/openrouter-chat-client'
export type {
  ChatCompletionClient,
  ChatCompletionRequest,
  ChatCompletionResult,
  OpenRouterChatClientConfig,
} from './rag/openrouter-chat-client'

// ---- Plantillas de TagMeetings (referencia) ---------------------------
// Cada consumidor puede usar estas o definir las suyas. Otro consumidor define
// sus propias plantillas de dominio en SU repo, no aqui. Estas
// son las plantillas de analisis que usa TagMeetings.
export {
  PLANTILLA_DISCOVERY,
  PLANTILLA_IDEA_SUELTA,
  PLANTILLA_INTERNA,
  PLANTILLA_PROVEEDOR,
  PLANTILLA_SEGUIMIENTO,
  PLANTILLA_REUNION_GENERAL,
  PLANTILLA_CLASE_CONFERENCIA,
  PLANTILLA_ENTREVISTA,
  PLANTILLA_MEDIOS_NOTICIERO,
  PLANTILLAS_TAGTRANSCRIPTOR,
  PLANTILLAS_TAGTRANSCRIPTOR_LIST,
  PLANTILLAS_GRUPOS,
  PLANTILLA_ALIASES,
  // Building blocks reutilizables (para compilar plantillas de usuario).
  BASE_SYSTEM_PROMPT_PROLOGO,
  BASE_USER_TEMPLATE,
  BASE_REQUIRED,
  BASE_PROPERTIES,
  ACTION_ITEM_SCHEMA,
} from './templates/templates'

// ---- Plantillas customizables por usuario --------------
// El asesor de IA emite una PlantillaSpec; el compilador ensambla un schema
// strict-valido + prompt_system consistente de forma determinística.
export {
  compileCustomTemplate,
  normalizePlantillaSpec,
  buildOutputSchema,
  customTemplateToAnalysisTemplate,
  PLANTILLA_SPEC_SCHEMA,
  CUSTOM_TEMPLATE_PREFIX,
  isCustomTemplateId,
  customTemplateUuid,
  MAX_CAMPOS,
} from './templates/custom-template-builder'
export type {
  CampoTipo,
  CampoSpec,
  PlantillaSpec,
  CompiledTemplate,
} from './templates/custom-template-builder'
