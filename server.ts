import express from 'express';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import { authenticateRequest, AuthenticatedRequest } from './src/middleware/authMiddleware';
import { dataStore, storageProvider } from './src/services/storage';
import { mockGeneratorService } from './src/services/mockGenerator';
import { GenerateMockRequestSchema } from './src/schemas/mockGeneratorSchema';
import {
  IELTS_THEMES,
  READING_QUESTION_TYPES,
  LISTENING_QUESTION_TYPES,
  WRITING_TASK1_ACADEMIC_TYPES,
  WRITING_TASK2_TYPES,
  SPEAKING_PART2_CATEGORIES
} from './src/config/ieltsTaxonomy';
import { executeGeminiWithRetry } from './prompts/geminiRetry';
import { adminRouter } from './src/routes/adminRoutes';
import { UPLOADS_DIR } from './src/services/adminStore';

dotenv.config();

const app = express();
const PORT = 3000;

// Rate-limiting configuration
const RATE_LIMIT_GENERATIONS = parseInt(process.env.RATE_LIMIT_GENERATIONS || '10', 10);
const RATE_LIMIT_UPLOADS = parseInt(process.env.RATE_LIMIT_UPLOADS || '3', 10);

// Middleware for parsing JSON with ample capacity for base64 audio snippets
app.use(express.json({ limit: '50mb' }));

// Static uploads serving for admin audio, images, diagrams, documents
app.use('/api/uploads', express.static(UPLOADS_DIR));

// Admin CMS Router (Protected with its own role-based token middleware)
app.use('/api/admin', adminRouter);

app.use('/api', authenticateRequest);

// Lazy/Safe initialization of GoogleGenAI client
let genAIClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!genAIClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('GEMINI_API_KEY is not set. Mock/fallback evaluation will be provided.');
    }
    genAIClient = new GoogleGenAI({
      apiKey: apiKey || 'dummy-key',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return genAIClient;
}

// Local storage file for persistent user data (single-user personal prep)
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDbFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    const defaultData = {
      profile: {
        id: 'user_1',
        targetBand: 7.5,
        currentLevel: 6.0,
        hoursPerWeek: 12,
        weakSection: 'writing',
        isOnboarded: false,
      },
      tasks: [],
      attempts: [],
      checklist: {
        weekNumber: 1,
        weekStart: new Date().toISOString().split('T')[0],
        mocksDone: 0,
        mocksTarget: 2,
        essaysDone: 0,
        essaysTarget: 4,
        speakingDone: 0,
        speakingTarget: 5,
      },
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2));
  }
}

function readDb() {
  ensureDbFile();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading db:', err);
    return {};
  }
}

function writeDb(data: any) {
  ensureDbFile();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing db:', err);
  }
}

// ---------------------------------------------------------------------------
// 1. HEALTH & DATA PERSISTENCE API
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', hasGeminiKey: !!process.env.GEMINI_API_KEY });
});

app.get('/api/data', (req, res) => {
  const db = readDb();
  res.json(db);
});

app.post('/api/data/sync', (req, res) => {
  const current = readDb();
  const updated = {
    ...current,
    ...req.body,
  };
  writeDb(updated);
  res.json({ success: true, data: updated });
});

// ---------------------------------------------------------------------------
// 1B. TAXONOMY CATALOG & QUOTA API
// ---------------------------------------------------------------------------
app.get('/api/taxonomy', (req, res) => {
  res.json({
    themes: IELTS_THEMES,
    readingQuestionTypes: READING_QUESTION_TYPES,
    listeningQuestionTypes: LISTENING_QUESTION_TYPES,
    writingTask1AcademicTypes: WRITING_TASK1_ACADEMIC_TYPES,
    writingTask2Types: WRITING_TASK2_TYPES,
    speakingPart2Categories: SPEAKING_PART2_CATEGORIES,
  });
});

