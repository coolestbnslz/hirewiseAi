import mongoose from 'mongoose';

const applicationSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  resumePath: {
    type: String,
  },
  resumeText: {
    type: String,
  },
  scores: {
    resumeScore: {
      type: Number,
      min: 0,
      max: 100,
    },
    githubPortfolioScore: {
      type: Number,
      min: 0,
      max: 100,
    },
    compensationScore: {
      type: Number,
      min: 0,
      max: 100,
    },
    compensationAnalysis: {
      type: String,
    },
  },
  unifiedScore: {
    type: Number,
    min: 0,
    max: 100,
  },
  rawResumeLLM: {
    type: String,
  },
  // Extracted resume scoring details
  skillsMatched: [{
    type: String,
  }],
  skillsMissing: [{
    type: String,
  }],
  topReasons: [{
    type: String,
  }],
  recommendedAction: {
    type: String,
    enum: ['yes', 'maybe', 'no'],
  },
  consent_given: {
    type: Boolean,
    default: false,
  },
  level1_approved: {
    type: Boolean,
    default: false,
  },
  // Rejection status
  rejected: {
    type: Boolean,
    default: false,
  },
  rejectedAt: {
    type: Date,
  },
  rejectionReason: {
    type: String,
    trim: true,
  },
  // Link to JobCandidateMatch if this application came from a match
  matchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JobCandidateMatch',
  },
  // Phone interview via Bland AI (stored in Application)
  phoneInterview: {
    callId: String, // Bland AI call ID
    status: {
      type: String,
      enum: ['not_initiated', 'initiated', 'scheduled', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer'],
      default: 'not_initiated',
    },
    phoneNumber: String,
    startedAt: Date,
    scheduledStartTime: String, // Scheduled start time in format "YYYY-MM-DD HH:MM:SS -HH:MM"
    completedAt: Date,
    duration: Number, // Duration in seconds
    recordingUrl: String,
    transcript: String,
    summary: String,
    analysis: {
      technical_skills: [String],
      behavioral_traits: [String],
      communication_quality: Number,
      overall_fit: Number,
      strengths: [String],
      concerns: [String],
    },
    error: String,
  },
}, {
  timestamps: true,
});

export default mongoose.model('Application', applicationSchema);

