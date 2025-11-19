/**
 * STT (Speech-to-Text) stub
 * In production, replace with actual STT service (AWS Transcribe, Google Speech-to-Text, etc.)
 */

export async function transcribeVideo(videoUrl) {
  console.log(`[STT] Transcribing video: ${videoUrl}`);

  // Simulate processing delay
  await new Promise(resolve => setTimeout(resolve, 500));

  // Mock transcript
  const transcript = `This is a mock transcript of the video interview. The candidate discussed their experience with Node.js and Express, their previous projects, and their motivation for joining the team. They provided detailed examples of challenging problems they solved and demonstrated strong communication skills.`;

  const segments = [
    { start: 0, end: 5, text: 'This is a mock transcript of the video interview.' },
    { start: 5, end: 12, text: 'The candidate discussed their experience with Node.js and Express.' },
    { start: 12, end: 20, text: 'They provided detailed examples of challenging problems they solved.' },
  ];

  return {
    transcript,
    segments,
  };
}

