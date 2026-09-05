export interface GenerateWritingOptions {
  module: 'academic' | 'general';
  targetBand: '5.0-5.5' | '6.0-6.5' | '7.0-7.5' | '8.0+';
  theme: string;
  negativeTopics?: string[];
  task1Type?: string;
  task2Type?: string;
}

export function buildWritingPrompt(options: GenerateWritingOptions) {
  const isGeneral = options.module === 'general';
  const negativeList = options.negativeTopics && options.negativeTopics.length > 0 
    ? `CRITICAL ANTI-REPEAT INSTRUCTION: You MUST NOT use or reference any of these themes: ${options.negativeTopics.join(', ')}.`
    : '';

  const systemInstruction = `You are a Senior IELTS Examiner and Item Writer specialized in IELTS Writing Task 1 and Task 2.
Your task is to generate complete, high-precision IELTS Writing examination assignments for ${options.module.toUpperCase()} module.

DIFFICULTY LEVEL: Target Band ${options.targetBand}.
THEME: "${options.theme}".
${negativeList}

TASK 1 SPECIFICATION:
${isGeneral ? `
- General Training Letter: ${options.task1Type || 'formal_letter or semi_formal_letter'}.
- Provide a realistic real-world situation with three mandatory bullet points that the candidate must address.
- Provide clear guidance on formal/semi-formal register, opening, and closing conventions.
` : `
- Academic Report: ${options.task1Type || 'bar_chart, line_graph, or process_diagram'}.
- Provide a detailed visual description, specific statistical data / categories / milestones, and clear instructions to "Summarise the information by selecting and reporting the main features, and make comparisons where relevant."
- Minimum 150 words requirement.
`}

TASK 2 SPECIFICATION:
- Essay Type: ${options.task2Type || 'opinion, discussion, or problem_solution'}.
- Format: A contemporary topic statement and a precise instruction (e.g. "To what extent do you agree or disagree?", "Discuss both views and give your own opinion").
- Deconstruct the prompt with:
  1. Scope limits (who, where, under what constraints).
  2. Hidden requirements (e.g. plurals, degree of agreement, balanced discussion).
  3. Fons De Belion's 2-5-5-2 structural blueprint (2 intro sentences, 5 sentences Body 1, 5 sentences Body 2, 2 conclusion sentences).
  4. 8 Band 8+ academic collocations tailored to this exact topic.`;

  return {
    systemInstruction,
    userPrompt: `Generate an authentic IELTS ${options.module.toUpperCase()} Writing Test (Task 1 and Task 2) on theme "${options.theme}". Target Band: ${options.targetBand}.`
  };
}

export const writingResponseSchema = {
  type: 'object',
  properties: {
    testTitle: { type: 'string' },
    module: { type: 'string' },
    theme: { type: 'string' },
    targetBand: { type: 'string' },
    task1: {
      type: 'object',
      properties: {
        taskNumber: { type: 'integer' },
        taskType: { type: 'string' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        dataDescription: { type: 'string' },
        structuredData: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            series: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  values: { type: 'array', items: { type: 'number' } }
                }
              }
            }
          }
        },
        letterBulletPoints: {
          type: 'array',
          items: { type: 'string' }
        },
        timeRecommendation: { type: 'string' },
        minWords: { type: 'integer' },
        modelOverview: { type: 'string' }
      },
      required: ['taskNumber', 'taskType', 'title', 'prompt', 'minWords']
    },
    task2: {
      type: 'object',
      properties: {
        taskNumber: { type: 'integer' },
        essayType: { type: 'string' },
        prompt: { type: 'string' },
        instruction: { type: 'string' },
        minWords: { type: 'integer' },
        timeRecommendation: { type: 'string' },
        scopeWords: { type: 'array', items: { type: 'string' } },
        hiddenRequirements: { type: 'array', items: { type: 'string' } },
        suggestedBlueprint: {
          type: 'object',
          properties: {
            intro: { type: 'string' },
            body1: { type: 'string' },
            body2: { type: 'string' },
            conclusion: { type: 'string' }
          }
        },
        academicCollocations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              collocation: { type: 'string' },
              contextExample: { type: 'string' }
            },
            required: ['collocation', 'contextExample']
          }
        }
      },
      required: ['taskNumber', 'essayType', 'prompt', 'instruction', 'minWords', 'academicCollocations']
    }
  },
  required: ['testTitle', 'module', 'theme', 'task1', 'task2']
};
