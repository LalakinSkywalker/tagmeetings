'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  analizarTranscripcion,
  type AskQueryListItem,
} from '@/actions/transcripciones'
import { editarTextoTranscripcion } from '@/actions/editar-texto'
import {
  resolveSpeakerName,
  resolverTokensSpeakerDeep,
  uniqueSpeakerIds,
  esMultifuentePorIds,
  parseSpeakerOrigin,
  type SpeakerNames,
} from '@/lib/transcription/speaker-names'
import { AskPanel } from './ask-panel'
import { ParticipantesPanel } from './participantes-panel'
import { AsignarProyecto } from './asignar-proyecto'
import { ScrollToTop } from './scroll-to-top'
import { ReintentarBoton } from './reintentar-boton'
import { SelectMenu, type SelectOption } from '@/components/ui/select-menu'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import {
  type ModoAnalisis,
  MODO_ANALISIS_LABELS,
  normalizarModoAnalisis,
} from '@/lib/transcription/modo-analisis'
import type { ContextoProyectoScope } from '@/lib/transcription/contexto-proyecto'
import { nombreIdioma } from '@/lib/transcription/idioma-display'
import { formatCustomFieldKey, formatCategoria } from '@/lib/export/format'

interface Segment {
  speaker: { id: number; label?: string }
  text: string
  start_ms: number
  end_ms: number
  confidence: number
}

interface ActionItem {
  texto: string
  due_date?: string | null
  owner?: string | null
}

interface Analisis {
  template_id: string
  resumen: string
  bullets: string[]
  action_items: ActionItem[]
  categoria: string
  custom_fields: Record<string, unknown>
  model_used: string
  cost_usd: number
}

interface Transcripcion {
  id: string
  titulo: string
  template_id: string
  estado: string
  raw_text: string | null
  segments: unknown
  analisis: unknown
  categoria: string | null
  duracion_ms: number | null
  idioma: string | null
  idioma_detectado?: string | null
  traducido_a?: string | null
  raw_text_traducido?: string | null
  segments_traducido?: unknown
  participantes_esperados?: unknown
  num_speakers_esperados?: number | null
  cost_usd_total: number | null
  created_at: string
  completed_at: string | null
  error_message: string | null
  speaker_names?: SpeakerNames | null
  modo_analisis?: string | null
  texto_editado_en?: string | null
  /** Si está presente, el audio original fue liberado de R2 (Bloque Almacenamiento). */
  audio_liberado_en?: string | null
  /** Respaldo a Drive (si el audio fue respaldado antes de liberarse). */
  archivado_en?: string | null
  drive_folder_id?: string | null
}

interface FuenteItem {
  orden: number
  tipo: string
  nombre_archivo: string | null
  estado: string
  /** Si está presente, el audio de ESTA fuente fue liberado de R2. */
  audio_liberado_en?: string | null
}

interface Props {
  transcripcion: Transcripcion
  asksHistory: AskQueryListItem[]
  indexada: boolean
  /** Nombre legible de la plantilla (predefinida o custom). */
  plantillaNombre?: string
  /** Fuentes que componen un análisis multi-fuente. */
  fuentes?: FuenteItem[]
  /** Proyecto al que pertenece la sesión (null = suelta). */
  proyectoId?: string | null
  /** Proyectos del usuario para el selector de asignación. */
  proyectos?: { id: string; nombre: string }[]
  /** Plantillas disponibles para re-analizar con otra plantilla. */
  templates?: { id: string; name: string; description: string }[]
  /** Grupos de plantillas para el selector. */
  grupos?: { label: string; ids: string[] }[]
}

const FUENTE_TIPO_LABEL: Record<string, string> = {
  audio: 'Audio',
  video: 'Video',
  pdf: 'PDF',
  doc: 'Documento',
  texto: 'Texto',
}

const FUENTE_ESTADO_DOT: Record<string, string> = {
  pendiente: 'bg-stone-400',
  subido: 'bg-stone-400',
  transcribiendo: 'bg-brand animate-pulse',
  transcrito: 'bg-emerald-500',
  error: 'bg-red-500',
}

