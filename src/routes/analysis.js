import express from 'express';
import { callLLM } from '../lib/llm.js';
import { parseJsonSafely } from '../lib/parseJsonSafely.js';

const router = express.Router();

/**
 * POST /api/analysis/check-criteria
 * Check if specific criteria are fulfilled in the provided text
 * 
 * Request body:
 * {
 *   "text": "Text to analyze for criteria fulfillment"
 * }
 * 
 * Response:
 * [
 *   {
 *     "label": "Location",
 *     "containsCriteria": true/false
 *   },
 *   ...
 * ]
 */
router.post('/check-criteria', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ 
        error: 'text is required and must be a non-empty string' 
      });
    }

    console.log(`[Analysis] Checking criteria for text (${text.length} characters)`);

    // Call LLM to check criteria
    const llmResponse = await callLLM('CRITERIA_CHECK', { text });
    const parsed = parseJsonSafely(llmResponse);

    if (!parsed.ok) {
      console.error('[Analysis] Failed to parse LLM response:', parsed.error);
      return res.status(500).json({ 
        error: 'Failed to analyze criteria',
        details: parsed.error 
      });
    }

    // Validate response structure
    if (!Array.isArray(parsed.json)) {
      return res.status(500).json({ 
        error: 'Invalid response format: expected array' 
      });
    }

    // Ensure all 5 labels are present
    const expectedLabels = ['Location', 'Job Title', 'Years of Experience', 'Industry', 'Skills'];
    const responseLabels = parsed.json.map(item => item.label);

    // Check if all expected labels are present
    const missingLabels = expectedLabels.filter(label => !responseLabels.includes(label));
    if (missingLabels.length > 0) {
      console.warn(`[Analysis] Missing labels in response: ${missingLabels.join(', ')}`);
    }

    // Ensure response has correct structure
    const result = expectedLabels.map(label => {
      const found = parsed.json.find(item => item.label === label);
      if (found) {
        return {
          label: found.label,
          containsCriteria: Boolean(found.containsCriteria),
        };
      }
      // If label not found, default to false
      return {
        label,
        containsCriteria: false,
      };
    });

    console.log(`[Analysis] Criteria check completed:`, result);

    res.json(result);
  } catch (error) {
    console.error('[Analysis] Error checking criteria:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
});

export default router;

