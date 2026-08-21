// apps/desktop/electron/services/stream-idle.ts
//
// Stream idle watchdog. If a provider socket stays open but stops sending
// (half-dead proxy, stuck upstream), reader.read() never settles and the
// conversation hangs until the user presses Stop. Race each read against an
// idle timer; on stall we abort the in-flight request so the caller's normal
// error path runs with a clear message instead of an infinite spinner.
//
// 120s is deliberately generous: local llama.cpp/Ollama on CPU can pause
// several seconds between tokens, but two minutes of ZERO bytes mid-stream
// means the upstream is gone.

export const STREAM_IDLE_TIMEOUT_MS = 120_000

// `aborter` is anything with an abort() method: chat-service passes its
// per-conversation AbortController (cancels the whole fetch); the streaming
// clients that only receive an AbortSignal pass a `{ abort: () => reader.cancel() }`
// wrapper instead (terminates the hung body stream). Either way the race
// below rejects with a clear stall message and the caller's normal error
// path runs.
export async function readOrIdleAbort<T>(
  read: () => Promise<T>,
  aborter: { abort(): void },
  idleMs = STREAM_IDLE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      aborter.abort()
      reject(new Error(`Stream stalled — no data received for ${Math.round(idleMs / 1000)}s.`))
    }, idleMs)
  })
  const readP = read()
  // If the idle timer wins, the raced read settles later (the abort surfaces
  // as a rejection) — attach a no-op handler so it can't become an
  // unhandledRejection. The race consumer still sees the original outcome.
  readP.catch(() => { /* settled via race */ })
  try {
    return await Promise.race([readP, idle])
  } finally {
    clearTimeout(timer)
  }
}
