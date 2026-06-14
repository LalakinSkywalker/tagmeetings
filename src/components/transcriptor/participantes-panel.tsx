'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { guardarNombresSpeakers } from '@/actions/transcripciones'
import {
  type SpeakerNames,
  parseSpeakerOrigin,
  esMultifuentePorIds,
  DOC_SPEAKER_BASE,
} from '@/lib/transcription/speaker-names'
import { InfoTooltip } from '@/components/ui/info-tooltip'

interface FuenteInfo {
  orden: number
  tipo: string
  nombre_archivo: string | null
}

interface Props {
  transcripcionId: string
  /** Ids unicos de hablantes detectados en los segments (ordenados asc). */
  speakerIds: number[]
  /** Diccionario actual persistido. */
  initialNames: SpeakerNames
  /** Fuentes de un analisis multi-fuente (para headers legibles). — Hueco B. */
  fuentes?: FuenteInfo[]
}

const NAME_MAX_LEN = 60

// Etiqueta auto-generada por combinar.ts: "F1 · Hablante 0" (U+00B7 entre espacios)
// o "Documento: nombre". En multi-fuente la tratamos como "sin nombre todavia"
// para que el input arranque vacio (el usuario no tiene que borrar la etiqueta).
const ETIQUETA_AUTO_RE = /^F\d+ · Hablante \d+$/
function esEtiquetaAuto(v: string | undefined): boolean {
  if (typeof v !== 'string') return false
  const t = v.trim()
  return ETIQUETA_AUTO_RE.test(t) || t.startsWith('Documento:')
}

/** Quita entradas vacias y trimea — para comparar dirty y mostrar estado real. */
function cleanDict(dict: SpeakerNames | null | undefined): SpeakerNames {
  const out: SpeakerNames = {}
  if (!dict) return out
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v === 'string' && v.trim().length > 0) out[k] = v.trim()
  }
  return out
}

function shallowEqual(a: SpeakerNames, b: SpeakerNames): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  for (const k of ak) {
    if (a[k] !== b[k]) return false
  }
  return true
}

/**
 * Panel "Participantes" arriba del tab Transcripcion. Ponle nombre a los
 * hablantes detectados; al guardar persiste el diccionario via server action y
 * refresca para reflejar los nombres en la transcripcion, el analisis y el Ask.
 * Costo cero de IA.
 *
 * MULTI-FUENTE: cuando la sesion combina varios audios,
 * Deepgram numera los hablantes por archivo, asi que aparecen muchos ("F1·
 * Hablante 0", "F2·Hablante 0"...) cuando en realidad son pocas personas. El
 * panel los AGRUPA por fuente con encabezados legibles y deja ASIGNAR cada uno a
 * una persona ya nombrada con un toque (chips), para juntarlos sin teclear.
 */
