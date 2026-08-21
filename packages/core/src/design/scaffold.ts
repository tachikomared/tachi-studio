// Version stamp embedded in every generated preview scaffold (Remotion Player
// pages + HyperFrames preview wrappers). The Design tab PERSISTS the baked
// preview html per message, so every scaffold improvement (opaque-origin shim,
// shared-audio pool, clip windowing…) would otherwise never reach sessions
// generated before it — their previews replay the stale scaffold forever.
// DesignPage compares the baked html against DESIGN_SCAFFOLD_MARK and rebuilds
// the preview from the stored composition code when the stamp is missing or
// old. Bump the version whenever any preview scaffold changes behavior.
export const DESIGN_SCAFFOLD_VERSION = 2
export const DESIGN_SCAFFOLD_MARK = `<!--tachi-scaffold:${DESIGN_SCAFFOLD_VERSION}-->`
