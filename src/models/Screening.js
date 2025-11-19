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
}, {
  timestamps: true,
});

export default mongoose.model('Screening', screeningSchema);

