// apps/desktop/src/pages/nodes/templates/summarizeUrl.ts
//
// Summarize a URL — an Internet-granted agent fetches the page named in the
// Text node and produces a structured summary. Web tools need a tool-capable
// model, so the provider defaults to Bankr/Claude.
// Mirror: examples/flows/summarize-url.tachiflow.json.

import type { FlowTemplate } from './tachiflow'

export const summarizeUrl: FlowTemplate = {
  id: 'summarize-url',
  label: 'Summarize a URL',
  description: 'Paste a link into the Text node — a web-enabled agent fetches the page and summarizes it. Needs a Bankr key.',
  file: {
    format: 'tachiflow',
    formatVersion: 1,
    app: 'tachi-studio',
    appVersion: '0.1.0',
    exportedAt: '2026-07-11T00:00:00.000Z',
    flow: {
      version: 1,
      name: 'Summarize a URL',
      savedAt: '2026-07-11T00:00:00.000Z',
      nodes: [
        {
          id: 'url-prov',
          type: 'provider',
          position: { x: 40, y: 40 },
          data: { label: 'Bankr', providerId: 'bankr', endpoint: 'llm.bankr.bot/v1', model: 'claude-sonnet-4.6' },
        },
        {
          id: 'url-net',
          type: 'internet',
          position: { x: 40, y: 220 },
          data: { label: 'Internet' },
        },
        {
          id: 'url-input',
          type: 'text',
          position: { x: 40, y: 380 },
          data: {
            label: 'URL',
            text: 'https://example.com — replace with the page you want summarized.',
            lastOutput: 'https://example.com — replace with the page you want summarized.',
          },
        },
        {
          id: 'url-agent',
          type: 'agent',
          position: { x: 440, y: 200 },
          data: {
            label: 'URL summarizer',
            harnessId: 'openclaude',
            systemPrompt: 'Fetch the URL given in the message with your web tool, then produce a structured summary: 1) a one-line TL;DR, 2) the 5 key points, 3) notable quotes with attribution. If the fetch fails, say exactly why.',
            final: true,
          },
        },
      ],
      edges: [
        { id: 'url-e1', source: 'url-prov', target: 'url-agent', sourceHandle: 'E-src', targetHandle: 'NW-tgt', type: 'link', data: {} },
        { id: 'url-e2', source: 'url-net', target: 'url-agent', sourceHandle: 'E-src', targetHandle: 'W-tgt', type: 'link', data: {} },
        { id: 'url-e3', source: 'url-input', target: 'url-agent', sourceHandle: 'E-src', targetHandle: 'SW-tgt', type: 'link', data: { instruction: 'the page to summarize' } },
      ],
    },
  },
}
