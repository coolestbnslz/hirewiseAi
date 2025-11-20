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
// IMPORTANT: Model selection is based on LLM_PROVIDER to ensure correct model type
const MODEL_CONFIG = {
  // Critical tasks requiring highest accuracy (resume scoring, video scoring)
  CRITICAL: LLM_PROVIDER === 'openai' 
    ? (process.env.LLM_MODEL_CRITICAL || 'gpt-4o')
    : (process.env.BEDROCK_MODEL_CRITICAL || 'us.anthropic.claude-3-opus-20240229-v1:0'),
  
  // Standard tasks (JD enhancement, email generation, screening questions)
  STANDARD: LLM_PROVIDER === 'openai' 
    ? (process.env.LLM_MODEL_STANDARD || 'gpt-4o')
    : (process.env.BEDROCK_MODEL_STANDARD || 'us.anthropic.claude-3-5-sonnet-20241022-v1:0'),
  
  // Simple/fast tasks (compensation analysis, github scoring)
  FAST: LLM_PROVIDER === 'openai' 
    ? (process.env.LLM_MODEL_FAST || 'gpt-4o-mini')
    : (process.env.BEDROCK_MODEL_FAST || 'us.anthropic.claude-3-5-haiku-20241022-v1:0'),
  
  // Default fallback
  DEFAULT: LLM_PROVIDER === 'openai' 
    ? (process.env.LLM_MODEL_ID || 'gpt-4o')
    : (process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-3-5-sonnet-20241022-v1:0'),
};

/**
 * Build prompt for JD enhancement
 */
function buildJDEnhancerPrompt(payload) {
  const { raw_jd, company_name, role, team, seniority, location, job_type, budget_info, must_have_skills, nice_to_have } = payload;

  return `You are an expert HR consultant helping to enhance a job description for Paytm, an Indian fintech company.

Company: ${company_name} (Indian fintech company, based in Noida)
Role: ${role}
Team: ${team || 'Not specified'}
Seniority: ${seniority || 'Not specified'}
Location: ${location || 'Noida, Delhi NCR'}
Job Type: ${job_type || 'Full-time'}
Must-have skills: ${must_have_skills?.join(', ') || 'None specified'}
Nice-to-have skills: ${nice_to_have?.join(', ') || 'None specified'}

Raw Job Description:
${raw_jd}

Please enhance this job description with Indian context:
- Mention Paytm's position in the Indian fintech market
- Reference Indian payment systems, UPI, digital payments if relevant
- Use Indian English conventions
- Include location context (${location || 'Noida/Delhi NCR'}) and work arrangement (${job_type || 'Full-time'})
- Mention the team/department (${team || 'Engineering'}) if specified
- DO NOT include salary range, compensation, or budget information in the enhanced job description
- Focus on role responsibilities, requirements, company culture, and growth opportunities

Return a JSON object with the following structure:
{
  "enhanced_jd": "Enhanced, professional job description (2-3 paragraphs) with Indian context, WITHOUT any salary or compensation information",
  "apply_form_fields": [
    {"name": "email", "type": "email", "label": "Email Address", "required": true},
    {"name": "phone", "type": "tel", "label": "Phone Number", "required": false}
  ]
}

IMPORTANT: The enhanced_jd must NOT contain any mention of salary, compensation, budget, pay scale, CTC, LPA, or any monetary information. Focus only on the role, responsibilities, requirements, and company benefits (non-monetary).

Note: Tags are extracted separately using embeddings for better semantic matching, and screening questions are generated dynamically on-the-spot when candidates submit videos.
Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for resume scoring
 */
function buildResumeScoringPrompt(payload) {
  const { resumeText, job } = payload;

  return `You are an expert recruiter evaluating a candidate's resume against a job posting at Paytm (Indian fintech company).

Job Requirements:
- Role: ${job.role}
- Company: ${job.company_name} (Indian fintech, Noida-based)
- Must-have skills: ${job.must_have_skills?.join(', ') || 'None specified'}
- Nice-to-have skills: ${job.nice_to_have?.join(', ') || 'None specified'}
- Job Description: ${job.enhanced_jd || job.raw_jd}

Candidate Resume:
${resumeText}

Evaluate the resume considering:
- Indian market experience and fintech/payment industry knowledge
- Experience with Indian payment systems (UPI, digital wallets, payment gateways)
- Understanding of Indian fintech regulations and compliance
- Cultural fit for Indian work environment

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
  const { githubData, portfolioUrl, job } = payload;

  let prompt = `You are an expert technical recruiter analyzing a candidate's GitHub profile and portfolio to evaluate their technical skills and project experience.

IMPORTANT: You MUST base your analysis ONLY on the actual GitHub data provided below. Do NOT use generic assumptions or templates.

`;

  // Add GitHub data if available
  if (githubData && typeof githubData === 'string' && !githubData.includes('Error:')) {
    prompt += `GitHub Profile Data (ACTUAL data fetched from GitHub API):
${githubData}

`;
  } else if (githubData && typeof githubData === 'string' && githubData.includes('Error:')) {
    prompt += `GitHub: ${githubData}\n\n`;
  } else {
    prompt += `GitHub: Not provided\n\n`;
  }

  // Add portfolio URL
  if (portfolioUrl) {
    prompt += `Portfolio URL: ${portfolioUrl}\n`;
    prompt += `Note: Portfolio website content could not be automatically fetched. Consider the URL in your analysis.\n\n`;
  } else {
    prompt += `Portfolio: Not provided\n\n`;
  }

  // Add job context if available
  if (job) {
    prompt += `Job Context:
- Role: ${job.role}
- Required Skills: ${job.must_have_skills?.join(', ') || 'Not specified'}
- Nice-to-have: ${job.nice_to_have?.join(', ') || 'Not specified'}

`;
  }

  prompt += `Your task:
1. Analyze the ACTUAL GitHub repositories, projects, and technologies mentioned
2. Identify specific projects the candidate has worked on (based on repository names and descriptions)
3. Identify technologies, programming languages, and frameworks used (based on repository languages and topics)
4. Evaluate the quality and relevance of their work
5. Provide a score based on technical depth, project complexity, and relevance to the job

CRITICAL RULES:
- Use ONLY information from the GitHub data provided above
- Do NOT add generic phrases like "likely worked on" or "may have experience"
- Base your summary on ACTUAL repository names, descriptions, languages, and topics
- If repositories are listed, mention specific project names and technologies
- If no repositories are found, state that clearly
- Do NOT make assumptions about projects not listed in the data

Example of what NOT to do:
❌ "Rahul Sharma appears to be a full-stack developer with a focus on web technologies. His repositories likely include projects built with React, Node.js, and Express. He may have contributed to open-source projects..."

Example of what TO do:
✅ "Based on the GitHub profile data, the candidate has [X] repositories including [specific repository names from the data]. Key projects: [actual project names]. Technologies used: [actual languages from repository data like JavaScript, Python, etc.]. The candidate has [X] stars and [X] forks across their repositories."

Return a JSON object:
{
  "score": 0-100,
  "confidence": 0-1,
  "summary": "Accurate summary based EXACTLY on the GitHub data provided, mentioning specific projects, technologies, and work experience",
  "analysis": "Brief analysis of the profile quality and technical depth based on actual data"
}

Return ONLY valid JSON, no additional text.`;

  return prompt;
}

/**
 * Build prompt for compensation analysis
 */
function buildCompensationAnalysisPrompt(payload) {
  const { compensationExpectation, budget_info } = payload;

  return `Analyze if a candidate's compensation expectation aligns with the job budget for Paytm (Indian fintech company).

IMPORTANT: All amounts are in INR (Indian Rupees). Use Indian compensation format:
- Format: ₹XX,XX,XXX per annum or XX LPA (Lakhs Per Annum)
- Example: ₹25,00,000 per annum = 25 LPA
- Consider Indian market rates for the role and experience level

Job Budget: ${budget_info || 'Not specified'} (in INR)
Candidate Expectation: ${compensationExpectation || 'Not specified'} (in INR)

Evaluate based on:
- Indian market compensation standards
- Fintech industry rates in India
- Experience level and location (Noida/Delhi NCR)
- Paytm's compensation structure

Return a JSON object:
{
  "score": 0-100,
  "analysis": "Analysis of alignment between expectation and budget, considering Indian market rates and fintech industry standards"
}

Score should be higher if expectations align well with Indian market standards. Return ONLY valid JSON, no additional text.`;
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

  let context = `Generate a personalized, professional email inviting a candidate to a video screening for Paytm (Indian fintech company).

IMPORTANT CONTEXT:
- Company: Paytm (leading Indian fintech company, based in Noida)
- Use Indian English conventions and cultural context
- Reference Paytm's position in Indian digital payments ecosystem
- Use warm, professional tone appropriate for Indian corporate culture
- Mention Paytm's impact on India's digital payment revolution if relevant

Candidate: ${candidateName}
Role: ${seniority ? seniority + ' ' : ''}${role}
Company: ${company} (Paytm - Indian fintech)
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

  context += `Generate a warm, professional email with Indian context. Make it personalized based on the candidate's scores and profile.
The tone should be ${scores?.unifiedScore >= 85 ? 'enthusiastic' : scores?.unifiedScore >= 80 ? 'warm' : 'friendly'}.

Email Guidelines:
- Use Indian English conventions
- Reference Paytm's role in Indian fintech and digital payments
- Mention Paytm's impact on India's digital economy
- Use culturally appropriate greetings and closing
- Keep it professional yet warm (Indian corporate style)

Return a JSON object:
{
  "subject": "Email subject line (with Paytm/Indian context)",
  "preview_text": "Preview text (first 100 chars)",
  "tone": "friendly" | "warm" | "enthusiastic",
  "plain_text": "Full email text (plain text version) with Indian context",
  "html_snippet": "HTML version of email body with Indian context"
}

Return ONLY valid JSON, no additional text.`;

  return context;
}

/**
 * Build prompt for generating screening questions on the spot
 */
function buildScreeningQuestionsPrompt(payload) {
  const { job, candidateInfo } = payload;

  return `You are an expert interviewer creating video screening questions for a job position at Paytm (Indian fintech company).

Job Details:
- Role: ${job.role}
- Company: ${job.company_name} (Paytm - Indian fintech, Noida)
- Team: ${job.team || 'Not specified'}
- Seniority: ${job.seniority || 'Not specified'}
- Location: ${job.location || 'Noida, Delhi NCR'}
- Job Type: ${job.job_type || 'Full-time'}
- Must-have skills: ${job.must_have_skills?.join(', ') || 'None specified'}
- Nice-to-have skills: ${job.nice_to_have?.join(', ') || 'None specified'}
- Job Description: ${(job.enhanced_jd || job.raw_jd).substring(0, 500)}

${candidateInfo ? `Candidate Context:
- Name: ${candidateInfo.name || 'Not provided'}
- Skills: ${candidateInfo.skills?.join(', ') || 'Not provided'}
` : ''}

Generate 3-5 engaging, relevant video screening questions that assess:
1. Technical skills and experience relevant to the role (especially fintech/payment systems)
2. Problem-solving approach and critical thinking
3. Communication abilities
4. Cultural fit for Indian fintech environment and motivation
5. Real-world application of skills in Indian market context

Question Guidelines:
- Include questions about Indian fintech/payment systems (UPI, digital payments, payment gateways) if relevant
- Consider Indian market experience and understanding
- Use Indian English conventions
- Be clear and specific
- Allow candidates to showcase their expertise
- Have an appropriate time limit (60-180 seconds)
- Be suitable for video response format

Return a JSON object with this structure:
{
  "screening_questions": [
    {"text": "Question 1 text (with Indian/fintech context if relevant)", "time_limit_sec": 120, "type": "video"},
    {"text": "Question 2 text", "time_limit_sec": 90, "type": "video"},
    {"text": "Question 3 text", "time_limit_sec": 150, "type": "video"}
  ]
}

Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for generating resume summary
 */
function buildResumeSummaryPrompt(payload) {
  const { resumeText } = payload;

  // Use more context for better accuracy
  const resumeContext = resumeText.substring(0, 12000);
  const isTruncated = resumeText.length > 12000;

  return `You are an expert HR analyst creating a brief summary of a candidate's resume based on their ACTUAL profile and work experience.

IMPORTANT: You MUST base your summary ONLY on the resume text provided below. Do NOT use generic templates or assumptions.

Resume Text (extracted from the candidate's actual resume):
${resumeContext}${isTruncated ? '\n\n[Note: Resume text truncated for length]' : ''}

Your task:
1. Read the resume text carefully
2. Identify the candidate's actual:
   - Years of experience (if mentioned)
   - Current/previous job titles and companies (if mentioned)
   - Specific technologies, programming languages, frameworks mentioned
   - Specific projects, achievements, or contributions mentioned
   - Education details (if mentioned)
   - Any certifications (if mentioned)
3. Create a concise, professional summary (2-3 sentences) that accurately reflects what is ACTUALLY in the resume

CRITICAL RULES:
- Use ONLY information that is explicitly stated in the resume text above
- Do NOT add generic phrases like "2+ years of experience" unless the resume explicitly states this
- Do NOT mention technologies unless they are explicitly listed in the resume
- Do NOT mention companies (like Paytm) unless they appear in the resume
- Do NOT use placeholder text or generic descriptions
- If the resume mentions specific projects, achievements, or roles, include them accurately
- If years of experience are not explicitly stated, do not guess or assume

Example of what NOT to do:
❌ "Software engineer with 2+ years of experience in full-stack development" (if resume doesn't explicitly state this)

Example of what TO do:
✅ "Software engineer with experience in React and Node.js, having worked on payment gateway integration projects" (only if these are actually mentioned in the resume)

Return a JSON object:
{
  "summary": "Accurate 2-3 sentence summary based EXACTLY on what is written in the resume text provided above"
}

Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for generating LinkedIn summary
 */
function buildLinkedInSummaryPrompt(payload) {
  const { linkedinUrl } = payload;

  return `Analyze a candidate's LinkedIn profile and provide a summary of their professional background and skills.

LinkedIn Profile:
${linkedinUrl ? `LinkedIn: ${linkedinUrl}` : 'No LinkedIn provided'}

Note: You cannot actually access this URL. Based on typical LinkedIn profiles, provide:
1. A summary of their professional background
2. Work experience and roles
3. Skills and expertise areas
4. Education and certifications
5. Notable achievements or endorsements

Return a JSON object:
{
  "summary": "Summary of the candidate's professional background, work experience, skills, and achievements based on their LinkedIn profile"
}

Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for extracting tags from resume text
 */
function buildResumeTagExtractionPrompt(payload) {
  const { resumeText } = payload;

  return `You are an expert HR analyst extracting relevant tags from a candidate's resume.

Resume Text:
${resumeText.substring(0, 8000)}${resumeText.length > 8000 ? '...' : ''}

Extract tags ONLY from what is explicitly mentioned in the resume. Do NOT add tags that are not present in the resume. Include:

1. **Programming Languages**: JavaScript, TypeScript, Python, Java, Go, etc.
2. **Frameworks & Libraries**: React, Node.js, Express, Django, Spring Boot, etc.
3. **Tools & Technologies**: Docker, Kubernetes, AWS, MongoDB, PostgreSQL, etc.
4. **Skills & Expertise**: Full Stack, Backend, Frontend, DevOps, Machine Learning, etc.
5. **Domain/Industry**: Fintech, Payment Systems, E-commerce, Banking, etc.
6. **Methodologies**: Agile, Scrum, TDD, CI/CD, etc.
7. **Certifications**: AWS Certified, Google Cloud, etc.
8. **Education**: Degree, University (if relevant)
9. **Other relevant technologies**: Git, REST API, GraphQL, Microservices, etc.

Extract tags ONLY from what is explicitly stated in the resume:
- Technologies explicitly mentioned in the resume
- Skills explicitly listed or mentioned
- Tools and platforms explicitly mentioned
- Programming languages explicitly mentioned
- Frameworks explicitly mentioned
- Certifications explicitly mentioned
- Education degrees if relevant to the role

IMPORTANT: Do NOT infer or add tags that are not explicitly mentioned in the resume. Only extract what is clearly stated.

Return a JSON object:
{
  "tags": ["tag1", "tag2", "tag3", ...],
  "categories": {
    "languages": ["JavaScript", "TypeScript", ...],
    "frameworks": ["React", "Node.js", ...],
    "tools": ["Docker", "AWS", ...],
    "skills": ["Full Stack", "Backend", ...],
    "domain": ["Fintech", "Payment Systems"],
    "certifications": ["AWS Certified", ...]
  }
}

Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for checking criteria fulfillment in text
 */
function buildCriteriaCheckPrompt(payload) {
  const { text } = payload;

  return `You are an expert HR analyst checking if specific criteria are fulfilled in a given text.

Text to analyze:
${text}

Check if the following 5 criteria are present in the text:
1. **Location**: Does the text mention a specific location, city, or geographic area? (e.g., "Noida", "Delhi", "Remote", "Bangalore", "Mumbai")
2. **Job Title**: Does the text mention a specific job title or role? (e.g., "Software Engineer", "Product Manager", "Data Scientist", "Full Stack Developer")
3. **Years of Experience**: Does the text mention years of experience, experience level, or seniority? (e.g., "2+ years", "5 years experience", "Senior", "Mid-level", "Entry level")
4. **Industry**: Does the text mention a specific industry, domain, or sector? (e.g., "Fintech", "E-commerce", "Healthcare", "Banking", "SaaS")
5. **Skills**: Does the text mention specific technical skills, technologies, or competencies? (e.g., "React", "Python", "AWS", "Machine Learning", "Node.js", "MongoDB")

IMPORTANT:
- Be strict: Only mark containsCriteria as true if the criterion is EXPLICITLY mentioned in the text
- Do NOT infer or assume - if it's not clearly stated, mark it as false
- For "Location": Accept cities, states, countries, or location types (remote, on-site, hybrid)
- For "Job Title": Accept role names, position titles, or job designations
- For "Years of Experience": Accept explicit numbers, ranges, or experience level descriptors
- For "Industry": Accept industry names, sectors, or domain mentions
- For "Skills": Accept technology names, programming languages, tools, frameworks, or specific competencies

Return a JSON array with exactly this structure:
[
  {
    "label": "Location",
    "containsCriteria": true or false
  },
  {
    "label": "Job Title",
    "containsCriteria": true or false
  },
  {
    "label": "Years of Experience",
    "containsCriteria": true or false
  },
  {
    "label": "Industry",
    "containsCriteria": true or false
  },
  {
    "label": "Skills",
    "containsCriteria": true or false
  }
]

Return ONLY valid JSON array, no additional text.`;

}

/**
 * Build prompt for extracting candidate search criteria from natural language
 */
function buildCandidateSearchPrompt(payload) {
  const { searchQuery } = payload;

  return `You are an expert recruiter helping to search for candidates in a candidate database.

The candidate database has the following fields in MongoDB:
- name: string (candidate's full name)
- email: string (candidate's email address)
- phone: string (candidate's phone number)
- tags: array of strings (skills, technologies, frameworks, tools, languages - e.g., ["React", "Node.js", "Python", "AWS"])
- resumeText: string (full text content of the candidate's resume)
- githubUrl: string (candidate's GitHub profile URL)
- portfolioUrl: string (candidate's portfolio website URL)
- linkedinUrl: string (candidate's LinkedIn profile URL)
- compensationExpectation: string (candidate's expected compensation in INR)
- isHired: boolean (whether the candidate has been hired)
- createdAt: date (when the candidate was added to the system)
- updatedAt: date (when the candidate was last updated)

User's search query:
"${searchQuery}"

Your task is to extract structured search criteria from the user's natural language query and create MongoDB query operators.

IMPORTANT RULES:
1. For skills/technologies, use the "tags" field with $in operator (match ANY of the tags)
2. For text search in resume content, use "resumeText" field with $regex operator (case-insensitive)
3. For name search, use "name" field with $regex operator (case-insensitive)
4. For email search, use "email" field with $regex operator (case-insensitive)
5. For experience-related queries, search in "resumeText" using $regex
6. For location-based queries, search in "resumeText" using $regex
7. For compensation, use "compensationExpectation" field with $regex
8. For hired status, use "isHired" field with boolean value
9. For date ranges, use "createdAt" or "updatedAt" with $gte or $lte operators

MongoDB Query Operators you can use:
- $in: for array fields like tags
- $regex: for text search (use with $options: 'i' for case-insensitive)
- $gte, $lte, $gt, $lt: for date and number comparisons
- $and, $or: for combining multiple conditions
- $eq: for exact matches

Examples of what you should extract:

Query: "Find React developers with Node.js experience"
→ Extract: tags: ["React", "Node.js"]

Query: "Senior software engineers in Bangalore"
→ Extract: resumeText search for "senior" AND "bangalore", tags: ["Software Engineer"]

Query: "Python developers with 5+ years experience"
→ Extract: tags: ["Python"], resumeText search for "5 years" or "5+ years"

Query: "Full stack developers who know React and MongoDB"
→ Extract: tags: ["React", "MongoDB", "Full Stack"]

Query: "Candidates with GitHub profiles"
→ Extract: githubUrl exists (not null/empty)

Query: "Find candidates added in the last 30 days"
→ Extract: createdAt >= (current date - 30 days)

Query: "Unhired candidates with React experience"
→ Extract: isHired: false, tags: ["React"]

Query: "Find John Doe"
→ Extract: name search for "John Doe"

Return a JSON object with this structure:
{
  "searchCriteria": {
    "tags": ["tag1", "tag2", ...],  // Technologies/skills to search in tags array (optional)
    "resumeKeywords": ["keyword1", "keyword2", ...],  // Keywords to search in resume text (optional)
    "nameQuery": "search term",  // Name to search (optional)
    "emailQuery": "search term",  // Email to search (optional)
    "compensationQuery": "search term",  // Compensation keywords (optional)
    "isHired": true/false,  // Hired status filter (optional)
    "githubRequired": true/false,  // Whether GitHub URL is required (optional)
    "portfolioRequired": true/false,  // Whether portfolio URL is required (optional)
    "linkedinRequired": true/false,  // Whether LinkedIn URL is required (optional)
    "dateFilter": {  // Date range filter (optional)
      "field": "createdAt" or "updatedAt",
      "operator": "$gte" or "$lte" or "$gt" or "$lt",
      "value": "ISO date string"
    }
  },
  "explanation": "Brief explanation of what you're searching for based on the query"
}

IMPORTANT:
- Only include fields that are relevant to the search query
- Extract as many relevant search criteria as possible
- Be smart about synonyms: "developer" = "engineer", "programmer", "coder"
- For skills, extract both explicit and implicit skills mentioned
- If no clear criteria can be extracted, return empty searchCriteria object

Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for extracting tags from job description
 */
function buildTagExtractionPrompt(payload) {
  const { job } = payload;

  return `You are an expert HR analyst extracting relevant tags from a job description for Paytm (Indian fintech company).

Job Description:
- Role: ${job.role}
- Company: ${job.company_name || 'Paytm'}
- Team: ${job.team || 'Not specified'}
- Seniority: ${job.seniority || 'Not specified'}
- Location: ${job.location || 'Noida, Delhi NCR, India'}
- Job Type: ${job.job_type || 'Full-time'}
- Must-have skills: ${job.must_have_skills?.join(', ') || 'None specified'}
- Nice-to-have skills: ${job.nice_to_have?.join(', ') || 'None specified'}
- Job Description Text:
${job.enhanced_jd || job.raw_jd}

Extract comprehensive tags from this job description. Include:

1. **Programming Languages**: JavaScript, TypeScript, Python, Java, Go, etc.
2. **Frameworks & Libraries**: React, Node.js, Express, Django, Spring Boot, etc.
3. **Tools & Technologies**: Docker, Kubernetes, AWS, MongoDB, PostgreSQL, etc.
4. **Skills & Expertise**: Full Stack, Backend, Frontend, DevOps, Machine Learning, etc.
5. **Job Type**: Full-time, Remote, Hybrid, On-site
6. **Location**: Noida, Delhi NCR, Bangalore, Mumbai, etc.
7. **Domain/Industry**: Fintech, Payment Systems, Digital Payments, Banking, etc.
8. **Methodologies**: Agile, Scrum, TDD, CI/CD, etc.
9. **Other relevant technologies**: Git, REST API, GraphQL, Microservices, etc.

Extract ALL relevant tags from the job description. Be thorough and include:
- Technologies mentioned explicitly
- Technologies implied by the role/skills
- Industry/domain terms
- Location information
- Job type and work arrangement

Return a JSON object:
{
  "tags": ["tag1", "tag2", "tag3", ...],
  "categories": {
    "languages": ["JavaScript", "TypeScript", ...],
    "frameworks": ["React", "Node.js", ...],
    "tools": ["Docker", "AWS", ...],
    "skills": ["Full Stack", "Backend", ...],
    "location": ["Noida", "Delhi NCR"],
    "job_type": ["Full-time"],
    "domain": ["Fintech", "Payment Systems"]
  }
}

Return ONLY valid JSON, no additional text.`;
}

/**
 * Build prompt for video scoring
 */
function buildVideoScoringPrompt(payload) {
  const { transcript, screening_questions } = payload;

  return `You are an expert interviewer evaluating a candidate's video interview responses for Paytm (Indian fintech company).

Context:
- Company: Paytm (Indian fintech, Noida-based)
- Consider Indian market context, fintech industry knowledge, and cultural fit
- Evaluate understanding of Indian payment systems and digital finance

Screening Questions:
${screening_questions?.map((q, i) => `${i + 1}. ${q.text}`).join('\n') || 'No questions provided'}

Candidate Transcript:
${transcript}

Evaluate each question response considering:
- Technical depth and relevance to Indian fintech market
- Understanding of Indian payment systems (UPI, digital wallets, etc.)
- Communication skills appropriate for Indian corporate environment
- Cultural fit for Indian work culture

Provide an overall assessment. Return a JSON object:
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
  // JD_ENHANCER, EMAIL_GENERATOR, SCREENING_QUESTIONS, TAG_EXTRACTION
  return MODEL_CONFIG.STANDARD;
}

/**
 * Main LLM function - routes to appropriate prompt builder and calls the configured LLM provider (Bedrock or OpenAI)
 * Automatically selects the best model for each task type
 */
export async function callLLM(promptName, payload) {
  const selectedModel = getModelForTask(promptName);
  console.log(`[LLM] Calling ${promptName} with ${LLM_PROVIDER.toUpperCase()} model: ${selectedModel}`);

  let prompt;
  let systemPrompt = 'You are a helpful AI assistant specialized in Indian HR and recruitment. Always return valid JSON as requested. Do not include any text before or after the JSON.\n\nIMPORTANT CONTEXT:\n- Company: Paytm (Indian fintech company)\n- Location: India (primarily Noida, Delhi NCR)\n- Currency: Always use INR (₹) - Indian Rupees\n- Compensation format: Use Indian format (e.g., ₹25,00,000 per annum or 25 LPA)\n- Names: Use Indian names (e.g., Rahul Sharma, Priya Patel, Amit Kumar)\n- Phone format: +91-XXXXXXXXXX\n- Cultural context: Indian work culture, fintech industry, payment systems\n- Language: Use Indian English conventions';
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

    case 'TAG_EXTRACTION':
      prompt = buildTagExtractionPrompt(payload);
      temperature = 0.5; // Moderate temperature for balanced extraction
      break;

    case 'RESUME_TAG_EXTRACTION':
      prompt = buildResumeTagExtractionPrompt(payload);
      temperature = 0.5; // Moderate temperature for balanced extraction
      break;

    case 'RESUME_SUMMARY':
      prompt = buildResumeSummaryPrompt(payload);
      temperature = 0.6; // Slightly creative for summary generation
      break;

    case 'LINKEDIN_SUMMARY':
      prompt = buildLinkedInSummaryPrompt(payload);
      temperature = 0.6; // Slightly creative for summary generation
      break;

    case 'CRITERIA_CHECK':
      prompt = buildCriteriaCheckPrompt(payload);
      temperature = 0.3; // Lower temperature for consistent, objective checking
      break;

    case 'CANDIDATE_SEARCH':
      prompt = buildCandidateSearchPrompt(payload);
      temperature = 0.4; // Lower temperature for more precise, consistent extraction
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
