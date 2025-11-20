import express from 'express';
import Job from '../models/Job.js';
import Application from '../models/Application.js';
import User from '../models/User.js';
import Screening from '../models/Screening.js';
import JobCandidateMatch from '../models/JobCandidateMatch.js';
import { callLLM } from '../lib/llm.js';
import { parseJsonSafely } from '../lib/parseJsonSafely.js';
import { extractTagsFromResume } from '../lib/embeddings.js';
import { saveUploadedFile, readFileAsText } from '../lib/storage.js';
import { sendEmail } from '../lib/email.js';
import { upload } from '../middleware/upload.js';
import { v4 as uuidv4 } from 'uuid';
import { fetchGitHubData, formatGitHubDataForLLM } from '../lib/github.js';

const router = express.Router();

// GET /api/applications/job/:jobId - Get all applications for a specific job
router.get('/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { 
      status, 
      minScore, 
      sortBy = 'createdAt', 
      sortOrder = 'desc',
      limit = 100,
      page = 1 
    } = req.query;

    // Validate job exists
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Build query
    const query = { jobId };

    // Filter by approval status if provided
    if (status === 'approved') {
      query.level1_approved = true;
    } else if (status === 'pending') {
      query.level1_approved = false;
    }

    // Filter by minimum score if provided
    if (minScore) {
      query.unifiedScore = { $gte: parseFloat(minScore) };
    }

    // Build sort object
    const sort = {};
    if (sortBy === 'score') {
      sort.unifiedScore = sortOrder === 'asc' ? 1 : -1;
    } else if (sortBy === 'createdAt') {
      sort.createdAt = sortOrder === 'asc' ? 1 : -1;
    } else if (sortBy === 'updatedAt') {
      sort.updatedAt = sortOrder === 'asc' ? 1 : -1;
    } else {
      sort.createdAt = -1; // Default sort
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Fetch applications with populated user data
    const applications = await Application.find(query)
      .populate('userId', 'name email phone githubUrl portfolioUrl linkedinUrl compensationExpectation tags')
      .populate('matchId', 'matchScore status')
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    // Get total count for pagination
    const total = await Application.countDocuments(query);

    // Format response
    const formattedApplications = applications.map(app => ({
      applicationId: app._id,
      userId: app.userId._id,
      candidate: {
        name: app.userId.name,
        email: app.userId.email,
        phone: app.userId.phone,
        githubUrl: app.userId.githubUrl,
        portfolioUrl: app.userId.portfolioUrl,
        linkedinUrl: app.userId.linkedinUrl,
        compensationExpectation: app.userId.compensationExpectation,
        tags: app.userId.tags || [],
      },
      scores: {
        resumeScore: app.scores?.resumeScore || null,
        githubPortfolioScore: app.scores?.githubPortfolioScore || null,
        compensationScore: app.scores?.compensationScore || null,
        unifiedScore: app.unifiedScore || null,
        compensationAnalysis: app.scores?.compensationAnalysis || null,
      },
      status: {
        consentGiven: app.consent_given,
        level1Approved: app.level1_approved,
      },
      matchInfo: app.matchId ? {
        matchId: app.matchId._id,
        matchScore: app.matchId.matchScore,
        status: app.matchId.status,
      } : null,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    }));

    res.json({
      jobId: job._id,
      jobRole: job.role,
      jobCompany: job.company_name,
      totalApplications: total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit)),
      applications: formattedApplications,
    });
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Calculate unified score from individual scores
function calculateUnifiedScore(scores) {
  const weights = {
    resumeScore: 0.5,
    githubPortfolioScore: 0.3,
    compensationScore: 0.2,
  };

  const resumeScore = scores.resumeScore || 0;
  const githubPortfolioScore = scores.githubPortfolioScore || 0;
  const compensationScore = scores.compensationScore || 0;

  const unified = (
    resumeScore * weights.resumeScore +
    githubPortfolioScore * weights.githubPortfolioScore +
    compensationScore * weights.compensationScore
  );

  return Math.round(unified);
}

