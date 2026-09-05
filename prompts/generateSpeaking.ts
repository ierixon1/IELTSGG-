export interface GenerateSpeakingOptions {
  targetBand: '5.0-5.5' | '6.0-6.5' | '7.0-7.5' | '8.0+';
  theme: string;
  negativeTopics?: string[];
  cueCardCategory?: 'person' | 'place' | 'object' | 'event' | 'experience' | 'activity';
}

export function buildSpeakingPrompt(options: GenerateSpeakingOptions) {
  const negativeList = options.negativeTopics && options.negativeTopics.length > 0 
    ? `CRITICAL ANTI-REPEAT INSTRUCTION: You MUST NOT use or reference any of these themes: ${options.negativeTopics.join(', ')}.`
    : '';

  const systemInstruction = `You are an Official IELTS Speaking Examiner and Test Designer.
Your task is to generate a complete, authentic 3-part IELTS Speaking Examination on the theme: "${options.theme}".

DIFFICULTY LEVEL: Target Band ${options.targetBand}.
${negativeList}

STRUCTURE:
1. Part 1 (Introduction & Interview, 4-5 mins):
   - 4 questions on familiar personal routines, habits, or preferences relating to the theme.
2. Part 2 (Long Turn / Individual Monologue, 3-4 mins):
   - Cue card category: ${options.cueCardCategory || 'experience, object, place, or person'}.
   - Clear topic title and 4 bullet points ("You should say: where/when/who... and explain why...").
   - Follow-up rounding-off question.
3. Part 3 (Two-Way Discussion, 4-5 mins):
   - 4 abstract, speculative, and analytical questions deepening the Part 2 theme into society, future trends, ethics, or global impact.
4. Idiomatic and Speaking-Safe Language Toolkit:
   - Provide 6 natural spoken idiomatic expressions or conversational connectors (from everyday natural native discourse, e.g. "for my money", "run short of", "slip away", "in high spirits").`;

  return {
    systemInstruction,
    userPrompt: `Generate an authentic IELTS Speaking Test on theme "${options.theme}" for target band ${options.targetBand} with Part 1, Part 2 (Cue Card), Part 3, and high-band spoken phrases.`
  };
}

export const speakingResponseSchema = {
  type: 'object',
  properties: {
    testTitle: { type: 'string' },
    theme: { type: 'string' },
    targetBand: { type: 'string' },
    part1: {
      type: 'object',
      properties: {
        topicName: { type: 'string' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              questionNumber: { type: 'integer' },
              prompt: { type: 'string' },
              examinerTip: { type: 'string' }
            },
            required: ['id', 'questionNumber', 'prompt']
          }
        }
      },
      required: ['topicName', 'questions']
    },
    part2: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        topic: { type: 'string' },
        cueCardPrompt: { type: 'string' },
        bulletPoints: {
          type: 'array',
          items: { type: 'string' }
        },
        roundingOffQuestion: { type: 'string' }
      },
      required: ['category', 'topic', 'cueCardPrompt', 'bulletPoints']
    },
    part3: {
      type: 'object',
      properties: {
        discussionArea: { type: 'string' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              questionNumber: { type: 'integer' },
              prompt: { type: 'string' },
              sampleIdeaPoints: { type: 'array', items: { type: 'string' } }
            },
            required: ['id', 'questionNumber', 'prompt']
          }
        }
      },
      required: ['discussionArea', 'questions']
    },
    recommendedPhrases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          phrase: { type: 'string' },
          meaning: { type: 'string' },
          spokenExample: { type: 'string' }
        },
        required: ['phrase', 'meaning', 'spokenExample']
      }
    }
  },
  required: ['testTitle', 'theme', 'targetBand', 'part1', 'part2', 'part3']
};
