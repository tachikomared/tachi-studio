// apps/desktop/src/pages/nodes/templates/ragOverFolder.ts
//
// RAG over a folder — a single Q&A agent grounded in a workspace folder:
// Folder (pick your docs) + read-only Role + Bankr/Claude provider (reliable
// tool-calling). Mirror: examples/flows/rag-over-folder.tachiflow.json.

import type { FlowTemplate } from './tachiflow'

export const ragOverFolder: FlowTemplate = {
  id: 'rag-over-folder',
  label: 'RAG over a folder',
  description: 'Pick a folder, ask questions — the agent searches your files and answers with citations. Needs a Bankr key.',
  file: {
    format: 'tachiflow',
    formatVersion: 1,
    app: 'tachi-studio',
    appVersion: '0.1.0',
    exportedAt: '2026-07-11T00:00:00.000Z',
    flow: {
      version: 1,
      name: 'RAG over a folder',
      savedAt: '2026-07-11T00:00:00.000Z',
      nodes: [
        {
          id: 'rag-prov',
          type: 'provider',
          position: { x: 40, y: 40 },
          data: { label: 'Bankr', providerId: 'bankr', endpoint: 'llm.bankr.bot/v1', model: 'claude-sonnet-4.6' },
        },
        {
          id: 'rag-folder',
          type: 'folder',
          position: { x: 40, y: 240 },
          data: { label: 'Knowledge folder', path: '' },
        },
        {
          id: 'rag-role',
          type: 'skill',
          position: { x: 40, y: 440 },
          data: { label: 'Read only', skillId: 'rag-role', description: '', allowedTools: ['Read', 'Glob', 'Grep'] },
        },
        {
          id: 'rag-agent',
          type: 'agent',
          position: { x: 440, y: 220 },
          data: {
            label: 'Folder Q&A',
            harnessId: 'openclaude',
            systemPrompt: 'You answer questions using ONLY the files in the connected folder. Use semantic_search and file reads to find the relevant passages, quote them, and cite the file paths. If the answer is not in the folder, say so plainly.',
            final: true,
          },
        },
      ],
      edges: [
        { id: 'rag-e1', source: 'rag-prov', target: 'rag-agent', sourceHandle: 'E-src', targetHandle: 'NW-tgt', type: 'link', data: {} },
        { id: 'rag-e2', source: 'rag-folder', target: 'rag-agent', sourceHandle: 'E-src', targetHandle: 'W-tgt', type: 'link', data: {} },
        { id: 'rag-e3', source: 'rag-role', target: 'rag-agent', sourceHandle: 'E-src', targetHandle: 'SW-tgt', type: 'link', data: {} },
      ],
    },
  },
}
