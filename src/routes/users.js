import express from 'express';
import User from '../models/User.js';
import { callLLM } from '../lib/llm.js';
import { parseJsonSafely } from '../lib/parseJsonSafely.js';

const router = express.Router();

// GET /api/users/:id - Get user profile
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// PATCH /api/users/:id - Update user info
router.patch('/:id', async (req, res) => {
  try {
    const { githubUrl, portfolioUrl, compensationExpectation, name, phone, isHired } = req.body;

    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (githubUrl !== undefined) user.githubUrl = githubUrl;
    if (portfolioUrl !== undefined) user.portfolioUrl = portfolioUrl;
    if (compensationExpectation !== undefined) user.compensationExpectation = compensationExpectation;
    if (name !== undefined) user.name = name;
    if (phone !== undefined) user.phone = phone;
    if (isHired !== undefined) {
      user.isHired = isHired;
      if (isHired && !user.hiredAt) {
        user.hiredAt = new Date();
      } else if (!isHired) {
        user.hiredAt = null;
      }
    }

    await user.save();

    res.json(user);
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * POST /api/users/search - Search candidates using natural language
 * 
 * Request body:
 * {
 *   "query": "Find React developers with Node.js experience",
 *   "limit": 50,  // Optional, defaults to 50
 *   "skip": 0     // Optional, defaults to 0
 * }
 * 
 * Response:
 * {
 *   "query": "original search query",
 *   "searchCriteria": { ... extracted criteria ... },
 *   "explanation": "what we're searching for",
 *   "mongoQuery": { ... MongoDB query used ... },
 *   "totalResults": 10,
 *   "results": [ ... candidate objects ... ]
 * }
 */
router.post('/search', async (req, res) => {
  try {
    const { query, limit = 50, skip = 0 } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ 
        error: 'query is required and must be a non-empty string' 
      });
    }

    console.log(`[CandidateSearch] Searching for: "${query}"`);

    // Call LLM to extract search criteria from natural language query
    const llmResponse = await callLLM('CANDIDATE_SEARCH', { searchQuery: query });
    const parsed = parseJsonSafely(llmResponse);

    if (!parsed.ok) {
      console.error('[CandidateSearch] Failed to parse LLM response:', parsed.error);
      return res.status(500).json({ 
        error: 'Failed to extract search criteria',
        details: parsed.error 
      });
    }

    const { searchCriteria, explanation } = parsed.json;

    if (!searchCriteria || typeof searchCriteria !== 'object') {
      return res.status(500).json({ 
        error: 'Invalid search criteria format from LLM' 
      });
    }

    console.log('[CandidateSearch] Extracted criteria:', JSON.stringify(searchCriteria, null, 2));

    // Build MongoDB query based on extracted criteria
    const finalQuery = {};
    const skillOrConditions = []; // For tags and resume keywords (OR logic)

    // Tags search (skills/technologies) - using $in operator for array matching
    if (searchCriteria.tags && Array.isArray(searchCriteria.tags) && searchCriteria.tags.length > 0) {
      skillOrConditions.push({ tags: { $in: searchCriteria.tags } });
      console.log('[CandidateSearch] Adding tags filter:', searchCriteria.tags);
    }

    // Resume text search (keywords, experience, location)
    // Add each keyword as a separate OR condition for more flexible matching
    if (searchCriteria.resumeKeywords && Array.isArray(searchCriteria.resumeKeywords) && searchCriteria.resumeKeywords.length > 0) {
      searchCriteria.resumeKeywords.forEach(keyword => {
        skillOrConditions.push({ resumeText: { $regex: keyword, $options: 'i' } });
      });
      console.log('[CandidateSearch] Adding resume keywords filter:', searchCriteria.resumeKeywords);
    }

    // If we have skill-based OR conditions (tags or resume keywords), add them
    if (skillOrConditions.length > 0) {
      finalQuery.$or = skillOrConditions;
    }

    // All other filters are AND conditions (must all match)
    
    // Name search
    if (searchCriteria.nameQuery) {
      finalQuery.name = { $regex: searchCriteria.nameQuery, $options: 'i' };
      console.log('[CandidateSearch] Adding name filter:', searchCriteria.nameQuery);
    }

    // Email search
    if (searchCriteria.emailQuery) {
      finalQuery.email = { $regex: searchCriteria.emailQuery, $options: 'i' };
      console.log('[CandidateSearch] Adding email filter:', searchCriteria.emailQuery);
    }

    // Compensation search
    if (searchCriteria.compensationQuery) {
      finalQuery.compensationExpectation = { $regex: searchCriteria.compensationQuery, $options: 'i' };
      console.log('[CandidateSearch] Adding compensation filter:', searchCriteria.compensationQuery);
    }

    // Hired status filter
    if (searchCriteria.isHired !== undefined) {
      finalQuery.isHired = searchCriteria.isHired;
      console.log('[CandidateSearch] Adding isHired filter:', searchCriteria.isHired);
    }

    // GitHub profile required
    if (searchCriteria.githubRequired === true) {
      finalQuery.githubUrl = { $exists: true, $ne: null, $ne: '' };
      console.log('[CandidateSearch] Adding GitHub required filter');
    }

    // Portfolio required
    if (searchCriteria.portfolioRequired === true) {
      finalQuery.portfolioUrl = { $exists: true, $ne: null, $ne: '' };
      console.log('[CandidateSearch] Adding portfolio required filter');
    }

    // LinkedIn required
    if (searchCriteria.linkedinRequired === true) {
      finalQuery.linkedinUrl = { $exists: true, $ne: null, $ne: '' };
      console.log('[CandidateSearch] Adding LinkedIn required filter');
    }

    // Date filter (createdAt or updatedAt)
    if (searchCriteria.dateFilter && searchCriteria.dateFilter.field && searchCriteria.dateFilter.operator && searchCriteria.dateFilter.value) {
      const { field, operator, value } = searchCriteria.dateFilter;
      finalQuery[field] = { [operator]: new Date(value) };
      console.log('[CandidateSearch] Adding date filter:', field, operator, value);
    }

    // If no criteria were extracted, search all candidates
    if (Object.keys(finalQuery).length === 0) {
      console.log('[CandidateSearch] No criteria extracted, searching all candidates');
    }

    console.log('[CandidateSearch] Final MongoDB query:', JSON.stringify(finalQuery, null, 2));

    // Execute search
    const results = await User.find(finalQuery)
      .sort({ createdAt: -1 }) // Most recent first
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .select('-__v'); // Exclude version key

    const totalResults = await User.countDocuments(finalQuery);

    console.log(`[CandidateSearch] Found ${totalResults} candidates (returning ${results.length})`);

    // Score each candidate against search criteria using LLM
    const scoredResults = await Promise.all(
      results.map(async (user) => {
        let matchScore = 0;
        let skillsMatched = [];
        let skillsMissing = [];
        let topReasons = [];
        let recommendedAction = null;

        // Only score if resume text is available
        if (user.resumeText && user.resumeText.trim().length > 0) {
          try {
            console.log(`[CandidateSearch] Scoring candidate: ${user.name} (${user._id})`);
            const scoringResponse = await callLLM('CANDIDATE_SEARCH_SCORING', {
              resumeText: user.resumeText,
              searchCriteria,
              searchQuery: query,
            });
            const scoringParsed = parseJsonSafely(scoringResponse);
            
            if (scoringParsed.ok) {
              matchScore = scoringParsed.json.match_score || 0;
              skillsMatched = scoringParsed.json.skills_matched || [];
              skillsMissing = scoringParsed.json.skills_missing || [];
              topReasons = scoringParsed.json.top_reasons || [];
              recommendedAction = scoringParsed.json.recommended_action || null;
              console.log(`[CandidateSearch] Scored candidate ${user.name}: ${matchScore}`);
            } else {
              console.error(`[CandidateSearch] Failed to parse scoring for ${user.name}:`, scoringParsed.error);
            }
          } catch (error) {
            console.error(`[CandidateSearch] Error scoring candidate ${user.name}:`, error);
            // Continue without score if scoring fails
          }
        } else {
          console.log(`[CandidateSearch] Skipping score for ${user.name}: no resume text`);
        }

        return {
          id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          tags: user.tags,
          githubUrl: user.githubUrl,
          portfolioUrl: user.portfolioUrl,
          linkedinUrl: user.linkedinUrl,
          compensationExpectation: user.compensationExpectation,
          isHired: user.isHired,
          hiredAt: user.hiredAt,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          resumeSummary: user.resumeSummary,
          parsedResume: user.parsedResume,
          // Scoring information
          matchScore,
          skillsMatched,
          skillsMissing,
          topReasons,
          recommendedAction,
        };
      })
    );

    // Sort by match score (highest first) if scores are available
    scoredResults.sort((a, b) => {
      if (a.matchScore > 0 || b.matchScore > 0) {
        return b.matchScore - a.matchScore;
      }
      // If no scores, maintain original order (most recent first)
      return 0;
    });

    res.json({
      query,
      explanation,
      totalResults,
      limit: parseInt(limit),
      skip: parseInt(skip),
      results: scoredResults,
    });
  } catch (error) {
    console.error('[CandidateSearch] Error searching candidates:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
});

export default router;

