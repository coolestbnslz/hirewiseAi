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
    team: job.team,
    seniority: job.seniority,
    location: job.location,
    job_type: job.job_type,
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

  // Extract tags using LLM-based extraction from job description
  let tags = [];
  try {
    tags = await extractTagsFromJob(job);
    console.log(`[JD Enhancer] Extracted ${tags.length} tags from job description`);
  } catch (error) {
    console.error('[JD Enhancer] Error extracting tags from job description:', error);
    // Fallback to basic tags from job fields
    tags = [
      ...(job.must_have_skills || []),
      ...(job.nice_to_have || []),
      job.role,
      job.seniority,
    ].filter(Boolean);
  }

  // Fix apply_form_fields if it's returned as a string instead of an array
  let applyFormFields = parsed.json.apply_form_fields || [];
  
  if (typeof applyFormFields === 'string') {
    console.log('[JD Enhancer] apply_form_fields is a string, attempting to parse...');
    console.log('[JD Enhancer] String value (first 200 chars):', applyFormFields.substring(0, 200));
    
    try {
      // First try: parse as JSON directly
      applyFormFields = JSON.parse(applyFormFields);
      console.log('[JD Enhancer] Successfully parsed as JSON');
    } catch (e) {
      // Second try: extract array from JavaScript code string and convert to JSON
      // The LLM might return it as JavaScript code with single quotes and unquoted keys
      const jsonMatch = applyFormFields.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          let cleaned = jsonMatch[0];
          
          // Step 1: Replace smart quotes with regular quotes
          cleaned = cleaned.replace(/['']/g, "'").replace(/[""]/g, '"');
          
          // Step 2: Convert unquoted keys to quoted keys
          // Match: { or , followed by whitespace/newlines, then a word, then :
          // This is tricky because we need to avoid matching values
          // Pattern: after { or ,, find word followed by : (but not : after a quote)
          cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
          
          // Step 3: Convert single-quoted strings to double-quoted strings
          // But be careful - we want to convert 'value' to "value" but not break already quoted keys
          cleaned = cleaned.replace(/([:\s,])'([^']*)'([,\s}])/g, '$1"$2"$3');
          
          // Step 4: Remove trailing commas before } or ]
          cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
          
          // Step 5: Ensure boolean values are not quoted
          cleaned = cleaned.replace(/:\s*"(true|false)"\s*([,}])/g, ': $1$2');
          
          // Step 6: Fix any remaining issues with number values
          cleaned = cleaned.replace(/:\s*"(\d+)"\s*([,}])/g, ': $1$2');
          
          console.log('[JD Enhancer] Cleaned string (first 400 chars):', cleaned.substring(0, 400));
          
          applyFormFields = JSON.parse(cleaned);
          console.log('[JD Enhancer] Successfully parsed from JavaScript code string');
        } catch (e2) {
          console.error('[JD Enhancer] Failed to parse apply_form_fields:', e2.message);
          console.error('[JD Enhancer] Parse error at position:', e2.message.match(/position (\d+)/)?.[1]);
          // Try one more time with a simpler approach - use eval (safe in this context)
          try {
            // Remove any string concatenation operators
            const evalSafe = applyFormFields.replace(/\+\s*['"]/g, '').replace(/['"]\s*\+/g, '');
            const arrayMatch = evalSafe.match(/\[[\s\S]*\]/);
            if (arrayMatch) {
              // Use Function constructor as safer alternative to eval
              const func = new Function('return ' + arrayMatch[0]);
              applyFormFields = func();
              console.log('[JD Enhancer] Successfully parsed using Function constructor');
            } else {
              throw new Error('No array found');
            }
          } catch (e3) {
            console.error('[JD Enhancer] All parsing attempts failed, using default');
            applyFormFields = [
              { name: 'email', type: 'email', label: 'Email Address', required: true },
              { name: 'phone', type: 'tel', label: 'Phone Number', required: false }
            ];
          }
        }
      } else {
        console.warn('[JD Enhancer] No array pattern found in string, using default');
        applyFormFields = [
          { name: 'email', type: 'email', label: 'Email Address', required: true },
          { name: 'phone', type: 'tel', label: 'Phone Number', required: false }
        ];
      }
    }
  }
  
  // Ensure applyFormFields is an array
  if (!Array.isArray(applyFormFields)) {
    console.warn('[JD Enhancer] apply_form_fields is not an array after parsing, using default');
    console.warn('[JD Enhancer] Type:', typeof applyFormFields, 'Value:', applyFormFields);
    applyFormFields = [
      { name: 'email', type: 'email', label: 'Email Address', required: true },
      { name: 'phone', type: 'tel', label: 'Phone Number', required: false }
    ];
  }
  
  console.log('[JD Enhancer] Final apply_form_fields:', JSON.stringify(applyFormFields, null, 2));
  console.log('[JD Enhancer] Final apply_form_fields type:', Array.isArray(applyFormFields) ? 'Array' : typeof applyFormFields);

  // Build result object, ensuring apply_form_fields is definitely an array
  const result = {
    ok: true,
    data: {
      ...parsed.json,
      tags, // Replace LLM tags with embeddings-based tags
      apply_form_fields: applyFormFields, // Ensure it's a proper array (overwrites any string from parsed.json)
    },
    raw: rawResponse,
    error: null,
  };
  
  // Final safety check - if somehow it's still not an array, use default
  if (!Array.isArray(result.data.apply_form_fields)) {
    console.error('[JD Enhancer] CRITICAL: apply_form_fields is STILL not an array after all processing!');
    console.error('[JD Enhancer] Type:', typeof result.data.apply_form_fields);
    console.error('[JD Enhancer] Value:', result.data.apply_form_fields);
    result.data.apply_form_fields = [
      { name: 'email', type: 'email', label: 'Email Address', required: true },
      { name: 'phone', type: 'tel', label: 'Phone Number', required: false }
    ];
  }
  
  return result;
}

