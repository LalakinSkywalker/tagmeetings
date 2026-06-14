'use server'

// =============================================================================
// Server actions — Proyectos con memoria
// =============================================================================
// Un Proyecto agrupa sesiones (transcripciones) de un cliente/relacion a traves
// del tiempo. Sesiones sueltas permitidas (proyecto_id NULL). Bloque 5A cubre:
//   - CRUD de proyectos (crear / listar / obtener / actualizar / borrar).
//   - Asignar / mover una sesion a un proyecto (o sacarla → suelta).
//   - Detalle de proyecto: sus sesiones + directorio de participantes agregado
//     (union de speaker_names de todas las sesiones, sin re-teclear).
//
// Seguridad: auth + ownership por user_id (RLS de proyectos filtra por
// auth.uid()=user_id; ademas filtramos por user_id explicito en escrituras como
// defensa en profundidad, igual que plantillas/transcripciones).
//
// Sanitizacion de texto con charCodeAt (NUNCA regex de clase de control chars:
// teclear el byte literal incrusta NUL y corrompe el .ts — regla dura del
// workspace, feedback_regex_control_chars_unicode_escape).
// =============================================================================

import { revalidatePath } from 'next/cache'
import { createClient as createUserSupabaseClient } from '@/lib/supabase/server'
import { COLORES_PROYECTO, COLOR_PROYECTO_DEFAULT } from '@/lib/proyectos'
import { getRagIndex, getChatClient } from '@/lib/transcription'

// Cap blando de proyectos por usuario (anti-abuso; Fase 8 formaliza cuotas).
const MAX_PROYECTOS_POR_USUARIO = 200
const NOMBRE_MAX = 120
const DESCRIPCION_MAX = 500

const COLORES_SET = new Set<string>(COLORES_PROYECTO)
const COLOR_DEFAULT = COLOR_PROYECTO_DEFAULT

export interface ProyectoListItem {
  id: string
  nombre: string
  descripcion: string
  color: string
  sesionesCount: number
  createdAt: string
  updatedAt: string
}

export interface ProyectoSesionItem {
  id: string
  titulo: string
  template_id: string
  estado: string
  categoria: string | null
  duracion_ms: number | null
  created_at: string
  completed_at: string | null
}

export interface ProyectoDetalle {
  id: string
  nombre: string
  descripcion: string
  color: string
  createdAt: string
  updatedAt: string
  sesiones: ProyectoSesionItem[]
  /** Directorio de participantes: union de nombres de hablantes de las sesiones. */
  participantes: string[]
  /** Memoria del histórico (resumen jerárquico). null si nunca se generó. */
  memoriaResumen: string | null
  memoriaGeneradaAt: string | null
  /** true si hay sesiones analizadas nuevas/cambiadas desde que se generó la memoria. */
  memoriaStale: boolean
  /** Sesiones del proyecto en estado 'completado' (las que alimentan la memoria). */
  sesionesCompletadasCount: number
  /** Tablero de pendientes vivo. */
  pendientes: PendienteDTO[]
  pendientesGeneradosAt: string | null
  /** true si hay sesiones nuevas/cambiadas desde que se generó el tablero. */
  pendientesStale: boolean
}

/** Un pendiente del tablero vivo del proyecto. */
export interface PendienteDTO {
  id: string
  texto: string
  owner: string | null
  dueDate: string | null
  estado: 'pendiente' | 'en_curso' | 'hecho'
  origen: 'ia' | 'usuario'
  estadoOrigen: 'ia' | 'usuario'
  notaIa: string | null
  /** Sesión de origen (null = manual o sesión borrada). */
  transcripcionId: string | null
  tituloSesion: string | null
  createdAt: string
}

export type EstadoPendiente = 'pendiente' | 'en_curso' | 'hecho'

export interface ProyectoResult {
  ok: boolean
  id?: string
  error?: string
}

// -----------------------------------------------------------------------------
// Helpers internos
// -----------------------------------------------------------------------------

/**
 * Limpia texto: descarta chars de control (< 32 y DEL 127), colapsa espacios,
 * recorta y aplica cap. charCodeAt, NO regex de control chars (bug NUL).
 */
function limpiarTexto(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return Array.from(raw)
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      return c >= 32 && c !== 127
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Valida el color contra la paleta; cualquier cosa fuera cae al default. */
function normalizarColor(raw: unknown): string {
  return typeof raw === 'string' && COLORES_SET.has(raw) ? raw : COLOR_DEFAULT
}

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

export interface CrearProyectoInput {
  nombre: string
  descripcion?: string
  color?: string
}

/** Crea un proyecto del usuario. */
export async function crearProyecto(input: CrearProyectoInput): Promise<ProyectoResult> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const nombre = limpiarTexto(input.nombre, NOMBRE_MAX)
  if (nombre.length === 0) return { ok: false, error: 'El proyecto necesita un nombre.' }

  const descripcion = limpiarTexto(input.descripcion ?? '', DESCRIPCION_MAX)
  const color = normalizarColor(input.color)

  // Cap blando: contar existentes (RLS filtra por user_id).
  const { count } = await supabase
    .from('proyectos')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
  if ((count ?? 0) >= MAX_PROYECTOS_POR_USUARIO) {
    return {
      ok: false,
      error: `Llegaste al maximo de ${MAX_PROYECTOS_POR_USUARIO} proyectos. Borra alguno para crear otro.`,
    }
  }

  const { data: inserted, error } = await supabase
    .from('proyectos')
    .insert({ user_id: user.id, nombre, descripcion, color })
    .select('id')
    .single()

  if (error || !inserted) {
    return { ok: false, error: `No se pudo crear: ${error?.message ?? 'sin data'}` }
  }

  revalidatePath('/dashboard/proyectos')
  return { ok: true, id: inserted.id as string }
}