const ESTADO_DOT: Record<string, string> = {
  pendiente: 'bg-stone-400',
  transcribiendo: 'bg-brand animate-pulse',
  analizando: 'bg-brand animate-pulse',
  indexando: 'bg-brand animate-pulse',
  completado: 'bg-emerald-500',
  error: 'bg-red-500',
}

const ESTADO_LABELS: Record<string, string> = {
  pendiente: 'Pendiente',
  transcribiendo: 'Transcribiendo',
  analizando: 'Analizando',
  indexando: 'Indexando',
  completado: 'Completado',
  error: 'Error',
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatDuration(ms: number | null): string {
  if (!ms) return '—'
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatCost(cost: number | null): string {
  if (cost === null || cost === undefined) return '—'
  const n = Number(cost)
  if (!Number.isFinite(n) || n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((x) => typeof x === 'string')
}

/** Chip de metadato premium (etiqueta + valor). */
function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 text-[11px] dark:bg-stone-800">
      <span className="text-stone-400 dark:text-stone-500">{label}</span>
      <span className="font-semibold text-stone-700 dark:text-stone-200">{value}</span>
    </span>
  )
}

/** Tarjeta de seccion premium. */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <h3 className="mb-2.5 text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
        {title}
      </h3>
      {children}
    </section>
  )
}

