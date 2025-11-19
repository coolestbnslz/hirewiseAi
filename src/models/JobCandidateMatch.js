import mongoose from 'mongoose';

const jobCandidateMatchSchema = new mongoose.Schema({
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
  matchScore: {
    type: Number,
    min: 0,
    max: 100,
    required: true,
  },
  tagMatchScore: {
    type: Number,
    min: 0,
    max: 100,
  },
  skillsMatchScore: {
    type: Number,
    min: 0,
    max: 100,
  },
  matchedTags: [{
    type: String,
  }],
  matchedSkills: [{
    type: String,
  }],
  missingSkills: [{
    type: String,
  }],
  matchReason: {
    type: String,
  },
  status: {
    type: String,
    enum: ['pending', 'contacted', 'interested', 'not_interested', 'applied'],
    default: 'pending',
  },
  contactedAt: {
    type: Date,
  },
  // Link to Application if candidate applies
  applicationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Application',
  },
}, {
  timestamps: true,
});

// Index for efficient queries
jobCandidateMatchSchema.index({ jobId: 1, userId: 1 }, { unique: true });
jobCandidateMatchSchema.index({ jobId: 1, matchScore: -1 });

export default mongoose.model('JobCandidateMatch', jobCandidateMatchSchema);

