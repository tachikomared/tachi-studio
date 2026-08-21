// PROJECT-scoped design context: attach once → persists on the project,
// rides every prompt, survives session switches; per-project isolation.
import { describe, it, expect, beforeEach } from 'vitest'
import { useDesignStore } from '../../src/store/design.store'

const reset = () => useDesignStore.setState({
  projects: [], activeProjectId: null, projectCtx: {}, sessions: [], activeId: null,
})

describe('design project context', () => {
  beforeEach(reset)

  it('self-creates a default project when attaching before any project exists', () => {
    useDesignStore.getState().addProjectCtx({ id: 'a', label: '0.mp4', text: 'ASSET' })
    const s = useDesignStore.getState()
    expect(s.projects.length).toBe(1)
    expect(s.activeProjectId).toBe(s.projects[0].id)
    expect(s.projectCtx[s.activeProjectId!]).toEqual([{ id: 'a', label: '0.mp4', text: 'ASSET' }])
  })

  it('replaces a same-label re-attach instead of duplicating', () => {
    const st = useDesignStore.getState()
    st.addProjectCtx({ id: 'a', label: '0.mp4', text: 'old' })
    useDesignStore.getState().addProjectCtx({ id: 'b', label: '0.mp4', text: 'new' })
    const s = useDesignStore.getState()
    expect(s.projectCtx[s.activeProjectId!]).toEqual([{ id: 'b', label: '0.mp4', text: 'new' }])
  })

  it('removes by item id', () => {
    useDesignStore.getState().addProjectCtx({ id: 'a', label: 'x', text: 't' })
    useDesignStore.getState().removeProjectCtx('a')
    const s = useDesignStore.getState()
    expect(s.projectCtx[s.activeProjectId!]).toEqual([])
  })

  it('keeps context per-project and drops it with the project', () => {
    useDesignStore.getState().addProjectCtx({ id: 'a', label: 'in-A', text: 't' })
    const aId = useDesignStore.getState().activeProjectId!
    const bId = useDesignStore.getState().newProject('B')
    useDesignStore.getState().addProjectCtx({ id: 'b', label: 'in-B', text: 't' })
    expect(useDesignStore.getState().projectCtx[aId].map(c => c.label)).toEqual(['in-A'])
    expect(useDesignStore.getState().projectCtx[bId].map(c => c.label)).toEqual(['in-B'])
    useDesignStore.getState().deleteProject(bId)
    const s = useDesignStore.getState()
    expect(s.projectCtx[bId]).toBeUndefined()
    expect(s.projectCtx[aId].length).toBe(1)
  })

  it('context survives session churn (newSession/loadSession leave it alone)', () => {
    useDesignStore.getState().addProjectCtx({ id: 'a', label: 'folder/', text: 'ctx' })
    const pid = useDesignStore.getState().activeProjectId!
    useDesignStore.getState().newSession()
    useDesignStore.getState().addUser('first prompt')
    useDesignStore.getState().newSession()
    useDesignStore.getState().addUser('second prompt')
    const s = useDesignStore.getState()
    expect(s.projectCtx[pid].map(c => c.label)).toEqual(['folder/'])
    expect(s.activeProjectId).toBe(pid)
  })
})