/** Lista los proyectos del usuario con conteo de sesiones (embebido, sin N+1). */
export async function listarProyectos(): Promise<ProyectoListItem[]> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from('proyectos')
    .select('id, nombre, descripcion, color, created_at, updated_at, transcripciones(count)')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })

  if (error || !data) return []

  return data.map((row) => {
    const rel = row.transcripciones as unknown
    const sesionesCount =
      Array.isArray(rel) && rel.length > 0 && typeof (rel[0] as { count?: number }).count === 'number'
        ? (rel[0] as { count: number }).count
        : 0
    return {
      id: row.id as string,
      nombre: (row.nombre as string) ?? 'Proyecto',
      descripcion: (row.descripcion as string) ?? '',
      color: normalizarColor(row.color),
      sesionesCount,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  })
}

/**
 * Detalle de un proyecto: datos + sus sesiones + directorio de participantes
 * (union de speaker_names de todas las sesiones, deduplicado, ordenado).
 */
export async function obtenerProyectoDetalle(id: string): Promise<ProyectoDetalle | null> {
  if (!id || id.length < 10) return null

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: proyecto, error } = await supabase
    .from('proyectos')
    .select(
      'id, nombre, descripcion, color, created_at, updated_at, memoria_resumen, memoria_generada_at, memoria_sesiones_count, pendientes_generados_at, pendientes_sesiones_count',
    )
    .eq('id', id)
    .eq('user_id', user.id)
    .single()
  if (error || !proyecto) return null

  const { data: sesiones } = await supabase
    .from('transcripciones')
    .select(
      'id, titulo, template_id, estado, categoria, duracion_ms, created_at, completed_at, speaker_names',
    )
    .eq('proyecto_id', id)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  // Directorio de participantes = union de los nombres reales de hablantes de
  // todas las sesiones del proyecto. Dedup case-insensitive, orden alfabetico.
  const vistos = new Map<string, string>()
  for (const s of sesiones ?? []) {
    const sn = (s as { speaker_names?: unknown }).speaker_names
    if (sn && typeof sn === 'object' && !Array.isArray(sn)) {
      for (const valor of Object.values(sn as Record<string, unknown>)) {
        if (typeof valor === 'string') {
          const nombre = valor.trim()
          if (nombre.length > 0) {
            const k = nombre.toLowerCase()
            if (!vistos.has(k)) vistos.set(k, nombre)
          }
        }
      }
    }
  }
  const participantes = Array.from(vistos.values()).sort((a, b) => a.localeCompare(b, 'es'))

  const sesionesLimpias: ProyectoSesionItem[] = (sesiones ?? []).map((s) => ({
    id: s.id as string,
    titulo: s.titulo as string,
    template_id: s.template_id as string,
    estado: s.estado as string,
    categoria: (s.categoria as string | null) ?? null,
    duracion_ms: (s.duracion_ms as number | null) ?? null,
    created_at: s.created_at as string,
    completed_at: (s.completed_at as string | null) ?? null,
  }))

  // Memoria del histórico + staleness: la memoria es "vieja" si cambió el numero
  // de sesiones completadas o si alguna se completo/re-analizo despues de generarla.
  const completadas = sesionesLimpias.filter((s) => s.estado === 'completado')
  const sesionesCompletadasCount = completadas.length
  const memoriaResumen = (proyecto.memoria_resumen as string | null) ?? null
  const memoriaGeneradaAt = (proyecto.memoria_generada_at as string | null) ?? null
  const memoriaSesionesCount = (proyecto.memoria_sesiones_count as number | null) ?? 0

  let memoriaStale = false
  if (memoriaResumen && memoriaGeneradaAt) {
    const genTime = new Date(memoriaGeneradaAt).getTime()
    const hayCambioReciente = completadas.some(
      (s) => s.completed_at != null && new Date(s.completed_at).getTime() > genTime,
    )
    memoriaStale = sesionesCompletadasCount !== memoriaSesionesCount || hayCambioReciente
  }

  // ---- Tablero de pendientes vivo + staleness.
  const { data: pendientesRaw } = await supabase
    .from('pendientes')
    .select(
      'id, texto, owner, due_date, estado, origen, estado_origen, nota_ia, transcripcion_id, created_at',
    )
    .eq('proyecto_id', id)
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })

  // Mapa id de sesión → título, para mostrar el origen de cada pendiente.
  const tituloPorSesion = new Map<string, string>()
  for (const s of sesionesLimpias) tituloPorSesion.set(s.id, s.titulo)

  // Orden de presentación: pendiente → en_curso → hecho.
  const ordenEstado: Record<string, number> = { pendiente: 0, en_curso: 1, hecho: 2 }
  const pendientes: PendienteDTO[] = (pendientesRaw ?? [])
    .map((p) => ({
      id: p.id as string,
      texto: p.texto as string,
      owner: (p.owner as string | null) ?? null,
      dueDate: (p.due_date as string | null) ?? null,
      estado: (p.estado as EstadoPendiente) ?? 'pendiente',
      origen: ((p.origen as string) === 'usuario' ? 'usuario' : 'ia') as 'ia' | 'usuario',
      estadoOrigen: ((p.estado_origen as string) === 'usuario' ? 'usuario' : 'ia') as 'ia' | 'usuario',
      notaIa: (p.nota_ia as string | null) ?? null,
      transcripcionId: (p.transcripcion_id as string | null) ?? null,
      tituloSesion: p.transcripcion_id
        ? (tituloPorSesion.get(p.transcripcion_id as string) ?? null)
        : null,
      createdAt: p.created_at as string,
    }))
    .sort((a, b) => (ordenEstado[a.estado] ?? 0) - (ordenEstado[b.estado] ?? 0))

  const pendientesGeneradosAt = (proyecto.pendientes_generados_at as string | null) ?? null
  const pendientesSesionesCount = (proyecto.pendientes_sesiones_count as number | null) ?? 0
  let pendientesStale = false
  if (pendientesGeneradosAt) {
    const genTime = new Date(pendientesGeneradosAt).getTime()
    const hayCambioReciente = completadas.some(
      (s) => s.completed_at != null && new Date(s.completed_at).getTime() > genTime,
    )
    pendientesStale =
      sesionesCompletadasCount !== pendientesSesionesCount || hayCambioReciente
  }

  return {
    id: proyecto.id as string,
    nombre: proyecto.nombre as string,
    descripcion: (proyecto.descripcion as string) ?? '',
    color: normalizarColor(proyecto.color),
    createdAt: proyecto.created_at as string,
    updatedAt: proyecto.updated_at as string,
    sesiones: sesionesLimpias,
    participantes,
    memoriaResumen,
    memoriaGeneradaAt,
    memoriaStale,
    sesionesCompletadasCount,
    pendientes,
    pendientesGeneradosAt,
    pendientesStale,
  }
}

