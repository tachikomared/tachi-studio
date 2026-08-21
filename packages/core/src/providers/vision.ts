// packages/core/src/providers/vision.ts
//
// Heuristic: does a model id name a multimodal (image-reading) model? Used so the
// Nodes surface flags vision-capable models across ALL providers — not just Venice
// (which carries an explicit vision flag). Matched by id family; like the rest of
// the catalog code it tolerates the rare miss (a false negative just shows the
// "model can't read the image" hint on a model that actually can).

const VISION_PATTERNS: RegExp[] = [
  /\bvision\b/i,
  /multimodal/i,
  /claude.*(opus|sonnet|haiku|fable|mythos)/i,    // modern Claude is all multimodal
  /gemini/i,                                        // Gemini 1.5+/2/3 are multimodal
  /gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision|gpt-5|chatgpt-4o/i,
  /\bo[34]-/i,                                      // o3-/o4- omni reasoning (vision)
  /qwen.*vl|[-_]vl[-_]|[-_]vl-?\d|[-_]vl$/i,        // Qwen-VL, InternVL, *-vl-2b
  /pixtral/i,
  /llava/i,
  /llama-?4|llama.*vision/i,                        // Llama 4 (multimodal) + 3.2-vision
  /glm-?4(?:\.\d+)?v/i,                             // GLM-4v / GLM-4.6v
  /mistral.*small-3\.1|mistral.*3\.1/i,             // Mistral Small 3.1 (vision)
  /grok-?4|grok.*vision/i,
]

/** True if `modelId` names a vision-capable (image-reading) model. */
export function isVisionModel(modelId: string): boolean {
  if (!modelId) return false
  return VISION_PATTERNS.some(re => re.test(modelId))
}
