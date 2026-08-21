# Third-party notices

Tachi Studio is MIT licensed (see `LICENSE`). It is built on open-source work by
other people, and this file reproduces their notices — which MIT, BSD and
Apache-2.0 all require of a binary distribution.

**This file is generated.** Run `node scripts/gen-notices.mjs` after any
dependency change; CI fails if it is stale. Hand-written sections are merged in
from that script, not edited here.

Counted from the **production** dependency graph — what actually ships —
resolved by pnpm: **903 packages** across 25 licence
families.

| Licence | Packages |
|---|---|
| MIT | 614 |
| Apache-2.0 | 138 |
| ISC | 70 |
| BSD-3-Clause | 30 |
| BSD-2-Clause | 12 |
| Unknown | 9 |
| BlueOak-1.0.0 | 5 |
| Unlicense | 5 |
| MPL-2.0 | 4 |
| (Apache-2.0 AND BSD-3-Clause) | 1 |
| lgpl | 1 |
| Apache-2.0 AND LGPL-3.0-or-later | 1 |
| Remotion License | 1 |
| Remotion License https://remotion.dev/license | 1 |
| Python-2.0 | 1 |
| CC-BY-4.0 | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| EPL-2.0 | 1 |
| CC0-1.0 | 1 |
| Standard 'no charge' license: https://gsap.com/standard-license. | 1 |
| (AFL-2.1 OR BSD-3-Clause) | 1 |
| (MIT AND Zlib) | 1 |
| MIT-0 | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |

## Components that need more than a line

A licence scanner reports a string. These need a sentence, so they are written
by hand and reviewed when they change.

### Remotion — not MIT, and not free for every user

Every `remotion` and `@remotion/*` package ships under **Remotion's own
licence**, not MIT — pnpm reports most of them as `Unknown` because it is not an
SPDX identifier. It is free for individuals and for companies up to three people,
and requires a paid company licence above that. See <https://remotion.dev/license>.

If you use this app inside a company larger than that, the obligation is yours,
not this project's — but you should know it exists before you rely on video
export.

**Remotion's video ENCODER is deliberately NOT bundled.** The per-platform
compositor package carries an FFmpeg built with `--enable-nonfree`, whose own
version string reads `libavcodec license: nonfree and unredistributable`.
Shipping it would make this project the distributor of something that states it
may not be distributed, so the app fetches it from Remotion's official npm
package on an explicit click instead. The packaging step fails the build if a
compositor package, or any binary carrying that string, is found inside an
artifact.

### sharp / libvips — LGPL-3.0-or-later

`@img/sharp-*` declares `Apache-2.0 AND LGPL-3.0-or-later` and ships
`libvips-42.dll` (and its platform equivalents). libvips is LGPL, which permits
distribution inside a larger work provided the user can replace that library.
It ships as a separate, replaceable shared library rather than being statically
linked, which is what satisfies that condition. libvips source:
<https://github.com/libvips/libvips>.

### mediabunny — MPL-2.0

`mediabunny` and its encoder packages are Mozilla Public License 2.0: file-level
copyleft. Distributing them unmodified inside a larger work is permitted; if you
modify those files, you must publish the modified files. This project does not
modify them. Source: <https://github.com/Vanilagy/mediabunny>.

### @dmitryrechkin/json-schema-to-zod — declared "lgpl"

Declared as `lgpl` with no version. The same replaceability reasoning as libvips
applies, and it is pure JavaScript shipped as its own module inside the package
tree rather than inlined. Named here so a reader does not have to discover it.

### GSAP — a "standard no-charge" licence, not an open-source one

`gsap` ships under GreenSock's own **Standard "No Charge" licence**, which is not
an OSI licence and carries no SPDX identifier. It permits use in projects that do
not charge for access to the GSAP features themselves; a commercial product built
around them needs a GreenSock club licence. Read it before you build a paid
product on the animation features: <https://gsap.com/standard-license>.

It is a direct production dependency and its minified source is inlined into
exported HyperFrames documents, so it leaves this app inside files a user shares.

### elkjs — EPL-2.0

`elkjs` (graph layout, used by the node canvas) is Eclipse Public License 2.0:
file-level copyleft like MPL. Distributing it unmodified inside a larger work is
permitted; modifications to its files must be published. This project does not
modify it. Source: <https://github.com/kieler/elkjs>.

### Dual-licensed packages

`dompurify` is `(MPL-2.0 OR Apache-2.0)` and `json-schema` is
`(AFL-2.1 OR BSD-3-Clause)`. Where a licence offers a choice, this distribution
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

## The full list

Every production package, by licence. Each package's own licence text ships
inside its own directory in the application bundle.

### MIT

