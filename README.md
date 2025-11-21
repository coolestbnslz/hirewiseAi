# HireWise Backend

A complete Node.js + Express backend for HR job posting with JD enhancement and candidate screening pipeline. Supports resume scoring, multi-level candidate evaluation (resume, GitHub/portfolio, compensation), and automated video screening workflows.

## Features

- **HR Job Posting**: Create jobs with automatic JD enhancement using LLM
- **Automatic Candidate Matching**: When a job is posted, automatically match it against existing candidates based on tags and skills
- **Candidate Application**: Resume upload with automatic scoring (resume, GitHub/portfolio, compensation)
- **Unified Scoring**: Weighted scoring system combining multiple evaluation criteria
- **User Management**: Store candidate information, resumes, and tags for future job matching
- **Hired Status Tracking**: Mark candidates as hired to exclude them from future matches
- **Automated Screening**: Auto-create video/phone screenings based on score thresholds
- **Phone Interviews**: AI-powered phone interviews via Bland AI (technical and behavioral questions)
- **Video Processing**: STT transcription and video scoring
- **Email Automation**: Auto-send video invites when applications are approved

## Tech Stack

- Node.js with ES Modules
- Express.js
- MongoDB with Mongoose
- Multer for file uploads
- Amazon Bedrock (Claude 3 Sonnet) for LLM functionality

## Prerequisites

- Node.js (v18 or higher)
- MongoDB (local or cloud instance)
- AWS Account with Bedrock access
- AWS credentials (Access Key ID and Secret Access Key)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd hirewiseAi
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Then edit `.env` and update with your actual values:
```
PORT=3000
MONGODB_URI=mongodb://localhost:27017/hirewise

# AWS Bedrock Configuration (using Converse API with Bearer token)
AWS_REGION=us-east-1
AWS_BEARER_TOKEN_BEDROCK=your_bearer_token
BEDROCK_MODEL_ID=us.anthropic.claude-3-5-haiku-20241022-v1:0
BEDROCK_EMBEDDING_MODEL_ID=amazon.titan-embed-text-v1

# SMTP Email Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=your_email@gmail.com
SMTP_PASSWORD=your_app_password
SMTP_FROM_EMAIL=your_email@gmail.com
SMTP_FROM_NAME=HireWise Team

# GitHub API Configuration (optional but recommended)
GITHUB_TOKEN=your_github_personal_access_token

# AWS S3 Configuration (for resume storage)
AWS_S3_BUCKET_NAME=your-s3-bucket-name
AWS_S3_REGION=us-west-2  # Optional: S3 bucket region (defaults to AWS_REGION if not set)
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
# Note: If S3 is not configured, resumes will be stored locally in tmp_uploads directory
# Note: AWS_S3_REGION can be different from AWS_REGION (used for Bedrock)

# Bland AI Configuration (for phone interviews)
BLAND_API_KEY=your_bland_ai_api_key
WEBHOOK_BASE_URL=https://yourdomain.com  # Base URL for webhooks (optional)
```

**Configuration Notes:**

1. **MongoDB**: Update `MONGODB_URI` with your MongoDB connection string
2. **AWS Bedrock**: 
   - Create an AWS account if you don't have one
   - Enable Bedrock access (request access to Claude models and Titan Embeddings)
   - Create a Bearer token in AWS Console → Amazon Bedrock → API Keys
   - Set `AWS_BEARER_TOKEN_BEDROCK` in your `.env` file
3. **Email (SMTP)**: 
   - For Gmail: Enable 2FA and generate an App Password
   - Set `SMTP_USERNAME` and `SMTP_PASSWORD`
   - Update `SMTP_FROM_EMAIL` and `SMTP_FROM_NAME`
   - If not configured, the system will work but emails won't be sent
4. **GitHub API (Optional but Recommended)**:
   - Create a GitHub Personal Access Token (PAT) with `public_repo` scope
   - Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Generate a new token with `public_repo` permission
   - Set `GITHUB_TOKEN` in your `.env` file
   - Without a token, GitHub API requests are rate-limited to 60 requests/hour
   - With a token, you get 5,000 requests/hour
