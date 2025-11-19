import express from 'express';
import Screening from '../models/Screening.js';
import Job from '../models/Job.js';
import Application from '../models/Application.js';
import { transcribeVideo } from '../lib/stt.js';
import { callLLM } from '../lib/llm.js';
import { parseJsonSafely } from '../lib/parseJsonSafely.js';

const router = express.Router();

// GET /api/screenings/:id/questions - Get screening questions (generates on the spot if not set)
router.get('/:id/questions', async (req, res) => {
  try {
    const screening = await Screening.findById(req.params.id).populate('jobId');
    
    if (!screening) {
      return res.status(404).json({ error: 'Screening not found' });
    }

    // If questions already exist, return them
    if (screening.screening_questions && screening.screening_questions.length > 0) {
      return res.json({
        screeningId: screening._id,
        questions: screening.screening_questions,
      });
    }

    // Generate questions on the spot using LLM based on job requirements
    const job = screening.jobId;
    
    // Get candidate info if available (from application)
    const application = await Application.findOne({ 
      _id: screening.applicationId 
    }).populate('userId');
    
    let candidateInfo = null;
    if (application && application.userId) {
      const user = application.userId;
      // Extract skills from resume analysis if available
      let skills = [];
      if (application.rawResumeLLM) {
        try {
          const resumeParsed = parseJsonSafely(application.rawResumeLLM);
          if (resumeParsed.ok && resumeParsed.json.skills_matched) {
            skills = resumeParsed.json.skills_matched;
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
      
      candidateInfo = {
        name: user.name,
        skills: skills.length > 0 ? skills : user.tags || [],
      };
    }

    // Use dedicated LLM prompt to generate questions on the spot
    const questionsResponse = await callLLM('SCREENING_QUESTIONS', {
      job,
      candidateInfo,
    });

    // Parse the response
    const parsed = parseJsonSafely(questionsResponse);
    
    let questions = [];
    if (parsed.ok && parsed.json.screening_questions) {
      questions = parsed.json.screening_questions;
    } else {
      // Fallback to job's default questions if LLM fails
      questions = job.screening_questions || [];
    }

    // Store questions in screening
    screening.screening_questions = questions;
    await screening.save();

    res.json({
      screeningId: screening._id,
      questions,
    });
  } catch (error) {
    console.error('Error getting/generating questions:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/screenings/:id/upload-video - Store video URL and questions (if provided)
router.post('/:id/upload-video', async (req, res) => {
  try {
    const { videoUrl, questions } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ error: 'videoUrl is required' });
    }

    const screening = await Screening.findById(req.params.id).populate('jobId');
    
    if (!screening) {
      return res.status(404).json({ error: 'Screening not found' });
    }

    // If questions are provided, store them (this ensures questions are set at upload time)
    if (questions && Array.isArray(questions) && questions.length > 0) {
      screening.screening_questions = questions;
    } else if (!screening.screening_questions || screening.screening_questions.length === 0) {
      // If no questions provided and none exist, generate them on the spot
      const job = screening.jobId;
      
      // Get candidate info if available
      const application = await Application.findOne({ 
        _id: screening.applicationId 
      }).populate('userId');
      
      let candidateInfo = null;
      if (application && application.userId) {
        const user = application.userId;
        let skills = [];
        if (application.rawResumeLLM) {
          try {
            const resumeParsed = parseJsonSafely(application.rawResumeLLM);
            if (resumeParsed.ok && resumeParsed.json.skills_matched) {
              skills = resumeParsed.json.skills_matched;
            }
          } catch (e) {
            // Ignore parsing errors
          }
        }
        candidateInfo = {
          name: user.name,
          skills: skills.length > 0 ? skills : user.tags || [],
        };
      }

      const questionsResponse = await callLLM('SCREENING_QUESTIONS', {
        job,
        candidateInfo,
      });

      const parsed = parseJsonSafely(questionsResponse);
      if (parsed.ok && parsed.json.screening_questions) {
        screening.screening_questions = parsed.json.screening_questions;
      } else {
        // Fallback to job's default questions
        screening.screening_questions = job.screening_questions || [];
      }
    }

    screening.videoUrl = videoUrl;
    await screening.save();

    res.json({ 
      message: 'Video URL saved', 
      screening: {
        _id: screening._id,
        videoUrl: screening.videoUrl,
        questions: screening.screening_questions,
      },
    });
  } catch (error) {
    console.error('Error saving video URL:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /api/screenings/:id/process - Process video (STT + scoring)
router.post('/:id/process', async (req, res) => {
  try {
    const screening = await Screening.findById(req.params.id).populate('jobId');
    
    if (!screening) {
      return res.status(404).json({ error: 'Screening not found' });
    }

    if (!screening.videoUrl) {
      return res.status(400).json({ error: 'No video URL found. Upload video first.' });
    }

    // Transcribe video
    const transcription = await transcribeVideo(screening.videoUrl);
    screening.transcript = transcription.transcript;

    // Score video using questions stored in screening (set at upload time)
    const questions = screening.screening_questions && screening.screening_questions.length > 0
      ? screening.screening_questions
      : screening.jobId.screening_questions || [];

    const videoLLMResponse = await callLLM('VIDEO_SCORING', {
      transcript: transcription.transcript,
      screening_questions: questions,
    });

    const videoParsed = parseJsonSafely(videoLLMResponse);
    
    if (!videoParsed.ok) {
      return res.status(500).json({ 
        error: 'Failed to parse video scoring', 
        details: videoParsed.error 
      });
    }

    screening.scoring = videoParsed.json;
    await screening.save();

    res.json({ 
      message: 'Video processed successfully',
      screening,
    });
  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

export default router;

