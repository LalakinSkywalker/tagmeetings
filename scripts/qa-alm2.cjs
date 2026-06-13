#!/usr/bin/env node
/* eslint-disable */
// =============================================================================
// qa-alm2.cjs — QA dedicado del flujo destructivo MULTIFUENTE (PRP-TT-ALM2)
// =============================================================================
// Crea un usuario QA AISLADO + sesiones multifuente SINTETICAS con objetos R2
// sinteticos, dispara el cron real (POST /api/cron/almacenamiento contra el dev
// server) en distintos escenarios, y verifica el comportamiento del barrido por
// fuente. NUNCA toca las 4 sesiones / 14 fuentes reales de Eduardo (retencion
// NULL = skip). Limpia TODO al final (sesiones + objetos R2 + usuario QA).
//
// USO: node scripts/qa-alm2.cjs   (requiere dev server en 127.0.0.1:3050)
// =============================================================================

const fs = require('node:fs')
const path = require('node:path')
const { createClient } = require('@supabase/supabase-js')
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3')

const DEV_URL = 'http://127.0.0.1:3050'
const QA_EMAIL = 'qa-alm2@tagtranscriptor.test'
const DIA = 86_400_000

function readEnv() {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', '.env.local'), 'utf8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

const env = readEnv()
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})
const s3 = new S3Client({
  region: 'auto',
  endpoint: env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
})
const BUCKET = env.R2_BUCKET

let PASS = 0
let FAIL = 0
function check(cond, msg) {
  if (cond) {
    console.log(`   ✓ ${msg}`)
    PASS++
  } else {
    console.log(`   ✗ FALLO: ${msg}`)
    FAIL++
  }
}

async function ensureQaUser() {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: QA_EMAIL, email_confirm: true }),
  })
  if (res.status === 200 || res.status === 201) {
    const j = await res.json()
    return j.id
  }
  // Ya existe → buscarlo.
  const { data } = await supabase.auth.admin.listUsers({ perPage: 1000 })
  const u = data.users.find((x) => x.email === QA_EMAIL)
  if (!u) throw new Error('No pude crear ni encontrar el user QA')
  return u.id
}

async function setSettings(userId, { retencion, respaldo, avisoActivo = true, avisoDias = 3 }) {
  const { error } = await supabase.from('user_settings').upsert(
    {
      user_id: userId,
      retencion_audio_dias: retencion,
      respaldo_modo: respaldo,
      aviso_expiracion_activo: avisoActivo,
      aviso_expiracion_dias: avisoDias,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  )
  if (error) throw new Error('setSettings: ' + error.message)
}

// Crea sesion multifuente sintetica + N fuentes + objetos R2.
async function crearSesion(userId, { completedHaceDias, fuentes }) {
  const completedAt = new Date(Date.now() - completedHaceDias * DIA).toISOString()
  const { data: padre, error: pErr } = await supabase
    .from('transcripciones')
    .insert({
      user_id: userId,
      titulo: 'QA ALM2 multifuente',
      template_id: 'discovery',
      estado: 'completado',
      es_multifuente: true,
      audio_path: 'multifuente',
      transcription_provider: 'multifuente',
      idioma: 'es-MX',
      completed_at: completedAt,
      analisis: { resumen: 'analisis QA combinado', bullets: ['x'], actionItems: [], customFields: {} },
    })
    .select('id')
    .single()
  if (pErr) throw new Error('crear padre: ' + pErr.message)
  const tid = padre.id

  const creadas = []
  for (let i = 0; i < fuentes.length; i++) {
    const f = fuentes[i]
    const { data: fila, error: fErr } = await supabase
      .from('transcripcion_fuentes')
      .insert({
        transcripcion_id: tid,
        user_id: userId,
        orden: i,
        tipo: f.tipo,
        nombre_archivo: f.nombre || `fuente-${i}.${f.tipo === 'pdf' ? 'pdf' : 'mp3'}`,
        size_bytes: f.size ?? 12345,
        estado: 'transcrito',
        audio_path: 'placeholder',
        raw_text: 'texto transcrito QA',
        texto_extraido: f.tipo === 'pdf' ? 'texto del pdf QA' : null,
        segments: f.tipo === 'pdf' ? null : [{ start: 0, end: 1000, speaker: 'A', text: 'hola' }],
        archivado_en: f.archivado ? new Date().toISOString() : null,
      })
      .select('id')
      .single()
    if (fErr) throw new Error('crear fuente: ' + fErr.message)
    const ext = f.tipo === 'pdf' ? 'pdf' : 'mp3'
    const key = `${userId}/${tid}/${fila.id}.${ext}`
    await supabase.from('transcripcion_fuentes').update({ audio_path: key }).eq('id', fila.id)
    // Objeto R2 sintetico (unos bytes).
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from(`QA-${fila.id}`), ContentType: 'application/octet-stream' }),
    )
    creadas.push({ id: fila.id, key, tipo: f.tipo })
  }
  return { tid, fuentes: creadas, completedAt }
}

