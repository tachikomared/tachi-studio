#!/usr/bin/env node
// generate-mac-icon.mjs
//
// Emits build/icon.icns from the highest-res existing icon source
// (build/icon.png, 256x256 — the same art used for icon.ico/icon.png on
// win/linux). Run manually whenever the source art changes; the output
// is committed alongside icon.ico/icon.png so `electron-builder` never
// needs this script or its `png2icons` devDependency at package time.
//
// Usage: node scripts/generate-mac-icon.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import png2icons from 'png2icons'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const buildDir = path.join(__dirname, '..', 'build')
const srcPng = path.join(buildDir, 'icon.png')
const outIcns = path.join(buildDir, 'icon.icns')

if (!existsSync(srcPng)) {
  console.error(`[generate-mac-icon] source not found: ${srcPng}`)
  process.exit(1)
}

const input = readFileSync(srcPng)
// BICUBIC2 gives the cleanest upscale from a 256px source into the larger
// icns slots (512/1024); png2icons pads/resizes each slot internally.
const output = png2icons.createICNS(input, png2icons.BICUBIC2, 0)

if (!output) {
  console.error('[generate-mac-icon] png2icons.createICNS() returned null — conversion failed')
  process.exit(1)
}

writeFileSync(outIcns, output)
console.log(`[generate-mac-icon] wrote ${outIcns} (${output.length} bytes)`)
