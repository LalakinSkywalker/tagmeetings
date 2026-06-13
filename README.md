# TagMeetings

**Transcribe tus reuniones, analízalas con IA y pregúntale a cada conversación** — con citas al minuto exacto. Versión **self-host con tus propias llaves** (BYOK): tú eres el dueño de tus datos y tus costos.

> Hecho por [Bluntag AI Studio](https://bluntagaistudio.com) y compartido con la comunidad. Instálalo en tu nube, con tus cuentas. Nada se queda en servidores ajenos.

---

## Qué hace

- 🎙️ **Transcribe** audio y video (reuniones, llamadas, notas de voz) con separación de hablantes.
- 🧠 **Analiza** cada sesión con IA: resúmenes, puntos clave, pendientes — con plantillas que tú defines.
- 💬 **Chat con citas**: pregúntale a una sesión o a un proyecto entero y te responde citando el minuto exacto.
- 📁 **Proyectos con memoria viva**: agrupa sesiones del mismo cliente o tema y conserva el contexto en el tiempo.
- 🌐 **Multi-idioma**: detecta el idioma y traduce al español cuando hace falta.
- 📲 **PWA instalable** con notificaciones opcionales.

---

## Instalación

La forma más fácil es el instalador asistido:

```bash
git clone <URL-del-repositorio>
cd tagmeetings
npm install
node setup.mjs
```

El instalador genera tus llaves de seguridad, te pide las de los servicios (con sus links) y arma tu configuración. Después montas la base de datos pegando un archivo SQL en tu Supabase. **Guía completa paso a paso en [SETUP.md](./SETUP.md)** — incluye un texto listo para que tu asistente Claude haga la instalación contigo si no eres técnico.

## Desplegar en Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=URL-DE-TU-REPOSITORIO)

> Reemplaza `URL-DE-TU-REPOSITORIO` por la dirección de tu copia del repo. Recuerda cargar las variables de entorno (las de tu `.env.local`) en Vercel y configurar las URLs de Supabase y el CORS de R2 con tu dominio. Detalles en [SETUP.md](./SETUP.md#llevarlo-a-producción-vercel).

---

## Servicios que usa

**Obligatorios (4):** Supabase (base de datos + login), Deepgram (transcripción), OpenRouter (IA), Cloudflare R2 (almacén de audios, hasta 2 GB por archivo).
**Opcionales (3):** OpenAI (embeddings propios), Google Drive (respaldo de audios), notificaciones push.

El plan gratuito de cada servicio alcanza para empezar.

---

## Stack

Next.js 16 (App Router, React 19) · TypeScript · Supabase (Postgres + pgvector + RLS) · Cloudflare R2 · Deepgram · OpenRouter · Tailwind CSS · PWA.

## Licencia

MIT. Úsalo, modifícalo y compártelo. Si te sirve, una mención a Bluntag AI Studio se agradece.
