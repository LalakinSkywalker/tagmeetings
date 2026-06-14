'use client'

// =============================================================================
// AjustesNotificaciones — activar/desactivar push + prueba
// =============================================================================
// Activa las notificaciones push de este dispositivo (pide permiso + suscribe) y
// permite enviar una notificacion de prueba para confirmar de punta a punta. El
// unico aviso real hoy es "tu transcripcion ya esta lista" (lo dispara el pipeline
// al terminar). Patron mobile-native: label + ⓘ + control, tap-scale, sin parrafos
// grises (la explicacion vive en el globo). Los mensajes de "no soportado" /
// "bloqueado" son estados, la unica excepcion legitima a la regla de oro.
// =============================================================================

import { useState, useTransition } from 'react'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { usePushSubscription } from '@/hooks/usePushSubscription'
import { enviarPushDePrueba } from '@/actions/notifications'

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; msg: string }
  | { kind: 'error'; msg: string }

export function AjustesNotificaciones() {
  const { isSupported, permission, isSubscribed, loading, subscribe, unsubscribe } =
    usePushSubscription()
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [, startTransition] = useTransition()

  const onActivar = async () => {
    setStatus({ kind: 'working' })
    const ok = await subscribe()
    setStatus(
      ok
        ? { kind: 'done', msg: 'Activadas ✓' }
        : { kind: 'error', msg: 'No se pudo activar. Revisa el permiso del navegador.' },
    )
  }

  const onDesactivar = async () => {
    setStatus({ kind: 'working' })
    await unsubscribe()
    setStatus({ kind: 'idle' })
  }

  const onProbar = () => {
    setStatus({ kind: 'working' })
    startTransition(async () => {
      const res = await enviarPushDePrueba()
      setStatus(
        res.ok
          ? { kind: 'done', msg: 'Enviada ✓ Revisa tu dispositivo.' }
          : { kind: 'error', msg: res.message ?? 'No se pudo enviar.' },
      )
    })
  }

  return (
    <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
            Notificaciones
          </h3>
          <InfoTooltip label="Qué avisos recibo">
            Te avisamos en tu celular cuando una transcripción termina de procesarse,
            aunque no tengas la app abierta. En iPhone, primero instala la app en tu
            pantalla de inicio (Compartir → Agregar a inicio).
          </InfoTooltip>
        </div>
        <StatusPill status={status} />
      </div>

      {loading ? (
        <p className="text-sm text-stone-400 dark:text-stone-500">Comprobando…</p>
      ) : !isSupported ? (
        <p className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300">
          Este dispositivo no soporta notificaciones push. En iPhone, instala la app en
          tu pantalla de inicio para activarlas.
        </p>
      ) : permission === 'denied' ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Las notificaciones están bloqueadas. Actívalas desde los ajustes del navegador
          para este sitio y vuelve a intentar.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-base font-medium text-stone-700 dark:text-stone-200">
                Avisar cuando esté lista
              </span>
              <InfoTooltip label="Cómo funciona">
                Cuando una transcripción termina de procesarse en segundo plano, recibes
                una notificación con un toque para abrirla directo.
              </InfoTooltip>
            </div>
            {isSubscribed ? (
              <button
                type="button"
                onClick={onDesactivar}
                className="tap-scale shrink-0 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm font-semibold text-stone-700 shadow-sm transition hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
              >
                Desactivar
              </button>
            ) : (
              <button
                type="button"
                onClick={onActivar}
                className="tap-scale shrink-0 rounded-xl bg-brand px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-strong"
              >
                Activar
              </button>
            )}
          </div>

          {isSubscribed && (
            <button
              type="button"
              onClick={onProbar}
              className="tap-scale w-full rounded-xl border border-stone-200 bg-white py-2.5 text-sm font-semibold text-stone-700 shadow-sm transition hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              Enviar notificación de prueba
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function StatusPill({ status }: { status: Status }) {
  if (status.kind === 'idle') return null
  if (status.kind === 'working')
    return <span className="text-xs font-medium text-stone-400">Trabajando…</span>
  if (status.kind === 'done')
    return <span className="text-xs font-medium text-green-600 dark:text-green-400">{status.msg}</span>
  return <span className="text-xs font-medium text-red-600 dark:text-red-400">{status.msg}</span>
}
