import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

// La app vieja Whisper-stateless vivia aqui. En Fase 6 PRP-TT-001 se elimino
// junto con el flow ffmpeg.wasm + Whisper API + /api/transcribe + /api/translate.
// La ruta raiz ahora es una landing minimal de redirect: usuarios autenticados
// van directo al dashboard, no autenticados al login.
export default async function RootPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  redirect(user ? '/dashboard/capturar' : '/login')
}
