// test/unit/chatFolders.test.ts — chat folders (projects) store logic:
// create/rename/delete (unfiles, never deletes convs), move, project powers.
import { describe, it, expect, beforeEach } from 'vitest'

// Same renderer-global stubs as chatStore.test.ts: the persist middleware's
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

beforeEach(() => {
  useChatStore.setState({ conversations: [], folders: [], activeConversationId: null })
})

describe('chat folders', () => {
  it('creates a folder with a trimmed name', () => {
    const id = useChatStore.getState().createFolder('  My Project  ')
    const f = useChatStore.getState().folders.find(x => x.id === id)
    expect(f?.name).toBe('My Project')
    expect(f?.createdAt).toBeTruthy()
  })

  it('falls back to a default name when blank', () => {
    const id = useChatStore.getState().createFolder('   ')
    expect(useChatStore.getState().folders.find(x => x.id === id)?.name).toBe('Project')
  })

  it('renames, keeping the old name on blank input', () => {
    const id = useChatStore.getState().createFolder('A')
    useChatStore.getState().renameFolder(id, 'B')
    expect(useChatStore.getState().folders.find(x => x.id === id)?.name).toBe('B')
    useChatStore.getState().renameFolder(id, '   ')
    expect(useChatStore.getState().folders.find(x => x.id === id)?.name).toBe('B')
  })

  it('moves conversations in and out of folders', () => {
    const convId = useChatStore.getState().newConversation()
    const fid = useChatStore.getState().createFolder('P')
    useChatStore.getState().setConversationFolder(convId, fid)
    expect(useChatStore.getState().conversations[0].folderId).toBe(fid)
    useChatStore.getState().setConversationFolder(convId, null)
    expect(useChatStore.getState().conversations[0].folderId).toBeUndefined()
  })

  it('deleteFolder unfiles its conversations but never deletes them', () => {
    const convId = useChatStore.getState().newConversation()
    const fid = useChatStore.getState().createFolder('P')
    useChatStore.getState().setConversationFolder(convId, fid)
    useChatStore.getState().deleteFolder(fid)
    const s = useChatStore.getState()
    expect(s.folders).toHaveLength(0)
    expect(s.conversations).toHaveLength(1)
    expect(s.conversations[0].folderId).toBeUndefined()
  })

  it('stores a project system prompt and clears it on blank', () => {
    const fid = useChatStore.getState().createFolder('P')
    useChatStore.getState().setFolderSystemPrompt(fid, 'Answer like a pirate.')
    expect(useChatStore.getState().folders[0].systemPrompt).toBe('Answer like a pirate.')
    useChatStore.getState().setFolderSystemPrompt(fid, '   ')
    expect(useChatStore.getState().folders[0].systemPrompt).toBeUndefined()
  })

  it('attaches and detaches a knowledge folder', () => {
    const fid = useChatStore.getState().createFolder('P')
    useChatStore.getState().setFolderRagFolder(fid, 'D:/docs')
    expect(useChatStore.getState().folders[0].ragFolder).toBe('D:/docs')
    useChatStore.getState().setFolderRagFolder(fid, null)
    expect(useChatStore.getState().folders[0].ragFolder).toBeUndefined()
  })

  it('toggles collapsed state', () => {
    const fid = useChatStore.getState().createFolder('P')
    useChatStore.getState().toggleFolderCollapsed(fid)
    expect(useChatStore.getState().folders[0].collapsed).toBe(true)
    useChatStore.getState().toggleFolderCollapsed(fid)
    expect(useChatStore.getState().folders[0].collapsed).toBe(false)
  })
})
