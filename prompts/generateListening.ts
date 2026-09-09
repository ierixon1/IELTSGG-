export interface GenerateListeningOptions {
  module: 'academic' | 'general';
  targetBand: '5.0-5.5' | '6.0-6.5' | '7.0-7.5' | '8.0+';
  theme: string;
  negativeTopics?: string[];
  partNumber?: number; // 1, 2, 3, 4 or full (1-4)
  requestedQuestionTypes?: string[];
}

export function buildListeningPrompt(options: GenerateListeningOptions) {
  const partDesc = options.partNumber 
    ? `Generate Part ${options.partNumber} specifically.`
    : `Generate 2 distinct parts of the test (Part 1 everyday social dialogue and Part 3 academic tutorial/discussion).`;

  const negativeList = options.negativeTopics && options.negativeTopics.length > 0 
    ? `CRITICAL ANTI-REPEAT INSTRUCTION: You MUST NOT use or reference any of these themes: ${options.negativeTopics.join(', ')}.`
    : '';

  const systemInstruction = `You are a Senior Audio Material Designer for official Cambridge IELTS Listening examinations.
Your task is to generate authentic IELTS Listening examination content including realistic multi-speaker dialogue scripts, accented speaker notation, audio scripts formatted for Speech Synthesis (TTS), and official IELTS listening questions with strict auto-grading keys.

DIFFICULTY LEVEL: Target Band ${options.targetBand}.
${options.targetBand === '8.0+' ? 'Include natural speaker self-corrections (e.g. "Sorry, I meant Tuesday the 14th, not Monday"), background pauses, subtle numbers with similar sounds, and rapid academic colloquial phrasing.' : 'Ensure clear articulation, standard tempo, and realistic conversational turn-taking.'}

THEME: "${options.theme}".
${negativeList}
${partDesc}

PART GUIDELINES:
- Part 1: Everyday social context between two speakers (e.g. hotel booking, community club registration, lost property inquiry). Form/table filling.
- Part 2: Monologue in an everyday social context (e.g. guide explaining a botanical garden, museum volunteer orientation). Map labelling or multiple choice.
- Part 3: Academic conversation with up to 3 speakers (university students and a tutor discussing a research project). Matching or complex multiple choice.
- Part 4: Academic university lecture monologue on a scholarly or scientific subject. Summary or sentence completion (ONE WORD ONLY).

RULES FOR QUESTIONS & ANSWERS:
- Strict adherence to word limits (e.g., "NO MORE THAN TWO WORDS AND/OR A NUMBER").
- Correct answers MUST be verbatim spoken words from the script.
- Explanations must pinpoint where the speaker speaks the answer, and how distractors (like initial mistakes or rejected suggestions) are dismissed.`;

  return {
    systemInstruction,
    userPrompt: `Generate high-authenticity IELTS Listening content on the theme: "${options.theme}" for target band ${options.targetBand}.
Provide the full audio dialogue script with speaker accents, dialogue turns, and 8 to 10 rigorously calibrated questions with keys and explanations.`
  };
}

export const listeningResponseSchema = {
  type: 'object',
  properties: {
    testTitle: { type: 'string' },
    targetBand: { type: 'string' },
    theme: { type: 'string' },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          partNumber: { type: 'integer' },
          title: { type: 'string' },
          context: { type: 'string' },
          speakers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                accent: { type: 'string' },
                role: { type: 'string' }
              },
              required: ['name', 'accent', 'role']
            }
          },
          dialogueLines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                speaker: { type: 'string' },
                text: { type: 'string' },
                accent: { type: 'string' },
                isAnswerCue: { type: 'boolean' }
              },
              required: ['speaker', 'text']
            }
          },
          fullTranscript: { type: 'string' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                questionNumber: { type: 'integer' },
                type: { 
                  type: 'string',
                  description: 'One of: form_completion, multiple_choice, matching, map_label, sentence_completion, short_answer'
                },
                prompt: { type: 'string' },
                instruction: { type: 'string' },
                options: { 
                  type: 'array',
                  items: { type: 'string' }
                },
                correctAnswer: { type: 'string' },
                acceptableAnswers: {
                  type: 'array',
                  items: { type: 'string' }
                },
                explanation: { type: 'string' }
              },
              required: ['id', 'questionNumber', 'type', 'prompt', 'correctAnswer', 'explanation']
            }
          }
        },
        required: ['partNumber', 'title', 'context', 'dialogueLines', 'fullTranscript', 'questions']
      }
    }
  },
  required: ['testTitle', 'targetBand', 'theme', 'parts']
};