app.get('/api/quotas', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.userId || 'usr_student_preview';
    const quota = await dataStore.getDailyQuota(userId);
    res.json({
      date: quota.dateStr,
      generations: {
        used: quota.generationsCount,
        max: RATE_LIMIT_GENERATIONS,
        remaining: Math.max(0, RATE_LIMIT_GENERATIONS - quota.generationsCount),
      },
      uploads: {
        used: quota.uploadsCount,
        max: RATE_LIMIT_UPLOADS,
        remaining: Math.max(0, RATE_LIMIT_UPLOADS - quota.uploadsCount),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 1C. MOCK TEST GENERATOR API (Feature 1: Zod validation + anti-repeat + rate limits)
// ---------------------------------------------------------------------------
app.post('/api/mocks/generate', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.userId || 'usr_student_preview';

    // 1. Zod schema validation
    const parsedRequest = GenerateMockRequestSchema.safeParse(req.body);
    if (!parsedRequest.success) {
      return res.status(400).json({
        error: 'Invalid request payload format.',
        details: parsedRequest.error.issues,
      });
    }

    // 2. Rate-limiting check
    const quota = await dataStore.getDailyQuota(userId);
    if (quota.generationsCount >= RATE_LIMIT_GENERATIONS) {
      return res.status(429).json({
        error: `Daily generation limit reached (${RATE_LIMIT_GENERATIONS} tests per day). Please resume tomorrow.`,
        quota: {
          used: quota.generationsCount,
          max: RATE_LIMIT_GENERATIONS,
        },
      });
    }

    // 3. Anti-repeat: fetch last 20 tests and extract themes
    const recentTests = await dataStore.getRecentGenerations(userId, 20);
    const recentThemes = recentTests.map(t => t.theme).filter(Boolean);

    // 4. Generate mock test via service (calls Gemini with temperature=0.9 and retry backoff)
    const result = await mockGeneratorService.generateMock(parsedRequest.data, recentThemes);

    // 5. Store generated test and increment daily quota
    await dataStore.recordGeneratedTest(userId, {
      id: result.id,
      userId,
      timestamp: new Date().toISOString(),
      module: result.module,
      section: result.section,
      targetBand: result.targetBand,
      theme: result.theme,
      contentHash: result.contentHash,
      title: result.title,
      questionTypes: result.questionTypes,
      data: result.testData,
    });

    const updatedQuota = await dataStore.incrementGenerationCount(userId);

    res.json({
      success: true,
      test: result,
      remainingGenerations: Math.max(0, RATE_LIMIT_GENERATIONS - updatedQuota.generationsCount),
      recentThemesCount: recentThemes.length,
    });
  } catch (error: any) {
    console.error('Mock generation error:', error);
    const isRateLimit = error.message?.includes('rate limit') || error.message?.includes('quota');
    const statusCode = isRateLimit ? 429 : 500;
    res.status(statusCode).json({
      error: error.message || 'Failed to generate mock test. Please try again.',
    });
  }
});

app.get('/api/mocks/history', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.userId || 'usr_student_preview';
    const limit = parseInt(req.query.limit as string || '20', 10);
    const tests = await dataStore.getRecentGenerations(userId, limit);
    res.json({
      tests: tests.map(t => ({
        id: t.id,
        timestamp: t.timestamp,
        module: t.module,
        section: t.section,
        targetBand: t.targetBand,
        theme: t.theme,
        title: t.title,
        questionTypes: t.questionTypes,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/mocks/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.userId || 'usr_student_preview';
    const test = await dataStore.getGeneratedTestById(userId, req.params.id);
    if (!test) {
      return res.status(404).json({ error: 'Mock test not found.' });
    }
    res.json(test);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// 2. AI WRITING GRADING ENGINE (Single Gemini Call with Structured JSON)
// ---------------------------------------------------------------------------
app.post('/api/grade/writing', async (req, res) => {
  try {
    const { taskType, prompt, essay } = req.body;

    if (!essay || typeof essay !== 'string' || essay.trim().length === 0) {
      return res.status(400).json({ error: 'Essay text is required for grading.' });
    }

    const words = essay.trim().split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const minWords = taskType === 'task1' ? 150 : 250;
    const meetsWordLimit = wordCount >= minWords;

    if (!process.env.GEMINI_API_KEY) {
      // Deterministic realistic fallback if API key is not yet provided in runtime
      const mockResult = generateFallbackWritingFeedback(taskType, essay, wordCount, minWords);
      return res.json(mockResult);
    }

    const ai = getGenAI();

    const isTask1 = taskType === 'task1';
    const firstCriterionName = isTask1 ? 'task_achievement' : 'task_response';

    const systemInstruction = `You are a certified, senior Academic IELTS Examiner.
Evaluate the candidate's IELTS Writing ${isTask1 ? 'Task 1' : 'Task 2'} essay strictly and rigorously according to the official IELTS Band Descriptors (0 to 9 scale).
Do not inflate or deflate marks out of courtesy. Adhere faithfully to the official standards:
- ${isTask1 ? 'Task Achievement' : 'Task Response'}: Key trends, clear overview, supporting data, addressing all parts of the prompt.
- Coherence and Cohesion: Logical sequencing, paragraphing, cohesive devices (penalize mechanical or repetitive linking).
- Lexical Resource: Range of academic vocabulary, precision, collocations, natural tone, spelling accuracy.
- Grammatical Range and Accuracy: Variety of complex syntactic structures, clause combinations, punctuation and error-free sentences.

Important: Calculate overall band by taking the arithmetic average of the four criteria and rounding using official IELTS rules (if average decimal is .25 or .75, round UP to nearest .5 or whole band).

Identify specific erroneous phrases or awkward collocations in the candidate's actual text and provide annotations with precise spans, issue types ('grammar', 'lexical', 'cohesion'), clear examiner comments, and exact improved suggestions.`;

    const userContent = `IELTS Writing Prompt:
${prompt}

Candidate's Submitted Essay (${wordCount} words):
"""
${essay}
"""

Provide complete multi-criteria assessment in valid JSON conforming to the schema.`;

    const response = await executeGeminiWithRetry(async () => {
      return await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: userContent,
        config: {
          systemInstruction,
          temperature: 0.25,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              band_overall: { type: Type.NUMBER, description: 'Overall IELTS Band from 0.0 to 9.0 in 0.5 increments' },
              criteria: {
                type: Type.ARRAY,
                description: 'The four official assessment criteria',
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING, description: 'Criteria identifier (e.g. task_response, coherence_cohesion, lexical_resource, grammatical_range)' },
                    band: { type: Type.NUMBER, description: 'Band score from 0.0 to 9.0' },
                    justification: { type: Type.STRING, description: 'Direct justification citing official band descriptors' },
                    improvement_tips: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                      description: 'Direct actionable steps to reach the next band level',
                    },
                  },
                  required: ['name', 'band', 'justification', 'improvement_tips'],
                },
              },
              annotated_text: {
                type: Type.ARRAY,
                description: 'Excerpts with issues, suggestions and category',
                items: {
                  type: Type.OBJECT,
                  properties: {
                    span: { type: Type.STRING, description: 'Exact phrase or clause from the essay with error' },
                    issue_type: { type: Type.STRING, description: 'grammar, lexical, cohesion, or task_achievement' },
                    comment: { type: Type.STRING, description: 'Examiner explanation of the issue' },
                    suggestion: { type: Type.STRING, description: 'Band 8-9 improved alternative formulation' },
                  },
                  required: ['span', 'issue_type', 'comment', 'suggestion'],
                },
              },
              general_commentary: { type: Type.STRING, description: 'High-level synthesis of essay strengths and primary bottleneck' },
            },
            required: ['band_overall', 'criteria', 'annotated_text', 'general_commentary'],
          },
        },
      });
    });

    const text = response.text || '{}';
    const parsed = JSON.parse(text);

    parsed.word_count = wordCount;
    parsed.meets_word_limit = meetsWordLimit;

    // Record this essay in DB
    const db = readDb();
    if (db.checklist) {
      db.checklist.essaysDone = (db.checklist.essaysDone || 0) + 1;
      writeDb(db);
    }

    res.json(parsed);
  } catch (error: any) {
    console.error('Writing grading error:', error);
    res.status(500).json({ error: error.message || 'Failed to grade writing submission' });
  }
});

