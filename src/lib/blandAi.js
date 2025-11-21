/**
 * Bland AI API integration for telephonic interviews
 */

import dotenv from 'dotenv';
import { isValidE164 } from './phoneFormatter.js';

dotenv.config();

const BLAND_API_KEY = process.env.BLAND_API_KEY;
const BLAND_API_URL = 'https://api.bland.ai/v1/calls';

/**
 * Make an outbound call using Bland AI
 * @param {Object} params - Call parameters
 * @param {string} params.phoneNumber - Candidate phone number (format: +91XXXXXXXXXX)
 * @param {string} params.candidateName - Candidate name
 * @param {Object} [params.job] - Job details (optional - for generic calls without job)
 * @param {Object} [params.application] - Application details (optional - for generic calls without application)
 * @param {Object} [params.user] - User details (for generic calls without application)
 * @param {Array} params.questions - Technical and behavioral questions
 * @param {string} params.applicationId - Application ID for tracking (optional)
 * @param {string} params.userId - User ID for tracking (optional, used when no application)
 * @param {string} params.startTime - Optional scheduled start time in format "YYYY-MM-DD HH:MM:SS -HH:MM" (e.g., "2021-01-01 12:00:00 -05:00")
 * @returns {Promise<Object>} Call response from Bland AI
 */
