'use server'

// =============================================================================
// Server actions — Plantillas customizables con asesor de IA (PRP-TT-V2 Fase 3)
// =============================================================================
// Tres bloques:
//   1. ASESOR conversacional: conversarAsesor() devuelve texto libre que guía al
//      usuario; generarPlantillaPreview() produce una PlantillaSpec en JSON strict.
//   2. CRUD de plantillas_usuario: guardar / listar / obtener / actualizar / borrar.
//      Auth + ownership (RLS por user_id) + recompilación SERVER-SIDE (no se
//      confía en lo que mande el cliente: se re-normaliza y re-compila la spec,
//      garantizando un output_schema strict-válido siempre).
//
// Seguridad: getChatClient usa OPENROUTER_API_KEY (server-only, nunca al cliente).
// RLS de plantillas_usuario filtra por auth.uid()=user_id; además filtramos por
// user_id explícito en escrituras como defensa en profundidad.
// =============================================================================

import { revalidatePath } from 'next/cache'
import { createClient as createUserSupabaseClient } from '@/lib/supabase/server'
import { getChatClient } from '@/lib/transcription'
import {
  compileCustomTemplate,
  normalizePlantillaSpec,
  CUSTOM_TEMPLATE_PREFIX,
  PLANTILLA_SPEC_SCHEMA,
  MAX_CAMPOS,
  type PlantillaSpec,
} from '@bluntag/transcription-core'

// Límite blando de plantillas por usuario (anti-abuso; Fase 8 formaliza cuotas).
const MAX_PLANTILLAS_POR_USUARIO = 100
const MAX_MENSAJES = 40
const MAX_CHARS_MENSAJE = 4000

export interface AsesorMensaje {
  role: 'user' | 'assistant'
  content: string
}

export interface PlantillaUsuarioItem {
  /** template_id que se guarda en transcripciones (custom:<uuid>). */
  templateId: string
  /** uuid crudo de la fila. */
  id: string
  nombre: string
  descripcion: string
  createdAt: string
}

// -----------------------------------------------------------------------------
// Helpers internos
// -----------------------------------------------------------------------------

/**
 * Limpia un string de control chars (NUL etc.) con charCodeAt, conservando tab
 * (9) y newline (10). NUNCA usar un regex de clase de control chars: teclear el
 * byte literal incrusta NUL y corrompe el .ts (regla dura del workspace,
 * feedback_regex_control_chars_unicode_escape).
 */
function limpiarTexto(raw: string, max: number): string {
  return Array.from(raw)
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      return c === 9 || c === 10 || (c >= 32 && c !== 127)
    })
    .join('')
    .trim()
    .slice(0, max)
}

function sanitizeMensajes(raw: unknown): AsesorMensaje[] {
  if (!Array.isArray(raw)) return []
  const out: AsesorMensaje[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const obj = m as Record<string, unknown>
    const role = obj.role === 'assistant' ? 'assistant' : 'user'
    if (typeof obj.content !== 'string') continue
    const content = limpiarTexto(obj.content, MAX_CHARS_MENSAJE)
    if (content.length === 0) continue
    out.push({ role, content })
  }
  return out.slice(-MAX_MENSAJES)
}

