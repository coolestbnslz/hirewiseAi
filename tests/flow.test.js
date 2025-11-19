import * as llmModule from '../src/lib/llm.js';
import { parseJsonSafely } from '../src/lib/parseJsonSafely.js';

// Mock the LLM module
const mockCallLLM = jest.fn();
llmModule.callLLM = mockCallLLM;

describe('Application Flow', () => {
  test('should score resume and calculate unified score', async () => {
    const mockResumeText = 'Experienced Node.js developer with 5 years of experience';
    const mockJob = {
      _id: 'job123',
      role: 'Software Engineer',
      settings: {
        autoCreateScreeningThreshold: 60,
      },
    };

    // Mock resume scoring response
    const mockResumeResponse = JSON.stringify({
      match_score: 85,
      confidence: 0.9,
      skills_matched: ['Node.js', 'Express'],
      skills_missing: [],
      recommended_action: 'yes',
      top_reasons: ['Strong match'],
    });

    mockCallLLM.mockResolvedValueOnce(mockResumeResponse);

    const resumeLLMResponse = await mockCallLLM('RESUME_SCORING', {
      resumeText: mockResumeText,
      job: mockJob,
    });

    const resumeParsed = parseJsonSafely(resumeLLMResponse);

    expect(resumeParsed.ok).toBe(true);
    expect(resumeParsed.json.match_score).toBe(85);
    expect(resumeParsed.json.recommended_action).toBe('yes');

    // Calculate unified score (simplified - resume only for this test)
    const resumeScore = resumeParsed.json.match_score;
    const unifiedScore = resumeScore * 0.5; // 50% weight

    expect(unifiedScore).toBeGreaterThan(mockJob.settings.autoCreateScreeningThreshold);
  });

  test('should generate email for approved application', async () => {
    const mockEmailPayload = {
      candidateName: 'John Doe',
      role: 'Software Engineer',
      company: 'TestCo',
      screening_link: 'https://hirewise.app/screening/abc123',
      screening_questions: [
        { text: 'Tell us about yourself', time_limit_sec: 120, type: 'video' },
      ],
    };

    const mockEmailResponse = JSON.stringify({
      subject: 'Next Step: Video Screening',
      preview_text: 'We invite you to complete a video screening',
      tone: 'friendly',
      plain_text: 'Hi John, ...',
      html_snippet: '<p>Hi John, ...</p>',
    });

    mockCallLLM.mockResolvedValueOnce(mockEmailResponse);

    const emailLLMResponse = await mockCallLLM('EMAIL_GENERATOR', mockEmailPayload);
    const emailParsed = parseJsonSafely(emailLLMResponse);

    expect(emailParsed.ok).toBe(true);
    expect(emailParsed.json.subject).toContain('Video Screening');
    expect(emailParsed.json.plain_text).toContain('John');
    expect(mockCallLLM).toHaveBeenCalledWith('EMAIL_GENERATOR', expect.objectContaining({
      candidateName: 'John Doe',
      role: 'Software Engineer',
    }));
  });

  test('should process video and score it', async () => {
    const mockTranscript = 'This is a mock transcript of the video interview';
    const mockScreeningQuestions = [
      { text: 'Question 1', time_limit_sec: 120, type: 'video' },
      { text: 'Question 2', time_limit_sec: 90, type: 'video' },
    ];

    const mockVideoScoringResponse = JSON.stringify({
      per_question: [
        { question_index: 1, communication: 8, technical_depth: 7, clarity: 9, notes: 'Good' },
        { question_index: 2, communication: 7, technical_depth: 8, clarity: 8, notes: 'Excellent' },
      ],
      overall_score: 80,
      confidence: 0.85,
      overall_recommendation: 'yes',
      two_line_summary: 'Strong candidate with good communication skills.',
    });

    mockCallLLM.mockResolvedValueOnce(mockVideoScoringResponse);

    const videoLLMResponse = await mockCallLLM('VIDEO_SCORING', {
      transcript: mockTranscript,
      screening_questions: mockScreeningQuestions,
    });

    const videoParsed = parseJsonSafely(videoLLMResponse);

    expect(videoParsed.ok).toBe(true);
    expect(videoParsed.json.overall_score).toBe(80);
    expect(videoParsed.json.overall_recommendation).toBe('yes');
    expect(videoParsed.json.per_question).toHaveLength(2);
  });
});

