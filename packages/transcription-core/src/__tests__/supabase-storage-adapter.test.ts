import { describe, expect, it, vi } from 'vitest'
import {
  SupabaseStorageAdapter,
  type MinimalSupabaseClient,
} from '../storage/supabase-storage-adapter'
import { StorageError } from '../types/index'

function makeMockClient(
  signedUploadResult: {
    data?: { signedUrl: string; token: string; path: string }
    error?: { message: string }
  },
  signedDownloadResult: {
    data?: { signedUrl: string }
    error?: { message: string }
  },
): { client: MinimalSupabaseClient; calls: { uploadPath?: string; downloadPath?: string; downloadExpires?: number; bucket?: string } } {
  const calls: {
    uploadPath?: string
    downloadPath?: string
    downloadExpires?: number
    bucket?: string
  } = {}

  const client: MinimalSupabaseClient = {
    storage: {
      from(bucket: string) {
        calls.bucket = bucket
        return {
          createSignedUploadUrl: vi.fn(async (path: string) => {
            calls.uploadPath = path
            return {
              data: signedUploadResult.data ?? null,
              error: signedUploadResult.error ?? null,
            }
          }),
          createSignedUrl: vi.fn(async (path: string, expiresIn: number) => {
            calls.downloadPath = path
            calls.downloadExpires = expiresIn
            return {
              data: signedDownloadResult.data ?? null,
              error: signedDownloadResult.error ?? null,
            }
          }),
        }
      },
    },
  }

  return { client, calls }
}

