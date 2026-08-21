// apps/desktop/src/store/prompts.store.ts
//
// The PROMPT LIBRARY (Phase 2 #3): reusable templates with {{variable}} slots,
// shared by the chat input picker and the Nodes Prompt-node picker. Syntax
// helpers live in @tachi/core (prompts/template.ts); this store only owns
// persistence + CRUD. Seeded with the starter set on first run.
//
// zustand + persist over localStorage ('tachi-prompts-v1') — templates are
// not secrets; keep them greppable on disk like other non-key stores.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { starterTemplates, type PromptTemplate } from '@tachi/core/src/prompts/template'

const TEMPLATE_CAP = 200

interface PromptsState {
  templates: PromptTemplate[]
  seeded: boolean
  ensureSeeded(): void
  add(input: { title: string; body: string; tag?: string }): PromptTemplate
  update(id: string, patch: Partial<Pick<PromptTemplate, 'title' | 'body' | 'tag'>>): void
  remove(id: string): void
}

export const usePromptsStore = create<PromptsState>()(
  persist(
    (set, get) => ({
      templates: [],
      seeded: false,

      ensureSeeded() {
        const s = get()
        if (s.seeded || s.templates.length > 0) {
          if (!s.seeded) set({ seeded: true })
          return
        }
        set({ templates: starterTemplates(), seeded: true })
      },

      add(input) {
        const now = Date.now()
        const tpl: PromptTemplate = {
          id: `tpl-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          title: input.title.trim() || 'Untitled',
          body: input.body,
          tag: input.tag?.trim() || undefined,
          createdAt: now,
          updatedAt: now,
        }
        set(s => ({ templates: [tpl, ...s.templates].slice(0, TEMPLATE_CAP) }))
        return tpl
      },

      update(id, patch) {
        set(s => ({
          templates: s.templates.map(tpl =>
            tpl.id === id ? { ...tpl, ...patch, updatedAt: Date.now() } : tpl),
        }))
      },

      remove(id) {
        set(s => ({ templates: s.templates.filter(tpl => tpl.id !== id) }))
      },
    }),
    { name: 'tachi-prompts-v1', storage: createJSONStorage(() => localStorage) },
  ),
)
