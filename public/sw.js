// Service Worker — TagMeetings PWA
// v5 (Fase 9 2026-06-08): + notificaciones push (handlers push /
// notificationclick / pushsubscriptionchange). Bump de version para invalidar
// el precache viejo y activar el SW nuevo con soporte push.
// Estrategia: network first con fallback a cache. App SPA pero rutas dinamicas
// (dashboard, transcripcion, server actions) requieren red — no cachear pages.
// Cache solo shell estatico (manifest + iconos). Esto evita servir contenido
// stale tras login/logout/upload.

const CACHE_NAME = 'tag-transcriptor-v7'
const PRECACHE_URLS = [
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png',
  '/icon-512-maskable.png',
  '/badge-96.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  // NO interceptar requests no-GET (server actions de Next.js usan POST)
  if (event.request.method !== 'GET') return

  // NO interceptar Next.js internals + API routes — siempre red
  const url = new URL(event.request.url)
  if (
    url.pathname.startsWith('/_next/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/')
  ) {
    return
  }

  // Para el resto: network first, fallback cache solo si red falla
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request)),
  )
})

// ===========================================================================
// Notificaciones push (Fase 9)
// ===========================================================================

// Push: el servidor (web-push) manda el payload; mostramos la notificacion.
self.addEventListener('push', (event) => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch {
    payload = { title: 'TagMeetings', body: event.data.text() }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'TagMeetings', {
      body: payload.body || '',
      icon: payload.icon || '/icon-192.png',
      badge: payload.badge || '/badge-96.png',
      data: payload.data || {},
      tag: payload.tag,
      requireInteraction: payload.requireInteraction || false,
    }),
  )
})

// Click: enfocar una pestania abierta o abrir la URL de la notificacion.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/dashboard'

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ('focus' in client) {
            client.focus()
            if ('navigate' in client) client.navigate(url)
            return
          }
        }
        return self.clients.openWindow(url)
      }),
  )
})

// El browser puede invalidar la suscripcion; re-suscribir y re-registrar.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager
      .subscribe(
        event.oldSubscription?.options || {
          userVisibleOnly: true,
          applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
        },
      )
      .then((newSub) =>
        fetch('/api/notifications/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscription: newSub.toJSON(),
            oldEndpoint: event.oldSubscription?.endpoint,
          }),
        }),
      ),
  )
})
