import mongoose from 'mongoose';

const candidateSearchSchema = new mongoose.Schema({
  searchText: {
    type: String,
    required: true,
    trim: true,
  },
  searchCriteria: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  explanation: {
    type: String,
  },
  // Shortlisted users (user IDs that were selected/approved)
  shortlistedUsers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  // Rejected users (user IDs that were rejected)
  rejectedUsers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  // Total results from the search
  totalResults: {
    type: Number,
    default: 0,
  },
  // Search results snapshot (optional, can store first N results)
  resultsSnapshot: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    matchScore: Number,
    skillsMatched: [String],
    recommendedAction: String,
  }],
  // Metadata
  createdBy: {
    type: String, // Can be user ID or "system" or "hr"
    default: 'system',
  },
}, {
  timestamps: true,
});

// Index for faster searches
candidateSearchSchema.index({ searchText: 'text' });
candidateSearchSchema.index({ createdAt: -1 });

export default mongoose.model('CandidateSearch', candidateSearchSchema);

