import mongoose from 'mongoose';

const screeningSchema = new mongoose.Schema({
  applicationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Application',
    required: true,
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true,
  },
  screening_link: {
    type: String,
  },
  screening_questions: [{
    text: String,
    time_limit_sec: Number,
    type: String,
  }],
  videoUrl: {
    type: String,
  },
  transcript: {
    type: String,
  },
  scoring: {
    per_question: [{
      question_index: Number,
      communication: Number,
      technical_depth: Number,
      clarity: Number,
      notes: String,
    }],
    overall_score: Number,
    confidence: Number,
    overall_recommendation: String,
    two_line_summary: String,
  },
  invite_sent_at: {
    type: Date,
  },
  // Phone interview via Bland AI
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

export default mongoose.model('Screening', screeningSchema);

