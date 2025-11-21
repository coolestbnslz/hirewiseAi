import express from 'express';
import Screening from '../models/Screening.js';
import Job from '../models/Job.js';
import Application from '../models/Application.js';
import User from '../models/User.js';
import { transcribeVideo } from '../lib/stt.js';
import { callLLM } from '../lib/llm.js';
import { parseJsonSafely } from '../lib/parseJsonSafely.js';
import { makeBlandAICall, getCallStatus, getCallRecording } from '../lib/blandAi.js';
import { formatPhoneNumber } from '../lib/phoneFormatter.js';

const router = express.Router();

// GET /api/screenings/:id/questions - Get screening questions (generates on the spot if not set)
router.get('/:id/questions', async (req, res) => {
  try {
    const screening = await Screening.findById(req.params.id).populate('jobId');
    
    if (!screening) {
      return res.status(404).json({ error: 'Screening not found' });
    }

    // If questions already exist, return them
    if (screening.screening_questions && screening.screening_questions.length > 0) {
      return res.json({
        screeningId: screening._id,
        questions: screening.screening_questions,
      });
    }

    // Generate questions on the spot using LLM based on job requirements
    const job = screening.jobId;
    
    // Get candidate info if available (from application)
    const application = await Application.findOne({ 
      _id: screening.applicationId 
    }).populate('userId');
    
    let candidateInfo = null;
    if (application && application.userId) {
      const user = application.userId;
      // Extract skills from resume analysis if available
      let skills = [];
      if (application.rawResumeLLM) {
        try {
          const resumeParsed = parseJsonSafely(application.rawResumeLLM);
          if (resumeParsed.ok && resumeParsed.json.skills_matched) {
            skills = resumeParsed.json.skills_matched;
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
      
      candidateInfo = {
        name: user.name,
        skills: skills.length > 0 ? skills : user.tags || [],
      };
    }

    // Use dedicated LLM prompt to generate questions on the spot
    const questionsResponse = await callLLM('SCREENING_QUESTIONS', {
      job,
      candidateInfo,
    });

    // Parse the response
    const parsed = parseJsonSafely(questionsResponse);
    
    let questions = [];
    if (parsed.ok && parsed.json.screening_questions) {
      questions = parsed.json.screening_questions;
    } else {
      // Fallback to job's default questions if LLM fails
      questions = job.screening_questions || [];
    }

    // Store questions in screening
    screening.screening_questions = questions;
    await screening.save();

    res.json({
      screeningId: screening._id,
      questions,
    });
  } catch (error) {
    console.error('Error getting/generating questions:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/screenings/:id/upload-video - Store video URL and questions (if provided)
router.post('/:id/upload-video', async (req, res) => {
  try {
    const { videoUrl, questions } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ error: 'videoUrl is required' });
    }

    const screening = await Screening.findById(req.params.id).populate('jobId');
    
    if (!screening) {
      return res.status(404).json({ error: 'Screening not found' });
    }

    // If questions are provided, store them (this ensures questions are set at upload time)
    if (questions && Array.isArray(questions) && questions.length > 0) {
      screening.screening_questions = questions;
    } else if (!screening.screening_questions || screening.screening_questions.length === 0) {
      // If no questions provided and none exist, generate them on the spot
      const job = screening.jobId;
      
      // Get candidate info if available
      const application = await Application.findOne({ 
        _id: screening.applicationId 
      }).populate('userId');
      
      let candidateInfo = null;
      if (application && application.userId) {
        const user = application.userId;
        let skills = [];
        if (application.rawResumeLLM) {
          try {
            const resumeParsed = parseJsonSafely(application.rawResumeLLM);
            if (resumeParsed.ok && resumeParsed.json.skills_matched) {
              skills = resumeParsed.json.skills_matched;
            }
          } catch (e) {
            // Ignore parsing errors
          }
        }
        candidateInfo = {
          name: user.name,
          skills: skills.length > 0 ? skills : user.tags || [],
        };
      }

      const questionsResponse = await callLLM('SCREENING_QUESTIONS', {
        job,
        candidateInfo,
      });

      const parsed = parseJsonSafely(questionsResponse);
      if (parsed.ok && parsed.json.screening_questions) {
        screening.screening_questions = parsed.json.screening_questions;
      } else {
        // Fallback to job's default questions
        screening.screening_questions = job.screening_questions || [];
      }
    }

    screening.videoUrl = videoUrl;
    await screening.save();

    res.json({ 
      message: 'Video URL saved', 
      screening: {
        _id: screening._id,
        videoUrl: screening.videoUrl,
        questions: screening.screening_questions,
      },
    });
  } catch (error) {
    console.error('Error saving video URL:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/screenings/:id/process - Process video (STT + scoring)
router.post('/:id/process', async (req, res) => {
  try {
    const screening = await Screening.findById(req.params.id).populate('jobId');
    
    if (!screening) {
      return res.status(404).json({ error: 'Screening not found' });
    }

    if (!screening.videoUrl) {
      return res.status(400).json({ error: 'No video URL found. Upload video first.' });
    }

    // Transcribe video
    const transcription = await transcribeVideo(screening.videoUrl);
    screening.transcript = transcription.transcript;

    // Score video using questions stored in screening (set at upload time)
    const questions = screening.screening_questions && screening.screening_questions.length > 0
      ? screening.screening_questions
      : screening.jobId.screening_questions || [];

    const videoLLMResponse = await callLLM('VIDEO_SCORING', {
      transcript: transcription.transcript,
      screening_questions: questions,
    });

    const videoParsed = parseJsonSafely(videoLLMResponse);
    
    if (!videoParsed.ok) {
      return res.status(500).json({ 
        error: 'Failed to parse video scoring', 
        details: videoParsed.error 
      });
    }

    screening.scoring = videoParsed.json;
    await screening.save();

    res.json({ 
      message: 'Video processed successfully',
      screening,
    });
  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/screenings/:id/initiate-phone-call - Initiate phone interview via Bland AI
router.post('/:id/initiate-phone-call', async (req, res) => {
  try {
    const { id } = req.params;
    const screening = await Screening.findById(id)
      .populate('applicationId')
      .populate('jobId');
    
    if (!screening) {
      return res.status(404).json({ error: 'Screening not found' });
    }

    const application = screening.applicationId;
    const job = screening.jobId;
    const user = await User.findById(application.userId);

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

    // Get or generate screening questions (technical and behavioral only)
    let questions = screening.screening_questions;
    if (!questions || questions.length === 0) {
      // Generate questions on the spot
      const questionsResponse = await callLLM('SCREENING_QUESTIONS', {
        job,
        candidateInfo: {
          name: user.name,
          skills: application.skillsMatched || user.tags || [],
        },
      });
      const parsed = parseJsonSafely(questionsResponse);
      questions = parsed.ok ? parsed.json.screening_questions : [];
      screening.screening_questions = questions;
      await screening.save();
    }

    // Initialize phone interview
    screening.phoneInterview = {
      status: 'initiated',
      phoneNumber: phoneNumber,
      startedAt: new Date(),
    };
    await screening.save();

    // Make Bland AI call
    const callResult = await makeBlandAICall({
      phoneNumber,
      candidateName: user.name,
      job,
      application,
      questions,
      screeningId: screening._id.toString(),
    });

    // Update screening with call ID
    screening.phoneInterview.callId = callResult.callId;
    screening.phoneInterview.status = 'ringing';
    await screening.save();

    res.json({
      message: 'Phone interview call initiated',
      callId: callResult.callId,
      status: callResult.status,
      phoneNumber: phoneNumber,
      screeningId: screening._id,
      checkStatusUrl: `/api/screenings/${screening._id}/phone-call-status`,
    });
  } catch (error) {
    console.error('Error initiating phone call:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /api/screenings/:id/phone-call-status - Get phone call status
router.get('/:id/phone-call-status', async (req, res) => {
  try {
    const { id } = req.params;
    const screening = await Screening.findById(id);

    if (!screening) {
      return res.status(404).json({ error: 'Screening not found' });
    }

    if (!screening.phoneInterview || !screening.phoneInterview.callId) {
      return res.status(400).json({ error: 'No phone call initiated for this screening' });
    }

    // Get latest status from Bland AI (including recording URL if available)
    try {
      const callStatus = await getCallStatus(screening.phoneInterview.callId);
      
      // Update screening with latest status
      if (callStatus.status) {
        screening.phoneInterview.status = mapBlandStatusToInternal(callStatus.status);
      }
      
      // Recording URL is available when call is completed
      if (callStatus.recording_url) {
        screening.phoneInterview.recordingUrl = callStatus.recording_url;
        console.log(`[Screening] Recording URL retrieved: ${callStatus.recording_url}`);
      }
      
      if (callStatus.transcript) {
        screening.phoneInterview.transcript = callStatus.transcript;
      }
      
      if (callStatus.summary) {
        screening.phoneInterview.summary = callStatus.summary;
      }
      
      if (callStatus.analysis) {
        screening.phoneInterview.analysis = callStatus.analysis;
      }
      
      if (callStatus.duration) {
        screening.phoneInterview.duration = callStatus.duration;
      }
      
      if (callStatus.status === 'completed' || callStatus.status === 'ended') {
        screening.phoneInterview.status = 'completed';
        screening.phoneInterview.completedAt = new Date();
        
        // If recording URL not in status, try to fetch it explicitly
        if (!screening.phoneInterview.recordingUrl) {
          try {
            const { getCallRecording } = await import('../lib/blandAi.js');
            const recordingData = await getCallRecording(screening.phoneInterview.callId);
            if (recordingData.recordingUrl) {
              screening.phoneInterview.recordingUrl = recordingData.recordingUrl;
              console.log(`[Screening] Recording URL fetched explicitly: ${recordingData.recordingUrl}`);
            }
          } catch (recordingError) {
            console.warn(`[Screening] Could not fetch recording URL:`, recordingError.message);
          }
        }
        
        // If we have analysis, update screening scoring
        if (callStatus.analysis) {
          screening.scoring = {
            overall_score: callStatus.analysis.overall_fit || 0,
            communication: callStatus.analysis.communication_quality || 0,
            technical_depth: calculateTechnicalScore(callStatus.analysis.technical_skills || []),
            overall_recommendation: callStatus.analysis.overall_fit >= 7 ? 'yes' : 
                                   callStatus.analysis.overall_fit >= 5 ? 'maybe' : 'no',
            two_line_summary: callStatus.summary || '',
            analysis: callStatus.analysis,
          };
        }
      }
      
      await screening.save();
    } catch (error) {
      console.error('[Screening] Error fetching call status from Bland AI:', error);
      // Continue with stored status if API call fails
    }

    res.json({
      screeningId: screening._id,
      phoneInterview: screening.phoneInterview,
    });
  } catch (error) {
    console.error('Error getting phone call status:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/screenings/:id/webhook - Bland AI webhook for call updates
// According to Bland AI API docs, webhook receives call status updates
router.post('/:id/webhook', async (req, res) => {
  try {
    const { id } = req.params;
    const webhookData = req.body;

    console.log(`[Screening] Webhook received for screening ${id}:`, {
      status: webhookData.status,
      call_id: webhookData.call_id,
      has_recording: !!webhookData.recording_url,
    });

    const screening = await Screening.findById(id);
    
    if (!screening) {
      console.error(`[Screening] Webhook: Screening ${id} not found`);
      return res.status(404).send('Screening not found');
    }

    // Update phone interview status from webhook data
    if (screening.phoneInterview) {
      // Map Bland AI status to internal status
      if (webhookData.status) {
        screening.phoneInterview.status = mapBlandStatusToInternal(webhookData.status);
      }
      
      // Update call ID if provided
      if (webhookData.call_id) {
        screening.phoneInterview.callId = webhookData.call_id;
      }
      
      // Get recording URL when call completes
      if (webhookData.recording_url) {
        screening.phoneInterview.recordingUrl = webhookData.recording_url;
        console.log(`[Screening] Recording URL received: ${webhookData.recording_url}`);
      }
      
      // Update transcript if available
      if (webhookData.transcript) {
        screening.phoneInterview.transcript = webhookData.transcript;
      }
      
      // Update summary if available
      if (webhookData.summary) {
        screening.phoneInterview.summary = webhookData.summary;
      }
      
      // Update analysis if available
      if (webhookData.analysis) {
        screening.phoneInterview.analysis = webhookData.analysis;
      }
      
      // Update duration if available
      if (webhookData.duration) {
        screening.phoneInterview.duration = webhookData.duration;
      }
      
      // When call is completed, fetch full details including recording
      if (webhookData.status === 'completed' || webhookData.status === 'ended') {
        screening.phoneInterview.status = 'completed';
        screening.phoneInterview.completedAt = new Date();
        
        // Fetch full call details to ensure we have recording URL
        if (webhookData.call_id) {
          try {
            const { getCallStatus } = await import('../lib/blandAi.js');
            const fullCallData = await getCallStatus(webhookData.call_id);
            
            // Update with complete data
            if (fullCallData.recording_url) {
              screening.phoneInterview.recordingUrl = fullCallData.recording_url;
            }
            if (fullCallData.transcript) {
              screening.phoneInterview.transcript = fullCallData.transcript;
            }
            if (fullCallData.summary) {
              screening.phoneInterview.summary = fullCallData.summary;
            }
            if (fullCallData.analysis) {
              screening.phoneInterview.analysis = fullCallData.analysis;
            }
            
            console.log(`[Screening] Full call data fetched for ${id}, recording: ${fullCallData.recording_url ? 'available' : 'not available'}`);
          } catch (fetchError) {
            console.error(`[Screening] Error fetching full call data:`, fetchError);
            // Continue with webhook data if fetch fails
          }
        }
        
        // Update screening scoring if analysis available
        const analysis = webhookData.analysis || screening.phoneInterview.analysis;
        if (analysis) {
          screening.scoring = {
            overall_score: analysis.overall_fit || 0,
            communication: analysis.communication_quality || 0,
            technical_depth: calculateTechnicalScore(analysis.technical_skills || []),
            overall_recommendation: analysis.overall_fit >= 7 ? 'yes' : 
                                   analysis.overall_fit >= 5 ? 'maybe' : 'no',
            two_line_summary: webhookData.summary || screening.phoneInterview.summary || '',
            analysis: analysis,
          };
        }
      }
    }

    await screening.save();
    console.log(`[Screening] Webhook processed successfully for screening ${id}`);

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error');
  }
});

// GET /api/screenings/:id/recording - Get call recording URL
router.get('/:id/recording', async (req, res) => {
  try {
    const { id } = req.params;
    const screening = await Screening.findById(id);

    if (!screening) {
      return res.status(404).json({ error: 'Screening not found' });
    }

    if (!screening.phoneInterview || !screening.phoneInterview.callId) {
      return res.status(400).json({ error: 'No phone call initiated for this screening' });
    }

    // Try to get recording from stored data first
    if (screening.phoneInterview.recordingUrl) {
      return res.json({
        screeningId: screening._id,
        callId: screening.phoneInterview.callId,
        recordingUrl: screening.phoneInterview.recordingUrl,
        status: screening.phoneInterview.status,
      });
    }

    // If not stored, fetch from Bland AI
    try {
      const recordingData = await getCallRecording(screening.phoneInterview.callId);
      
      // Update screening if recording URL is available
      if (recordingData.recordingUrl) {
        screening.phoneInterview.recordingUrl = recordingData.recordingUrl;
        await screening.save();
      }

      res.json({
        screeningId: screening._id,
        callId: screening.phoneInterview.callId,
        recordingUrl: recordingData.recordingUrl,
        status: recordingData.status,
        message: recordingData.message || null,
      });
    } catch (error) {
      console.error('[Screening] Error fetching recording:', error);
      res.status(500).json({ 
        error: 'Error fetching recording', 
        details: error.message,
        status: screening.phoneInterview.status,
      });
    }
  } catch (error) {
    console.error('Error getting recording:', error);
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

// Helper function to calculate technical score from skills
function calculateTechnicalScore(technicalSkills) {
  // Simple scoring: more skills = higher score (max 10)
  if (!technicalSkills || technicalSkills.length === 0) return 0;
  return Math.min(10, Math.round((technicalSkills.length / 5) * 10));
}

export default router;

