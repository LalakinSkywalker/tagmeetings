#!/usr/bin/env node
// =============================================================================
// generate-pwa-icons.cjs — genera iconos PNG del PWA desde public/icon.svg
// =============================================================================
// USO: node scripts/generate-pwa-icons.cjs
//
// Lee public/icon.svg y produce:
//   - public/icon-192.png  (192x192, transparent — Android Chrome)
//   - public/icon-512.png  (512x512, transparent — splash + install)
//   - public/icon-180.png  (180x180 — apple-touch-icon iOS)
//   - public/icon-512-maskable.png (con padding 10% para safe area maskable)
//
// Re-correr cuando se actualice icon.svg.
// =============================================================================

const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')

const SRC = path.resolve(__dirname, '..', 'public', 'icon.svg')
const OUT_DIR = path.resolve(__dirname, '..', 'public')

const TARGETS = [
  { size: 192, filename: 'icon-192.png' },
  { size: 512, filename: 'icon-512.png' },
  { size: 180, filename: 'icon-180.png' },
]

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error('ERROR: no encuentro public/icon.svg en', SRC)
    process.exit(1)
  }

  const svgBuffer = fs.readFileSync(SRC)

  for (const target of TARGETS) {
    const out = path.join(OUT_DIR, target.filename)
    await sharp(svgBuffer)
      .resize(target.size, target.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(out)
    console.log(`OK ${target.filename} (${target.size}x${target.size})`)
  }

  // Maskable: agregar 10% padding (safe area en Android adaptive icons)
  const maskablePath = path.join(OUT_DIR, 'icon-512-maskable.png')
  const padding = Math.round(512 * 0.1)
  const innerSize = 512 - padding * 2
  const inner = await sharp(svgBuffer)
    .resize(innerSize, innerSize, { fit: 'contain', background: { r: 15, g: 23, b: 42, alpha: 1 } })
    .png()
    .toBuffer()
  await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 15, g: 23, b: 42, alpha: 1 },
    },
  })
    .composite([{ input: inner, top: padding, left: padding }])
    .png()
    .toFile(maskablePath)
  console.log('OK icon-512-maskable.png (512x512 con safe area)')
}

main().catch((err) => {
  console.error('UNEXPECTED:', err.message)
  process.exit(1)
})
