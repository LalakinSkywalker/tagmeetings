import 'server-only'

// =============================================================================
// lifecycle — ciclo de vida de los audios en R2 (Bloque Almacenamiento)
// =============================================================================
// `correrCicloAlmacenamiento` recorre las sesiones con audio aun en R2 y, segun
// la politica del usuario (retencion + respaldo + aviso), avisa o libera el
// audio. Espeja el patron del watchdog: service-role, CAS anti-race, resumen
// JSON. La logica de DECISION vive en funciones puras testeables.
//
// SALVAGUARDA DURA (no-negociable): si el respaldo esta activado, NUNCA se borra
// un audio sin respaldo CONFIRMADO. En modo auto se respalda y solo se borra si
// el respaldo devolvio ok=true; si falla, no se borra y se reintenta el proximo
// ciclo. En modo manual solo se borra si ya hay respaldo previo (archivado_en).
//
// ALCANCE: cubre sesiones SINGLE (audio en transcripciones.audio_path) Y las
// MULTIFUENTE (audios reales en transcripcion_fuentes.audio_path, PRP-TT-ALM2).
// El barrido single libera el audio del padre; el barrido multifuente libera cada
// fuente de audio/video como unidad independiente (respaldo + borrado por fuente,
// salvaguarda por fuente, flag agregado en el padre). NUNCA se borra la
// transcripcion, analisis, chunks ni la fila de la fuente: solo el objeto de R2.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveUserSettings, type UserSettings } from '@/lib/settings'
import { enviarPushAUsuario } from '@/lib/notifications/push'
import { respaldarAudioEnDrive, respaldarFuenteEnDrive } from '@/lib/drive/backup'
import { getStorageAdapter } from '@/lib/transcription'
import { decidirAccion, diasParaExpirar, planBorrado, PATHS_NO_REALES } from './lifecycle-rules'

/**
 * Borra un objeto de R2. `deleteObject` solo existe en R2StorageAdapter, no en la
 * interfaz del paquete compartido (no se toca para no romper otros consumidores) → mismo
 * cast que usa deleteStorageObjects. Lanza si el adapter no lo soporta o si R2
 * falla, para que el caller revierta el flag de liberacion. Idempotente en R2.
 */
async function borrarObjetoR2(audioPath: string): Promise<void> {
  const adapter = getStorageAdapter() as unknown as {
    deleteObject?: (p: string) => Promise<void>
  }
  if (typeof adapter.deleteObject !== 'function') {
    throw new Error('storage adapter sin deleteObject')
  }
  await adapter.deleteObject(audioPath)
}

// ---------------------------------------------------------------------------
// Motor (con BD). Las decisiones puras viven en ./lifecycle-rules (testeables).
// ---------------------------------------------------------------------------

export interface CicloAccion {
  id: string
  accion: 'avisado' | 'liberado' | 'respaldado_y_liberado' | 'bloqueado_salvaguarda' | 'respaldo_fallido'
  detalle?: string
}

export interface CicloResult {
  revisados: number
  avisados: number
  liberados: number
  saltados: number
  acciones: CicloAccion[]
  // Multifuente (PRP-TT-ALM2): conteo del segundo barrido (por fuente).
  mfSesionesRevisadas: number
  mfFuentesLiberadas: number
  mfFuentesSaltadas: number
  mfAvisados: number
}

interface FilaSesion {
  id: string
  user_id: string
  audio_path: string
  created_at: string
  completed_at: string | null
  archivado_en: string | null
  audio_liberado_en: string | null
  aviso_expiracion_enviado_en: string | null
}

/**
 * Ejecuta un ciclo completo de almacenamiento. Idempotente y seguro ante
 * concurrencia (CAS por `audio_liberado_en IS NULL` / `aviso_..._en IS NULL`:
 * dos crons no avisan ni borran dos veces). Devuelve resumen para el log del cron.
 * NUNCA expone datos crudos al exterior.
 */
