import express from 'express';
import Job from '../models/Job.js';
import Application from '../models/Application.js';
import Screening from '../models/Screening.js';
import User from '../models/User.js';
import JobCandidateMatch from '../models/JobCandidateMatch.js';

const router = express.Router();

// GET /debug/jobs - Get all jobs
router.get('/jobs', async (req, res) => {
  try {
    const jobs = await Job.find({});
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /debug/applications - Get all applications
router.get('/applications', async (req, res) => {
  try {
    const applications = await Application.find({})
      .populate('jobId')
      .populate('userId');
    res.json(applications);
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /debug/screenings - Get all screenings
router.get('/screenings', async (req, res) => {
  try {
    const screenings = await Screening.find({})
      .populate('applicationId')
      .populate('jobId');
    res.json(screenings);
  } catch (error) {
    console.error('Error fetching screenings:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /debug/users - Get all users
router.get('/users', async (req, res) => {
  try {
    const users = await User.find({});
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /debug/matches - Get all job-candidate matches
router.get('/matches', async (req, res) => {
  try {
    const matches = await JobCandidateMatch.find({})
      .populate('jobId', 'role company_name')
      .populate('userId', 'name email');
    res.json(matches);
  } catch (error) {
    console.error('Error fetching matches:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

export default router;

