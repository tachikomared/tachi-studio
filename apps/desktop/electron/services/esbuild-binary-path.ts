// apps/desktop/electron/services/esbuild-binary-path.ts
//
// MUST be imported before anything that loads 'esbuild' (@remotion/bundler
// pulls it at import time): esbuild CAPTURES process.env.ESBUILD_BINARY_PATH
// into a module-level const at load (lib/main.js ~1889), so setting it later
// is a no-op. In packaged builds esbuild otherwise resolves its exe to a path
// INSIDE app.asar — an exe can't be spawned from an archive, and every MP4
// export died with "spawn ...app.asar...esbuild.exe ENOENT" (verified on a
// real NSIS install). The binary IS on disk via asarUnpack — point at it.
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

if (app.isPackaged && !process.env.ESBUILD_BINARY_PATH) {
  const pkg = `${process.platform}-${process.arch}` // @esbuild/win32-x64 etc.
  const bin = process.platform === 'win32'
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', pkg, 'esbuild.exe')
    : join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', pkg, 'bin', 'esbuild')
  if (existsSync(bin)) process.env.ESBUILD_BINARY_PATH = bin
  else console.warn(`[esbuild-binary-path] unpacked esbuild binary not found at ${bin} — MP4 export may fail`)
}

export {}
