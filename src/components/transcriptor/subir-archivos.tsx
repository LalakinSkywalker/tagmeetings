'use client'

// =============================================================================
// SubirArchivos — pantalla unificada de subida (1 o varios archivos)
// =============================================================================
// UNA sola interfaz para analizar archivos. El usuario sube de 1 a N archivos
// (audio/video/documentos, hasta 2 GB en total), pone título + plantilla +
// idioma + modo + participantes, e inicia. El SISTEMA decide el motor por debajo
// (el usuario nunca elige "modo" ni ve "fuentes"):
//   - 1 archivo de audio/video  → motor SIMPLE (createTranscripcionDraft +
//     iniciarTranscripcion): conserva el audio original descargable y los
//     hablantes salen limpios ("Hablante 0, 1, 2").
//   - 2+ archivos, o cualquier documento (PDF/Word/texto) → motor COMBINADO
//     (multi-fuente): los pega en un solo análisis con el panel de fuentes.
// =============================================================================

import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'
import {
  createTranscripcionDraft,
  iniciarTranscripcion,
} from '@/actions/transcripciones'
import {
  createTranscripcionMultifuenteDraft,
  iniciarTranscripcionMultifuente,
} from '@/actions/multifuente'
import {
  OpcionesCaptura,
  parseRoster,
  type TemplateOption,
  type TemplateGrupo,
  type CapturaDefaults,
} from './opciones-captura'
import { type ModoAnalisis } from '@/lib/transcription/modo-analisis'

interface Props {
  templates: TemplateOption[]
  grupos: TemplateGrupo[]
  /** Defaults del usuario: inicializan los selects; override por sesión. */
  defaults: CapturaDefaults
}

type Phase = 'idle' | 'subiendo' | 'procesando' | 'listo' | 'error'

const MAX_ARCHIVOS = 10
const MAX_BYTES_TOTAL = 2_147_483_648 // 2 GB sumando todo

function bytesToHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function defaultTitleFromFile(filename: string): string {
  const dotIdx = filename.lastIndexOf('.')
  const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename
  return base.slice(0, 100)
}

type TipoVisual = 'audio' | 'video' | 'documento'

function tipoVisual(file: File): TipoVisual {
  const m = (file.type || '').toLowerCase()
  const n = file.name.toLowerCase()
  if (m.startsWith('video/') || /\.(mp4|mov|mkv|webm)$/.test(n)) return 'video'
  if (
    m === 'application/pdf' ||
    m.includes('word') ||
    m.startsWith('text/') ||
    /\.(pdf|docx?|txt|md)$/.test(n)
  ) {
    return 'documento'
  }
  return 'audio'
}

const TIPO_LABEL: Record<TipoVisual, string> = {
  audio: 'Audio',
  video: 'Video',
  documento: 'Documento',
}

