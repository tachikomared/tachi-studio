# Flow gallery — `.tachiflow.json`

Shareable starter flows for the TACHI STUDIO **Nodes** canvas. Import any file
here via **Nodes → Flows rail → IMPORT**, or export your own flows with the
per-flow `⇩` button and share them.

## Format

```json
{
  "format": "tachiflow",
  "formatVersion": 1,
  "app": "tachi-studio",
  "appVersion": "0.1.0",
  "exportedAt": "<ISO 8601>",
  "flow": { "version": 1, "name": "...", "nodes": [], "edges": [], "savedAt": "<ISO 8601>" }
}
```

Node/edge ids are regenerated on import, so importing the same file twice is safe.

## Included flows

| File | What it does | Keys needed |
| --- | --- | --- |
| `multi-agent-research.tachiflow.json` | Researcher → Analyst → Writer chain over your topic | none (free router) |
| `brainstorm-decide.tachiflow.json` | Optimist / Skeptic / Decider deliberation triangle | none (free router) |
| `prompt-to-image.tachiflow.json` | Free model writes an image prompt → Image node | Surplus for the image gen |
| `compare-two-models.tachiflow.json` | Two models answer the same question, a judge picks the winner | Bankr for Model B |
| `rag-over-folder.tachiflow.json` | Q&A agent grounded in a folder you pick (read-only tools) | Bankr |
| `summarize-url.tachiflow.json` | Web-enabled agent fetches a URL and summarizes it | Bankr |
| `geo-audit.tachiflow.json` | Generative-engine-optimization audit: inventory → answer-engine simulation → fixes → graded report card | none (free router) |

These files are byte-mirrors of the in-app templates
(`apps/desktop/src/pages/nodes/templates/`); parity is enforced by
`apps/desktop/test/unit/tachiflowPortability.test.ts`.
