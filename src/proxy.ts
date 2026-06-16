import type { NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/proxy'

// Convención de Next.js 16: el antiguo `middleware` se renombró a `proxy`.
// Este archivo es el punto de entrada que Next ejecuta antes de renderizar; la
// lógica de sesión vive en `src/lib/supabase/proxy.ts` (updateSession).
//
// Propósito:
//  - Refresca el token de Supabase UNA vez por request (renueva cookies antes de
//    que expiren → la sesión no se cae sola a la hora). Antes este código estaba
//    desconectado (no existía el archivo de convención) y no se ejecutaba.
//  - Protege /dashboard de forma centralizada y manda al login si no hay sesión.
// Con el refresco aquí, las páginas validan localmente con getClaims (sin red).
export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  // Corre en todas las rutas EXCEPTO assets estáticos, imágenes, el service
  // worker y el manifest (no necesitan sesión y deben servirse directo).
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf)$).*)',
  ],
}
