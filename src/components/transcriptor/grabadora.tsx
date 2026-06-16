'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  createTranscripcionDraft,
  iniciarTranscripcion,
} from '@/actions/transcripciones'
import {
  OpcionesCaptura,
  parseRoster,
  type TemplateOption,
  type TemplateGrupo,
  type CapturaDefaults,
} from './opciones-captura'
import { type ModoAnalisis } from '@/lib/transcription/modo-analisis'
import { formatFechaHora } from '@/lib/format/fecha'

interface Props {
  templates: TemplateOption[]
  grupos: TemplateGrupo[]
  /** Defaults del usuario: inicializan los selects; override por sesión. */
  defaults: CapturaDefaults
}

type Phase =
  | 'idle' // todavia no se ha pedido permiso
  | 'requesting' // pidiendo permiso del microfono
  | 'ready' // permiso concedido, listo para grabar
  | 'recording'
  | 'paused'
  | 'stopped' // grabacion terminada, blob listo, mostrar boton "subir"
  | 'uploading'
  | 'transcribing'
  | 'done'
  | 'error'

// Cap de seguridad para grabaciones extra largas. Reuniones presenciales
// y videoconferencias multi-sesion pueden durar 5-6h reales (caso documentado
// 2026-05-28). 8h da margen para "reuniones maraton" sin truncar.
const MAX_DURATION_SEC = 8 * 60 * 60

/**
 * Detecta el mejor MIME type soportado por el browser para audio.
 * iOS Safari moderno soporta audio/webm desde 14.5+. Fallback a audio/mp4.
 */
function pickAudioMime(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm'
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return 'audio/webm'
}

function mimeToExt(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('mp4')) return 'm4a'
  if (mime.includes('ogg')) return 'ogg'
  return 'bin'
}

