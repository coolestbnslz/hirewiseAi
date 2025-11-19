import { enhanceJD } from '../src/lib/jdEnhancer.js';
import * as llmModule from '../src/lib/llm.js';

// Mock the LLM module
const mockCallLLM = jest.fn();
llmModule.callLLM = mockCallLLM;

describe('jdEnhancer', () => {
  test('should enhance JD and return structured data', async () => {
    const mockJob = {
      raw_jd: 'We need a Node.js developer',
      company_name: 'TestCo',
      role: 'Software Engineer',
      seniority: 'Mid-level',
      budget_info: '$100k-$120k',
      must_have_skills: ['Node.js', 'Express'],
      nice_to_have: ['MongoDB'],
    };

    const mockLLMResponse = JSON.stringify({
      enhanced_jd: 'Enhanced job description',
      tags: ['engineering', 'nodejs'],
      apply_form_fields: [
        { name: 'email', type: 'email', label: 'Email', required: true },
      ],
      screening_questions: [
        { text: 'Tell us about yourself', time_limit_sec: 120, type: 'video' },
      ],
    });

    mockCallLLM.mockResolvedValue(mockLLMResponse);

    const result = await enhanceJD(mockJob);

    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data.enhanced_jd).toBe('Enhanced job description');
    expect(result.data.tags).toContain('engineering');
    expect(result.data.screening_questions).toHaveLength(1);
    expect(mockCallLLM).toHaveBeenCalledWith('JD_ENHANCER', expect.objectContaining({
      raw_jd: mockJob.raw_jd,
      company_name: mockJob.company_name,
    }));
  });

  test('should handle LLM response with noise', async () => {
    const mockJob = {
      raw_jd: 'Test JD',
      company_name: 'TestCo',
      role: 'Engineer',
    };

    const noisyResponse = `Here's the JSON:\n${JSON.stringify({
      enhanced_jd: 'Enhanced',
      tags: ['test'],
      apply_form_fields: [],
      screening_questions: [],
    })}\nEnd of response.`;

    mockCallLLM.mockResolvedValue(noisyResponse);

    const result = await enhanceJD(mockJob);

    expect(result.ok).toBe(true);
    expect(result.data.enhanced_jd).toBe('Enhanced');
  });

  test('should handle invalid LLM response', async () => {
    const mockJob = {
      raw_jd: 'Test JD',
      company_name: 'TestCo',
      role: 'Engineer',
    };

    mockCallLLM.mockResolvedValue('This is not JSON at all');

    const result = await enhanceJD(mockJob);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