async function r2Existe(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return true
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false
    throw e
  }
}

async function dispararCron() {
  const res = await fetch(`${DEV_URL}/api/cron/almacenamiento`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
  })
  const j = await res.json().catch(() => ({}))
  return { status: res.status, body: j }
}

async function leerFuente(id) {
  const { data } = await supabase
    .from('transcripcion_fuentes')
    .select('audio_liberado_en, archivado_en, raw_text, texto_extraido, segments, audio_path')
    .eq('id', id)
    .single()
  return data
}
async function leerPadre(id) {
  const { data } = await supabase
    .from('transcripciones')
    .select('audio_liberado_en, aviso_expiracion_enviado_en, analisis')
    .eq('id', id)
    .single()
  return data
}

async function borrarSesion(tid, userId) {
  // borrar objetos R2 de la sesion + filas (CASCADE de fuentes via FK).
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${userId}/${tid}/` }))
  for (const o of list.Contents || []) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key }))
  }
  await supabase.from('transcripcion_fuentes').delete().eq('transcripcion_id', tid)
  await supabase.from('transcripciones').delete().eq('id', tid)
}

async function main() {
  console.log('=== QA ALM2 — flujo destructivo multifuente (fuentes sinteticas) ===\n')
  const userId = await ensureQaUser()
  console.log('User QA:', userId, '\n')

  // -------------------------------------------------------------------------
  // E1 — off, retencion vencida: 2 audios + 1 pdf. Libera audios, NO el pdf,
  //      enciende flag del padre, transcripcion/analisis sobreviven.
  // -------------------------------------------------------------------------
  console.log('E1 — off vencido (2 audio + 1 pdf):')
  await setSettings(userId, { retencion: 30, respaldo: 'off' })
  {
    const s = await crearSesion(userId, {
      completedHaceDias: 40,
      fuentes: [{ tipo: 'audio' }, { tipo: 'audio' }, { tipo: 'pdf' }],
    })
    const r = await dispararCron()
    check(r.status === 200, `cron 200 (got ${r.status})`)
    const a0 = await leerFuente(s.fuentes[0].id)
    const a1 = await leerFuente(s.fuentes[1].id)
    const pdf = await leerFuente(s.fuentes[2].id)
    check(a0.audio_liberado_en && a1.audio_liberado_en, 'ambos audios marcados audio_liberado_en')
    check(!(await r2Existe(s.fuentes[0].key)) && !(await r2Existe(s.fuentes[1].key)), 'objetos R2 de los audios BORRADOS')
    check(!pdf.audio_liberado_en && (await r2Existe(s.fuentes[2].key)), 'el PDF NO se libero (sigue en R2)')
    check(a0.raw_text && a0.segments && a0.audio_path, 'fuente audio: raw_text/segments/audio_path INTACTOS')
    const padre = await leerPadre(s.tid)
    check(!!padre.audio_liberado_en, 'flag agregado del padre ENCENDIDO (todas las fuentes audio liberadas)')
    check(!!padre.analisis, 'analisis combinado del padre INTACTO')
    await borrarSesion(s.tid, userId)
  }

  // -------------------------------------------------------------------------
  // E2 — manual mixto: fuenteA con respaldo previo (borra), fuenteB sin (bloqueada).
  //      Aislamiento por fuente + flag del padre NO se enciende.
  // -------------------------------------------------------------------------
  console.log('\nE2 — manual mixto (A respaldada / B sin respaldo):')
  await setSettings(userId, { retencion: 30, respaldo: 'manual' })
  {
    const s = await crearSesion(userId, {
      completedHaceDias: 40,
      fuentes: [{ tipo: 'audio', archivado: true }, { tipo: 'audio', archivado: false }],
    })
    const r = await dispararCron()
    check(r.status === 200, `cron 200 (got ${r.status})`)
    const a = await leerFuente(s.fuentes[0].id)
    const b = await leerFuente(s.fuentes[1].id)
    check(a.audio_liberado_en && !(await r2Existe(s.fuentes[0].key)), 'fuente A (con respaldo) LIBERADA')
    check(!b.audio_liberado_en && (await r2Existe(s.fuentes[1].key)), 'fuente B (sin respaldo) BLOQUEADA por salvaguarda')
    const padre = await leerPadre(s.tid)
    check(!padre.audio_liberado_en, 'flag del padre NO encendido (queda B pendiente)')
    await borrarSesion(s.tid, userId)
  }

  // -------------------------------------------------------------------------
  // E3 — auto sin Drive: respaldo falla → NO borra (salvaguarda dura).
  // -------------------------------------------------------------------------
  console.log('\nE3 — auto sin Drive (salvaguarda: respaldo falla, no borra):')
  await setSettings(userId, { retencion: 30, respaldo: 'auto' })
  {
    const s = await crearSesion(userId, { completedHaceDias: 40, fuentes: [{ tipo: 'audio' }] })
    const r = await dispararCron()
    check(r.status === 200, `cron 200 (got ${r.status})`)
    const a = await leerFuente(s.fuentes[0].id)
    check(!a.audio_liberado_en && (await r2Existe(s.fuentes[0].key)), 'audio NO liberado (respaldo Drive fallo → salvaguarda)')
    check(!a.archivado_en, 'fuente NO marcada como respaldada (el upload no ocurrio)')
    await borrarSesion(s.tid, userId)
  }

  // -------------------------------------------------------------------------
  // E4 — aviso: dentro de ventana → avisa UNA vez (idempotente), no libera aun.
  // -------------------------------------------------------------------------
  console.log('\nE4 — aviso por sesion (idempotente, no libera):')
  await setSettings(userId, { retencion: 30, respaldo: 'off', avisoActivo: true, avisoDias: 3 })
  {
    const s = await crearSesion(userId, { completedHaceDias: 28, fuentes: [{ tipo: 'audio' }] })
    await dispararCron()
    const p1 = await leerPadre(s.tid)
    check(!!p1.aviso_expiracion_enviado_en, 'aviso marcado en el padre (1ra corrida)')
    const a1 = await leerFuente(s.fuentes[0].id)
    check(!a1.audio_liberado_en && (await r2Existe(s.fuentes[0].key)), 'audio NO liberado (aun no vence)')
    const t1 = p1.aviso_expiracion_enviado_en
    await dispararCron()
    const p2 = await leerPadre(s.tid)
    check(p2.aviso_expiracion_enviado_en === t1, 'aviso NO se reenvia en 2da corrida (idempotente)')
    await borrarSesion(s.tid, userId)
  }

  // -------------------------------------------------------------------------
  // E5 — retencion NULL: skip total (nada se toca). Default conservador.
  // -------------------------------------------------------------------------
  console.log('\nE5 — retencion NULL (nunca borrar → skip):')
  await setSettings(userId, { retencion: null, respaldo: 'off' })
  {
    const s = await crearSesion(userId, { completedHaceDias: 999, fuentes: [{ tipo: 'audio' }] })
    await dispararCron()
    const a = await leerFuente(s.fuentes[0].id)
    const p = await leerPadre(s.tid)
    check(!a.audio_liberado_en && (await r2Existe(s.fuentes[0].key)), 'audio intacto (retencion nunca)')
    check(!p.audio_liberado_en && !p.aviso_expiracion_enviado_en, 'padre intacto (sin flag ni aviso)')
    await borrarSesion(s.tid, userId)
  }

  // -------------------------------------------------------------------------
  // Limpieza total: borrar cualquier residuo + el usuario QA (CASCADE).
  // -------------------------------------------------------------------------
  console.log('\n=== LIMPIEZA ===')
  const { data: resto } = await supabase.from('transcripciones').select('id').eq('user_id', userId)
  for (const r of resto || []) await borrarSesion(r.id, userId)
  const leftover = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${userId}/` }))
  for (const o of leftover.Contents || []) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key }))
  }
  await supabase.from('user_settings').delete().eq('user_id', userId)
  await supabase.auth.admin.deleteUser(userId)
  console.log('Usuario QA + datos + objetos R2 eliminados.')

  console.log(`\n=== RESULTADO: ${PASS} PASS / ${FAIL} FAIL ===`)
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('ERROR FATAL:', err)
  process.exit(1)
})
