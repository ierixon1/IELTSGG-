/**
 * A small, deterministic full-exam fixture for browser verification.
 *
 *   STORAGE_BACKEND=local npm run seed:exam-fixture
 *
 * Publishes, through the ordinary material publish gate, exactly what a full
 * CDI bundle needs and nothing more:
 *
 *   Listening Parts 1–4   ten questions each (40), each with a real (generated) WAV recording
 *   Reading Passages 1–3  13, 13 and 14 questions (40)
 *   Writing               Task 1 and Task 2
 *   Speaking              Parts 1, 2 and 3
 *
 * The counts are the IELTS ones, which the bundle gate enforces. In each
 * section the first two questions are written out; the rest are numbered gaps
 * whose answer is `part<P>q<N>` (Listening) or `passage<P>q<N>` (Reading),
 * N being the question number within that part.
 *
 * No AI is involved and nothing is random: the same run produces the same
 * content, so the answers a tester types are known in advance. It does not
 * create the bundle — that is done in the Bundle Builder, which is what is
 * being verified. Running it again reuses materials it already published.
 *
 * Local storage only. It refuses to run against Firestore, so it can never
 * seed a production project.
 */
import 'dotenv/config';

if (process.env.STORAGE_BACKEND !== 'local') {
  console.error('seed:exam-fixture writes to the local store only. Run it with STORAGE_BACKEND=local.');
  process.exit(78);
}

const { adminStore } = await import('../src/services/adminStore');
const { assetStore } = await import('../src/services/assetStore');
const { materialContentHash } = await import('../src/services/materialVersion');

type Section = 'listening' | 'reading' | 'writing' | 'speaking';

const PREFIX = 'E2E Fixture';

/** A mono 16-bit WAV of a plain tone: real, playable audio with no content to transcribe. */
function toneWav(seconds: number, frequency: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 6000), 44 + i * 2);
  return buffer;
}

const shortAnswer = (id: string, questionNumber: number, prompt: string, correctAnswer: string) => ({
  id,
  questionNumber,
  type: 'short_answer',
  prompt,
  wordLimit: 'ONE WORD ONLY',
  correctAnswer,
});

const choice = (id: string, questionNumber: number, prompt: string, options: string[], correctAnswer: string) => ({
  id,
  questionNumber,
  type: 'multiple_choice',
  prompt,
  options,
  correctAnswer,
});

const LISTENING = [
  { title: 'Booking a sports centre', q1: ['Which day is the free trial? Write ONE WORD.', 'saturday'], q2: ['How is the fee paid?', ['A monthly', 'B yearly', 'C per visit'], 'A monthly'] },
  { title: 'A museum tour', q1: ['Which floor has the map room? Write ONE WORD.', 'third'], q2: ['What must visitors leave at the desk?', ['A coats', 'B bags', 'C cameras'], 'B bags'] },
  { title: 'Planning a field trip', q1: ['What will the students measure first? Write ONE WORD.', 'temperature'], q2: ['When is the report due?', ['A Monday', 'B Wednesday', 'C Friday'], 'C Friday'] },
  { title: 'A lecture on city bees', q1: ['In which season do colonies grow fastest? Write ONE WORD.', 'spring'], q2: ['What do rooftop hives need most?', ['A shelter', 'B sunlight', 'C water'], 'A shelter'] },
] as const;

const READING = [
  { title: 'The urban fox', text: 'Foxes have adapted to cities by changing their diet and hunting at night. Researchers tracked forty animals across one city for two years and found that most never left an area of two square kilometres.', q1: ['When do urban foxes mostly hunt? Write ONE WORD.', 'night'], q2: ['How long did the tracking study last?', ['A one year', 'B two years', 'C four years'], 'B two years'] },
  { title: 'Salt and trade', text: 'Before refrigeration, salt preserved food through long winters. Soldiers were sometimes paid in salt, and several desert trade routes existed mainly to carry it south.', q1: ['What did salt preserve? Write ONE WORD.', 'food'], q2: ['Who was sometimes paid in salt?', ['A farmers', 'B soldiers', 'C sailors'], 'B soldiers'] },
  { title: 'Sleep and memory', text: 'During deep sleep the brain replays the experiences of the day. People who sleep after learning a list of words recall more of it than people who stay awake.', q1: ['During which kind of sleep does the brain replay the day? Write ONE WORD.', 'deep'], q2: ['Who recalls more of a word list?', ['A people who sleep', 'B people who stay awake', 'C there is no difference'], 'A people who sleep'] },
] as const;

/** Questions 3 onwards of a part: numbered gaps with a rule-based answer. */
const gaps = (idPrefix: string, answerPrefix: string, from: number, count: number, firstNumber: number) =>
  Array.from({ length: count - from + 1 }, (_, offset) => {
    const index = from + offset;
    return shortAnswer(`${idPrefix}-q${index}`, firstNumber + index - 1, `Fixture gap ${index}. Write ONE WORD.`, `${answerPrefix}q${index}`);
  });

const LISTENING_PER_PART = 10;
const READING_PER_PASSAGE: Record<number, number> = { 1: 13, 2: 13, 3: 14 };
const readingFirstNumber = (part: number) => 1 + [1, 2].filter((earlier) => earlier < part).reduce((sum, earlier) => sum + READING_PER_PASSAGE[earlier], 0);