export function ParticipantesPanel({ transcripcionId, speakerIds, initialNames, fuentes }: Props) {
  const router = useRouter()
  const [names, setNames] = useState<SpeakerNames>(() => {
    const seed: SpeakerNames = {}
    for (const id of speakerIds) {
      const v = initialNames?.[String(id)]
      if (typeof v === 'string') seed[String(id)] = v
    }
    return seed
  })
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [error, setError] = useState('')

  const currentClean = useMemo(() => cleanDict(names), [names])
  const initialClean = useMemo(() => cleanDict(initialNames), [initialNames])
  const dirty = !shallowEqual(currentClean, initialClean)

  const multifuente = useMemo(() => esMultifuentePorIds(speakerIds), [speakerIds])

  // Banco de personas: nombres reales (no auto, no vacios) ya escritos en CUALQUIER
  // hablante de audio. Sirve para los chips de asignacion rapida en multi-fuente.
  const personasBank = useMemo(() => {
    const vistos = new Map<string, string>()
    for (const id of speakerIds) {
      if (id >= DOC_SPEAKER_BASE) continue
      const v = names[String(id)]
      if (typeof v === 'string' && v.trim().length > 0 && !esEtiquetaAuto(v)) {
        const k = v.trim().toLowerCase()
        if (!vistos.has(k)) vistos.set(k, v.trim())
      }
    }
    return Array.from(vistos.values()).sort((a, b) => a.localeCompare(b, 'es'))
  }, [names, speakerIds])

  const setName = (id: number, value: string) => {
    setSavedOk(false)
    setError('')
    setNames((prev) => ({ ...prev, [String(id)]: value.slice(0, NAME_MAX_LEN) }))
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    setSavedOk(false)
    try {
      const result = await guardarNombresSpeakers(transcripcionId, names)
      if (!result.ok) {
        setError(result.errorMessage ?? 'No se pudieron guardar los nombres.')
      } else {
        setSavedOk(true)
        router.refresh()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (speakerIds.length === 0) return null

  // ---- Footer compartido: boton guardar + estado.
  const footer = (
    <div className="mt-3.5 flex items-center gap-3">
      <button
        type="button"
        onClick={handleSave}
        disabled={saving || !dirty}
        className="tap-scale rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition hover:bg-brand-strong disabled:opacity-50"
      >
        {saving ? 'Guardando…' : 'Guardar nombres'}
      </button>
      {savedOk && !dirty && (
        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Guardado ✓</span>
      )}
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </div>
  )

  // ===========================================================================
  // MODO SIMPLE (sesion de una sola fuente) — comportamiento original.
  // ===========================================================================
  if (!multifuente) {
    return (
      <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-stone-900 dark:text-stone-100">Participantes</h3>
          <InfoTooltip label="Cómo funcionan los nombres">
            Ponles nombre a los hablantes detectados. Se aplican en la transcripción,
            el análisis y el Ask — al instante, sin reanalizar.
          </InfoTooltip>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {speakerIds.map((id) => (
            <div key={id} className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-xs font-bold text-brand">Speaker {id}</span>
              <input
                type="text"
                value={names[String(id)] ?? ''}
                onChange={(e) => setName(id, e.target.value)}
                placeholder={`Speaker ${id}`}
                maxLength={NAME_MAX_LEN}
                disabled={saving}
                className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-brand focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
              />
            </div>
          ))}
        </div>

        {footer}
      </section>
    )
  }

  // ===========================================================================
  // MODO MULTI-FUENTE — agrupado por fuente + asignacion rapida con chips.
  // ===========================================================================
  // Agrupar SOLO hablantes de audio por su fuente (los "Documento: X" se
  // conservan en el state pero no se editan aqui).
  const fuentePorOrden = new Map<number, FuenteInfo>()
  for (const f of fuentes ?? []) fuentePorOrden.set(f.orden, f)

  const grupos = new Map<number, number[]>()
  for (const id of speakerIds) {
    if (id >= DOC_SPEAKER_BASE) continue
    const { sourceIndex } = parseSpeakerOrigin(id)
    const arr = grupos.get(sourceIndex) ?? []
    arr.push(id)
    grupos.set(sourceIndex, arr)
  }
  const sourceIndexes = Array.from(grupos.keys()).sort((a, b) => a - b)

  return (
    <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-stone-900 dark:text-stone-100">Participantes</h3>
        <InfoTooltip label="Juntar hablantes de varias fuentes">
          Esta sesión combina varios audios. Cada audio numera sus hablantes por
          separado, por eso ves varios. Ponle a cada uno el nombre de la persona real
          (o tócala en los botones de abajo): los que tengan el mismo nombre se cuentan
          como una sola persona en el proyecto.
        </InfoTooltip>
      </div>

      <div className="space-y-4">
        {sourceIndexes.map((si) => {
          const f = fuentePorOrden.get(si)
          const headerFuente = f?.nombre_archivo?.trim()
            ? `Fuente ${si + 1} · ${f.nombre_archivo.trim()}`
            : `Fuente ${si + 1}`
          const ids = (grupos.get(si) ?? []).sort(
            (a, b) => parseSpeakerOrigin(a).origId - parseSpeakerOrigin(b).origId,
          )
          return (
            <div key={si}>
              <button
                type="button"
                onClick={() =>
                  document
                    .getElementById(`fuente-${si}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
                title="Ir al inicio de esta fuente en la transcripción"
                className="tap-scale mb-2 flex w-full items-center gap-1.5 text-left text-[11px] font-bold tracking-wider text-stone-400 uppercase transition hover:text-brand dark:text-stone-500 dark:hover:text-brand"
              >
                <span className="truncate">{headerFuente}</span>
                <svg viewBox="0 0 24 24" fill="none" className="size-3.5 shrink-0" aria-hidden="true">
                  <path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className="space-y-2.5">
                {ids.map((id) => {
                  const { origId } = parseSpeakerOrigin(id)
                  const raw = names[String(id)]
                  const display = esEtiquetaAuto(raw) ? '' : (raw ?? '')
                  const chips = personasBank.filter(
                    (p) => p.toLowerCase() !== display.trim().toLowerCase(),
                  )
                  return (
                    <div key={id}>
                      <div className="flex items-center gap-2">
                        <span className="w-24 shrink-0 text-xs font-bold text-brand">
                          Hablante {origId}
                        </span>
                        <input
                          type="text"
                          value={display}
                          onChange={(e) => setName(id, e.target.value)}
                          placeholder="Nombre real"
                          maxLength={NAME_MAX_LEN}
                          disabled={saving}
                          className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-brand focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
                        />
                      </div>
                      {chips.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5 pl-26">
                          {chips.map((p) => (
                            <button
                              key={p}
                              type="button"
                              onClick={() => setName(id, p)}
                              disabled={saving}
                              className="tap-scale inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand-soft/70 disabled:opacity-50 dark:bg-brand-softdark"
                            >
                              <span aria-hidden="true">+</span>
                              {p}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {footer}
    </section>
  )
}
