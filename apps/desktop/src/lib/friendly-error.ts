// apps/desktop/src/lib/friendly-error.ts
//
// Turn a raw provider/agent error into { title, detail } where title is
// localized ACTIONABLE copy ("add a key in Settings") and detail is the raw
// text for debugging. Unknown errors keep the raw text as the title so we
// never hide information — this only upgrades the knowable cases.

import type { TFunction } from 'i18next'
// Deep import (not the '@tachi/core' barrel) so the renderer bundle doesn't pull
// node-only provider modules (e.g. bankr-provider's randomUUID) into its graph.
import { classifyProviderError, type ProviderErrorKind } from '@tachi/core/src/chat/classify-error'

const KEY_BY_KIND: Record<Exclude<ProviderErrorKind, 'unknown'>, string> = {
  'no-key':         'common:errors.noKey',
  'auth':           'common:errors.auth',
  'rate-limit':     'common:errors.rateLimit',
  'quota':          'common:errors.quota',
  'context-length': 'common:errors.contextLength',
  'network':        'common:errors.network',
  'upstream':       'common:errors.upstream',
}

export interface FriendlyError {
  title: string
  /** Raw provider text — show small/muted under the title; absent when it IS the title. */
  detail?: string
}

export function friendlyError(t: TFunction, raw: string | undefined | null): FriendlyError {
  const text = (raw ?? '').trim()
  const kind = classifyProviderError(text)
  if (kind === 'unknown') return { title: text || t('common:errors.generic') }
  return { title: t(KEY_BY_KIND[kind]), detail: text || undefined }
}