- @adraffy/ens-normalize 1.10.1
- @antfu/install-pkg 1.1.0
- @babel/runtime 7.29.7
- @braintree/sanitize-url 6.0.2, 7.1.2
- @esbuild/win32-x64 0.28.1
- @ethersproject/abi 5.8.0
- @ethersproject/abstract-provider 5.8.0
- @ethersproject/abstract-signer 5.8.0
- @ethersproject/address 5.8.0
- @ethersproject/base64 5.8.0
- @ethersproject/basex 5.8.0
- @ethersproject/bignumber 5.8.0
- @ethersproject/bytes 5.8.0
- @ethersproject/constants 5.8.0
- @ethersproject/contracts 5.8.0
- @ethersproject/hash 5.8.0
- @ethersproject/hdnode 5.8.0
- @ethersproject/json-wallets 5.8.0
- @ethersproject/keccak256 5.8.0
- @ethersproject/logger 5.8.0
- @ethersproject/networks 5.8.0
- @ethersproject/pbkdf2 5.8.0
- @ethersproject/properties 5.8.0
- @ethersproject/providers 5.8.0
- @ethersproject/random 5.8.0
- @ethersproject/rlp 5.8.0
- @ethersproject/sha2 5.8.0
- @ethersproject/signing-key 5.8.0
- @ethersproject/strings 5.8.0
- @ethersproject/transactions 5.8.0
- @ethersproject/wallet 5.8.0
- @ethersproject/web 5.8.0
- @ethersproject/wordlists 5.8.0
- @excalidraw/excalidraw 0.18.1
- @excalidraw/laser-pointer 1.3.1
- @excalidraw/markdown-to-text 0.1.2
- @excalidraw/mermaid-to-excalidraw 2.2.2
- @excalidraw/random-username 1.1.0
- @floating-ui/core 1.7.5
- @floating-ui/dom 1.7.6
- @floating-ui/react-dom 2.1.8
- @floating-ui/utils 0.2.11
- @hono/node-server 1.19.14
- @huggingface/jinja 0.5.9
- @iconify/types 2.0.0
- @iconify/utils 3.1.4
- @img/colour 1.1.0
- @inquirer/external-editor 1.0.3
- @irys/arweave 0.0.2
- @irys/query 0.0.9
- @irys/upload 0.0.15
- @irys/upload-core 0.0.10
- @irys/upload-ethereum 0.0.16
- @jpwilliams/waitgroup 2.1.1
- @jridgewell/gen-mapping 0.3.13
- @jridgewell/resolve-uri 3.1.2
- @jridgewell/source-map 0.3.11
- @jridgewell/sourcemap-codec 1.5.5
- @jridgewell/trace-mapping 0.3.31
- @js-sdsl/ordered-map 4.4.2
- @mermaid-js/parser 0.6.3, 1.2.0
- @modelcontextprotocol/sdk 1.29.0
- @module-federation/error-codes 0.22.0
- @module-federation/runtime 0.22.0
- @module-federation/runtime-core 0.22.0
- @module-federation/runtime-tools 0.22.0
- @module-federation/sdk 0.22.0
- @module-federation/webpack-bundler-runtime 0.22.0
- @napi-rs/canvas 1.0.2
- @napi-rs/canvas-win32-x64-msvc 1.0.2
- @noble/curves 1.2.0, 1.7.0
- @noble/ed25519 1.7.5
- @noble/hashes 1.3.2, 1.6.0
- @nodelib/fs.scandir 2.1.5
- @nodelib/fs.stat 2.0.5
- @nodelib/fs.walk 1.2.8
- @nookplot/mcp 0.4.122, 0.4.135
- @radix-ui/primitive 1.0.0, 1.1.1
- @radix-ui/react-arrow 1.1.2
- @radix-ui/react-collection 1.0.1
- @radix-ui/react-compose-refs 1.0.0, 1.1.1
- @radix-ui/react-context 1.0.0, 1.1.1
- @radix-ui/react-direction 1.0.0
- @radix-ui/react-dismissable-layer 1.1.5
- @radix-ui/react-focus-guards 1.1.1
- @radix-ui/react-focus-scope 1.1.2
- @radix-ui/react-id 1.0.0, 1.1.0
- @radix-ui/react-popover 1.1.6
- @radix-ui/react-popper 1.2.2
- @radix-ui/react-portal 1.1.4
- @radix-ui/react-presence 1.0.0, 1.1.2
- @radix-ui/react-primitive 1.0.1, 2.0.2
- @radix-ui/react-roving-focus 1.0.2
- @radix-ui/react-slot 1.0.1, 1.1.2
- @radix-ui/react-tabs 1.0.2
- @radix-ui/react-use-callback-ref 1.0.0, 1.1.0
- @radix-ui/react-use-controllable-state 1.0.0, 1.1.0
- @radix-ui/react-use-escape-keydown 1.1.0
- @radix-ui/react-use-layout-effect 1.0.0, 1.1.0
- @radix-ui/react-use-rect 1.1.0
- @radix-ui/react-use-size 1.1.0
- @radix-ui/rect 1.1.0
- @remotion/licensing 4.0.490
- @remotion/media-utils 4.0.490
- @remotion/streaming 4.0.490
- @remotion/studio 4.0.490
- @remotion/studio-shared 4.0.490
- @remotion/timeline-utils 4.0.490
- @remotion/zod-types 4.0.490
- @rspack/binding 1.7.11
- @rspack/binding-win32-x64-msvc 1.7.11
- @rspack/core 1.7.11
- @rspack/lite-tapable 1.1.0
- @rspack/plugin-react-refresh 1.6.1
- @scure/base 1.2.1
- @scure/starknet 1.1.0
- @standard-schema/spec 1.1.0
- @starknet-io/types-js 0.7.10
- @supercharge/promise-pool 3.3.0
- @tootallnate/quickjs-emscripten 0.23.0
- @types/aws-lambda 8.10.161
- @types/bunyan 1.8.11
- @types/connect 3.4.38
- @types/d3 7.4.3
- @types/d3-array 3.2.2
- @types/d3-axis 3.0.6
- @types/d3-brush 3.0.6
- @types/d3-chord 3.0.6
- @types/d3-color 3.1.3
- @types/d3-contour 3.0.6
- @types/d3-delaunay 6.0.4
- @types/d3-dispatch 3.0.7
- @types/d3-drag 3.0.7
- @types/d3-dsv 3.0.7
- @types/d3-ease 3.0.2
- @types/d3-fetch 3.0.7
- @types/d3-force 3.0.10
- @types/d3-format 3.0.4
- @types/d3-geo 3.1.0
- @types/d3-hierarchy 3.1.7
- @types/d3-interpolate 3.0.4
- @types/d3-path 3.1.1
- @types/d3-polygon 3.0.2
- @types/d3-quadtree 3.0.6
- @types/d3-random 3.0.4
- @types/d3-scale 4.0.9
- @types/d3-scale-chromatic 3.1.0
- @types/d3-selection 3.0.11
- @types/d3-shape 3.1.8
- @types/d3-time 3.0.4
- @types/d3-time-format 4.0.3
- @types/d3-timer 3.0.2
- @types/d3-transition 3.0.9
- @types/d3-zoom 3.0.8
- @types/debug 4.1.13
- @types/dom-mediacapture-transform 0.1.11
- @types/dom-webcodecs 0.1.13
- @types/eslint 9.6.1
- @types/eslint-scope 3.7.7
- @types/estree 1.0.9
- @types/geojson 7946.0.16
- @types/json-schema 7.0.15
- @types/memcached 2.2.10
- @types/ms 2.1.0
- @types/mysql 2.15.27
- @types/node 20.19.41, 22.7.5, 22.19.19
- @types/oracledb 6.5.2
- @types/pg 8.15.6
- @types/pg-pool 2.0.7
- @types/react 19.2.17
- @types/react-dom 19.2.3
- @types/tedious 4.0.14
- @types/trusted-types 2.0.7
- @types/yauzl 2.10.3
- @upsetjs/venn.js 2.0.0
- @webassemblyjs/ast 1.14.1
- @webassemblyjs/floating-point-hex-parser 1.13.2
- @webassemblyjs/helper-api-error 1.13.2
- @webassemblyjs/helper-buffer 1.14.1
- @webassemblyjs/helper-numbers 1.13.2
- @webassemblyjs/helper-wasm-bytecode 1.13.2
- @webassemblyjs/helper-wasm-section 1.14.1
- @webassemblyjs/ieee754 1.13.2
- @webassemblyjs/utf8 1.13.2
- @webassemblyjs/wasm-edit 1.14.1
- @webassemblyjs/wasm-gen 1.14.1
- @webassemblyjs/wasm-opt 1.14.1
- @webassemblyjs/wasm-parser 1.14.1
- @webassemblyjs/wast-printer 1.14.1
- @xyflow/react 12.11.2
- @xyflow/system 0.0.79
- accepts 1.3.8, 2.0.0
- acorn 8.16.0
- acorn-import-attributes 1.9.5
- acorn-import-phases 1.0.4
- adm-zip 0.5.18
- aes-js 3.0.0, 4.0.0-beta.5
- agent-base 6.0.2, 7.1.4
- ajv 8.20.0
- ajv-formats 2.1.1, 3.0.1
- ajv-keywords 5.1.0
- algosdk 1.24.1
- ansi-escapes 4.3.2
- ansi-regex 5.0.1, 6.2.2
- ansi-styles 4.3.0, 6.2.3
- ansicolors 0.3.2
- arconnect 0.4.2
- aria-hidden 1.2.6
- array-flatten 1.1.1
- arweave 1.15.7
- arweave-stream-tx 1.2.2
- asn1.js 5.4.1
- ast-types 0.13.4
- async-retry 1.3.3
- asynckit 0.4.0
- axios 1.16.1
- base-x 3.0.11
- base64-js 1.5.1
- base64url 3.0.1
- basic-ftp 5.3.1
- bech32 1.1.4
- bignumber.js 9.3.1
- binary-extensions 2.3.0
- bl 4.1.0
- bn.js 4.12.3, 5.2.3
- body-parser 1.20.5, 2.2.2
- boolean 3.2.0
- braces 3.0.3
- brorand 1.1.0
- browserslist 4.28.2
- bs58 4.0.1
- buffer 5.7.1, 6.0.3
- buffer-crc32 0.2.13
- buffer-from 1.1.2
- builder-util-runtime 9.7.0
- bytes 3.1.2
- call-bind-apply-helpers 1.0.2
- call-bound 1.0.4
- canvas-roundrect-polyfill 0.0.1
- cardinal 2.1.1
- chalk 4.1.2
- chardet 2.1.1
- chevrotain-allstar 0.3.1
- chokidar 3.6.0
- chrome-trace-event 1.0.4
- cjs-module-lexer 1.4.3, 2.2.0
- classcat 5.0.5
- cli-cursor 3.1.0
- cli-spinners 2.9.2
- clone 1.0.4
- clsx 1.1.1
- color-convert 2.0.1
- color-name 1.1.4
- combined-stream 1.0.8
- commander 2.20.3, 7.2.0, 8.3.0
- content-disposition 0.5.4, 1.1.0
- content-type 1.0.5, 2.0.0
- cookie 0.7.2, 1.1.1
- cookie-signature 1.0.7, 1.2.2
- cors 2.8.6
- cose-base 1.0.3, 2.2.0
- cross-env 7.0.3
- cross-fetch 3.2.0, 4.1.0
- cross-spawn 7.0.6
- css-loader 7.1.4
- cssesc 3.0.0
- csstype 3.2.3
- csv-parse 5.6.0
- csv-stringify 6.7.0
- cuint 0.2.2
- cytoscape 3.34.0
- cytoscape-cose-bilkent 4.1.0
- cytoscape-fcose 2.2.0
- dagre-d3-es 7.0.14
- data-uri-to-buffer 4.0.1, 6.0.2
- dayjs 1.11.21
- debug 2.6.9, 4.4.3
- defaults 1.0.4
- define-data-property 1.1.4
- define-lazy-prop 2.0.0
- define-properties 1.2.1
- degenerator 5.0.1
- delayed-stream 1.0.0
- depd 2.0.0
- destroy 1.2.0
- detect-node 2.1.0
- detect-node-es 1.1.0
- developer-icons 7.0.1
- dunder-proto 1.0.1
- ee-first 1.1.1
- electron-updater 6.8.9
- elliptic 6.6.1
- emoji-regex 8.0.0, 10.6.0
- encodeurl 2.0.0
- end-of-stream 1.4.5
- enhanced-resolve 5.24.1
- error-stack-parser 2.1.4
- es-define-property 1.0.1
- es-errors 1.3.0
- es-module-lexer 2.1.0
- es-object-atoms 1.1.1
- es-set-tostringtag 2.1.0
- es-toolkit 1.49.0
- es6-error 4.1.1
- es6-promise-pool 2.5.0
- esbuild 0.28.1
- escalade 3.2.0
- escape-html 1.0.3
- escape-string-regexp 1.0.5, 4.0.0
- etag 1.8.1
- ethers 6.13.4, 6.16.0
- events 3.3.0
- eventsource 3.0.7
- eventsource-parser 3.0.8
- execa 5.1.1
- express 4.22.2, 5.2.1
- express-rate-limit 8.5.2
- extend 3.0.2
- fast-deep-equal 3.1.3
- fast-fifo 1.3.2
- fast-glob 3.3.3
- fd-slicer 1.1.0
- fetch-blob 3.2.0
- figures 3.2.0
- fill-range 7.1.1
- finalhandler 1.3.2, 2.1.1
- follow-redirects 1.16.0
- form-data 4.0.5
- formdata-polyfill 4.0.10
- forwarded 0.2.0
- forwarded-parse 2.1.2
- fresh 0.5.2, 2.0.0
- fs-extra 10.1.0
- function-bind 1.1.2
- fuzzy 0.1.3
- get-east-asian-width 1.6.0
- get-intrinsic 1.3.0
- get-nonce 1.0.1
- get-proto 1.0.1
- get-stream 5.2.0, 6.0.1
- get-uri 6.0.5
- globalthis 1.0.4
- glur 1.1.2
- gopd 1.2.0
- hachure-fill 0.5.2
- has-flag 4.0.0
- has-property-descriptors 1.0.2
- has-symbols 1.1.0
- has-tostringtag 1.0.2
- hash.js 1.1.7
- hasown 2.0.3
- hi-base32 0.5.1
- hmac-drbg 1.0.1
- hono 4.12.22
- html-entities 2.6.0
- html-parse-stringify 3.0.1
- html-to-image 1.11.13
- http-errors 2.0.1
- http-proxy-agent 7.0.2
- https-proxy-agent 5.0.1, 7.0.6
- i18next 26.3.1
- i18next-resources-to-backend 1.2.1
- iconv-lite 0.4.24, 0.6.3, 0.7.2
- image-blob-reduce 3.0.1
- immutable 4.3.9
- import-meta-resolve 4.2.0
- inquirer 8.2.7
- ip-address 10.2.0
- ipaddr.js 1.9.1
- is-binary-path 2.1.0
- is-core-module 2.16.2
- is-docker 2.2.1
- is-extglob 2.1.1
- is-fullwidth-code-point 3.0.0
- is-glob 4.0.3
- is-interactive 1.0.0
- is-number 7.0.0
- is-promise 4.0.0
- is-stream 2.0.1
- is-unicode-supported 0.1.0
- is-wsl 2.2.0
- isomorphic-fetch 3.0.0
- jest-worker 27.5.1
- jose 6.2.3
- jotai 2.11.0
- jotai-scope 0.7.2
- js-sha256 0.9.0
- js-sha3 0.8.0
- js-sha512 0.8.0
- js-yaml 4.1.1
- json-bigint 1.0.0
- json-parse-even-better-errors 2.3.1
- json-schema-traverse 1.0.0
- jsonfile 6.2.1
- katex 0.16.47
- keccak 3.0.4
- langium 3.3.1
- layout-base 1.0.2, 2.0.1
- lazy-val 1.0.5
- loader-runner 4.3.2
- lodash 4.18.1
- lodash-es 4.17.21, 4.18.1
- lodash.camelcase 4.3.0
- lodash.debounce 4.0.8
- lodash.escaperegexp 4.1.2
- lodash.isequal 4.5.0
- lodash.sortby 4.7.0
- lodash.throttle 4.1.1
- log-symbols 4.1.0
- lossless-json 4.3.0
- marked 16.4.2
- matcher 3.0.0
- math-intrinsics 1.1.0
- media-typer 0.3.0, 1.1.0
- merge-descriptors 1.0.3, 2.0.0
- merge-stream 2.0.0
- merge2 1.4.1
- mermaid 11.16.0
- methods 1.1.2
- micromatch 4.0.8
- mime 1.6.0
- mime-db 1.52.0, 1.54.0
- mime-types 2.1.35, 3.0.2
- mimic-fn 2.1.0
- minimalistic-crypto-utils 1.0.1
- minizlib 3.1.0
- mitt 3.0.1
- modern-tar 0.7.6
- module-details-from-path 1.0.4
- ms 2.0.0, 2.1.3
- multimath 2.0.0
- multistream 4.1.0
- nanoid 3.3.3, 3.3.12, 4.0.2
- negotiator 0.6.3, 1.0.0
- neo-async 2.6.2
- netmask 2.1.1
- node-addon-api 2.0.2, 5.1.0, 7.1.1
- node-domexception 1.0.0
- node-fetch 2.7.0, 3.3.2
- node-gyp-build 4.8.4
- node-pty 1.1.0
- node-releases 2.0.44
- node-sqlite3-wasm 0.8.59
- nodejs-whisper 0.3.0
- normalize-path 3.0.0
- npm-run-path 4.0.1
- object-assign 4.1.1
- object-inspect 1.13.4
- object-keys 1.1.1
- on-finished 2.4.1
- onetime 5.1.2
- onnxruntime-common 1.21.0, 1.22.0-dev.20250409-89f8206ba4, 1.24.0-dev.20251116-b39e144322, 1.24.3
- onnxruntime-node 1.21.0, 1.24.3
- onnxruntime-web 1.22.0-dev.20250409-89f8206ba4, 1.26.0-dev.20260416-b7804b056c
- open 8.4.2
- open-color 1.9.1
- ora 5.4.1
- pac-proxy-agent 7.2.0
- pac-resolver 7.0.1
- package-manager-detector 1.7.0
- parseurl 1.3.3
- path-data-parser 0.1.0
- path-key 3.1.1
- path-parse 1.0.7
- path-to-regexp 0.1.13, 8.4.2
- pend 1.2.0
- perfect-freehand 1.2.0
- pg-protocol 1.14.0
- pg-types 2.2.0
- pica 7.1.1
- picomatch 2.3.2
- pkce-challenge 5.0.1
- platform 1.3.6
- png-chunk-text 1.0.0
- png-chunks-encode 1.0.0
- png-chunks-extract 1.0.0
- points-on-curve 0.2.0, 1.0.1
- points-on-path 0.2.1
- postcss 8.5.15
- postcss-modules-local-by-default 4.2.0
- postcss-selector-parser 7.1.4
- postcss-value-parser 4.2.0
- postgres-array 2.0.0
- postgres-bytea 1.0.1
- postgres-date 1.0.7
- postgres-interval 1.2.0
- progress 2.0.3
- proxy-addr 2.0.7
- proxy-agent 6.5.0
- proxy-from-env 1.1.0, 2.1.0
- psl 1.15.0
- pump 3.0.4
- punycode 2.3.1
- querystringify 2.2.0
- queue-microtask 1.2.3
- range-parser 1.2.1
- raw-body 2.5.3, 3.0.2
- react 19.2.7
- react-dom 19.2.7
- react-i18next 17.0.8
- react-refresh 0.18.0
- react-remove-scroll 2.7.2
- react-remove-scroll-bar 2.3.8
- react-router 7.15.1
- react-router-dom 7.15.1
- react-style-singleton 2.2.3
- readable-stream 3.6.2
- readdirp 3.6.0
- readline-sync 1.4.10
- redeyed 2.1.1
- require-directory 2.1.1
- require-from-string 2.0.2
- require-in-the-middle 7.5.2, 8.0.1
- requires-port 1.0.0
- resolve 1.22.12
- restore-cursor 3.1.0
- retry 0.13.1
- reusify 1.1.0
- roughjs 4.6.4, 4.6.6
- router 2.2.0
- run-async 2.4.1
- run-parallel 1.2.0
- safe-buffer 5.2.1
- safer-buffer 2.1.2
- sass 1.51.0
- scheduler 0.27.0
- schema-utils 4.3.3
- scrypt-js 3.0.1
- secp256k1 5.0.1
- semver-compare 1.0.0
- send 0.19.2, 1.2.1
- serialize-error 7.0.1
- serve-static 1.16.3, 2.2.1
- set-cookie-parser 2.7.2
- shebang-command 2.0.0
- shebang-regex 3.0.0
- side-channel 1.1.0
- side-channel-list 1.0.1
- side-channel-map 1.0.1
- side-channel-weakmap 1.0.2
- sliced 1.0.1
- smart-buffer 4.2.0
- socks 2.8.9
- socks-proxy-agent 8.0.5
- source-map-support 0.5.21
- stackframe 1.3.4
- starknet 6.24.1
- statuses 2.0.2
- streamx 2.28.0
- string_decoder 1.3.0
- string-width 4.2.3, 7.2.0
- strip-ansi 6.0.1, 7.2.0
- strip-final-newline 2.0.0
- style-loader 4.0.0
- stylis 4.4.0
- supports-color 7.2.0, 8.1.1
- supports-preserve-symlinks-flag 1.0.0
- systeminformation 5.31.7
- tapable 2.3.3
- tar-fs 3.1.3
- tar-stream 3.2.0
- teex 1.0.1
- temporal-polyfill 0.2.5
- terser-webpack-plugin 5.6.1
- through 2.3.8
- tiny-typed-emitter 2.1.0
- tinyexec 1.2.4
- tmp 0.2.5
- tmp-promise 3.0.3
- to-regex-range 5.0.1
- toidentifier 1.0.1
- tr46 0.0.3, 1.0.1
- ts-dedent 2.3.0
- ts-mixer 6.0.4
- tunnel-rat 0.1.2
- type-is 1.6.18, 2.1.0
- typed-query-selector 2.12.2
- ulid 2.4.0
- undici-types 6.19.8, 6.21.0
- universalify 0.2.0, 2.0.1
- unpipe 1.0.0
- update-browserslist-db 1.2.3
- url-parse 1.5.10
- use-callback-ref 1.3.3
- use-sidecar 1.1.3
- use-sync-external-store 1.6.0
- util-deprecate 1.0.2
- utils-merge 1.0.1
- uuid 14.0.1
- vary 1.1.2
- vlq 2.0.4
- void-elements 3.1.0
- vscode-jsonrpc 8.2.0
- vscode-languageserver 9.0.1
- vscode-languageserver-protocol 3.17.5
- vscode-languageserver-textdocument 1.0.12
- vscode-languageserver-types 3.17.5
- vscode-uri 3.0.8
- watchpack 2.5.2
- wcwidth 1.0.1
- web-streams-polyfill 3.3.3
- webpack 5.105.0
- webpack-sources 3.5.0
- webworkify 1.5.0
- whatwg-fetch 3.6.20
- whatwg-url 5.0.0, 7.1.0
- wrap-ansi 6.2.0, 7.0.0, 9.0.2
- ws 8.17.1, 8.18.0, 8.20.1, 8.21.0
- xtend 4.0.2
- xxhashjs 0.2.2
- yargs 17.7.2, 18.0.0
- yauzl 2.10.0
- zod 3.25.76, 4.3.6
- zustand 4.5.7

