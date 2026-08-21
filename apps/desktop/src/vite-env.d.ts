// Minimal Vite ambient types for the renderer typecheck. We declare only what
// we use (import.meta.glob) instead of referencing "vite/client": vite is a
// transitive dep (via electron-vite), and pnpm's strict node_modules doesn't
// reliably resolve vite/client's glob augmentation from here. Vite itself still
// performs the real glob transform at build/dev time regardless of these types.
interface ImportMeta {
  readonly glob: (
    pattern: string | string[],
    options?: { eager?: boolean; query?: string; import?: string },
  ) => Record<string, () => Promise<unknown>>
}

// Static image assets (the claw art OpusChrome masks its engraving with) —
// Vite emits a URL.
declare module '*.png' {
  const url: string
  export default url
}

// Vite `?worker` imports (used by lib/monaco-setup for Monaco's language workers).
// The default export is a constructable Worker. Vite performs the real worker
// transform at build/dev time; this just types the import for tsc.
declare module '*?worker' {
  const workerConstructor: { new (): Worker }
  export default workerConstructor
}
