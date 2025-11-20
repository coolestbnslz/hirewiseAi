import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema({
  raw_jd: {
    type: String,
    required: true,
  },
  enhanced_jd: {
    type: String,
  },
  company_name: {
    type: String,
    required: true,
    trim: true,
  },
  role: {
    type: String,
    required: true,
    trim: true,
  },
  team: {
    type: String,
    trim: true,
  },
  seniority: {
    type: String,
    trim: true,
  },
  location: {
    type: String,
    trim: true,
  },
  job_type: {
    type: String,
    enum: ['full-time', 'part-time', 'contract', 'internship', 'remote', 'hybrid', 'on-site'],
    trim: true,
  },
  budget_info: {
    type: String,
  },
  must_have_skills: [{
    type: String,
  }],
  nice_to_have: [{
    type: String,
  }],
  tags: [{
    type: String,
  }],
  apply_form_fields: {
    type: mongoose.Schema.Types.Mixed,
    default: [],
  },
  screening_questions: [{
    text: String,
    time_limit_sec: Number,
    type: String,
  }],
  settings: {
    autoInviteOnLevel1Approval: {
      type: Boolean,
      default: false,
    },
    autoInviteThreshold: {
      type: Number,
      default: 70,
    },
    autoCreateScreeningThreshold: {
      type: Number,
      default: 60,
    },
  },
  status: {
    type: String,
    enum: ['draft', 'finalized'],
    default: 'finalized',
  },
}, {
  timestamps: true,
});

export default mongoose.model('Job', jobSchema);