export async function correrCicloAlmacenamiento(supabase: SupabaseClient): Promise<CicloResult> {
  const acciones: CicloAccion[] = []
  let revisados = 0
  let avisados = 0
  let liberados = 0
  let saltados = 0
  const ahoraMs = Date.now()

  // Solo sesiones SINGLE completadas con audio real aun en R2.
  const { data: filas } = await supabase
    .from('transcripciones')
    .select(
      'id, user_id, audio_path, created_at, completed_at, archivado_en, audio_liberado_en, aviso_expiracion_enviado_en',
    )
    .eq('es_multifuente', false)
    .eq('estado', 'completado')
    .is('audio_liberado_en', null)
    .limit(200)

  // Cache de settings por usuario (evita resolver N veces para el mismo dueno).
  const settingsCache = new Map<string, Awaited<ReturnType<typeof resolveUserSettings>>>()
  async function settingsDe(userId: string) {
    const hit = settingsCache.get(userId)
    if (hit) return hit
    const s = await resolveUserSettings(supabase, userId)
    settingsCache.set(userId, s)
    return s
  }

  for (const raw of (filas ?? []) as FilaSesion[]) {
    const audioPath = raw.audio_path ?? ''
    // Sin audio real (placeholder/multifuente) → no liberable aqui.
    if (!audioPath || PATHS_NO_REALES.has(audioPath)) {
      saltados++
      continue
    }
    revisados++

    const settings = await settingsDe(raw.user_id)
    // base = cuando se completo (el audio dejo de ser necesario); fallback created_at.
    const baseMs = new Date(raw.completed_at ?? raw.created_at).getTime()

    const accion = decidirAccion({
      retencionDias: settings.retencionAudioDias,
      baseMs,
      ahoraMs,
      avisoActivo: settings.avisoExpiracionActivo,
      avisoDias: settings.avisoExpiracionDias,
      avisoYaEnviado: raw.aviso_expiracion_enviado_en !== null,
    })

    if (accion === 'skip' || accion === 'esperar') {
      saltados++
      continue
    }

    if (accion === 'avisar') {
      // CAS: reclamar el aviso (solo uno gana) antes de enviar.
      const { data: claim } = await supabase
        .from('transcripciones')
        .update({ aviso_expiracion_enviado_en: new Date().toISOString() })
        .eq('id', raw.id)
        .is('aviso_expiracion_enviado_en', null)
        .select('id')
      if (!claim || claim.length === 0) continue // otro cron lo tomo

      const restantes = Math.max(
        1,
        Math.ceil(diasParaExpirar({ baseMs, retencionDias: settings.retencionAudioDias, ahoraMs })),
      )
      await enviarPushAUsuario(raw.user_id, {
        title: 'Tu audio está por expirar',
        body:
          restantes === 1
            ? 'Un audio se liberará mañana. La transcripción se queda; el audio original no.'
            : `Un audio se liberará en ${restantes} días. La transcripción se queda; el audio original no.`,
        url: `/dashboard/transcripcion/${raw.id}`,
        tag: `audio-expira-${raw.id}`,
      })
      avisados++
      acciones.push({ id: raw.id, accion: 'avisado', detalle: `${restantes}d` })
      continue
    }

    // accion === 'borrar'
    const plan = planBorrado({
      respaldoModo: settings.respaldoModo,
      tieneRespaldoPrevio: raw.archivado_en !== null,
    })

    if (plan.bloqueado) {
      // Manual sin respaldo previo → la salvaguarda impide borrar. No tocar.
      saltados++
      acciones.push({ id: raw.id, accion: 'bloqueado_salvaguarda' })
      continue
    }

    if (plan.respaldarPrimero) {
      const res = await respaldarAudioEnDrive(supabase, {
        transcripcionId: raw.id,
        userId: raw.user_id,
      })
      if (!res.ok) {
        // Salvaguarda: respaldo fallido → NO borrar, reintentar proximo ciclo.
        saltados++
        acciones.push({ id: raw.id, accion: 'respaldo_fallido', detalle: res.error?.slice(0, 120) })
        continue
      }
    }

    // CAS: reclamar el borrado (audio_liberado_en IS NULL) antes de tocar R2.
    const { data: claim } = await supabase
      .from('transcripciones')
      .update({ audio_liberado_en: new Date().toISOString() })
      .eq('id', raw.id)
      .is('audio_liberado_en', null)
      .select('id')
    if (!claim || claim.length === 0) continue // otro cron ya lo libero

    try {
      await borrarObjetoR2(audioPath)
      liberados++
      acciones.push({
        id: raw.id,
        accion: plan.respaldarPrimero ? 'respaldado_y_liberado' : 'liberado',
      })
    } catch (err) {
      // El objeto R2 no se borro: revertir el flag para reintentar el proximo ciclo.
      await supabase
        .from('transcripciones')
        .update({ audio_liberado_en: null })
        .eq('id', raw.id)
      const msg = err instanceof Error ? err.message : String(err)
      acciones.push({ id: raw.id, accion: 'respaldo_fallido', detalle: `R2 delete: ${msg.slice(0, 100)}` })
    }
  }

  // --- Segundo barrido: sesiones MULTIFUENTE (audios en transcripcion_fuentes).
  const mf = await barrerMultifuente(supabase, { ahoraMs, settingsDe })

  return {
    revisados,
    avisados,
    liberados,
    saltados,
    acciones: [...acciones, ...mf.acciones],
    mfSesionesRevisadas: mf.sesionesRevisadas,
    mfFuentesLiberadas: mf.fuentesLiberadas,
    mfFuentesSaltadas: mf.fuentesSaltadas,
    mfAvisados: mf.avisados,
  }
}