### Apache-2.0

- @ai-sdk/anthropic 4.0.18
- @ai-sdk/gateway 4.0.27
- @ai-sdk/openai-compatible 3.0.14
- @ai-sdk/provider 4.0.3
- @ai-sdk/provider-utils 5.0.12
- @chevrotain/cst-dts-gen 11.0.3
- @chevrotain/gast 11.0.3
- @chevrotain/regexp-to-ast 11.0.3
- @chevrotain/types 11.0.3, 11.1.2
- @chevrotain/utils 11.0.3
- @grpc/grpc-js 1.14.4
- @grpc/proto-loader 0.8.1
- @huggingface/tokenizers 0.1.3
- @huggingface/transformers 3.8.1, 4.2.0
- @inngest/agent-kit 0.13.2
- @inngest/ai 0.1.7
- @irys/bundles 0.0.3
- @opentelemetry/api 1.9.1
- @opentelemetry/api-logs 0.203.0, 0.218.0
- @opentelemetry/auto-instrumentations-node 0.76.0
- @opentelemetry/configuration 0.218.0
- @opentelemetry/context-async-hooks 2.7.1
- @opentelemetry/core 2.7.1
- @opentelemetry/exporter-logs-otlp-grpc 0.218.0
- @opentelemetry/exporter-logs-otlp-http 0.218.0
- @opentelemetry/exporter-logs-otlp-proto 0.218.0
- @opentelemetry/exporter-metrics-otlp-grpc 0.218.0
- @opentelemetry/exporter-metrics-otlp-http 0.218.0
- @opentelemetry/exporter-metrics-otlp-proto 0.218.0
- @opentelemetry/exporter-prometheus 0.218.0
- @opentelemetry/exporter-trace-otlp-grpc 0.218.0
- @opentelemetry/exporter-trace-otlp-http 0.218.0
- @opentelemetry/exporter-trace-otlp-proto 0.218.0
- @opentelemetry/exporter-zipkin 2.7.1
- @opentelemetry/instrumentation 0.203.0, 0.218.0
- @opentelemetry/instrumentation-amqplib 0.65.0
- @opentelemetry/instrumentation-aws-lambda 0.70.0
- @opentelemetry/instrumentation-aws-sdk 0.73.0
- @opentelemetry/instrumentation-bunyan 0.63.0
- @opentelemetry/instrumentation-cassandra-driver 0.63.0
- @opentelemetry/instrumentation-connect 0.61.0
- @opentelemetry/instrumentation-cucumber 0.34.0
- @opentelemetry/instrumentation-dataloader 0.35.0
- @opentelemetry/instrumentation-dns 0.61.0
- @opentelemetry/instrumentation-express 0.66.0
- @opentelemetry/instrumentation-fs 0.37.0
- @opentelemetry/instrumentation-generic-pool 0.61.0
- @opentelemetry/instrumentation-graphql 0.66.0
- @opentelemetry/instrumentation-grpc 0.218.0
- @opentelemetry/instrumentation-hapi 0.64.0
- @opentelemetry/instrumentation-http 0.218.0
- @opentelemetry/instrumentation-ioredis 0.66.0
- @opentelemetry/instrumentation-kafkajs 0.27.0
- @opentelemetry/instrumentation-knex 0.62.0
- @opentelemetry/instrumentation-koa 0.66.0
- @opentelemetry/instrumentation-lru-memoizer 0.62.0
- @opentelemetry/instrumentation-memcached 0.61.0
- @opentelemetry/instrumentation-mongodb 0.71.0
- @opentelemetry/instrumentation-mongoose 0.64.0
- @opentelemetry/instrumentation-mysql 0.64.0
- @opentelemetry/instrumentation-mysql2 0.64.0
- @opentelemetry/instrumentation-nestjs-core 0.64.0
- @opentelemetry/instrumentation-net 0.62.0
- @opentelemetry/instrumentation-openai 0.16.0
- @opentelemetry/instrumentation-oracledb 0.43.0
- @opentelemetry/instrumentation-pg 0.70.0
- @opentelemetry/instrumentation-pino 0.64.0
- @opentelemetry/instrumentation-redis 0.66.0
- @opentelemetry/instrumentation-restify 0.63.0
- @opentelemetry/instrumentation-router 0.62.0
- @opentelemetry/instrumentation-runtime-node 0.31.0
- @opentelemetry/instrumentation-socket.io 0.65.0
- @opentelemetry/instrumentation-tedious 0.37.0
- @opentelemetry/instrumentation-undici 0.28.0
- @opentelemetry/instrumentation-winston 0.62.0
- @opentelemetry/otlp-exporter-base 0.218.0
- @opentelemetry/otlp-grpc-exporter-base 0.218.0
- @opentelemetry/otlp-transformer 0.218.0
- @opentelemetry/propagator-b3 2.7.1
- @opentelemetry/propagator-jaeger 2.7.1
- @opentelemetry/redis-common 0.38.3
- @opentelemetry/resource-detector-alibaba-cloud 0.33.8
- @opentelemetry/resource-detector-aws 2.18.0
- @opentelemetry/resource-detector-azure 0.26.0
- @opentelemetry/resource-detector-container 0.8.9
- @opentelemetry/resource-detector-gcp 0.53.0
- @opentelemetry/resources 2.7.1
- @opentelemetry/sdk-logs 0.218.0
- @opentelemetry/sdk-metrics 2.7.1
- @opentelemetry/sdk-node 0.218.0
- @opentelemetry/sdk-trace-base 2.7.1
- @opentelemetry/sdk-trace-node 2.7.1
- @opentelemetry/semantic-conventions 1.41.1
- @opentelemetry/sql-common 0.41.2
- @puppeteer/browsers 2.13.2, 3.0.5
- @randlabs/communication-bridge 1.0.1
- @randlabs/myalgo-connect 1.4.2
- @traceloop/ai-semantic-conventions 0.20.0
- @traceloop/instrumentation-anthropic 0.20.0
- @vercel/oidc 3.2.0
- @webassemblyjs/leb128 1.13.2
- @workflow/serde 4.1.0
- @xtuc/long 4.2.2
- ai 7.0.35
- b4a 1.8.1
- bare-events 2.9.1
- bare-fs 4.7.2
- bare-os 3.9.2
- bare-path 3.0.1
- bare-stream 2.13.3
- bare-url 2.4.5
- baseline-browser-mapping 2.10.31
- browser-fs-access 0.29.1
- canonicalize 1.0.8
- chevrotain 11.0.3
- chromium-bidi 14.0.0
- crc-32 0.3.0
- detect-libc 2.1.2
- events-universal 1.0.1
- exponential-backoff 3.1.3
- flatbuffers 25.9.23
- gaxios 7.1.4
- gcp-metadata 8.1.2
- google-logging-utils 1.1.3
- human-signals 2.1.0
- import-in-the-middle 1.15.0, 3.0.1
- inngest 4.13.0
- kokoro-js 1.2.1
- long 5.3.2
- pdfjs-dist 6.1.200
- phonemizer 1.2.1
- puppeteer-core 24.43.1
- pwacompat 2.0.17
- rxjs 7.8.2
- sharp 0.34.5
- text-decoder 1.2.7
- typescript 5.9.3
- webdriver-bidi-protocol 0.4.1

