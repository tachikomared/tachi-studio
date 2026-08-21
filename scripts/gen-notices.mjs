#!/usr/bin/env node
// scripts/gen-notices.mjs
//
// Generate THIRD_PARTY_NOTICES.md from what is ACTUALLY installed.
//
// The file this replaces was nine lines long, described Electron and React, and
// ended with "(Add further entries as dependencies are added.)" — a TODO that
// had been shipping inside every installer since electron-builder.json started
// copying it into `extraResources`. MIT, BSD and Apache-2.0 all require the
// notice to be reproduced in a binary distribution, so a hand-maintained list is
// a promise nobody can keep across 900 packages.
//
// SO IT IS GENERATED. `pnpm licenses list --json --prod` reports what pnpm
// resolved for the PRODUCTION graph — the thing that actually ships — and this
// turns that into the notices file. Run it after any dependency change; CI
// checks it is current (see the `notices` job).
//
//   node scripts/gen-notices.mjs           # write THIRD_PARTY_NOTICES.md
//   node scripts/gen-notices.mjs --check   # exit 1 if it is stale
//
// WHAT A GENERATOR CANNOT DO is decide what a licence MEANS. Several groups carry
// obligations or restrictions that a scanner cannot express, so they are written
// by hand in HAND_WRITTEN below and merged into the output. If a new licence
// family appears that is not in KNOWN_FAMILIES, this script FAILS rather than
// quietly listing it as ordinary permissive — a new copyleft dependency should
// stop a release, not slip into a table.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'THIRD_PARTY_NOTICES.md')

/**
 * Licence families we have already reasoned about.
 *
 * `permissive` ones need attribution and nothing else. Anything NOT in this map
 * is an unreviewed licence and stops the script — see the header.
 */
const KNOWN_FAMILIES = new Map([
  ['MIT', 'permissive'],
  ['Apache-2.0', 'permissive'],
  ['ISC', 'permissive'],
  ['BSD-3-Clause', 'permissive'],
  ['BSD-2-Clause', 'permissive'],
  ['0BSD', 'permissive'],
  ['BlueOak-1.0.0', 'permissive'],
  ['Unlicense', 'permissive'],
  ['CC0-1.0', 'permissive'],
  ['CC-BY-4.0', 'permissive'],
  ['Python-2.0', 'permissive'],
  ['(Apache-2.0 AND BSD-3-Clause)', 'permissive'],
  // Dual-licensed: the permissive half is the one taken, named in the output.
  ['(MPL-2.0 OR Apache-2.0)', 'permissive'],
  ['(AFL-2.1 OR BSD-3-Clause)', 'permissive'],
  ['(MIT OR CC0-1.0)', 'permissive'],
  ['(MIT AND BSD-3-Clause)', 'permissive'],
  ['(MIT AND Zlib)', 'permissive'],
  ['Zlib', 'permissive'],
  ['WTFPL', 'permissive'],
  ['MIT-0', 'permissive'],
  // Reviewed and written up by hand below.
  ['MPL-2.0', 'reviewed'],
  ['lgpl', 'reviewed'],
  ['LGPL-3.0-or-later', 'reviewed'],
  ['Apache-2.0 AND LGPL-3.0-or-later', 'reviewed'],
  ['Remotion License', 'reviewed'],
  ['Remotion License https://remotion.dev/license', 'reviewed'],
  ['Unknown', 'reviewed'],
  ['EPL-2.0', 'reviewed'],
  ["Standard 'no charge' license: https://gsap.com/standard-license.", 'reviewed'],
])