// ---------------------------------------------------------------------------
// Barrido multifuente (PRP-TT-ALM2): libera el audio de cada fuente de las
// sesiones combinadas. Espeja el barrido single con un nivel extra de iteracion
// por fuente. Reusa las MISMAS decisiones puras (decidirAccion/planBorrado), la
// salvaguarda dura y el CAS anti-race, ahora a nivel `transcripcion_fuentes`.
// ---------------------------------------------------------------------------

interface FilaPadreMf {
  id: string
  user_id: string
  created_at: string
  completed_at: string | null
  aviso_expiracion_enviado_en: string | null
}

interface FilaFuente {
  id: string
  audio_path: string | null
  tipo: string
  orden: number
  archivado_en: string | null
}

interface ResultadoMf {
  sesionesRevisadas: number
  avisados: number
  fuentesLiberadas: number
  fuentesSaltadas: number
  acciones: CicloAccion[]
}

async function barrerMultifuente(
  supabase: SupabaseClient,
  ctx: { ahoraMs: number; settingsDe: (userId: string) => Promise<UserSettings> },
): Promise<ResultadoMf> {
  const acciones: CicloAccion[] = []
  let sesionesRevisadas = 0
  let avisados = 0
  let fuentesLiberadas = 0
  let fuentesSaltadas = 0

  // Sesiones combinadas completadas cuyo flag agregado del padre aun no se encendio
  // (audio_liberado_en IS NULL = al menos una fuente con audio sigue en R2).
  const { data: padres } = await supabase
    .from('transcripciones')
    .select('id, user_id, created_at, completed_at, aviso_expiracion_enviado_en')
    .eq('es_multifuente', true)
    .eq('estado', 'completado')
    .is('audio_liberado_en', null)
    .limit(200)

  for (const padre of (padres ?? []) as FilaPadreMf[]) {
    // Fuentes de audio/video con audio real aun en R2.
    const { data: fuentesRaw } = await supabase
      .from('transcripcion_fuentes')
      .select('id, audio_path, tipo, orden, archivado_en')
      .eq('transcripcion_id', padre.id)
      .in('tipo', ['audio', 'video'])
      .is('audio_liberado_en', null)
      .order('orden', { ascending: true })

    const elegibles = ((fuentesRaw ?? []) as FilaFuente[]).filter(
      (f) => f.audio_path && !PATHS_NO_REALES.has(f.audio_path),
    )
    if (elegibles.length === 0) continue // documentos/placeholders: nada que liberar aqui
    sesionesRevisadas++

    const settings = await ctx.settingsDe(padre.user_id)
    const baseMs = new Date(padre.completed_at ?? padre.created_at).getTime()

    const accion = decidirAccion({
      retencionDias: settings.retencionAudioDias,
      baseMs,
      ahoraMs: ctx.ahoraMs,
      avisoActivo: settings.avisoExpiracionActivo,
      avisoDias: settings.avisoExpiracionDias,
      avisoYaEnviado: padre.aviso_expiracion_enviado_en !== null,
    })

    if (accion === 'skip' || accion === 'esperar') {
      fuentesSaltadas += elegibles.length
      continue
    }

    if (accion === 'avisar') {
      // Un solo aviso por SESION padre (no N por fuente). CAS sobre el padre.
      const { data: claim } = await supabase
        .from('transcripciones')
        .update({ aviso_expiracion_enviado_en: new Date().toISOString() })
        .eq('id', padre.id)
        .is('aviso_expiracion_enviado_en', null)
        .select('id')
      if (!claim || claim.length === 0) continue // otro cron lo tomo

      const restantes = Math.max(
        1,
        Math.ceil(diasParaExpirar({ baseMs, retencionDias: settings.retencionAudioDias, ahoraMs: ctx.ahoraMs })),
      )
      await enviarPushAUsuario(padre.user_id, {
        title: 'Tu audio está por expirar',
        body:
          restantes === 1
            ? 'Los audios de un análisis se liberarán mañana. La transcripción se queda; los audios originales no.'
            : `Los audios de un análisis se liberarán en ${restantes} días. La transcripción se queda; los audios originales no.`,
        url: `/dashboard/transcripcion/${padre.id}`,
        tag: `audio-expira-${padre.id}`,
      })
      avisados++
      acciones.push({ id: padre.id, accion: 'avisado', detalle: `mf ${restantes}d` })
      continue
    }

    // accion === 'borrar': procesar cada fuente como unidad independiente.
    for (const fuente of elegibles) {
      const plan = planBorrado({
        respaldoModo: settings.respaldoModo,
        tieneRespaldoPrevio: fuente.archivado_en !== null,
      })

      if (plan.bloqueado) {
        // Manual sin respaldo previo de ESTA fuente → la salvaguarda impide borrar.
        fuentesSaltadas++
        acciones.push({ id: fuente.id, accion: 'bloqueado_salvaguarda', detalle: `mf:${padre.id}` })
        continue
      }

      if (plan.respaldarPrimero) {
        const res = await respaldarFuenteEnDrive(supabase, { fuenteId: fuente.id, userId: padre.user_id })
        if (!res.ok) {
          // Salvaguarda: respaldo de esta fuente fallido → NO borrar; las demas siguen.
          fuentesSaltadas++
          acciones.push({ id: fuente.id, accion: 'respaldo_fallido', detalle: res.error?.slice(0, 120) })
          continue
        }
      }

      // CAS por fuente: reclamar audio_liberado_en IS NULL antes de tocar R2.
      const { data: claim } = await supabase
        .from('transcripcion_fuentes')
        .update({ audio_liberado_en: new Date().toISOString() })
        .eq('id', fuente.id)
        .is('audio_liberado_en', null)
        .select('id')
      if (!claim || claim.length === 0) continue // otro cron ya la libero

      try {
        await borrarObjetoR2(fuente.audio_path as string)
        fuentesLiberadas++
        acciones.push({
          id: fuente.id,
          accion: plan.respaldarPrimero ? 'respaldado_y_liberado' : 'liberado',
          detalle: `mf:${padre.id}`,
        })
      } catch (err) {
        // El objeto R2 no se borro: revertir el flag de la fuente para reintentar.
        await supabase
          .from('transcripcion_fuentes')
          .update({ audio_liberado_en: null })
          .eq('id', fuente.id)
        const msg = err instanceof Error ? err.message : String(err)
        acciones.push({ id: fuente.id, accion: 'respaldo_fallido', detalle: `R2 delete: ${msg.slice(0, 100)}` })
      }
    }

    // Flag agregado del padre: encender si YA no queda ninguna fuente de audio/video
    // con audio real sin liberar (mismo criterio de elegibilidad que arriba; el
    // filtro de placeholders se hace en JS para no depender de `not.in` raw). CAS
    // sobre el padre (idempotente).
    const { data: restantesRaw } = await supabase
      .from('transcripcion_fuentes')
      .select('id, audio_path')
      .eq('transcripcion_id', padre.id)
      .in('tipo', ['audio', 'video'])
      .is('audio_liberado_en', null)
    const pendientes = ((restantesRaw ?? []) as Array<{ audio_path: string | null }>).filter(
      (f) => f.audio_path && !PATHS_NO_REALES.has(f.audio_path),
    ).length
    if (pendientes === 0) {
      await supabase
        .from('transcripciones')
        .update({ audio_liberado_en: new Date().toISOString() })
        .eq('id', padre.id)
        .is('audio_liberado_en', null)
    }
  }

  return { sesionesRevisadas, avisados, fuentesLiberadas, fuentesSaltadas, acciones }
}
