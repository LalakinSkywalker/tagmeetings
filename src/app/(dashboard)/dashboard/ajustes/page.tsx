import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { signout } from '@/actions/auth'
import { getStorageUsage } from '@/actions/settings'
import { resolveUserSettings } from '@/lib/settings'
import { isDriveConfigured } from '@/lib/drive/oauth'
import { buildTemplateSelectorData } from '@/lib/transcription/template-options'
import { getStorageAdapter } from '@/lib/transcription'
import { AppHeader } from '@/components/shell/app-header'
import { ThemeToggle } from '@/components/theme/theme-toggle'
import { DriveConnect } from '@/components/transcriptor/drive-connect'
import { AjustesTranscripcion } from '@/components/ajustes/ajustes-transcripcion'
import { AjustesMarca } from '@/components/ajustes/ajustes-marca'
import { AjustesNotificaciones } from '@/components/ajustes/ajustes-notificaciones'
import { AjustesAlmacenamiento } from '@/components/ajustes/ajustes-almacenamiento'

export const dynamic = 'force-dynamic'

const DRIVE_MSG: Record<string, { ok: boolean; text: string }> = {
  ok: { ok: true, text: 'Google Drive conectado. Ya puedes archivar tus sesiones.' },
  cancel: { ok: false, text: 'Conexión con Google cancelada.' },
  error: { ok: false, text: 'No se pudo conectar con Google. Intenta de nuevo.' },
  noconfig: { ok: false, text: 'Google Drive aún no está configurado en este entorno.' },
}

export default async function AjustesPage({
  searchParams,
}: {
  searchParams: Promise<{ drive?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, full_name, avatar_url')
    .eq('id', user.id)
    .single()

  const { data: driveConn } = await supabase
    .from('drive_connections')
    .select('user_id, connected_email')
    .eq('user_id', user.id)
    .maybeSingle()
  const driveConnected = Boolean(driveConn)
  const driveEmail = (driveConn?.connected_email as string | null) ?? null
  // Drive es opcional (BYOK): si la instalacion no tiene credenciales de Google,
  // no se muestran ni la tarjeta de conexion ni la opcion de respaldo a Drive.
  const driveConfigured = isDriveConfigured()
  const driveMsg = DRIVE_MSG[(await searchParams).drive ?? '']

  const settings = await resolveUserSettings(supabase, user.id)
  const { templates } = await buildTemplateSelectorData()
  const storageUsage = await getStorageUsage()

  // Preview del logo (R2 privado): signed URL on-demand. Best-effort.
  let logoUrl: string | null = null
  if (settings.brandLogoPath) {
    try {
      const r = await getStorageAdapter().getSignedDownloadUrl(settings.brandLogoPath, {
        expiresInSec: 600,
      })
      logoUrl = r
    } catch {
      logoUrl = null
    }
  }

  const nombre = profile?.full_name ?? user.email ?? 'Usuario'
  const inicial = nombre.charAt(0).toUpperCase()

  return (
    <>
      <AppHeader title="Ajustes">
        <ThemeToggle />
      </AppHeader>

      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        {/* Resultado del OAuth de Drive (PRP-TT-V2 Fase 6C) */}
        {driveMsg && (
          <div
            className={`rounded-2xl border px-4 py-3 text-sm ${
              driveMsg.ok
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100'
                : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100'
            }`}
          >
            {driveMsg.text}
          </div>
        )}

        {/* Perfil */}
        <section className="flex items-center gap-3.5 rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand text-lg font-bold text-white">
            {inicial}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-stone-900 dark:text-stone-100">
              {profile?.full_name ?? 'Mi cuenta'}
            </p>
            <p className="truncate text-xs text-stone-500 dark:text-stone-400">
              {user.email}
            </p>
          </div>
        </section>

        {/* Transcripción por defecto (Fase 7) */}
        <AjustesTranscripcion
          initial={{
            idiomaDefault: settings.idiomaDefault,
            traducirA: settings.traducirA,
            modoAnalisisDefault: settings.modoAnalisisDefault,
            templateIdDefault: settings.templateIdDefault,
          }}
          templates={templates}
        />

        {/* Mi marca (Fase 7): perfil + logo + color del branding de exports */}
        <AjustesMarca
          initialFullName={profile?.full_name ?? ''}
          initialColor={settings.brandColorPrimario}
          initialLogoUrl={logoUrl}
        />

        {/* Notificaciones push (Fase 9) */}
        <AjustesNotificaciones />

        {/* Google Drive (Fase 6C) — solo si la instalacion lo tiene configurado */}
        {driveConfigured && <DriveConnect connected={driveConnected} email={driveEmail} />}

        {/* Almacenamiento (Bloque Almacenamiento): ciclo de vida del audio */}
        <AjustesAlmacenamiento
          initial={{
            retencionAudioDias: settings.retencionAudioDias,
            respaldoModo: settings.respaldoModo,
            avisoExpiracionActivo: settings.avisoExpiracionActivo,
            avisoExpiracionDias: settings.avisoExpiracionDias,
          }}
          usage={storageUsage}
          driveConnected={driveConnected}
          driveConfigured={driveConfigured}
        />

        {/* Mis plantillas (Fase 3) */}
        <Link
          href="/dashboard/plantillas"
          className="tap-scale flex items-center gap-3.5 rounded-2xl border border-stone-200/80 bg-white px-4 py-3.5 shadow-sm transition hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:hover:bg-stone-800"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand dark:bg-brand-softdark">
            <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
              <path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" />
              <path d="M13 4v5h5M8 13h8M8 16h5" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-stone-700 dark:text-stone-200">Mis plantillas</p>
            <p className="truncate text-xs text-stone-500 dark:text-stone-400">
              Crea y edita plantillas de análisis con IA
            </p>
          </div>
          <svg viewBox="0 0 24 24" fill="none" className="size-4 shrink-0 text-stone-400" aria-hidden="true">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>

        {/* Salir */}
        <form action={signout}>
          <button
            type="submit"
            className="tap-scale w-full rounded-2xl border border-stone-200 bg-white py-3.5 text-sm font-semibold text-red-600 shadow-sm transition hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:text-red-400 dark:hover:bg-stone-800"
          >
            Cerrar sesión
          </button>
        </form>
      </main>
    </>
  )
}