export interface ActualizarProyectoInput {
  nombre?: string
  descripcion?: string
  color?: string
}

/** Actualiza nombre / descripcion / color de un proyecto. */
export async function actualizarProyecto(
  id: string,
  input: ActualizarProyectoInput,
): Promise<ProyectoResult> {
  if (!id || id.length < 10) return { ok: false, error: 'Id invalido.' }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof input.nombre === 'string') {
    const nombre = limpiarTexto(input.nombre, NOMBRE_MAX)
    if (nombre.length === 0) return { ok: false, error: 'El proyecto necesita un nombre.' }
    patch.nombre = nombre
  }
  if (typeof input.descripcion === 'string') {
    patch.descripcion = limpiarTexto(input.descripcion, DESCRIPCION_MAX)
  }
  if (typeof input.color === 'string') {
    patch.color = normalizarColor(input.color)
  }

  const { error } = await supabase
    .from('proyectos')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return { ok: false, error: `No se pudo actualizar: ${error.message}` }

  revalidatePath('/dashboard/proyectos')
  revalidatePath(`/dashboard/proyectos/${id}`)
  return { ok: true, id }
}

/**
 * Borra un proyecto. Sus sesiones NO se borran: el FK on-delete-set-null las
 * deja sueltas (proyecto_id = NULL). Defensa en profundidad: filtramos por user_id.
 */
export async function borrarProyecto(id: string): Promise<ProyectoResult> {
  if (!id || id.length < 10) return { ok: false, error: 'Id invalido.' }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const { error } = await supabase
    .from('proyectos')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return { ok: false, error: `No se pudo borrar: ${error.message}` }

  revalidatePath('/dashboard/proyectos')
  revalidatePath('/dashboard')
  return { ok: true }
}

// -----------------------------------------------------------------------------
// Asignar / mover sesion a un proyecto
// -----------------------------------------------------------------------------

/**
 * Asigna (o mueve) una sesion a un proyecto. proyectoId = null la deja suelta.
 * Valida ownership de AMBOS recursos (la sesion y, si aplica, el proyecto destino)
 * filtrando por user_id — un usuario no puede mover su sesion a un proyecto ajeno.
 */
export async function asignarSesionAProyecto(
  transcripcionId: string,
  proyectoId: string | null,
): Promise<ProyectoResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    return { ok: false, error: 'Sesion invalida.' }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  // Si hay destino, verificar que el proyecto sea del usuario.
  if (proyectoId) {
    const { data: proyecto, error: pErr } = await supabase
      .from('proyectos')
      .select('id')
      .eq('id', proyectoId)
      .eq('user_id', user.id)
      .single()
    if (pErr || !proyecto) return { ok: false, error: 'Proyecto no encontrado o sin permisos.' }
  }

  const { error } = await supabase
    .from('transcripciones')
    .update({ proyecto_id: proyectoId })
    .eq('id', transcripcionId)
    .eq('user_id', user.id)

  if (error) return { ok: false, error: `No se pudo asignar: ${error.message}` }

  // Tocar updated_at del/los proyecto(s) afectado(s) para que suban en la lista.
  if (proyectoId) {
    await supabase
      .from('proyectos')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', proyectoId)
      .eq('user_id', user.id)
  }

  revalidatePath('/dashboard/proyectos')
  if (proyectoId) revalidatePath(`/dashboard/proyectos/${proyectoId}`)
  revalidatePath('/dashboard')
  revalidatePath(`/dashboard/transcripcion/${transcripcionId}`)
  return { ok: true }
}