// ---------------------------------------------------------------------------
// 3. AI SPEAKING GRADING ENGINE (Single Gemini Call with Multimodal / Audio)
// ---------------------------------------------------------------------------
app.post('/api/grade/speaking', async (req, res) => {
  try {
    const {
      topic,
      cueCard,
      partNumber,
      audioBase64,
      mimeType,
      transcriptProvided,
      clientMetrics,
    } = req.body;

    if (!audioBase64 && !transcriptProvided) {
      return res.status(400).json({ error: 'Either audio data or transcript is required.' });
    }

    if (!process.env.GEMINI_API_KEY) {
      const fallback = generateFallbackSpeakingFeedback(partNumber, topic, transcriptProvided, clientMetrics);
      return res.json(fallback);
    }

    const ai = getGenAI();

    const systemInstruction = `You are a certified IELTS Speaking Examiner.
Evaluate the candidate's Speaking Part ${partNumber} performance based strictly on the official IELTS Speaking Band Descriptors (0-9):
1. Fluency and Coherence (speech continuity, hesitation/pauses, self-correction, logical cohesion)
2. Lexical Resource (idiomatic phrasing, precision, avoiding repetition, collocations)
3. Grammatical Range and Accuracy (complex structures, tenses, clause variation, error density)
4. Pronunciation (note: marked approximate in UI; evaluate intelligible phonetics, syllable stress, intonation patterns)

Objective client metrics:
${clientMetrics ? JSON.stringify(clientMetrics, null, 2) : 'No client metrics provided.'}

If audio is provided, first transcribe the candidate's exact spoken words verbatim (including fillers like 'um', 'uh', 'like'). If a transcript is already provided, verify and refine it.
Output strictly structured JSON according to the schema.`;

    const parts: any[] = [];

    if (audioBase64) {
      parts.push({
        inlineData: {
          mimeType: mimeType || 'audio/webm',
          data: audioBase64,
        },
      });
    }

    const textPrompt = `IELTS Speaking Part ${partNumber}
Topic: ${topic}
${cueCard ? `Cue Card Points: ${cueCard}` : ''}
${transcriptProvided ? `Transcribed candidate text: "${transcriptProvided}"` : 'Please transcribe the audio and grade accurately.'}
Please provide comprehensive band evaluation and targeted drills.`;

    parts.push({ text: textPrompt });

    const response = await executeGeminiWithRetry(async () => {
      return await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: { parts },
        config: {
          systemInstruction,
          temperature: 0.25,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              band_overall: { type: Type.NUMBER, description: 'Overall Speaking Band (0-9 in 0.5 increments)' },
              transcript: { type: Type.STRING, description: 'Verbatim transcript of candidate response' },
              criteria: {
                type: Type.OBJECT,
                properties: {
                  fluency_coherence: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      band: { type: Type.NUMBER },
                      justification: { type: Type.STRING },
                      improvement_tips: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ['name', 'band', 'justification', 'improvement_tips'],
                  },
                  lexical_resource: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      band: { type: Type.NUMBER },
                      justification: { type: Type.STRING },
                      improvement_tips: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ['name', 'band', 'justification', 'improvement_tips'],
                  },
                  grammatical_range: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      band: { type: Type.NUMBER },
                      justification: { type: Type.STRING },
                      improvement_tips: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ['name', 'band', 'justification', 'improvement_tips'],
                  },
                  pronunciation: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      band: { type: Type.NUMBER },
                      justification: { type: Type.STRING },
                      improvement_tips: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ['name', 'band', 'justification', 'improvement_tips'],
                  },
                },
                required: ['fluency_coherence', 'lexical_resource', 'grammatical_range', 'pronunciation'],
              },
              objective_metrics: {
                type: Type.OBJECT,
                properties: {
                  durationSeconds: { type: Type.NUMBER },
                  wordsPerMinute: { type: Type.NUMBER },
                  pausesCount: { type: Type.NUMBER },
                  totalPauseDurationSeconds: { type: Type.NUMBER },
                  fillerWords: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        word: { type: Type.STRING },
                        count: { type: Type.NUMBER },
                      },
                      required: ['word', 'count'],
                    },
                  },
                },
                required: ['durationSeconds', 'wordsPerMinute', 'pausesCount', 'totalPauseDurationSeconds', 'fillerWords'],
              },
              actionable_drills: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: '3 concrete micro-exercises to boost band score',
              },
            },
            required: ['band_overall', 'transcript', 'criteria', 'objective_metrics', 'actionable_drills'],
          },
        },
      });
    });

    const parsed = JSON.parse(response.text || '{}');

    // Update DB checklist
    const db = readDb();
    if (db.checklist) {
      db.checklist.speakingDone = (db.checklist.speakingDone || 0) + 1;
      writeDb(db);
    }

    res.json(parsed);
  } catch (error: any) {
    console.error('Speaking grading error:', error);
    res.status(500).json({ error: error.message || 'Failed to grade speaking response' });
  }
});