export function TranscripcionDetalle({ transcripcion, asksHistory, indexada, plantillaNombre, fuentes, proyectoId, proyectos, templates, grupos }: Props) {
  const [tab, setTab] = useState<'analisis' | 'transcripcion' | 'ask'>('analisis')
  const [reanalyzing, setReanalyzing] = useState(false)
  const [errorAccion, setErrorAccion] = useState<string>('')
  const [templateSel, setTemplateSel] = useState<string>(transcripcion.template_id)
  const [modoSel, setModoSel] = useState<ModoAnalisis>(
    normalizarModoAnalisis(transcripcion.modo_analisis),
  )
  // Eje 2: alcance del contexto del proyecto a inyectar al re-análisis.
  const [contextoSel, setContextoSel] = useState<ContextoProyectoScope>('ninguno')
  const [, startTransition] = useTransition()
  const router = useRouter()

  // Tab Transcripcion: original vs traduccion. Si el audio
  // no estaba en espanol, guardamos ambas versiones; el usuario alterna.
  const [verOriginal, setVerOriginal] = useState(false)

  // Edición de texto. Solo sin traducción (evita desync original↔
  // traducción). `cambios` = { índiceSegmento: textoEditado }. `editIdx` = qué
  // segmento está abierto como textarea (click-to-edit, performante en transcripciones largas).
  const [editando, setEditando] = useState(false)
  const [editIdx, setEditIdx] = useState<number | null>(null)
  const [cambios, setCambios] = useState<Record<number, string>>({})
  const [guardandoEdit, setGuardandoEdit] = useState(false)
  const [errorEdit, setErrorEdit] = useState('')

  const segmentsOriginal = useMemo<Segment[]>(() => {
    return Array.isArray(transcripcion.segments)
      ? (transcripcion.segments as Segment[])
      : []
  }, [transcripcion.segments])

  const segmentsTraducidos = useMemo<Segment[]>(() => {
    return Array.isArray(transcripcion.segments_traducido)
      ? (transcripcion.segments_traducido as Segment[])
      : []
  }, [transcripcion.segments_traducido])

  // Hay traduccion disponible si tenemos segments traducidos y un idioma destino.
  const hayTraduccion =
    segmentsTraducidos.length > 0 && Boolean(transcripcion.traducido_a)

  // Por default mostramos la traduccion (espanol). El toggle deja ver el original.
  const segments = hayTraduccion && !verOriginal ? segmentsTraducidos : segmentsOriginal

  // Idioma de origen real (detectado si existe, si no el solicitado).
  const idiomaOrigen = transcripcion.idioma_detectado ?? transcripcion.idioma
  const nombreOrigen = nombreIdioma(idiomaOrigen)

  // Alerta de discrepancia: el usuario esperaba N hablantes y se detectaron M.
  const numEsperado = transcripcion.num_speakers_esperados ?? null
  const numDetectado = useMemo(() => {
    return uniqueSpeakerIds(segmentsOriginal).length
  }, [segmentsOriginal])
  const hayDiscrepancia =
    typeof numEsperado === 'number' &&
    numEsperado > 0 &&
    numDetectado > 0 &&
    numEsperado !== numDetectado

  // Roster esperado (nombres pre-registrados) para mostrar como ayuda.
  const rosterEsperado = useMemo<string[]>(() => {
    return Array.isArray(transcripcion.participantes_esperados)
      ? (transcripcion.participantes_esperados as unknown[]).filter(
          (x): x is string => typeof x === 'string' && x.trim().length > 0,
        )
      : []
  }, [transcripcion.participantes_esperados])

  // Diccionario de nombres reales de hablantes. Se resuelve en
  // runtime: NO se persiste dentro de segments ni re-indexa embeddings.
  const speakerNames = useMemo<SpeakerNames>(() => {
    const raw = transcripcion.speaker_names
    return raw && typeof raw === 'object' ? (raw as SpeakerNames) : {}
  }, [transcripcion.speaker_names])

  const speakerIds = useMemo<number[]>(() => uniqueSpeakerIds(segments), [segments])

  const multifuente = useMemo(() => esMultifuentePorIds(speakerIds), [speakerIds])

  // Índice del PRIMER segmento de cada fuente → ancla `#fuente-N` para que los
  // headers del panel de Participantes salten al inicio de esa conversación.
  const anclasFuente = useMemo(() => {
    const m = new Map<number, number>() // sourceIndex → índice del primer segmento
    if (!multifuente) return m
    segments.forEach((seg, i) => {
      const src = parseSpeakerOrigin(seg.speaker.id).sourceIndex
      if (!m.has(src)) m.set(src, i)
    })
    // Invertir: índice de segmento → sourceIndex (para anotar el <li> rápido).
    const porSegmento = new Map<number, number>()
    for (const [src, idx] of m) porSegmento.set(idx, src)
    return porSegmento
  }, [segments, multifuente])

  const analisis = useMemo<Analisis | null>(() => {
    if (transcripcion.analisis && typeof transcripcion.analisis === 'object') {
      // Sustituye {{sN}} por los nombres reales actuales:
      // renombrar un hablante refleja el cambio en el análisis al instante.
      return resolverTokensSpeakerDeep(transcripcion.analisis, speakerNames) as Analisis
    }
    return null
  }, [transcripcion.analisis, speakerNames])

  const estadoLabel = ESTADO_LABELS[transcripcion.estado] ?? transcripcion.estado
  const estadoDot = ESTADO_DOT[transcripcion.estado] ?? ESTADO_DOT.pendiente
  const estaPendiente =
    transcripcion.estado === 'transcribiendo' ||
    transcripcion.estado === 'analizando' ||
    transcripcion.estado === 'pendiente'

  const handleReanalyze = async () => {
    setReanalyzing(true)
    setErrorAccion('')
    try {
      const cambioPlantilla = templateSel !== transcripcion.template_id
      const result = await analizarTranscripcion(transcripcion.id, {
        forzar: true,
        nuevoTemplateId: cambioPlantilla ? templateSel : undefined,
        modo: modoSel,
        contextoProyecto: proyectoId ? contextoSel : undefined,
      })
      if (!result.ok) {
        setErrorAccion(result.errorMessage ?? 'Error desconocido al reanalizar.')
      } else {
        startTransition(() => router.refresh())
      }
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : String(err))
    } finally {
      setReanalyzing(false)
    }
  }

  // ---- Edición de texto ----
  const puedeEditarTexto =
    transcripcion.estado === 'completado' &&
    segmentsOriginal.length > 0 &&
    !hayTraduccion

  // El análisis quedó desactualizado si se editó el texto DESPUÉS de analizar.
  const analisisDesactualizado = useMemo(() => {
    const ed = transcripcion.texto_editado_en
    if (!ed) return false
    const comp = transcripcion.completed_at
    if (!comp) return true
    return new Date(ed).getTime() > new Date(comp).getTime()
  }, [transcripcion.texto_editado_en, transcripcion.completed_at])

  const numCambios = Object.entries(cambios).filter(
    ([k, v]) => v !== (segmentsOriginal[Number(k)]?.text ?? ''),
  ).length

  const textoSegmento = (i: number, original: string): string =>
    cambios[i] !== undefined ? cambios[i] : original

  const handleCancelarEdicion = () => {
    setEditando(false)
    setEditIdx(null)
    setCambios({})
    setErrorEdit('')
  }

  const handleGuardarEdicion = async () => {
    const ediciones = Object.entries(cambios).map(([k, v]) => ({
      index: Number(k),
      text: v,
    }))
    if (ediciones.length === 0) {
      handleCancelarEdicion()
      return
    }
    setGuardandoEdit(true)
    setErrorEdit('')
    try {
      const res = await editarTextoTranscripcion(transcripcion.id, ediciones)
      if (!res.ok) {
        setErrorEdit(res.errorMessage ?? 'No se pudo guardar.')
        return
      }
      setEditando(false)
      setEditIdx(null)
      setCambios({})
      startTransition(() => router.refresh())
    } catch (err) {
      setErrorEdit(err instanceof Error ? err.message : String(err))
    } finally {
      setGuardandoEdit(false)
    }
  }

  // Opciones del selector de plantilla para re-analizar (reusa el SelectMenu).
  const templateOptions: SelectOption[] = (templates ?? []).map((t) => ({
    value: t.id,
    label: t.name,
  }))

  // Opciones del modo de análisis (Eje 1).
  const modoOptions: SelectOption[] = [
    { value: 'rapido', label: MODO_ANALISIS_LABELS.rapido },
    { value: 'profundo', label: MODO_ANALISIS_LABELS.profundo },
  ]

  // Opciones del contexto del proyecto (Eje 2).
  const contextoOptions: SelectOption[] = [
    { value: 'ninguno', label: 'Sin contexto' },
    { value: 'memoria', label: 'Memoria del proyecto' },
    { value: 'detallado', label: 'Histórico detallado' },
  ]

  const TABS: { key: typeof tab; label: string; dot?: boolean }[] = [
    { key: 'analisis', label: 'Análisis' },
    { key: 'transcripcion', label: 'Transcripción' },
    { key: 'ask', label: 'Ask', dot: indexada },
  ]

  return (
    <div className="space-y-4">
      {/* Metadata: chips premium */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-semibold text-stone-700 dark:bg-stone-800 dark:text-stone-200">
          <span className={`size-1.5 rounded-full ${estadoDot}`} aria-hidden="true" />
          {estadoLabel}
        </span>
        <MetaChip label="Plantilla" value={plantillaNombre ?? transcripcion.template_id} />
        <MetaChip label="Duración" value={formatDuration(transcripcion.duracion_ms)} />
        {nombreOrigen && (
          <MetaChip
            label="Idioma"
            value={
              hayTraduccion
                ? `${nombreOrigen} → Español`
                : nombreOrigen
            }
          />
        )}
        <MetaChip label="Costo" value={formatCost(transcripcion.cost_usd_total)} />
        {(transcripcion.estado === 'error' || transcripcion.estado === 'analizando') && (
          <button
            type="button"
            onClick={handleReanalyze}
            disabled={reanalyzing || !transcripcion.raw_text}
            className="tap-scale ml-auto inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1 text-[11px] font-semibold text-brand transition hover:bg-brand-soft/70 disabled:opacity-50 dark:bg-brand-softdark"
          >
            {reanalyzing ? 'Procesando…' : 'Disparar análisis'}
          </button>
        )}
      </div>

      {errorAccion && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {errorAccion}
        </div>
      )}

      {transcripcion.estado === 'error' && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          <p className="font-semibold">Falló el procesamiento</p>
          {transcripcion.error_message && (
            <p className="mt-1 text-xs">{transcripcion.error_message}</p>
          )}
          <p className="mt-2 text-xs text-red-800/80 dark:text-red-200/80">
            Puedes reintentar: el sistema reanuda el paso que se cayó (no reprocesa lo que ya quedó listo).
          </p>
          <div className="mt-3">
            <ReintentarBoton transcripcionId={transcripcion.id} />
          </div>
        </div>
      )}

      {/* Asignar / mover a un proyecto */}
      {proyectos && (
        <AsignarProyecto
          transcripcionId={transcripcion.id}
          proyectoIdActual={proyectoId ?? null}
          proyectos={proyectos}
        />
      )}

      {/* Fuentes del analisis combinado */}
      {fuentes && fuentes.length > 0 && (
        <Card title={`Fuentes de este análisis (${fuentes.length})`}>
          <ul className="space-y-1.5 text-sm">
            {fuentes.map((f) => (
              <li key={f.orden} className="flex items-center gap-2.5">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${FUENTE_ESTADO_DOT[f.estado] ?? 'bg-stone-400'}`}
                  aria-hidden="true"
                />
                <span className="rounded-md bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold text-stone-500 dark:bg-stone-800 dark:text-stone-400">
                  {FUENTE_TIPO_LABEL[f.tipo] ?? f.tipo}
                </span>
                <span className="min-w-0 flex-1 truncate text-stone-900 dark:text-stone-100">
                  {f.nombre_archivo ?? `Fuente ${f.orden + 1}`}
                </span>
                {f.audio_liberado_en && (
                  <span
                    className="shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                    title="El audio de esta fuente se liberó de almacenamiento; la transcripción sigue disponible."
                  >
                    audio liberado
                  </span>
                )}
                {f.estado === 'error' && (
                  <span className="shrink-0 text-[11px] font-semibold text-red-600 dark:text-red-400">
                    error
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Segmented control nativo iOS */}
      <div className="flex gap-1 rounded-2xl bg-stone-100 p-1 dark:bg-stone-900">
        {TABS.map((t) => {
          const active = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`tap-scale flex flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-[13px] font-semibold transition ${
                active
                  ? 'bg-white text-brand shadow-sm dark:bg-stone-800'
                  : 'text-stone-500 dark:text-stone-400'
              }`}
            >
              {t.label}
              {t.dot && (
                <span
                  className="size-1.5 rounded-full bg-emerald-500"
                  title="Indexada — lista para preguntas"
                />
              )}
            </button>
          )
        })}
      </div>

      {/* Audio liberado (Bloque Almacenamiento): nota honesta — la transcripción
          sigue intacta; solo se liberó el archivo de audio pesado. */}
      {transcripcion.audio_liberado_en && (
        <div className="mb-3 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm dark:border-stone-700 dark:bg-stone-800/60">
          <p className="font-semibold text-stone-700 dark:text-stone-200">
            El audio original fue liberado
          </p>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            Para ahorrar espacio se liberó el archivo de audio. Tu transcripción y tu
            análisis siguen completos aquí.
            {transcripcion.archivado_en
              ? ' Una copia del audio quedó respaldada en tu Google Drive.'
              : ''}
          </p>
        </div>
      )}

      {/* Tab content */}
      {tab === 'analisis' && (
        <div className="space-y-3">
          {analisisDesactualizado && (
            <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800/60 dark:bg-amber-950/40">
              <p className="font-semibold text-amber-900 dark:text-amber-100">
                Editaste el texto después de este análisis
              </p>
              <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
                El resumen y los puntos de abajo se generaron con el texto anterior. Si quieres
                que reflejen tus correcciones, usa «Reanalizar».
              </p>
            </div>
          )}
          {!analisis && estaPendiente && (
            <div className="rounded-2xl border border-dashed border-brand/40 bg-brand-soft p-5 text-sm text-stone-700 dark:bg-brand-softdark dark:text-stone-200">
              <p className="font-semibold">
                {transcripcion.estado === 'analizando' ? 'Analizando con IA…' : 'En cola'}
              </p>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                Esto puede tomar 10-60 segundos. La pestaña se actualiza automáticamente.
              </p>
            </div>
          )}

          {!analisis && transcripcion.estado === 'completado' && (
            <div className="rounded-2xl border border-stone-200 bg-white p-5 text-sm text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
              Transcripción lista pero sin análisis. Presiona “Disparar análisis” arriba.
            </div>
          )}

          {analisis && (
            <>
              {/* Re-análisis sin re-transcribir */}
              <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
                    Re-analizar
                  </h3>
                  <InfoTooltip label="Cuándo conviene re-analizar">
                    Genera el análisis de nuevo, por ejemplo con otra plantilla. Los
                    nombres de los hablantes se actualizan solos al renombrarlos —
                    no necesitas reanalizar para eso. No re-transcribe el audio.
                  </InfoTooltip>
                </div>
                {templateOptions.length > 0 && (
                  <div className="mb-3">
                    <span className="mb-1.5 block text-sm font-medium text-stone-700 dark:text-stone-200">
                      Plantilla
                    </span>
                    <SelectMenu
                      value={templateSel}
                      onChange={setTemplateSel}
                      options={templateOptions}
                      groups={grupos}
                      size="sm"
                      ariaLabel="Plantilla de análisis"
                      disabled={reanalyzing}
                    />
                  </div>
                )}
                <div className="mb-3">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-stone-700 dark:text-stone-200">
                      Modo de análisis
                    </span>
                    <InfoTooltip label="Rápido vs Profundo">
                      «Rápido» analiza con menos esfuerzo de la IA: es más veloz y
                      económico, ideal para el día a día. «Profundo» hace que la IA
                      razone más a fondo: tarda un poco más pero saca un resumen y
                      conclusiones más ricas. Útil para reuniones importantes o
                      densas.
                    </InfoTooltip>
                  </div>
                  <SelectMenu
                    value={modoSel}
                    onChange={(v) => setModoSel(normalizarModoAnalisis(v))}
                    options={modoOptions}
                    size="sm"
                    ariaLabel="Modo de análisis"
                    disabled={reanalyzing}
                  />
                </div>
                {proyectoId && (
                  <div className="mb-3">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-stone-700 dark:text-stone-200">
                        Contexto del proyecto
                      </span>
                      <InfoTooltip label="Analizar con el histórico">
                        Hace que el análisis tome en cuenta las reuniones anteriores
                        de este proyecto, no solo esta sesión. «Memoria del proyecto»
                        usa el resumen de todo el histórico (económico). «Histórico
                        detallado» suma además los resúmenes de las últimas sesiones.
                        Genera la «Memoria del proyecto» en la página del proyecto para
                        aprovecharlo al máximo.
                      </InfoTooltip>
                    </div>
                    <SelectMenu
                      value={contextoSel}
                      onChange={(v) => setContextoSel(v as ContextoProyectoScope)}
                      options={contextoOptions}
                      size="sm"
                      ariaLabel="Contexto del proyecto"
                      disabled={reanalyzing}
                    />
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleReanalyze}
                  disabled={reanalyzing}
                  className="tap-scale w-full rounded-xl bg-brand-soft py-2.5 text-sm font-semibold text-brand transition hover:bg-brand-soft/70 disabled:opacity-50 dark:bg-brand-softdark"
                >
                  {reanalyzing ? 'Reanalizando…' : '↻ Reanalizar'}
                </button>
              </section>

              <Card title="Resumen">
                <p className="text-sm leading-relaxed whitespace-pre-line text-stone-900 dark:text-stone-100">
                  {analisis.resumen}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <MetaChip label="Modelo" value={analisis.model_used} />
                  <MetaChip label="Categoría" value={formatCategoria(analisis.categoria)} />
                  <MetaChip label="Costo" value={formatCost(analisis.cost_usd)} />
                </div>
              </Card>

              {(analisis.bullets?.length ?? 0) > 0 && (
                <Card title="Puntos clave">
                  <ul className="space-y-2 text-sm text-stone-900 dark:text-stone-100">
                    {(analisis.bullets ?? []).map((b, i) => (
                      <li key={i} className="flex gap-2.5">
                        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" aria-hidden="true" />
                        <span className="leading-relaxed">{b}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {(analisis.action_items?.length ?? 0) > 0 && (
                <Card title="Acuerdos">
                  <ul className="space-y-2 text-sm">
                    {(analisis.action_items ?? []).map((ai, i) => (
                      <li
                        key={i}
                        className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 dark:border-stone-700 dark:bg-stone-800/60"
                      >
                        <p className="text-stone-900 dark:text-stone-100">{ai.texto}</p>
                        {(ai.owner || ai.due_date) && (
                          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                            {ai.owner && <>Responsable: {ai.owner}</>}
                            {ai.owner && ai.due_date && ' · '}
                            {ai.due_date && <>Para: {ai.due_date}</>}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {Object.entries(analisis.custom_fields ?? {}).length > 0 && (
                <Card title="Detalle por plantilla">
                  <div className="space-y-3 text-sm">
                    {Object.entries(analisis.custom_fields ?? {}).map(([key, val]) => (
                      <div key={key}>
                        <p className="mb-1 text-xs font-semibold text-stone-600 dark:text-stone-400">
                          {formatCustomFieldKey(key)}
                        </p>
                        {isStringArray(val) ? (
                          val.length === 0 ? (
                            <p className="text-xs text-stone-400 italic">— Vacío —</p>
                          ) : (
                            <ul className="space-y-1 text-stone-900 dark:text-stone-100">
                              {val.map((v, i) => (
                                <li key={i} className="flex gap-2.5">
                                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-stone-300 dark:bg-stone-600" aria-hidden="true" />
                                  <span>{v}</span>
                                </li>
                              ))}
                            </ul>
                          )
                        ) : typeof val === 'string' ? (
                          <p className="text-stone-900 dark:text-stone-100">{val}</p>
                        ) : (
                          <pre className="overflow-x-auto rounded-xl bg-stone-100 p-2.5 text-xs text-stone-800 dark:bg-stone-800 dark:text-stone-200">
                            {JSON.stringify(val, null, 2)}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'transcripcion' && (
        <div className="space-y-3">
          {/* Alerta de discrepancia de hablantes */}
          {hayDiscrepancia && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
              <p className="font-semibold">
                Esperabas {numEsperado} {numEsperado === 1 ? 'persona' : 'personas'},
                detectamos {numDetectado}.
              </p>
              <p className="mt-1 text-xs leading-relaxed">
                Revisa la separación de hablantes abajo. A veces dos voces parecidas
                se juntan o una persona que habla poco no se separa. Puedes corregir
                los nombres en Participantes.
              </p>
            </div>
          )}

          {/* Roster pre-registrado como ayuda */}
          {rosterEsperado.length > 0 && (
            <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400">
              <span className="font-semibold text-stone-700 dark:text-stone-300">
                Participantes anotados:
              </span>{' '}
              {rosterEsperado.join(', ')}
            </div>
          )}

          {/* Toggle original / traduccion */}
          {hayTraduccion && (
            <div className="flex items-center gap-1 rounded-2xl bg-stone-100 p-1 dark:bg-stone-900">
              <button
                type="button"
                onClick={() => setVerOriginal(false)}
                className={`tap-scale flex-1 rounded-xl px-2 py-1.5 text-[12px] font-semibold transition ${
                  !verOriginal
                    ? 'bg-white text-brand shadow-sm dark:bg-stone-800'
                    : 'text-stone-500 dark:text-stone-400'
                }`}
              >
                Traducción (Español)
              </button>
              <button
                type="button"
                onClick={() => setVerOriginal(true)}
                className={`tap-scale flex-1 rounded-xl px-2 py-1.5 text-[12px] font-semibold transition ${
                  verOriginal
                    ? 'bg-white text-brand shadow-sm dark:bg-stone-800'
                    : 'text-stone-500 dark:text-stone-400'
                }`}
              >
                Original{nombreOrigen ? ` (${nombreOrigen})` : ''}
              </button>
            </div>
          )}

          {speakerIds.length > 0 && (
            <ParticipantesPanel
              transcripcionId={transcripcion.id}
              speakerIds={speakerIds}
              initialNames={speakerNames}
              fuentes={fuentes}
            />
          )}
          {segments.length === 0 && transcripcion.raw_text && (
            <Card title="Transcripción">
              <p className="text-sm leading-relaxed whitespace-pre-line text-stone-900 dark:text-stone-100">
                {transcripcion.raw_text}
              </p>
            </Card>
          )}
          {segments.length > 0 && (
            <>
              {/* Toolbar de edición de texto */}
              {puedeEditarTexto && (
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
                      Transcripción
                    </span>
                    <InfoTooltip label="Editar el texto">
                      Corrige errores de transcripción (nombres, términos). Toca una
                      línea para editarla. Al guardar se actualiza la búsqueda; el
                      análisis no se regenera solo (usa «Reanalizar» si quieres).
                    </InfoTooltip>
                  </div>
                  {!editando ? (
                    <button
                      type="button"
                      onClick={() => setEditando(true)}
                      className="tap-scale inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1 text-[11px] font-semibold text-stone-600 transition hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300"
                    >
                      ✎ Editar texto
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleCancelarEdicion}
                        disabled={guardandoEdit}
                        className="tap-scale rounded-full px-3 py-1 text-[11px] font-semibold text-stone-500 transition hover:text-stone-700 disabled:opacity-50 dark:text-stone-400"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        onClick={handleGuardarEdicion}
                        disabled={guardandoEdit || numCambios === 0}
                        className="tap-scale rounded-full bg-brand px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-brand/90 disabled:opacity-50"
                      >
                        {guardandoEdit ? 'Guardando…' : `Guardar${numCambios > 0 ? ` (${numCambios})` : ''}`}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {editando && (
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Toca cualquier línea para corregirla. Se guardan solo las que cambies.
                </p>
              )}
              {errorEdit && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                  {errorEdit}
                </div>
              )}
              <div className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white dark:border-stone-800 dark:bg-stone-900">
                <ul className="divide-y divide-stone-100 dark:divide-stone-800">
                  {segments.map((seg, i) => {
                    const fuenteAnchor = anclasFuente.get(i)
                    const valor = textoSegmento(i, seg.text)
                    const editado = cambios[i] !== undefined && cambios[i] !== seg.text
                    return (
                      <li
                        key={i}
                        id={fuenteAnchor !== undefined ? `fuente-${fuenteAnchor}` : undefined}
                        className="scroll-mt-24 px-4 py-3"
                      >
                        <div className="mb-1 flex items-center gap-2">
                          <span className="font-mono text-[11px] text-stone-400">
                            {formatTimestamp(seg.start_ms)}
                          </span>
                          <span className="text-[11px] font-bold text-brand">
                            {resolveSpeakerName(seg.speaker.id, speakerNames)}
                          </span>
                          {editado && (
                            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
                              editado
                            </span>
                          )}
                        </div>
                        {editando && editIdx === i ? (
                          <textarea
                            autoFocus
                            defaultValue={valor}
                            onBlur={(e) => {
                              const v = e.target.value
                              setCambios((prev) => ({ ...prev, [i]: v }))
                              setEditIdx(null)
                            }}
                            rows={Math.min(6, Math.max(2, Math.ceil(valor.length / 60)))}
                            className="w-full rounded-lg border border-brand/40 bg-white p-2 text-sm leading-relaxed text-stone-900 outline-none focus:border-brand dark:bg-stone-950 dark:text-stone-100"
                          />
                        ) : (
                          <p
                            className={`text-sm leading-relaxed text-stone-900 dark:text-stone-100 ${
                              editando
                                ? '-mx-1 cursor-text rounded-md px-1 hover:bg-brand-soft/50 dark:hover:bg-brand-softdark/40'
                                : ''
                            }`}
                            onClick={editando ? () => setEditIdx(i) : undefined}
                          >
                            {valor}
                          </p>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            </>
          )}
          {segments.length === 0 && !transcripcion.raw_text && estadoLabel !== 'Completado' && (
            <div className="rounded-2xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
              Aún no hay transcripción disponible. Estado actual: {estadoLabel}.
            </div>
          )}
          {segments.length === 0 && !transcripcion.raw_text && estadoLabel === 'Completado' && (
            <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
              <p className="font-semibold">El audio se procesó pero no se extrajo texto.</p>
              <p className="text-xs leading-relaxed">
                Esto suele ocurrir cuando: (a) el audio está en un idioma distinto al
                esperado, (b) no contiene voz humana, o (c) el volumen es demasiado bajo.
                Puedes volver a subir el archivo o revisar la grabación original.
              </p>
            </div>
          )}
        </div>
      )}

      {tab === 'ask' && (
        <AskPanel
          transcripcionId={transcripcion.id}
          initialHistory={asksHistory}
          indexada={indexada}
          estadoTranscripcion={transcripcion.estado}
          speakerNames={speakerNames}
        />
      )}

      <ScrollToTop />
    </div>
  )
}
