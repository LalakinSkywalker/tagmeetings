'use client'

// =============================================================================
// PRP-TT-V2 Fase 6 — Menú de acciones del detalle (kebab ⋮)
// =============================================================================
// Un solo botón de tres puntos en el header agrupa las acciones de la sesión:
// Editar (renombrar), Descargar / Compartir, y Archivar en Drive. Unifica lo
// que antes eran botones sueltos con estilos distintos + una tarjeta grande.
// Íconos uniformes (mismo peso y color). Cierra al tocar fuera o con Escape.
// Cada acción abre su propia hoja/diálogo (control y transparencia).
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RenameDialog } from './rename-title'
import { DescargarSheet } from './descargar-sheet'
import { ArchivarSheet } from './archivar-sheet'
import { EliminarDialog } from './eliminar-dialog'
import { borrarTranscripcion } from '@/actions/transcripciones'

interface Props {
  transcripcionId: string
  titulo: string
  hayAnalisis: boolean
  audioDisponible: boolean
  /** Extensión real del audio (de audio_path), para el nombre de preview. */
  audioExt: string
  /** ¿Esta sesión ya se puede descargar/archivar? (false mientras procesa). */
  listo: boolean
  driveConnected: boolean
  /** Correo de la cuenta de Drive conectada (null si no se pudo resolver). */
  driveEmail: string | null
  /** Nombre del proyecto contenedor, o null si es una sesión suelta. */
  carpetaProyecto: string | null
  archivadoEn: string | null
  driveFolderId: string | null
}

function KebabIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  )
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M4 20h4l10-10a2.83 2.83 0 0 0-4-4L4 16v4Z" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" />
      <path d="m13.5 6.5 4 4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  )
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DriveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M8 4h8l5 9-4 7H7l-4-7L8 4Z" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" />
      <path d="M8 4l4 9h9M16 4l-7 16M3 13h13" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" />
    </svg>
  )
}

function FolderOpenIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1H7l-2 8M3 7v10l3-8" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  )
}

export function AccionesMenu({
  transcripcionId,
  titulo,
  hayAnalisis,
  audioDisponible,
  audioExt,
  listo,
  driveConnected,
  driveEmail,
  carpetaProyecto,
  archivadoEn,
  driveFolderId,
}: Props) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [descargarOpen, setDescargarOpen] = useState(false)
  const [archivarOpen, setArchivarOpen] = useState(false)
  const [eliminarOpen, setEliminarOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const archivado = Boolean(archivadoEn)

  // Cierra el menú al tocar fuera o con Escape.
  useEffect(() => {
    if (!menuOpen) return
    function onDown(e: MouseEvent | TouchEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  function abrir(setter: (v: boolean) => void) {
    setMenuOpen(false)
    setter(true)
  }

  function handleArchivar() {
    setMenuOpen(false)
    if (!driveConnected) {
      router.push('/dashboard/ajustes')
      return
    }
    setArchivarOpen(true)
  }

  const itemClass =
    'tap-scale flex w-full items-center gap-3 px-4 py-3 text-left text-base text-stone-700 transition hover:bg-stone-50 disabled:opacity-50 dark:text-stone-200 dark:hover:bg-stone-800'
  const iconClass = 'size-5 shrink-0 text-stone-500 dark:text-stone-400'

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Más acciones"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        className="tap-scale inline-flex size-9 items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
      >
        <KebabIcon className="size-5" />
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="animate-fade-in-up absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-2xl border border-stone-200 bg-white py-1 shadow-xl dark:border-stone-700 dark:bg-stone-900"
        >
          <button type="button" role="menuitem" onClick={() => abrir(setRenameOpen)} className={itemClass}>
            <PencilIcon className={iconClass} />
            Editar nombre
          </button>

          {listo && (
            <button type="button" role="menuitem" onClick={() => abrir(setDescargarOpen)} className={itemClass}>
              <DownloadIcon className={iconClass} />
              Descargar o compartir
            </button>
          )}

          {listo && (
            <button type="button" role="menuitem" onClick={handleArchivar} className={itemClass}>
              <DriveIcon className={iconClass} />
              {archivado ? 'Actualizar en Drive' : 'Archivar en Drive'}
            </button>
          )}

          {listo && archivado && driveFolderId && (
            <a
              href={`https://drive.google.com/drive/folders/${driveFolderId}`}
              target="_blank"
              rel="noopener noreferrer"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              className={itemClass}
            >
              <FolderOpenIcon className={iconClass} />
              Ver carpeta en Drive
            </a>
          )}

          <div className="my-1 h-px bg-stone-100 dark:bg-stone-800" role="separator" />

          <button
            type="button"
            role="menuitem"
            onClick={() => abrir(setEliminarOpen)}
            className="tap-scale flex w-full items-center gap-3 px-4 py-3 text-left text-base text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <TrashIcon className="size-5 shrink-0" />
            Eliminar
          </button>
        </div>
      )}

      <RenameDialog
        transcripcionId={transcripcionId}
        tituloActual={titulo}
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
      />
      <DescargarSheet
        transcripcionId={transcripcionId}
        titulo={titulo}
        hayAnalisis={hayAnalisis}
        audioDisponible={audioDisponible}
        open={descargarOpen}
        onClose={() => setDescargarOpen(false)}
      />
      <ArchivarSheet
        transcripcionId={transcripcionId}
        titulo={titulo}
        hayAnalisis={hayAnalisis}
        audioDisponible={audioDisponible}
        audioExt={audioExt}
        email={driveEmail}
        carpetaProyecto={carpetaProyecto}
        archivadoEn={archivadoEn}
        driveFolderId={driveFolderId}
        open={archivarOpen}
        onClose={() => setArchivarOpen(false)}
      />
      <EliminarDialog
        open={eliminarOpen}
        onClose={() => setEliminarOpen(false)}
        count={1}
        titulo={titulo}
        onConfirm={() => borrarTranscripcion(transcripcionId)}
        onDeleted={() => {
          setEliminarOpen(false)
          router.push('/dashboard')
          router.refresh()
        }}
      />
    </div>
  )
}