// ---------------------------------------------------------------------------
// 4. PREPPY AI MENTOR CHAT ENDPOINT
// ---------------------------------------------------------------------------
app.post('/api/preppy/chat', async (req, res) => {
  try {
    const { messages, userContext } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required.' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.json({
        reply: `Hello! I am Preppy AI, your personal IELTS mentor.
Based on your current focus on ${userContext?.weakSection || 'Writing'}, remember that Band 7+ requires demonstrating flexible use of complex sentence structures and natural collocations rather than cramming archaic synonyms. How can I assist you with your prep today?`,
      });
    }

    const ai = getGenAI();

    const systemInstruction = `You are Preppy AI, an encouraging, sharp, and highly strategic Academic IELTS Mentor.
You provide high-impact, concise IELTS preparation advice:
- Explain specific Band 7-9 requirements and band descriptors.
- Provide high-scoring vocabulary collocations and linking phrases.
- Analyze essay structure (Introduction, 2 Body Paragraphs, Conclusion).
- Guide Speaking Part 2 cue card story structures (e.g. context -> conflict -> action -> reflection).
- Keep answers structured with bullet points and bold key terms.
User profile context: Target Band: ${userContext?.targetBand || 7.5}, Weak Section: ${userContext?.weakSection || 'Writing'}.`;

    const chat = ai.chats.create({
      model: 'gemini-3.8-flash',
      config: {
        systemInstruction,
        temperature: 0.5,
      },
    });

    // Send the latest message with retry protection
    const latestUserMessage = messages[messages.length - 1]?.content || 'Give me advice on IELTS prep.';
    const result = await executeGeminiWithRetry(async () => {
      return await chat.sendMessage({
        message: latestUserMessage,
      });
    });

    res.json({ reply: result.text });
  } catch (error: any) {
    console.error('Preppy chat error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate mentor reply' });
  }
});