// -----------------------------------------------------------------------------
// Ask cross-sesion a nivel proyecto
// -----------------------------------------------------------------------------
// Pregunta sobre el HISTORICO de TODAS las sesiones de un proyecto a la vez
// ("¿que le promet a Mario en 3 meses?"). Reusa el RAG pgvector pero con el RPC
// cross-sesion; cada cita recuerda de que sesion proviene. Los nombres de
// hablantes se resuelven POR sesion (Speaker 1 puede ser distinto entre sesiones).

export interface AskProyectoCitationDTO {
  text: string
  start_ms: number
  end_ms: number
  speaker_id: number | null
  /** Nombre real del hablante si la sesion de origen lo tiene; si no, null. */
  speaker_label: string | null
  /** Sesion de origen de la cita. */
  transcripcion_id: string
  titulo_sesion: string
}

export interface AskProyectoResult {
  ok: boolean
  errorMessage?: string
  askId?: string
  answer?: string
  citations?: AskProyectoCitationDTO[]
  modelUsed?: string
  costUsd?: number
}

export interface AskProyectoQueryListItem {
  id: string
  question: string
  answer: string
  citations: AskProyectoCitationDTO[]
  model_used: string | null
  cost_usd: number | null
  created_at: string
}

/**
 * Responde una pregunta sobre TODAS las sesiones del proyecto via RAG cross-sesion.
 * Persiste el Q&A en `ask_queries` con `proyecto_id` (transcripcion_id NULL).
 */
export async function askProyecto(
  proyectoId: string,
  question: string,
): Promise<AskProyectoResult> {
  if (!proyectoId || proyectoId.length < 10) {
    return { ok: false, errorMessage: 'Proyecto invalido.' }
  }
  const cleanQuestion = (question ?? '').trim()
  if (cleanQuestion.length === 0) {
    return { ok: false, errorMessage: 'La pregunta esta vacia.' }
  }
  if (cleanQuestion.length > 2000) {
    return { ok: false, errorMessage: 'La pregunta es demasiado larga (max 2000 caracteres).' }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, errorMessage: 'No autenticado.' }

  // Ownership del proyecto.
  const { data: proyecto, error: pErr } = await supabase
    .from('proyectos')
    .select('id')
    .eq('id', proyectoId)
    .eq('user_id', user.id)
    .single()
  if (pErr || !proyecto) {
    return { ok: false, errorMessage: 'Proyecto no encontrado o sin permisos.' }
  }

  // Mapa { transcripcion_id: speaker_names } para resolver nombres POR sesion.
  const { data: sesiones } = await supabase
    .from('transcripciones')
    .select('id, speaker_names')
    .eq('proyecto_id', proyectoId)
    .eq('user_id', user.id)

  if (!sesiones || sesiones.length === 0) {
    return { ok: false, errorMessage: 'Este proyecto todavia no tiene sesiones.' }
  }

  const namesByTx: Record<string, Record<string, string>> = {}
  for (const s of sesiones) {
    const sn = (s as { id: string; speaker_names?: unknown }).speaker_names
    if (sn && typeof sn === 'object' && !Array.isArray(sn)) {
      namesByTx[s.id as string] = sn as Record<string, string>
    }
  }

  try {
    const ragIndex = getRagIndex(supabase)
    const result = await ragIndex.askProyecto(proyectoId, cleanQuestion, namesByTx)

    const citationsDTO: AskProyectoCitationDTO[] = result.citations.map((c) => ({
      text: c.text,
      start_ms: c.start_ms,
      end_ms: c.end_ms,
      speaker_id: c.speaker?.id ?? null,
      speaker_label: c.speaker?.label ?? null,
      transcripcion_id: c.transcripcion_id,
      titulo_sesion: c.titulo_sesion,
    }))

    const { data: inserted, error: insertError } = await supabase
      .from('ask_queries')
      .insert({
        proyecto_id: proyectoId,
        transcripcion_id: null,
        user_id: user.id,
        question: cleanQuestion,
        answer: result.answer,
        citations: citationsDTO,
        model_used: result.model_used,
        cost_usd: result.cost_usd,
      })
      .select('id')
      .single()

    if (insertError || !inserted) {
      throw new Error(
        `askProyecto: insert ask_queries fallo: ${insertError?.message ?? 'sin data'}`,
      )
    }

    revalidatePath(`/dashboard/proyectos/${proyectoId}`)

    return {
      ok: true,
      askId: inserted.id as string,
      answer: result.answer,
      citations: citationsDTO,
      modelUsed: result.model_used,
      costUsd: result.cost_usd,
    }
  } catch (err) {
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : 'Error al responder la pregunta.',
    }
  }
}

