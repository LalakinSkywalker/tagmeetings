#!/usr/bin/env node
// =============================================================================
// TagMeetings — Instalador asistido (self-host BYOK)
// -----------------------------------------------------------------------------
// Wizard cross-OS (Windows / macOS / Linux), Node puro. Hace 3 cosas:
//   1. GENERA por ti las llaves de seguridad que no tienes que pedirle a nadie
//      (ENCRYPTION_KEY, CRON_SECRET y el par de llaves para notificaciones VAPID).
//   2. TE PIDE las llaves de los servicios externos, mostrandote el link directo
//      del panel de cada uno.
//   3. ESCRIBE tu archivo .env.local y te dice como montar la base de datos.
//
// Uso:  node setup.mjs       (despues de `npm install`)
//
// Tus llaves son TUYAS: viven solo en tu .env.local (que esta en .gitignore y
// nunca se sube). Este script no manda nada a ningun lado.
// =============================================================================

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { randomBytes } from 'node:crypto'
import { writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = join(__dirname, '.env.local')
const MIGRATION_REL = 'supabase/migrations/20260527000000_baseline_schema.sql'

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  brand: '\x1b[38;5;208m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
}
const c = (color, s) => `${C[color]}${s}${C.reset}`
const line = () => console.log(c('dim', '─'.repeat(64)))

const rl = createInterface({ input: stdin, output: stdout })

/** Pregunta obligatoria: repite hasta que haya un valor no vacio. */
async function required(label, hint) {
  if (hint) console.log(c('dim', `   ${hint}`))
  let v = ''
  while (!v) {
    v = (await rl.question(`   ${c('bold', label)}: `)).trim()
    if (!v) console.log(c('yellow', '   (este dato es obligatorio)'))
  }
  return v
}

/** Pregunta opcional: Enter en blanco la deja vacia. */
async function optional(label, hint) {
  if (hint) console.log(c('dim', `   ${hint}`))
  return (await rl.question(`   ${c('bold', label)} ${c('dim', '(opcional, Enter para omitir)')}: `)).trim()
}

/** Pregunta si/no. Default segun `def` (true = Enter es si). */
async function yesNo(label, def = false) {
  const suf = def ? '[S/n]' : '[s/N]'
  const r = (await rl.question(`   ${c('bold', label)} ${c('dim', suf)}: `)).trim().toLowerCase()
  if (!r) return def
  return r === 's' || r === 'si' || r === 'sí' || r === 'y' || r === 'yes'
}

/** Deriva el "project ref" de una URL de Supabase: https://<ref>.supabase.co */
function supabaseRef(url) {
  const m = url.match(/^https?:\/\/([a-z0-9-]+)\.supabase\.(co|in|red)/i)
  return m ? m[1] : null
}

function genKeys() {
  return {
    ENCRYPTION_KEY: randomBytes(32).toString('base64'), // 32 bytes (AES-256), formato que acepta src/lib/crypto/encrypt.ts
    CRON_SECRET: randomBytes(24).toString('hex'),
  }
}

/** Genera el par VAPID (P-256) usando web-push si esta disponible. */
async function genVapid() {
  try {
    const { default: webpush } = await import('web-push')
    const { publicKey, privateKey } = webpush.generateVAPIDKeys()
    return { publicKey, privateKey, ok: true }
  } catch {
    return { publicKey: '', privateKey: '', ok: false }
  }
}

