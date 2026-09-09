export interface GenerateReadingOptions {
  module: 'academic' | 'general';
  targetBand: '5.0-5.5' | '6.0-6.5' | '7.0-7.5' | '8.0+';
  theme: string;
  negativeTopics?: string[];
  requestedQuestionTypes?: string[];
  passageCount?: number;
}

export function buildReadingPrompt(options: GenerateReadingOptions) {
  const isGeneral = options.module === 'general';
  const passageCount = options.passageCount || 1;
  const negativeList = options.negativeTopics && options.negativeTopics.length > 0 
    ? `CRITICAL ANTI-REPEAT INSTRUCTION: You MUST NOT use or reference any of these recently tested themes: ${options.negativeTopics.join(', ')}.`
    : '';

  const questionTypesInstruction = options.requestedQuestionTypes && options.requestedQuestionTypes.length > 0
    ? `You MUST include questions from the following official IELTS types: ${options.requestedQuestionTypes.join(', ')} (at least 4 distinct types must be represented across the questions).`
    : `You MUST distribute questions across at least 4 distinct official IELTS Reading question types (e.g. true_false_not_given, matching_headings, sentence_completion, multiple_choice, summary_completion).`;

  const difficultyNotes = {
    '5.0-5.5': 'Vocabulary should be moderately accessible (B1-B2). Sentences should have direct syntax. Questions should have clear, direct keyword anchors and minimal deceptive distractors.',
    '6.0-6.5': 'Standard IELTS academic text (B2-C1). Introduce moderate paraphrasing, some sentence transformations, and believable distractors.',
    '7.0-7.5': 'Advanced academic register (C1). Sophisticated synonyms, dense clause subordination, subtle scope shifts (e.g. "some researchers" vs "the majority"), and genuine True vs Not Given dilemmas.',
    '8.0+': 'Mastery level (C1-C2). Highly complex scientific or philosophical discourse. Dense nominalizations, intricate hedging (arguably, ostensibly, plausibly), subtle traps where common misconceptions deceive superficial readers.'
  }[options.targetBand];

  const systemInstruction = `You are a Senior Principal IELTS Cambridge/IDP Exam Item Writer and Test Development Officer.
Your task is to generate an authentic, publication-quality IELTS ${isGeneral ? 'General Training' : 'Academic'} Reading passage with an exact set of rigorously constructed questions, strict answer keys, and clear explanations.

DIFFICULTY LEVEL: Target Band ${options.targetBand}.
${difficultyNotes}

THEME: "${options.theme}".
${negativeList}

RULES FOR PASSAGES:
- Academic passages must be structured into 5 to 7 clearly lettered paragraphs [A], [B], [C], [D], [E], [F], [G].
- Passage length: ~750 to 950 words per passage.
- Tone: Formal, objective, scholarly journalistic (similar to New Scientist, The Economist, or National Geographic).
- Do not use fictional gibberish; ground the content in authentic scientific, historical, or environmental facts and methodologies.

RULES FOR QUESTIONS:
${questionTypesInstruction}
- For True/False/Not Given (facts) and Yes/No/Not Given (opinions), ensure that:
  * TRUE/YES: The statement accurately reflects what is explicitly stated in the text (with paraphrased language).
  * FALSE/NO: The statement directly contradicts the text (both cannot be true at the same time).
  * NOT GIVEN: The text neither confirms nor contradicts the statement; no conclusion can be drawn from the text alone.
- For Matching Headings: Provide 6-8 roman numeral headings for 4-5 lettered paragraphs with at least 2 plausible distractors.
- For Sentence/Summary Completion: Specify the word limit (e.g., "NO MORE THAN TWO WORDS"). The correct answer MUST be an EXACT word or words taken directly from the passage text.
- For Multiple Choice: Provide 4 options (A, B, C, D) with 1 unambiguously correct option and 3 crafted distractors representing common reading traps (e.g. absolute words, wrong subject, temporal mismatch).
- Every single question MUST include an in-depth "explanation" identifying:
  1. The exact paragraph and sentence where the evidence is located.
  2. The exact paraphrase bridge (how question keywords correspond to passage words).
  3. Why incorrect options/interpretations fail.`;

  return {
    systemInstruction,
    userPrompt: `Generate 1 complete IELTS ${options.module.toUpperCase()} Reading passage with 10 to 13 varied questions on the theme: "${options.theme}". Target Band: ${options.targetBand}.
Ensure all JSON fields are populated with pristine academic English.`
  };
}

export const readingResponseSchema = {
  type: 'object',
  properties: {
    testTitle: { type: 'string' },
    module: { type: 'string' },
    targetBand: { type: 'string' },
    theme: { type: 'string' },
    passages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          passageNumber: { type: 'integer' },
          title: { type: 'string' },
          subheading: { type: 'string' },
          content: { type: 'string' },
          wordCount: { type: 'integer' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                questionNumber: { type: 'integer' },
                type: { 
                  type: 'string',
                  description: 'One of: multiple_choice, true_false_not_given, yes_no_not_given, matching_headings, matching_information, matching_features, sentence_completion, summary_completion, diagram_label, short_answer'
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
                explanation: { type: 'string' },
                paragraphLocation: { type: 'string' },
                targetSkill: { type: 'string' }
              },
              required: ['id', 'questionNumber', 'type', 'prompt', 'correctAnswer', 'explanation']
            }
          }
        },
        required: ['passageNumber', 'title', 'content', 'questions']
      }
    }
  },
  required: ['testTitle', 'module', 'targetBand', 'theme', 'passages']
};