### ISC

- @isaacs/fs-minipass 4.0.1
- abi-wan-kanabi 2.2.4
- algo-msgpack-with-bigint 2.1.1
- anymatch 3.1.3
- cli-width 3.0.0
- cliui 8.0.1, 9.0.1
- d3 7.9.0
- d3-array 3.2.4
- d3-axis 3.0.0
- d3-brush 3.0.0
- d3-chord 3.0.1
- d3-color 3.1.0
- d3-contour 4.0.2
- d3-delaunay 6.0.4
- d3-dispatch 3.0.1
- d3-drag 3.0.0
- d3-dsv 3.0.1
- d3-fetch 3.0.1
- d3-force 3.0.0
- d3-format 3.1.2
- d3-geo 3.1.1
- d3-hierarchy 3.1.2
- d3-interpolate 3.0.1
- d3-path 3.1.0
- d3-polygon 3.0.1
- d3-quadtree 3.0.1
- d3-random 3.0.1
- d3-scale 4.0.2
- d3-scale-chromatic 3.1.0
- d3-selection 3.0.0
- d3-shape 3.2.0
- d3-time 3.1.0
- d3-time-format 4.1.0
- d3-timer 3.0.1
- d3-transition 3.0.1
- d3-zoom 3.0.0
- delaunator 5.1.0
- electron-to-chromium 1.5.360
- fastq 1.20.1
- get-caller-file 2.0.5
- glob-parent 5.1.2
- graceful-fs 4.2.11
- guid-typescript 1.0.9
- icss-utils 5.1.0
- inherits 2.0.4
- internmap 1.0.1, 2.0.3
- isexe 2.0.0
- json-stringify-safe 5.0.1
- libsodium 0.8.4
- libsodium-wrappers 0.8.4
- lru-cache 6.0.0, 7.18.3
- minimalistic-assert 1.0.1
- mute-stream 0.0.8
- once 1.4.0
- pg-int8 1.0.1
- picocolors 1.1.1
- postcss-modules-extract-imports 3.1.0
- postcss-modules-scope 3.2.1
- postcss-modules-values 4.0.0
- semver 7.5.3, 7.7.4, 7.8.0
- setprototypeof 1.2.0
- signal-exit 3.0.7
- temporal-spec 0.2.4
- which 2.0.2
- wrappy 1.0.2
- y18n 5.0.8
- yallist 4.0.0
- yaml 2.9.0
- yargs-parser 21.1.1, 22.0.0
- zod-to-json-schema 3.25.2

