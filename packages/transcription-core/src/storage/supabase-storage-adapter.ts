// =============================================================================
// SupabaseStorageAdapter — implementacion real de StorageAdapter
// =============================================================================
// Trabaja contra un MinimalSupabaseClient (duck typing) para evitar dependency
// hard en @supabase/supabase-js dentro del paquete. El consumidor pasa el client
// que ya tiene (el del app), TypeScript valida estructuralmente.
//
// IMPORTANTE: este adapter debe instanciarse SERVER-SIDE con un Supabase client
// que tenga permisos sobre Storage (anon authenticated o service_role). Si se
// instancia con service_role bypasea RLS — eso es intencional para signed URLs
// admin path en server actions. NUNCA exponer service_role al cliente.
// =============================================================================

import {
  StorageError,
  type SignedUploadUrl,
  type SignedUrlOptions,
} from '../types/index'
import type { StorageAdapter } from './storage-adapter'

interface SupabaseStorageResult<T> {
  data: T | null
  error: { message: string } | null
}

interface SupabaseSignedUploadData {
  signedUrl: string
  token: string
  path: string
}

interface SupabaseSignedDownloadData {
  signedUrl: string
}

/**
 * Subset minimo de la API de Supabase Storage que el adapter necesita.
 * Compatible estructuralmente con `supabase.storage.from(bucket)` de
 * @supabase/supabase-js v2. Definido aqui para no introducir dependency hard.
 */
interface MinimalStorageBucket {
  createSignedUploadUrl(
    path: string,
    options?: { upsert?: boolean },
  ): Promise<SupabaseStorageResult<SupabaseSignedUploadData>>
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<SupabaseStorageResult<SupabaseSignedDownloadData>>
}

interface MinimalSupabaseStorage {
  from(bucket: string): MinimalStorageBucket
}

/**
 * Shape minimo de un cliente Supabase que el adapter requiere.
 * Compatible con `SupabaseClient` de @supabase/supabase-js v2 sin importarlo.
 */
export interface MinimalSupabaseClient {
  storage: MinimalSupabaseStorage
}

export interface SupabaseStorageAdapterConfig {
  /** Cliente Supabase ya inicializado (server-side con service_role o auth). */
  client: MinimalSupabaseClient
  /** Bucket privado. Default 'audios'. */
  bucket?: string
  /** TTL maximo permitido para signed URLs en segundos. Default 3600 (1h). */
  maxExpiresInSec?: number
}

/**
 * Clampa el TTL pedido al maximo permitido. Defense in depth contra signed URLs
 * con TTL absurdamente largo (>24h) que rompen el modelo de seguridad.
 */
function clampExpires(requestedSec: number, maxSec: number): number {
  if (!Number.isFinite(requestedSec) || requestedSec <= 0) return Math.min(60, maxSec)
  return Math.min(requestedSec, maxSec)
}

export class SupabaseStorageAdapter implements StorageAdapter {
  private readonly client: MinimalSupabaseClient
  private readonly bucket: string
  private readonly maxExpiresInSec: number

  constructor(config: SupabaseStorageAdapterConfig) {
    if (!config.client || !config.client.storage) {
      throw new StorageError(
        'SupabaseStorageAdapter: client invalido (falta .storage).',
        '<init>',
      )
    }
    this.client = config.client
    this.bucket = config.bucket ?? 'audios'
    this.maxExpiresInSec = config.maxExpiresInSec ?? 3600
  }

  async getSignedUploadUrl(
    path: string,
    opts: SignedUrlOptions,
  ): Promise<SignedUploadUrl> {
    if (!path || path.includes('..')) {
      throw new StorageError(
        'SupabaseStorageAdapter: path invalido (vacio o intenta path traversal).',
        path,
      )
    }

    // Nota: createSignedUploadUrl de Supabase actualmente NO acepta expiresIn
    // como parametro publico — la URL tiene TTL fijo del lado de Supabase (~2h
    // por default). El parametro `opts.expiresInSec` queda como hint contractual
    // por si el provider de Storage evoluciona. Lo registramos para auditoria.
    void clampExpires(opts.expiresInSec, this.maxExpiresInSec)

    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUploadUrl(path, { upsert: false })

    if (error || !data) {
      throw new StorageError(
        `SupabaseStorageAdapter: createSignedUploadUrl fallo: ${error?.message ?? 'sin data'}`,
        path,
        error,
      )
    }

    return {
      url: data.signedUrl,
      fields: {
        token: data.token,
        path: data.path,
      },
    }
  }

  async getSignedDownloadUrl(
    path: string,
    opts: SignedUrlOptions,
  ): Promise<string> {
    if (!path || path.includes('..')) {
      throw new StorageError(
        'SupabaseStorageAdapter: path invalido (vacio o intenta path traversal).',
        path,
      )
    }

    const expires = clampExpires(opts.expiresInSec, this.maxExpiresInSec)

    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(path, expires)

    if (error || !data) {
      throw new StorageError(
        `SupabaseStorageAdapter: createSignedUrl fallo: ${error?.message ?? 'sin data'}`,
        path,
        error,
      )
    }

    return data.signedUrl
  }
}
