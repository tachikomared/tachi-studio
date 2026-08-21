// test/unit/folderSettings.test.ts — F16 per-folder settings precedence:
// explicit > folder > global default, and absent settings are a strict no-op.
// Pure helper first (src/pages/chat/folder-settings.ts), then the store
// actions the feature added (togglePinned, setFolderDefaults) and the
// "new chat in folder adopts defaults" flow.
import { describe, it, expect, beforeEach } from 'vitest'

import {
  composeSystemMessage,
  effectiveNewConversationTarget,
  effectiveRagFolder,
  toFolderSendSettings,
} from '../../src/pages/chat/folder-settings'

// Same renderer-global stubs as chatFolders.test.ts: the persist middleware's
// async write path needs a localStorage shim in the node env, installed
// BEFORE the store module loads.
const memStore = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
}
;(globalThis as Record<string, unknown>).window = {
  tachi: { safeStorage: { isAvailable: async () => ({ available: false }) } },
}

const { useChatStore } = await import('../../src/store/chat.store')

// ── Pure helper: composeSystemMessage ────────────────────────────────────────

describe('composeSystemMessage', () => {
  it('prepends folder instructions before other parts', () => {
    expect(composeSystemMessage({ instructions: 'Talk like a pirate.' }, 'Skill prompt'))
      .toBe('Talk like a pirate.\n\nSkill prompt')
  })

  it('returns just the extra part when no folder settings exist (no-op)', () => {
    expect(composeSystemMessage(null, 'Skill prompt')).toBe('Skill prompt')
    expect(composeSystemMessage(undefined, 'Skill prompt')).toBe('Skill prompt')
  })

  it('returns just the instructions when no extra parts exist', () => {
    expect(composeSystemMessage({ instructions: 'Be terse.' })).toBe('Be terse.')
  })

  it('returns undefined when nothing survives (pre-F16 send shape)', () => {
    expect(composeSystemMessage(null)).toBeUndefined()
    expect(composeSystemMessage({}, '', null, undefined)).toBeUndefined()
  })

  it('drops whitespace-only parts and trims survivors', () => {
    expect(composeSystemMessage({ instructions: '  spaced  ' }, '   ', '\n\n', 'tail'))
      .toBe('spaced\n\ntail')
  })
})

// ── Pure helper: effectiveRagFolder ──────────────────────────────────────────

describe('effectiveRagFolder', () => {
  it('explicit attach always wins over the folder default', () => {
    expect(effectiveRagFolder('D:/mine', { ragFolder: 'D:/project' })).toBe('D:/mine')
  })

  it('falls back to the folder default when nothing is attached', () => {
    expect(effectiveRagFolder(undefined, { ragFolder: 'D:/project' })).toBe('D:/project')
    expect(effectiveRagFolder(null, { ragFolder: 'D:/project' })).toBe('D:/project')
    expect(effectiveRagFolder('', { ragFolder: 'D:/project' })).toBe('D:/project')
  })

  it('is a no-op without settings: undefined when neither exists', () => {
    expect(effectiveRagFolder(undefined, null)).toBeUndefined()
    expect(effectiveRagFolder(undefined, {})).toBeUndefined()
    expect(effectiveRagFolder(undefined)).toBeUndefined()
  })
})

// ── Pure helper: effectiveNewConversationTarget ──────────────────────────────

describe('effectiveNewConversationTarget', () => {
  const fallback = { providerId: 'freellmapi-local', model: 'auto' }

  it('returns the fallback unchanged when there is no folder (no-op)', () => {
    expect(effectiveNewConversationTarget(null, fallback)).toEqual(fallback)
    expect(effectiveNewConversationTarget(undefined, fallback)).toEqual(fallback)
    expect(effectiveNewConversationTarget({}, fallback)).toEqual(fallback)
  })

  it('adopts the folder provider + model when both are set', () => {
    expect(effectiveNewConversationTarget({ providerId: 'venice', model: 'llama-3.3-70b' }, fallback))
      .toEqual({ providerId: 'venice', model: 'llama-3.3-70b' })
  })

  it('provider without model falls to the auto sentinel, not the fallback model', () => {
    expect(effectiveNewConversationTarget({ providerId: 'venice' }, { providerId: 'x', model: 'gpt-x' }))
      .toEqual({ providerId: 'venice', model: 'auto' })
    expect(effectiveNewConversationTarget({ providerId: 'venice', model: '   ' }, fallback))
      .toEqual({ providerId: 'venice', model: 'auto' })
  })

  it('ignores a stray model without a provider (ambiguous across providers)', () => {
    expect(effectiveNewConversationTarget({ model: 'llama-3.3-70b' }, fallback)).toEqual(fallback)
  })

  it('ignores a whitespace-only providerId', () => {
    expect(effectiveNewConversationTarget({ providerId: '   ' }, fallback)).toEqual(fallback)
  })
})