/** Historial de Asks de un proyecto (orden cronologico ascendente para el chat). */
export async function listarAskProyecto(
  proyectoId: string,
): Promise<AskProyectoQueryListItem[]> {
  if (!proyectoId || proyectoId.length < 10) return []

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from('ask_queries')
    .select('id, question, answer, citations, model_used, cost_usd, created_at')
    .eq('proyecto_id', proyectoId)
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })

  if (error || !data) return []

  return data.map((row) => ({
    id: row.id as string,
    question: (row.question as string) ?? '',
    answer: (row.answer as string) ?? '',
    citations: Array.isArray(row.citations) ? (row.citations as AskProyectoCitationDTO[]) : [],
    model_used: (row.model_used as string | null) ?? null,
    cost_usd: (row.cost_usd as number | null) ?? null,
    created_at: row.created_at as string,
  }))
}

// -----------------------------------------------------------------------------
// Memoria del historico — resumen jerarquico del proyecto
// -----------------------------------------------------------------------------
// Sintetiza los resumenes de TODAS las sesiones analizadas del proyecto en un
// meta-resumen (resumen de resumenes). Resuelve el limite de tokens: no manda
// las transcripciones completas, solo sus resumenes ya destilados. Este texto
// alimenta tambien el re-analisis con contexto global (Fase C).

export interface MemoriaProyectoResult {
  ok: boolean
  errorMessage?: string
  resumen?: string
  generadaAt?: string
  costUsd?: number
}

/** Reemplaza marcadores {{sN}} por el nombre real del hablante de ESA sesion. */
function resolverTokensSpeaker(texto: string, names: Record<string, string> | null): string {
  if (typeof texto !== 'string' || texto.length === 0) return texto
  return texto.replace(/\{\{s(\d+)\}\}/g, (_m, n: string) => {
    const nombre = names?.[n]
    return typeof nombre === 'string' && nombre.trim().length > 0 ? nombre.trim() : `Hablante ${n}`
  })
}

const MEMORIA_SYSTEM_PROMPT = [
  'Eres un asistente que sintetiza la MEMORIA de un proyecto: la relacion con un cliente o contraparte a lo largo de varias reuniones en el tiempo.',
  'Recibes los resumenes de cada sesion en orden cronologico (de la mas antigua a la mas reciente).',
  'Produce un RESUMEN EJECUTIVO del proyecto completo en espanol mexicano, en prosa clara y fluida (maximo 220 palabras).',
  'Cubre: de que trata la relacion, los temas y acuerdos clave y como han evolucionado, y los compromisos o pendientes que siguen abiertos.',
  'NO inventes nada: basate SOLO en los resumenes proporcionados. NO uses encabezados, vinetas ni listas — solo prosa.',
].join(' ')

/**
 * Genera (o regenera) la memoria del histórico del proyecto. Solo considera
 * sesiones en estado 'completado' con análisis. Persiste el texto + el conteo de
 * sesiones cubiertas (para detectar staleness despues).
 */
