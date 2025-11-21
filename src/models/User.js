import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  resumePath: {
    type: String, // Can be S3 URL or local path (for backward compatibility)
  },
  resumeS3Url: {
    type: String, // S3 URL for the resume
  },
  resumeText: {
    type: String,
  },
  tags: [{
    type: String,
  }],
  githubUrl: {
    type: String,
    trim: true,
  },
  portfolioUrl: {
    type: String,
    trim: true,
  },
  linkedinUrl: {
    type: String,
    trim: true,
  },
  compensationExpectation: {
    type: String,
  },
  isHired: {
    type: Boolean,
    default: false,
  },
  hiredAt: {
    type: Date,
  },
  parsedResume: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  resumeSummary: {
    type: String,
  },
  currentTenure: {
    type: String, // e.g., "2 years 3 months", "1.5 years"
  },
  totalExperience: {
    type: String, // e.g., "5 years", "3.5 years"
  },
  isRecentSwitcher: {
    type: Boolean,
    default: false,
  },
  currentCompany: {
    type: String,
  },
  lastJobSwitchDate: {
    type: String, // YYYY-MM format
  },
  // Phone interview summaries (for users without applications, e.g., from AI search)
  phoneInterviewSummaries: [{
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
    questions: [{
      text: String,
      type: String,
    }],
    analysis: {
      technical_skills: [String],
      behavioral_traits: [String],
      communication_quality: Number,
      overall_fit: Number,
      strengths: [String],
      concerns: [String],
    },
    error: String,
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }],
}, {
  timestamps: true,
});

export default mongoose.model('User', userSchema);

