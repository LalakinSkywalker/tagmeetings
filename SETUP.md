# Instalar TagMeetings (con tus propias llaves)

TagMeetings es una app que **transcribe tus reuniones, las analiza con IA y te deja preguntarle a cada conversación** (con citas al minuto exacto). Esta es la versión **self-host con tus propias llaves** (BYOK, *Bring Your Own Keys*): la instalas en tu propia nube, con tus propias cuentas. Tú eres el dueño de todo — tus datos y tus costos viven en tu infraestructura, no en la de nadie más.

> **¿No eres técnico?** Salta a la sección [«Pégaselo a tu Claude»](#pégaselo-a-tu-claude) más abajo. Le das un texto a tu asistente (Claude Code) y él hace la instalación contigo, paso a paso.

---

## Lo que vas a necesitar

Una computadora con **Node.js 20 o superior** ([descárgalo aquí](https://nodejs.org)) y cuentas (el plan gratis alcanza para empezar) en **4 servicios obligatorios**:

| Servicio | Para qué sirve | Dónde sacar la llave |
|---|---|---|
| **Supabase** | Base de datos y login | https://supabase.com/dashboard |
| **Deepgram** | Convertir el audio en texto | https://console.deepgram.com |
| **OpenRouter** | El análisis y el chat con IA | https://openrouter.ai/keys |
| **Cloudflare R2** | Guardar los audios (hasta 2 GB c/u) | https://dash.cloudflare.com → R2 |

Y **3 extras opcionales** (puedes activarlos después): tu propia llave de **OpenAI**, **Google Drive** (para respaldar audios) y **notificaciones push**.

---

## Instalación en 4 pasos

### 1. Descarga el proyecto

**Si bajaste el `.zip`** (lo más común): descomprímelo. Se crea una carpeta llamada `tagmeetings`. Ábrela en una terminal.

**Si prefieres git** (opcional, para técnicos):

```bash
git clone <URL-del-repositorio>
cd tagmeetings
```

En cualquiera de los dos casos, instala las dependencias:

```bash
npm install
```

### 2. Corre el instalador

```bash
node setup.mjs
```

El asistente:
- **Genera por ti** las llaves de seguridad (no tienes que conseguirlas de nadie).
- **Te pide** las llaves de los 4 servicios, mostrándote el link directo de cada panel.
- **Te pregunta** si quieres activar los extras opcionales.
- **Escribe** tu archivo de configuración (`.env.local`).

### 3. Monta la base de datos (1 paso manual)

Al terminar, el instalador te muestra un link al **editor SQL de tu Supabase**. Ahí:
1. Abre el archivo `supabase/migrations/20260527000000_baseline_schema.sql`.
2. Copia **todo** su contenido.
3. Pégalo en el editor y pulsa **Run**.

Eso crea todas las tablas, las reglas de seguridad y los índices de una sola vez.

> Si prefieres la línea de comandos: `npx supabase link` y luego `npx supabase db push`.

### 4. Arranca

```bash
npm run dev
```

Abre http://localhost:3050, crea tu cuenta, y sube tu primer audio. ¡Listo!

---

## Llevarlo a producción (Vercel)

1. Sube tu copia del proyecto a un repositorio tuyo (GitHub, GitLab…).
2. Impórtalo en [Vercel](https://vercel.com/new).
3. En **Settings → Environment Variables**, pega las mismas variables de tu `.env.local` (cambia `NEXT_PUBLIC_SITE_URL` por tu dominio real).
4. En Supabase → **Authentication → URL Configuration**, pon tu dominio en *Site URL* y agrégalo a *Redirect URLs*.
5. En Cloudflare R2 → CORS del bucket, agrega tu dominio a los orígenes permitidos.

Si activaste Google Drive, agrega también `https://tu-dominio/api/drive/callback` a los *Redirect URIs* en Google Cloud.

---

## Pégaselo a tu Claude

¿No te sientes cómodo con la terminal? Copia el texto de abajo y pégaselo a tu asistente **Claude Code** (abierto en la carpeta del proyecto). Él te guía y ejecuta los pasos contigo:

```text
Acabo de descargar el proyecto TagMeetings (self-host BYOK). Ayúdame a instalarlo
en mi computadora, paso a paso, explicándome en palabras simples. Yo no quiero
tocar la terminal ni editar archivos: hazlo tú por mí.

1. Verifica que tengo Node 20+ instalado; si no, dime cómo instalarlo.
2. Corre `npm install`.
3. Corre `node setup.mjs --auto`: genera mis llaves de seguridad y deja el
   archivo `.env.local` listo, con huecos vacíos para 4 servicios.
4. Acompáñame a crear las cuentas y conseguir esas 4 llaves (Supabase, Deepgram,
   OpenRouter, Cloudflare R2): ábreme el panel de cada una, dime qué crear y qué
   copiar, y TÚ pega cada llave en su hueco del `.env.local` (yo no lo edito).
   Los opcionales (OpenAI, Google Drive, notificaciones) los omitimos por ahora.
5. Cuando el `.env.local` esté completo, ábreme el editor SQL de mi Supabase,
   dime qué archivo copiar, pégalo y confirma conmigo que corrió bien.
6. Arranca la app con `npm run dev` y dime en qué dirección abrirla.

Si algo falla, diagnostícalo y arréglalo conmigo antes de seguir. No subas ni
compartas mis llaves en ningún lado.
```

---

## Servicios opcionales

- **OpenAI**: si la dejas vacía, los embeddings del chat-con-citas se piden a OpenRouter (una llave menos). Solo ponla si prefieres tu cuenta de OpenAI directa.
- **Google Drive**: respaldo automático o manual de tus audios antes de liberarlos. Si no lo activas, la app funciona igual; simplemente no aparece la opción.
- **Notificaciones push**: aviso cuando una transcripción está lista. Requiere poner tu correo de contacto en el instalador.

---

## Problemas comunes

- **«ENCRYPTION_KEY debe representar 32 bytes»**: corre `node setup.mjs` de nuevo (genera la llave correcta), o pon una de 32 bytes con `openssl rand -base64 32`.
- **No suben los audios**: revisa el CORS de tu bucket de R2 (debe permitir tu dominio o `http://localhost:3050`).
- **El login no redirige bien**: confirma `NEXT_PUBLIC_SITE_URL` y las *Redirect URLs* de Supabase.
- **El chat con IA no responde**: verifica que `OPENROUTER_API_KEY` sea válida y tenga crédito.

---

Tu `.env.local` es **privado**: contiene tus llaves y nunca debe subirse a un repositorio. Ya está protegido en `.gitignore`.