function buildEnv(v) {
  const q = (s) => (s ?? '')
  return `# =============================================================================
# TagMeetings — Configuracion local (generada por setup.mjs el ${new Date().toISOString().slice(0, 10)})
# Este archivo es TUYO y privado. Esta en .gitignore: NUNCA lo subas a un repo.
# =============================================================================

# --- Tu sitio -----------------------------------------------------------------
NEXT_PUBLIC_SITE_URL=${q(v.NEXT_PUBLIC_SITE_URL)}

# --- Supabase (base de datos + login) -----------------------------------------
NEXT_PUBLIC_SUPABASE_URL=${q(v.NEXT_PUBLIC_SUPABASE_URL)}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${q(v.NEXT_PUBLIC_SUPABASE_ANON_KEY)}
SUPABASE_SERVICE_ROLE_KEY=${q(v.SUPABASE_SERVICE_ROLE_KEY)}

# --- Deepgram (transcripcion de audio) ----------------------------------------
DEEPGRAM_API_KEY=${q(v.DEEPGRAM_API_KEY)}

# --- OpenRouter (analisis + chat con IA) --------------------------------------
OPENROUTER_API_KEY=${q(v.OPENROUTER_API_KEY)}
OPENROUTER_MODEL=${q(v.OPENROUTER_MODEL)}

# --- Cloudflare R2 (almacen de audios, hasta 2 GB por archivo) -----------------
R2_ACCOUNT_ID=${q(v.R2_ACCOUNT_ID)}
R2_ENDPOINT=${q(v.R2_ENDPOINT)}
R2_BUCKET=${q(v.R2_BUCKET)}
R2_ACCESS_KEY_ID=${q(v.R2_ACCESS_KEY_ID)}
R2_SECRET_ACCESS_KEY=${q(v.R2_SECRET_ACCESS_KEY)}

# --- Llaves de seguridad (generadas para ti; no las compartas) ----------------
ENCRYPTION_KEY=${q(v.ENCRYPTION_KEY)}
CRON_SECRET=${q(v.CRON_SECRET)}

# --- OpenAI (OPCIONAL) --------------------------------------------------------
# Si la dejas vacia, los embeddings del chat-con-citas se piden a OpenRouter
# (una llave menos). Ponla solo si prefieres usar tu cuenta de OpenAI directa.
OPENAI_API_KEY=${q(v.OPENAI_API_KEY)}

# --- Google Drive (OPCIONAL: respaldo de audios) ------------------------------
GOOGLE_CLIENT_ID=${q(v.GOOGLE_CLIENT_ID)}
GOOGLE_CLIENT_SECRET=${q(v.GOOGLE_CLIENT_SECRET)}

# --- Notificaciones push (OPCIONAL) -------------------------------------------
# Las llaves VAPID se generaron para ti. Para ACTIVAR el push, pon tu correo de
# contacto en VAPID_SUBJECT (formato mailto:tucorreo@dominio.com). Sin el, el
# push queda desactivado de forma limpia (la app funciona igual).
NEXT_PUBLIC_VAPID_PUBLIC_KEY=${q(v.NEXT_PUBLIC_VAPID_PUBLIC_KEY)}
VAPID_PRIVATE_KEY=${q(v.VAPID_PRIVATE_KEY)}
VAPID_SUBJECT=${q(v.VAPID_SUBJECT)}
`
}

