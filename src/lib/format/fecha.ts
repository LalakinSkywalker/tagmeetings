// Formateo de fechas con zona horaria de México FIJA.
//
// Por qué la zona fija: sin `timeZone`, `toLocaleString` usa la zona del entorno
// que ejecuta el código. En SSR eso es el servidor (UTC en Vercel); en el
// navegador es la del usuario (México, UTC-6). El texto sale distinto en cada
// lado → React lanza el error de hidratación #418 ("Text content did not match")
// y, además, el servidor mostraría horas en UTC. Fijar la zona hace el formato
// determinista e idéntico en servidor y navegador, y siempre correcto para México.
const TZ = 'America/Mexico_City'

/** Fecha + hora: "15 jun, 14:30" */
export function formatFechaHora(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value
  return d.toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  })
}

/** Fecha corta: "15 jun 2026" */
export function formatFecha(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value
  return d.toLocaleDateString('es-MX', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: TZ,
  })
}
