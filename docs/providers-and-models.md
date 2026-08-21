# Providers and models

## Cloud, local, and free

Tachi Studio talks to three kinds of model host and treats them the same way in
the interface:

- **Cloud providers you have an account with** — Anthropic (OAuth or key),
  OpenRouter, and several gateways. Keys go in Settings → Connections and live in
  the OS keychain.
- **Keyless / free providers** — a built-in router fans requests out across
  roughly seventeen providers that do not require an account. This is why the app
  is useful the moment it is installed, with nothing configured.
- **Local** — llama.cpp for text, plus anything OpenAI-compatible you run
  yourself (LM Studio, Ollama, vLLM, a server on another machine on your LAN).
  Add it as a custom endpoint; there is a TEST button that tells you the truth
  before you save.

Providers drift: prices change, free aliases start charging, gateways rename
models. The catalog in the app is fetched live rather than compiled in, so what
you see is what the provider is offering now.

## Automatic model choice

Leave the model on `AUTO` and a local classifier — no LLM call, sub-millisecond —
sorts the prompt into a difficulty tier and a task type, then picks a model that
suits it. A bandit re-ranks by what has actually worked for that kind of task on
your machine, with per-model cooldowns and failover when one is down.

You can see and move the cutoffs from the composer, and you can always pin a
model by hand. Automatic routing is a default, not a cage.

## The catalog knows your machine

![Model catalog](media/catalog.png)

The catalog reads your GPU, VRAM, system memory and core count, and labels each
model with whether it **fits** — before you spend twenty minutes downloading it.
Quantisations are listed with their real sizes. Every model shows its licence,
with a link, before anything is fetched; a few are listed and deliberately not
fetchable, because their terms do not allow it.

## Local engines

| Engine | What it does | Notes |
|---|---|---|
| llama.cpp | text generation | GPU offload, configurable context |
| stable-diffusion.cpp | images and video | CUDA, Vulkan or ROCm; speed packs and upscaling |
| Piper | text to speech | small, fast, fully offline |
| Whisper | speech to text | transcription and dictation |
| RIFE | frame interpolation | smooths generated video |
| yt-dlp | media import from a URL | for content you own or have the rights to |

They are downloaded on request rather than bundled, verified against the
publisher's digest, and then run entirely offline. Nothing about a local
generation leaves the machine — not the prompt, not the result, not a telemetry
ping.

## Serving models to your other tools

The app can serve what it has on `127.0.0.1:11435`:

- `/v1/chat/completions`, `/v1/completions`, `/v1/models` — the OpenAI shape,
  with streaming, so any OpenAI SDK or tool can point at it;
- `/v1/messages` — the Anthropic shape, so Claude Code and Anthropic SDK tools
  can too.

It is Bearer-gated. The key and a working `curl` example are in
Settings → Connections.
