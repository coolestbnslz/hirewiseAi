import express from 'express';
import Job from '../models/Job.js';
import { enhanceJD } from '../lib/jdEnhancer.js';
import { matchJobToCandidates, getJobMatches } from '../lib/candidateMatcher.js';
import { callLLM } from '../lib/llm.js';
import { parseJsonSafely } from '../lib/parseJsonSafely.js';

const router = express.Router();

// POST /api/jobs/extract-fields - Extract job fields from raw text
router.post('/extract-fields', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text field is required and must be a non-empty string' });
    }

    console.log('[Jobs] Extracting job fields from text...');
    
    // Call LLM to extract job fields
    const llmResponse = await callLLM('JOB_FIELD_EXTRACTION', { text });
    const parsed = parseJsonSafely(llmResponse);

    if (!parsed.ok) {
      console.error('[Jobs] Failed to parse LLM response:', parsed.error);
      return res.status(500).json({ 
        error: 'Failed to extract job fields', 
        details: parsed.error 
      });
    }

    const extractedFields = parsed.json;

    // Validate and format the response
    const response = {
      company_name: extractedFields.company_name || null,
      role: extractedFields.role || null,
      team: extractedFields.team || null,
      seniority: extractedFields.seniority || null,
      location: extractedFields.location || null,
      job_type: extractedFields.job_type || null,
      budget_info: extractedFields.budget_info || null,
      must_have_skills: Array.isArray(extractedFields.must_have_skills) 
        ? extractedFields.must_have_skills 
        : [],
      nice_to_have: Array.isArray(extractedFields.nice_to_have) 
        ? extractedFields.nice_to_have 
        : [],
    };

    console.log('[Jobs] Successfully extracted job fields');
    res.json(response);
  } catch (error) {
    console.error('Error extracting job fields:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/jobs - Create job and enhance JD
router.post('/', async (req, res) => {
  try {
    const {
      raw_jd,
      company_name,
      role,
      team,
      seniority,
      location,
      job_type,
      budget_info,
      must_have_skills,
      nice_to_have,
    } = req.body;

    if (!raw_jd || !company_name || !role) {
      return res.status(400).json({ error: 'raw_jd, company_name, and role are required' });
    }

    // Create job draft
    const job = new Job({
      raw_jd,
      company_name,
      role,
      team,
      seniority,
      location,
      job_type,
      budget_info,
      must_have_skills: must_have_skills || [],
      nice_to_have: nice_to_have || [],
      status: 'draft',
    });

    // Enhance JD
    const enhancement = await enhanceJD(job);
    
    if (!enhancement.ok) {
      return res.status(500).json({ 
        error: 'Failed to enhance JD', 
        details: enhancement.error 
      });
    }

    // Update job with enhanced data
    job.enhanced_jd = enhancement.data.enhanced_jd;
    job.tags = enhancement.data.tags || [];
    job.apply_form_fields = enhancement.data.apply_form_fields || [];
    // Screening questions are now generated on-the-spot, but keep any provided as fallback
    if (enhancement.data.screening_questions) {
      job.screening_questions = enhancement.data.screening_questions;
    }
    job.status = 'finalized';

    await job.save();

    // Automatically match job to existing candidates (async, don't wait)
    matchJobToCandidates(job._id).catch(error => {
      console.error('Error matching candidates to job:', error);
    });

    res.status(201).json(job);
  } catch (error) {
    console.error('Error creating job:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /api/jobs/:id - Get job by ID
router.get('/:id', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// PATCH /api/jobs/:id/settings - Update job settings
router.patch('/:id/settings', async (req, res) => {
  try {
    const { autoInviteOnLevel1Approval, autoInviteThreshold, autoCreateScreeningThreshold } = req.body;

    const job = await Job.findById(req.params.id);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (autoInviteOnLevel1Approval !== undefined) {
      job.settings.autoInviteOnLevel1Approval = autoInviteOnLevel1Approval;
    }
    if (autoInviteThreshold !== undefined) {
      job.settings.autoInviteThreshold = autoInviteThreshold;
    }
    if (autoCreateScreeningThreshold !== undefined) {
      job.settings.autoCreateScreeningThreshold = autoCreateScreeningThreshold;
    }

    await job.save();

    res.json(job);
  } catch (error) {
    console.error('Error updating job settings:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/jobs/:id/match-candidates - Manually trigger candidate matching
router.post('/:id/match-candidates', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const result = await matchJobToCandidates(req.params.id);

    res.json({
      message: 'Candidate matching completed',
      ...result,
    });
  } catch (error) {
    console.error('Error matching candidates:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /api/jobs/:id/matches - Get matched candidates for a job
router.get('/:id/matches', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const minScore = parseInt(req.query.minScore) || 0;
    const limit = parseInt(req.query.limit) || 50;
    const status = req.query.status;

    const matches = await getJobMatches(req.params.id, {
      minScore,
      limit,
      status,
    });

    res.json({
      jobId: job._id,
      jobTitle: job.role,
      totalMatches: matches.length,
      matches: matches.map(match => ({
        matchId: match._id,
        candidate: {
          id: match.userId._id,
          name: match.userId.name,
          email: match.userId.email,
          tags: match.userId.tags,
          githubUrl: match.userId.githubUrl,
          portfolioUrl: match.userId.portfolioUrl,
          compensationExpectation: match.userId.compensationExpectation,
        },
        matchScore: match.matchScore,
        tagMatchScore: match.tagMatchScore,
        skillsMatchScore: match.skillsMatchScore,
        matchedTags: match.matchedTags,
        matchedSkills: match.matchedSkills,
        missingSkills: match.missingSkills,
        matchReason: match.matchReason,
        status: match.status,
        createdAt: match.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error fetching matches:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

export default router;

