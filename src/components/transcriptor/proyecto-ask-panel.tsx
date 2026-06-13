'use client'

// =============================================================================
// ProyectoAskPanel — Ask cross-sesion a nivel proyecto (PRP-TT-V2 Fase 5B)
// =============================================================================
// Pregunta sobre el HISTORICO de todas las sesiones del proyecto. Cada cita
// recuerda de que sesion proviene y enlaza a ella. Mismo lenguaje visual que el
// Ask por sesion (ask-panel.tsx) pero con la dimension de "que sesion".
// Estandar mobile-native-ui: tap-scale, input sticky, dark, font nivel iOS.
// =============================================================================

import { useState, useTransition, useRef, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  askProyecto,
  type AskProyectoCitationDTO,
  type AskProyectoQueryListItem,
} from '@/actions/proyectos'

interface Props {
  proyectoId: string
  initialHistory: AskProyectoQueryListItem[]
}

interface OptimisticAsk {
  id: string
  question: string
  answer: string
  citations: AskProyectoCitationDTO[]
  model_used: string | null
  cost_usd: number | null
  pending?: boolean
  error?: string
}

function formatTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function CitationCard({ citation }: { citation: AskProyectoCitationDTO }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-brand/30 bg-brand-soft/60 dark:bg-brand-softdark/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="tap-scale flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-xs font-bold text-brand">
          [{formatTimestamp(citation.start_ms)}]
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-stone-700 dark:text-stone-200">
          {citation.titulo_sesion}
          {citation.speaker_label ? ` · ${citation.speaker_label}` : ''}
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className={`size-4 shrink-0 text-brand transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="animate-fade-in-up space-y-2 px-3 pb-3">
          <p className="text-sm leading-relaxed text-stone-700 dark:text-stone-200">
            &ldquo;{citation.text}&rdquo;
          </p>
          <Link
            href={`/dashboard/transcripcion/${citation.transcripcion_id}`}
            className="tap-scale inline-flex items-center gap-1 text-xs font-semibold text-brand"
          >
            Ver en la sesión
            <svg viewBox="0 0 24 24" fill="none" className="size-3.5" aria-hidden="true">
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>
      )}
    </div>
  )
}

function QABubble({ ask }: { ask: OptimisticAsk }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-4 py-2 text-sm text-white shadow-sm">
          {ask.question}
        </div>
      </div>
      <div className="flex justify-start">
        <div className="w-full max-w-[95%] space-y-2 rounded-2xl rounded-bl-sm border border-stone-200 bg-white px-4 py-3 text-sm shadow-sm dark:border-stone-700 dark:bg-stone-800">
          {ask.pending ? (
            <p className="flex items-center gap-2 text-stone-500 dark:text-stone-400">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
              Buscando en todas las sesiones del proyecto…
            </p>
          ) : ask.error ? (
            <p className="text-red-700 dark:text-red-300">{ask.error}</p>
          ) : (
            <>
              <p className="whitespace-pre-wrap text-stone-900 dark:text-stone-100">{ask.answer}</p>
              {ask.citations.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  {ask.citations.map((c, i) => (
                    <CitationCard key={i} citation={c} />
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-3 pt-1 text-xs text-stone-400">
                {ask.model_used && <span>Modelo: {ask.model_used}</span>}
                {ask.cost_usd !== null && <span>Costo: ${Number(ask.cost_usd).toFixed(4)}</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function ProyectoAskPanel({ proyectoId, initialHistory }: Props) {
  const [history, setHistory] = useState<OptimisticAsk[]>(initialHistory)
  const [question, setQuestion] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [, startTransition] = useTransition()
  const router = useRouter()
  const bottomRef = useRef<HTMLDivElement>(null)

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
    const tempId = `temp-${history.length}-${clean.length}`
    setHistory((prev) => [
      ...prev,
      { id: tempId, question: clean, answer: '', citations: [], model_used: null, cost_usd: null, pending: true },
    ])
    setQuestion('')

    try {
      const result = await askProyecto(proyectoId, clean)
      if (!result.ok) {
        setHistory((prev) =>
          prev.map((a) =>
            a.id === tempId ? { ...a, pending: false, error: result.errorMessage ?? 'Error desconocido.' } : a,
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
                  pending: false,
                }
              : a,
          ),
        )
        startTransition(() => router.refresh())
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setHistory((prev) => prev.map((a) => (a.id === tempId ? { ...a, pending: false, error: msg } : a)))
      setError(msg)
    } finally {
      setSending(false)
    }
  }

  const chips = [
    '¿Qué se acordó a lo largo de las sesiones?',
    '¿Qué pendientes o compromisos quedaron abiertos?',
    '¿Cuáles fueron los temas recurrentes?',
  ]
  const chipLabels = ['Lo acordado', 'Pendientes', 'Temas recurrentes']

  return (
    <div className="flex flex-col gap-4">
      {history.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 p-5 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
          <p className="font-semibold text-stone-700 dark:text-stone-200">
            Pregúntale a la memoria del proyecto
          </p>
          <p className="mt-1 text-xs">
            Busco en todas las sesiones a la vez y te respondo citando en qué sesión y momento se dijo.
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs">
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
            <QABubble key={ask.id} ask={ask} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {error}
        </div>
      )}

      <form
        onSubmit={handleAsk}
        className="sticky bottom-2 z-10 flex gap-2 rounded-2xl border border-stone-200 bg-white p-2 shadow-md dark:border-stone-700 dark:bg-stone-900"
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Pregunta sobre todo el proyecto…"
          disabled={sending}
          maxLength={2000}
          className="min-w-0 flex-1 rounded-xl border border-transparent bg-stone-50 px-3 py-2 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand-ring/40 disabled:opacity-50 dark:bg-stone-800 dark:text-stone-100 dark:focus:bg-stone-900"
        />
        <button
          type="submit"
          disabled={sending || question.trim().length === 0}
          className="tap-scale shrink-0 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-strong disabled:opacity-50"
        >
          {sending ? '…' : 'Preguntar'}
        </button>
      </form>
    </div>
  )
}