5. **AWS S3 (Optional but Recommended for Production)**:
   - Create an S3 bucket in your AWS account
   - Create an IAM user with S3 read/write permissions for the bucket
   - Generate Access Key ID and Secret Access Key for the IAM user
   - Set `AWS_S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` in your `.env` file
   - **Important**: If your S3 bucket is in a different region than your Bedrock service, set `AWS_S3_REGION` (e.g., `AWS_S3_REGION=us-west-2`)
   - If `AWS_S3_REGION` is not set, it will default to `AWS_REGION` (used for Bedrock)
   - If S3 is not configured, resumes will be stored locally in `tmp_uploads` directory
   - **Note**: For public access to resumes, you may need to configure bucket policies or use signed URLs

5. Start MongoDB (if running locally):
```bash
# macOS with Homebrew
brew services start mongodb-community

# Or use Docker
docker run -d -p 27017:27017 --name mongodb mongo
```

5. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

The server will start on `http://localhost:3000`

## API Endpoints

### Health Check
```bash
curl http://localhost:3000/health
```

### 1. Create Job (POST /api/jobs)

Create a new job posting. The system will automatically enhance the JD and add static screening questions.

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "raw_jd": "We are looking for a Node.js developer with experience in Express and MongoDB.",
    "company_name": "TechCorp",
    "role": "Backend Developer",
    "seniority": "Mid-level",
    "budget_info": "$100k-$120k",
    "must_have_skills": ["Node.js", "Express", "MongoDB"],
    "nice_to_have": ["AWS", "Docker"]
  }'
```

Response includes `_id` (jobId) for use in other endpoints.

### 2. Get Job (GET /api/jobs/:id)

```bash
curl http://localhost:3000/api/jobs/<jobId>
```

### 3. Update Job Settings (PATCH /api/jobs/:id/settings)

Configure auto-invite and threshold settings.

```bash
curl -X PATCH http://localhost:3000/api/jobs/<jobId>/settings \
  -H "Content-Type: application/json" \
  -d '{
    "autoInviteOnLevel1Approval": true,
    "autoInviteThreshold": 70,
    "autoCreateScreeningThreshold": 60
  }'
```

### 4. Get Matched Candidates for Job (GET /api/jobs/:id/matches)

When a job is created, the system automatically matches it against all existing candidates (who are not hired) based on tags and skills. Get the matched candidates:

```bash
# Get all matches
curl http://localhost:3000/api/jobs/<jobId>/matches

# Get matches with minimum score
curl http://localhost:3000/api/jobs/<jobId>/matches?minScore=70

# Get top 20 matches
curl http://localhost:3000/api/jobs/<jobId>/matches?limit=20

# Get matches by status
curl http://localhost:3000/api/jobs/<jobId>/matches?status=pending
```

### 5. Manually Trigger Candidate Matching (POST /api/jobs/:id/match-candidates)

Manually trigger matching for a job (useful if you want to re-match after updating job tags):

```bash
curl -X POST http://localhost:3000/api/jobs/<jobId>/match-candidates
```

### 6. Apply to Job (POST /api/apply/:jobId)

Upload resume and apply to a job. The system will:
- Create/update user profile
- Score resume, GitHub/portfolio, and compensation
- Calculate unified score
- Auto-create screening if threshold is met

```bash
curl -X POST http://localhost:3000/api/apply/<jobId> \
  -F "resume=@/path/to/resume.pdf" \
  -F "applicant_email=john@example.com" \
  -F "applicant_name=John Doe" \
  -F "applicant_phone=+1234567890" \
  -F "githubUrl=https://github.com/johndoe" \
  -F "portfolioUrl=https://johndoe.dev" \
  -F "compensationExpectation=$110k"
