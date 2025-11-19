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
}, {
  timestamps: true,
});

export default mongoose.model('User', userSchema);