// ---------------------------------------------------------------------------
// FALLBACK ENGINES (Ensures 100% offline & key-missing resiliency)
// ---------------------------------------------------------------------------
function generateFallbackWritingFeedback(taskType: string, essay: string, wordCount: number, minWords: number) {
  const isTask1 = taskType === 'task1';
  const baseBand = wordCount < minWords ? 5.5 : wordCount > 280 ? 7.0 : 6.5;

  return {
    band_overall: baseBand,
    criteria: [
      {
        name: isTask1 ? 'task_achievement' : 'task_response',
        band: wordCount < minWords ? 5.0 : baseBand,
        justification: wordCount < minWords
          ? `Word count is ${wordCount}, below the mandatory ${minWords}-word requirement, which automatically restricts Band for Task Achievement/Response.`
          : 'Addresses all parts of the task with a recognizable position and relevant arguments supported by examples.',
        improvement_tips: [
          'Ensure the overview or thesis clearly contrasts the most striking comparative features.',
          'Elaborate main topic sentences with specific factual or illustrative progression.',
        ],
      },
      {
        name: 'coherence_cohesion',
        band: baseBand,
        justification: 'Information and ideas are logically organized with clear progression throughout paragraphs. Cohesive devices are used accurately.',
        improvement_tips: [
          'Vary sentence opening adverbs and use referential pronouns to avoid repetitive connective discourse markers.',
        ],
      },
      {
        name: 'lexical_resource',
        band: baseBand + 0.5 <= 9 ? baseBand + 0.5 : 9,
        justification: 'Demonstrates a good range of academic vocabulary suitable for higher education contexts with minor collocation slips.',
        improvement_tips: [
          'Incorporate topic-specific collocations and ensure natural preposition pairings.',
        ],
      },
      {
        name: 'grammatical_range',
        band: baseBand,
        justification: 'Uses a mix of simple and complex sentence forms with reasonable grammatical control. Occasional punctuation oversights noted.',
        improvement_tips: [
          'Practice inversion and conditional structures (e.g. "Not only did... but also...", "Were governments to intervene...").',
        ],
      },
    ],
    annotated_text: [
      {
        span: essay.slice(0, 30) || 'sample phrase',
        issue_type: 'lexical',
        comment: 'Consider elevating this opening phrase with more formal academic vocabulary.',
        suggestion: 'A notable upward trajectory is evident in...',
      },
    ],
    word_count: wordCount,
    meets_word_limit: wordCount >= minWords,
    general_commentary: `Solid academic writing baseline. ${wordCount < minWords ? 'Priority warning: your essay is under length which costs band score.' : 'Focus on elevating complex syntactic range to push beyond Band 7.0.'}`,
  };
}

