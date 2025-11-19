/**
 * Safely parse JSON from LLM responses that may contain extra text, smart quotes, or trailing commas
 */
export function parseJsonSafely(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, json: null, raw, error: 'Input must be a string' };
  }

  // First try: direct parse
  try {
    const json = JSON.parse(raw);
    return { ok: true, json, raw, error: null };
  } catch (e) {
    // Continue to fallback strategies
  }

  // Second try: extract first {...} block using regex
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    let cleaned = jsonMatch[0];
    
    // Clean smart quotes
    cleaned = cleaned
      .replace(/[""]/g, '"')
      .replace(/['']/g, "'");
    
    // Remove trailing commas before closing braces/brackets
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
    
    try {
      const json = JSON.parse(cleaned);
      return { ok: true, json, raw, error: null };
    } catch (e) {
      // Continue to error return
    }
  }

  return { ok: false, json: null, raw, error: 'Could not parse JSON from response' };
}

