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
  resumeSummary: {
    type: String,
  },
  consent_given: {
    type: Boolean,
    default: false,
  },
  level1_approved: {
    type: Boolean,
    default: false,
  },
  // Link to JobCandidateMatch if this application came from a match
  matchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JobCandidateMatch',
  },
}, {
  timestamps: true,
});

export default mongoose.model('Application', applicationSchema);