function formatHMS(totalSec: number): string {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function defaultTitle(): string {
  return `Grabación ${formatFechaHora(new Date())}`
}

export function Grabadora({ templates, grupos, defaults }: Props) {
  const router = useRouter()
  const [templateId, setTemplateId] = useState<string>(defaults.templateId ?? templates[0]?.id ?? '')
  const [idioma, setIdioma] = useState<string>(defaults.idioma)
  const [traducir, setTraducir] = useState<string | null>(defaults.traducirA)
  const [numSpeakers, setNumSpeakers] = useState<string>('')
  const [roster, setRoster] = useState<string>('')
  const [modo, setModo] = useState<ModoAnalisis>(defaults.modo)
  const [titulo, setTitulo] = useState<string>('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null)
  const [audioMime, setAudioMime] = useState<string>('')

  // Refs (no rerender por update)
  const streamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef<number>(0)
  const pausedAccumSecRef = useRef<number>(0)
  const pausedAtRef = useRef<number>(0)
  // Wake Lock para grabaciones largas (5-6h). Chrome/Edge/Safari 16.4+.
  // Si bloqueas pantalla mientras grabas, sin Wake Lock iOS suspende JS y
  // MediaRecorder se pausa silenciosamente — perdes la grabacion. Con Wake Lock
  // la pantalla se mantiene encendida y la pestana sigue activa.
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  // Fallback iOS Safari (<16.4): audio HTMLAudioElement silent loop. Mantiene
  // el contexto activo via Media Session API + tab keep-alive (iOS no mata
  // tabs que estan reproduciendo audio).
  const silentAudioRef = useRef<HTMLAudioElement | null>(null)

  // ---- Cleanup global on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {})
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
      }
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {})
        wakeLockRef.current = null
      }
      if (silentAudioRef.current) {
        silentAudioRef.current.pause()
        silentAudioRef.current.src = ''
        silentAudioRef.current = null
      }
    }
  }, [])

  // ---- Wake Lock: adquirir + re-adquirir si la pagina vuelve a visible
  const acquireWakeLock = useCallback(async () => {
    if (typeof navigator === 'undefined') return
    if (!('wakeLock' in navigator)) {
      // Wake Lock no soportado: el fallback silent audio se encarga.
      return
    }
    try {
      const sentinel = await navigator.wakeLock.request('screen')
      wakeLockRef.current = sentinel
      sentinel.addEventListener('release', () => {
        // El sistema puede liberar el wake lock cuando la pagina va al
        // background. No tratamos esto como error — se re-adquiere en
        // visibilitychange.
      })
    } catch {
      // Algunas politicas (low power mode, permissions) rechazan. Silent
      // audio loop sigue siendo el safety net.
    }
  }, [])

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release()
      } catch {
        // ignore
      }
      wakeLockRef.current = null
    }
  }, [])

  // Re-adquirir wake lock cuando la pagina vuelve a visible (system release).
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'visible' && phase === 'recording') {
        void acquireWakeLock()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [phase, acquireWakeLock])

  // ---- Silent audio loop: fallback para iOS <16.4 sin Wake Lock + extra
  //      keep-alive incluso en navegadores con Wake Lock (defensa en
  //      profundidad para grabaciones de varias horas).
  const startSilentAudioLoop = useCallback(() => {
    if (silentAudioRef.current) return // ya activo
    if (typeof Audio === 'undefined') return
    // WAV header de 1 frame mudo en base64 (44 bytes header + 4 bytes data).
    // No hace ruido (volume=0 igual por seguridad). Loop permanente.
    const silentWav =
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='
    const audio = new Audio(silentWav)
    audio.loop = true
    audio.volume = 0.001 // casi 0 pero no exactamente 0 (iOS pausa volume=0)
    audio.muted = false // muted=true tambien hace que iOS pause
    audio.play().catch(() => {
      // Si el browser bloquea autoplay sin user gesture, no pasa nada — el
      // user ya hizo gesture al pulsar "Grabar", normalmente autoriza.
    })
    silentAudioRef.current = audio
  }, [])

  const stopSilentAudioLoop = useCallback(() => {
    if (silentAudioRef.current) {
      silentAudioRef.current.pause()
      silentAudioRef.current.src = ''
      silentAudioRef.current = null
    }
  }, [])

  // ---- Canvas waveform loop
  const drawWaveform = useCallback(() => {
    const analyser = analyserRef.current
    const canvas = canvasRef.current
    if (!analyser || !canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Adapt canvas size to displayed size (HiDPI)
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    if (
      canvas.width !== Math.round(rect.width * dpr) ||
      canvas.height !== Math.round(rect.height * dpr)
    ) {
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
    }
    const W = canvas.width
    const H = canvas.height

    const bufferLength = analyser.fftSize
    const dataArray = new Uint8Array(bufferLength)
    analyser.getByteTimeDomainData(dataArray)

    // Background — leer del computed body para light/dark
    const isDark = document.documentElement.classList.contains('dark')
    ctx.fillStyle = isDark ? '#1c1917' : '#faf9f7'
    ctx.fillRect(0, 0, W, H)

    // Linea de tiempo central
    ctx.strokeStyle = isDark ? '#44403c' : '#e7e5e4'
    ctx.lineWidth = 1 * dpr
    ctx.beginPath()
    ctx.moveTo(0, H / 2)
    ctx.lineTo(W, H / 2)
    ctx.stroke()

    // Waveform
    ctx.lineWidth = 2 * dpr
    ctx.strokeStyle = phase === 'recording' ? '#ff8133' : '#a8a29e'
    ctx.beginPath()
    const sliceWidth = W / bufferLength
    let x = 0
    for (let i = 0; i < bufferLength; i++) {
      const v = (dataArray[i] ?? 128) / 128.0
      const y = (v * H) / 2
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
      x += sliceWidth
    }
    ctx.lineTo(W, H / 2)
    ctx.stroke()

    animationFrameRef.current = requestAnimationFrame(drawWaveform)
  }, [phase])

  // ---- Timer tick
  const tickTimer = useCallback(() => {
    const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000) - pausedAccumSecRef.current
    setElapsedSec(elapsed)
    if (elapsed >= MAX_DURATION_SEC) {
      // Cap automatico
      stopRecording()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Pedir permiso + setup AudioContext + MediaRecorder
  const requestPermissionAndSetup = useCallback(async (): Promise<boolean> => {
    setErrorMsg('')
    setPhase('requesting')

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setPhase('error')
      setErrorMsg('Tu navegador no soporta grabación de audio (MediaDevices API).')
      return false
    }
    if (typeof MediaRecorder === 'undefined') {
      setPhase('error')
      setErrorMsg('Tu navegador no soporta MediaRecorder.')
      return false
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      streamRef.current = stream

      // AudioContext para waveform (requiere user gesture — el clic en "Iniciar" lo es)
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext
      const audioCtx = new AudioCtx()
      audioCtxRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)
      analyserRef.current = analyser

      // MediaRecorder
      const mime = pickAudioMime()
      setAudioMime(mime)
      const mr = new MediaRecorder(stream, { mimeType: mime })
      mediaRecorderRef.current = mr
      chunksRef.current = []

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      mr.onerror = (e) => {
        const err = e as unknown as { error?: Error }
        setPhase('error')
        setErrorMsg(
          `MediaRecorder error: ${err.error?.message ?? 'desconocido'}`,
        )
      }
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime })
        setAudioBlob(blob)
        chunksRef.current = []
      }

      setPhase('ready')
      return true
    } catch (err) {
      setPhase('error')
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Permission') || msg.includes('NotAllowed')) {
        setErrorMsg(
          'Permiso de micrófono denegado. Habilítalo en configuración del navegador y recarga.',
        )
      } else if (msg.includes('NotFound')) {
        setErrorMsg('No se detectó micrófono en este dispositivo.')
      } else {
        setErrorMsg(`Error al iniciar: ${msg}`)
      }
      return false
    }
  }, [])

  // ---- Iniciar grabacion (combina request si hace falta + start)
  const startRecording = useCallback(async () => {
    if (!templateId) {
      setErrorMsg('Selecciona una plantilla antes de grabar.')
      return
    }
    let ok = phase === 'ready'
    if (!ok) {
      ok = await requestPermissionAndSetup()
      if (!ok) return
    }

    const mr = mediaRecorderRef.current
    if (!mr) return

    chunksRef.current = []
    setAudioBlob(null)
    setElapsedSec(0)
    pausedAccumSecRef.current = 0
    startedAtRef.current = Date.now()

    try {
      mr.start(1000) // chunk cada 1s
    } catch (err) {
      setPhase('error')
      setErrorMsg(`No se pudo iniciar grabación: ${err instanceof Error ? err.message : err}`)
      return
    }

    setPhase('recording')

    // Timer
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(tickTimer, 250)

    // Waveform loop
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
    drawWaveform()

    // keep-alive defensa en profundidad para grabaciones largas.
    void acquireWakeLock()
    startSilentAudioLoop()
  }, [
    templateId,
    phase,
    requestPermissionAndSetup,
    tickTimer,
    drawWaveform,
    acquireWakeLock,
    startSilentAudioLoop,
  ])

  // ---- Pausar / reanudar
  const pauseRecording = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (!mr || mr.state !== 'recording') return
    mr.pause()
    pausedAtRef.current = Date.now()
    setPhase('paused')
    if (timerRef.current) clearInterval(timerRef.current)
    // Pausa = liberar wake lock para no gastar bateria, pero MANTENER el
    // silent audio loop (no queremos que iOS suspenda mientras el user
    // decide reanudar — la sesion sigue activa).
    void releaseWakeLock()
  }, [releaseWakeLock])

  const resumeRecording = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (!mr || mr.state !== 'paused') return
    const pauseDurationSec = Math.floor((Date.now() - pausedAtRef.current) / 1000)
    pausedAccumSecRef.current += pauseDurationSec
    mr.resume()
    setPhase('recording')
    timerRef.current = setInterval(tickTimer, 250)
    drawWaveform()
    void acquireWakeLock()
  }, [tickTimer, drawWaveform, acquireWakeLock])

  // ---- Detener (no sube todavia)
  function stopRecording() {
    const mr = mediaRecorderRef.current
    if (!mr || mr.state === 'inactive') return
    mr.stop()
    if (timerRef.current) clearInterval(timerRef.current)
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
    setPhase('stopped')
    // Liberar tracks del microfono
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
    }
    // Liberar keep-alive — ya no estamos grabando.
    void releaseWakeLock()
    stopSilentAudioLoop()
  }

  // ---- Descartar y volver a empezar
  const discardAndReset = useCallback(() => {
    setAudioBlob(null)
    setElapsedSec(0)
    pausedAccumSecRef.current = 0
    setPhase('idle')
    setErrorMsg('')
  }, [])

  // ---- Subir y procesar
  const uploadAndProcess = useCallback(async () => {
    if (!audioBlob || !audioMime) return
    if (!templateId) {
      setErrorMsg('Selecciona una plantilla.')
      return
    }

    setPhase('uploading')
    setErrorMsg('')

    try {
      const finalTitulo = titulo.trim() || defaultTitle()
      const ext = mimeToExt(audioMime)
      const filename = `grabacion-${Date.now()}.${ext}`

      const draft = await createTranscripcionDraft({
        titulo: finalTitulo,
        templateId,
        idioma,
        traducirA: traducir,
        participantesEsperados: parseRoster(roster),
        numSpeakersEsperados: numSpeakers ? Number(numSpeakers) : undefined,
        modoAnalisis: modo,
        audioFilename: filename,
        audioMime,
        audioSizeBytes: audioBlob.size,
      })

      // PUT directo a R2 via signed URL (bypasea el body limit de Vercel)
      const uploadRes = await fetch(draft.signedUrl, {
        method: 'PUT',
        body: audioBlob,
        headers: { 'Content-Type': audioMime },
      })
      if (!uploadRes.ok) {
        throw new Error(`Upload fallo: HTTP ${uploadRes.status} ${uploadRes.statusText}`)
      }

      setPhase('transcribing')

      const result = await iniciarTranscripcion(draft.transcripcionId)
      if (!result.ok) {
        setPhase('error')
        setErrorMsg(result.errorMessage ?? 'Error en transcripción.')
        return
      }

      setPhase('done')
      // Redirigir a la vista detalle de la transcripcion recien creada
      router.push(`/dashboard/transcripcion/${draft.transcripcionId}`)
    } catch (err) {
      setPhase('error')
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }, [audioBlob, audioMime, templateId, idioma, traducir, roster, numSpeakers, modo, titulo, router])

  const busy =
    phase === 'requesting' ||
    phase === 'uploading' ||
    phase === 'transcribing'

  const isRec = phase === 'recording'
  const isPaused = phase === 'paused'
  const isStopped = phase === 'stopped'

  return (
    <div className="space-y-5">
      {/* Titulo opcional — primero (lo primero al crear algo es nombrarlo). */}
      <div>
        <label
          htmlFor="grabadora-titulo"
          className="mb-1.5 block text-sm font-medium text-stone-700 dark:text-stone-200"
        >
          Título (opcional)
        </label>
        <input
          id="grabadora-titulo"
          type="text"
          value={titulo}
          onChange={(e) => setTitulo(e.target.value)}
          placeholder={defaultTitle()}
          disabled={busy}
          className="block w-full rounded-md border border-stone-300 bg-white px-3 py-2.5 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        />
      </div>

      {/* Opciones de captura: plantilla + idioma + modo + pre-registro participantes */}
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
        disabled={isRec || isPaused || busy}
        size="md"
      />

      {/* Waveform canvas */}
      <div className="rounded-lg border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900">
        <canvas
          ref={canvasRef}
          className="block h-32 w-full"
          aria-label="Visualizacion de audio en tiempo real"
        />
      </div>

      {/* Timer + estado */}
      <div className="text-center">
        <div className="font-mono text-5xl font-semibold tabular-nums text-stone-900 dark:text-stone-100">
          {formatHMS(elapsedSec)}
        </div>
        <p className="mt-1 text-xs uppercase tracking-wide text-stone-500 dark:text-stone-400">
          {phase === 'idle' && 'Listo para grabar'}
          {phase === 'requesting' && 'Pidiendo permiso de micrófono…'}
          {phase === 'ready' && 'Permiso concedido — presiona Grabar'}
          {phase === 'recording' && (
            <span className="text-red-600 dark:text-red-400">● Grabando</span>
          )}
          {phase === 'paused' && 'Pausado'}
          {phase === 'stopped' && 'Grabación lista — revisa y sube'}
          {phase === 'uploading' && 'Subiendo audio…'}
          {phase === 'transcribing' && 'Transcribiendo + analizando…'}
          {phase === 'done' && '✓ Procesado'}
          {phase === 'error' && (
            <span className="text-red-600 dark:text-red-400">Error</span>
          )}
        </p>
      </div>

      {/* Controles principales */}
      <div className="flex items-center justify-center gap-4">
        {(phase === 'idle' || phase === 'ready' || phase === 'error') && (
          <button
            type="button"
            onClick={startRecording}
            disabled={busy || !templateId}
            className="tap-scale inline-flex h-16 min-w-[160px] items-center justify-center gap-2 rounded-full bg-brand px-6 text-base font-semibold text-white shadow-lg hover:bg-brand-strong disabled:opacity-50"
            aria-label="Iniciar grabacion"
          >
            <svg className="size-5" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="8" />
            </svg>
            Grabar
          </button>
        )}

        {isRec && (
          <>
            <button
              type="button"
              onClick={pauseRecording}
              className="inline-flex size-14 items-center justify-center rounded-full border-2 border-stone-300 bg-white text-stone-700 shadow hover:bg-stone-50 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-200"
              aria-label="Pausar"
            >
              <svg className="size-6" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            </button>
            <button
              type="button"
              onClick={stopRecording}
              className="inline-flex h-16 min-w-[160px] items-center justify-center gap-2 rounded-full bg-stone-900 px-6 text-base font-semibold text-white shadow-lg hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
              aria-label="Detener grabacion"
            >
              <svg className="size-5" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
              Detener
            </button>
          </>
        )}

        {isPaused && (
          <>
            <button
              type="button"
              onClick={resumeRecording}
              className="tap-scale inline-flex size-14 items-center justify-center rounded-full bg-brand text-white shadow hover:bg-brand-strong"
              aria-label="Reanudar"
            >
              <svg className="size-6" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={stopRecording}
              className="inline-flex h-16 min-w-[160px] items-center justify-center gap-2 rounded-full bg-stone-900 px-6 text-base font-semibold text-white shadow-lg hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
            >
              Detener
            </button>
          </>
        )}

        {isStopped && (
          <>
            <button
              type="button"
              onClick={discardAndReset}
              className="tap-scale inline-flex h-12 items-center justify-center rounded-md border border-stone-300 px-4 text-sm font-medium text-stone-700 hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              Descartar
            </button>
            <button
              type="button"
              onClick={uploadAndProcess}
              disabled={!audioBlob || busy}
              className="tap-scale inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-brand px-5 text-sm font-semibold text-white shadow hover:bg-brand-strong disabled:opacity-50"
            >
              Subir y procesar
            </button>
          </>
        )}
      </div>

      {/* Mensaje de error / estado pendiente */}
      {errorMsg && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {errorMsg}
        </div>
      )}
      {phase === 'transcribing' && (
        <div className="rounded-md border border-brand/30 bg-brand-soft p-3 text-sm text-brand dark:border-brand/50 dark:bg-brand-softdark dark:text-brand">
          <p className="font-medium">Lanzando transcripción</p>
          <p className="mt-1 text-xs">
            En unos segundos te llevaremos a la vista detalle donde verás el
            progreso en vivo. El procesamiento ocurre en el servidor — puedes
            cerrar la pestaña sin perder la transcripción.
          </p>
        </div>
      )}

    </div>
  )
}
