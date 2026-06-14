'use client'

// =============================================================================
// Tarjeta de conexion a Google Drive (Ajustes)
// =============================================================================
// Conectar = navegacion a /api/drive/connect (inicia el OAuth). Desconectar =
// server action que borra los tokens. Mobile-native: etiqueta + valor + ⓘ.
// =============================================================================

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { disconnectDrive } from '@/actions/drive'

function DriveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M8 4h8l5 9-4 7H7l-4-7L8 4Z"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinejoin="round"
      />
      <path d="M8 4l4 9h9M16 4l-7 16M3 13h13" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" />
    </svg>
  )
}

export function DriveConnect({ connected, email }: { connected: boolean; email: string | null }) {
  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()
  const router = useRouter()

  async function handleDisconnect() {
    setBusy(true)
    try {
      await disconnectDrive()
      startTransition(() => router.refresh())
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center gap-3.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand dark:bg-brand-softdark">
          <DriveIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-stone-700 dark:text-stone-200">Google Drive</p>
            <InfoTooltip label="Respaldo en Google Drive">
              Conecta tu Google Drive para respaldar tus sesiones (análisis, transcripción y
              audio) en una carpeta «TagMeetings». La app solo puede ver y crear los
              archivos que ella misma genera — nunca el resto de tu Drive.
            </InfoTooltip>
          </div>
          <p className="truncate text-xs text-stone-500 dark:text-stone-400">
            {connected ? (email ? `Conectado como ${email}` : 'Conectado') : 'Sin conectar'}
          </p>
        </div>
        {!connected && (
          <a
            href="/api/drive/connect"
            className="tap-scale shrink-0 rounded-full bg-brand px-3.5 py-1.5 text-xs font-bold text-white transition hover:bg-brand-strong"
          >
            Conectar
          </a>
        )}
      </div>

      {/* Acciones cuando ya está conectado: cambiar de cuenta o desconectar. */}
      {connected && (
        <div className="mt-3 flex gap-2 border-t border-stone-100 pt-3 dark:border-stone-800">
          <a
            href="/api/drive/connect"
            className="tap-scale flex-1 rounded-full border border-stone-200 py-1.5 text-center text-xs font-semibold text-stone-600 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            Cambiar cuenta
          </a>
          <button
            type="button"
            onClick={handleDisconnect}
            disabled={busy}
            className="tap-scale flex-1 rounded-full border border-stone-200 py-1.5 text-center text-xs font-semibold text-stone-600 transition hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            {busy ? 'Desconectando…' : 'Desconectar'}
          </button>
        </div>
      )}
    </section>
  )
}