function listeningPayload(part: number, audioAssetId: string) {
  const spec = LISTENING[part - 1];
  return {
    title: `${PREFIX} Listening Part ${part}: ${spec.title}`,
    section: 'listening',
    module: 'academic',
    theme: 'E2E fixture',
    targetBand: '6.5',
    content: {
      audioAssetId,
      transcript: `Script of fixture part ${part}.`,
      section: {
        sectionNumber: part,
        title: `Part ${part}: ${spec.title}`,
        contextDescription: `Fixture recording for part ${part}.`,
        audioTranscript: `Script of fixture part ${part}.`,
        questions: [
          shortAnswer(`e2e-lis-p${part}-q1`, (part - 1) * LISTENING_PER_PART + 1, spec.q1[0], spec.q1[1]),
          choice(`e2e-lis-p${part}-q2`, (part - 1) * LISTENING_PER_PART + 2, spec.q2[0], [...spec.q2[1]], spec.q2[2]),
          ...gaps(`e2e-lis-p${part}`, `part${part}`, 3, LISTENING_PER_PART, (part - 1) * LISTENING_PER_PART + 1),
        ],
      },
    },
  };
}

function readingPayload(part: number) {
  const spec = READING[part - 1];
  return {
    title: `${PREFIX} Reading Passage ${part}: ${spec.title}`,
    section: 'reading',
    module: 'academic',
    theme: 'E2E fixture',
    targetBand: '6.5',
    content: {
      passage: {
        passageNumber: part,
        title: spec.title,
        text: spec.text,
        questions: [
          shortAnswer(`e2e-rea-p${part}-q1`, readingFirstNumber(part), spec.q1[0], spec.q1[1]),
          choice(`e2e-rea-p${part}-q2`, readingFirstNumber(part) + 1, spec.q2[0], [...spec.q2[1]], spec.q2[2]),
          ...gaps(`e2e-rea-p${part}`, `passage${part}`, 3, READING_PER_PASSAGE[part], readingFirstNumber(part)),
        ],
      },
    },
  };
}

const writingPayload = {
  title: `${PREFIX} Writing: commuting and remote work`,
  section: 'writing',
  module: 'academic',
  theme: 'E2E fixture',
  targetBand: '6.5',
  content: {
    task: {
      task1: { title: 'Task 1', prompt: 'The chart shows how commuters in one city travelled to work in 2000 and 2020: by bus, by train and by bicycle. Summarise the information by selecting and reporting the main features, and make comparisons where relevant.' },
      task2: { title: 'Task 2', prompt: 'Some people believe that working from home will make city centres unnecessary. To what extent do you agree or disagree? Give reasons for your answer.' },
    },
  },
};

const speakingPayload = {
  title: `${PREFIX} Speaking: places and travel`,
  section: 'speaking',
  module: 'academic',
  theme: 'E2E fixture',
  targetBand: '6.5',
  content: {
    speakingSession: {
      part1: { topic: 'Your hometown', questions: ['Where is your hometown?', 'What do you like most about it?'] },
      part2: { cueCardTopic: 'Describe a place you visited that surprised you', bulletPoints: ['where it was', 'when you went', 'what surprised you'] },
      part3: { questions: ['Why do people travel abroad?', 'How has tourism changed cities?'] },
    },
  },
};

async function publish(section: Section, payload: { title: string }): Promise<string> {
  const existing = (await adminStore.listMaterials(section, 'published')).find((material) => material.title === payload.title);
  if (existing) return existing.id;
  const saved = await adminStore.saveMaterial(section, payload, 'E2E fixture');
  const known = new Set((await assetStore.list()).map((asset) => asset.id));
  const result = await adminStore.setMaterialStatus(section, saved.id, 'published', { assetExists: (id) => known.has(id) });
  if (!result.ok) throw new Error(`${payload.title} was refused by the publish gate: ${result.blockers.map((blocker) => blocker.message).join(' | ')}`);
  return saved.id;
}

const created: Array<{ slot: string; id: string; title: string; contentHash: string; audioAssetId?: string }> = [];
const record = async (slot: string, section: Section, id: string, audioAssetId?: string) => {
  const material = await adminStore.getMaterial(section, id);
  if (!material) throw new Error(`${id} vanished after publishing.`);
  created.push({ slot, id, title: material.title, contentHash: materialContentHash(material), ...(audioAssetId ? { audioAssetId } : {}) });
};

for (const part of [1, 2, 3, 4]) {
  const title = listeningPayload(part, '').title;
  const existing = (await adminStore.listMaterials('listening', 'published')).find((material) => material.title === title);
  let audioAssetId = existing?.section === 'listening' ? existing.content.audioAssetId : undefined;
  if (!audioAssetId) {
    const audio = await assetStore.create({
      originalName: `e2e-fixture-listening-part-${part}.wav`,
      content: toneWav(4, 330 + part * 110),
      mimeType: 'audio/wav',
      kind: 'audio',
      createdBy: 'e2e-fixture',
      sourceType: 'upload',
    });
    audioAssetId = audio.id;
  }
  await record(`listening-${part}`, 'listening', await publish('listening', listeningPayload(part, audioAssetId)), audioAssetId);
}
for (const part of [1, 2, 3]) await record(`reading-${part}`, 'reading', await publish('reading', readingPayload(part)));
await record('writing', 'writing', await publish('writing', writingPayload));
await record('speaking', 'speaking', await publish('speaking', speakingPayload));

console.log(JSON.stringify({ fixture: PREFIX, materials: created }, null, 2));
