// apps/desktop/src/pages/nodes/templates/index.ts
//
// Curated starter flows (UX-benchmark #12a/b). Each template is a complete
// .tachiflow.json document authored as a TS module — REAL node types, wired
// with valid handles, placeholder prompts, and nothing that auto-runs.
// Byte-identical copies live in repo-root examples/flows/ (the shareable
// gallery seed); test/unit/tachiflowPortability.test.ts enforces parity.
//
// Instantiating a template MUST go through remapFlowIds() (see tachiflow.ts)
// so two instances never share node ids.

import type { FlowTemplate } from './tachiflow'
import { multiAgentResearch } from './multiAgentResearch'
import { compareTwoModels }   from './compareTwoModels'
import { ragOverFolder }      from './ragOverFolder'
import { promptToImage }      from './promptToImage'
import { summarizeUrl }       from './summarizeUrl'
import { brainstormDecide }   from './brainstormDecide'
import { geoAudit }           from './geoAudit'

export type { FlowTemplate, TachiflowFile } from './tachiflow'

/** Rail order: free/no-key templates first, key-needing ones after. */
export const FLOW_TEMPLATES: FlowTemplate[] = [
  multiAgentResearch,
  brainstormDecide,
  promptToImage,
  compareTwoModels,
  ragOverFolder,
  summarizeUrl,
  // BATCH35 lane B — GEO audit. Free/no-key like the first two, but it lands
  // last because it is the only one that wants a page PASTED in before it says
  // anything useful; the rail's "free first" order is about zero-setup value.
  geoAudit,
]

/** The three templates surfaced as empty-canvas starter cards. */
export const STARTER_CARD_TEMPLATES: FlowTemplate[] = FLOW_TEMPLATES.slice(0, 3)