// POST /api/apply/:jobId - Apply to job with resume upload
router.post('/:jobId', upload.single('resume'), async (req, res) => {
  try {
    const { jobId } = req.params;
    const { applicant_email, applicant_name, applicant_phone, githubUrl, portfolioUrl, linkedinUrl, compensationExpectation } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Resume file is required' });
    }

    if (!applicant_email) {
      return res.status(400).json({ error: 'applicant_email is required' });
    }

    // Find job
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Save resume file
    const resumePath = await saveUploadedFile(req.file);
    const resumeText = await readFileAsText(resumePath);

    // Log extracted resume text for debugging
    if (resumeText) {
      console.log(`[Application] Extracted ${resumeText.length} characters from resume`);
      console.log(`[Application] Resume text preview (first 500 chars): ${resumeText.substring(0, 500)}...`);
    } else {
      console.warn('[Application] Warning: No text extracted from resume file');
    }

    // Find or create user
    let user = await User.findOne({ email: applicant_email.toLowerCase() });
    
    // Extract tags from resume using LLM
    let resumeTags = [];
    let resumeSummary = '';
    if (resumeText && resumeText.trim().length > 0) {
      try {
        resumeTags = await extractTagsFromResume(resumeText);
        console.log(`[Application] Extracted ${resumeTags.length} tags from resume using LLM`);
        
        // Generate resume summary using LLM
        try {
          const summaryResponse = await callLLM('RESUME_SUMMARY', { resumeText });
          const summaryParsed = parseJsonSafely(summaryResponse);
          if (summaryParsed.ok && summaryParsed.json.summary) {
            resumeSummary = summaryParsed.json.summary;
            console.log('[Application] Generated resume summary:', resumeSummary.substring(0, 200));
          } else {
            console.error('[Application] Failed to parse resume summary response:', summaryParsed.error);
          }
        } catch (error) {
          console.error('[Application] Error generating resume summary:', error);
          // Continue without summary if generation fails
        }
      } catch (error) {
        console.error('[Application] Error extracting tags from resume:', error);
        // Continue without tags if extraction fails
      }
    } else {
      console.warn('[Application] Skipping resume processing: no valid resume text extracted');
    }
    
    // Calculate matched tags between resume and job
    const jobTags = job.tags || [];
    const matchedTags = [];
    const resumeTagsLower = resumeTags.map(t => t.toLowerCase());
    const jobTagsLower = jobTags.map(t => t.toLowerCase());
    
    for (const jobTag of jobTags) {
      const jobTagLower = jobTag.toLowerCase();
      // Check for exact match or partial match
      if (resumeTagsLower.includes(jobTagLower)) {
        matchedTags.push(jobTag);
      } else {
        // Check for partial matches (e.g., "React" matches "React.js")
        const matched = resumeTagsLower.find(rt => 
          rt.includes(jobTagLower) || jobTagLower.includes(rt)
        );
        if (matched) {
          const originalTag = resumeTags.find(t => t.toLowerCase() === matched);
          if (originalTag && !matchedTags.includes(originalTag)) {
            matchedTags.push(originalTag);
          }
        }
      }
    }
    
    console.log(`[Application] Found ${matchedTags.length} matched tags out of ${jobTags.length} job tags`);
    
    if (!user) {
      user = new User({
        email: applicant_email.toLowerCase(),
        name: applicant_name || 'Unknown',
        phone: applicant_phone,
        resumePath,
        resumeText,
        githubUrl,
        portfolioUrl,
        linkedinUrl,
        compensationExpectation,
        tags: resumeTags, // Extracted using LLM
      });
    } else {
      // Update user info
      if (resumePath) user.resumePath = resumePath;
      if (resumeText) {
        user.resumeText = resumeText;
        user.tags = resumeTags; // Update tags with embeddings-based extraction
      }
      if (githubUrl) user.githubUrl = githubUrl;
      if (portfolioUrl) user.portfolioUrl = portfolioUrl;
      if (linkedinUrl) user.linkedinUrl = linkedinUrl;
      if (compensationExpectation) user.compensationExpectation = compensationExpectation;
    }
    await user.save();

    // Score resume
    const resumeLLMResponse = await callLLM('RESUME_SCORING', {
      resumeText,
      job,
    });
    const resumeParsed = parseJsonSafely(resumeLLMResponse);
    const resumeScore = resumeParsed.ok ? resumeParsed.json.match_score : 0;

    // Score GitHub/Portfolio and get summary
    let githubPortfolioScore = 0;
    let githubPortfolioSummary = '';
    if (user.githubUrl || user.portfolioUrl) {
      try {
        // Fetch actual GitHub data if GitHub URL is provided
        let githubDataFormatted = '';
        if (user.githubUrl) {
          console.log(`[Application] Fetching GitHub data for: ${user.githubUrl}`);
          const githubData = await fetchGitHubData(user.githubUrl);
          githubDataFormatted = formatGitHubDataForLLM(githubData);
          console.log(`[Application] Fetched GitHub data: ${githubData.error ? 'Error' : `${githubData.repositories?.length || 0} repositories`}`);
        }

        const githubLLMResponse = await callLLM('GITHUB_PORTFOLIO_SCORING', {
          githubData: githubDataFormatted,
          portfolioUrl: user.portfolioUrl,
          job,
        });
        const githubParsed = parseJsonSafely(githubLLMResponse);
        if (githubParsed.ok) {
          githubPortfolioScore = githubParsed.json.score || 0;
          githubPortfolioSummary = githubParsed.json.summary || '';
          console.log('[Application] Generated GitHub/Portfolio summary:', githubPortfolioSummary.substring(0, 200));
        } else {
          console.error('[Application] Failed to parse GitHub/Portfolio response:', githubParsed.error);
        }
      } catch (error) {
        console.error('[Application] Error processing GitHub/Portfolio:', error);
        // Continue without GitHub/Portfolio score if processing fails
      }
    }
    
    // Generate LinkedIn summary
    let linkedinSummary = '';
    if (user.linkedinUrl) {
      try {
        const linkedinResponse = await callLLM('LINKEDIN_SUMMARY', {
          linkedinUrl: user.linkedinUrl,
        });
        const linkedinParsed = parseJsonSafely(linkedinResponse);
        if (linkedinParsed.ok && linkedinParsed.json.summary) {
          linkedinSummary = linkedinParsed.json.summary;
          console.log('[Application] Generated LinkedIn summary');
        }
      } catch (error) {
        console.error('[Application] Error generating LinkedIn summary:', error);
        // Continue without LinkedIn summary if generation fails
      }
    }

    // Score compensation
    let compensationScore = 0;
    let compensationAnalysis = '';
    if (user.compensationExpectation && job.budget_info) {
      const compLLMResponse = await callLLM('COMPENSATION_ANALYSIS', {
        compensationExpectation: user.compensationExpectation,
        budget_info: job.budget_info,
      });
      const compParsed = parseJsonSafely(compLLMResponse);
      if (compParsed.ok) {
        compensationScore = compParsed.json.score || 0;
        compensationAnalysis = compParsed.json.analysis || '';
      }
    }

    // Calculate unified score
    const scores = {
      resumeScore,
      githubPortfolioScore,
      compensationScore,
      compensationAnalysis,
    };
    const unifiedScore = calculateUnifiedScore(scores);

    // Check if there's an existing match for this job-candidate pair
    const existingMatch = await JobCandidateMatch.findOne({
      jobId: job._id,
      userId: user._id,
    });

    // Create application
    const application = new Application({
      jobId: job._id,
      userId: user._id,
      resumePath,
      resumeText,
      scores,
      unifiedScore,
      rawResumeLLM: resumeLLMResponse,
      consent_given: false,
      level1_approved: false,
      matchId: existingMatch?._id || null,
    });
    await application.save();

    // Update match status to 'applied' and link to application
    if (existingMatch) {
      existingMatch.status = 'applied';
      existingMatch.applicationId = application._id;
      await existingMatch.save();
    }

    // Auto-create screening if threshold met
    let screening = null;
    if (unifiedScore >= job.settings.autoCreateScreeningThreshold) {
      screening = new Screening({
        applicationId: application._id,
        jobId: job._id,
        screening_link: `https://hirewise.app/screening/${uuidv4()}`,
      });
      await screening.save();
    }

    // Candidate-facing response (no scores shown)
    res.status(201).json({
      message: 'Application submitted successfully',
      applicationId: application._id,
      screeningId: screening?._id || null,
      resume: {
        summary: resumeSummary,
        tags: resumeTags,
        matchedTags: matchedTags,
        totalTags: resumeTags.length,
        matchedCount: matchedTags.length,
        matchPercentage: jobTags.length > 0 ? Math.round((matchedTags.length / jobTags.length) * 100) : 0,
      },
      githubPortfolio: {
        summary: githubPortfolioSummary,
      },
      linkedin: {
        summary: linkedinSummary,
      },
      job: {
        role: job.role,
        company: job.company_name,
        tags: jobTags,
        totalTags: jobTags.length,
      },
    });
  } catch (error) {
    console.error('Error processing application:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/applications/:id/consent - Mark consent given
router.post('/:id/consent', async (req, res) => {
  try {
    const application = await Application.findById(req.params.id);
    
    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    application.consent_given = true;
    await application.save();

    res.json({ message: 'Consent recorded', application });
  } catch (error) {
    console.error('Error updating consent:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/applications/:id/approve-level1 - Approve application and auto-send email if enabled
router.post('/:id/approve-level1', async (req, res) => {
  try {
    const application = await Application.findById(req.params.id).populate('jobId').populate('userId');
    
    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    if (!application.consent_given) {
      return res.status(400).json({ error: 'Consent not given. Cannot approve without consent.' });
    }

    application.level1_approved = true;
    await application.save();

    const job = application.jobId;
    const user = application.userId;

    // Auto-send email if enabled
    if (job.settings.autoInviteOnLevel1Approval && 
        application.unifiedScore >= job.settings.autoInviteThreshold) {
      
      // Find or create screening
      let screening = await Screening.findOne({ applicationId: application._id });
      if (!screening) {
        screening = new Screening({
          applicationId: application._id,
          jobId: job._id,
          screening_link: `https://hirewise.app/screening/${uuidv4()}`,
        });
        await screening.save();
      }

      // Generate dynamic email based on candidate profile and scores
      const emailLLMResponse = await callLLM('EMAIL_GENERATOR', {
        candidateName: user.name,
        candidateEmail: user.email,
        role: job.role,
        company: job.company_name,
        seniority: job.seniority,
        screening_link: screening.screening_link,
        screening_questions: [], // Questions will be generated on-the-spot when candidate accesses screening
        // Candidate scores and highlights
        scores: {
          resumeScore: application.scores.resumeScore,
          githubPortfolioScore: application.scores.githubPortfolioScore,
          compensationScore: application.scores.compensationScore,
          unifiedScore: application.unifiedScore,
        },
        // Resume highlights from LLM analysis
        resumeHighlights: application.rawResumeLLM ? (() => {
          try {
            const parsed = JSON.parse(application.rawResumeLLM);
            return {
              skills_matched: parsed.skills_matched || [],
              top_reasons: parsed.top_reasons || [],
              recommended_action: parsed.recommended_action,
            };
          } catch {
            return null;
          }
        })() : null,
        // User profile info
        userProfile: {
          githubUrl: user.githubUrl,
          portfolioUrl: user.portfolioUrl,
          compensationExpectation: user.compensationExpectation,
        },
        // Job details for personalization
        jobDetails: {
          must_have_skills: job.must_have_skills,
          nice_to_have: job.nice_to_have,
          tags: job.tags,
        },
      });

      const emailParsed = parseJsonSafely(emailLLMResponse);
      
      if (emailParsed.ok) {
        const emailData = emailParsed.json;
        
        // Send email
        const emailResult = await sendEmail({
          to: user.email,
          subject: emailData.subject,
          html: emailData.html_snippet,
          text: emailData.plain_text,
        });

        if (!emailResult.ok) {
          console.error('[Application] Failed to send email:', emailResult.error);
          // Continue even if email fails - don't block the approval
        }

        screening.invite_sent_at = new Date();
        await screening.save();
      }
    }

    res.json({ 
      message: 'Application approved',
      application,
      emailSent: job.settings.autoInviteOnLevel1Approval && 
                 application.unifiedScore >= job.settings.autoInviteThreshold,
    });
  } catch (error) {
    console.error('Error approving application:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

export default router;

