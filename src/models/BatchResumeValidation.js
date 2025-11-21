import mongoose from 'mongoose';

const batchResumeValidationSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending',
  },
  totalResumes: {
    type: Number,
    required: true,
  },
  processedResumes: {
    type: Number,
    default: 0,
  },
  results: [{
    resumeIndex: {
      type: Number,
      required: true,
    },
    filename: {
      type: String,
      required: true,
    },
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },
    error: {
      type: String,
    },
    processedAt: {
      type: Date,
    },
  }],
  startedAt: {
    type: Date,
    default: Date.now,
  },
  completedAt: {
    type: Date,
  },
  error: {
    type: String,
  },
}, {
  timestamps: true,
});

export default mongoose.model('BatchResumeValidation', batchResumeValidationSchema);

