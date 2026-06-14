'use client'

// =============================================================================
// Hook de suscripcion a notificaciones push.
// =============================================================================
// Expone el estado (soportado / permiso / suscrito) y dos acciones (subscribe /
// unsubscribe). La VAPID public key viene de NEXT_PUBLIC_VAPID_PUBLIC_KEY y se
// convierte a Uint8Array (el formato que pide pushManager.subscribe). El registro
// en servidor va contra /api/notifications/subscribe (que saca el user de la
// sesion). En iOS, push SOLO funciona con la PWA instalada (standalone).
// =============================================================================

import { useCallback, useEffect, useState } from 'react'

type Permission = NotificationPermission | 'unsupported'

interface UsePushSubscriptionReturn {
  isSupported: boolean
  permission: Permission
  isSubscribed: boolean
  loading: boolean
  subscribe: () => Promise<boolean>
  unsubscribe: () => Promise<void>
}

/** Convierte la VAPID public key (base64url) al Uint8Array que pide el browser. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  // Construir sobre un ArrayBuffer explicito (no SharedArrayBuffer) para que el
  // tipo encaje con BufferSource que pide pushManager.subscribe en TS reciente.
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Nombre legible del navegador/dispositivo para distinguir suscripciones. */
function describeDevice(): { deviceName: string; browser: string } {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  let browser = 'Navegador'
  if (/edg/i.test(ua)) browser = 'Edge'
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome'
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox'
  else if (/safari/i.test(ua)) browser = 'Safari'

  let os = ''
  if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS'
  else if (/android/i.test(ua)) os = 'Android'
  else if (/windows/i.test(ua)) os = 'Windows'
  else if (/mac/i.test(ua)) os = 'Mac'

  return { deviceName: os ? `${browser} en ${os}` : browser, browser }
}

export function usePushSubscription(): UsePushSubscriptionReturn {
  const [isSupported, setIsSupported] = useState(false)
  const [permission, setPermission] = useState<Permission>('unsupported')
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supported =
      typeof window !== 'undefined' &&
      'Notification' in window &&
      'serviceWorker' in navigator &&
      'PushManager' in window

    setIsSupported(supported)
    if (!supported) {
      setLoading(false)
      return
    }

    setPermission(Notification.permission)
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setIsSubscribed(!!sub))
      .catch(() => setIsSubscribed(false))
      .finally(() => setLoading(false))
  }, [])

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!isSupported) return false
    setLoading(true)
    try {
      const result = await Notification.requestPermission()
      setPermission(result)
      if (result !== 'granted') return false

      const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      if (!vapid) {
        console.error('[Push] Falta NEXT_PUBLIC_VAPID_PUBLIC_KEY')
        return false
      }

      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      })

      const res = await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), deviceInfo: describeDevice() }),
      })
      if (!res.ok) {
        // No dejar una suscripcion fantasma en el browser si el server la rechazo.
        await sub.unsubscribe().catch(() => {})
        return false
      }

      setIsSubscribed(true)
      return true
    } catch (err) {
      console.error('[Push] subscribe fallo:', err)
      return false
    } finally {
      setLoading(false)
    }
  }, [isSupported])

  const unsubscribe = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await fetch('/api/notifications/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {})
        await sub.unsubscribe()
      }
      setIsSubscribed(false)
    } catch (err) {
      console.error('[Push] unsubscribe fallo:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  return { isSupported, permission, isSubscribed, loading, subscribe, unsubscribe }
}
