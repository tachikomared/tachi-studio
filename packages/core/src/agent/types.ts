/**
 * The four recognised slash commands in the agent input bar.
 *
 * Canonical home for the union — re-exported via `@tachi/core` and consumed by
 * both the renderer (slash-parser, slash-commands types) and the main process
 * (chat-service.ts) so all three layers stay in lock-step.
 */
export type SlashCommand = 'troubleshoot' | 'refactor' | 'review' | 'plan'

/**
 * Parsed slash-command metadata attached to user-text events when the input
 * starts with one of the four recognised commands (/troubleshoot, /refactor,
 * /review, /plan).
 *
 * Canonical home — single source of truth. The renderer's slash-parser.ts and
 * the renderer's slash-commands.ts both re-export this type from `@tachi/core`;
 * the main-process chat-service.ts imports it directly. The previous
 * AgentParsedSlashCommand alias is preserved below for backward compatibility.
 */
export interface ParsedSlashCommand {
  /** Which slash command was invoked. */
  command: SlashCommand
  flags:   {
    /** Whether `--fix` was passed anywhere after the command token. */
    fix: boolean
  }
  /** Everything after the command name (and any recognised flag tokens), trimmed. */
  rawArgs: string
}

/**
 * @deprecated Use {@link ParsedSlashCommand} instead. Retained for
 * backward compatibility with electron.d.ts callers that imported the old name.
 */
export type AgentParsedSlashCommand = ParsedSlashCommand

/** A single renderable event produced by an agent harness (TACHI, OpenClaude, …). */
export type AgentEvent =
  | { type: 'text';      text: string }
  /**
   * User-authored message echoed into the log immediately on send.
   * `parsedCommand` is present when the input was a recognised slash command.
   */
  | { type: 'user-text'; text: string; parsedCommand?: ParsedSlashCommand }
  | { type: 'tool-call'; name: string; input: string }
  /** `exitCode` (when known) lets the deterministic compactor apply its
   *  failure-aware rules; non-zero ⇒ the command/tool failed. */
  | { type: 'tool-done'; name: string; output: string; exitCode?: number }
  /**
   * Fusion fan-out receipt — surfaced when the agent consults a model panel
   * (`consult_panel`) or fuses a plan (`fuse_plan`). Lets the UI SHOW the panel:
   * which models answered (`ok`) vs failed (e.g. a tripped circuit-breaker leg),
   * each answer's size, and which model judged/synthesized. `mode` distinguishes
   * a plan fusion from a general consult. Observability only — not gated, and
   * not recorded to the JSONL trace (live transcript surface, ephemeral). */
  | { type: 'fusion-panel'; members: { model: string; ok: boolean; chars: number; text?: string }[]; judge: string; mode: 'plan' | 'synthesis'; brief: string; providerId: string }
  /**
   * CONNECTION RESILIENCE. Emitted when a round's model request/stream died on
   * a RETRYABLE transport failure and the loop is about to re-request it. The
   * run is NOT over — the UI shows "connection lost — retrying n/10 (next in
   * Xs)" where the run status already lives, and clears it on
   * `reconnect-resolved`. `reason` is the classifier tag (econnreset,
   * premature-close, http-503 …), useful in the trace, not shown verbatim.
   */
  | { type: 'reconnect'; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  /** The re-requested round streamed successfully — clear the retry banner. */
  | { type: 'reconnect-resolved' }
  /**
   * LOOP MODE. Emitted by the loop controller at the START of each cycle of a
   * `/loop` run: the UI shows a "LOOP n/cap" chip (with STOP LOOP) next to the
   * run status. Like `reconnect`, this is live STATUS, not transcript — it does
   * not enter the message list.
   */
  | { type: 'loop'; iteration: number; cap: number; goal: string }
  /** The loop stopped (cap, goal reached, spend cap, user stop, abort). */
  | { type: 'loop-ended'; iterations: number; reason: string }
  | { type: 'error';     message: string }
  /**
   * Terminal event. `reason` is unchanged (stop / error / abort).
   *
   * GAVE-UP DETECTION (additive, all optional — every existing emitter and
   * consumer keeps working): a provider finish-reason `stop` does NOT prove the
   * task was finished. When the harness's end-state classifier says the run
   * merely STOPPED — no accepted completion call, nothing said, or a
   * mutating-intent task that changed nothing, or a pass that ended ON tool
   * output with no closing word — it sets `incomplete` and the UI renders an
   * amber "ENDED WITHOUT COMPLETING" badge with a CONTINUE affordance instead
   * of the success checkmark. `nudged` records that the loop already spent its
   * one automatic continuation attempt on this run.
   */
  | { type: 'done';      reason: string; incomplete?: boolean; incompleteCode?: 'empty-text' | 'no-completion' | 'silent-finish'; incompleteDetail?: string; nudged?: boolean }
