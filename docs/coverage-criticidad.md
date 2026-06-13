# Coverage de criticidad — TagTranscriptor

> Matriz oficial. **Regla maestra #6 (2026-05-08): coverage 80% en CRITICO, opcional en COSMETICO.**

TagTranscriptor es Next.js minimal (`src/app/api` + `src/lib`). Probablemente herramienta de transcripcion via API. La matriz se completa al primer PRP nuevo que aclare alcance.

---

## Modulos CRITICOS (inferidos)

| Modulo / Path | Por que es CRITICO |
|---|---|
| `src/app/api/**` | API routes (transcripcion). Bug = transcripcion mal o no entregada. |
| `src/lib/**` | Helpers core (clientes a Whisper / Groq / OpenAI). |
| `supabase/migrations/**` (si aplica) | Schema + RLS. |

## COSMETICOS

`src/app/page.tsx`, `src/app/layout.tsx`, components UI.

---

## Politicas

- Aplica a PRPs nuevos desde 2026-05-08. PRPs heredados NO migran.
- Si el proyecto solo es UI minimal (transcribe + descarga), tests E2E basicos cubren el flujo. La criticidad alta aplica solo en logica de transcripcion + API a proveedores externos.