// ── Pure helper: toFolderSendSettings ────────────────────────────────────────

describe('toFolderSendSettings', () => {
  it('maps ChatFolder-shaped fields onto send settings', () => {
    expect(toFolderSendSettings({
      systemPrompt: 'Be brief.',
      ragFolder: 'D:/docs',
      defaultProviderId: 'venice',
      defaultModel: 'llama-3.3-70b',
    })).toEqual({
      instructions: 'Be brief.',
      providerId: 'venice',
      model: 'llama-3.3-70b',
      ragFolder: 'D:/docs',
    })
  })

  it('is null-safe', () => {
    expect(toFolderSendSettings(null)).toBeNull()
    expect(toFolderSendSettings(undefined)).toBeNull()
  })
})

// ── Store: pinned chats + folder defaults ────────────────────────────────────

beforeEach(() => {
  useChatStore.setState({ conversations: [], folders: [], activeConversationId: null })
})

describe('chat store: pinned conversations (F16)', () => {
  it('togglePinned pins, then unpins back to undefined (old-blob shape)', () => {
    const id = useChatStore.getState().newConversation()
    useChatStore.getState().togglePinned(id)
    expect(useChatStore.getState().conversations[0].pinned).toBe(true)
    useChatStore.getState().togglePinned(id)
    expect(useChatStore.getState().conversations[0].pinned).toBeUndefined()
  })

  it('pinning does not touch updatedAt (must not reorder history)', () => {
    const id = useChatStore.getState().newConversation()
    const before = useChatStore.getState().conversations[0].updatedAt
    useChatStore.getState().togglePinned(id)
    expect(useChatStore.getState().conversations[0].updatedAt).toBe(before)
  })
})

describe('chat store: folder defaults (F16)', () => {
  it('sets and clears default provider/model', () => {
    const fid = useChatStore.getState().createFolder('P')
    useChatStore.getState().setFolderDefaults(fid, { providerId: 'venice', model: 'llama-3.3-70b' })
    let f = useChatStore.getState().folders[0]
    expect(f.defaultProviderId).toBe('venice')
    expect(f.defaultModel).toBe('llama-3.3-70b')

    useChatStore.getState().setFolderDefaults(fid, { model: null })
    f = useChatStore.getState().folders[0]
    expect(f.defaultProviderId).toBe('venice')
    expect(f.defaultModel).toBeUndefined()
  })

  it('clearing the provider clears the model too', () => {
    const fid = useChatStore.getState().createFolder('P')
    useChatStore.getState().setFolderDefaults(fid, { providerId: 'venice', model: 'llama-3.3-70b' })
    useChatStore.getState().setFolderDefaults(fid, { providerId: null })
    const f = useChatStore.getState().folders[0]
    expect(f.defaultProviderId).toBeUndefined()
    expect(f.defaultModel).toBeUndefined()
  })

  it('new chat in a folder adopts folder defaults (helper + store flow)', () => {
    const fid = useChatStore.getState().createFolder('P')
    useChatStore.getState().setFolderDefaults(fid, { providerId: 'venice', model: 'llama-3.3-70b' })
    const folder = useChatStore.getState().folders[0]

    // Same flow ChatHistory's folder [+] runs:
    const target = effectiveNewConversationTarget(
      toFolderSendSettings(folder),
      { providerId: 'freellmapi-local', model: 'auto' },
    )
    const id = useChatStore.getState().newConversation(target.providerId, target.model)
    useChatStore.getState().setConversationFolder(id, fid)

    const conv = useChatStore.getState().conversations.find(c => c.id === id)!
    expect(conv.providerId).toBe('venice')
    expect(conv.model).toBe('llama-3.3-70b')
    expect(conv.folderId).toBe(fid)
  })

  it('folder with NO defaults leaves the new chat on app defaults (no-op)', () => {
    const fid = useChatStore.getState().createFolder('P')
    const folder = useChatStore.getState().folders[0]
    const target = effectiveNewConversationTarget(
      toFolderSendSettings(folder),
      { providerId: 'freellmapi-local', model: 'auto' },
    )
    const id = useChatStore.getState().newConversation(target.providerId, target.model)
    useChatStore.getState().setConversationFolder(id, fid)
    const conv = useChatStore.getState().conversations.find(c => c.id === id)!
    expect(conv.providerId).toBe('freellmapi-local')
    expect(conv.model).toBe('auto')
  })
})