function serializarDialogo(messages: AsesorMensaje[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'USUARIO' : 'ASESOR'}: ${m.content}`)
    .join('\n\n')
}

const SYSTEM_CONVERSACION = `Eres un consultor experto que ayuda a un usuario a diseñar una PLANTILLA DE ANÁLISIS para sus transcripciones de audio/reuniones en TagMeetings. Una plantilla define QUÉ información estructurada se extrae de cada audio. TODA plantilla ya incluye automáticamente: resumen, puntos clave (bullets) y tareas/compromisos (action items) — NO los propongas, ya vienen.

Tu trabajo:
1. Entiende el caso de uso real (qué tipo de audio graba el usuario y para qué lo usará después).
2. Si te falta información clave, haz MÁXIMO 1 o 2 preguntas inteligentes (no un cuestionario largo). Como buen consultor, detecta lo que el usuario NO previó pero le serviría extraer.
3. Cuando tengas suficiente contexto, PROPÓN en lenguaje claro entre 3 y 6 campos que la plantilla extraería: para cada uno, su nombre legible + qué captura. Cierra invitando al usuario a ajustar lo que quiera y, cuando esté conforme, presionar el botón "Generar plantilla".

Reglas duras:
- Español de México, directo y conciso. Prohibido el peloteo ("¡excelente!", "¡claro que sí!", "buena pregunta").
- Máximo ~130 palabras por respuesta.
- Habla SIEMPRE en lenguaje humano. NUNCA escribas JSON, esquemas, ni jerga técnica.
- Texto plano, SIN markdown (nada de **, ##, ni viñetas con *). Si enumeras campos, usa guiones simples (- ) o números.
- No inventes campos absurdos ni redundantes con resumen/puntos/tareas.`

const SYSTEM_GENERACION = `Eres un compilador que convierte una conversación de diseño en la ESPECIFICACIÓN estructurada de una plantilla de análisis para transcripciones. Devuelves SOLO el objeto JSON pedido por el schema.

Reglas:
- "nombre": nombre corto y claro de la plantilla (ej. "Sesión de terapia").
- "descripcion": una frase de para qué sirve.
- "contexto": 1-3 frases que describan el tipo de contenido y cuándo se usa (irá dentro de las instrucciones del modelo de análisis).
- "campos": entre 1 y ${MAX_CAMPOS} campos a extraer (ADEMÁS del resumen, puntos clave y tareas que ya son automáticos — NO los incluyas). Por cada campo:
  - "key": identificador en snake_case y minúsculas, sin acentos (ej. "objeciones_cliente").
  - "label": etiqueta legible para humano.
  - "tipo": uno de "texto" (un dato/frase), "texto_largo" (párrafo), "lista" (varios items), "opcion" (un valor de un conjunto cerrado).
  - "instruccion": qué debe extraer el modelo para ese campo, en español claro.
  - "opciones": SOLO si tipo="opcion", el conjunto de valores permitidos (mínimo 2). En cualquier otro tipo, arreglo vacío [].
  - "nullable": true solo para "texto"/"texto_largo" que pueden no aplicar; false en los demás.
- Refleja fielmente lo que se acordó en la conversación. No agregues campos que el usuario no quiso.`

// -----------------------------------------------------------------------------
// 1. Asesor conversacional
// -----------------------------------------------------------------------------

export interface ConversarAsesorResult {
  ok: boolean
  reply?: string
  error?: string
}

/**
 * Un turno del asesor conversacional. Recibe el historial completo y devuelve
 * la siguiente respuesta del asesor (texto libre). NO persiste nada.
 */
export async function conversarAsesor(
  messages: AsesorMensaje[],
): Promise<ConversarAsesorResult> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const limpios = sanitizeMensajes(messages)
  if (limpios.length === 0) {
    return { ok: false, error: 'No hay mensaje para responder.' }
  }

  try {
    const chat = getChatClient()
    const result = await chat.complete({
      systemPrompt: SYSTEM_CONVERSACION,
      userPrompt: `Conversación hasta ahora:\n\n${serializarDialogo(
        limpios,
      )}\n\nResponde el siguiente turno como ASESOR (sin el prefijo "ASESOR:").`,
    })
    return { ok: true, reply: result.content.trim() }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `El asesor no pudo responder: ${message}` }
  }
}

// -----------------------------------------------------------------------------
// 2. Generar preview (PlantillaSpec) desde la conversación
// -----------------------------------------------------------------------------

export interface PlantillaPreviewResult {
  ok: boolean
  spec?: PlantillaSpec
  error?: string
}

/**
 * Genera la PlantillaSpec estructurada a partir de la conversación, vía JSON
 * strict. Devuelve la spec NORMALIZADA (keys saneadas, caps aplicados) para
 * preview/edición en el cliente. NO persiste — guardar es otra acción.
 */
export async function generarPlantillaPreview(
  messages: AsesorMensaje[],
): Promise<PlantillaPreviewResult> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const limpios = sanitizeMensajes(messages)
  if (limpios.length === 0) {
    return { ok: false, error: 'Conversa primero con el asesor para generar la plantilla.' }
  }

  try {
    const chat = getChatClient()
    const result = await chat.complete({
      systemPrompt: SYSTEM_GENERACION,
      userPrompt: `Conversación de diseño:\n\n${serializarDialogo(
        limpios,
      )}\n\nGenera la especificación de la plantilla conforme al schema.`,
      jsonSchema: { name: 'plantilla_spec', schema: PLANTILLA_SPEC_SCHEMA },
    })

    let parsed: unknown
    try {
      parsed = JSON.parse(result.content)
    } catch {
      return { ok: false, error: 'No se pudo interpretar la propuesta. Intenta de nuevo.' }
    }

    const spec = normalizePlantillaSpec(parsed)
    return { ok: true, spec }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `No se pudo generar la plantilla: ${message}` }
  }
}

// -----------------------------------------------------------------------------
// 3. CRUD plantillas_usuario
// -----------------------------------------------------------------------------

export interface GuardarPlantillaResult {
  ok: boolean
  id?: string
  templateId?: string
  error?: string
}

/**
 * Persiste una nueva plantilla del usuario. Recibe la SPEC (no el schema crudo):
 * la re-normaliza y re-compila server-side, garantizando un output_schema
 * strict-válido sin confiar en el cliente.
 */
export async function guardarPlantilla(
  spec: PlantillaSpec,
): Promise<GuardarPlantillaResult> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const compiled = compileCustomTemplate(spec)
  if (!compiled.nombre || compiled.nombre.trim().length === 0) {
    return { ok: false, error: 'La plantilla necesita un nombre.' }
  }

  // Cap blando: contar existentes del usuario (RLS filtra).
  const { count } = await supabase
    .from('plantillas_usuario')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
  if ((count ?? 0) >= MAX_PLANTILLAS_POR_USUARIO) {
    return {
      ok: false,
      error: `Llegaste al máximo de ${MAX_PLANTILLAS_POR_USUARIO} plantillas. Borra alguna para crear otra.`,
    }
  }

  const { data: inserted, error } = await supabase
    .from('plantillas_usuario')
    .insert({
      user_id: user.id,
      nombre: compiled.nombre,
      descripcion: compiled.descripcion,
      prompt_system: compiled.prompt_system,
      prompt_user_template: compiled.prompt_user_template,
      output_schema: compiled.output_schema,
      campos_spec: { ...spec, campos: compiled.campos },
    })
    .select('id')
    .single()

  if (error || !inserted) {
    return { ok: false, error: `No se pudo guardar: ${error?.message ?? 'sin data'}` }
  }

  revalidatePath('/dashboard/plantillas')
  revalidatePath('/dashboard/capturar')
  revalidatePath('/dashboard/grabar')

  const id = inserted.id as string
  return { ok: true, id, templateId: `${CUSTOM_TEMPLATE_PREFIX}${id}` }
}

/**
 * Actualiza una plantilla existente del usuario (re-compila desde la spec).
 */
export async function actualizarPlantilla(
  id: string,
  spec: PlantillaSpec,
): Promise<GuardarPlantillaResult> {
  if (!id || id.length < 10) return { ok: false, error: 'Id inválido.' }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const compiled = compileCustomTemplate(spec)
  if (!compiled.nombre || compiled.nombre.trim().length === 0) {
    return { ok: false, error: 'La plantilla necesita un nombre.' }
  }

  const { error } = await supabase
    .from('plantillas_usuario')
    .update({
      nombre: compiled.nombre,
      descripcion: compiled.descripcion,
      prompt_system: compiled.prompt_system,
      prompt_user_template: compiled.prompt_user_template,
      output_schema: compiled.output_schema,
      campos_spec: { ...spec, campos: compiled.campos },
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) {
    return { ok: false, error: `No se pudo actualizar: ${error.message}` }
  }

  revalidatePath('/dashboard/plantillas')
  revalidatePath('/dashboard/capturar')
  revalidatePath('/dashboard/grabar')
  return { ok: true, id, templateId: `${CUSTOM_TEMPLATE_PREFIX}${id}` }
}

/** Lista las plantillas del usuario (para el selector y la pantalla de gestión). */
export async function listarPlantillasUsuario(): Promise<PlantillaUsuarioItem[]> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from('plantillas_usuario')
    .select('id, nombre, descripcion, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error || !data) return []
  return data.map((row) => ({
    id: row.id as string,
    templateId: `${CUSTOM_TEMPLATE_PREFIX}${row.id as string}`,
    nombre: (row.nombre as string) ?? 'Plantilla',
    descripcion: (row.descripcion as string) ?? '',
    createdAt: row.created_at as string,
  }))
}

export interface ObtenerPlantillaResult {
  ok: boolean
  spec?: PlantillaSpec
  nombre?: string
  error?: string
}

/** Devuelve la spec editable de una plantilla del usuario (para la pantalla de edición). */
export async function obtenerPlantillaSpec(id: string): Promise<ObtenerPlantillaResult> {
  if (!id || id.length < 10) return { ok: false, error: 'Id inválido.' }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const { data, error } = await supabase
    .from('plantillas_usuario')
    .select('nombre, descripcion, campos_spec')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (error || !data) return { ok: false, error: 'Plantilla no encontrada.' }

  // Reconstruir la spec desde campos_spec; normalizar por si la fila es vieja.
  const stored = (data.campos_spec ?? {}) as Record<string, unknown>
  const spec = normalizePlantillaSpec({
    nombre: (stored.nombre as string) ?? (data.nombre as string),
    descripcion: (stored.descripcion as string) ?? (data.descripcion as string) ?? '',
    contexto: (stored.contexto as string) ?? '',
    campos: Array.isArray(stored.campos) ? stored.campos : [],
  })
  return { ok: true, spec, nombre: data.nombre as string }
}

export interface BorrarPlantillaResult {
  ok: boolean
  error?: string
}

/** Borra una plantilla del usuario. */
export async function borrarPlantilla(id: string): Promise<BorrarPlantillaResult> {
  if (!id || id.length < 10) return { ok: false, error: 'Id inválido.' }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const { error } = await supabase
    .from('plantillas_usuario')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return { ok: false, error: `No se pudo borrar: ${error.message}` }

  revalidatePath('/dashboard/plantillas')
  revalidatePath('/dashboard/capturar')
  revalidatePath('/dashboard/grabar')
  return { ok: true }
}
