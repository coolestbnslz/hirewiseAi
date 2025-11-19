import { callLLM } from './llm.js';
import { parseJsonSafely } from './parseJsonSafely.js';
import { extractTagsFromJob } from './embeddings.js';

/**
 * Build prompt for JD enhancement
 */
function buildEnhancePrompt(job) {
  return {
    raw_jd: job.raw_jd,
    company_name: job.company_name,
    role: job.role,
    seniority: job.seniority,
    budget_info: job.budget_info,
    must_have_skills: job.must_have_skills,
    nice_to_have: job.nice_to_have,
  };
}

/**
 * Enhance job description using LLM
 * Uses embeddings for tag extraction instead of LLM-generated tags
 * @param {Object} job - Job object with raw_jd and other fields
 * @returns {Promise<{ok: boolean, data: Object, raw: string, error: string|null}>}
 */
export async function enhanceJD(job) {
  const prompt = buildEnhancePrompt(job);
  const rawResponse = await callLLM('JD_ENHANCER', prompt);
  const parsed = parseJsonSafely(rawResponse);

  if (!parsed.ok) {
    return {
      ok: false,
      data: null,
      raw: rawResponse,
      error: parsed.error,
    };
  }

  // Extract tags using embeddings instead of LLM-generated tags
  let tags = [];
  try {
    tags = await extractTagsFromJob(job);
    console.log(`[JD Enhancer] Extracted ${tags.length} tags using embeddings`);
  } catch (error) {
    console.error('[JD Enhancer] Error extracting tags with embeddings, using LLM tags as fallback:', error);
    // Fallback to LLM-generated tags if embeddings fail
    tags = parsed.json.tags || [];
  }

  return {
    ok: true,
    data: {
      ...parsed.json,
      tags, // Replace LLM tags with embeddings-based tags
    },
    raw: rawResponse,
    error: null,
  };
}

