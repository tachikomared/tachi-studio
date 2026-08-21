# Agents and automation

## Coding agents

![The agent workspace](media/code-agent.png)

Point an agent at a folder and give it a task. Before it starts you choose:

- **Plan or Build** — plan is read-only and describes what it would do; build
  does it.
- **How hard it should think** — normal, think, ultra. This maps to the reasoning
  budget of whichever model is behind it.
- **Which runtime** — a first-party harness (TACHI) plus three others; they
  differ in how they talk to the model, not in what they are allowed to do.
- **Which provider** — the same picker as chat, so an agent can run entirely on a
  local model if you want it to.

While it runs you see the tool calls as they happen, with a permission card for
anything that writes, executes or reaches the network. Approvals queue; switching
tabs does not lose one.

Two behaviours worth knowing:

- **It admits defeat.** A classifier watches the run and marks it
  `ENDED-INCOMPLETE` when the agent has stopped making progress, instead of
  letting a cheerful summary stand in for a finished job.
- **It reconnects.** A dropped stream is retried up to ten times before the run
  is called failed, because a long agent run should not die to one bad socket.

### The agent that works on this app

There is a pinned chat bound to Tachi Studio's own source tree. It reads
[AGENTS.md](../AGENTS.md) and the recipes in [recipes/](../recipes/), which is
how it knows the conventions of the codebase it is editing. Several features in
this repository were built through it.

## Node flows

![The node canvas](media/nodes-canvas.png)

A flow is a graph of blocks: providers, prompts, agents, images, video, tools,
webhooks, folders. Wire them together and run the whole board, or one node at a
time while you are still building it.

- Flows are files. Save, export, import, send one to somebody.
- Templates cover the common shapes — compare two models, research with several
  agents, RAG over a folder, prompt to image, summarise a URL. There are working
  examples in [examples/flows/](../examples/flows/).
- A flow can be triggered by a webhook or run on a schedule.
- Anything new in the app is expected to arrive as a node too, so the canvas
  stays a complete surface rather than a demo.

## Scheduling

Local jobs that survive the machine going to sleep, in Settings → Advanced. Each
job has a missed-run policy (skip or catch up), and a spend check before it fires,
so a scheduled job cannot quietly run up a bill while you are away.

## MCP — both directions

**Tachi Studio as a server.** It exposes a curated set of filesystem, git and
model tools on `127.0.0.1`, token-gated, with a permission mode that defaults to
read-only. Point Claude Desktop, Cline or Codex at it and they can work with this
machine through the same gates the built-in agents use.

**Tachi Studio as a client.** A catalog of MCP servers you can install with one
click — no JSON editing. Secrets go to the OS keychain. Each server is classified
by whether it needs the network, so private mode keeps the local ones running and
stops the rest. Installed tools appear to the agent as `mcp__<server>__<tool>`.

## Memory

The agent keeps notes between runs: facts you confirmed, conventions it was told
to follow, and a relevance-ranked recap of long sessions instead of a raw replay.
It is capped by a token budget you control and can be turned off. Everything is
stored on this machine.

See [../recipes/AGENT-MEMORY.md](../recipes/AGENT-MEMORY.md).
