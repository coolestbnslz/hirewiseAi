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
    type: String,
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
}, {
  timestamps: true,
});

export default mongoose.model('User', userSchema);

