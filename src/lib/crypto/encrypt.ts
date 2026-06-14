// =============================================================================
// Cifrado simetrico de secretos (AES-256-GCM)
// =============================================================================
// Cifra/descifra los tokens OAuth de Google Drive antes de guardarlos en BD.
// AES-256-GCM = cifrado autenticado (detecta manipulacion). La llave vive en
// ENCRYPTION_KEY (server-only, 32 bytes en base64 o hex) y NUNCA en codigo.
//
// Formato del payload: "<iv_b64>.<tag_b64>.<ciphertext_b64>".
// SOLO server-side.
// =============================================================================

import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12 // recomendado para GCM

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY no configurada. Genera 32 bytes: `openssl rand -base64 32` y ponla en .env.local + Vercel.',
    )
  }
  // Acepta hex (64 chars) o base64 (44 chars con padding).
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY debe representar exactamente 32 bytes (AES-256).')
  }
  return key
}

/** Cifra un string y devuelve el payload "iv.tag.ciphertext" en base64. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, getKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`
}

/** Descifra un payload generado por encryptSecret. Lanza si fue manipulado. */
export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.')
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Payload cifrado invalido.')
  }
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ])
  return dec.toString('utf8')
}
