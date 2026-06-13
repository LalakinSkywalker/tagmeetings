import type {
  SignedUploadUrl,
  SignedUrlOptions,
} from '../types/index'

/**
 * Interface canonica para almacenamiento de blobs (audio, futuras transcripciones .srt, etc.).
 *
 * Abstrae el origen de almacenamiento. Implementaciones previstas:
 * - `SupabaseStorageAdapter` (Fase 2) — Supabase Storage con bucket privado
 * - `MockStorageAdapter` (este archivo) — URLs fake para validar el flujo
 *
 * IMPORTANTE: el paquete NUNCA expone `service_role` al cliente. El
 * `SupabaseStorageAdapter` recibe via constructor el `supabaseClient` y
 * delega la generacion de signed URLs al backend del consumidor (server actions).
 */
export interface StorageAdapter {
  /**
   * Genera una URL firmada para SUBIR un blob. El consumidor decide path y nombre.
   * La URL expira en `opts.expiresInSec`.
   *
   * @throws StorageError si el provider falla.
   */
  getSignedUploadUrl(
    path: string,
    opts: SignedUrlOptions,
  ): Promise<SignedUploadUrl>

  /**
   * Genera una URL firmada para DESCARGAR un blob. La URL expira en
   * `opts.expiresInSec` (max recomendado 3600s).
   *
   * @throws StorageError si el path no existe o el provider falla.
   */
  getSignedDownloadUrl(
    path: string,
    opts: SignedUrlOptions,
  ): Promise<string>
}

/**
 * Stub deterministic. Devuelve URLs fake con timestamp para que el consumidor
 * pueda validar wiring sin tocar Supabase Storage real.
 */
export class MockStorageAdapter implements StorageAdapter {
  async getSignedUploadUrl(
    path: string,
    opts: SignedUrlOptions,
  ): Promise<SignedUploadUrl> {
    const expiresAt = Date.now() + opts.expiresInSec * 1000
    return {
      url: `https://mock-storage.bluntag.local/upload/${encodeURIComponent(path)}?expires=${expiresAt}`,
    }
  }

  async getSignedDownloadUrl(
    path: string,
    opts: SignedUrlOptions,
  ): Promise<string> {
    const expiresAt = Date.now() + opts.expiresInSec * 1000
    return `https://mock-storage.bluntag.local/download/${encodeURIComponent(path)}?expires=${expiresAt}`
  }
}