```

Response includes `applicationId`, `unifiedScore`, `scores`, and `screeningId` (if created).

### 7. Give Consent (POST /api/applications/:id/consent)

Mark that the candidate has given consent for video screening.

```bash
curl -X POST http://localhost:3000/api/applications/<applicationId>/consent
```

### 8. Approve Application Level 1 (POST /api/applications/:id/approve-level1)

Approve the application. If auto-invite is enabled and score meets threshold:
- A phone interview call will be automatically initiated via Bland AI (if candidate has phone number)
- An email will be automatically sent (if configured)

```bash
curl -X POST http://localhost:3000/api/applications/<applicationId>/approve-level1
```

Response includes `phoneCallInitiated` and `emailSent` flags.

### 9. Get Screening Questions (GET /api/screenings/:id/questions)

Get screening questions for a candidate. Questions are generated on the spot using LLM based on job requirements and candidate profile. If questions already exist, they are returned. Otherwise, new questions are generated and stored.

```bash
curl http://localhost:3000/api/screenings/<screeningId>/questions
```

Response includes questions with text, time_limit_sec, and type for each question.

### 10. Upload Video (POST /api/screenings/:id/upload-video)

Store video URL for a screening. Questions are automatically generated on the spot if not already set. You can also provide questions in the request body.

```bash
# Upload video (questions auto-generated if not set)
curl -X POST http://localhost:3000/api/screenings/<screeningId>/upload-video \
  -H "Content-Type: application/json" \
  -d '{
    "videoUrl": "https://example.com/video.mp4"
  }'

# Upload video with specific questions
curl -X POST http://localhost:3000/api/screenings/<screeningId>/upload-video \
  -H "Content-Type: application/json" \
  -d '{
    "videoUrl": "https://example.com/video.mp4",
    "questions": [
      {"text": "Tell us about yourself", "time_limit_sec": 120, "type": "video"},
      {"text": "Why are you interested in this role?", "time_limit_sec": 90, "type": "video"}
    ]
  }'
```

**Note:** Questions are generated on the spot using Amazon Bedrock LLM, personalized based on:
- Job requirements (role, skills, description)
- Candidate profile (if available from application)
- Resume analysis results

### 11. Process Video (POST /api/screenings/:id/process)

Transcribe video and score it using the questions that were set at upload time.

```bash
curl -X POST http://localhost:3000/api/screenings/<screeningId>/process
```

### 11a. Initiate Phone Interview (POST /api/screenings/:id/initiate-phone-call)

Manually initiate a phone interview call via Bland AI. The call will ask only technical and behavioral questions (no notice period, compensation, etc.).

```bash
curl -X POST http://localhost:3000/api/screenings/<screeningId>/initiate-phone-call
```

**Note:** This endpoint is automatically called when HR approves a candidate (if auto-invite is enabled), but can also be called manually.

### 11b. Get Phone Call Status (GET /api/screenings/:id/phone-call-status)

Get the current status of a phone interview call, including transcript, summary, and analysis.

```bash
curl http://localhost:3000/api/screenings/<screeningId>/phone-call-status
```

Response includes:
- `phoneInterview.status`: Current call status (initiated, ringing, in_progress, completed, failed, no_answer)
- `phoneInterview.recordingUrl`: URL to call recording (if available)
- `phoneInterview.transcript`: Full call transcript
- `phoneInterview.summary`: AI-generated summary of the call
- `phoneInterview.analysis`: Structured analysis with technical skills, behavioral traits, communication quality, overall fit, strengths, and concerns

### 11c. Get Call Recording (GET /api/screenings/:id/recording)

Get the call recording URL. This endpoint fetches the recording URL from Bland AI if not already stored.

```bash
curl http://localhost:3000/api/screenings/<screeningId>/recording
```

Response includes:
- `recordingUrl`: Direct URL to the call recording (available when call is completed)
- `status`: Current call status
- `message`: Status message if recording is not yet available

### 12. Get User (GET /api/users/:id)

```bash
curl http://localhost:3000/api/users/<userId>
```

### 13. Update User (PATCH /api/users/:id)

Update user information, including marking as hired:

```bash
curl -X PATCH http://localhost:3000/api/users/<userId> \
  -H "Content-Type: application/json" \
  -d '{
    "githubUrl": "https://github.com/johndoe",
    "portfolioUrl": "https://johndoe.dev",
    "compensationExpectation": "$115k",
    "isHired": true
  }'
