import { BottomNav } from '@/components/shell/bottom-nav'

/**
 * Shell de la app autenticada (estilo nativo).
 * Provee el menu inferior fijo y el espacio inferior para que el contenido
 * no quede tapado por el. Cada pagina renderiza su propio AppHeader.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-dvh bg-stone-50 dark:bg-stone-950">
      <div className="pb-safe-nav">{children}</div>
      <BottomNav />
    </div>
  )
}