export async function makeBlandAICall({ phoneNumber, candidateName, job, application, user, questions, applicationId, userId, startTime = null }) {
  try {
    if (!BLAND_API_KEY) {
      throw new Error('BLAND_API_KEY not configured. Please set BLAND_API_KEY in your .env file.');
    }

    // Validate phone number is in E.164 format (required by Bland AI)
    if (!isValidE164(phoneNumber)) {
      throw new Error(`Phone number must be in E.164 format (e.g., +919876543210). Received: ${phoneNumber}`);
    }

    // Build candidate summary from application or user data
    const candidateSummary = job && application 
      ? buildCandidateSummary(application, job)
      : buildGenericCandidateSummary(user);
    
    // Build interview prompt (generic if no job, job-specific if job exists)
    const prompt = job && application
      ? buildInterviewPrompt(candidateName, job, questions, candidateSummary)
      : buildGenericInterviewPrompt(candidateName, questions, candidateSummary);
    
    // Build first sentence (generic if no job)
    const firstSentence = job
      ? buildFirstSentence(candidateName, job.role, job.company_name)
      : buildGenericFirstSentence(candidateName);
    
    // Get webhook base URL from environment or use default
    const webhookBaseUrl = process.env.WEBHOOK_BASE_URL || 'http://localhost:3000';
    
    // Prepare payload according to Bland AI API format
    const payload = {
      phone_number: phoneNumber,
      task: prompt,
      first_sentence: firstSentence,
      wait_for_greeting: true,
      model: 'base',
      record: true, // Enable call recording
      language: 'en-IN', // Indian English
      answered_by_enabled: true,
      interruption_threshold: 170,
      temperature: 0.5,
      amd: false, // Answering Machine Detection
      max_duration: 15, // Maximum call duration in minutes
      summary_prompt: 'Summarize the phone interview call in English. Include key technical and behavioral insights.',
      analysis_prompt: 'Extract the following information from the call: technical skills demonstrated, behavioral traits, communication quality, overall fit for the role.',
      analysis_schema: {
        technical_skills: 'array of technical skills mentioned or demonstrated',
        behavioral_traits: 'array of behavioral traits observed',
        communication_quality: 'rating from 1-10',
        overall_fit: 'rating from 1-10',
        strengths: 'array of candidate strengths',
        concerns: 'array of any concerns or gaps',
      },
      // Webhook for call status updates (use application webhook if available, otherwise user webhook)
      webhook: applicationId 
        ? `${webhookBaseUrl}/api/applications/${applicationId}/webhook`
        : `${webhookBaseUrl}/api/users/${userId}/phone-call-webhook`,
      // Metadata for tracking
      metadata: {
        ...(applicationId && { applicationId: applicationId.toString() }),
        ...(userId && { userId: userId.toString() }),
        ...(job && { jobId: job._id.toString() }),
        candidateName: candidateName,
      },
      voice: "bc97a31e-b0b8-49e5-bcb8-393fcc6a86ea"
    };

    // Add start_time if provided (for scheduled calls)
    // Format: "YYYY-MM-DD HH:MM:SS -HH:MM" (e.g., "2021-01-01 12:00:00 -05:00")
    if (startTime) {
      // Validate start_time format
      const startTimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [-\+]\d{2}:\d{2}$/;
      if (!startTimeRegex.test(startTime)) {
        throw new Error(`Invalid start_time format. Expected "YYYY-MM-DD HH:MM:SS -HH:MM" (e.g., "2021-01-01 12:00:00 -05:00"). Received: ${startTime}`);
      }
      payload.start_time = startTime;
      console.log(`[BlandAI] Scheduling call for: ${startTime}`);
    }

    const callContext = applicationId ? `application ${applicationId}` : `user ${userId}`;
    console.log(`[BlandAI] Initiating call to ${phoneNumber} for ${callContext}`);

    const response = await fetch(BLAND_API_URL, {
      method: 'POST',
      headers: {
        'authorization': BLAND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Bland AI API error: ${response.status} - ${errorText}`);
    }

    const responseData = await response.json();
    
    // Handle API response format according to Bland AI docs
    // Response includes: call_id, status, message
    const callId = responseData.call_id || responseData.id;
    
    if (!callId) {
      throw new Error('Bland AI API did not return a call_id');
    }
    
    console.log(`[BlandAI] Call initiated successfully. Call ID: ${callId}`);

    return {
      callId: callId,
      status: responseData.status || 'initiated',
      message: responseData.message || 'Call initiated',
    };
  } catch (error) {
    console.error('[BlandAI] Error making call:', error);
    throw error;
  }
}

/**
 * Build candidate summary for the interview prompt
 */
function buildCandidateSummary(application, job) {
  const summary = {
    name: application.userId?.name || 'Candidate',
    role: job.role,
    company: job.company_name,
    skills: application.skillsMatched || [],
    resumeScore: application.scores?.resumeScore || 0,
    unifiedScore: application.unifiedScore || 0,
    topReasons: application.topReasons || [],
  };

  // Add resume highlights if available
  if (application.rawResumeLLM) {
    try {
      const parsed = typeof application.rawResumeLLM === 'string' 
        ? JSON.parse(application.rawResumeLLM)
        : application.rawResumeLLM;
      
      if (parsed.skills_matched) {
        summary.skills = parsed.skills_matched;
      }
      if (parsed.top_reasons) {
        summary.topReasons = parsed.top_reasons;
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }

  return summary;
}

/**
 * Build generic candidate summary from user data (when no application/job)
 */
function buildGenericCandidateSummary(user) {
  return {
    name: user.name || 'Candidate',
    skills: user.tags || [],
    resumeSummary: user.resumeSummary || '',
    experience: user.totalExperience || '',
    currentCompany: user.currentCompany || '',
  };
}

/**
 * Build interview prompt with technical and behavioral questions only
 */
function buildInterviewPrompt(candidateName, job, questions, candidateSummary) {
  const questionsText = questions.map((q, index) => 
    `Question ${index + 1}: ${q.text}`
  ).join('\n\n');

  return `You are Neo, an AI HR Representative conducting a phone interview for ${job.company_name} (Paytm - Indian fintech company).

IMPORTANT INSTRUCTIONS:
- Always let the candidate finish their sentence before speaking
- Acknowledge candidate answers with words like "okay, great!", "okay", "got it", "understood"
- Ask all main questions in order
- Only ask follow-up questions if needed for clarification
- Be natural and conversational
- Use Indian English conventions
- Be patient and professional

CANDIDATE INFORMATION:
- Name: ${candidateName}
- Role Applied: ${job.role}
- Company: ${job.company_name}
- Skills from Resume: ${candidateSummary.skills.join(', ') || 'Not specified'}
- Resume Score: ${candidateSummary.resumeScore}/100

INTERVIEW FLOW:

1. After your first sentence, if the candidate says they have time, continue with the interview. If they say no or don't have time, say "Okay no worries, you can schedule a call later. Thank you for your time. You can hang up the call." and end the conversation.

2. Ask the following technical and behavioral questions in order:

${questionsText}

3. For each question:
   - Listen to the complete answer
   - Acknowledge with "okay" or "got it"
   - Ask natural follow-up questions only if the answer needs clarification
   - Move to the next question after getting a satisfactory answer

4. After asking all questions, summarize what you've gathered:
   - "Let me quickly summarize what we discussed..."
   - Mention key technical skills and behavioral traits they demonstrated

5. End the call professionally:
   - "That's it from my side. Thank you for your time and for taking this call. We'll review your interview and get back to you if we decide to move ahead. You can hang up the call now."

IMPORTANT:
- NEVER hang up the call without the candidate's permission
- Focus on technical skills and behavioral assessment
- Do NOT ask about notice period, compensation, or joining date (those are handled separately)
- Keep the conversation natural and engaging
- If the candidate asks questions, answer them briefly and professionally`;
}

/**
 * Build generic interview prompt (when no job/application - based on resume only)
 */
function buildGenericInterviewPrompt(candidateName, questions, candidateSummary) {
  const questionsText = questions.map((q, index) => 
    `Question ${index + 1}: ${q.text}`
  ).join('\n\n');

  return `You are Neo, an AI HR Representative conducting a general phone interview for Paytm (Indian fintech company).

IMPORTANT INSTRUCTIONS:
- Always let the candidate finish their sentence before speaking
- Acknowledge candidate answers with words like "okay, great!", "okay", "got it", "understood"
- Ask all main questions in order
- Only ask follow-up questions if needed for clarification
- Be natural and conversational
- Use Indian English conventions
- Be patient and professional

CANDIDATE INFORMATION:
- Name: ${candidateName}
- Skills from Resume: ${candidateSummary.skills.join(', ') || 'Not specified'}
${candidateSummary.experience ? `- Experience: ${candidateSummary.experience}` : ''}
${candidateSummary.currentCompany ? `- Current Company: ${candidateSummary.currentCompany}` : ''}
${candidateSummary.resumeSummary ? `- Resume Summary: ${candidateSummary.resumeSummary.substring(0, 200)}` : ''}

INTERVIEW FLOW:

1. After your first sentence, if the candidate says they have time, continue with the interview. If they say no or don't have time, say "Okay no worries, you can schedule a call later. Thank you for your time. You can hang up the call." and end the conversation.

2. Ask the following technical and behavioral questions in order (these are based on the candidate's resume):

${questionsText}

3. For each question:
   - Listen to the complete answer
   - Acknowledge with "okay" or "got it"
   - Ask natural follow-up questions only if the answer needs clarification
   - Move to the next question after getting a satisfactory answer

4. After asking all questions, summarize what you've gathered:
   - "Let me quickly summarize what we discussed..."
   - Mention key technical skills and behavioral traits they demonstrated

5. End the call professionally:
   - "That's it from my side. Thank you for your time and for taking this call. We'll review your interview and get back to you if we decide to move ahead. You can hang up the call now."

IMPORTANT:
- NEVER hang up the call without the candidate's permission
- Focus on technical skills and behavioral assessment based on their resume
- Do NOT ask about notice period, compensation, or joining date (those are handled separately)
- Keep the conversation natural and engaging
- If the candidate asks questions, answer them briefly and professionally
- Since there's no specific job role, focus on understanding their general technical capabilities and behavioral traits`;
}

/**
 * Build first sentence for the call
 */
function buildFirstSentence(candidateName, jobRole, companyName) {
  return `Hey ${candidateName}... I am Neo, an AI HR Representative calling from ${companyName || 'Paytm'}. It's the company with the yellow light house logo? You recently applied for a ${jobRole} role at the company. Just wanted to talk about that.

...Yes...i know... i know. I am an actual AI...it's a lil weird.

I'm still experimental... I might take a few seconds to respond, the call might get dropped, I might talk over you & so on...

Please try to be patient & talk slightly faster than usual, with fewer pauses but, this will only take about 5-10 minutes, is this a good time to talk?`;
}

/**
 * Build generic first sentence (when no job/application)
 */
function buildGenericFirstSentence(candidateName) {
  return `Hey ${candidateName}... I am Neo, an AI HR Representative calling from Paytm. It's the company with the yellow light house logo? We came across your profile and would like to have a quick conversation with you.

...Yes...i know... i know. I am an actual AI...it's a lil weird.

I'm still experimental... I might take a few seconds to respond, the call might get dropped, I might talk over you & so on...

Please try to be patient & talk slightly faster than usual, with fewer pauses but, this will only take about 5-10 minutes, is this a good time to talk?`;
}

/**
 * Get call status and details from Bland AI
 * According to API docs: GET /v1/calls/{call_id}
 */
export async function getCallStatus(callId) {
  try {
    if (!BLAND_API_KEY) {
      throw new Error('BLAND_API_KEY not configured');
    }

    const response = await fetch(`${BLAND_API_URL}/${callId}`, {
      method: 'GET',
      headers: {
        'authorization': BLAND_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Bland AI API error: ${response.status} - ${errorText}`);
    }

    const callData = await response.json();
    
    // Log call status for debugging
    console.log(`[BlandAI] Call ${callId} status: ${callData.status || 'unknown'}`);
    
    return callData;
  } catch (error) {
    console.error('[BlandAI] Error getting call status:', error);
    throw error;
  }
}

/**
 * Get call recording URL
 * The recording URL is available in the call status response when call is completed
 * This is a convenience function that fetches call status and extracts recording URL
 */
export async function getCallRecording(callId) {
  try {
    const callStatus = await getCallStatus(callId);
    
    // Recording URL is available in the response when call is completed
    if (callStatus.recording_url) {
      return {
        recordingUrl: callStatus.recording_url,
        status: callStatus.status,
        transcript: callStatus.transcript,
        summary: callStatus.summary,
        analysis: callStatus.analysis,
      };
    }
    
    // If recording not ready yet, return status
    return {
      recordingUrl: null,
      status: callStatus.status,
      message: callStatus.status === 'completed' 
        ? 'Call completed but recording not yet available. Please check again in a few moments.'
        : `Call status: ${callStatus.status}. Recording will be available when call completes.`,
    };
  } catch (error) {
    console.error('[BlandAI] Error getting call recording:', error);
    throw error;
  }
}

