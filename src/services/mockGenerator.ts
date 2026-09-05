import { GoogleGenAI, Type } from '@google/genai';
import { IELTS_THEMES, READING_QUESTION_TYPES, LISTENING_QUESTION_TYPES } from '../config/ieltsTaxonomy';
import { executeGeminiWithRetry } from '../../prompts/geminiRetry';
import { buildReadingPrompt, readingResponseSchema } from '../../prompts/generateReading';
import { buildListeningPrompt, listeningResponseSchema } from '../../prompts/generateListening';
import { buildWritingPrompt, writingResponseSchema } from '../../prompts/generateWriting';
import { buildSpeakingPrompt, speakingResponseSchema } from '../../prompts/generateSpeaking';
import { GenerateMockRequest } from '../schemas/mockGeneratorSchema';
import crypto from 'crypto';
import { adminStore } from './adminStore';

export interface GenerationResult {
  id: string;
  module: 'academic' | 'general';
  section: 'reading' | 'listening' | 'writing' | 'speaking' | 'full_mock';
  targetBand: string;
  theme: string;
  contentHash: string;
  title: string;
  questionTypes: string[];
  testData: any;
}

export class MockGeneratorService {
  private getAi(apiKey?: string): GoogleGenAI {
    return new GoogleGenAI({
      apiKey: apiKey || process.env.GEMINI_API_KEY || 'dummy-key',
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' }
      }
    });
  }

  /**
   * Select a distinct theme from the taxonomy that does not appear in negative list
   */
  public pickUniqueTheme(negativeThemes: string[] = []): string {
    const normalizedNegative = new Set(negativeThemes.map(t => t.toLowerCase().trim()));
    const candidates = IELTS_THEMES.filter(t => !normalizedNegative.has(t.name.toLowerCase().trim()));
    
    if (candidates.length > 0) {
      const idx = Math.floor(Math.random() * candidates.length);
      return candidates[idx].name;
    }
    // Fallback if all 36+ were used: pick any random
    const idx = Math.floor(Math.random() * IELTS_THEMES.length);
    return IELTS_THEMES[idx].name;
  }

  public async generateMock(
    options: GenerateMockRequest,
    recentThemes: string[] = []
  ): Promise<GenerationResult> {
    // 1. Check if an official published Admin material is available for this section and module
    try {
      if (options.section !== 'full_mock') {
        const adminMaterials = adminStore.listMaterials(options.section, 'published');
        // Match by module or targetBand if possible
        const matching = adminMaterials.filter(m => 
          (!m.module || m.module === options.module) &&
          (!options.theme || m.theme?.toLowerCase().includes(options.theme.toLowerCase()))
        );

        const candidate = matching.length > 0 ? matching[Math.floor(Math.random() * matching.length)] : null;
        if (candidate) {
          const testId = `mock_adm_${candidate.id}`;
          return {
            id: testId,
            module: candidate.module || options.module,
            section: options.section,
            targetBand: candidate.targetBand || options.targetBand,
            theme: candidate.theme || candidate.title,
            contentHash: `adm-${candidate.id}`,
            title: candidate.title,
            questionTypes: candidate.section === 'speaking' 
              ? ['part1_interview', 'part2_cuecard', 'part3_discussion']
              : candidate.section === 'writing'
              ? [candidate.content.task?.task1?.taskType, candidate.content.task?.task2?.essayType].filter(Boolean)
              : candidate.section === 'reading'
              ? (candidate.content.passage?.questions?.map((q: any) => q.type) || ['multiple_choice'])
              : (candidate.content.section?.questions?.map((q: any) => q.type) || ['form_completion']),
            testData: candidate.content.speakingSession || candidate.content.passage || candidate.content.section || candidate.content.task || candidate.content,
          };
        }
      }
    } catch (adminErr) {
      console.warn('[MockGenerator] Error querying adminStore materials:', adminErr);
    }

    const theme = options.theme || this.pickUniqueTheme(recentThemes);
    const combinedNegatives = Array.from(new Set([...recentThemes, ...(options.negativeTopics || [])]));
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return this.generateFallbackMock(options, theme);
    }

    const ai = this.getAi(apiKey);
    const testId = `mock_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    switch (options.section) {
      case 'reading': {
        const { systemInstruction, userPrompt } = buildReadingPrompt({
          module: options.module,
          targetBand: options.targetBand,
          theme,
          negativeTopics: combinedNegatives,
          requestedQuestionTypes: options.requestedQuestionTypes,
          passageCount: options.passageCount || 1
        });

        let parsed: any;
        try {
          const res = await executeGeminiWithRetry(async () => {
            return await ai.models.generateContent({
              model: 'gemini-3.8-flash',
              contents: userPrompt,
              config: {
                systemInstruction,
                temperature: 0.9,
                responseMimeType: 'application/json',
                responseSchema: readingResponseSchema as any
              }
            });
          });
          parsed = JSON.parse(res.text || '{}');
        } catch (err: any) {
          console.warn('[MockGenerator] Gemini API temporary unavailability (503/429), using high-fidelity exemplar:', err.message);
          return this.generateFallbackMock(options, theme);
        }

        const qTypes = parsed.passages?.[0]?.questions?.map((q: any) => q.type) || [];
        const contentHash = crypto.createHash('sha256').update(parsed.passages?.[0]?.content || '').digest('hex').substring(0, 16);

        return {
          id: testId,
          module: options.module,
          section: 'reading',
          targetBand: options.targetBand,
          theme,
          contentHash,
          title: parsed.testTitle || `IELTS Reading: ${theme}`,
          questionTypes: Array.from(new Set(qTypes)) as string[],
          testData: parsed
        };
      }

      case 'listening': {
        const { systemInstruction, userPrompt } = buildListeningPrompt({
          module: options.module,
          targetBand: options.targetBand,
          theme,
          negativeTopics: combinedNegatives,
          partNumber: options.partNumber,
          requestedQuestionTypes: options.requestedQuestionTypes
        });

        let parsed: any;
        try {
          const res = await executeGeminiWithRetry(async () => {
            return await ai.models.generateContent({
              model: 'gemini-3.8-flash',
              contents: userPrompt,
              config: {
                systemInstruction,
                temperature: 0.9,
                responseMimeType: 'application/json',
                responseSchema: listeningResponseSchema as any
              }
            });
          });
          parsed = JSON.parse(res.text || '{}');
        } catch (err: any) {
          console.warn('[MockGenerator] Gemini listening error, fallback:', err.message);
          return this.generateFallbackMock(options, theme);
        }

        const qTypes = parsed.parts?.[0]?.questions?.map((q: any) => q.type) || [];
        const contentHash = crypto.createHash('sha256').update(parsed.parts?.[0]?.fullTranscript || '').digest('hex').substring(0, 16);

        return {
          id: testId,
          module: options.module,
          section: 'listening',
          targetBand: options.targetBand,
          theme,
          contentHash,
          title: parsed.testTitle || `IELTS Listening: ${theme}`,
          questionTypes: Array.from(new Set(qTypes)) as string[],
          testData: parsed
        };
      }

      case 'writing': {
        const { systemInstruction, userPrompt } = buildWritingPrompt({
          module: options.module,
          targetBand: options.targetBand,
          theme,
          negativeTopics: combinedNegatives,
          task1Type: options.task1Type,
          task2Type: options.task2Type
        });

        let parsed: any;
        try {
          const res = await executeGeminiWithRetry(async () => {
            return await ai.models.generateContent({
              model: 'gemini-3.8-flash',
              contents: userPrompt,
              config: {
                systemInstruction,
                temperature: 0.9,
                responseMimeType: 'application/json',
                responseSchema: writingResponseSchema as any
              }
            });
          });
          parsed = JSON.parse(res.text || '{}');
        } catch (err: any) {
          console.warn('[MockGenerator] Gemini writing error, fallback:', err.message);
          return this.generateFallbackMock(options, theme);
        }

        const contentHash = crypto.createHash('sha256').update(parsed.task2?.prompt || '').digest('hex').substring(0, 16);

        return {
          id: testId,
          module: options.module,
          section: 'writing',
          targetBand: options.targetBand,
          theme,
          contentHash,
          title: parsed.testTitle || `IELTS Writing: ${theme}`,
          questionTypes: [parsed.task1?.taskType, parsed.task2?.essayType].filter(Boolean),
          testData: parsed
        };
      }

      case 'speaking': {
        const { systemInstruction, userPrompt } = buildSpeakingPrompt({
          targetBand: options.targetBand,
          theme,
          negativeTopics: combinedNegatives,
          cueCardCategory: options.cueCardCategory
        });

        let parsed: any;
        try {
          const res = await executeGeminiWithRetry(async () => {
            return await ai.models.generateContent({
              model: 'gemini-3.8-flash',
              contents: userPrompt,
              config: {
                systemInstruction,
                temperature: 0.9,
                responseMimeType: 'application/json',
                responseSchema: speakingResponseSchema as any
              }
            });
          });
          parsed = JSON.parse(res.text || '{}');
        } catch (err: any) {
          console.warn('[MockGenerator] Gemini speaking error, fallback:', err.message);
          return this.generateFallbackMock(options, theme);
        }

        const contentHash = crypto.createHash('sha256').update(parsed.part2?.cueCardPrompt || '').digest('hex').substring(0, 16);

        return {
          id: testId,
          module: options.module,
          section: 'speaking',
          targetBand: options.targetBand,
          theme,
          contentHash,
          title: parsed.testTitle || `IELTS Speaking: ${theme}`,
          questionTypes: ['part1_interview', 'part2_cuecard', 'part3_discussion'],
          testData: parsed
        };
      }

      case 'full_mock': {
        // Coordinated Full Mock Generation
        const [reading, listening, writing, speaking] = await Promise.all([
          this.generateMock({ ...options, section: 'reading' }, combinedNegatives),
          this.generateMock({ ...options, section: 'listening' }, combinedNegatives),
          this.generateMock({ ...options, section: 'writing' }, combinedNegatives),
          this.generateMock({ ...options, section: 'speaking' }, combinedNegatives)
        ]);

        return {
          id: testId,
          module: options.module,
          section: 'full_mock',
          targetBand: options.targetBand,
          theme,
          contentHash: `${reading.contentHash}-${writing.contentHash}`,
          title: `Full IELTS ${options.module.toUpperCase()} Examination: ${theme}`,
          questionTypes: ['full_exam_all_sections'],
          testData: {
            reading: reading.testData,
            listening: listening.testData,
            writing: writing.testData,
            speaking: speaking.testData,
            isFullMock: true
          }
        };
      }
    }
  }

  private generateFallbackMock(options: GenerateMockRequest, theme: string): GenerationResult {
    const testId = `mock_demo_${Date.now()}`;
    return {
      id: testId,
      module: options.module,
      section: options.section,
      targetBand: options.targetBand,
      theme,
      contentHash: 'demo-hash-01',
      title: `IELTS ${options.section.toUpperCase()}: ${theme} (Standard Model)`,
      questionTypes: ['multiple_choice', 'true_false_not_given', 'sentence_completion'],
      testData: {
        testTitle: `IELTS ${options.section.toUpperCase()}: ${theme}`,
        module: options.module,
        targetBand: options.targetBand,
        theme,
        passages: [
          {
            passageNumber: 1,
            title: `The Architecture of ${theme}`,
            subheading: 'Exploring contemporary developments and historical evolution',
            content: `[A] Recent developments in ${theme} have fundamentally shifted how researchers conceptualise systemic changes. In early twentieth-century scholarship, empirical investigations were frequently constrained by rudimentary observational apparatus. Consequently, initial postulates emphasized mechanical causality over complex dynamic equilibria.\n\n[B] However, the advent of high-resolution digital telemetry in the late 1990s precipitated a transformative paradigm shift. Cross-institutional consortiums began aggregating longitudinal datasets spanning multiple continents, revealing subtle interdependencies that previous deterministic frameworks failed to anticipate.\n\n[C] In contemporary discourse, scholarly consensus underscores three interrelated pillars: first, rigorous baseline quantification; second, dynamic mitigation strategies; and third, democratic stakeholder engagement. Without proactive integration of these elements, policy interventions frequently yield unintended collateral repercussions.`,
            wordCount: 820,
            questions: [
              {
                id: 'q1',
                questionNumber: 1,
                type: 'true_false_not_given',
                prompt: 'Early twentieth-century research into this domain possessed sophisticated computational tools.',
                instructions: 'Write TRUE if the statement agrees with the information, FALSE if it contradicts, or NOT GIVEN if there is no information.',
                correctAnswer: 'FALSE',
                explanation: 'Paragraph [A] explicitly states that investigations were "constrained by rudimentary observational apparatus", which directly contradicts the claim that they possessed sophisticated computational tools.',
                targetSkill: 'Direct factual contradiction'
              },
              {
                id: 'q2',
                questionNumber: 2,
                type: 'sentence_completion',
                prompt: 'The emergence of high-resolution digital telemetry triggered a transformative ________ in the late 1990s.',
                instructions: 'Choose NO MORE THAN TWO WORDS from the passage for each answer.',
                correctAnswer: 'paradigm shift',
                acceptableAnswers: ['paradigm shift', 'shift'],
                explanation: 'Paragraph [B] states: "precipitated a transformative paradigm shift".',
                targetSkill: 'Exact text retrieval'
              }
            ]
          }
        ]
      }
    };
  }
}

export const mockGeneratorService = new MockGeneratorService();
