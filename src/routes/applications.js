import express from 'express';
import Job from '../models/Job.js';
import Application from '../models/Application.js';
import User from '../models/User.js';
import Screening from '../models/Screening.js'; // Still used for video screenings
import JobCandidateMatch from '../models/JobCandidateMatch.js';
import { callLLM } from '../lib/llm.js';
import { parseJsonSafely } from '../lib/parseJsonSafely.js';
import { extractTagsFromResume } from '../lib/embeddings.js';
import { saveUploadedFile, readFileAsText } from '../lib/storage.js';
import { sendEmail } from '../lib/email.js';
import { upload, uploadMultiple } from '../middleware/upload.js';
import { v4 as uuidv4 } from 'uuid';
import { fetchGitHubData, formatGitHubDataForLLM } from '../lib/github.js';
import BatchResumeValidation from '../models/BatchResumeValidation.js';
import { makeBlandAICall, getCallStatus } from '../lib/blandAi.js';
import { formatPhoneNumber } from '../lib/phoneFormatter.js';

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

    // Filter by approval/rejection status if provided
    if (status === 'approved') {
      query.level1_approved = true;
      query.rejected = false; // Approved applications are not rejected
    } else if (status === 'pending') {
      query.level1_approved = false;
      query.rejected = false; // Pending applications are not rejected
    } else if (status === 'rejected') {
      query.rejected = true;
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
      .populate('userId', 'name email phone githubUrl portfolioUrl linkedinUrl compensationExpectation tags resumeSummary parsedResume currentTenure totalExperience isRecentSwitcher currentCompany lastJobSwitchDate')
      .populate('matchId', 'matchScore status')
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    // Get total count for pagination
    const total = await Application.countDocuments(query);

    // Format response (filter out applications with null userId)
    const formattedApplications = applications
      .filter(app => app.userId !== null && app.userId !== undefined) // Filter out null users
      .map(app => ({
        applicationId: app._id,
        userId: app.userId?._id || null,
        candidate: {
          name: app.userId?.name || 'Unknown',
          email: app.userId?.email || null,
          phone: app.userId?.phone || null,
          githubUrl: app.userId?.githubUrl || null,
          portfolioUrl: app.userId?.portfolioUrl || null,
          linkedinUrl: app.userId?.linkedinUrl || null,
          compensationExpectation: app.userId?.compensationExpectation || null,
          tags: app.userId?.tags || [],
          parsedResume: app.userId?.parsedResume || null,
          resumeSummary: app.userId?.resumeSummary || null,
          currentTenure: app.userId?.currentTenure || null,
          totalExperience: app.userId?.totalExperience || null,
          isRecentSwitcher: app.userId?.isRecentSwitcher || false,
          currentCompany: app.userId?.currentCompany || null,
          lastJobSwitchDate: app.userId?.lastJobSwitchDate || null,
        },
      skillsMatched: app.skillsMatched || [],
      skillsMissing: app.skillsMissing || [],
      topReasons: app.topReasons || [],
      recommendedAction: app.recommendedAction || null,
      scores: {
        resumeScore: app.scores?.resumeScore || null,
        githubPortfolioScore: app.scores?.githubPortfolioScore || null,
        compensationScore: app.scores?.compensationScore || null,
        aiToolsCompatibilityScore: app.scores?.aiToolsCompatibilityScore || null,
        unifiedScore: app.unifiedScore || null,
        compensationAnalysis: app.scores?.compensationAnalysis || null,
        aiToolsCompatibilityAnalysis: app.scores?.aiToolsCompatibilityAnalysis || null,
      },
      status: {
        level1Approved: app.level1_approved,
        rejected: app.rejected || false,
        rejectedAt: app.rejectedAt || null,
        rejectionReason: app.rejectionReason || null,
      },
      matchInfo: app.matchId ? {
        matchId: app.matchId?._id || null,
        matchScore: app.matchId?.matchScore || null,
        status: app.matchId?.status || null,
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
    resumeScore: 0.4,
    githubPortfolioScore: 0.25,
    compensationScore: 0.15,
    aiToolsCompatibilityScore: 0.2,
  };

  const resumeScore = scores.resumeScore || 0;
  const githubPortfolioScore = scores.githubPortfolioScore || 0;
  const compensationScore = scores.compensationScore || 0;
  const aiToolsCompatibilityScore = scores.aiToolsCompatibilityScore || 0;

  const unified = (
    resumeScore * weights.resumeScore +
    githubPortfolioScore * weights.githubPortfolioScore +
    compensationScore * weights.compensationScore +
    aiToolsCompatibilityScore * weights.aiToolsCompatibilityScore
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

    // Save resume file to S3 (or local storage) - minimal sync operation
    const resumePathOrUrl = await saveUploadedFile(req.file);
    
    // Determine if it's an S3 URL or local path
    const isS3Url = resumePathOrUrl && resumePathOrUrl.startsWith('https://') && resumePathOrUrl.includes('.s3.');

    // Use provided email (extraction from resume will happen async)
    if (!applicant_email) {
      return res.status(400).json({ error: 'applicant_email is required' });
    }
    const finalEmail = applicant_email.toLowerCase();

    // Find or create user with minimal info (only what's provided in request)
    let user = await User.findOne({ email: finalEmail });
    
    if (!user) {
      user = new User({
        email: finalEmail,
        name: applicant_name || 'Unknown',
        phone: applicant_phone || null,
        resumePath: resumePathOrUrl, // Keep for backward compatibility
        resumeS3Url: isS3Url ? resumePathOrUrl : null, // Store S3 URL if it's from S3
        githubUrl: githubUrl || null,
        portfolioUrl: portfolioUrl || null,
        linkedinUrl: linkedinUrl || null,
        compensationExpectation: compensationExpectation || null,
      });
    } else {
      // Update user with provided info (only if not already set)
      if (resumePathOrUrl) {
        user.resumePath = resumePathOrUrl;
        user.resumeS3Url = isS3Url ? resumePathOrUrl : null;
      }
      if (applicant_name && applicant_name !== 'Unknown' && (!user.name || user.name === 'Unknown')) {
        user.name = applicant_name;
      }
      if (applicant_phone && !user.phone) {
        user.phone = applicant_phone;
      }
      if (githubUrl && !user.githubUrl) {
        user.githubUrl = githubUrl;
      }
      if (portfolioUrl && !user.portfolioUrl) {
        user.portfolioUrl = portfolioUrl;
      }
      if (linkedinUrl && !user.linkedinUrl) {
        user.linkedinUrl = linkedinUrl;
      }
      if (compensationExpectation && !user.compensationExpectation) {
        user.compensationExpectation = compensationExpectation;
      }
    }
    await user.save();

    // Check if there's an existing match for this job-candidate pair
    const existingMatch = await JobCandidateMatch.findOne({
      jobId: job._id,
      userId: user._id,
    });

    // Create application immediately with minimal data
    const application = new Application({
      jobId: job._id,
      userId: user._id,
      resumePath: resumePathOrUrl, // Can be S3 URL or local path
      resumeText: '', // Will be populated async
      level1_approved: false,
      matchId: existingMatch?._id || null,
      // Scores will be updated asynchronously
      scores: {
        resumeScore: 0,
        githubPortfolioScore: 0,
        compensationScore: 0,
        aiToolsCompatibilityScore: 0,
      },
      unifiedScore: 0,
    });
    await application.save();

    // Update match status to 'applied' and link to application
    if (existingMatch) {
      existingMatch.status = 'applied';
      existingMatch.applicationId = application._id;
      await existingMatch.save();
    }

    // Return immediate success response (before any LLM processing)
    res.status(201).json({
      message: 'Application submitted successfully',
      applicationId: application._id,
      job: {
        role: job.role,
        company: job.company_name,
      },
    });

    // Process ALL LLM operations asynchronously (don't await - fire and forget)
    processApplicationScoring(application._id, job._id, user._id, resumePathOrUrl, githubUrl, portfolioUrl, linkedinUrl).catch(error => {
      console.error(`[Application] Error processing scoring for application ${application._id}:`, error);
    });
  } catch (error) {
    console.error('Error processing application:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * Async function to process application scoring (resume, GitHub/Portfolio, compensation)
 * This runs in the background after the application is created
 */
async function processApplicationScoring(applicationId, jobId, userId, resumePathOrUrl, githubUrl, portfolioUrl, linkedinUrl) {
  try {
    console.log(`[Application] Starting async scoring for application ${applicationId}`);
    
    // Fetch job, user, and application from database
    const job = await Job.findById(jobId);
    const user = await User.findById(userId);
    const application = await Application.findById(applicationId);
    
    if (!job || !user || !application) {
      throw new Error('Job, user, or application not found');
    }
    
    // Extract resume text (this is now async)
    const resumeText = await readFileAsText(resumePathOrUrl);
    
    // Log extracted resume text for debugging
    if (resumeText) {
      console.log(`[Application] Extracted ${resumeText.length} characters from resume`);
      console.log(`[Application] Resume text preview (first 500 chars): ${resumeText.substring(0, 500)}...`);
    } else {
      console.warn('[Application] Warning: No text extracted from resume file');
    }
    
    // Update application and user with resume text
    application.resumeText = resumeText;
    await application.save();
    
    user.resumeText = resumeText;
    await user.save();
    
    // Parallel execution: Run all resume-related LLM calls and GitHub data fetch simultaneously
    const resumeProcessingPromises = [];
    let resumeTags = [];
    let resumeSummary = '';
    let parsedResumeData = null;
    let resumeScore = 0;
    let skillsMatched = [];
    let skillsMissing = [];
    let topReasons = [];
    let recommendedAction = null;
    let resumeLLMResponse = ''; // Store raw LLM response for rawResumeLLM field
    
    if (resumeText && resumeText.trim().length > 0) {
      // Extract tags from resume (LLM call)
      resumeProcessingPromises.push(
        extractTagsFromResume(resumeText)
          .then(tags => {
            resumeTags = tags;
            console.log(`[Application] Extracted ${tags.length} tags from resume using LLM`);
          })
          .catch(error => {
            console.error('[Application] Error extracting tags from resume:', error);
          })
      );
      
      // Generate resume summary (LLM call)
      resumeProcessingPromises.push(
        callLLM('RESUME_SUMMARY', { resumeText })
          .then(summaryResponse => {
            const summaryParsed = parseJsonSafely(summaryResponse);
            if (summaryParsed.ok && summaryParsed.json.summary) {
              resumeSummary = summaryParsed.json.summary;
              console.log('[Application] Generated resume summary:', resumeSummary.substring(0, 200));
            } else {
              console.error('[Application] Failed to parse resume summary response:', summaryParsed.error);
            }
          })
          .catch(error => {
            console.error('[Application] Error generating resume summary:', error);
          })
      );
      
      // Parse resume with LLM (LLM call)
      resumeProcessingPromises.push(
        callLLM('RESUME_PARSER', { resumeText })
          .then(parseResponse => {
            const parsed = parseJsonSafely(parseResponse);
            if (parsed.ok) {
              parsedResumeData = parsed.json;
              console.log('[Application] Resume parsed successfully with LLM');
            } else {
              console.error('[Application] Failed to parse LLM response for resume parsing:', parsed.error);
            }
          })
          .catch(error => {
            console.error('[Application] Error parsing resume with LLM:', error);
          })
      );
      
      // Score resume (LLM call)
      resumeProcessingPromises.push(
        callLLM('RESUME_SCORING', { resumeText, job })
          .then(response => {
            resumeLLMResponse = response; // Store raw response
            const resumeParsed = parseJsonSafely(response);
            if (resumeParsed.ok) {
              resumeScore = resumeParsed.json.match_score || 0;
              skillsMatched = resumeParsed.json.skills_matched || [];
              skillsMissing = resumeParsed.json.skills_missing || [];
              topReasons = resumeParsed.json.top_reasons || [];
              recommendedAction = resumeParsed.json.recommended_action || null;
              console.log('[Application] Resume scored:', resumeScore);
            }
          })
          .catch(error => {
            console.error('[Application] Error scoring resume:', error);
          })
      );
    } else {
      console.warn('[Application] Skipping resume processing: no valid resume text extracted');
    }
    
    // Wait for all resume processing to complete
    await Promise.all(resumeProcessingPromises);
    
    // Extract contact information from parsed resume if not provided
    let extractedName = null;
    let extractedEmail = null;
    let extractedPhone = null;
    let extractedLinkedIn = null;
    let finalGithubUrl = githubUrl || user.githubUrl;
    let finalPortfolioUrl = portfolioUrl || user.portfolioUrl;
    let githubDataFormatted = '';
    
    if (parsedResumeData) {
      // Extract name from parsed resume
      if (parsedResumeData.name) {
        extractedName = parsedResumeData.name.trim();
        console.log(`[Application] Extracted name from parsed resume: ${extractedName}`);
      }
      
      // Extract contact information from parsed resume
      if (parsedResumeData.contact) {
        if (parsedResumeData.contact.email) {
          extractedEmail = parsedResumeData.contact.email.trim().toLowerCase();
          console.log(`[Application] Extracted email from parsed resume: ${extractedEmail}`);
        }
        if (parsedResumeData.contact.phone) {
          extractedPhone = parsedResumeData.contact.phone.trim();
          console.log(`[Application] Extracted phone from parsed resume: ${extractedPhone}`);
        }
        if (parsedResumeData.contact.linkedin) {
          extractedLinkedIn = parsedResumeData.contact.linkedin.trim();
          console.log(`[Application] Extracted LinkedIn URL from parsed resume: ${extractedLinkedIn}`);
        }
        if (!finalGithubUrl && parsedResumeData.contact.github) {
          finalGithubUrl = parsedResumeData.contact.github.trim();
          console.log(`[Application] Extracted GitHub URL from parsed resume: ${finalGithubUrl}`);
        }
        if (!finalPortfolioUrl && parsedResumeData.contact.portfolio) {
          finalPortfolioUrl = parsedResumeData.contact.portfolio.trim();
          console.log(`[Application] Extracted portfolio URL from parsed resume: ${finalPortfolioUrl}`);
        }
      }
    }
    
    // Update user with extracted data (only if not already provided)
    if (resumeTags.length > 0) user.tags = resumeTags;
    if (parsedResumeData) {
      user.parsedResume = parsedResumeData;
      
      // Update name if extracted and not already set or if current name is generic
      if (extractedName && (!user.name || user.name === 'Unknown' || user.name.trim() === '')) {
        user.name = extractedName;
        console.log(`[Application] Updated user name from resume: ${extractedName}`);
      }
      
      // Update email if extracted and matches the application email (for validation)
      // Note: We don't change email if it's different to avoid breaking user identity
      if (extractedEmail && extractedEmail === user.email.toLowerCase()) {
        // Email matches, no update needed
      } else if (extractedEmail && !user.email) {
        // Only update if user email is missing
        user.email = extractedEmail;
        console.log(`[Application] Updated user email from resume: ${extractedEmail}`);
      }
      
      // Update phone if extracted and not already provided
      if (extractedPhone && (!user.phone || user.phone.trim() === '')) {
        user.phone = extractedPhone;
        console.log(`[Application] Updated user phone from resume: ${extractedPhone}`);
      }
      
      // Update LinkedIn if extracted and not already provided
      if (extractedLinkedIn && (!user.linkedinUrl || user.linkedinUrl.trim() === '')) {
        user.linkedinUrl = extractedLinkedIn;
        console.log(`[Application] Updated user LinkedIn URL from resume: ${extractedLinkedIn}`);
      }
      
      // Extract and store experience-related fields from parsed resume
      if (parsedResumeData.currentTenure) user.currentTenure = parsedResumeData.currentTenure;
      if (parsedResumeData.totalExperience) user.totalExperience = parsedResumeData.totalExperience;
      if (parsedResumeData.isRecentSwitcher !== undefined) user.isRecentSwitcher = parsedResumeData.isRecentSwitcher;
      if (parsedResumeData.currentCompany) user.currentCompany = parsedResumeData.currentCompany;
      if (parsedResumeData.lastJobSwitchDate) user.lastJobSwitchDate = parsedResumeData.lastJobSwitchDate;
    }
    if (resumeSummary) user.resumeSummary = resumeSummary;
    if (finalGithubUrl) user.githubUrl = finalGithubUrl;
    if (finalPortfolioUrl) user.portfolioUrl = finalPortfolioUrl;
    await user.save();
    
    // Fetch GitHub data if we have a GitHub URL
    if (finalGithubUrl) {
      try {
        console.log(`[Application] Fetching GitHub data for: ${finalGithubUrl}`);
        const githubData = await fetchGitHubData(finalGithubUrl);
        githubDataFormatted = formatGitHubDataForLLM(githubData);
        console.log(`[Application] Fetched GitHub data: ${githubData.error ? 'Error' : `${githubData.repositories?.length || 0} repositories`}`);
      } catch (error) {
        console.error('[Application] Error fetching GitHub data:', error);
      }
    }

    // Parallel execution: Run GitHub/Portfolio scoring, LinkedIn summary, and compensation analysis simultaneously
    const scoringPromises = [];
    let githubPortfolioScore = 0;
    let githubPortfolioSummary = '';
    let linkedinSummary = '';
    let compensationScore = 0;
    let compensationAnalysis = '';
    let aiToolsCompatibilityScore = 0;
    let aiToolsCompatibilityAnalysis = '';
    
    // Score GitHub/Portfolio (if GitHub data was fetched or portfolio URL exists)
    if (githubDataFormatted || finalPortfolioUrl) {
      scoringPromises.push(
        callLLM('GITHUB_PORTFOLIO_SCORING', {
          githubData: githubDataFormatted,
          portfolioUrl: finalPortfolioUrl,
          job,
        })
          .then(githubLLMResponse => {
            const githubParsed = parseJsonSafely(githubLLMResponse);
            if (githubParsed.ok) {
              githubPortfolioScore = githubParsed.json.score || 0;
              githubPortfolioSummary = githubParsed.json.summary || '';
              console.log('[Application] Generated GitHub/Portfolio summary:', githubPortfolioSummary.substring(0, 200));
            } else {
              console.error('[Application] Failed to parse GitHub/Portfolio response:', githubParsed.error);
            }
          })
          .catch(error => {
            console.error('[Application] Error processing GitHub/Portfolio:', error);
          })
      );
    }
    
    // Generate LinkedIn summary (if LinkedIn URL exists)
    if (user.linkedinUrl) {
      scoringPromises.push(
        callLLM('LINKEDIN_SUMMARY', {
          linkedinUrl: user.linkedinUrl,
        })
          .then(linkedinResponse => {
            const linkedinParsed = parseJsonSafely(linkedinResponse);
            if (linkedinParsed.ok && linkedinParsed.json.summary) {
              linkedinSummary = linkedinParsed.json.summary;
              console.log('[Application] Generated LinkedIn summary');
            }
          })
          .catch(error => {
            console.error('[Application] Error generating LinkedIn summary:', error);
          })
      );
    }

    // Score compensation (if compensation expectation and budget info exist)
    if (user.compensationExpectation && job.budget_info) {
      scoringPromises.push(
        callLLM('COMPENSATION_ANALYSIS', {
          compensationExpectation: user.compensationExpectation,
          budget_info: job.budget_info,
        })
          .then(compLLMResponse => {
            const compParsed = parseJsonSafely(compLLMResponse);
            if (compParsed.ok) {
              compensationScore = compParsed.json.score || 0;
              compensationAnalysis = compParsed.json.analysis || '';
            }
          })
          .catch(error => {
            console.error('[Application] Error analyzing compensation:', error);
          })
      );
    }

    // Score AI Tools Compatibility (analyze resume, GitHub, and portfolio for AI/ML tools usage)
    if (resumeText || githubDataFormatted || finalPortfolioUrl) {
      scoringPromises.push(
        callLLM('AI_TOOLS_COMPATIBILITY', {
          resumeText: resumeText || '',
          githubData: githubDataFormatted || '',
          portfolioUrl: finalPortfolioUrl || '',
          parsedResume: user.parsedResume || null,
        })
          .then(aiLLMResponse => {
            const aiParsed = parseJsonSafely(aiLLMResponse);
            if (aiParsed.ok) {
              aiToolsCompatibilityScore = aiParsed.json.score || 0;
              aiToolsCompatibilityAnalysis = aiParsed.json.analysis || '';
              console.log(`[Application] AI Tools Compatibility Score: ${aiToolsCompatibilityScore}`);
            } else {
              console.error('[Application] Failed to parse AI Tools Compatibility response:', aiParsed.error);
            }
          })
          .catch(error => {
            console.error('[Application] Error analyzing AI tools compatibility:', error);
          })
      );
    }
    
    // Wait for all scoring operations to complete in parallel
    await Promise.all(scoringPromises);

    // Calculate unified score
    const scores = {
      resumeScore,
      githubPortfolioScore,
      compensationScore,
      compensationAnalysis,
      aiToolsCompatibilityScore,
      aiToolsCompatibilityAnalysis,
    };
    const unifiedScore = calculateUnifiedScore(scores);

    // Update application with all scoring data (application was already fetched at the start)
    if (application) {
      application.scores = scores;
      application.unifiedScore = unifiedScore;
      application.rawResumeLLM = resumeLLMResponse;
      application.skillsMatched = skillsMatched;
      application.skillsMissing = skillsMissing;
      application.topReasons = topReasons;
      application.recommendedAction = recommendedAction;
      await application.save();

      // Note: Screening model creation removed - no longer auto-creating screenings

      console.log(`[Application] Completed async scoring for application ${applicationId}`);
    } else {
      console.error(`[Application] Application ${applicationId} not found for scoring update`);
    }
  } catch (error) {
    console.error(`[Application] Error in async scoring for application ${applicationId}:`, error);
  }
}

// POST /api/applications/:id/consent - Mark consent given
router.post('/:id/consent', async (req, res) => {
  try {
    const application = await Application.findById(req.params.id);
    
    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

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


    application.level1_approved = true;
    // If rejected, unset rejection (can't be both approved and rejected)
    if (application.rejected) {
      application.rejected = false;
      application.rejectedAt = null;
      application.rejectionReason = null;
    }
    await application.save();

    const job = application.jobId;
    const user = application.userId;

    // Generate email data (but don't send it)
    let emailData = null;
    let emailError = null;

      
    try {
    // Generate dynamic email based on candidate profile and scores
    const emailLLMResponse = await callLLM('EMAIL_GENERATOR', {
        candidateName: user.name,
        candidateEmail: user.email,
        role: job.role,
        company: job.company_name,
        seniority: job.seniority,
        screening_link: null, // No screening link since we're not creating screening
        screening_questions: [], // Questions will be generated on-the-spot when candidate accesses screening
        // Candidate scores and highlights
        scores: {
        resumeScore: application.scores?.resumeScore,
        githubPortfolioScore: application.scores?.githubPortfolioScore,
        compensationScore: application.scores?.compensationScore,
        aiToolsCompatibilityScore: application.scores?.aiToolsCompatibilityScore,
        unifiedScore: application.unifiedScore,
        },
        // Resume highlights from LLM analysis
        resumeHighlights: application.rawResumeLLM ? (() => {
        try {
            const parsed = typeof application.rawResumeLLM === 'string' 
            ? JSON.parse(application.rawResumeLLM)
            : application.rawResumeLLM;
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
        emailData = emailParsed.json;
    } else {
        emailError = emailParsed.error || 'Failed to parse email response';
    }
    } catch (error) {
    console.error('[Application] Error generating email:', error);
    emailError = error.message || 'Failed to generate email';
    }

    res.json({ 
      message: 'Application approved',
      application: {
        _id: application._id,
        jobId: application.jobId,
        userId: application.userId,
        level1_approved: application.level1_approved,
        unifiedScore: application.unifiedScore,
        scores: application.scores,
        skillsMatched: application.skillsMatched,
        topReasons: application.topReasons,
        recommendedAction: application.recommendedAction,
      },
      emailData: emailData ? {
        subject: emailData.subject,
        html: emailData.html_snippet,
        text: emailData.plain_text,
        preview_text: emailData.preview_text,
        to: user.email,
      } : null,
      emailError: emailError || null,
      scheduleCallUrl: `/api/applications/${application._id}/schedule-call`, // Phone interview uses applicationId
    });
  } catch (error) {
    console.error('Error approving application:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/applications/:id/schedule-call - Schedule/initiate phone interview via Bland AI with optional start_time
router.post('/:id/schedule-call', async (req, res) => {
  try {
    const { id } = req.params;
    const { start_time, userId } = req.body; // Optional: userId if no application, start_time for scheduling

    // Determine if id is applicationId or userId, or use userId from body
    const targetUserId = userId || id;
    let application = null;
    let user = null;
    let job = null;
    let isUserOnlyCall = false;

    // Try to find application first
    try {
      application = await Application.findById(id)
        .populate('jobId')
        .populate('userId');
    } catch (err) {
      // If id is not a valid ObjectId for Application, treat as userId
      console.log(`[Application] ID ${id} not found as application, trying as userId`);
    }

    if (application && application.userId) {
      // Application found - use application context
      job = application.jobId;
      user = application.userId;
      isUserOnlyCall = false;
    } else {
      // No application found - treat as user-only call (from AI search)
      user = await User.findById(targetUserId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      isUserOnlyCall = true;
    }

    if (!user || !user.phone) {
      return res.status(400).json({ error: 'Candidate phone number not found' });
    }

    // Format phone number to E.164 format (required by Bland AI)
    let phoneNumber;
    try {
      phoneNumber = formatPhoneNumber(user.phone, '91'); // Default to India (+91)
    } catch (error) {
      return res.status(400).json({ 
        error: 'Invalid phone number format', 
        details: error.message,
        provided: user.phone 
      });
    }

    // Get or generate screening questions
    let questions = [];
    
    if (isUserOnlyCall) {
      // User-only call: Generate questions based on resume only (no job context)
      // Check if user has stored questions from a previous call
      if (user.phoneInterviewSummaries && user.phoneInterviewSummaries.length > 0) {
        const lastCall = user.phoneInterviewSummaries[user.phoneInterviewSummaries.length - 1];
        if (lastCall.questions && lastCall.questions.length > 0) {
          questions = lastCall.questions;
        }
      }

      // If no stored questions, generate based on resume
      if (questions.length === 0) {
        if (!user.resumeText || user.resumeText.trim().length === 0) {
          return res.status(400).json({ 
            error: 'Resume text not available. Cannot generate interview questions without resume.' 
          });
        }

        // Generate questions based on resume only (no job)
        const questionsResponse = await callLLM('SCREENING_QUESTIONS', {
          candidateInfo: {
            name: user.name,
            skills: user.tags || [],
          },
          resumeText: user.resumeText, // Pass resume text for generic questions
        });
        const parsed = parseJsonSafely(questionsResponse);
        questions = parsed.ok ? parsed.json.screening_questions : [];
      }
    } else {
      // Application-based call: Use questions from Application if already stored, otherwise generate
      if (application.phoneInterview && application.phoneInterview.questions && application.phoneInterview.questions.length > 0) {
        questions = application.phoneInterview.questions;
      } else {
        // Generate questions on the spot (job-specific)
        const questionsResponse = await callLLM('SCREENING_QUESTIONS', {
          job,
          candidateInfo: {
            name: user.name,
            skills: application.skillsMatched || user.tags || [],
          },
        });
        const parsed = parseJsonSafely(questionsResponse);
        questions = parsed.ok ? parsed.json.screening_questions : [];
      }
    }

    // Make Bland AI call (with optional start_time for scheduling)
    const callResult = await makeBlandAICall({
      phoneNumber,
      candidateName: user.name,
      job: job || null, // null for user-only calls
      application: application || null, // null for user-only calls
      user: isUserOnlyCall ? user : null, // Pass user for generic calls
      questions,
      applicationId: application ? application._id.toString() : null,
      userId: user._id.toString(), // Always pass userId
      startTime: start_time || null,
    });

    if (isUserOnlyCall) {
      // Store in user's phoneInterviewSummaries array
      const phoneInterviewSummary = {
        callId: callResult.callId,
        status: start_time ? 'scheduled' : 'ringing',
        phoneNumber: phoneNumber,
        startedAt: start_time ? null : new Date(),
        scheduledStartTime: start_time || null,
        questions: questions,
      };

      // Add to user's phone interview summaries array
      if (!user.phoneInterviewSummaries) {
        user.phoneInterviewSummaries = [];
      }
      user.phoneInterviewSummaries.push(phoneInterviewSummary);
      await user.save();
    } else {
      // Store in application's phoneInterview object
      if (!application.phoneInterview) {
        application.phoneInterview = {};
      }
      application.phoneInterview.callId = callResult.callId;
      application.phoneInterview.status = start_time ? 'scheduled' : 'ringing';
      application.phoneInterview.phoneNumber = phoneNumber;
      application.phoneInterview.startedAt = start_time ? null : new Date();
      application.phoneInterview.scheduledStartTime = start_time || null;
      application.phoneInterview.questions = questions;
      await application.save();
    }

    // Send email notification about the phone interview (async - don't wait)
    if (user.email) {
      (async () => {
        try {
          // Generate email content using LLM
          const emailLLMResponse = await callLLM('PHONE_INTERVIEW_EMAIL', {
            candidateName: user.name,
            role: job ? job.role : 'Potential Role', // Generic if no job
            company: job ? job.company_name : 'Paytm',
            phoneNumber: phoneNumber,
            scheduledStartTime: start_time,
            questions: questions,
            applicationId: application ? application._id.toString() : null,
          });

          const emailParsed = parseJsonSafely(emailLLMResponse);
          
          if (emailParsed.ok) {
            const emailData = emailParsed.json;
            
            // Send email
            const emailResult = await sendEmail({
              to: user.email,
              subject: emailData.subject || (job ? `Phone Interview Invitation - ${job.role} at ${job.company_name}` : 'Phone Interview Invitation - Paytm'),
              html: emailData.html_snippet || emailData.plain_text,
              text: emailData.plain_text || emailData.html_snippet?.replace(/<[^>]*>/g, ''),
            });

            if (emailResult.ok) {
              console.log(`[Application] Phone interview email sent to ${user.email} for ${isUserOnlyCall ? 'user' : 'application'} ${isUserOnlyCall ? user._id : application._id}`);
            } else {
              console.error(`[Application] Failed to send phone interview email:`, emailResult.error);
            }
          } else {
            console.error('[Application] Failed to parse phone interview email response:', emailParsed.error);
            // Fallback: Send a simple email if LLM fails
            const fallbackSubject = start_time 
              ? (job ? `Phone Interview Scheduled - ${job.role} at ${job.company_name}` : 'Phone Interview Scheduled - Paytm')
              : (job ? `Phone Interview Invitation - ${job.role} at ${job.company_name}` : 'Phone Interview Invitation - Paytm');
            
            const fallbackHtml = `
              <h2>Hello ${user.name},</h2>
              <p>${job ? `Congratulations! You have been shortlisted for the <strong>${job.role}</strong> position at ${job.company_name || 'Paytm'}.</p>` : 'We came across your profile and would like to have a conversation with you.</p>'}
              <p>We would like to invite you for an AI-based phone interview.</p>
              ${start_time ? `<p><strong>Scheduled Time:</strong> ${start_time}</p>` : '<p>You will receive a call shortly at: <strong>' + phoneNumber + '</strong></p>'}
              <p><strong>What to expect:</strong></p>
              <ul>
                <li>An AI interviewer named "Neo" will call you</li>
                <li>The interview will take approximately 5-10 minutes</li>
                <li>You'll be asked technical and behavioral questions${job ? '' : ' based on your resume'}</li>
                <li>Please answer naturally and be patient if there are brief pauses</li>
              </ul>
              <p>We look forward to speaking with you!</p>
              <p>Best regards,<br>${job ? job.company_name || 'Paytm' : 'Paytm'} HR Team</p>
            `;
            
            await sendEmail({
              to: user.email,
              subject: fallbackSubject,
              html: fallbackHtml,
              text: fallbackHtml.replace(/<[^>]*>/g, ''),
            });
          }
        } catch (error) {
          console.error(`[Application] Error sending phone interview email:`, error);
          // Don't fail the request if email fails
        }
      })();
    }

    res.json({
      message: start_time ? 'Phone interview call scheduled' : 'Phone interview call initiated',
      callId: callResult.callId,
      status: callResult.status,
      phoneNumber: phoneNumber,
      userId: user._id,
      applicationId: application ? application._id : null,
      isUserOnlyCall: isUserOnlyCall,
      startTime: start_time || null,
      emailSent: user.email ? true : false,
      checkStatusUrl: isUserOnlyCall 
        ? `/api/users/${user._id}/phone-call-status`
        : `/api/applications/${application._id}/phone-call-status`,
    });
  } catch (error) {
    console.error('Error scheduling/initiating phone call:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /api/applications/:id/phone-call-status - Get phone call status
router.get('/:id/phone-call-status', async (req, res) => {
  try {
    const { id } = req.params;
    const application = await Application.findById(id);

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    if (!application.phoneInterview || !application.phoneInterview.callId) {
      return res.status(400).json({ error: 'No phone call initiated for this application' });
    }

    // Get latest status from Bland AI (including recording URL if available)
    try {
      const callStatus = await getCallStatus(application.phoneInterview.callId);
      
      // Update application with latest status
      if (callStatus.status) {
        application.phoneInterview.status = mapBlandStatusToInternal(callStatus.status);
      }
      
      // Recording URL is available when call is completed
      if (callStatus.recording_url) {
        application.phoneInterview.recordingUrl = callStatus.recording_url;
        console.log(`[Application] Recording URL retrieved: ${callStatus.recording_url}`);
      }
      
      if (callStatus.transcript) {
        application.phoneInterview.transcript = callStatus.transcript;
      }
      
      if (callStatus.summary) {
        application.phoneInterview.summary = callStatus.summary;
      }
      
      if (callStatus.analysis) {
        application.phoneInterview.analysis = callStatus.analysis;
      }
      
      if (callStatus.duration) {
        application.phoneInterview.duration = callStatus.duration;
      }
      
      if (callStatus.status === 'completed' || callStatus.status === 'ended') {
        application.phoneInterview.status = 'completed';
        application.phoneInterview.completedAt = new Date();
        
        // If recording URL not in status, try to fetch it explicitly
        if (!application.phoneInterview.recordingUrl) {
          try {
            const { getCallRecording } = await import('../lib/blandAi.js');
            const recordingData = await getCallRecording(application.phoneInterview.callId);
            if (recordingData.recordingUrl) {
              application.phoneInterview.recordingUrl = recordingData.recordingUrl;
              console.log(`[Application] Recording URL fetched explicitly: ${recordingData.recordingUrl}`);
            }
          } catch (recordingError) {
            console.warn(`[Application] Could not fetch recording URL:`, recordingError.message);
          }
        }
      }
      
      await application.save();
    } catch (error) {
      console.error('[Application] Error fetching call status from Bland AI:', error);
      // Continue with stored status if API call fails
    }

    res.json({
      applicationId: application._id,
      phoneInterview: application.phoneInterview,
    });
  } catch (error) {
    console.error('Error getting phone call status:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/applications/:id/webhook - Bland AI webhook for call updates
router.post('/:id/webhook', async (req, res) => {
  try {
    const { id } = req.params;
    const webhookData = req.body;

    console.log(`[Application] Webhook received for application ${id}:`, {
      status: webhookData.status,
      call_id: webhookData.call_id,
      has_recording: !!webhookData.recording_url,
    });

    const application = await Application.findById(id);
    
    if (!application) {
      console.error(`[Application] Webhook: Application ${id} not found`);
      return res.status(404).send('Application not found');
    }

    // Update phone interview status from webhook data
    if (!application.phoneInterview) {
      application.phoneInterview = {};
    }

    // Map Bland AI status to internal status
    if (webhookData.status) {
      application.phoneInterview.status = mapBlandStatusToInternal(webhookData.status);
    }
    
    // Update call ID if provided
    if (webhookData.call_id) {
      application.phoneInterview.callId = webhookData.call_id;
    }
    
    // Get recording URL when call completes
    if (webhookData.recording_url) {
      application.phoneInterview.recordingUrl = webhookData.recording_url;
      console.log(`[Application] Recording URL received: ${webhookData.recording_url}`);
    }
    
    // Update transcript if available
    if (webhookData.transcript) {
      application.phoneInterview.transcript = webhookData.transcript;
    }
    
    // Update summary if available
    if (webhookData.summary) {
      application.phoneInterview.summary = webhookData.summary;
    }
    
    // Update analysis if available
    if (webhookData.analysis) {
      application.phoneInterview.analysis = webhookData.analysis;
    }
    
    // Update duration if available
    if (webhookData.duration) {
      application.phoneInterview.duration = webhookData.duration;
    }
    
    // When call is completed, fetch full details including recording
    if (webhookData.status === 'completed' || webhookData.status === 'ended') {
      application.phoneInterview.status = 'completed';
      application.phoneInterview.completedAt = new Date();
      
      // Fetch full call details to ensure we have recording URL
      if (webhookData.call_id) {
        try {
          const { getCallStatus } = await import('../lib/blandAi.js');
          const fullCallData = await getCallStatus(webhookData.call_id);
          
          // Update with complete data
          if (fullCallData.recording_url) {
            application.phoneInterview.recordingUrl = fullCallData.recording_url;
          }
          if (fullCallData.transcript) {
            application.phoneInterview.transcript = fullCallData.transcript;
          }
          if (fullCallData.summary) {
            application.phoneInterview.summary = fullCallData.summary;
          }
          if (fullCallData.analysis) {
            application.phoneInterview.analysis = fullCallData.analysis;
          }
          
          console.log(`[Application] Full call data fetched for ${id}, recording: ${fullCallData.recording_url ? 'available' : 'not available'}`);
        } catch (fetchError) {
          console.error(`[Application] Error fetching full call data:`, fetchError);
          // Continue with webhook data if fetch fails
        }
      }
    }

    await application.save();
    console.log(`[Application] Webhook processed successfully for application ${id}`);

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error');
  }
});

// POST /api/applications/:id/reject - Mark candidate as rejected for this job
router.post('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason } = req.body; // Optional rejection reason

    const application = await Application.findById(id)
      .populate('jobId')
      .populate('userId');
    
    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    // Mark as rejected
    application.rejected = true;
    application.rejectedAt = new Date();
    if (rejectionReason) {
      application.rejectionReason = rejectionReason.trim();
    }
    
    // If approved, unapprove it (can't be both approved and rejected)
    if (application.level1_approved) {
      application.level1_approved = false;
    }
    
    await application.save();

    res.json({
      message: 'Candidate marked as rejected',
      application: {
        _id: application._id,
        jobId: application.jobId._id,
        userId: application.userId._id,
        candidateName: application.userId.name,
        jobRole: application.jobId.role,
        rejected: application.rejected,
        rejectedAt: application.rejectedAt,
        rejectionReason: application.rejectionReason,
      },
    });
  } catch (error) {
    console.error('Error rejecting application:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Helper function to map Bland AI status to internal status
function mapBlandStatusToInternal(blandStatus) {
  const statusMap = {
    'initiated': 'initiated',
    'ringing': 'ringing',
    'in-progress': 'in_progress',
    'completed': 'completed',
    'ended': 'completed',
    'failed': 'failed',
    'no-answer': 'no_answer',
    'busy': 'failed',
    'voicemail': 'no_answer',
  };
  return statusMap[blandStatus] || 'initiated';
}

// POST /api/applications/batch-validate/:jobId - Batch upload and validate up to 10 resumes
router.post('/batch-validate/:jobId', uploadMultiple.array('resumes', 10), async (req, res) => {
  try {
    const { jobId } = req.params;
    const files = req.files || [];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'At least one resume file is required' });
    }

    if (files.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 resumes allowed per batch' });
    }

    // Find job
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Create batch validation record
    const batchValidation = new BatchResumeValidation({
      jobId: job._id,
      status: 'pending',
      totalResumes: files.length,
      processedResumes: 0,
      results: files.map((file, index) => ({
        resumeIndex: index,
        filename: file.originalname,
        status: 'pending',
      })),
    });
    await batchValidation.save();

    // Return immediate response with batch ID
    res.status(202).json({
      message: 'Batch validation started',
      batchId: batchValidation._id,
      totalResumes: files.length,
      status: 'pending',
      checkStatusUrl: `/api/applications/batch-validate/${batchValidation._id}/status`,
    });

    // Process batch validation asynchronously (pub/sub pattern - fire and forget)
    processBatchResumeValidation(batchValidation._id, job, files).catch(error => {
      console.error(`[BatchValidation] Error processing batch ${batchValidation._id}:`, error);
    });
  } catch (error) {
    console.error('Error starting batch validation:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /api/applications/batch-validate/:batchId/status - Get batch validation status
router.get('/batch-validate/:batchId/status', async (req, res) => {
  try {
    const { batchId } = req.params;

    const batchValidation = await BatchResumeValidation.findById(batchId)
      .populate('jobId', 'role company_name');

    if (!batchValidation) {
      return res.status(404).json({ error: 'Batch validation not found' });
    }

    res.json({
      batchId: batchValidation._id,
      jobId: batchValidation.jobId._id,
      jobRole: batchValidation.jobId.role,
      jobCompany: batchValidation.jobId.company_name,
      status: batchValidation.status,
      totalResumes: batchValidation.totalResumes,
      processedResumes: batchValidation.processedResumes,
      progress: batchValidation.totalResumes > 0
        ? Math.round((batchValidation.processedResumes / batchValidation.totalResumes) * 100)
        : 0,
      results: await Promise.all(
        batchValidation.results.map(async (result) => {
          let applicationData = null;
          if (result.applicationId) {
            const app = await Application.findById(result.applicationId)
              .populate('userId', 'name email')
              .select('scores unifiedScore skillsMatched skillsMissing topReasons recommendedAction');
            if (app) {
              applicationData = {
                applicationId: app._id,
                matchScore: app.scores?.resumeScore || 0,
                unifiedScore: app.unifiedScore || 0,
                skillsMatched: app.skillsMatched || [],
                skillsMissing: app.skillsMissing || [],
                topReasons: app.topReasons || [],
                recommendedAction: app.recommendedAction,
                candidate: {
                  name: app.userId?.name,
                  email: app.userId?.email,
                },
              };
            }
          }
          return {
            resumeIndex: result.resumeIndex,
            filename: result.filename,
            applicationId: result.applicationId,
            status: result.status,
            error: result.error,
            processedAt: result.processedAt,
            application: applicationData,
          };
        })
      ),
      startedAt: batchValidation.startedAt,
      completedAt: batchValidation.completedAt,
      error: batchValidation.error,
    });
  } catch (error) {
    console.error('Error fetching batch validation status:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/**
 * Async function to process batch resume validation (pub/sub pattern)
 * Processes each resume validation asynchronously
 */
async function processBatchResumeValidation(batchId, job, files) {
  try {
    console.log(`[BatchValidation] Starting batch processing for batch ${batchId} with ${files.length} resumes`);

    // Update status to processing
    const batchValidation = await BatchResumeValidation.findById(batchId);
    if (!batchValidation) {
      console.error(`[BatchValidation] Batch ${batchId} not found`);
      return;
    }

    batchValidation.status = 'processing';
    await batchValidation.save();

    // Process each resume in parallel (pub/sub pattern - each resume is a separate async task)
    const processingPromises = files.map(async (file, index) => {
      return processSingleResumeValidation(batchId, job, file, index);
    });

    // Wait for all resumes to be processed
    await Promise.all(processingPromises);

    // Update batch status to completed
    const completedBatch = await BatchResumeValidation.findById(batchId);
    if (completedBatch) {
      completedBatch.status = 'completed';
      completedBatch.completedAt = new Date();
      await completedBatch.save();
      console.log(`[BatchValidation] Completed batch processing for batch ${batchId}`);
    }
  } catch (error) {
    console.error(`[BatchValidation] Error in batch processing for ${batchId}:`, error);
    const batchValidation = await BatchResumeValidation.findById(batchId);
    if (batchValidation) {
      batchValidation.status = 'failed';
      batchValidation.error = error.message;
      batchValidation.completedAt = new Date();
      await batchValidation.save();
    }
  }
}

/**
 * Process a single resume validation (subscriber in pub/sub pattern)
 */
async function processSingleResumeValidation(batchId, job, file, index) {
  try {
    console.log(`[BatchValidation] Processing resume ${index + 1}/${file.originalname} for batch ${batchId}`);

    // Update resume status to processing
    const batchValidation = await BatchResumeValidation.findById(batchId);
    if (!batchValidation) {
      console.error(`[BatchValidation] Batch ${batchId} not found`);
      return;
    }

    const result = batchValidation.results[index];
    if (result) {
      result.status = 'processing';
      await batchValidation.save();
    }

    // Save resume file to S3 (or local storage)
    const resumePathOrUrl = await saveUploadedFile(file);
    const resumeText = await readFileAsText(resumePathOrUrl);
    
    // Determine if it's an S3 URL or local path
    const isS3Url = resumePathOrUrl && resumePathOrUrl.startsWith('https://') && resumePathOrUrl.includes('.s3.');

    if (!resumeText || resumeText.trim().length === 0) {
      throw new Error('No text extracted from resume file');
    }

    // Score resume against job using LLM
    const resumeLLMResponse = await callLLM('RESUME_SCORING', {
      resumeText,
      job,
    });

    const resumeParsed = parseJsonSafely(resumeLLMResponse);
    
    if (!resumeParsed.ok) {
      throw new Error(`Failed to parse LLM response: ${resumeParsed.error}`);
    }

    const matchScore = resumeParsed.json.match_score || 0;
    const skillsMatched = resumeParsed.json.skills_matched || [];
    const skillsMissing = resumeParsed.json.skills_missing || [];
    const topReasons = resumeParsed.json.top_reasons || [];
    const recommendedAction = resumeParsed.json.recommended_action || null;

    // Extract tags and parse resume for user creation
    let resumeTags = [];
    let parsedResumeData = null;
    
    try {
      resumeTags = await extractTagsFromResume(resumeText);
    } catch (error) {
      console.error('[BatchValidation] Error extracting tags:', error);
    }

    // Parse resume to extract structured data including experience fields
    try {
      const parseResponse = await callLLM('RESUME_PARSER', { resumeText });
      const parsed = parseJsonSafely(parseResponse);
      if (parsed.ok) {
        parsedResumeData = parsed.json;
        console.log('[BatchValidation] Resume parsed successfully');
      }
    } catch (error) {
      console.error('[BatchValidation] Error parsing resume:', error);
    }

    // Create or find user (use filename as placeholder email if no email can be extracted)
    // For batch uploads, we'll create users with placeholder emails
    // Extract contact information from parsed resume
    const extractedEmail = parsedResumeData?.contact?.email?.trim().toLowerCase() || `batch-${batchId}-${index}@hirewise.app`;
    const extractedName = parsedResumeData?.name?.trim() || file.originalname.replace(/\.[^/.]+$/, '');
    const extractedPhone = parsedResumeData?.contact?.phone?.trim() || null;
    const extractedLinkedIn = parsedResumeData?.contact?.linkedin?.trim() || null;
    const extractedGithub = parsedResumeData?.contact?.github?.trim() || null;
    const extractedPortfolio = parsedResumeData?.contact?.portfolio?.trim() || null;

    let user = await User.findOne({ email: extractedEmail.toLowerCase() });
    
    if (!user) {
      user = new User({
        email: extractedEmail.toLowerCase(),
        name: extractedName,
        phone: extractedPhone,
        resumePath: resumePathOrUrl, // Keep for backward compatibility
        resumeS3Url: isS3Url ? resumePathOrUrl : null, // Store S3 URL if it's from S3
        resumeText,
        tags: resumeTags,
        parsedResume: parsedResumeData,
        linkedinUrl: extractedLinkedIn,
        githubUrl: extractedGithub,
        portfolioUrl: extractedPortfolio,
        // Extract experience-related fields
        currentTenure: parsedResumeData?.currentTenure || null,
        totalExperience: parsedResumeData?.totalExperience || null,
        isRecentSwitcher: parsedResumeData?.isRecentSwitcher || false,
        currentCompany: parsedResumeData?.currentCompany || null,
        lastJobSwitchDate: parsedResumeData?.lastJobSwitchDate || null,
      });
    } else {
      user.resumePath = resumePathOrUrl; // Keep for backward compatibility
      user.resumeS3Url = isS3Url ? resumePathOrUrl : null; // Store S3 URL if it's from S3
      user.resumeText = resumeText;
      if (resumeTags.length > 0) user.tags = resumeTags;
      
      // Update name if extracted and current is generic/missing
      if (extractedName && (!user.name || user.name === 'Unknown' || user.name.trim() === '')) {
        user.name = extractedName;
      }
      
      // Update phone if extracted and current is missing
      if (extractedPhone && (!user.phone || user.phone.trim() === '')) {
        user.phone = extractedPhone;
      }
      
      // Update LinkedIn if extracted and current is missing
      if (extractedLinkedIn && (!user.linkedinUrl || user.linkedinUrl.trim() === '')) {
        user.linkedinUrl = extractedLinkedIn;
      }
      
      // Update GitHub if extracted and current is missing
      if (extractedGithub && (!user.githubUrl || user.githubUrl.trim() === '')) {
        user.githubUrl = extractedGithub;
      }
      
      // Update portfolio if extracted and current is missing
      if (extractedPortfolio && (!user.portfolioUrl || user.portfolioUrl.trim() === '')) {
        user.portfolioUrl = extractedPortfolio;
      }
      
      if (parsedResumeData) {
        user.parsedResume = parsedResumeData;
        // Update experience-related fields
        if (parsedResumeData.currentTenure) user.currentTenure = parsedResumeData.currentTenure;
        if (parsedResumeData.totalExperience) user.totalExperience = parsedResumeData.totalExperience;
        if (parsedResumeData.isRecentSwitcher !== undefined) user.isRecentSwitcher = parsedResumeData.isRecentSwitcher;
        if (parsedResumeData.currentCompany) user.currentCompany = parsedResumeData.currentCompany;
        if (parsedResumeData.lastJobSwitchDate) user.lastJobSwitchDate = parsedResumeData.lastJobSwitchDate;
      }
    }
    await user.save();

    // Calculate unified score (only resume score for batch validation)
    const scores = {
      resumeScore: matchScore,
      githubPortfolioScore: 0,
      compensationScore: 0,
    };
    const unifiedScore = calculateUnifiedScore(scores);

    // Create Application record with all scoring data
    const application = new Application({
      jobId: job._id,
      userId: user._id,
      resumePath: resumePathOrUrl, // Can be S3 URL or local path
      resumeText,
      scores,
      unifiedScore,
      rawResumeLLM: resumeLLMResponse,
      skillsMatched,
      skillsMissing,
      topReasons,
      recommendedAction,
      consent_given: false,
      level1_approved: false,
    });
    await application.save();

    // Update batch validation with application ID
    const updatedBatch = await BatchResumeValidation.findById(batchId);
    if (updatedBatch) {
      const result = updatedBatch.results[index];
      if (result) {
        result.status = 'completed';
        result.applicationId = application._id;
        result.processedAt = new Date();
      }
      updatedBatch.processedResumes += 1;
      await updatedBatch.save();

      console.log(`[BatchValidation] Completed resume ${index + 1} (${file.originalname}) - Application ID: ${application._id}, Score: ${matchScore}`);
    }
  } catch (error) {
    console.error(`[BatchValidation] Error processing resume ${index + 1} (${file.originalname}):`, error);
    
    // Update batch validation with error
    const batchValidation = await BatchResumeValidation.findById(batchId);
    if (batchValidation) {
      const result = batchValidation.results[index];
      if (result) {
        result.status = 'failed';
        result.error = error.message;
        result.processedAt = new Date();
      }
      batchValidation.processedResumes += 1;
      await batchValidation.save();
    }
  }
}

export default router;