### BSD-3-Clause

- @protobufjs/aspromise 1.1.2
- @protobufjs/base64 1.1.2
- @protobufjs/codegen 2.0.5
- @protobufjs/eventemitter 1.1.0
- @protobufjs/fetch 1.1.1
- @protobufjs/float 1.0.2
- @protobufjs/inquire 1.1.2
- @protobufjs/path 1.1.2
- @protobufjs/pool 1.1.0
- @protobufjs/utf8 1.1.1
- @xtuc/ieee754 1.2.0
- d3-array 2.12.1
- d3-ease 3.0.1
- d3-path 1.0.9
- d3-sankey 0.12.3
- d3-shape 1.3.7
- devtools-protocol 0.0.1608973
- diff 9.0.0
- fast-uri 3.1.2
- global-agent 3.0.0
- ieee754 1.2.1
- protobufjs 7.6.0
- qs 6.15.2
- roarr 2.15.4
- rw 1.3.3
- shelljs 0.10.0
- source-map 0.6.1, 0.8.0-beta.0
- source-map-js 1.2.1
- sprintf-js 1.1.3
- tough-cookie 4.1.4

### BSD-2-Clause

- dotenv 17.3.1
- escodegen 2.1.0
- eslint-scope 5.1.1
- esprima 4.0.1
- esrecurse 4.3.0
- estraverse 4.3.0, 5.3.0
- esutils 2.0.3
- extract-zip 2.0.1
- glob-to-regexp 0.4.1
- json-schema-typed 8.0.2
- terser 5.48.0
- webidl-conversions 3.0.1, 4.0.2

