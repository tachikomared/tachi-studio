import { describe, it, expect } from 'vitest'
import { groupMessages, sliceForFork } from '../../src/pages/chat/chat-branching'
import type { ChatMessage } from '../../src/store/chat.store'

const msg = (id: string, role: 'user' | 'assistant', content = 'x'): ChatMessage =>
  ({ id, role, content } as ChatMessage)

describe('groupMessages', () => {
  it('keeps a plain u/a/u/a conversation as one group per message', () => {
    const g = groupMessages([msg('1', 'user'), msg('2', 'assistant'), msg('3', 'user'), msg('4', 'assistant')])
    expect(g.map(x => x.versions.length)).toEqual([1, 1, 1, 1])
  })

  it('collapses consecutive assistant messages (regenerations) into versions', () => {
    const g = groupMessages([
      msg('1', 'user'), msg('2', 'assistant'), msg('3', 'assistant'), msg('4', 'assistant'),
      msg('5', 'user'), msg('6', 'assistant'),
    ])
    expect(g).toHaveLength(4)
    expect(g[1].anchorId).toBe('2')
    expect(g[1].versions.map(v => v.id)).toEqual(['2', '3', '4'])
    expect(g[3].versions.map(v => v.id)).toEqual(['6'])
  })

  it('a leading assistant message forms its own group', () => {
    const g = groupMessages([msg('1', 'assistant'), msg('2', 'assistant'), msg('3', 'user')])
    expect(g).toHaveLength(2)
    expect(g[0].versions).toHaveLength(2)
  })

  it('empty input → empty output', () => {
    expect(groupMessages([])).toEqual([])
  })

  it('media-part and panel messages never join a version group', () => {
    const media = { id: 'm', role: 'assistant', content: [{ type: 'image', b64: 'x' }] } as unknown as ChatMessage
    const panel = { id: 'p', role: 'assistant', content: 'pick', panelMembers: [{}] } as unknown as ChatMessage
    const g = groupMessages([msg('1', 'user'), msg('2', 'assistant'), media, panel, msg('5', 'assistant')])
    expect(g.map(x => x.versions.length)).toEqual([1, 1, 1, 1, 1])
  })
})

describe('sliceForFork', () => {
  const msgs = [msg('a', 'user', 'q1'), msg('b', 'assistant', 'a1'), msg('c', 'user', 'q2')]
  let n = 0
  const newId = () => `new-${++n}`

  it('copies up to and including the target with FRESH ids', () => {
    const out = sliceForFork(msgs, 'b', newId)!
    expect(out).toHaveLength(2)
    expect(out.map(m => m.content)).toEqual(['q1', 'a1'])
    expect(out.every(m => m.id.startsWith('new-'))).toBe(true)
    // deep copy — mutating the fork must not touch the original
    ;(out[0] as { content: string }).content = 'MUTATED'
    expect(msgs[0].content).toBe('q1')
  })

  it('unknown id → null', () => {
    expect(sliceForFork(msgs, 'zzz', newId)).toBeNull()
  })

  it('clears streaming flags on the copies', () => {
    const streaming = [{ ...msg('s', 'assistant'), streaming: true } as ChatMessage]
    const out = sliceForFork(streaming, 's', newId)!
    expect(out[0].streaming).toBe(false)
  })
})