describe('SupabaseStorageAdapter', () => {
  describe('constructor', () => {
    it('lanza StorageError si client es null', () => {
      expect(
        () => new SupabaseStorageAdapter({ client: null as unknown as MinimalSupabaseClient }),
      ).toThrow(StorageError)
    })

    it('lanza StorageError si client.storage falta', () => {
      expect(
        () =>
          new SupabaseStorageAdapter({
            client: {} as unknown as MinimalSupabaseClient,
          }),
      ).toThrow(StorageError)
    })

    it('acepta config minima con client valido', () => {
      const { client } = makeMockClient(
        { data: { signedUrl: 'u', token: 't', path: 'p' } },
        { data: { signedUrl: 'd' } },
      )
      const adapter = new SupabaseStorageAdapter({ client })
      expect(adapter).toBeDefined()
    })
  })

  describe('getSignedUploadUrl', () => {
    it('devuelve URL + fields con token y path', async () => {
      const { client } = makeMockClient(
        {
          data: {
            signedUrl: 'https://example.supabase.co/storage/v1/upload/sign/audios/u1/t1/audio.opus?token=abc',
            token: 'abc',
            path: 'u1/t1/audio.opus',
          },
        },
        { data: { signedUrl: 'irrelevant' } },
      )
      const adapter = new SupabaseStorageAdapter({ client })

      const result = await adapter.getSignedUploadUrl('u1/t1/audio.opus', {
        expiresInSec: 600,
      })

      expect(result.url).toContain('upload/sign')
      expect(result.fields).toEqual({
        token: 'abc',
        path: 'u1/t1/audio.opus',
      })
    })

    it('usa bucket "audios" por default', async () => {
      const { client, calls } = makeMockClient(
        {
          data: {
            signedUrl: 'u',
            token: 't',
            path: 'p',
          },
        },
        { data: { signedUrl: 'd' } },
      )
      const adapter = new SupabaseStorageAdapter({ client })

      await adapter.getSignedUploadUrl('u1/t1/audio.opus', { expiresInSec: 60 })

      expect(calls.bucket).toBe('audios')
    })

    it('respeta bucket custom', async () => {
      const { client, calls } = makeMockClient(
        { data: { signedUrl: 'u', token: 't', path: 'p' } },
        { data: { signedUrl: 'd' } },
      )
      const adapter = new SupabaseStorageAdapter({ client, bucket: 'audios-test' })

      await adapter.getSignedUploadUrl('x/y/z.mp3', { expiresInSec: 60 })

      expect(calls.bucket).toBe('audios-test')
    })

    it('lanza StorageError si el client devuelve error', async () => {
      const { client } = makeMockClient(
        { error: { message: 'permission denied' } },
        { data: { signedUrl: 'd' } },
      )
      const adapter = new SupabaseStorageAdapter({ client })

      await expect(
        adapter.getSignedUploadUrl('x/y/z.mp3', { expiresInSec: 60 }),
      ).rejects.toThrowError(/permission denied/)
    })

    it('lanza StorageError si path tiene path traversal "..',  async () => {
      const { client } = makeMockClient(
        { data: { signedUrl: 'u', token: 't', path: 'p' } },
        { data: { signedUrl: 'd' } },
      )
      const adapter = new SupabaseStorageAdapter({ client })

      await expect(
        adapter.getSignedUploadUrl('u1/../u2/audio.mp3', { expiresInSec: 60 }),
      ).rejects.toThrow(StorageError)
    })
  })

  describe('getSignedDownloadUrl', () => {
    it('devuelve signedUrl como string', async () => {
      const { client } = makeMockClient(
        { data: { signedUrl: 'u', token: 't', path: 'p' } },
        {
          data: {
            signedUrl: 'https://example.supabase.co/storage/v1/object/sign/audios/u1/t1/audio.opus?token=xyz',
          },
        },
      )
      const adapter = new SupabaseStorageAdapter({ client })

      const url = await adapter.getSignedDownloadUrl('u1/t1/audio.opus', {
        expiresInSec: 600,
      })

      expect(url).toContain('object/sign')
      expect(typeof url).toBe('string')
    })

    it('clampa TTL al maxExpiresInSec (default 3600)', async () => {
      const { client, calls } = makeMockClient(
        { data: { signedUrl: 'u', token: 't', path: 'p' } },
        { data: { signedUrl: 'd' } },
      )
      const adapter = new SupabaseStorageAdapter({ client })

      await adapter.getSignedDownloadUrl('u1/t1/audio.opus', {
        expiresInSec: 99999,
      })

      expect(calls.downloadExpires).toBe(3600)
    })

    it('respeta TTL pedido si es menor al max', async () => {
      const { client, calls } = makeMockClient(
        { data: { signedUrl: 'u', token: 't', path: 'p' } },
        { data: { signedUrl: 'd' } },
      )
      const adapter = new SupabaseStorageAdapter({ client })

      await adapter.getSignedDownloadUrl('u1/t1/audio.opus', {
        expiresInSec: 300,
      })

      expect(calls.downloadExpires).toBe(300)
    })

    it('clampa expires negativo o 0 a 60s', async () => {
      const { client, calls } = makeMockClient(
        { data: { signedUrl: 'u', token: 't', path: 'p' } },
        { data: { signedUrl: 'd' } },
      )
      const adapter = new SupabaseStorageAdapter({ client, maxExpiresInSec: 3600 })

      await adapter.getSignedDownloadUrl('u1/t1/audio.opus', {
        expiresInSec: -100,
      })

      expect(calls.downloadExpires).toBe(60)
    })

    it('lanza StorageError si el client falla', async () => {
      const { client } = makeMockClient(
        { data: { signedUrl: 'u', token: 't', path: 'p' } },
        { error: { message: 'object not found' } },
      )
      const adapter = new SupabaseStorageAdapter({ client })

      await expect(
        adapter.getSignedDownloadUrl('inexistente.mp3', { expiresInSec: 60 }),
      ).rejects.toThrowError(/object not found/)
    })

    it('lanza StorageError con path traversal', async () => {
      const { client } = makeMockClient(
        { data: { signedUrl: 'u', token: 't', path: 'p' } },
        { data: { signedUrl: 'd' } },
      )
      const adapter = new SupabaseStorageAdapter({ client })

      await expect(
        adapter.getSignedDownloadUrl('u1/../u2/audio.mp3', { expiresInSec: 60 }),
      ).rejects.toThrow(StorageError)
    })
  })
})