/** The things a table cannot say. Merged into the generated output. */
const HAND_WRITTEN = `
## Components that need more than a line

A licence scanner reports a string. These need a sentence, so they are written
by hand and reviewed when they change.

### Remotion — not MIT, and not free for every user

Every \`remotion\` and \`@remotion/*\` package ships under **Remotion's own
licence**, not MIT — pnpm reports most of them as \`Unknown\` because it is not an
SPDX identifier. It is free for individuals and for companies up to three people,
and requires a paid company licence above that. See <https://remotion.dev/license>.

If you use this app inside a company larger than that, the obligation is yours,
not this project's — but you should know it exists before you rely on video
export.

**Remotion's video ENCODER is deliberately NOT bundled.** The per-platform
compositor package carries an FFmpeg built with \`--enable-nonfree\`, whose own
version string reads \`libavcodec license: nonfree and unredistributable\`.
Shipping it would make this project the distributor of something that states it
may not be distributed, so the app fetches it from Remotion's official npm
package on an explicit click instead. The packaging step fails the build if a
compositor package, or any binary carrying that string, is found inside an
artifact.

### sharp / libvips — LGPL-3.0-or-later

\`@img/sharp-*\` declares \`Apache-2.0 AND LGPL-3.0-or-later\` and ships
\`libvips-42.dll\` (and its platform equivalents). libvips is LGPL, which permits
distribution inside a larger work provided the user can replace that library.
It ships as a separate, replaceable shared library rather than being statically
linked, which is what satisfies that condition. libvips source:
<https://github.com/libvips/libvips>.

### mediabunny — MPL-2.0

\`mediabunny\` and its encoder packages are Mozilla Public License 2.0: file-level
copyleft. Distributing them unmodified inside a larger work is permitted; if you
modify those files, you must publish the modified files. This project does not
modify them. Source: <https://github.com/Vanilagy/mediabunny>.

### @dmitryrechkin/json-schema-to-zod — declared "lgpl"

Declared as \`lgpl\` with no version. The same replaceability reasoning as libvips
applies, and it is pure JavaScript shipped as its own module inside the package
tree rather than inlined. Named here so a reader does not have to discover it.

### GSAP — a "standard no-charge" licence, not an open-source one

\`gsap\` ships under GreenSock's own **Standard "No Charge" licence**, which is not
an OSI licence and carries no SPDX identifier. It permits use in projects that do
not charge for access to the GSAP features themselves; a commercial product built
around them needs a GreenSock club licence. Read it before you build a paid
product on the animation features: <https://gsap.com/standard-license>.

It is a direct production dependency and its minified source is inlined into
exported HyperFrames documents, so it leaves this app inside files a user shares.

### elkjs — EPL-2.0

\`elkjs\` (graph layout, used by the node canvas) is Eclipse Public License 2.0:
file-level copyleft like MPL. Distributing it unmodified inside a larger work is
permitted; modifications to its files must be published. This project does not
modify it. Source: <https://github.com/kieler/elkjs>.

### Dual-licensed packages

\`dompurify\` is \`(MPL-2.0 OR Apache-2.0)\` and \`json-schema\` is
\`(AFL-2.1 OR BSD-3-Clause)\`. Where a licence offers a choice, this distribution
takes the permissive option — Apache-2.0 and BSD-3-Clause respectively — so
neither carries a copyleft obligation here.

### Binaries this app DOWNLOADS at runtime — not part of this distribution

The app can fetch these on request. They are **not** in the installer, and each
arrives under its own licence directly from its own publisher:

| Component | What it is | Licence |
|---|---|---|
| llama.cpp | local LLM server | MIT |
| stable-diffusion.cpp | local image / video generation | MIT |
| piper | local text-to-speech | MIT |
| whisper.cpp | local speech-to-text | MIT |
| RIFE | frame interpolation | MIT |
| yt-dlp | media URL import | Unlicense |
| Chromium (via @puppeteer/browsers) | page rendering / capture | BSD-3-Clause |
| Remotion compositor | MP4 encoding | Remotion License (see above) |
| Model weights | chosen by the user in the catalog | shown per model before download |

The model catalog states each model's licence, with a link, **before** anything
is downloaded — including the ones we refuse to fetch at all because their terms
do not allow it.
`.trim()

function collect() {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  return JSON.parse(raw)
}

function render(byLicence) {
  const families = Object.keys(byLicence).sort((a, b) => byLicence[b].length - byLicence[a].length)

  const unknownFamilies = families.filter(f => !KNOWN_FAMILIES.has(f))
  if (unknownFamilies.length > 0) {
    console.error(
      `\n[gen-notices] UNREVIEWED LICENCE(S): ${unknownFamilies.join(', ')}\n\n` +
      `A licence this script has never seen is not automatically fine. Add it to\n` +
      `KNOWN_FAMILIES as 'permissive' if it needs attribution only, or write it up\n` +
      `in HAND_WRITTEN and mark it 'reviewed'. Refusing to guess is the point.\n`,
    )
    process.exit(2)
  }

  const total = families.reduce((n, f) => n + byLicence[f].length, 0)
  const rows = families.map(f => `| ${f} | ${byLicence[f].length} |`).join('\n')

  const list = families.map(f => {
    const pkgs = [...byLicence[f]].sort((a, b) => String(a.name).localeCompare(String(b.name)))
    const lines = pkgs.map(p => `- ${p.name} ${(p.versions || []).join(', ')}`).join('\n')
    return `### ${f}\n\n${lines}`
  }).join('\n\n')

  return `# Third-party notices

Tachi Studio is MIT licensed (see \`LICENSE\`). It is built on open-source work by
other people, and this file reproduces their notices — which MIT, BSD and
Apache-2.0 all require of a binary distribution.

**This file is generated.** Run \`node scripts/gen-notices.mjs\` after any
dependency change; CI fails if it is stale. Hand-written sections are merged in
from that script, not edited here.

Counted from the **production** dependency graph — what actually ships —
resolved by pnpm: **${total} packages** across ${families.length} licence
families.

| Licence | Packages |
|---|---|
${rows}

${HAND_WRITTEN}

## The full list

Every production package, by licence. Each package's own licence text ships
inside its own directory in the application bundle.

${list}
`
}

const byLicence = collect()
const text = render(byLicence)

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (current.trim() !== text.trim()) {
    console.error(
      '[gen-notices] THIRD_PARTY_NOTICES.md is STALE.\n' +
      'A dependency changed and the notices did not. Run:\n' +
      '  node scripts/gen-notices.mjs\n',
    )
    process.exit(1)
  }
  console.log('[gen-notices] THIRD_PARTY_NOTICES.md is current.')
  process.exit(0)
}

writeFileSync(OUT, text, 'utf8')
console.log(`[gen-notices] wrote ${OUT}`)