async function main() {
  console.clear()
  line()
  console.log(c('brand', c('bold', '   TagMeetings — Instalador asistido')))
  console.log(c('dim', '   Te dejo la app lista con TUS propias llaves. Tardamos ~10 min.'))
  line()
  console.log('')
  console.log('   Vamos a necesitar cuentas (con plan gratis sirve para empezar) en:')
  console.log(`   ${c('cyan', '•')} Supabase   ${c('dim', 'base de datos + login')}`)
  console.log(`   ${c('cyan', '•')} Deepgram   ${c('dim', 'transcripcion de audio')}`)
  console.log(`   ${c('cyan', '•')} OpenRouter ${c('dim', 'analisis + chat con IA')}`)
  console.log(`   ${c('cyan', '•')} Cloudflare R2 ${c('dim', 'almacen de audios grandes')}`)
  console.log('')
  console.log(c('dim', '   Ten a la mano las llaves de cada uno. Si te falta alguna, puedes'))
  console.log(c('dim', '   cancelar (Ctrl+C), conseguirla, y volver a correr este instalador.'))
  console.log('')

  if (existsSync(ENV_PATH)) {
    const ok = await yesNo('Ya existe un .env.local. ¿Lo reemplazo? (guardo copia .env.local.bak)', false)
    if (!ok) {
      console.log(c('yellow', '\n   Cancelado. No toque tu .env.local.'))
      rl.close()
      return
    }
    copyFileSync(ENV_PATH, `${ENV_PATH}.bak`)
    console.log(c('dim', '   Copia guardada en .env.local.bak'))
  }

  const v = {}

  // --- 1. Llaves de seguridad (automatico) -----------------------------------
  console.log('')
  line()
  console.log(c('bold', '   1/5  Generando tus llaves de seguridad...'))
  line()
  Object.assign(v, genKeys())
  const vapid = await genVapid()
  v.NEXT_PUBLIC_VAPID_PUBLIC_KEY = vapid.publicKey
  v.VAPID_PRIVATE_KEY = vapid.privateKey
  console.log(c('green', '   ✓ Llave de cifrado (ENCRYPTION_KEY) generada'))
  console.log(c('green', '   ✓ Secreto de tareas programadas (CRON_SECRET) generado'))
  if (vapid.ok) console.log(c('green', '   ✓ Par de llaves de notificaciones (VAPID) generado'))
  else console.log(c('yellow', '   ⚠ No pude generar las llaves VAPID (¿corriste `npm install`?). El push quedara desactivado; puedes activarlo despues.'))

  // --- 2. Tu sitio -----------------------------------------------------------
  console.log('')
  line()
  console.log(c('bold', '   2/5  Tu sitio'))
  line()
  const site = await optional('URL del sitio', 'En tu compu deja Enter (usa http://localhost:3050). En produccion pon tu dominio.')
  v.NEXT_PUBLIC_SITE_URL = site || 'http://localhost:3050'

  // --- 3. Servicios obligatorios ---------------------------------------------
  console.log('')
  line()
  console.log(c('bold', '   3/5  Servicios obligatorios (4)'))
  line()

  console.log(c('cyan', '\n   Supabase  →  https://supabase.com/dashboard/projects'))
  console.log(c('dim', '   Crea un proyecto. Las 3 llaves estan en: Project Settings → API.'))
  v.NEXT_PUBLIC_SUPABASE_URL = await required('URL del proyecto (Project URL)', 'Algo como https://xxxxxxxx.supabase.co')
  v.NEXT_PUBLIC_SUPABASE_ANON_KEY = await required('Llave publica (anon / publishable key)')
  v.SUPABASE_SERVICE_ROLE_KEY = await required('Llave secreta de servicio (service_role key)', 'Es secreta: solo se usa en el servidor.')

  console.log(c('cyan', '\n   Deepgram  →  https://console.deepgram.com/signup'))
  console.log(c('dim', '   Crea una API Key en el panel.'))
  v.DEEPGRAM_API_KEY = await required('API Key de Deepgram')

  console.log(c('cyan', '\n   OpenRouter  →  https://openrouter.ai/keys'))
  console.log(c('dim', '   Crea una API Key. Necesitas credito/cuenta activa.'))
  v.OPENROUTER_API_KEY = await required('API Key de OpenRouter')
  const model = await optional('Modelo de IA', 'Enter para el recomendado: openai/gpt-5-mini')
  v.OPENROUTER_MODEL = model || 'openai/gpt-5-mini'

  console.log(c('cyan', '\n   Cloudflare R2  →  https://dash.cloudflare.com/  → R2'))
  console.log(c('dim', '   Crea un bucket (ej. "tagmeetings-audios") y un API Token de R2.'))
  v.R2_ACCOUNT_ID = await required('Account ID de Cloudflare')
  v.R2_BUCKET = await required('Nombre del bucket')
  v.R2_ACCESS_KEY_ID = await required('Access Key ID del token de R2')
  v.R2_SECRET_ACCESS_KEY = await required('Secret Access Key del token de R2')
  const ep = await optional('Endpoint de R2', `Enter para el estandar: https://${v.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`)
  v.R2_ENDPOINT = ep || `https://${v.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`

  // --- 4. Opcionales ---------------------------------------------------------
  console.log('')
  line()
  console.log(c('bold', '   4/5  Extras opcionales'))
  line()
  console.log(c('dim', '   Puedes omitir todo esto y activarlo despues.'))

  console.log('')
  if (await yesNo('¿Usar tu propia cuenta de OpenAI para los embeddings? (si no, se usa OpenRouter)', false)) {
    console.log(c('cyan', '   OpenAI  →  https://platform.openai.com/api-keys'))
    v.OPENAI_API_KEY = await optional('API Key de OpenAI')
  } else {
    v.OPENAI_API_KEY = ''
  }

  console.log('')
  if (await yesNo('¿Activar respaldo de audios en Google Drive?', false)) {
    console.log(c('cyan', '   Google Cloud  →  https://console.cloud.google.com/apis/credentials'))
    console.log(c('dim', '   Crea credenciales OAuth 2.0 (tipo "Aplicacion web").'))
    console.log(c('dim', `   Redirect URI autorizado: ${v.NEXT_PUBLIC_SITE_URL}/api/drive/callback`))
    v.GOOGLE_CLIENT_ID = await optional('Google Client ID')
    v.GOOGLE_CLIENT_SECRET = await optional('Google Client Secret')
  } else {
    v.GOOGLE_CLIENT_ID = ''
    v.GOOGLE_CLIENT_SECRET = ''
  }

  console.log('')
  if (vapid.ok && (await yesNo('¿Activar notificaciones push (avisar cuando una transcripcion este lista)?', false))) {
    const mail = await optional('Tu correo de contacto', 'Se guarda como mailto:tucorreo. Lo exige el estandar de push.')
    v.VAPID_SUBJECT = mail ? (mail.startsWith('mailto:') ? mail : `mailto:${mail}`) : ''
  } else {
    v.VAPID_SUBJECT = ''
  }

  // --- 5. Escribir .env.local ------------------------------------------------
  console.log('')
  line()
  console.log(c('bold', '   5/5  Escribiendo tu configuracion...'))
  line()
  writeFileSync(ENV_PATH, buildEnv(v), 'utf8')
  console.log(c('green', `   ✓ .env.local escrito (${ENV_PATH})`))

  // --- Cierre: base de datos -------------------------------------------------
  const ref = supabaseRef(v.NEXT_PUBLIC_SUPABASE_URL)
  const sqlEditor = ref
    ? `https://supabase.com/dashboard/project/${ref}/sql/new`
    : 'el SQL Editor de tu proyecto en Supabase'
  const migrationExists = existsSync(join(__dirname, MIGRATION_REL))

  console.log('')
  line()
  console.log(c('brand', c('bold', '   Casi listo. Falta montar la base de datos (1 paso manual)')))
  line()
  console.log('')
  console.log('   La forma mas simple (sin instalar nada):')
  console.log(`   ${c('bold', '1.')} Abre el editor SQL de tu Supabase:`)
  console.log(`      ${c('cyan', sqlEditor)}`)
  console.log(`   ${c('bold', '2.')} Abre este archivo y copia TODO su contenido:`)
  console.log(`      ${c('cyan', MIGRATION_REL)}`)
  if (!migrationExists) {
    console.log(c('yellow', `      ⚠ No encontre ese archivo; verifica que clonaste el repo completo.`))
  }
  console.log(`   ${c('bold', '3.')} Pegalo en el editor y pulsa ${c('bold', 'Run')}. Crea todas las tablas y reglas.`)
  console.log('')
  console.log(c('dim', '   (Alternativa para usuarios avanzados: `npx supabase link` + `npx supabase db push`.)'))
  console.log('')
  line()
  console.log(c('green', c('bold', '   ¡Todo listo!')))
  console.log('')
  console.log(`   Arranca la app con:  ${c('bold', 'npm run dev')}`)
  console.log(`   y abre:              ${c('cyan', v.NEXT_PUBLIC_SITE_URL)}`)
  console.log('')
  console.log(c('dim', '   Recuerda: tu .env.local es privado. No lo subas a ningun repo.'))
  line()

  rl.close()
}

main().catch((err) => {
  console.error(c('yellow', `\n   Algo fallo: ${err?.message ?? err}`))
  try { rl.close() } catch {}
  process.exit(1)
})
