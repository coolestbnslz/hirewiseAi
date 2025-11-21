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
import { upload, uploadMultiple } from '../middleware/upload.js';
import { v4 as uuidv4 } from 'uuid';
import { fetchGitHubData, formatGitHubDataForLLM } from '../lib/github.js';
import BatchResumeValidation from '../models/BatchResumeValidation.js';

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
      .populate('userId', 'name email phone githubUrl portfolioUrl linkedinUrl compensationExpectation tags resumeSummary parsedResume currentTenure totalExperience isRecentSwitcher currentCompany lastJobSwitchDate')
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
        parsedResume: app.userId.parsedResume || null,
        resumeSummary: app.userId.resumeSummary || null,
        currentTenure: app.userId.currentTenure || null,
        totalExperience: app.userId.totalExperience || null,
        isRecentSwitcher: app.userId.isRecentSwitcher || false,
        currentCompany: app.userId.currentCompany || null,
        lastJobSwitchDate: app.userId.lastJobSwitchDate || null,
      },
      skillsMatched: app.skillsMatched || [],
      skillsMissing: app.skillsMissing || [],
      topReasons: app.topReasons || [],
      recommendedAction: app.recommendedAction || null,
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

    // Find or create user (minimal processing for immediate response)
    let user = await User.findOne({ email: applicant_email.toLowerCase() });
    
    // Update user with basic info immediately
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
      });
    } else {
      // Update user info
      if (resumePath) user.resumePath = resumePath;
      if (applicant_name) user.name = applicant_name;
      if (applicant_phone) user.phone = applicant_phone;
      if (applicant_email) user.email = applicant_email.toLowerCase();
      if (resumeText) user.resumeText = resumeText;
      if (githubUrl) user.githubUrl = githubUrl;
      if (portfolioUrl) user.portfolioUrl = portfolioUrl;
      if (linkedinUrl) user.linkedinUrl = linkedinUrl;
      if (compensationExpectation) user.compensationExpectation = compensationExpectation;
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
      resumePath,
      resumeText,
      consent_given: false,
      level1_approved: false,
      matchId: existingMatch?._id || null,
      // Scores will be updated asynchronously
      scores: {
        resumeScore: 0,
        githubPortfolioScore: 0,
        compensationScore: 0,
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

    // Return immediate success response
    res.status(201).json({
      message: 'Application submitted successfully',
      applicationId: application._id,
      job: {
        role: job.role,
        company: job.company_name,
      },
    });

    // Process all scoring asynchronously (don't await - fire and forget)
    processApplicationScoring(application._id, job, user, resumeText, githubUrl, portfolioUrl, linkedinUrl).catch(error => {
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
async function processApplicationScoring(applicationId, job, user, resumeText, githubUrl, portfolioUrl, linkedinUrl) {
  try {
    console.log(`[Application] Starting async scoring for application ${applicationId}`);
    
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
    
    // Extract GitHub and portfolio URLs from parsed resume if not provided
    let finalGithubUrl = githubUrl || user.githubUrl;
    let finalPortfolioUrl = portfolioUrl || user.portfolioUrl;
    let githubDataFormatted = '';
    
    if (parsedResumeData && parsedResumeData.contact) {
      if (!finalGithubUrl && parsedResumeData.contact.github) {
        finalGithubUrl = parsedResumeData.contact.github;
        console.log(`[Application] Extracted GitHub URL from parsed resume: ${finalGithubUrl}`);
      }
      if (!finalPortfolioUrl && parsedResumeData.contact.portfolio) {
        finalPortfolioUrl = parsedResumeData.contact.portfolio;
        console.log(`[Application] Extracted portfolio URL from parsed resume: ${finalPortfolioUrl}`);
      }
    }
    
    // Update user with extracted data
    if (resumeTags.length > 0) user.tags = resumeTags;
    if (parsedResumeData) {
      user.parsedResume = parsedResumeData;
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
    
    // Wait for all scoring operations to complete in parallel
    await Promise.all(scoringPromises);

    // Calculate unified score
    const scores = {
      resumeScore,
      githubPortfolioScore,
      compensationScore,
      compensationAnalysis,
    };
    const unifiedScore = calculateUnifiedScore(scores);

    // Update application with all scoring data
    const application = await Application.findById(applicationId);
    if (application) {
      application.scores = scores;
      application.unifiedScore = unifiedScore;
      application.rawResumeLLM = resumeLLMResponse;
      application.skillsMatched = skillsMatched;
      application.skillsMissing = skillsMissing;
      application.topReasons = topReasons;
      application.recommendedAction = recommendedAction;
      await application.save();

      // Auto-create screening if threshold met
      if (unifiedScore >= job.settings.autoCreateScreeningThreshold) {
        const existingScreening = await Screening.findOne({ applicationId: application._id });
        if (!existingScreening) {
          const screening = new Screening({
            applicationId: application._id,
            jobId: job._id,
            screening_link: `https://hirewise.app/screening/${uuidv4()}`,
          });
          await screening.save();
          console.log(`[Application] Auto-created screening for application ${applicationId}`);
        }
      }

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

    // Save resume file
    const resumePath = await saveUploadedFile(file);
    const resumeText = await readFileAsText(resumePath);

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
    const placeholderEmail = parsedResumeData?.contact?.email || `batch-${batchId}-${index}@hirewise.app`;
    let user = await User.findOne({ email: placeholderEmail.toLowerCase() });
    
    if (!user) {
      user = new User({
        email: placeholderEmail.toLowerCase(),
        name: parsedResumeData?.name || file.originalname.replace(/\.[^/.]+$/, ''), // Use parsed name or filename
        resumePath,
        resumeText,
        tags: resumeTags,
        parsedResume: parsedResumeData,
        // Extract experience-related fields
        currentTenure: parsedResumeData?.currentTenure || null,
        totalExperience: parsedResumeData?.totalExperience || null,
        isRecentSwitcher: parsedResumeData?.isRecentSwitcher || false,
        currentCompany: parsedResumeData?.currentCompany || null,
        lastJobSwitchDate: parsedResumeData?.lastJobSwitchDate || null,
      });
    } else {
      user.resumePath = resumePath;
      user.resumeText = resumeText;
      if (resumeTags.length > 0) user.tags = resumeTags;
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
      resumePath,
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

