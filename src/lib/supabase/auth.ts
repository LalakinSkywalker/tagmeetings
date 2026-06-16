import 'server-only'
import { redirect } from 'next/navigation'
import { createClient } from './server'

// Validación de sesión para PÁGINAS de render (lectura), sin ida y vuelta a la red.
//
// getClaims() verifica la firma del JWT LOCALMENTE con la clave pública asimétrica
// del proyecto (ES256) — no consulta al Auth server en cada navegación, a diferencia
// de getUser(). Eso quita un round-trip por pantalla y baja el tiempo de respuesta.
// El refresco del token lo hace el proxy (src/proxy.ts) una vez por request, así que
// cuando la página valida, el JWT ya está fresco.
//
// Las SERVER ACTIONS de escritura siguen usando getUser() (consulta directa al Auth
// server) como defensa en profundidad — ahí la seguridad pesa más que el milisegundo.

/** Devuelve el id del usuario validando el JWT localmente, o redirige a /login. */
export async function requireUserId(): Promise<string> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()
  const userId = data?.claims?.sub
  if (!userId) redirect('/login')
  return userId
}

/** Igual que requireUserId pero sin redirigir: devuelve null si no hay sesión válida. */
export async function getUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()
  return data?.claims?.sub ?? null
}
