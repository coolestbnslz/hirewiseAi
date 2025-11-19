import User from '../models/User.js';
import Job from '../models/Job.js';
import JobCandidateMatch from '../models/JobCandidateMatch.js';
import Application from '../models/Application.js';
import { callLLM } from './llm.js';
import { parseJsonSafely } from './parseJsonSafely.js';

/**
 * Calculate tag-based match score between job tags and candidate tags
 */
function calculateTagMatchScore(jobTags, candidateTags) {
  if (!jobTags || jobTags.length === 0) return 0;
  if (!candidateTags || candidateTags.length === 0) return 0;

  // Normalize tags to lowercase for comparison
  const normalizedJobTags = jobTags.map(tag => tag.toLowerCase().trim());
  const normalizedCandidateTags = candidateTags.map(tag => tag.toLowerCase().trim());

  // Find matching tags
  const matchedTags = normalizedJobTags.filter(jobTag =>
    normalizedCandidateTags.some(candidateTag =>
      candidateTag.includes(jobTag) || jobTag.includes(candidateTag)
    )
  );

  // Calculate score based on percentage of matched tags
  const matchPercentage = (matchedTags.length / normalizedJobTags.length) * 100;
  return Math.min(100, Math.round(matchPercentage));
}

/**
 * Calculate skills match score between job skills and candidate resume
 */
async function calculateSkillsMatchScore(job, candidate) {
  if (!candidate.resumeText) return 0;

  try {
    // Use LLM to analyze skills match
    const skillsLLMResponse = await callLLM('RESUME_SCORING', {
      resumeText: candidate.resumeText,
      job,
    });

    const parsed = parseJsonSafely(skillsLLMResponse);
    if (parsed.ok && parsed.json.match_score) {
      return parsed.json.match_score;
    }
  } catch (error) {
    console.error('Error calculating skills match:', error);
  }

  return 0;
}

/**
 * Generate match reason based on scores and matches
 */
function generateMatchReason(tagMatchScore, skillsMatchScore, matchedTags, matchedSkills) {
  const reasons = [];

  if (tagMatchScore >= 80) {
    reasons.push('Excellent tag alignment');
  } else if (tagMatchScore >= 60) {
    reasons.push('Good tag alignment');
  }

  if (skillsMatchScore >= 80) {
    reasons.push('Strong skills match');
  } else if (skillsMatchScore >= 60) {
    reasons.push('Relevant skills');
  }

  if (matchedTags && matchedTags.length > 0) {
    reasons.push(`Matched tags: ${matchedTags.slice(0, 3).join(', ')}`);
  }

  if (matchedSkills && matchedSkills.length > 0) {
    reasons.push(`Key skills: ${matchedSkills.slice(0, 3).join(', ')}`);
  }

  return reasons.join('. ') || 'Potential match based on profile';
}

/**
 * Match a job to all available candidates and calculate scores
 */
export async function matchJobToCandidates(jobId) {
  try {
    const job = await Job.findById(jobId);

    if (!job) {
      throw new Error('Job not found');
    }

    // Get all candidates who are not hired
    const candidates = await User.find({
      isHired: false,
      resumeText: { $exists: true, $ne: '' }, // Only candidates with resumes
    });

    if (candidates.length === 0) {
      return {
        success: true,
        matches: [],
        message: 'No available candidates found',
      };
    }

    const matches = [];

    for (const candidate of candidates) {
      // Check if match already exists
      const existingMatch = await JobCandidateMatch.findOne({
        jobId: job._id,
        userId: candidate._id,
      });

      if (existingMatch) {
        matches.push(existingMatch);
        continue;
      }

      // Calculate tag match score
      const tagMatchScore = calculateTagMatchScore(job.tags, candidate.tags);
      
      // Find matched tags
      const normalizedJobTags = job.tags.map(t => t.toLowerCase().trim());
      const normalizedCandidateTags = candidate.tags.map(t => t.toLowerCase().trim());
      const matchedTags = normalizedJobTags.filter(jobTag =>
        normalizedCandidateTags.some(candidateTag =>
          candidateTag.includes(jobTag) || jobTag.includes(candidateTag)
        )
      );

      // Calculate skills match score
      const skillsMatchScore = await calculateSkillsMatchScore(job, candidate);

      // Get matched skills from resume analysis if available
      let matchedSkills = [];
      let missingSkills = [];
      
      // Try to get skills from existing application for this job
      const existingApplication = await Application.findOne({
        jobId: job._id,
        userId: candidate._id,
      });

      if (existingApplication && existingApplication.rawResumeLLM) {
        try {
          const parsed = parseJsonSafely(existingApplication.rawResumeLLM);
          if (parsed.ok) {
            matchedSkills = parsed.json.skills_matched || [];
            missingSkills = parsed.json.skills_missing || [];
          }
        } catch (error) {
          console.error('Error parsing resume LLM data:', error);
        }
      }

      // Calculate overall match score (weighted: 40% tags, 60% skills)
      const overallMatchScore = Math.round(
        tagMatchScore * 0.4 + skillsMatchScore * 0.6
      );

      // Generate match reason
      const matchReason = generateMatchReason(
        tagMatchScore,
        skillsMatchScore,
        matchedTags,
        matchedSkills
      );

      // Create match record
      const match = new JobCandidateMatch({
        jobId: job._id,
        userId: candidate._id,
        matchScore: overallMatchScore,
        tagMatchScore,
        skillsMatchScore,
        matchedTags,
        matchedSkills,
        missingSkills,
        matchReason,
        status: 'pending',
      });

      await match.save();
      matches.push(match);
    }

    // Sort matches by score (highest first)
    matches.sort((a, b) => b.matchScore - a.matchScore);

    return {
      success: true,
      matches: matches.map(m => ({
        matchId: m._id,
        userId: m.userId,
        matchScore: m.matchScore,
        tagMatchScore: m.tagMatchScore,
        skillsMatchScore: m.skillsMatchScore,
        matchedTags: m.matchedTags,
        matchedSkills: m.matchedSkills,
        missingSkills: m.missingSkills,
        matchReason: m.matchReason,
        status: m.status,
      })),
      totalCandidates: candidates.length,
      matchedCandidates: matches.length,
    };
  } catch (error) {
    console.error('Error matching job to candidates:', error);
    throw error;
  }
}

/**
 * Get matches for a specific job
 */
export async function getJobMatches(jobId, options = {}) {
  const { minScore = 0, limit = 50, status } = options;

  const query = {
    jobId,
    matchScore: { $gte: minScore },
  };

  if (status) {
    query.status = status;
  }

  const matches = await JobCandidateMatch.find(query)
    .populate('userId', 'name email tags githubUrl portfolioUrl compensationExpectation')
    .sort({ matchScore: -1 })
    .limit(limit);

  return matches;
}