```

## Debug Endpoints

For development and testing, use these endpoints to view all data:

```bash
# Get all jobs
curl http://localhost:3000/debug/jobs

# Get all applications
curl http://localhost:3000/debug/applications

# Get all screenings
curl http://localhost:3000/debug/screenings

# Get all users
curl http://localhost:3000/debug/users

# Get all job-candidate matches
curl http://localhost:3000/debug/matches
```

## Scoring System

### Application Scoring

The unified score for applications is calculated as a weighted average:
- **Resume Score**: 50% weight
- **GitHub/Portfolio Score**: 30% weight
- **Compensation Score**: 20% weight

Each score ranges from 0-100.

### Job-Candidate Matching Scoring

When a job is posted, candidates are automatically matched and scored:
- **Tag Match Score**: 40% weight - Based on matching tags between job and candidate
- **Skills Match Score**: 60% weight - Based on LLM analysis of resume against job requirements

The system only matches candidates who:
- Are not marked as hired (`isHired: false`)
- Have a resume on file (`resumeText` exists)

Matches are stored in the `JobCandidateMatch` collection with status tracking (pending, contacted, interested, not_interested, applied).

## Testing

Run tests:
```bash
npm test
```

Run tests in watch mode:
```bash
npm run test:watch
```

## LLM Integration

The system supports **two LLM providers**:

1. **AWS Bedrock** (default) - Supports Claude, Titan, AI21, Cohere, Llama models
2. **OpenAI** - Supports GPT-4o, GPT-4, GPT-3.5 models

**Embeddings** use **Amazon Titan Embeddings** (via Bedrock) for semantic tag matching.

- **JD Enhancement**: Enhances job descriptions with form fields
- **Tag Extraction**: Uses **Titan Embeddings** to extract relevant tags from job descriptions and resumes using semantic similarity
- **Resume Scoring**: Analyzes resumes against job requirements
- **GitHub/Portfolio Scoring**: Evaluates candidate profiles
- **Compensation Analysis**: Matches candidate expectations with job budget
- **Email Generation**: Creates personalized invitation emails
- **Video Scoring**: Evaluates video interview responses
- **Screening Questions**: Generated dynamically on-the-spot when candidates access screening links

### Option 1: Using AWS Bedrock (Default)

1. **Enable Bedrock Access:**
   - Go to AWS Console → Amazon Bedrock
   - Request access to Claude models (Claude 3 Sonnet, Opus, Haiku)
   - Request access to Titan Embeddings model
   - Wait for approval (usually instant for most accounts)

2. **Create IAM User:**
   - Create an IAM user with `AmazonBedrockFullAccess` policy
   - Or create a custom policy with Bedrock permissions
   - Create Access Key ID and Secret Access Key

3. **Get Bearer Token:**
   - Go to AWS Console → Amazon Bedrock → API Keys
   - Create a new API key (Bearer token)
   - Copy the token (you won't be able to see it again)

4. **Configure Environment Variables:**
   ```bash
   LLM_PROVIDER=bedrock
   AWS_REGION=us-east-1
   AWS_BEARER_TOKEN_BEDROCK=your_bearer_token
   BEDROCK_MODEL_ID=us.anthropic.claude-3-5-haiku-20241022-v1:0
   ```

**Note:** The Converse API uses Bearer token authentication, which is simpler than AWS Signature V4. You can also use model IDs like:
- `us.anthropic.claude-3-5-haiku-20241022-v1:0` (Claude 3.5 Haiku)
- `us.anthropic.claude-3-5-sonnet-20241022-v1:0` (Claude 3.5 Sonnet)
- `us.anthropic.claude-3-opus-20240229-v1:0` (Claude 3 Opus)

### Option 2: Using OpenAI (GPT-4o, GPT-4, etc.)

1. **Get OpenAI API Key:**
   - Go to https://platform.openai.com/api-keys
   - Sign up or log in to your OpenAI account
   - Create a new API key
   - Copy the key (you won't be able to see it again)

2. **Configure Environment Variables:**
   ```bash
   LLM_PROVIDER=openai
   OPENAI_API_KEY=your_openai_api_key
   LLM_MODEL_ID=gpt-4o
   LLM_MODEL_CRITICAL=gpt-4o
   LLM_MODEL_STANDARD=gpt-4o
   LLM_MODEL_FAST=gpt-4o-mini
   ```

**Available OpenAI Models:**
- `gpt-4o` - Latest GPT-4o model (recommended, best quality)
- `gpt-4o-mini` - Faster, cheaper version (good for simple tasks)
- `gpt-4-turbo` - GPT-4 Turbo (high quality)
- `gpt-3.5-turbo` - GPT-3.5 Turbo (cheapest option)

### Embeddings Model (Tag Extraction)

The system uses **Amazon Titan Embeddings** for semantic tag matching:
- **Model**: `amazon.titan-embed-text-v1` (default)
- **Purpose**: Extract relevant tags from job descriptions and resumes using semantic similarity
- **Configuration**: Set `BEDROCK_EMBEDDING_MODEL_ID` in `.env` to use a different embedding model

**How it works:**
1. Job description/resume text is converted to embeddings
2. Embeddings are compared against a database of common tech tags
3. Tags with highest cosine similarity are selected
4. Provides more accurate matching than keyword-based approaches

### Model Selection Strategy

The system **automatically selects the best model** for each task based on requirements:

**Critical Tasks (Claude 3 Opus)** - Highest accuracy for important decisions:
- `RESUME_SCORING` - Accurate resume evaluation is crucial for hiring decisions
- `VIDEO_SCORING` - Fair and thorough video interview evaluation

**Standard Tasks (Claude 3 Sonnet)** - Good balance of quality and cost:
- `JD_ENHANCER` - Job description enhancement
- `EMAIL_GENERATOR` - Personalized email generation
- `SCREENING_QUESTIONS` - Dynamic question generation

**Fast Tasks (Claude 3 Haiku)** - Speed and cost efficiency:
- `GITHUB_PORTFOLIO_SCORING` - Simple profile evaluation
- `COMPENSATION_ANALYSIS` - Straightforward analysis

### Customizing Model Selection

You can override model selection in `.env`:

```bash
# Use Opus for all critical tasks (highest quality)
BEDROCK_MODEL_CRITICAL=anthropic.claude-3-opus-20240229-v1:0