### Unknown

- @nookplot/runtime 0.5.156
- @nookplot/sdk 0.6.2
- @remotion/bundler 4.0.490
- @remotion/compositor-win32-x64-msvc 4.0.490
- @remotion/player 4.0.490
- @remotion/renderer 4.0.490
- @remotion/web-renderer 4.0.490
- khroma 2.1.0
- remotion 4.0.490

### BlueOak-1.0.0

- chownr 3.0.0
- minipass 7.1.3
- sax 1.6.0
- tar 7.5.19
- yallist 5.0.0

### Unlicense

- fetch-cookie 3.0.1
- fs-monkey 1.0.3
- memfs 3.4.3
- robust-predicates 3.0.3
- tweetnacl 1.0.3

### MPL-2.0

- @mediabunny/aac-encoder 1.50.8
- @mediabunny/flac-encoder 1.50.8
- @mediabunny/mp3-encoder 1.50.8
- mediabunny 1.50.8

### (Apache-2.0 AND BSD-3-Clause)

- @bufbuild/protobuf 2.12.0

### lgpl

- @dmitryrechkin/json-schema-to-zod 1.0.1

### Apache-2.0 AND LGPL-3.0-or-later

- @img/sharp-win32-x64 0.34.5

### Remotion License

- @remotion/canvas-capture 4.0.490

### Remotion License https://remotion.dev/license

- @remotion/media-parser 4.0.490

### Python-2.0

- argparse 2.0.1

### CC-BY-4.0

- caniuse-lite 1.0.30001793

### (MPL-2.0 OR Apache-2.0)

- dompurify 3.4.11

### EPL-2.0

- elkjs 0.11.1

### CC0-1.0

- fractional-indexing 3.2.0

### Standard 'no charge' license: https://gsap.com/standard-license.

- gsap 3.15.0

### (AFL-2.1 OR BSD-3-Clause)

- json-schema 0.4.0

### (MIT AND Zlib)

- pako 2.0.3, 2.1.0

### MIT-0

- serialize-error-cjs 0.1.4

### 0BSD

- tslib 2.7.0, 2.8.1

### (MIT OR CC0-1.0)

- type-fest 0.13.1, 0.21.3