export async function generarMemoriaProyecto(proyectoId: string): Promise<MemoriaProyectoResult> {
  if (!proyectoId || proyectoId.length < 10) {
    return { ok: false, errorMessage: 'Proyecto invalido.' }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, errorMessage: 'No autenticado.' }

  const { data: proyecto, error: pErr } = await supabase
    .from('proyectos')
    .select('id, nombre')
    .eq('id', proyectoId)
    .eq('user_id', user.id)
    .single()
  if (pErr || !proyecto) {
    return { ok: false, errorMessage: 'Proyecto no encontrado o sin permisos.' }
  }

  const { data: sesiones } = await supabase
    .from('transcripciones')
    .select('id, titulo, created_at, categoria, analisis, speaker_names')
    .eq('proyecto_id', proyectoId)
    .eq('user_id', user.id)
    .eq('estado', 'completado')
    .order('created_at', { ascending: true })

  const conAnalisis = (sesiones ?? []).filter(
    (s) => (s as { analisis?: unknown }).analisis != null,
  )
  if (conAnalisis.length === 0) {
    return {
      ok: false,
      errorMessage: 'El proyecto todavia no tiene sesiones analizadas para resumir.',
    }
  }

  // Construir el insumo: cada sesion con su resumen + bullets (tokens resueltos).
  const bloques = conAnalisis.map((s, i) => {
    const an = (s as { analisis?: Record<string, unknown> }).analisis ?? {}
    const names =
      (s as { speaker_names?: unknown }).speaker_names &&
      typeof (s as { speaker_names?: unknown }).speaker_names === 'object'
        ? ((s as { speaker_names?: unknown }).speaker_names as Record<string, string>)
        : null
    const resumen = resolverTokensSpeaker(String(an.resumen ?? ''), names)
    const bulletsRaw = Array.isArray(an.bullets) ? (an.bullets as unknown[]) : []
    const bullets = bulletsRaw
      .map((b) => resolverTokensSpeaker(String(b ?? ''), names))
      .filter((b) => b.length > 0)
    const fecha = new Date(s.created_at as string).toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    const categoria = (s as { categoria?: string | null }).categoria ?? 'sesion'
    return [
      `[${i + 1}] ${s.titulo as string} · ${fecha} · ${categoria}`,
      `Resumen: ${resumen}`,
      bullets.length > 0 ? `Puntos: ${bullets.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })

  const userPrompt = [
    `PROYECTO: ${proyecto.nombre as string}`,
    '',
    'SESIONES (orden cronologico):',
    '',
    bloques.join('\n\n'),
  ].join('\n')

  try {
    const chatClient = getChatClient()
    const result = await chatClient.complete({
      systemPrompt: MEMORIA_SYSTEM_PROMPT,
      userPrompt,
    })

    const resumen = result.content.trim()
    if (resumen.length === 0) {
      return { ok: false, errorMessage: 'El modelo devolvio un resumen vacio.' }
    }

    const generadaAt = new Date().toISOString()
    const { error: updErr } = await supabase
      .from('proyectos')
      .update({
        memoria_resumen: resumen,
        memoria_generada_at: generadaAt,
        memoria_sesiones_count: conAnalisis.length,
        updated_at: generadaAt,
      })
      .eq('id', proyectoId)
      .eq('user_id', user.id)

    if (updErr) {
      return { ok: false, errorMessage: `No se pudo guardar la memoria: ${updErr.message}` }
    }

    revalidatePath(`/dashboard/proyectos/${proyectoId}`)
    return { ok: true, resumen, generadaAt, costUsd: result.cost_usd }
  } catch (err) {
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : 'Error al generar la memoria.',
    }
  }
}

// =============================================================================
// Tablero de pendientes VIVO
// =============================================================================
// Agrega los action_items de TODAS las sesiones del proyecto; la IA propone un
// estado (pendiente/en_curso/hecho) considerando la linea de tiempo (un
// compromiso de una sesion vieja pudo cumplirse en una posterior); el usuario
// confirma/edita. Al REGENERAR, los items con estado_origen='usuario' conservan
// su estado (no se pisan las ediciones del usuario). Los manuales no se tocan.
// =============================================================================

const DIACRITICOS_RE = new RegExp(
  '[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']',
  'g',
)

/** Normaliza un texto para dedup: minusculas, sin acentos, espacios colapsados. */
function normalizarDedup(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(DIACRITICOS_RE, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** Valida que due_date sea una fecha 'YYYY-MM-DD' (de lo contrario null). */
function normalizarDueDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = raw.match(/^\d{4}-\d{2}-\d{2}/)
  return m ? m[0] : null
}

const TABLERO_SYSTEM_PROMPT = [
  'Eres un asistente que evalua el ESTADO de los compromisos/pendientes de un proyecto a lo largo del tiempo.',
  'Recibes la memoria del proyecto (si existe) y una lista de pendientes extraidos de las reuniones; cada uno indica la sesion y la fecha en que surgio.',
  'Para CADA pendiente propon su estado:',
  '- "pendiente": no hay evidencia de que se haya empezado.',
  '- "en_curso": hay senales de que se esta trabajando en el.',
  '- "hecho": alguna sesion POSTERIOR indica que ya se completo.',
  'Considera la linea de tiempo: un compromiso de una sesion antigua pudo cumplirse o avanzar en una sesion mas reciente.',
  'Agrega una "nota" de maximo una linea en espanol mexicano explicando por que ese estado.',
  'NO inventes: si no hay evidencia de avance, el estado es "pendiente".',
  'Responde UNICAMENTE con el JSON del schema (un objeto con "items").',
].join(' ')

const TABLERO_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['indice', 'estado', 'nota'],
        properties: {
          indice: { type: 'integer' },
          estado: { type: 'string', enum: ['pendiente', 'en_curso', 'hecho'] },
          nota: { type: 'string' },
        },
      },
    },
  },
} as const

export interface TableroPendientesResult {
  ok: boolean
  errorMessage?: string
  /** Total de pendientes en el tablero tras regenerar. */
  total?: number
  costUsd?: number
}

interface PendienteFresco {
  transcripcionId: string
  texto: string
  owner: string | null
  dueDate: string | null
  dedupKey: string
  estado: EstadoPendiente
  nota: string
}

/**
 * Genera (o regenera) el tablero de pendientes del proyecto. Junta los
 * action_items de todas las sesiones completadas, la IA propone estado por la
 * linea de tiempo, y reconcilia con lo existente preservando las ediciones del
 * usuario y los pendientes manuales.
 */
export async function generarTableroPendientes(
  proyectoId: string,
): Promise<TableroPendientesResult> {
  if (!proyectoId || proyectoId.length < 10) {
    return { ok: false, errorMessage: 'Proyecto invalido.' }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, errorMessage: 'No autenticado.' }

  const { data: proyecto, error: pErr } = await supabase
    .from('proyectos')
    .select('id, nombre, memoria_resumen')
    .eq('id', proyectoId)
    .eq('user_id', user.id)
    .single()
  if (pErr || !proyecto) {
    return { ok: false, errorMessage: 'Proyecto no encontrado o sin permisos.' }
  }

  const { data: sesiones } = await supabase
    .from('transcripciones')
    .select('id, titulo, created_at, analisis, speaker_names')
    .eq('proyecto_id', proyectoId)
    .eq('user_id', user.id)
    .eq('estado', 'completado')
    .order('created_at', { ascending: true })

  const completadas = sesiones ?? []

  // ---- Recolectar action_items de todas las sesiones (resolviendo {{sN}}).
  const frescos: PendienteFresco[] = []
  const metaPorIndice: Array<{ tituloSesion: string; fecha: string }> = []
  for (const s of completadas) {
    const an = (s as { analisis?: unknown }).analisis
    if (!an || typeof an !== 'object') continue
    const items = (an as { action_items?: unknown }).action_items
    if (!Array.isArray(items)) continue
    const names =
      (s as { speaker_names?: unknown }).speaker_names &&
      typeof (s as { speaker_names?: unknown }).speaker_names === 'object'
        ? ((s as { speaker_names?: unknown }).speaker_names as Record<string, string>)
        : null
    const fecha = new Date(s.created_at as string).toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    for (const it of items) {
      if (!it || typeof it !== 'object') continue
      const textoRaw = (it as { texto?: unknown }).texto
      if (typeof textoRaw !== 'string' || textoRaw.trim().length === 0) continue
      const texto = resolverTokensSpeaker(textoRaw.trim(), names).slice(0, 600)
      const ownerRaw = (it as { owner?: unknown }).owner
      const owner =
        typeof ownerRaw === 'string' && ownerRaw.trim().length > 0
          ? resolverTokensSpeaker(ownerRaw.trim(), names).slice(0, 80)
          : null
      frescos.push({
        transcripcionId: s.id as string,
        texto,
        owner,
        dueDate: normalizarDueDate((it as { due_date?: unknown }).due_date),
        dedupKey: normalizarDedup(texto),
        estado: 'pendiente',
        nota: '',
      })
      metaPorIndice.push({ tituloSesion: s.titulo as string, fecha })
    }
  }

  let costUsd = 0

  // ---- Pase LLM: proponer estado por la linea de tiempo (si hay items).
  if (frescos.length > 0) {
    const lista = frescos
      .map((f, i) => {
        const meta = metaPorIndice[i]
        const resp = f.owner ? ` [responsable: ${f.owner}]` : ''
        return `[${i}] (sesion: "${meta?.tituloSesion ?? '—'}", ${meta?.fecha ?? '—'})${resp} ${f.texto}`
      })
      .join('\n')

    const memoria =
      typeof proyecto.memoria_resumen === 'string' && proyecto.memoria_resumen.trim().length > 0
        ? proyecto.memoria_resumen.trim()
        : '(sin memoria del proyecto generada)'

    const userPrompt = [
      `PROYECTO: ${proyecto.nombre as string}`,
      '',
      `MEMORIA DEL PROYECTO:\n${memoria}`,
      '',
      'PENDIENTES (con su sesion y fecha de origen):',
      '',
      lista,
    ].join('\n')

    try {
      const chatClient = getChatClient()
      const result = await chatClient.complete({
        systemPrompt: TABLERO_SYSTEM_PROMPT,
        userPrompt,
        jsonSchema: { name: 'tablero_pendientes', schema: TABLERO_JSON_SCHEMA },
      })
      costUsd = result.cost_usd || 0
      const parsed = JSON.parse(result.content) as {
        items?: Array<{ indice?: number; estado?: string; nota?: string }>
      }
      for (const r of parsed.items ?? []) {
        const i = typeof r.indice === 'number' ? r.indice : -1
        if (i < 0 || i >= frescos.length) continue
        const est = r.estado
        if (est === 'pendiente' || est === 'en_curso' || est === 'hecho') {
          frescos[i]!.estado = est
        }
        if (typeof r.nota === 'string') frescos[i]!.nota = r.nota.trim().slice(0, 240)
      }
    } catch (err) {
      // Si el LLM falla, igual materializamos los pendientes en estado 'pendiente'
      // (mejor un tablero sin estados propuestos que ningun tablero).
      console.error(
        `[generarTableroPendientes] pase LLM fallo: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ---- Reconciliar con lo existente preservando ediciones del usuario.
  const { data: existentes } = await supabase
    .from('pendientes')
    .select('id, transcripcion_id, dedup_key, origen, estado_origen')
    .eq('proyecto_id', proyectoId)
    .eq('user_id', user.id)

  const claveExistente = (txId: string | null, key: string | null) => `${txId ?? ''}::${key ?? ''}`
  const existentesIa = new Map<string, { id: string; estado_origen: string }>()
  for (const e of existentes ?? []) {
    if ((e.origen as string) === 'ia') {
      existentesIa.set(
        claveExistente(e.transcripcion_id as string | null, e.dedup_key as string | null),
        { id: e.id as string, estado_origen: e.estado_origen as string },
      )
    }
  }

  const vistas = new Set<string>()
  const aInsertar: Record<string, unknown>[] = []
  for (const f of frescos) {
    const key = claveExistente(f.transcripcionId, f.dedupKey)
    vistas.add(key)
    const ex = existentesIa.get(key)
    if (ex) {
      // Existe: refresca metadata. Conserva estado SOLO si el usuario lo fijo.
      const patch: Record<string, unknown> = {
        texto: f.texto,
        owner: f.owner,
        due_date: f.dueDate,
        nota_ia: f.nota || null,
        updated_at: new Date().toISOString(),
      }
      if (ex.estado_origen !== 'usuario') patch.estado = f.estado
      await supabase.from('pendientes').update(patch).eq('id', ex.id).eq('user_id', user.id)
    } else {
      aInsertar.push({
        user_id: user.id,
        proyecto_id: proyectoId,
        transcripcion_id: f.transcripcionId,
        texto: f.texto,
        owner: f.owner,
        due_date: f.dueDate,
        estado: f.estado,
        origen: 'ia',
        estado_origen: 'ia',
        nota_ia: f.nota || null,
        dedup_key: f.dedupKey,
      })
    }
  }

  if (aInsertar.length > 0) {
    await supabase.from('pendientes').insert(aInsertar)
  }

  // Borrar items IA huerfanos QUE EL USUARIO NO CURO (su action_item desaparecio
  // del analisis tras un re-analisis). Los curados por el usuario se conservan.
  const aBorrar: string[] = []
  for (const [key, ex] of existentesIa) {
    if (!vistas.has(key) && ex.estado_origen !== 'usuario') aBorrar.push(ex.id)
  }
  if (aBorrar.length > 0) {
    await supabase.from('pendientes').delete().in('id', aBorrar).eq('user_id', user.id)
  }

  // ---- Sello de generacion para staleness.
  const generadoAt = new Date().toISOString()
  await supabase
    .from('proyectos')
    .update({
      pendientes_generados_at: generadoAt,
      pendientes_sesiones_count: completadas.length,
      updated_at: generadoAt,
    })
    .eq('id', proyectoId)
    .eq('user_id', user.id)

  revalidatePath(`/dashboard/proyectos/${proyectoId}`)

  // Total tras reconciliar.
  const { count } = await supabase
    .from('pendientes')
    .select('id', { count: 'exact', head: true })
    .eq('proyecto_id', proyectoId)
    .eq('user_id', user.id)

  return { ok: true, total: count ?? undefined, costUsd }
}

/** Cambia el estado de un pendiente (lo marca como editado por el usuario). */
export async function actualizarEstadoPendiente(
  pendienteId: string,
  estado: EstadoPendiente,
): Promise<ProyectoResult> {
  if (!pendienteId || pendienteId.length < 10) return { ok: false, error: 'Pendiente invalido.' }
  if (estado !== 'pendiente' && estado !== 'en_curso' && estado !== 'hecho') {
    return { ok: false, error: 'Estado invalido.' }
  }
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const { data, error } = await supabase
    .from('pendientes')
    .update({ estado, estado_origen: 'usuario', updated_at: new Date().toISOString() })
    .eq('id', pendienteId)
    .eq('user_id', user.id)
    .select('proyecto_id')
    .single()
  if (error || !data) return { ok: false, error: 'No se pudo actualizar el pendiente.' }

  revalidatePath(`/dashboard/proyectos/${data.proyecto_id as string}`)
  return { ok: true }
}

export interface AgregarPendienteInput {
  proyectoId: string
  texto: string
  owner?: string
  dueDate?: string
}

/** Agrega un pendiente manual (origen='usuario'). */
export async function agregarPendienteManual(
  input: AgregarPendienteInput,
): Promise<ProyectoResult> {
  const texto = limpiarTexto(input.texto, 600)
  if (!input.proyectoId || input.proyectoId.length < 10) {
    return { ok: false, error: 'Proyecto invalido.' }
  }
  if (texto.length === 0) return { ok: false, error: 'El pendiente no puede estar vacio.' }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  // Verificar ownership del proyecto (RLS ademas filtra).
  const { data: proyecto } = await supabase
    .from('proyectos')
    .select('id')
    .eq('id', input.proyectoId)
    .eq('user_id', user.id)
    .single()
  if (!proyecto) return { ok: false, error: 'Proyecto no encontrado o sin permisos.' }

  const owner =
    typeof input.owner === 'string' && input.owner.trim().length > 0
      ? limpiarTexto(input.owner, 80)
      : null

  const { data, error } = await supabase
    .from('pendientes')
    .insert({
      user_id: user.id,
      proyecto_id: input.proyectoId,
      transcripcion_id: null,
      texto,
      owner,
      due_date: normalizarDueDate(input.dueDate),
      estado: 'pendiente',
      origen: 'usuario',
      estado_origen: 'usuario',
      dedup_key: normalizarDedup(texto),
    })
    .select('id')
    .single()
  if (error || !data) return { ok: false, error: 'No se pudo agregar el pendiente.' }

  revalidatePath(`/dashboard/proyectos/${input.proyectoId}`)
  return { ok: true, id: data.id as string }
}

/** Borra un pendiente (manual o IA). */
export async function borrarPendiente(pendienteId: string): Promise<ProyectoResult> {
  if (!pendienteId || pendienteId.length < 10) return { ok: false, error: 'Pendiente invalido.' }
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const { data, error } = await supabase
    .from('pendientes')
    .delete()
    .eq('id', pendienteId)
    .eq('user_id', user.id)
    .select('proyecto_id')
    .single()
  if (error || !data) return { ok: false, error: 'No se pudo borrar el pendiente.' }

  revalidatePath(`/dashboard/proyectos/${data.proyecto_id as string}`)
  return { ok: true }
}
