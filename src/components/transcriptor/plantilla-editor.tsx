'use client'

// =============================================================================
// PlantillaEditor — asesor conversacional + editor de spec (PRP-TT-V2 Fase 3)
// =============================================================================
// Dos modos:
//   - crear: chat con el asesor IA → "Generar plantilla" → spec editable → guardar.
//   - editar: carga la spec existente directo en el formulario editable → guardar.
// La spec es la unidad editable; al guardar, el server re-compila el schema strict.
// =============================================================================

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  conversarAsesor,
  generarPlantillaPreview,
  guardarPlantilla,
  actualizarPlantilla,
  type AsesorMensaje,
} from '@/actions/plantillas'
import type { CampoSpec, CampoTipo, PlantillaSpec } from '@bluntag/transcription-core'
import { SelectMenu } from '@/components/ui/select-menu'

interface Props {
  mode: 'crear' | 'editar'
  plantillaId?: string
  initialSpec?: PlantillaSpec
}

interface ChatBubble {
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
}

// Forma editable de un campo en el formulario (opciones como texto multilinea).
interface CampoForm {
  key: string
  label: string
  tipo: CampoTipo
  instruccion: string
  opcionesText: string
  nullable: boolean
}

const TIPO_LABELS: Record<CampoTipo, string> = {
  texto: 'Texto corto',
  texto_largo: 'Texto largo',
  lista: 'Lista de puntos',
  opcion: 'Opción (elige una)',
}

const SALUDO_INICIAL =
  'Soy tu asesor de plantillas. Cuéntame qué tipo de reuniones o audios quieres analizar y para qué te sirve después; con eso te propongo qué conviene extraer. Recuerda que toda plantilla ya incluye resumen, puntos clave y tareas.'

function campoSpecToForm(c: CampoSpec): CampoForm {
  return {
    key: c.key,
    label: c.label,
    tipo: c.tipo,
    instruccion: c.instruccion,
    opcionesText: (c.opciones ?? []).join('\n'),
    nullable: c.nullable,
  }
}

function formToCampoSpec(f: CampoForm): CampoSpec {
  const opciones =
    f.tipo === 'opcion'
      ? f.opcionesText
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : []
  return {
    key: f.key,
    label: f.label,
    tipo: f.tipo,
    instruccion: f.instruccion,
    opciones,
    nullable: f.tipo === 'texto' || f.tipo === 'texto_largo' ? f.nullable : false,
  }
}