function generateFallbackSpeakingFeedback(partNumber: number, topic: string, transcript?: string, clientMetrics?: any) {
  const words = transcript ? transcript.split(/\s+/).length : 85;
  return {
    band_overall: 6.5,
    transcript: transcript || 'Well, speaking about this topic, I would say that technology has definitely transformed how we acquire knowledge in our everyday lives...',
    criteria: {
      fluency_coherence: {
        name: 'fluency_coherence',
        band: 6.5,
        justification: 'Able to speak at length with manageable continuity. Occasional hesitation when formulating complex thoughts, but without loss of coherence.',
        improvement_tips: ['Use discourse fillers like "From my vantage point" or "Looking at this from another perspective" instead of silent blocks.'],
      },
      lexical_resource: {
        name: 'lexical_resource',
        band: 7.0,
        justification: 'Uses vocabulary resource flexibly to discuss a variety of topics, using some less common idioms with awareness of style.',
        improvement_tips: ['Integrate more idiomatic phrasal verbs and topic-specific adjectives.'],
      },
      grammatical_range: {
        name: 'grammatical_range',
        band: 6.5,
        justification: 'Uses a mix of complex structures with generally good control, though subordinate clauses occasionally collapse in fast speech.',
        improvement_tips: ['Maintain subject-verb agreement during spontaneous long compound sentences.'],
      },
      pronunciation: {
        name: 'pronunciation',
        band: 6.5,
        justification: 'Phonological features are generally intelligible with clear sentence stress and appropriate rhythm. (Approximate evaluation).',
        improvement_tips: ['Emphasize key content words and avoid flat monotone intonation during lists.'],
      },
    },
    objective_metrics: clientMetrics || {
      durationSeconds: 110,
      wordsPerMinute: 125,
      pausesCount: 4,
      totalPauseDurationSeconds: 7.2,
      fillerWords: [{ word: 'um', count: 3 }, { word: 'like', count: 2 }],
    },
    actionable_drills: [
      'The 30-Second No-Hesitation Sprint: Speak on a random object without stopping.',
      'Complex Clause Connector Drill: Practice starting responses with "Although...", "Despite...", or "In light of...".',
      'Intonation Pitch Variation: Record sentences and check pitch contrast on verbs.',
    ],
  };
}

// ---------------------------------------------------------------------------
// 5. SERVER LAUNCH & VITE MIDDLEWARE
// ---------------------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PrepIELTS AI Studio Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