export function SubirArchivos({ templates, grupos, defaults }: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [titulo, setTitulo] = useState('')
  const [templateId, setTemplateId] = useState<string>(defaults.templateId ?? templates[0]?.id ?? '')
  const [idioma, setIdioma] = useState(defaults.idioma)
  const [traducir, setTraducir] = useState<string | null>(defaults.traducirA)
  const [numSpeakers, setNumSpeakers] = useState('')
  const [roster, setRoster] = useState('')
  const [modo, setModo] = useState<ModoAnalisis>(defaults.modo)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progressMsg, setProgressMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)
  /** Id de la transcripción recién iniciada (para el enlace "Ver transcripción"). */
  const [doneId, setDoneId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const busy = phase === 'subiendo' || phase === 'procesando'

  const addFiles = useCallback((incoming: FileList | File[]) => {
    setErrorMsg('')
    // Si venía de un análisis recién iniciado, limpiar el aviso para empezar otro.
    setPhase('idle')
    setDoneId(null)
    setFiles((prev) => {
      const next = [...prev]
      for (const f of Array.from(incoming)) {
        if (next.length >= MAX_ARCHIVOS) break
        if (f.size === 0) continue
        if (next.some((x) => x.name === f.name && x.size === f.size)) continue
        next.push(f)
      }
      return next
    })
  }, [])

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragOver(false)
      if (e.dataTransfer.files?.length) addFiles(Array.from(e.dataTransfer.files))
    },
    [addFiles],
  )

  const handleIniciar = async () => {
    setErrorMsg('')
    if (files.length === 0) {
      setErrorMsg('Agrega al menos un archivo.')
      return
    }
    if (totalBytes > MAX_BYTES_TOTAL) {
      setErrorMsg(`El total supera el límite de ${bytesToHuman(MAX_BYTES_TOTAL)}.`)
      return
    }
    if (!templateId) {
      setErrorMsg('Selecciona una plantilla.')
      return
    }

    // El sistema decide el motor: 1 archivo de audio/video → simple; el resto → combinado.
    const esMediaUnico = files.length === 1 && tipoVisual(files[0]!) !== 'documento'

    setPhase('subiendo')
    try {
      let transcripcionId: string

      if (esMediaUnico) {
        // ---- MOTOR SIMPLE (1 audio/video) ----
        const file = files[0]!
        setProgressMsg('Subiendo el audio…')
        const draft = await createTranscripcionDraft({
          titulo: titulo.trim() || defaultTitleFromFile(file.name),
          templateId,
          idioma,
          traducirA: traducir,
          participantesEsperados: parseRoster(roster),
          numSpeakersEsperados: numSpeakers ? Number(numSpeakers) : undefined,
          modoAnalisis: modo,
          audioFilename: file.name,
          audioMime: file.type || 'application/octet-stream',
          audioSizeBytes: file.size,
        })
        const res = await fetch(draft.signedUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
        })
        if (!res.ok) throw new Error(`Falló la subida: HTTP ${res.status}`)

        setPhase('procesando')
        setProgressMsg('Iniciando transcripción y análisis…')
        const result = await iniciarTranscripcion(draft.transcripcionId)
        if (!result.ok) {
          setPhase('error')
          setErrorMsg(result.errorMessage ?? 'Error al iniciar el análisis.')
          return
        }
        transcripcionId = draft.transcripcionId
      } else {
        // ---- MOTOR COMBINADO (2+ archivos o documento) ----
        setProgressMsg('Preparando la subida…')
        const draft = await createTranscripcionMultifuenteDraft({
          titulo: titulo.trim() || `Análisis de ${files.length} archivos`,
          templateId,
          idioma,
          traducirA: traducir,
          participantesEsperados: parseRoster(roster),
          numSpeakersEsperados: numSpeakers ? Number(numSpeakers) : undefined,
          modoAnalisis: modo,
          fuentes: files.map((f) => ({
            nombre: f.name,
            mime: f.type || 'application/octet-stream',
            sizeBytes: f.size,
          })),
        })

        const ordenadas = [...draft.fuentes].sort((a, b) => a.orden - b.orden)
        for (let i = 0; i < ordenadas.length; i++) {
          const fu = ordenadas[i]!
          const file = files[fu.orden]!
          setProgressMsg(`Subiendo ${i + 1} de ${ordenadas.length}: ${file.name}`)
          const res = await fetch(fu.signedUrl, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
          })
          if (!res.ok) throw new Error(`Falló la subida de "${file.name}": HTTP ${res.status}`)
        }

        setPhase('procesando')
        setProgressMsg('Procesando y combinando los archivos…')
        const result = await iniciarTranscripcionMultifuente(draft.transcripcionId)
        if (!result.ok) {
          setPhase('error')
          setErrorMsg(result.errorMessage ?? 'Error al iniciar el análisis.')
          return
        }
        transcripcionId = draft.transcripcionId
      }

      // Análisis iniciado. NO redirigimos: nos quedamos en Capturar mostrando el
      // aviso + enlace para ver la transcripción. Limpiamos el formulario para
      // poder subir otro de inmediato.
      setDoneId(transcripcionId)
      setFiles([])
      setTitulo('')
      setPhase('listo')
    } catch (err) {
      setPhase('error')
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-4">
      {/* Cola de archivos */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`rounded-2xl border-2 border-dashed p-4 transition ${
          dragOver ? 'border-brand bg-brand-soft dark:bg-brand-softdark' : 'border-stone-300 dark:border-stone-700'
        } ${busy ? 'opacity-60' : ''}`}
      >
        {files.length === 0 ? (
          <button
            type="button"
            onClick={() => !busy && fileInputRef.current?.click()}
            disabled={busy}
            className="flex w-full flex-col items-center justify-center gap-2 py-8 text-center"
          >
            <svg
              className="size-10 text-stone-400 dark:text-stone-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7 16a4 4 0 01-.88-7.9 5 5 0 019.9-1.62A4.5 4.5 0 0117 16h-1m-4-4v8m0-8l-3 3m3-3l3 3"
              />
            </svg>
            <p className="text-base font-medium text-stone-700 dark:text-stone-200">
              Arrastra o sube tus archivos, hasta 2 GB en total
            </p>
            <p className="text-sm text-stone-400">Audio, video o documentos (uno o varios)</p>
          </button>
        ) : (
          <ul className="space-y-2">
            {files.map((f, i) => {
              const tv = tipoVisual(f)
              return (
                <li
                  key={`${f.name}-${i}`}
                  className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5 dark:border-stone-700 dark:bg-stone-900"
                >
                  <span className="rounded-lg bg-brand-soft px-2 py-0.5 text-[10px] font-semibold text-brand dark:bg-brand-softdark">
                    {TIPO_LABEL[tv]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base text-stone-900 dark:text-stone-100">{f.name}</p>
                    <p className="text-sm text-stone-400">{bytesToHuman(f.size)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    disabled={busy}
                    aria-label={`Quitar ${f.name}`}
                    className="tap-scale shrink-0 rounded-lg border border-stone-200 px-2 py-1.5 text-stone-400 transition hover:border-red-300 hover:text-red-600 disabled:opacity-50 dark:border-stone-700"
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="size-4" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              )
            })}
            {files.length < MAX_ARCHIVOS && (
              <li>
                <button
                  type="button"
                  onClick={() => !busy && fileInputRef.current?.click()}
                  disabled={busy}
                  className="tap-scale w-full rounded-xl border border-dashed border-stone-300 py-2.5 text-sm font-semibold text-stone-500 transition hover:border-brand/50 hover:text-brand disabled:opacity-50 dark:border-stone-700 dark:text-stone-400"
                >
                  + Agregar otro archivo
                </button>
              </li>
            )}
            <li className="pt-1 text-right text-sm text-stone-400">
              {files.length} {files.length === 1 ? 'archivo' : 'archivos'} · {bytesToHuman(totalBytes)}
            </li>
          </ul>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept="audio/*,video/mp4,video/webm,video/quicktime,video/x-matroska,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,text/plain,.txt,.md"
          onChange={(e) => {
            const picked = e.target.files ? Array.from(e.target.files) : []
            if (picked.length) addFiles(picked)
            e.target.value = ''
          }}
          disabled={busy}
        />
      </div>

      {/* Título del análisis */}
      <div>
        <label htmlFor="subir-titulo" className="mb-1.5 block text-base font-medium text-stone-700 dark:text-stone-200">
          Título <span className="font-normal text-stone-400">(opcional)</span>
        </label>
        <input
          id="subir-titulo"
          value={titulo}
          onChange={(e) => setTitulo(e.target.value)}
          maxLength={120}
          placeholder="Ponle un nombre a este análisis"
          disabled={busy}
          className="block w-full rounded-md border border-stone-300 bg-white px-3 py-2.5 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        />
      </div>

      {/* Opciones del análisis */}
      <OpcionesCaptura
        templates={templates}
        grupos={grupos}
        templateId={templateId}
        onTemplateId={setTemplateId}
        idioma={idioma}
        onIdioma={setIdioma}
        traducirA={traducir}
        onTraducirA={setTraducir}
        numSpeakers={numSpeakers}
        onNumSpeakers={setNumSpeakers}
        roster={roster}
        onRoster={setRoster}
        modo={modo}
        onModo={setModo}
        disabled={busy}
        size="md"
      />

      {errorMsg && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {errorMsg}
        </div>
      )}

      {busy && (
        <div className="rounded-2xl border border-brand/30 bg-brand-soft px-4 py-3 text-sm text-brand dark:border-brand/50 dark:bg-brand-softdark">
          <p className="flex items-center gap-2 font-medium">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
            {progressMsg}
          </p>
          <p className="mt-1 text-xs">No cierres la pestaña.</p>
        </div>
      )}

      {/* Aviso de análisis iniciado (sin redirigir) + enlace para verlo */}
      {phase === 'listo' && doneId && (
        <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 dark:border-green-900 dark:bg-green-950">
          <p className="font-medium text-green-900 dark:text-green-100">✓ Análisis iniciado</p>
          <p className="mt-1 text-sm text-green-800 dark:text-green-200">
            Lo estamos procesando. Puedes ver su avance ahora o subir otro archivo.
          </p>
          <Link
            href={`/dashboard/transcripcion/${doneId}`}
            className="tap-scale mt-2.5 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-strong"
          >
            Ver transcripción
            <svg viewBox="0 0 24 24" fill="none" className="size-4" aria-hidden="true">
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>
      )}

      {/* Botón principal: iniciar análisis (oculto mientras se muestra el aviso de éxito) */}
      {phase !== 'listo' && (
        <button
          type="button"
          onClick={handleIniciar}
          disabled={busy || files.length === 0}
          className="tap-scale flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 text-base font-bold text-white shadow-sm transition hover:bg-brand-strong disabled:opacity-50"
        >
          {phase === 'subiendo' ? (
            'Subiendo…'
          ) : phase === 'procesando' ? (
            'Procesando…'
          ) : (
            <>
              <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
                <path d="M5 3l14 9-14 9V3z" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" />
              </svg>
              Iniciar análisis
            </>
          )}
        </button>
      )}
    </div>
  )
}
