/**
 * LLM integration supporting both AWS Bedrock and OpenAI
 * - AWS Bedrock: Claude, Titan, AI21, Cohere, Llama models (using REST API)
 * - OpenAI: GPT-4o, GPT-4, GPT-3.5 models
 */

import dotenv from 'dotenv';

dotenv.config();

// LLM Provider selection
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'bedrock'; // 'bedrock' or 'openai'

// AWS Bedrock configuration
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_BEARER_TOKEN_BEDROCK = process.env.AWS_BEARER_TOKEN_BEDROCK;
const BEDROCK_ENDPOINT = `https://bedrock-runtime.${AWS_REGION}.amazonaws.com`;

// Model configuration - can use different models for different tasks
// Supports both Bedrock and OpenAI models
const MODEL_CONFIG = {
  // Critical tasks requiring highest accuracy (resume scoring, video scoring)
  CRITICAL: process.env.LLM_MODEL_CRITICAL || process.env.BEDROCK_MODEL_CRITICAL || (LLM_PROVIDER === 'openai' 
    ? 'gpt-4o' 
    : 'us.anthropic.claude-3-opus-20240229-v1:0'),
  
  // Standard tasks (JD enhancement, email generation, screening questions)
  STANDARD: process.env.LLM_MODEL_STANDARD || process.env.BEDROCK_MODEL_STANDARD || (LLM_PROVIDER === 'openai' 
    ? 'gpt-4o' 
    : 'us.anthropic.claude-3-5-sonnet-20241022-v1:0'),
  
  // Simple/fast tasks (compensation analysis, github scoring)
  FAST: process.env.LLM_MODEL_FAST || process.env.BEDROCK_MODEL_FAST || (LLM_PROVIDER === 'openai' 
    ? 'gpt-4o-mini' 
    : 'us.anthropic.claude-3-5-haiku-20241022-v1:0'),
  
  // Default fallback
  DEFAULT: process.env.LLM_MODEL_ID || process.env.BEDROCK_MODEL_ID || (LLM_PROVIDER === 'openai' 
    ? 'gpt-4o' 
    : 'us.anthropic.claude-3-5-sonnet-20241022-v1:0'),
};

/**
 * Build prompt for JD enhancement
 */