# Use Sonnet for standard tasks (balanced)
BEDROCK_MODEL_STANDARD=anthropic.claude-3-sonnet-20240229-v1:0

# Use Haiku for fast tasks (cost-effective)
BEDROCK_MODEL_FAST=anthropic.claude-3-haiku-20240307-v1:0

# Fallback default (if above not set)
BEDROCK_MODEL_ID=anthropic.claude-3-sonnet-20240229-v1:0
```

### Model Comparison

**AWS Bedrock Models:**
| Model | Best For | Speed | Cost | Quality | Use Cases |
|-------|----------|-------|------|---------|-----------|
| **Claude 3 Opus** | Critical decisions, complex analysis | Slowest | Highest | Highest | Resume scoring, video scoring |
| **Claude 3 Sonnet** | General tasks, balanced needs | Medium | Medium | High | JD enhancement, emails, questions |
| **Claude 3 Haiku** | Simple tasks, high volume | Fastest | Lowest | Good | Compensation, portfolio scoring |

**OpenAI Models:**
| Model | Best For | Speed | Cost | Quality | Use Cases |
|-------|----------|-------|------|---------|-----------|
| **GPT-4o** | All tasks, best quality | Fast | Medium | Highest | All use cases (recommended) |
| **GPT-4o-mini** | Fast tasks, cost-effective | Fastest | Lowest | High | Compensation, portfolio scoring |
| **GPT-4 Turbo** | Complex tasks | Medium | High | Highest | Resume scoring, video scoring |
| **GPT-3.5 Turbo** | Simple tasks | Fastest | Lowest | Good | Basic tasks |

**Recommendation for Production:**

**With AWS Bedrock:**
- ✅ Use **Claude 3 Opus** for resume and video scoring (critical hiring decisions)
- ✅ Use **Claude 3 Sonnet** for most other tasks (good balance)
- ✅ Use **Claude 3 Haiku** for simple analyses (cost savings)

**With OpenAI:**
- ✅ Use **GPT-4o** for all tasks (excellent quality, fast, cost-effective)
- ✅ Use **GPT-4o-mini** for simple/fast tasks (cost savings)
- ✅ Use **GPT-4 Turbo** if you need maximum quality for critical tasks

This strategy optimizes for both **quality** (where it matters) and **cost** (where speed is sufficient).

### STT Service

Replace `src/lib/stt.js` with actual STT service:

**AWS Transcribe Example:**
```javascript
import { TranscribeClient, StartTranscriptionJobCommand } from '@aws-sdk/client-transcribe';

