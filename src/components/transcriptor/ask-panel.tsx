'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  askTranscripcion,
  indexarTranscripcion,
  type AskCitationDTO,
  type AskQueryListItem,
} from '@/actions/transcripciones'
import {
  resolveSpeakerName,
  type SpeakerNames,
} from '@/lib/transcription/speaker-names'

interface Props {
  transcripcionId: string
  initialHistory: AskQueryListItem[]
  indexada: boolean
  estadoTranscripcion: string
  /** Diccionario de nombres reales de hablantes (PRP-TT-003). */
  speakerNames: SpeakerNames
}

interface OptimisticAsk {
  id: string
  question: string
  answer: string
  citations: AskCitationDTO[]
  model_used: string | null
  cost_usd: number | null
  created_at: string
  pending?: boolean
  error?: string
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function CitationChip({
  citation,
  speakerNames,
  isOpen,
  onToggle,
}: {
  citation: AskCitationDTO
  speakerNames: SpeakerNames
  isOpen: boolean
  onToggle: () => void
}) {
  const speakerLabel = resolveSpeakerName(citation.speaker_id, speakerNames)
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      className={`tap-scale inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium text-brand transition ${
        isOpen
          ? 'border-brand bg-brand-soft dark:bg-brand-softdark'
          : 'border-brand/30 bg-brand-soft hover:border-brand/60 dark:border-brand/40 dark:bg-brand-softdark'
      }`}
    >
      <span className="font-mono">[{formatTimestamp(citation.start_ms)}]</span>
      <span className="hidden sm:inline">{speakerLabel}</span>
      <span className="max-w-[140px] truncate text-brand/80 sm:max-w-[220px]">
        &quot;{citation.text.slice(0, 60)}&quot;
      </span>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className={`size-3 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function QABubble({
  ask,
  speakerNames,
}: {
  ask: OptimisticAsk
  speakerNames: SpeakerNames
}) {
  // Cual cita esta expandida (tap-to-expand, mobile-friendly: NO depende de
  // hover/title que no funciona con el dedo y se sale de pantalla en desktop).
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const openCitation = openIdx !== null ? ask.citations[openIdx] : null

  return (
    <div className="space-y-2">
      {/* Pregunta */}
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-4 py-2 text-sm text-white shadow-sm">
          {ask.question}
        </div>
      </div>
      {/* Respuesta o estado pending/error */}
      <div className="flex justify-start">
        <div className="w-full max-w-[95%] space-y-2 rounded-2xl rounded-bl-sm border border-stone-200 bg-white px-4 py-3 text-sm shadow-sm dark:border-stone-700 dark:bg-stone-800">
          {ask.pending ? (
            <p className="flex items-center gap-2 text-stone-500 dark:text-stone-400">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
              Buscando respuesta en la transcripción…
            </p>
          ) : ask.error ? (
            <p className="text-red-700 dark:text-red-300">{ask.error}</p>
          ) : (
            <>
              <p className="whitespace-pre-wrap text-stone-900 dark:text-stone-100">
                {ask.answer}
              </p>
              {ask.citations.length > 0 && (
                <div className="space-y-2 pt-2">
                  <div className="flex flex-wrap gap-1.5">
                    {ask.citations.map((c, i) => (
                      <CitationChip
                        key={i}
                        citation={c}
                        speakerNames={speakerNames}
                        isOpen={openIdx === i}
                        onToggle={() => setOpenIdx(openIdx === i ? null : i)}
                      />
                    ))}
                  </div>
                  {/* Texto completo de la cita seleccionada (mobile-safe, wrap, no se sale) */}
                  {openCitation && (
                    <div className="animate-fade-in-up rounded-xl border border-brand/30 bg-brand-soft/60 p-3 dark:bg-brand-softdark/50">
                      <div className="mb-1 flex items-center gap-2 text-[11px] font-bold text-brand">
                        <span className="font-mono">[{formatTimestamp(openCitation.start_ms)}]</span>
                        <span>{resolveSpeakerName(openCitation.speaker_id, speakerNames)}</span>
                      </div>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap text-stone-700 dark:text-stone-200">
                        {openCitation.text}
                      </p>
                    </div>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-3 pt-1 text-xs text-stone-400">
                {ask.model_used && <span>Modelo: {ask.model_used}</span>}
                {ask.cost_usd !== null && (
                  <span>Costo: ${Number(ask.cost_usd).toFixed(4)}</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function AskPanel({
  transcripcionId,
  initialHistory,
  indexada,
  estadoTranscripcion,
  speakerNames,
}: Props) {
  const [history, setHistory] = useState<OptimisticAsk[]>(initialHistory)
  const [question, setQuestion] = useState('')
  const [sending, setSending] = useState(false)
  const [indexando, setIndexando] = useState(false)
  const [error, setError] = useState('')
  const [, startTransition] = useTransition()
  const router = useRouter()
  const bottomRef = useRef<HTMLDivElement>(null)

  const procesando =
    estadoTranscripcion === 'transcribiendo' ||
    estadoTranscripcion === 'analizando' ||
    estadoTranscripcion === 'indexando' ||
    estadoTranscripcion === 'pendiente'

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [history.length])

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault()
    const clean = question.trim()
    if (clean.length === 0) return
    if (clean.length > 2000) {
      setError('La pregunta es demasiado larga (máximo 2000 caracteres).')
      return
    }

    setError('')
    setSending(true)

    const tempId = `temp-${Date.now()}`
    const optimistic: OptimisticAsk = {
      id: tempId,
      question: clean,
      answer: '',
      citations: [],
      model_used: null,
      cost_usd: null,
      created_at: new Date().toISOString(),
      pending: true,
    }
    setHistory((prev) => [...prev, optimistic])
    setQuestion('')

    try {
      const result = await askTranscripcion(transcripcionId, clean)
      if (!result.ok) {
        setHistory((prev) =>
          prev.map((a) =>
            a.id === tempId
              ? { ...a, pending: false, error: result.errorMessage ?? 'Error desconocido.' }
              : a,
          ),
        )
        setError(result.errorMessage ?? 'Error desconocido al preguntar.')
      } else {
        setHistory((prev) =>
          prev.map((a) =>
            a.id === tempId
              ? {
                  id: result.askId ?? tempId,
                  question: clean,
                  answer: result.answer ?? '',
                  citations: result.citations ?? [],
                  model_used: result.modelUsed ?? null,
                  cost_usd: result.costUsd ?? null,
                  created_at: a.created_at,
                  pending: false,
                }
              : a,
          ),
        )
        startTransition(() => router.refresh())
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setHistory((prev) =>
        prev.map((a) => (a.id === tempId ? { ...a, pending: false, error: msg } : a)),
      )
      setError(msg)
    } finally {
      setSending(false)
    }
  }

  const handleIndexarManual = async () => {
    setIndexando(true)
    setError('')
    try {
      const result = await indexarTranscripcion(transcripcionId)
      if (!result.ok) {
        setError(result.errorMessage ?? 'No se pudo indexar la transcripción.')
      } else {
        startTransition(() => router.refresh())
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIndexando(false)
    }
  }

  // ---- Estado: procesando todavía ------------------------------------------
  if (procesando && history.length === 0 && !indexada) {
    return (
      <div className="rounded-2xl border border-dashed border-brand/40 bg-brand-soft p-6 text-sm text-stone-700 dark:bg-brand-softdark dark:text-stone-200">
        <p className="font-semibold">Procesando…</p>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          La transcripción aún se está {estadoTranscripcion === 'indexando' ? 'indexando para Ask' : estadoTranscripcion}.
          El tab Ask estará disponible cuando termine.
        </p>
      </div>
    )
  }

  // ---- Estado: no indexada (analizada pero sin chunks) ---------------------
  if (!indexada && estadoTranscripcion === 'completado') {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-semibold">Esta transcripción aún no está indexada</p>
          <p className="mt-1 text-xs">
            El indexado prepara los segmentos para que puedas preguntar sobre el contenido y
            recibir respuestas con citas a momentos exactos. Tiene un costo de centavos.
          </p>
          <button
            type="button"
            onClick={handleIndexarManual}
            disabled={indexando}
            className="tap-scale mt-3 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-strong disabled:opacity-50"
          >
            {indexando ? 'Indexando…' : 'Indexar ahora'}
          </button>
        </div>
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
            {error}
          </div>
        )}
      </div>
    )
  }

  // ---- Estado normal: indexada -> chat -------------------------------------
  const chips = [
    '¿Cuál es el resumen ejecutivo de esta conversación?',
    '¿Qué decisiones se tomaron?',
    '¿Cuáles son los próximos pasos acordados?',
  ]
  const chipLabels = ['Resumen ejecutivo', 'Decisiones tomadas', 'Próximos pasos']

  return (
    <div className="flex flex-col gap-4">
      {history.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
          <p className="font-semibold text-stone-700 dark:text-stone-200">
            Pregúntame lo que quieras sobre esta transcripción
          </p>
          <p className="mt-1 text-xs">
            Buscaré por similaridad semántica en los segmentos indexados y te responderé citando
            los momentos exactos del audio.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs">
            {chips.map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setQuestion(q)}
                className="tap-scale rounded-full border border-stone-200 bg-white px-3 py-1.5 font-medium text-stone-600 transition hover:border-brand/50 hover:bg-brand-soft hover:text-brand dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300 dark:hover:border-brand/50 dark:hover:bg-brand-softdark"
              >
                {chipLabels[i]}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {history.map((ask) => (
            <QABubble key={ask.id} ask={ask} speakerNames={speakerNames} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {error}
        </div>
      )}

      {/* Input sticky */}
      <form
        onSubmit={handleAsk}
        className="sticky bottom-2 z-10 flex gap-2 rounded-2xl border border-stone-200 bg-white p-2 shadow-md dark:border-stone-700 dark:bg-stone-900"
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Escribe tu pregunta..."
          disabled={sending}
          maxLength={2000}
          className="flex-1 rounded-xl border border-transparent bg-stone-50 px-3 py-2 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand-ring/40 disabled:opacity-50 dark:bg-stone-800 dark:text-stone-100 dark:focus:bg-stone-900"
        />
        <button
          type="submit"
          disabled={sending || question.trim().length === 0}
          className="tap-scale rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-strong disabled:opacity-50"
        >
          {sending ? '…' : 'Preguntar'}
        </button>
      </form>
    </div>
  )
}
