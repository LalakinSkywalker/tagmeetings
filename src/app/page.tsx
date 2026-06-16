import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

// La app vieja Whisper-stateless vivia aqui. En Fase 6 se elimino
// junto con el flow ffmpeg.wasm + Whisper API + /api/transcribe + /api/translate.
// La ruta raiz ahora es una landing minimal de redirect: usuarios autenticados
// van directo al dashboard, no autenticados al login.
export default async function RootPage() {
  const supabase = await createClient()
  // getClaims valida el JWT localmente (sin round-trip) — basta para decidir
  // el redirect. El proxy ya refrescó la sesión antes de llegar aquí.
  const { data: jwt } = await supabase.auth.getClaims()
  redirect(jwt?.claims?.sub ? '/dashboard/capturar' : '/login')
}