export async function transcribeVideo(videoUrl) {
  const client = new TranscribeClient({ region: 'us-east-1' });
  // Implementation here
}
```

**Google Speech-to-Text Example:**
```javascript
import speech from '@google-cloud/speech';

export async function transcribeVideo(videoUrl) {
  const client = new speech.SpeechClient();
  // Implementation here
}
```

### Email Service (SMTP)

The system uses **Nodemailer with SMTP** for sending emails. Configure your SMTP settings in `.env`:

#### Gmail Setup

1. **Enable 2-Factor Authentication** on your Gmail account
2. **Generate App Password**:
   - Go to Google Account → Security → 2-Step Verification → App passwords
   - Generate a password for "Mail"
3. **Configure `.env`**:
   ```bash
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USERNAME=your_email@gmail.com
   SMTP_PASSWORD=your_16_char_app_password
   SMTP_FROM_EMAIL=your_email@gmail.com
   SMTP_FROM_NAME=HireWise Team
   ```

#### Outlook/Office 365 Setup

```bash
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=your_email@outlook.com
SMTP_PASSWORD=your_password
SMTP_FROM_EMAIL=your_email@outlook.com
SMTP_FROM_NAME=HireWise Team
```

#### Custom SMTP Server

```bash
SMTP_HOST=smtp.yourdomain.com
SMTP_PORT=587
SMTP_SECURE=false  # or true for port 465
SMTP_USERNAME=your_username
SMTP_PASSWORD=your_password
SMTP_FROM_EMAIL=noreply@yourdomain.com
SMTP_FROM_NAME=HireWise Team
```

#### Other Email Providers

**SendGrid SMTP:**
```bash
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USERNAME=apikey
SMTP_PASSWORD=your_sendgrid_api_key
```

**Mailgun SMTP:**
```bash
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USERNAME=your_mailgun_username
SMTP_PASSWORD=your_mailgun_password
```

**Note:** If SMTP credentials are not configured, the system will log warnings but continue to function (emails won't be sent).

## Privacy & Consent

- Candidates must explicitly give consent before video invites are sent
- All personal data is stored securely in MongoDB
- Resume files are stored locally in `tmp_uploads/` directory
- In production, implement proper file storage (S3, Cloud Storage, etc.)
- Ensure compliance with GDPR, CCPA, and other privacy regulations
- Implement proper authentication and authorization for production use

## Project Structure

```
hirewiseAi/
├── src/
│   ├── server.js              # Express app entry point
│   ├── routes/                # API route handlers
│   ├── models/                # MongoDB models
│   ├── lib/                   # Utility libraries (LLM, STT, email, etc.)
│   ├── config/                # Configuration files
│   └── middleware/            # Express middleware
├── tests/                     # Jest test files
├── tmp_uploads/               # Uploaded files (gitignored)
└── package.json
```

## License

ISC

