import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import User from '../models/User.js';
import { callLLM } from '../lib/llm.js';
import { parseJsonSafely } from '../lib/parseJsonSafely.js';
import { fetchGitHubData, formatGitHubDataForLLM } from '../lib/github.js';

const router = express.Router();

// GET /api/users/:id/resume - Download user's resume (must come before /:id route)
router.get('/:id/resume', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.resumePath) {
      return res.status(404).json({ error: 'Resume not found for this user' });
    }

    // Check if file exists
    try {
      await fs.access(user.resumePath);
    } catch (error) {
      console.error(`[User] Resume file not found at path: ${user.resumePath}`, error);
      return res.status(404).json({ error: 'Resume file not found on server' });
    }

    // Get file extension to determine content type
    const ext = path.extname(user.resumePath).toLowerCase();
    const contentTypes = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';

    // Get original filename from resumePath (format: timestamp-originalname)
    const filename = path.basename(user.resumePath);
    // Extract original filename (remove timestamp prefix)
    const originalFilename = filename.includes('-') 
      ? filename.substring(filename.indexOf('-') + 1)
      : filename;

    // Set headers for file download
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${originalFilename}"`);
    res.setHeader('Cache-Control', 'no-cache');

    // Read and send file
    const fileBuffer = await fs.readFile(user.resumePath);
    res.send(fileBuffer);

    console.log(`[User] Resume downloaded for user ${user._id}: ${originalFilename}`);
  } catch (error) {
    console.error('Error downloading resume:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

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

    // Tags search (skills/technologies) - using exact case-insensitive matching
    // Use $expr with $regexMatch to avoid partial matches (e.g., "java" matching "javascript")
    if (searchCriteria.tags && Array.isArray(searchCriteria.tags) && searchCriteria.tags.length > 0) {
      // For each tag, create an exact match condition
      const tagConditions = searchCriteria.tags.map(tag => {
        // Escape special regex characters
        const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Use $expr with $regexMatch for exact case-insensitive matching in array
        // This ensures "java" matches "Java" but NOT "JavaScript"
        return {
          $expr: {
            $anyElementTrue: {
              $map: {
                input: '$tags',
                as: 'tag',
                in: {
                  $regexMatch: {
                    input: '$$tag',
                    regex: new RegExp(`^${escapedTag}$`, 'i'),
                  },
                },
              },
            },
          },
        };
      });
      skillOrConditions.push(...tagConditions);
      console.log('[CandidateSearch] Adding tags filter (exact match):', searchCriteria.tags);
    }

    // Resume text search (keywords, experience, location)
    // Add word boundaries to avoid partial matches (e.g., "java" matching "javascript")
    if (searchCriteria.resumeKeywords && Array.isArray(searchCriteria.resumeKeywords) && searchCriteria.resumeKeywords.length > 0) {
      searchCriteria.resumeKeywords.forEach(keyword => {
        // Escape special regex characters
        const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Use word boundaries for exact word matching (case-insensitive)
        // For phrases like "senior software engineer", match the whole phrase
        const isPhrase = keyword.trim().split(/\s+/).length > 1;
        const regexPattern = isPhrase 
          ? `\\b${escapedKeyword}\\b`  // Word boundaries for phrases
          : `\\b${escapedKeyword}\\b`;  // Word boundaries for single words
        skillOrConditions.push({ resumeText: { $regex: regexPattern, $options: 'i' } });
      });
      console.log('[CandidateSearch] Adding resume keywords filter (with word boundaries):', searchCriteria.resumeKeywords);
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
        let githubPortfolioScore = 0;
        let githubPortfolioSummary = '';
        let compensationScore = 0;
        let compensationAnalysis = '';

        // Extract GitHub URL from parsedResume if not provided directly
        let finalGithubUrl = user.githubUrl;
        let finalPortfolioUrl = user.portfolioUrl;
        
        if (!finalGithubUrl && user.parsedResume && user.parsedResume.contact && user.parsedResume.contact.github) {
          finalGithubUrl = user.parsedResume.contact.github;
          console.log(`[CandidateSearch] Extracted GitHub URL from parsed resume for ${user.name}: ${finalGithubUrl}`);
        }
        
        if (!finalPortfolioUrl && user.parsedResume && user.parsedResume.contact && user.parsedResume.contact.portfolio) {
          finalPortfolioUrl = user.parsedResume.contact.portfolio;
          console.log(`[CandidateSearch] Extracted portfolio URL from parsed resume for ${user.name}: ${finalPortfolioUrl}`);
        }

        // Parallel scoring: Resume scoring, GitHub/Portfolio scoring, Compensation analysis
        const scoringPromises = [];

        // Resume scoring
        if (user.resumeText && user.resumeText.trim().length > 0) {
          scoringPromises.push(
            callLLM('CANDIDATE_SEARCH_SCORING', {
              resumeText: user.resumeText,
              searchCriteria,
              searchQuery: query,
            })
              .then(scoringResponse => {
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
              })
              .catch(error => {
                console.error(`[CandidateSearch] Error scoring candidate ${user.name}:`, error);
              })
          );
        } else {
          console.log(`[CandidateSearch] Skipping resume score for ${user.name}: no resume text`);
        }

        // GitHub/Portfolio scoring
        let githubDataFormatted = '';
        if (finalGithubUrl) {
          // Fetch GitHub data first
          try {
            const githubData = await fetchGitHubData(finalGithubUrl);
            githubDataFormatted = formatGitHubDataForLLM(githubData);
            console.log(`[CandidateSearch] Fetched GitHub data for ${user.name}: ${githubData.error ? 'Error' : `${githubData.repositories?.length || 0} repositories`}`);
          } catch (error) {
            console.error(`[CandidateSearch] Error fetching GitHub data for ${user.name}:`, error);
          }
        }

        if (githubDataFormatted || finalPortfolioUrl) {
          // Create a mock job object for GitHub/Portfolio scoring (using search criteria)
          const mockJob = {
            role: searchCriteria.role || 'Position',
            company_name: 'Paytm',
            must_have_skills: searchCriteria.tags || [],
            nice_to_have: [],
            enhanced_jd: query,
          };

          scoringPromises.push(
            callLLM('GITHUB_PORTFOLIO_SCORING', {
              githubData: githubDataFormatted,
              portfolioUrl: finalPortfolioUrl,
              job: mockJob,
            })
              .then(githubLLMResponse => {
                const githubParsed = parseJsonSafely(githubLLMResponse);
                if (githubParsed.ok) {
                  githubPortfolioScore = githubParsed.json.score || 0;
                  githubPortfolioSummary = githubParsed.json.summary || '';
                  console.log(`[CandidateSearch] GitHub/Portfolio scored for ${user.name}: ${githubPortfolioScore}`);
                } else {
                  console.error(`[CandidateSearch] Failed to parse GitHub/Portfolio response for ${user.name}:`, githubParsed.error);
                }
              })
              .catch(error => {
                console.error(`[CandidateSearch] Error processing GitHub/Portfolio for ${user.name}:`, error);
              })
          );
        }

        // Compensation analysis (if compensation expectation and budget info exist)
        // Check for budget info in search criteria (could be budgetInfo, budget, or compensationQuery)
        const budgetInfo = searchCriteria.budgetInfo || searchCriteria.budget || searchCriteria.compensationQuery;
        if (user.compensationExpectation && budgetInfo) {
          scoringPromises.push(
            callLLM('COMPENSATION_ANALYSIS', {
              compensationExpectation: user.compensationExpectation,
              budget_info: budgetInfo,
            })
              .then(compLLMResponse => {
                const compParsed = parseJsonSafely(compLLMResponse);
                if (compParsed.ok) {
                  compensationScore = compParsed.json.score || 0;
                  compensationAnalysis = compParsed.json.analysis || '';
                  console.log(`[CandidateSearch] Compensation analyzed for ${user.name}: ${compensationScore}`);
                } else {
                  console.error(`[CandidateSearch] Failed to parse compensation response for ${user.name}:`, compParsed.error);
                }
              })
              .catch(error => {
                console.error(`[CandidateSearch] Error analyzing compensation for ${user.name}:`, error);
              })
          );
        }

        // Wait for all scoring operations to complete
        await Promise.all(scoringPromises);

        return {
          id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          tags: user.tags,
          githubUrl: finalGithubUrl || user.githubUrl,
          portfolioUrl: finalPortfolioUrl || user.portfolioUrl,
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
          githubPortfolioScore,
          githubPortfolioSummary,
          compensationScore,
          compensationAnalysis,
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

