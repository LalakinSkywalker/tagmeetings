// =============================================================================
// R2StorageAdapter — implementacion de StorageAdapter contra Cloudflare R2
// =============================================================================
// Reemplaza a SupabaseStorageAdapter. R2 es S3-compatible, asi que
// generamos URLs firmadas SigV4 (PUT para subir, GET para descargar). Deepgram
// descarga el audio desde la URL firmada GET (publicamente accesible + temporal,
// el patron recomendado por Deepgram).
//
// IMPORTANTE: SOLO server-side. Las credenciales R2 (R2_SECRET_ACCESS_KEY) NUNCA
// deben llegar al cliente. El cliente solo recibe la URL firmada ya generada.
//
// A diferencia de Supabase, el presigned PUT lleva la auth en la query string:
// no hay "token" aparte. El cliente hace fetch(url, { method: 'PUT', body }).
// =============================================================================

import 'server-only'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  StorageError,
  type SignedUploadUrl,
  type SignedUrlOptions,
  type StorageAdapter,
} from '@bluntag/transcription-core'

export interface R2StorageAdapterConfig {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** Default https://<accountId>.r2.cloudflarestorage.com */
  endpoint?: string
  /** TTL maximo permitido para URLs firmadas. Default 21600s (6h) para cubrir
   *  la descarga de audios largos por Deepgram. */
  maxExpiresInSec?: number
}

/** Clampa el TTL pedido al maximo permitido (defense in depth). */
function clampExpires(requestedSec: number, maxSec: number): number {
  if (!Number.isFinite(requestedSec) || requestedSec <= 0) return Math.min(60, maxSec)
  return Math.min(requestedSec, maxSec)
}

function assertSafePath(path: string): void {
  if (!path || path.includes('..')) {
    throw new StorageError(
      'R2StorageAdapter: path invalido (vacio o intenta path traversal).',
      path,
    )
  }
}

export class R2StorageAdapter implements StorageAdapter {
  private readonly client: S3Client
  private readonly bucket: string
  private readonly maxExpiresInSec: number

  constructor(config: R2StorageAdapterConfig) {
    if (
      !config.accountId ||
      !config.accessKeyId ||
      !config.secretAccessKey ||
      !config.bucket
    ) {
      throw new StorageError(
        'R2StorageAdapter: faltan credenciales (accountId/accessKeyId/secretAccessKey/bucket).',
        '<init>',
      )
    }
    this.bucket = config.bucket
    this.maxExpiresInSec = config.maxExpiresInSec ?? 21_600
    this.client = new S3Client({
      region: 'auto',
      endpoint:
        config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }

  async getSignedUploadUrl(
    path: string,
    opts: SignedUrlOptions,
  ): Promise<SignedUploadUrl> {
    assertSafePath(path)
    const expiresIn = clampExpires(opts.expiresInSec, this.maxExpiresInSec)
    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({ Bucket: this.bucket, Key: path }),
        { expiresIn },
      )
      // Sin Content-Type firmado: el navegador puede mandar el header que quiera
      // sin romper la firma. Sin "fields": la auth viaja en la query string.
      return { url }
    } catch (cause) {
      throw new StorageError(
        `R2StorageAdapter: getSignedUploadUrl fallo: ${cause instanceof Error ? cause.message : String(cause)}`,
        path,
        cause,
      )
    }
  }

  async getSignedDownloadUrl(
    path: string,
    opts: SignedUrlOptions,
  ): Promise<string> {
    assertSafePath(path)
    const expiresIn = clampExpires(opts.expiresInSec, this.maxExpiresInSec)
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: path }),
        { expiresIn },
      )
    } catch (cause) {
      throw new StorageError(
        `R2StorageAdapter: getSignedDownloadUrl fallo: ${cause instanceof Error ? cause.message : String(cause)}`,
        path,
        cause,
      )
    }
  }

  /**
   * Borra un objeto del bucket. Usado al eliminar una sesion (su audio ya no
   * sirve y libera storage). NO esta en la interfaz `StorageAdapter` del paquete
   * core (que solo modela subir/descargar) — es una extension propia del adapter
   * R2. R2/S3 NO falla si el objeto no existe (DeleteObject es idempotente), asi
   * que borrar dos veces o borrar un path inexistente es seguro.
   */
  async deleteObject(path: string): Promise<void> {
    assertSafePath(path)
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: path }),
      )
    } catch (cause) {
      throw new StorageError(
        `R2StorageAdapter: deleteObject fallo: ${cause instanceof Error ? cause.message : String(cause)}`,
        path,
        cause,
      )
    }
  }
}
