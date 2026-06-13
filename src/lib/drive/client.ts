// =============================================================================
// PRP-TT-V2 Fase 6C — Cliente REST de Google Drive (fetch directo)
// =============================================================================
// Con scope drive.file: crea carpetas y sube archivos que la app genera. No lee
// ni toca nada mas del Drive del usuario. SOLO server-side.
// =============================================================================

import 'server-only'
import { randomUUID } from 'node:crypto'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

/**
 * Email de la cuenta de Google conectada. `about.get` con `fields=user` funciona
 * con scope drive.file. Best-effort: null si falla (no debe tumbar el OAuth).
 */
export async function getDriveAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${DRIVE_API}/about?fields=user(emailAddress)`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { user?: { emailAddress?: string } }
    return data.user?.emailAddress ?? null
  } catch {
    return null
  }
}

/**
 * Busca una carpeta por nombre bajo `parentId` (o la raiz). La crea si no
 * existe. Devuelve su id. Idempotente: reusar evita duplicar carpetas.
 */
export async function ensureFolder(
  accessToken: string,
  name: string,
  parentId?: string,
): Promise<string> {
  const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const q = [
    `mimeType='${FOLDER_MIME}'`,
    'trashed=false',
    `name='${safeName}'`,
    `'${parentId ?? 'root'}' in parents`,
  ].join(' and ')

  const searchUrl = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive&pageSize=1`
  const res = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.ok) {
    const data = (await res.json()) as { files?: { id?: string }[] }
    const existing = data.files?.[0]?.id
    if (existing) return existing
  }

  const meta: Record<string, unknown> = { name, mimeType: FOLDER_MIME }
  if (parentId) meta.parents = [parentId]
  const createRes = await fetch(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  })
  if (!createRes.ok) {
    throw new Error(`No se pudo crear la carpeta en Drive (${createRes.status}).`)
  }
  const created = (await createRes.json()) as { id: string }
  return created.id
}

/**
 * Busca un archivo por nombre exacto bajo `parentId` (no en papelera). Devuelve
 * su id o null. Con scope drive.file solo encuentra archivos creados por la app
 * (justo los que esta funcion crea), asi que sirve para upsert idempotente.
 */
async function findFile(
  accessToken: string,
  name: string,
  parentId: string,
): Promise<string | null> {
  const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const q = [`name='${safeName}'`, `'${parentId}' in parents`, 'trashed=false'].join(' and ')
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive&pageSize=1`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return null
  const data = (await res.json()) as { files?: { id?: string }[] }
  return data.files?.[0]?.id ?? null
}

/**
 * Sube un archivo a `parentId`. IDEMPOTENTE: si ya existe uno con el mismo
 * nombre en la carpeta, reemplaza su contenido (no duplica). Asi "Actualizar en
 * Drive" actualiza de verdad en vez de acumular copias. Devuelve el id.
 */
export async function uploadFile(
  accessToken: string,
  file: { name: string; mimeType: string; content: Uint8Array | string; parentId: string },
): Promise<string> {
  const existingId = await findFile(accessToken, file.name, file.parentId)

  // Cast: Uint8Array es BlobPart valido en runtime; el generico ArrayBufferLike
  // de TS 5.7 no calza con el tipo del DOM, pero la conversion es segura.
  const content = file.content as BlobPart

  // Ya existe → reemplaza solo el contenido (media update, conserva nombre/carpeta).
  if (existingId) {
    const res = await fetch(`${UPLOAD_API}/files/${existingId}?uploadType=media&fields=id`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': file.mimeType },
      body: new Blob([content], { type: file.mimeType }),
    })
    if (!res.ok) {
      throw new Error(`No se pudo actualizar "${file.name}" en Drive (${res.status}).`)
    }
    return existingId
  }

  // No existe → crea (multipart: metadata + media).
  const boundary = `tagtx-${randomUUID()}`
  const metadata = JSON.stringify({ name: file.name, parents: [file.parentId] })
  const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${file.mimeType}\r\n\r\n`
  const post = `\r\n--${boundary}--`
  const body = new Blob([pre, content, post])

  const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })
  if (!res.ok) {
    throw new Error(`No se pudo subir "${file.name}" a Drive (${res.status}).`)
  }
  const data = (await res.json()) as { id: string }
  return data.id
}