export function PlantillaEditor({ mode, plantillaId, initialSpec }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  // ---- Chat (solo modo crear) ----------------------------------------------
  const [messages, setMessages] = useState<ChatBubble[]>(
    mode === 'crear' ? [{ role: 'assistant', content: SALUDO_INICIAL }] : [],
  )
  const [input, setInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [generando, setGenerando] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // ---- Spec editable --------------------------------------------------------
  const [nombre, setNombre] = useState(initialSpec?.nombre ?? '')
  const [descripcion, setDescripcion] = useState(initialSpec?.descripcion ?? '')
  const [contexto, setContexto] = useState(initialSpec?.contexto ?? '')
  const [campos, setCampos] = useState<CampoForm[]>(
    (initialSpec?.campos ?? []).map(campoSpecToForm),
  )
  const [specLista, setSpecLista] = useState(mode === 'editar')

  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length])

  const hayMensajeUsuario = messages.some((m) => m.role === 'user')

  // ---- Enviar turno al asesor ----------------------------------------------
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    const clean = input.trim()
    if (clean.length === 0 || chatBusy) return
    setError('')
    setChatBusy(true)

    const nextMessages: ChatBubble[] = [...messages, { role: 'user', content: clean }]
    setMessages([...nextMessages, { role: 'assistant', content: '', pending: true }])
    setInput('')

    const payload: AsesorMensaje[] = nextMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }))

    try {
      const res = await conversarAsesor(payload)
      setMessages((prev) => {
        const copy = prev.filter((m) => !m.pending)
        if (res.ok && res.reply) {
          return [...copy, { role: 'assistant', content: res.reply }]
        }
        return [
          ...copy,
          {
            role: 'assistant',
            content: res.error ?? 'No pude responder. Intenta de nuevo.',
          },
        ]
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMessages((prev) => [
        ...prev.filter((m) => !m.pending),
        { role: 'assistant', content: `Error: ${msg}` },
      ])
    } finally {
      setChatBusy(false)
    }
  }

  // ---- Generar la spec desde la conversación -------------------------------
  const handleGenerar = async () => {
    if (generando || chatBusy) return
    setError('')
    setGenerando(true)
    const payload: AsesorMensaje[] = messages
      .filter((m) => !m.pending)
      .map((m) => ({ role: m.role, content: m.content }))
    try {
      const res = await generarPlantillaPreview(payload)
      if (!res.ok || !res.spec) {
        setError(res.error ?? 'No se pudo generar la plantilla.')
        return
      }
      setNombre(res.spec.nombre)
      setDescripcion(res.spec.descripcion)
      setContexto(res.spec.contexto)
      setCampos(res.spec.campos.map(campoSpecToForm))
      setSpecLista(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerando(false)
    }
  }

  // ---- Editar campos --------------------------------------------------------
  const updateCampo = (i: number, patch: Partial<CampoForm>) => {
    setCampos((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }
  const removeCampo = (i: number) => {
    setCampos((prev) => prev.filter((_, idx) => idx !== i))
  }
  const addCampo = () => {
    setCampos((prev) => [
      ...prev,
      { key: '', label: '', tipo: 'lista', instruccion: '', opcionesText: '', nullable: false },
    ])
  }

  // ---- Guardar --------------------------------------------------------------
  const handleGuardar = async () => {
    if (guardando) return
    setError('')
    if (nombre.trim().length === 0) {
      setError('Ponle un nombre a la plantilla.')
      return
    }
    const spec: PlantillaSpec = {
      nombre: nombre.trim(),
      descripcion: descripcion.trim(),
      contexto: contexto.trim(),
      campos: campos
        .filter((c) => c.label.trim().length > 0 || c.key.trim().length > 0)
        .map(formToCampoSpec),
    }
    setGuardando(true)
    try {
      const res =
        mode === 'editar' && plantillaId
          ? await actualizarPlantilla(plantillaId, spec)
          : await guardarPlantilla(spec)
      if (!res.ok) {
        setError(res.error ?? 'No se pudo guardar.')
        return
      }
      startTransition(() => {
        router.push('/dashboard/plantillas')
        router.refresh()
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGuardando(false)
    }
  }

  const fieldClass =
    'block w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100'

  return (
    <div className="space-y-5">
      {/* ---- CHAT ASESOR (solo crear) ---- */}
      {mode === 'crear' && (
        <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
          <h2 className="mb-3 text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
            Asesor de plantillas
          </h2>
          <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap shadow-sm ${
                    m.role === 'user'
                      ? 'rounded-br-sm bg-brand text-white'
                      : 'rounded-bl-sm border border-stone-200 bg-stone-50 text-stone-900 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100'
                  }`}
                >
                  {m.pending ? (
                    <span className="flex items-center gap-2 text-stone-500 dark:text-stone-400">
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
                      Pensando…
                    </span>
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <form onSubmit={handleSend} className="mt-3 flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe tu caso de uso…"
              disabled={chatBusy}
              maxLength={4000}
              className="flex-1 rounded-xl border border-transparent bg-stone-50 px-3 py-2 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand-ring/40 disabled:opacity-50 dark:bg-stone-800 dark:text-stone-100 dark:focus:bg-stone-900"
            />
            <button
              type="submit"
              disabled={chatBusy || input.trim().length === 0}
              className="tap-scale rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-strong disabled:opacity-50"
            >
              {chatBusy ? '…' : 'Enviar'}
            </button>
          </form>

          <button
            type="button"
            onClick={handleGenerar}
            disabled={!hayMensajeUsuario || generando || chatBusy}
            className="tap-scale mt-3 w-full rounded-xl border border-brand/40 bg-brand-soft px-4 py-2.5 text-sm font-semibold text-brand transition hover:bg-brand-soft/70 disabled:opacity-50 dark:bg-brand-softdark"
          >
            {generando ? 'Generando propuesta…' : specLista ? 'Regenerar propuesta' : 'Generar plantilla'}
          </button>
        </section>
      )}

      {/* ---- EDITOR DE SPEC ---- */}
      {specLista && (
        <section className="space-y-4 rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
          <h2 className="text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
            {mode === 'editar' ? 'Editar plantilla' : 'Revisa y ajusta tu plantilla'}
          </h2>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-stone-700 dark:text-stone-200">
              Nombre
            </label>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              maxLength={80}
              placeholder="Ej. Sesión de terapia"
              className={fieldClass}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-stone-700 dark:text-stone-200">
              Descripción <span className="font-normal text-stone-400">(para qué sirve)</span>
            </label>
            <input
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              maxLength={240}
              placeholder="Una frase corta"
              className={fieldClass}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-stone-700 dark:text-stone-200">
              Contexto <span className="font-normal text-stone-400">(qué tipo de audio y cuándo se usa)</span>
            </label>
            <textarea
              value={contexto}
              onChange={(e) => setContexto(e.target.value)}
              rows={3}
              maxLength={1500}
              placeholder="Describe el tipo de contenido que analizará esta plantilla."
              className={`${fieldClass} resize-y`}
            />
          </div>

          {/* Campos */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-stone-700 dark:text-stone-200">
                Qué extraer ({campos.length})
              </span>
              <button
                type="button"
                onClick={addCampo}
                className="tap-scale rounded-full border border-stone-200 px-3 py-1 text-xs font-semibold text-stone-600 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                + Agregar campo
              </button>
            </div>
            <p className="text-xs text-stone-400">
              Además de estos, toda plantilla extrae resumen, puntos clave y tareas automáticamente.
            </p>

            {campos.length === 0 && (
              <p className="rounded-xl border border-dashed border-stone-300 px-3 py-4 text-center text-xs text-stone-400 dark:border-stone-700">
                Sin campos extra. La plantilla solo extraerá resumen, puntos clave y tareas.
              </p>
            )}

            {campos.map((c, i) => (
              <div
                key={i}
                className="space-y-2.5 rounded-xl border border-stone-200 bg-stone-50/60 p-3 dark:border-stone-700 dark:bg-stone-800/40"
              >
                <div className="flex items-center gap-2">
                  <input
                    value={c.label}
                    onChange={(e) => updateCampo(i, { label: e.target.value })}
                    maxLength={60}
                    placeholder="Nombre del campo (ej. Objeciones)"
                    className={`${fieldClass} flex-1`}
                  />
                  <button
                    type="button"
                    onClick={() => removeCampo(i)}
                    aria-label="Quitar campo"
                    className="tap-scale shrink-0 rounded-lg border border-stone-200 px-2.5 py-2 text-stone-400 transition hover:border-red-300 hover:text-red-600 dark:border-stone-700 dark:hover:border-red-800"
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="size-4" aria-hidden="true">
                      <path d="M6 7h12M9 7V5h6v2m-7 0v12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <SelectMenu
                    value={c.tipo}
                    onChange={(v) => updateCampo(i, { tipo: v as CampoTipo })}
                    options={(Object.keys(TIPO_LABELS) as CampoTipo[]).map((t) => ({ value: t, label: TIPO_LABELS[t] }))}
                    size="sm"
                    ariaLabel="Tipo de campo"
                  />
                  {(c.tipo === 'texto' || c.tipo === 'texto_largo') && (
                    <label className="flex items-center gap-2 px-1 text-xs text-stone-600 dark:text-stone-300">
                      <input
                        type="checkbox"
                        checked={c.nullable}
                        onChange={(e) => updateCampo(i, { nullable: e.target.checked })}
                        className="size-4 accent-brand"
                      />
                      Puede quedar vacío
                    </label>
                  )}
                </div>

                <textarea
                  value={c.instruccion}
                  onChange={(e) => updateCampo(i, { instruccion: e.target.value })}
                  rows={2}
                  maxLength={300}
                  placeholder="Qué debe extraer la IA en este campo."
                  className={`${fieldClass} resize-y`}
                />

                {c.tipo === 'opcion' && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-stone-600 dark:text-stone-300">
                      Opciones (una por línea o separadas por coma, mínimo 2)
                    </label>
                    <textarea
                      value={c.opcionesText}
                      onChange={(e) => updateCampo(i, { opcionesText: e.target.value })}
                      rows={2}
                      placeholder={'positivo\nneutro\nnegativo'}
                      className={`${fieldClass} resize-y`}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {error}
        </div>
      )}

      {specLista && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => router.push('/dashboard/plantillas')}
            className="tap-scale flex-1 rounded-2xl border border-stone-200 bg-white py-3 text-sm font-semibold text-stone-600 shadow-sm transition hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleGuardar}
            disabled={guardando}
            className="tap-scale flex-[2] rounded-2xl bg-brand py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-strong disabled:opacity-50"
          >
            {guardando ? 'Guardando…' : mode === 'editar' ? 'Guardar cambios' : 'Guardar plantilla'}
          </button>
        </div>
      )}
    </div>
  )
}
