import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import User from '../models/User.js';
import CandidateSearch from '../models/CandidateSearch.js';
import { callLLM } from '../lib/llm.js';
import { parseJsonSafely } from '../lib/parseJsonSafely.js';
import { fetchGitHubData, formatGitHubDataForLLM } from '../lib/github.js';
import { makeBlandAICall, getCallStatus } from '../lib/blandAi.js';
import { formatPhoneNumber } from '../lib/phoneFormatter.js';
import { sendEmail } from '../lib/email.js';
import { readFileAsText } from '../lib/storage.js';

const router = express.Router();

/**
 * Calculate unified score from individual scores (same as in applications)
 * @param {Object} scores - Object containing individual scores
 * @returns {Number} Unified score (0-100)
 */
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

  return Math.round(unified * 100) / 100; // Round to 2 decimal places
}

// GET /api/users/:id/resume - Download user's resume (must come before /:id route)
router.get('/:id/resume', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prefer S3 URL if available, otherwise use resumePath
    const resumeLocation = user.resumeS3Url || user.resumePath;
    
    if (!resumeLocation) {
      return res.status(404).json({ error: 'Resume not found for this user' });
    }

    // Check if it's an S3 URL
    const isS3Url = resumeLocation && resumeLocation.startsWith('https://') && resumeLocation.includes('.s3.');
    
    if (isS3Url) {
      // Generate presigned URL for S3 file
      try {
        const { getPresignedUrl } = await import('../lib/storage.js');
        const expiresIn = parseInt(req.query.expiresIn) || 3600; // Default 1 hour, can be overridden via query param
        const presignedUrl = await getPresignedUrl(resumeLocation, expiresIn);
        
        // Return presigned URL in response
        return res.json({
          downloadUrl: presignedUrl,
          expiresIn: expiresIn,
          message: 'Use the downloadUrl to download the resume. URL expires in ' + expiresIn + ' seconds.',
        });
      } catch (error) {
        console.error('[User] Error generating presigned URL:', error);
        return res.status(500).json({ 
          error: 'Failed to generate download URL', 
          details: error.message 
        });
      }
    } else {
      // Local file path
      // Check if file exists
      try {
        await fs.access(resumeLocation);
      } catch (error) {
        console.error(`[User] Resume file not found at path: ${resumeLocation}`, error);
        return res.status(404).json({ error: 'Resume file not found on server' });
      }

      // Get file extension to determine content type
      const ext = path.extname(resumeLocation).toLowerCase();
      const contentTypes = {
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.txt': 'text/plain',
      };
      const contentType = contentTypes[ext] || 'application/octet-stream';

      // Get original filename from resumePath (format: timestamp-originalname)
      const filename = path.basename(resumeLocation);
      // Extract original filename (remove timestamp prefix)
      const originalFilename = filename.includes('-') 
        ? filename.substring(filename.indexOf('-') + 1)
        : filename;

      // Set headers for file download
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${originalFilename}"`);
      res.setHeader('Cache-Control', 'no-cache');

      // Read and send file
      const fileBuffer = await fs.readFile(resumeLocation);
      res.send(fileBuffer);

      console.log(`[User] Resume downloaded for user ${user._id}: ${originalFilename}`);
    }
  } catch (error) {
    console.error('Error downloading resume:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/users/:userId/schedule-call - Schedule phone interview for a user (without application)
// This is for users found through AI search who don't have an application yet
router.post('/:userId/schedule-call', async (req, res) => {
  try {
    const { userId } = req.params;
    const { start_time } = req.body; // Optional: "YYYY-MM-DD HH:MM:SS -HH:MM" format

    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.phone) {
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

    // Generate questions based on resume only (no job context)
    let questions = [];
    
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

    // Create new phone interview summary entry
    const phoneInterviewSummary = {
      status: start_time ? 'scheduled' : 'initiated',
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

    // Make Bland AI call (with optional start_time for scheduling)
    const callResult = await makeBlandAICall({
      phoneNumber,
      candidateName: user.name,
      user: user, // Pass user instead of application
      questions,
      userId: user._id.toString(),
      startTime: start_time || null,
    });

    // Update the last phone interview summary with call ID
    const lastSummary = user.phoneInterviewSummaries[user.phoneInterviewSummaries.length - 1];
    lastSummary.callId = callResult.callId;
    lastSummary.status = start_time ? 'scheduled' : 'ringing';
    if (start_time) {
      lastSummary.scheduledStartTime = start_time;
    }
    await user.save();

    // Send email notification about the phone interview (async - don't wait)
    if (user.email) {
      (async () => {
        try {
          // Generate email content using LLM (generic, no job context)
          const emailLLMResponse = await callLLM('PHONE_INTERVIEW_EMAIL', {
            candidateName: user.name,
            role: 'Potential Role', // Generic since no specific job
            company: 'Paytm',
            phoneNumber: phoneNumber,
            scheduledStartTime: start_time,
            questions: questions,
          });

          const emailParsed = parseJsonSafely(emailLLMResponse);
          
          if (emailParsed.ok) {
            const emailData = emailParsed.json;
            
            // Send email
            const emailResult = await sendEmail({
              to: user.email,
              subject: emailData.subject || `Phone Interview Invitation - Paytm`,
              html: emailData.html_snippet || emailData.plain_text,
              text: emailData.plain_text || emailData.html_snippet?.replace(/<[^>]*>/g, ''),
            });

            if (emailResult.ok) {
              console.log(`[User] Phone interview email sent to ${user.email} for user ${user._id}`);
            } else {
              console.error(`[User] Failed to send phone interview email:`, emailResult.error);
            }
          } else {
            console.error('[User] Failed to parse phone interview email response:', emailParsed.error);
            // Fallback email
            const fallbackSubject = start_time 
              ? `Phone Interview Scheduled - Paytm`
              : `Phone Interview Invitation - Paytm`;
            
            const fallbackHtml = `
              <h2>Hello ${user.name},</h2>
              <p>Congratulations! We came across your profile and would like to have a conversation with you.</p>
              <p>We would like to invite you for an AI-based phone interview.</p>
              ${start_time ? `<p><strong>Scheduled Time:</strong> ${start_time}</p>` : '<p>You will receive a call shortly at: <strong>' + phoneNumber + '</strong></p>'}
              <p><strong>What to expect:</strong></p>
              <ul>
                <li>An AI interviewer named "Neo" will call you</li>
                <li>The interview will take approximately 5-10 minutes</li>
                <li>You'll be asked technical and behavioral questions based on your resume</li>
                <li>Please answer naturally and be patient if there are brief pauses</li>
              </ul>
              <p>We look forward to speaking with you!</p>
              <p>Best regards,<br>Paytm HR Team</p>
            `;
            
            await sendEmail({
              to: user.email,
              subject: fallbackSubject,
              html: fallbackHtml,
              text: fallbackHtml.replace(/<[^>]*>/g, ''),
            });
          }
        } catch (error) {
          console.error(`[User] Error sending phone interview email:`, error);
        }
      })();
    }

    res.json({
      message: start_time ? 'Phone interview call scheduled' : 'Phone interview call initiated',
      callId: callResult.callId,
      status: callResult.status,
      phoneNumber: phoneNumber,
      userId: user._id,
      startTime: start_time || null,
      emailSent: user.email ? true : false,
      checkStatusUrl: `/api/users/${user._id}/phone-call-status`,
    });
  } catch (error) {
    console.error('Error scheduling/initiating phone call:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /api/users/:userId/phone-call-status - Get phone call status for a user
router.get('/:userId/phone-call-status', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.phoneInterviewSummaries || user.phoneInterviewSummaries.length === 0) {
      return res.status(404).json({ error: 'No phone interviews found for this user' });
    }

    // Get the most recent phone interview
    const lastInterview = user.phoneInterviewSummaries[user.phoneInterviewSummaries.length - 1];

    if (!lastInterview.callId) {
      return res.status(400).json({ error: 'No phone call initiated for this user' });
    }

    // Helper function to map Bland AI status to internal status
    function mapBlandStatusToInternal(blandStatus) {
      const statusMap = {
        'initiated': 'initiated',
        'ringing': 'ringing',
        'answered': 'in_progress',
        'in-progress': 'in_progress',
        'completed': 'completed',
        'ended': 'completed',
        'failed': 'failed',
        'no-answer': 'no_answer',
        'busy': 'failed',
        'voicemail': 'failed',
      };
      return statusMap[blandStatus] || 'in_progress';
    }

    // Get latest status from Bland AI (including recording URL if available)
    try {
      const callStatus = await getCallStatus(lastInterview.callId);
      
      // Update user's phone interview summary with latest status
      if (callStatus.status) {
        lastInterview.status = mapBlandStatusToInternal(callStatus.status);
      }
      
      if (callStatus.recording_url) {
        lastInterview.recordingUrl = callStatus.recording_url;
        console.log(`[User] Recording URL retrieved: ${callStatus.recording_url}`);
      }
      
      if (callStatus.transcript) {
        lastInterview.transcript = callStatus.transcript;
      }
      
      if (callStatus.summary) {
        lastInterview.summary = callStatus.summary;
      }
      
      if (callStatus.analysis) {
        lastInterview.analysis = callStatus.analysis;
      }
      
      if (callStatus.duration) {
        lastInterview.duration = callStatus.duration;
      }
      
      if (callStatus.status === 'completed' || callStatus.status === 'ended') {
        lastInterview.status = 'completed';
        lastInterview.completedAt = new Date();
        
        // If recording URL not in status, try to fetch it explicitly
        if (!lastInterview.recordingUrl) {
          try {
            const { getCallRecording } = await import('../lib/blandAi.js');
            const recordingData = await getCallRecording(lastInterview.callId);
            if (recordingData.recordingUrl) {
              lastInterview.recordingUrl = recordingData.recordingUrl;
              console.log(`[User] Recording URL fetched explicitly: ${recordingData.recordingUrl}`);
            }
          } catch (recordingError) {
            console.warn(`[User] Could not fetch recording URL:`, recordingError.message);
          }
        }
      }
      
      await user.save();
    } catch (error) {
      console.error('[User] Error fetching call status from Bland AI:', error);
      // Return stored status even if fetch fails
    }

    res.json({
      userId: user._id,
      phoneInterview: lastInterview,
      totalInterviews: user.phoneInterviewSummaries.length,
    });
  } catch (error) {
    console.error('Error getting phone call status:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/users/:userId/phone-call-webhook - Webhook handler for user-based phone calls (from Bland AI)
router.post('/:userId/phone-call-webhook', async (req, res) => {
  try {
    const { userId } = req.params;
    const webhookData = req.body;

    console.log(`[User] Webhook received for user ${userId}:`, JSON.stringify(webhookData, null, 2));

    const user = await User.findById(userId);
    if (!user) {
      console.error(`[User] User ${userId} not found for webhook`);
      return res.status(404).send('User not found');
    }

    // Get the phone interview summary - match by call_id if provided, otherwise use most recent
    if (!user.phoneInterviewSummaries || user.phoneInterviewSummaries.length === 0) {
      console.error(`[User] No phone interview summaries found for user ${userId}`);
      return res.status(400).send('No phone interview found');
    }

    // Try to find interview by call_id if provided
    let lastInterview = null;
    if (webhookData.call_id) {
      lastInterview = user.phoneInterviewSummaries.find(
        summary => summary.callId === webhookData.call_id || summary.callId === webhookData.call_id?.toString()
      );
    }
    
    // Fallback to most recent if no match found
    if (!lastInterview) {
      lastInterview = user.phoneInterviewSummaries[user.phoneInterviewSummaries.length - 1];
      console.log(`[User] No matching call_id found, using most recent interview`);
    }

    // Helper function to map Bland AI status to internal status
    function mapBlandStatusToInternal(blandStatus) {
      const statusMap = {
        'initiated': 'initiated',
        'ringing': 'ringing',
        'answered': 'in_progress',
        'in-progress': 'in_progress',
        'completed': 'completed',
        'ended': 'completed',
        'failed': 'failed',
        'no-answer': 'no_answer',
        'busy': 'failed',
        'voicemail': 'failed',
      };
      return statusMap[blandStatus] || 'in_progress';
    }

    // Map Bland AI status to internal status
    if (webhookData.status) {
      lastInterview.status = mapBlandStatusToInternal(webhookData.status);
    }
    
    // Update call ID if provided
    if (webhookData.call_id) {
      lastInterview.callId = webhookData.call_id;
    }
    
    // Get recording URL when call completes
    if (webhookData.recording_url) {
      lastInterview.recordingUrl = webhookData.recording_url;
      console.log(`[User] Recording URL received: ${webhookData.recording_url}`);
    }
    
    // Update transcript if available (handle both string and array formats)
    if (webhookData.transcript) {
      if (Array.isArray(webhookData.transcript)) {
        // Convert transcript array to formatted string
        const transcriptText = webhookData.transcript
          .map(msg => {
            const speaker = msg.user === 'assistant' ? 'Interviewer' : 'Candidate';
            const timestamp = msg.created_at ? new Date(msg.created_at).toISOString() : '';
            return `[${timestamp}] ${speaker}: ${msg.text || ''}`;
          })
          .join('\n\n');
        lastInterview.transcript = transcriptText;
      } else {
        lastInterview.transcript = webhookData.transcript;
      }
    }
    
    // Update summary if available
    if (webhookData.summary) {
      lastInterview.summary = webhookData.summary;
    }
    
    // Update analysis if available (handle both object and string formats)
    if (webhookData.analysis) {
      if (typeof webhookData.analysis === 'object') {
        lastInterview.analysis = {
          technical_skills: webhookData.analysis.technical_skills || [],
          behavioral_traits: webhookData.analysis.behavioral_traits || [],
          communication_quality: webhookData.analysis.communication_quality || null,
          overall_fit: webhookData.analysis.overall_fit || null,
          strengths: webhookData.analysis.strengths || [],
          concerns: webhookData.analysis.concerns || [],
        };
      } else {
        // If analysis is a string, try to parse it or store as summary
        lastInterview.summary = webhookData.analysis;
      }
    }
    
    // Update duration if available (handle corrected_duration as well)
    if (webhookData.duration) {
      lastInterview.duration = parseInt(webhookData.duration, 10);
    } else if (webhookData.corrected_duration) {
      lastInterview.duration = parseInt(webhookData.corrected_duration, 10);
    }
    
    // Update completedAt if end_at is provided
    if (webhookData.end_at) {
      lastInterview.completedAt = new Date(webhookData.end_at);
    }
    
    // When call is completed, fetch full details including recording
    if (webhookData.status === 'completed' || webhookData.status === 'ended') {
      lastInterview.status = 'completed';
      lastInterview.completedAt = new Date();
      
      // Fetch full call details to ensure we have recording URL
      if (webhookData.call_id) {
        try {
          const { getCallStatus } = await import('../lib/blandAi.js');
          const fullCallData = await getCallStatus(webhookData.call_id);
          
          // Update with complete data
          if (fullCallData.recording_url) {
            lastInterview.recordingUrl = fullCallData.recording_url;
          }
          if (fullCallData.transcript) {
            lastInterview.transcript = fullCallData.transcript;
          }
          if (fullCallData.summary) {
            lastInterview.summary = fullCallData.summary;
          }
          if (fullCallData.analysis) {
            lastInterview.analysis = fullCallData.analysis;
          }
          
          console.log(`[User] Full call data fetched for user ${userId}, recording: ${fullCallData.recording_url ? 'available' : 'not available'}`);
        } catch (fetchError) {
          console.error(`[User] Error fetching full call data:`, fetchError);
        }
      }
    }

    await user.save();
    console.log(`[User] Webhook processed successfully for user ${userId}`);

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error');
  }
});

// GET /api/users/searches - Get all searches (with pagination) - MUST come before /:id route
router.get('/searches', async (req, res) => {
  try {
    const { limit = 50, page = 1, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const searches = await CandidateSearch.find()
      .populate('shortlistedUsers', 'name email')
      .populate('rejectedUsers', 'name email')
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    const total = await CandidateSearch.countDocuments();

    res.json({
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      searches: searches.map(search => ({
        searchId: search._id,
        searchText: search.searchText,
        totalResults: search.totalResults,
        shortlistedCount: search.shortlistedUsers?.length || 0,
        rejectedCount: search.rejectedUsers?.length || 0,
        createdAt: search.createdAt,
        updatedAt: search.updatedAt,
      })),
    });
  } catch (error) {
    console.error('Error fetching searches:', error);
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

    // Build MongoDB query based on extracted criteria using hybrid AND/OR logic
    // Structure: Different criteria types are ANDed together
    // Within each type, conditions are ORed (e.g., match ANY skill)
    
    const andConditions = [];
    
    // 1. Skills/Role Criteria (OR within this group - must match at least ONE skill/role)
    const skillOrConditions = [];
    
    // Tags search (skills/technologies/roles) - using exact case-insensitive matching
    if (searchCriteria.tags && Array.isArray(searchCriteria.tags) && searchCriteria.tags.length > 0) {
      searchCriteria.tags.forEach(tag => {
        // Escape special regex characters
        const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // Add exact tag match OR resume text match for this skill/role
        // This allows finding candidates who have the skill in tags OR mentioned in resume
        skillOrConditions.push({
          $or: [
            // Exact match in tags array - use string pattern, not RegExp object
            {
              $expr: {
                $anyElementTrue: {
                  $map: {
                    input: '$tags',
                    as: 'tag',
                    in: {
                      $regexMatch: {
                        input: '$$tag',
                        regex: `^${escapedTag}$`,  // Use string pattern
                        options: 'i',
                      },
                    },
                  },
                },
              },
            },
            // Word boundary match in resume text
            { resumeText: { $regex: `\\b${escapedTag}\\b`, $options: 'i' } }
          ]
        });
      });
      console.log('[CandidateSearch] Adding tags filter (exact match in tags OR resume):', searchCriteria.tags);
    }
    
    // If we have skill/role requirements, at least ONE must match
    if (skillOrConditions.length > 0) {
      andConditions.push({ $or: skillOrConditions });
    }
    
    // 2. Resume Keywords (location, experience, etc.)
    // Strategy: Separate locations from experience/other keywords
    const locationKeywords = [];
    const experienceKeywords = [];
    
    if (searchCriteria.resumeKeywords && Array.isArray(searchCriteria.resumeKeywords) && searchCriteria.resumeKeywords.length > 0) {
      // Common location patterns
      const locationPatterns = /bangalore|mumbai|delhi|hyderabad|pune|chennai|kolkata|ncr|gurugram|gurgaon|noida|remote/i;
      // Experience patterns (numbers followed by years, or seniority levels)
      const experiencePatterns = /\d+\s*(years?|yrs?)|senior|junior|mid-level|lead/i;
      
      searchCriteria.resumeKeywords.forEach(keyword => {
        if (locationPatterns.test(keyword)) {
          locationKeywords.push(keyword);
        } else if (experiencePatterns.test(keyword)) {
          experienceKeywords.push(keyword);
        }
      });
      
      // Location: OR logic (match any location mentioned)
      if (locationKeywords.length > 0) {
        const locationConditions = locationKeywords.map(keyword => {
          const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return { resumeText: { $regex: `\\b${escapedKeyword}\\b`, $options: 'i' } };
        });
        
        if (locationConditions.length === 1) {
          andConditions.push(locationConditions[0]);
        } else {
          andConditions.push({ $or: locationConditions });
        }
        console.log('[CandidateSearch] Adding location filter (OR):', locationKeywords);
      }
      
      // Experience: AND logic (all must match if specified)
      if (experienceKeywords.length > 0) {
        experienceKeywords.forEach(keyword => {
          const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          andConditions.push({ resumeText: { $regex: `\\b${escapedKeyword}\\b`, $options: 'i' } });
        });
        console.log('[CandidateSearch] Adding experience filter (AND):', experienceKeywords);
      }
    }
    
    // Build final query
    const finalQuery = {};
    if (andConditions.length === 1) {
      // Only one condition, no need for $and wrapper
      Object.assign(finalQuery, andConditions[0]);
    } else if (andConditions.length > 1) {
      // Multiple conditions, use $and
      finalQuery.$and = andConditions;
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
        let resumeScore = 0;
        let skillsMatched = [];
        let skillsMissing = [];
        let topReasons = [];
        let recommendedAction = null;
        let githubPortfolioScore = 0;
        let githubPortfolioSummary = '';
        let compensationScore = 0;
        let compensationAnalysis = '';
        let aiToolsCompatibilityScore = 0;
        let aiToolsCompatibilityAnalysis = '';

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

        // Parallel scoring: Resume scoring, GitHub/Portfolio scoring, Compensation analysis, AI Tools Compatibility
        const scoringPromises = [];

        // Create a mock job object for scoring (using search criteria)
        const mockJob = {
          role: searchCriteria.role || 'Position',
          company_name: 'Paytm',
          must_have_skills: searchCriteria.tags || [],
          nice_to_have: [],
          enhanced_jd: query,
        };

        // Resume scoring (for match score and skills analysis)
        if (user.resumeText && user.resumeText.trim().length > 0) {
          // Candidate search scoring (for match score and skills)
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
                  console.log(`[CandidateSearch] Match score for ${user.name}: ${matchScore}`);
                } else {
                  console.error(`[CandidateSearch] Failed to parse match scoring for ${user.name}:`, scoringParsed.error);
                }
              })
              .catch(error => {
                console.error(`[CandidateSearch] Error in match scoring for ${user.name}:`, error);
              })
          );

          // Resume scoring (for resume score - same as in applications)
          scoringPromises.push(
            callLLM('RESUME_SCORING', {
              resumeText: user.resumeText,
              job: mockJob,
            })
              .then(resumeScoringResponse => {
                const resumeParsed = parseJsonSafely(resumeScoringResponse);
                if (resumeParsed.ok) {
                  resumeScore = resumeParsed.json.match_score || 0;
                  console.log(`[CandidateSearch] Resume score for ${user.name}: ${resumeScore}`);
                } else {
                  console.error(`[CandidateSearch] Failed to parse resume scoring for ${user.name}:`, resumeParsed.error);
                }
              })
              .catch(error => {
                console.error(`[CandidateSearch] Error in resume scoring for ${user.name}:`, error);
              })
          );
        } else {
          console.log(`[CandidateSearch] Skipping resume scoring for ${user.name}: no resume text`);
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

        // AI Tools Compatibility scoring (analyze resume, GitHub, and portfolio for AI/ML tools usage)
        if (user.resumeText || githubDataFormatted || finalPortfolioUrl) {
          scoringPromises.push(
            callLLM('AI_TOOLS_COMPATIBILITY', {
              resumeText: user.resumeText || '',
              githubData: githubDataFormatted || '',
              portfolioUrl: finalPortfolioUrl || '',
              parsedResume: user.parsedResume || null,
            })
              .then(aiLLMResponse => {
                const aiParsed = parseJsonSafely(aiLLMResponse);
                if (aiParsed.ok) {
                  aiToolsCompatibilityScore = aiParsed.json.score || 0;
                  aiToolsCompatibilityAnalysis = aiParsed.json.analysis || '';
                  console.log(`[CandidateSearch] AI Tools Compatibility Score for ${user.name}: ${aiToolsCompatibilityScore}`);
                } else {
                  console.error(`[CandidateSearch] Failed to parse AI Tools Compatibility response for ${user.name}:`, aiParsed.error);
                }
              })
              .catch(error => {
                console.error(`[CandidateSearch] Error analyzing AI tools compatibility for ${user.name}:`, error);
              })
          );
        }

        // Wait for all scoring operations to complete
        await Promise.all(scoringPromises);

        // Calculate unified score
        const scores = {
          resumeScore,
          githubPortfolioScore,
          compensationScore,
          aiToolsCompatibilityScore,
        };
        const unifiedScore = calculateUnifiedScore(scores);

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
          matchScore, // Legacy match score from CANDIDATE_SEARCH_SCORING
          resumeScore, // Resume score from RESUME_SCORING (0-100)
          skillsMatched,
          skillsMissing,
          topReasons,
          recommendedAction,
          githubPortfolioScore,
          githubPortfolioSummary,
          compensationScore,
          compensationAnalysis,
          aiToolsCompatibilityScore,
          aiToolsCompatibilityAnalysis,
          unifiedScore, // Overall unified score (weighted average)
        };
      })
    );

     // Filter out very low unified scores (below threshold)
    // Use unifiedScore for filtering and sorting (more accurate than matchScore alone)
    const MINIMUM_UNIFIED_SCORE = 40; // Only return candidates with 40+ unified score
    const filteredResults = scoredResults.filter(result => {
      // If unifiedScore is 0 (not scored), include it
      // Otherwise, only include if unified score is above threshold
      return result.unifiedScore === 0 || result.unifiedScore >= MINIMUM_UNIFIED_SCORE;
    });

    // Sort by unified score (highest first) if scores are available
    filteredResults.sort((a, b) => {
      if (a.unifiedScore > 0 || b.unifiedScore > 0) {
        return b.unifiedScore - a.unifiedScore;
      }
      // If no unified scores, fall back to matchScore
      if (a.matchScore > 0 || b.matchScore > 0) {
        return b.matchScore - a.matchScore;
      }
      // If no scores, maintain original order (most recent first)
      return 0;
    });

    console.log(`[CandidateSearch] Filtered ${scoredResults.length - filteredResults.length} candidates below score threshold`);

    // Create CandidateSearch record
    const candidateSearch = new CandidateSearch({
      searchText: query,
      searchCriteria,
      explanation,
      totalResults,
      resultsSnapshot: scoredResults.slice(0, 20).map(result => ({
        userId: result.id,
        matchScore: result.matchScore,
        resumeScore: result.resumeScore,
        githubPortfolioScore: result.githubPortfolioScore,
        compensationScore: result.compensationScore,
        aiToolsCompatibilityScore: result.aiToolsCompatibilityScore,
        unifiedScore: result.unifiedScore,
        skillsMatched: result.skillsMatched,
        recommendedAction: result.recommendedAction,
      })),
      shortlistedUsers: [],
      rejectedUsers: [],
    });
    await candidateSearch.save();

    res.json({
      query,
      explanation,
      totalResults: filteredResults.length,
      totalBeforeFiltering: totalResults,
      limit: parseInt(limit),
      skip: parseInt(skip),
      minimumUnifiedScore: MINIMUM_UNIFIED_SCORE,
      results: filteredResults,
      searchId: candidateSearch._id, // Return search ID for future updates
    });
  } catch (error) {
    console.error('[CandidateSearch] Error searching candidates:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
});

// POST /api/users/search/:searchId/shortlist - Add user to shortlist for a search
router.post('/search/:searchId/shortlist', async (req, res) => {
  try {
    const { searchId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const candidateSearch = await CandidateSearch.findById(searchId);
    if (!candidateSearch) {
      return res.status(404).json({ error: 'Search not found' });
    }

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Add to shortlist if not already there
    if (!candidateSearch.shortlistedUsers.includes(userId)) {
      candidateSearch.shortlistedUsers.push(userId);
      
      // Remove from rejected if present
      candidateSearch.rejectedUsers = candidateSearch.rejectedUsers.filter(
        id => id.toString() !== userId.toString()
      );
      
      await candidateSearch.save();
    }

    res.json({
      message: 'User added to shortlist',
      searchId: candidateSearch._id,
      shortlistedUsers: candidateSearch.shortlistedUsers,
      rejectedUsers: candidateSearch.rejectedUsers,
    });
  } catch (error) {
    console.error('Error adding user to shortlist:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/users/search/:searchId/reject - Add user to rejected list for a search
router.post('/search/:searchId/reject', async (req, res) => {
  try {
    const { searchId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const candidateSearch = await CandidateSearch.findById(searchId);
    if (!candidateSearch) {
      return res.status(404).json({ error: 'Search not found' });
    }

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Add to rejected if not already there
    if (!candidateSearch.rejectedUsers.includes(userId)) {
      candidateSearch.rejectedUsers.push(userId);
      
      // Remove from shortlisted if present
      candidateSearch.shortlistedUsers = candidateSearch.shortlistedUsers.filter(
        id => id.toString() !== userId.toString()
      );
      
      await candidateSearch.save();
    }

    res.json({
      message: 'User added to rejected list',
      searchId: candidateSearch._id,
      shortlistedUsers: candidateSearch.shortlistedUsers,
      rejectedUsers: candidateSearch.rejectedUsers,
    });
  } catch (error) {
    console.error('Error adding user to rejected list:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /api/users/search/:searchId - Get search details with shortlisted and rejected users
router.get('/search/:searchId', async (req, res) => {
  try {
    const { searchId } = req.params;
    const { status } = req.query; // Query param: 'shortlisted' or 'rejected'

    const candidateSearch = await CandidateSearch.findById(searchId)
      .populate('shortlistedUsers', 'name email phone tags')
      .populate('rejectedUsers', 'name email phone tags');

    if (!candidateSearch) {
      return res.status(404).json({ error: 'Search not found' });
    }

    // Build response object
    const response = {
      searchId: candidateSearch._id,
      searchText: candidateSearch.searchText,
      searchCriteria: candidateSearch.searchCriteria,
      explanation: candidateSearch.explanation,
      totalResults: candidateSearch.totalResults,
      resultsSnapshot: candidateSearch.resultsSnapshot,
      createdAt: candidateSearch.createdAt,
      updatedAt: candidateSearch.updatedAt,
    };

    // Filter response based on status query param
    if (status === 'shortlisted') {
      response.shortlistedUsers = candidateSearch.shortlistedUsers;
      response.shortlistedCount = candidateSearch.shortlistedUsers?.length || 0;
    } else if (status === 'rejected') {
      response.rejectedUsers = candidateSearch.rejectedUsers;
      response.rejectedCount = candidateSearch.rejectedUsers?.length || 0;
    } else {
      // Default: return both if no filter or invalid status
      response.shortlistedUsers = candidateSearch.shortlistedUsers;
      response.rejectedUsers = candidateSearch.rejectedUsers;
      response.shortlistedCount = candidateSearch.shortlistedUsers?.length || 0;
      response.rejectedCount = candidateSearch.rejectedUsers?.length || 0;
    }

    res.json(response);
  } catch (error) {
    console.error('Error fetching search:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /api/users/:id - Get user profile (MUST come after all /search* routes)
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

// PATCH /api/users/:id - Update user info (MUST come after all /search* routes)
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

export default router;

