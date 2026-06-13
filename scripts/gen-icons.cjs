/**
 * Genera los iconos PWA + notificaciones de TagMeetings a partir del SIMBOLO
 * (microfono naranja) — NO del logo con wordmark.
 *
 * Estandar Bluntag (brand_assets_recipe): el icono de app/notificacion es el
 * SIMBOLO solo, grande, OPACO, sobre fondo = background_color del manifest. Un
 * logo con texto a tamano de icono se lee como "cuadro blanco" en la notificacion
 * de iOS (cazado 2026-06-12: la notificacion mostraba un cuadro blanco vacio).
 *
 * Produce:
 *   - icon-192/512/180.png  -> simbolo ~80% sobre fondo opaco (manifest "any" + apple-touch)
 *   - icon-512-maskable.png -> simbolo ~64% sobre fondo opaco (safe-zone, el OS recorta)
 *   - favicon-32.png        -> simbolo transparente (pestania del navegador)
 *   - badge-96.png          -> silueta MONOCROMATICA sobre transparente (barra de estado Android;
 *                              Android ignora el color y usa solo el alpha -> NUNCA el icono opaco)
 *
 * Uso: node scripts/gen-icons.cjs
 */
const sharp = require('sharp')
const path = require('path')

// Simbolo (microfono naranja + onda) sobre transparente. SIN wordmark.
const SYMBOL = path.join(__dirname, '../public/logo-tagflow-small.png')
const OUT = path.join(__dirname, '../public')
// Fondo opaco = background_color del manifest (que el icono se funda en el splash).
const BG = { r: 250, g: 249, b: 247, alpha: 1 } // #faf9f7
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

/** Compone el simbolo a `ratio` del lienzo de `size`, sobre fondo opaco. */
async function iconoOpaco(size, ratio, outFile) {
  const inner = Math.round(size * ratio)
  const simbolo = await sharp(SYMBOL)
    .resize(inner, inner, { fit: 'contain', background: TRANSPARENT })
    .toBuffer()
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: simbolo, gravity: 'center' }])
    .flatten({ background: BG })
    .png()
    .toFile(path.join(OUT, outFile))
}

async function gen() {
  // Iconos "any" + apple-touch: simbolo grande sobre fondo opaco.
  await iconoOpaco(192, 0.8, 'icon-192.png')
  await iconoOpaco(512, 0.8, 'icon-512.png')
  await iconoOpaco(180, 0.8, 'icon-180.png')

  // Maskable: simbolo en la safe-zone (~64%) sobre fondo opaco que LLENA el cuadro.
  await iconoOpaco(512, 0.64, 'icon-512-maskable.png')

  // Favicon: simbolo transparente pequenio (el navegador maneja el alpha).
  await sharp(SYMBOL)
    .resize(32, 32, { fit: 'contain', background: TRANSPARENT })
    .png()
    .toFile(path.join(OUT, 'favicon-32.png'))

  // Badge Android: silueta del simbolo en BLANCO sobre transparente. Android pinta
  // el badge usando solo el canal alpha; un icono opaco aqui = cuadrado blanco solido.
  const sym96 = await sharp(SYMBOL)
    .resize(96, 96, { fit: 'contain', background: TRANSPARENT })
    .ensureAlpha()
    .toBuffer()
  const { data: alphaRaw } = await sharp(sym96)
    .extractChannel('alpha')
    .raw()
    .toBuffer({ resolveWithObject: true })
  await sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(alphaRaw, { raw: { width: 96, height: 96, channels: 1 } })
    .png()
    .toFile(path.join(OUT, 'badge-96.png'))

  console.log('Iconos generados: icon-192/512/180, icon-512-maskable, favicon-32, badge-96')
}

gen().catch((e) => {
  console.error(e)
  process.exit(1)
})