function buildJDEnhancerPrompt(payload) {
  const { raw_jd, company_name, role, seniority, budget_info, must_have_skills, nice_to_have } = payload;

  return `You are an expert HR consultant helping to enhance a job description.

Company: ${company_name}
Role: ${role}
Seniority: ${seniority || 'Not specified'}
Budget: ${budget_info || 'Not specified'}
Must-have skills: ${must_have_skills?.join(', ') || 'None specified'}
Nice-to-have skills: ${nice_to_have?.join(', ') || 'None specified'}

Raw Job Description:
${raw_jd}

Please enhance this job description and return a JSON object with the following structure:
{
  "enhanced_jd": "Enhanced, professional job description (2-3 paragraphs)",
  "apply_form_fields": [
    {"name": "email", "type": "email", "label": "Email Address", "required": true},
    {"name": "phone", "type": "tel", "label": "Phone Number", "required": false}
  ]
}

Note: Tags are extracted separately using embeddings for better semantic matching, and screening questions are generated dynamically on-the-spot when candidates submit videos.
Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for resume scoring
 */
function buildResumeScoringPrompt(payload) {
  const { resumeText, job } = payload;

  return `You are an expert recruiter evaluating a candidate's resume against a job posting.

Job Requirements:
- Role: ${job.role}
- Company: ${job.company_name}
- Must-have skills: ${job.must_have_skills?.join(', ') || 'None specified'}
- Nice-to-have skills: ${job.nice_to_have?.join(', ') || 'None specified'}
- Job Description: ${job.enhanced_jd || job.raw_jd}

Candidate Resume:
${resumeText}

Analyze the resume and return a JSON object with:
{
  "match_score": 0-100,
  "confidence": 0-1,
  "skills_matched": ["skill1", "skill2", ...],
  "skills_missing": ["skill1", "skill2", ...],
  "recommended_action": "yes" | "maybe" | "no",
  "top_reasons": ["reason1", "reason2", "reason3"]
}

Be thorough and accurate. Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for GitHub/Portfolio scoring
 */
function buildGitHubPortfolioScoringPrompt(payload) {
  const { githubUrl, portfolioUrl, job } = payload;

  return `Evaluate a candidate's GitHub and/or Portfolio profile for a job position.

Job Requirements:
- Role: ${job.role}
- Required skills: ${job.must_have_skills?.join(', ') || 'None specified'}

Candidate Profiles:
${githubUrl ? `GitHub: ${githubUrl}` : 'No GitHub provided'}
${portfolioUrl ? `Portfolio: ${portfolioUrl}` : 'No Portfolio provided'}

Note: You cannot actually access these URLs, but based on typical evaluation criteria, provide a score.

Return a JSON object:
{
  "score": 0-100,
  "confidence": 0-1,
  "analysis": "Brief analysis of the profile quality and relevance"
}

Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for compensation analysis
 */
function buildCompensationAnalysisPrompt(payload) {
  const { compensationExpectation, budget_info } = payload;

  return `Analyze if a candidate's compensation expectation aligns with the job budget.

Job Budget: ${budget_info || 'Not specified'}
Candidate Expectation: ${compensationExpectation || 'Not specified'}

Return a JSON object:
{
  "score": 0-100,
  "analysis": "Analysis of alignment between expectation and budget"
}

Score should be higher if expectations align well. Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for email generation
 */
function buildEmailGeneratorPrompt(payload) {
  const {
    candidateName,
    role,
    company,
    seniority,
    screening_link,
    screening_questions,
    scores,
    resumeHighlights,
    userProfile,
    jobDetails,
  } = payload;

  let context = `Generate a personalized, professional email inviting a candidate to a video screening.

Candidate: ${candidateName}
Role: ${seniority ? seniority + ' ' : ''}${role}
Company: ${company}
Screening Link: ${screening_link}

Screening Questions: ${screening_questions?.length || 0} question(s)
${screening_questions?.map((q, i) => `${i + 1}. ${q.text} (${q.time_limit_sec}s)`).join('\n') || 'None'}

`;

  if (scores) {
    context += `Candidate Scores:
- Overall Match: ${scores.unifiedScore}%
- Resume Score: ${scores.resumeScore}%
- GitHub/Portfolio Score: ${scores.githubPortfolioScore}%
- Compensation Score: ${scores.compensationScore}%

`;
  }

  if (resumeHighlights) {
    context += `Resume Highlights:
- Matched Skills: ${resumeHighlights.skills_matched?.join(', ') || 'None'}
- Top Reasons: ${resumeHighlights.top_reasons?.join('; ') || 'None'}

`;
  }

  if (userProfile) {
    context += `Candidate Profile:
- GitHub: ${userProfile.githubUrl || 'Not provided'}
- Portfolio: ${userProfile.portfolioUrl || 'Not provided'}

`;
  }

  context += `Generate a warm, professional email. Make it personalized based on the candidate's scores and profile.
The tone should be ${scores?.unifiedScore >= 85 ? 'enthusiastic' : scores?.unifiedScore >= 80 ? 'warm' : 'friendly'}.

Return a JSON object:
{
  "subject": "Email subject line",
  "preview_text": "Preview text (first 100 chars)",
  "tone": "friendly" | "warm" | "enthusiastic",
  "plain_text": "Full email text (plain text version)",
  "html_snippet": "HTML version of email body"
}

Return ONLY valid JSON, no additional text.`;

  return context;
}

/**
 * Build prompt for generating screening questions on the spot
 */
function buildScreeningQuestionsPrompt(payload) {
  const { job, candidateInfo } = payload;

  return `You are an expert interviewer creating video screening questions for a job position.

Job Details:
- Role: ${job.role}
- Company: ${job.company_name}
- Seniority: ${job.seniority || 'Not specified'}
- Must-have skills: ${job.must_have_skills?.join(', ') || 'None specified'}
- Nice-to-have skills: ${job.nice_to_have?.join(', ') || 'None specified'}
- Job Description: ${(job.enhanced_jd || job.raw_jd).substring(0, 500)}

${candidateInfo ? `Candidate Context:
- Name: ${candidateInfo.name || 'Not provided'}
- Skills: ${candidateInfo.skills?.join(', ') || 'Not provided'}
` : ''}

Generate 3-5 engaging, relevant video screening questions that assess:
1. Technical skills and experience relevant to the role
2. Problem-solving approach and critical thinking
3. Communication abilities
4. Cultural fit and motivation
5. Real-world application of skills

Each question should:
- Be clear and specific
- Allow candidates to showcase their expertise
- Have an appropriate time limit (60-180 seconds)
- Be suitable for video response format

Return a JSON object with this structure:
{
  "screening_questions": [
    {"text": "Question 1 text", "time_limit_sec": 120, "type": "video"},
    {"text": "Question 2 text", "time_limit_sec": 90, "type": "video"},
    {"text": "Question 3 text", "time_limit_sec": 150, "type": "video"}
  ]
}

Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for video scoring
 */
function buildVideoScoringPrompt(payload) {
  const { transcript, screening_questions } = payload;

  return `You are an expert interviewer evaluating a candidate's video interview responses.

Screening Questions:
${screening_questions?.map((q, i) => `${i + 1}. ${q.text}`).join('\n') || 'No questions provided'}

Candidate Transcript:
${transcript}

Evaluate each question response and provide an overall assessment. Return a JSON object:
{
  "per_question": [
    {
      "question_index": 1,
      "communication": 0-10,
      "technical_depth": 0-10,
      "clarity": 0-10,
      "notes": "Brief notes about the response"
    }
  ],
  "overall_score": 0-100,
  "confidence": 0-1,
  "overall_recommendation": "yes" | "maybe" | "no",
  "two_line_summary": "Two-line summary of the candidate's performance"
}

Be thorough and fair. Return ONLY valid JSON, no additional text.`;
}

/**
 * Call OpenAI API with a prompt
 * @param {string} prompt - The user prompt
 * @param {string} systemPrompt - Optional system prompt
 * @param {string} modelId - Optional model ID (defaults to STANDARD)
 * @param {number} temperature - Optional temperature (defaults to 0.7)
 */
async function callOpenAI(prompt, systemPrompt = null, modelId = null, temperature = 0.7) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key not configured. Please set OPENAI_API_KEY in your .env file.');
  }

  const selectedModel = modelId || MODEL_CONFIG.STANDARD;
  const messages = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: selectedModel,
        messages,
        temperature,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('[OpenAI] Error calling model:', error);
    throw new Error(`OpenAI API error: ${error.message}`);
  }
}

/**
 * Call Amazon Bedrock Converse API with a prompt
 * Uses Bearer token authentication
 * @param {string} prompt - The user prompt
 * @param {string} systemPrompt - Optional system prompt
 * @param {string} modelId - Optional model ID (defaults to STANDARD)
 * @param {number} temperature - Optional temperature (defaults to 0.7)
 */
async function callBedrock(prompt, systemPrompt = null, modelId = null, temperature = 0.7) {
  try {
    // Validate credentials
    if (!AWS_BEARER_TOKEN_BEDROCK) {
      throw new Error('AWS Bearer token not configured. Please set AWS_BEARER_TOKEN_BEDROCK in your .env file.');
    }

    // Use provided model or default to STANDARD
    const selectedModel = modelId || MODEL_CONFIG.STANDARD;

    // Prepare messages in Converse API format
    const messages = [
      {
        role: 'user',
        content: [{ text: prompt }],
      },
    ];

    const body = {
      messages,
      inferenceConfig: {
        maxTokens: 4096,
        temperature,
      },
    };

    // Add system prompt if provided
    if (systemPrompt) {
      body.system = [{ text: systemPrompt }];
    }

    // Prepare request URL
    const url = `${BEDROCK_ENDPOINT}/model/${selectedModel}/converse`;

    // Make the HTTP request with Bearer token
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AWS_BEARER_TOKEN_BEDROCK}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { message: errorText };
      }

      // Provide helpful error messages
      if (response.status === 403) {
        throw new Error('Access denied to Bedrock. Please ensure your Bearer token has Bedrock permissions and model access is enabled.');
      }
      if (response.status === 400) {
        throw new Error(`Invalid Bedrock model ID: ${selectedModel}. Please check your model configuration. ${errorData.message || ''}`);
      }
      if (response.status === 401) {
        throw new Error('AWS Bearer token invalid. Please check AWS_BEARER_TOKEN_BEDROCK in your .env file.');
      }

      throw new Error(`Bedrock API error (${response.status}): ${errorData.message || errorText}`);
    }

    const responseBody = await response.json();

    // Extract text from Converse API response
    // Response format: { "output": { "message": { "content": [{ "text": "..." }] } } }
    const text = responseBody.output?.message?.content?.[0]?.text || '';
    
    if (!text) {
      console.warn('[Bedrock] Empty response from model:', responseBody);
      throw new Error('Empty response from Bedrock model');
    }

    return text;
  } catch (error) {
    console.error('[Bedrock] Error calling model:', error);
    
    // Re-throw with better error messages
    if (error.message.includes('Bearer token')) {
      throw error;
    }
    if (error.message.includes('Access denied') || error.message.includes('403')) {
      throw error;
    }
    if (error.message.includes('Invalid Bedrock model')) {
      throw error;
    }
    
    throw new Error(`Bedrock API error: ${error.message}`);
  }
}

/**
 * Call LLM (routes to Bedrock or OpenAI based on configuration)
 * @param {string} prompt - The user prompt
 * @param {string} systemPrompt - Optional system prompt
 * @param {string} modelId - Optional model ID (defaults to STANDARD)
 * @param {number} temperature - Optional temperature (defaults to 0.7)
 */
async function callLLMProvider(prompt, systemPrompt = null, modelId = null, temperature = 0.7) {
  if (LLM_PROVIDER === 'openai') {
    return await callOpenAI(prompt, systemPrompt, modelId, temperature);
  } else {
    return await callBedrock(prompt, systemPrompt, modelId, temperature);
  }
}

/**
 * Get the best model for a specific task
 */
function getModelForTask(promptName) {
  // Critical tasks - use best model for highest accuracy
  if (promptName === 'RESUME_SCORING' || promptName === 'VIDEO_SCORING') {
    return MODEL_CONFIG.CRITICAL;
  }
  
  // Fast tasks - use faster/cheaper model
  if (promptName === 'GITHUB_PORTFOLIO_SCORING' || promptName === 'COMPENSATION_ANALYSIS') {
    return MODEL_CONFIG.FAST;
  }
  
  // Standard tasks - use balanced model
  // JD_ENHANCER, EMAIL_GENERATOR, SCREENING_QUESTIONS
  return MODEL_CONFIG.STANDARD;
}

/**
 * Main LLM function - routes to appropriate prompt builder and calls Bedrock
 * Automatically selects the best model for each task type
 */
export async function callLLM(promptName, payload) {
  const selectedModel = getModelForTask(promptName);
  console.log(`[LLM] Calling ${promptName} with Bedrock model: ${selectedModel}`);

  let prompt;
  let systemPrompt = 'You are a helpful AI assistant. Always return valid JSON as requested. Do not include any text before or after the JSON.';
  let temperature = 0.7; // Default temperature

  switch (promptName) {
    case 'JD_ENHANCER':
      prompt = buildJDEnhancerPrompt(payload);
      temperature = 0.7; // Creative but structured
      break;

    case 'RESUME_SCORING':
      prompt = buildResumeScoringPrompt(payload);
      systemPrompt += ' Be precise and consistent in your scoring.';
      temperature = 0.3; // Lower temperature for more consistent, objective scoring
      break;

    case 'GITHUB_PORTFOLIO_SCORING':
      prompt = buildGitHubPortfolioScoringPrompt(payload);
      temperature = 0.5; // Moderate creativity
      break;

    case 'COMPENSATION_ANALYSIS':
      prompt = buildCompensationAnalysisPrompt(payload);
      temperature = 0.4; // More objective analysis
      break;

    case 'EMAIL_GENERATOR':
      prompt = buildEmailGeneratorPrompt(payload);
      temperature = 0.8; // More creative for personalized emails
      break;

    case 'VIDEO_SCORING':
      prompt = buildVideoScoringPrompt(payload);
      systemPrompt += ' Be thorough and fair in your evaluation.';
      temperature = 0.3; // Lower temperature for consistent, fair evaluation
      break;

    case 'SCREENING_QUESTIONS':
      prompt = buildScreeningQuestionsPrompt(payload);
      temperature = 0.7; // Creative but relevant questions
      break;

    default:
      throw new Error(`Unknown prompt name: ${promptName}`);
  }

  try {
    const response = await callLLMProvider(prompt, systemPrompt, selectedModel, temperature);
    console.log(`[LLM] Raw response for ${promptName} (${LLM_PROVIDER}):`, response.substring(0, 200) + '...');
    return response;
  } catch (error) {
    console.error(`[LLM] Error for ${promptName}:`, error);
    throw error;
  }
}
