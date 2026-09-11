import './env';
import { describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from './harness';
import type { AdminMaterial } from '../src/types/admin';
import type { BundleComponentRef, FullCdiBundle } from '../src/types/bundle';
import {
  CUSTOM_TIMING,
  FULL_SLOTS,
  asMaterial,
  listeningPayload,
  readingPayload,
  speakingPayload,
  writingPayload,
} from './bundleFixtures';

/**
 * The bundle gate as a pure function: a bundle, the materials its references
 * resolve to, and the assets that exist. Every blocker the phase names is
 * produced here from a single broken fact, so a regression in one rule shows up
 * as exactly one failing case.
 */
process.chdir(mkdtempSync(path.join(os.tmpdir(), 'everstudy-bundle-gate-')));
const { bundleBlockers } = await import('../src/services/bundleGate');
const { materialContentHash } = await import('../src/services/materialVersion');
const { readStoredBundle } = await import('../src/schemas/bundle');

const AUDIO = (part: number) => `ast_audiopart${part}000000`;

function fullMaterials(): AdminMaterial[] {
  return [
    ...[1, 2, 3, 4].map((part) => asMaterial(`lis-${part}`, listeningPayload(part, AUDIO(part)))),
    ...[1, 2, 3].map((part) => asMaterial(`rea-${part}`, readingPayload(part))),
    asMaterial('wri-1', writingPayload()),
    asMaterial('spk-1', speakingPayload()),
  ];
}

const idFor = (section: string, part: number) =>
  section === 'listening' ? `lis-${part}` : section === 'reading' ? `rea-${part}` : section === 'writing' ? 'wri-1' : 'spk-1';

function bundleOver(materials: AdminMaterial[], over: Partial<FullCdiBundle> = {}): FullCdiBundle {
  const byId = new Map(materials.map((material) => [material.id, material]));
  const components: BundleComponentRef[] = FULL_SLOTS.map(({ section, part }) => {
    const material = byId.get(idFor(section, part));
    return { section, part, materialId: idFor(section, part), contentHash: material ? materialContentHash(material) : 'f'.repeat(64) };
  });
  return {
    id: 'cdi-gate',
    schemaVersion: 2,
    title: 'Gate Bundle',
    module: 'academic',
    status: 'draft',
    components,
    timing: CUSTOM_TIMING,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function contextFor(materials: AdminMaterial[], assets: Record<string, string> = defaultAssets()) {
  const byId = new Map(materials.map((material) => [material.id, material]));
  return {
    component: (ref: BundleComponentRef) => {
      const material = byId.get(ref.materialId);
      if (!material) return { material: null, foundInSection: null, needsReview: [], currentHash: null };
      if (material.section !== ref.section) return { material: null, foundInSection: material.section, needsReview: [], currentHash: null };
      return { material, foundInSection: null, needsReview: [], currentHash: materialContentHash(material) };
    },
    asset: (id: string) => ({ exists: id in assets, kind: assets[id] ?? null }),
  };
}

function defaultAssets(): Record<string, string> {
  return Object.fromEntries([1, 2, 3, 4].map((part) => [AUDIO(part), 'audio']));
}

const codesOf = (bundle: FullCdiBundle, materials: AdminMaterial[], assets?: Record<string, string>) =>
  bundleBlockers(bundle, contextFor(materials, assets)).map((blocker) => blocker.code);

const replace = (materials: AdminMaterial[], id: string, next: AdminMaterial) => materials.map((material) => (material.id === id ? next : material));

describe('a valid Full CDI bundle', () => {
  it('has no blockers when every section, part, pin, audio file and timing is right', () => {
    const materials = fullMaterials();
    expect(bundleBlockers(bundleOver(materials), contextFor(materials))).toEqual([]);
  });
});

describe('what a bundle is made of', () => {
  it('names each missing section', () => {
    const materials = fullMaterials();
    for (const section of ['listening', 'reading', 'writing', 'speaking'] as const) {
      const bundle = bundleOver(materials);
      bundle.components = bundle.components.filter((ref) => ref.section !== section);
      expect(codesOf(bundle, materials)).toContain(`${section}_missing`);
    }
  });

  it('names a missing Listening part and a missing Reading passage', () => {
    const materials = fullMaterials();
    const bundle = bundleOver(materials);
    bundle.components = bundle.components.filter((ref) => !(ref.section === 'listening' && ref.part === 4) && !(ref.section === 'reading' && ref.part === 2));
    const blockers = bundleBlockers(bundle, contextFor(materials));
    expect(blockers.filter((blocker) => blocker.code === 'part_missing').map((blocker) => `${blocker.section}-${blocker.part}`)).toEqual(['listening-4', 'reading-2']);
  });

  it('refuses a part filled twice and the same material used twice', () => {
    const materials = fullMaterials();
    const bundle = bundleOver(materials);
    const first = bundle.components.find((ref) => ref.section === 'reading' && ref.part === 1)!;
    bundle.components.push({ ...first });
    const codes = codesOf(bundle, materials);
    expect(codes).toContain('part_duplicate');
    expect(codes).toContain('duplicate_material');
  });

  it('refuses a material pinned into a part it is not printed as', () => {
    const materials = fullMaterials();
    const bundle = bundleOver(materials);
    const slot3 = bundle.components.find((ref) => ref.section === 'reading' && ref.part === 3)!;
    const passage2 = materials.find((material) => material.id === 'rea-2')!;
    slot3.materialId = 'rea-2';
    slot3.contentHash = materialContentHash(passage2);
    const slot2 = bundle.components.find((ref) => ref.section === 'reading' && ref.part === 2)!;
    slot2.materialId = 'rea-3';
    slot2.contentHash = materialContentHash(materials.find((material) => material.id === 'rea-3')!);
    expect(codesOf(bundle, materials)).toContain('part_mismatch');
  });

  it('refuses a part number the section does not have', () => {
    const materials = fullMaterials();
    const bundle = bundleOver(materials);
    bundle.components.push({ section: 'reading', part: 4, materialId: 'rea-extra', contentHash: 'e'.repeat(64) });
    expect(codesOf(bundle, materials)).toContain('invalid_configuration');
  });
});

describe('what each reference resolves to', () => {
  it('reports a material that does not exist', () => {
    const materials = fullMaterials().filter((material) => material.id !== 'spk-1');
    expect(codesOf(bundleOver(fullMaterials()), materials)).toContain('component_not_found');
  });

  it('reports a material from the wrong section', () => {
    const materials = fullMaterials();
    const bundle = bundleOver(materials);
    const speaking = bundle.components.find((ref) => ref.section === 'speaking')!;
    speaking.materialId = 'rea-1';
    expect(codesOf(bundle, materials)).toContain('section_mismatch');
  });

  it('refuses an unpublished component and an archived one', () => {
    const materials = fullMaterials();
    const draft = replace(materials, 'rea-1', asMaterial('rea-1', readingPayload(1), 'draft'));
    expect(codesOf(bundleOver(draft), draft)).toContain('component_unpublished');
    const archived = replace(materials, 'wri-1', asMaterial('wri-1', writingPayload(), 'archived'));
    expect(codesOf(bundleOver(archived), archived)).toContain('component_archived');
  });

  it('refuses a component from the other module', () => {
    const materials = replace(fullMaterials(), 'spk-1', asMaterial('spk-1', speakingPayload('general')));
    expect(codesOf(bundleOver(materials), materials)).toContain('module_mismatch');
  });

  it('refuses a component whose content changed since it was pinned, and one never pinned', () => {
    const materials = fullMaterials();
    const pinned = bundleOver(materials);
    const edited = readingPayload(2);
    edited.content.passage.questions[0].prompt = 'An edited question';
    const after = replace(materials, 'rea-2', asMaterial('rea-2', edited));
    expect(codesOf(pinned, after)).toContain('component_changed');

    const unpinned = bundleOver(materials);
    unpinned.components[0].contentHash = '';
    expect(codesOf(unpinned, materials)).toContain('component_unpinned');
  });
});

/**
 * IELTS paper sizes (ielts.org, Listening and Reading test format): four Listening
 * parts with 10 questions each; 40 Reading questions across the section, in any
 * split between passages. The published raw-score tables are out of 40.
 */
describe('how many questions a full exam has', () => {
  const withQuestions = (payload: ReturnType<typeof listeningPayload> | ReturnType<typeof readingPayload>, count: number) => {
    const copy = structuredClone(payload);
    const questions = 'section' in copy.content ? copy.content.section.questions : copy.content.passage.questions;
    questions.splice(count);
    return copy;
  };

  it('refuses a Listening part without exactly 10 questions', () => {
    const materials = replace(fullMaterials(), 'lis-2', asMaterial('lis-2', withQuestions(listeningPayload(2, AUDIO(2)), 9)));
    const blockers = bundleBlockers(bundleOver(materials), contextFor(materials));
    expect(blockers.map((blocker) => [blocker.code, blocker.section, blocker.part])).toEqual([['question_count', 'listening', 2]]);
    expect(blockers[0].message).toContain('9 questions');
  });

  it('refuses a Reading section without exactly 40 questions, whatever the split', () => {
    const short = replace(fullMaterials(), 'rea-3', asMaterial('rea-3', withQuestions(readingPayload(3), 13)));
    const blockers = bundleBlockers(bundleOver(short), contextFor(short));
    expect(blockers.map((blocker) => [blocker.code, blocker.section])).toEqual([['question_count', 'reading']]);
    expect(blockers[0].message).toContain('39 questions');

    // 13 + 13 + 14 is not the only valid split: 10 + 16 + 14 is also 40.
    const resplit = replace(
      replace(fullMaterials(), 'rea-1', asMaterial('rea-1', withQuestions(readingPayload(1), 10))),
      'rea-2',
      asMaterial('rea-2', (() => {
        const payload = readingPayload(2);
        for (let index = 14; index <= 16; index++) {
          payload.content.passage.questions.push({ id: `rea-p2-q${index}`, questionNumber: index, type: 'short_answer', prompt: `Extra ${index}`, correctAnswer: `extra${index}` });
        }
        return payload;
      })()),
    );
    expect(bundleBlockers(bundleOver(resplit), contextFor(resplit))).toEqual([]);
  });

  it('does not add a count blocker on top of a missing Reading passage', () => {
    const materials = fullMaterials();
    const bundle = bundleOver(materials);
    bundle.components = bundle.components.filter((ref) => !(ref.section === 'reading' && ref.part === 2));
    expect(codesOf(bundle, materials)).toEqual(['part_missing']);
  });
});

describe('what each component contains', () => {
  it('refuses an invalid question set', () => {
    const broken = readingPayload(1);
    (broken.content.passage.questions[0] as { type: string }).type = 'mystery_type';
    const materials = replace(fullMaterials(), 'rea-1', asMaterial('rea-1', broken));
    expect(codesOf(bundleOver(materials), materials)).toContain('invalid_question_set');
  });

  it('refuses Writing without both tasks and Speaking without all three parts', () => {
    const noTask2 = replace(fullMaterials(), 'wri-1', asMaterial('wri-1', writingPayload('academic', { task2: false })));
    expect(codesOf(bundleOver(noTask2), noTask2)).toContain('invalid_question_set');

    const speaking = speakingPayload();
    speaking.content.speakingSession.part3.questions = [];
    const noPart3 = replace(fullMaterials(), 'spk-1', asMaterial('spk-1', speaking));
    expect(codesOf(bundleOver(noPart3), noPart3)).toContain('invalid_question_set');
  });

  it('refuses Listening with no audio, with audio that is gone, and with a file that is not audio', () => {
    const silent = replace(fullMaterials(), 'lis-2', asMaterial('lis-2', listeningPayload(2, undefined)));
    expect(codesOf(bundleOver(silent), silent)).toContain('audio_missing');

    const materials = fullMaterials();
    const gone = defaultAssets();
    delete gone[AUDIO(3)];
    expect(codesOf(bundleOver(materials), materials, gone)).toContain('audio_missing');

    const notAudio = { ...defaultAssets(), [AUDIO(1)]: 'image' };
    expect(codesOf(bundleOver(materials), materials, notAudio)).toContain('audio_missing');
  });

  it('refuses a component whose other assets are missing', () => {
    const payload = readingPayload(1);
    const withImage = { ...payload, content: { ...payload.content, assetIds: ['ast_missingimage00000'] } };
    const materials = replace(fullMaterials(), 'rea-1', asMaterial('rea-1', withImage as ReturnType<typeof readingPayload>));
    expect(codesOf(bundleOver(materials), materials)).toContain('asset_missing');
  });
});

describe('how a bundle is configured', () => {
  it('refuses a duration that is not a positive whole number of minutes', () => {
    const materials = fullMaterials();
    expect(codesOf(bundleOver(materials, { timing: { ...CUSTOM_TIMING, readingMinutes: 0 } }), materials)).toContain('invalid_timing');
    expect(codesOf(bundleOver(materials, { timing: { ...CUSTOM_TIMING, writingMinutes: 12.5 } }), materials)).toContain('invalid_timing');
  });

  it('refuses timing labelled as IELTS reference timing that is not', () => {
    const materials = fullMaterials();
    expect(codesOf(bundleOver(materials, { timing: { ...CUSTOM_TIMING, basis: 'ielts_reference' } }), materials)).toContain('invalid_timing');
    const reference = { listeningMinutes: 30, readingMinutes: 60, writingMinutes: 60, speakingMinutes: 14, basis: 'ielts_reference' as const, allowEarlyFinish: true };
    expect(codesOf(bundleOver(materials, { timing: reference }), materials)).toEqual([]);
  });

  it('refuses a bundle with no title', () => {
    const materials = fullMaterials();
    expect(codesOf(bundleOver(materials, { title: '  ' }), materials)).toContain('invalid_configuration');
  });

  it('migrates a bundle from before pinning into one that cannot be sat until it is pinned', () => {
    const legacy = readStoredBundle({
      id: 'cdi-legacy',
      title: 'Legacy CDI',
      module: 'academic',
      status: 'published',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      timings: { listeningMinutes: 30, readingMinutes: 60, writingMinutes: 60, speakingMinutes: 15 },
      materials: { readingId: 'rea-1', writingId: 'wri-1' },
    });
    expect(legacy.schemaVersion).toBe(2);
    expect(legacy.timing.basis).toBe('custom');
    expect(legacy.components.map((ref) => [ref.section, ref.contentHash])).toEqual([
      ['reading', ''],
      ['writing', ''],
    ]);
    const codes = codesOf(legacy, fullMaterials());
    expect(codes).toContain('component_unpinned');
    expect(codes).toContain('listening_missing');
  });
});
