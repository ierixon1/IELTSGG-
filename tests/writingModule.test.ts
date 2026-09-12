import './env';
import { describe, it } from 'node:test';
import { expect } from './harness';

/**
 * Writing is graded as the module it was set in.
 *
 * IELTS Writing Task 1 is a different task in each module (ielts.org, Writing
 * test format): Academic Task 1 describes visual information, General Training
 * Task 1 is a letter. Task 2 is an essay in both. The grader used to be told
 * every task was Academic, so a General Training letter was assessed as a
 * description of a chart. These tests pin what the grading model is told; they
 * never call the model.
 */
const { gradeWritingSubmission, paragraphRewriteInstruction, writingExaminerInstruction } = await import('../src/services/grading');

describe('what the Writing examiner is told', () => {
  it('describes General Training Task 1 as a letter', () => {
    const instruction = writingExaminerInstruction('task1', 'general');
    expect(instruction).toContain('IELTS General Training Writing Task 1');
    expect(instruction).toContain('a letter');
    expect(instruction.includes('visual information')).toBe(false);
    expect(instruction.includes('Academic')).toBe(false);
  });

  it('describes Academic Task 1 as visual information', () => {
    const instruction = writingExaminerInstruction('task1', 'academic');
    expect(instruction).toContain('IELTS Academic Writing Task 1');
    expect(instruction).toContain('visual information');
    expect(instruction.includes('letter')).toBe(false);
  });

  it('describes Task 2 as an essay in either module, assessed on Task Response', () => {
    for (const module of ['academic', 'general'] as const) {
      const instruction = writingExaminerInstruction('task2', module);
      expect(instruction).toContain('Task 2 (an essay');
      expect(instruction).toContain('Task Response');
    }
    expect(writingExaminerInstruction('task1', 'academic')).toContain('Task Achievement');
  });

  it('refuses to grade without knowing the module, before any model is called', async () => {
    const essay = 'word '.repeat(60);
    const missing = await gradeWritingSubmission({ taskType: 'task1', prompt: 'Write a letter to your landlord.', essay, module: undefined });
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.status).toBe(400);
    const wrong = await gradeWritingSubmission({ taskType: 'task1', prompt: 'Write a letter to your landlord.', essay, module: 'gt' });
    expect(wrong.ok === false && wrong.status).toBe(400);
  });
});

describe('what the paragraph-rewrite tutor is told', () => {
  it('tutors General Training Writing as General Training, and Academic as Academic', () => {
    const general = paragraphRewriteInstruction('general');
    expect(general).toContain('IELTS General Training Writing');
    expect(String(general).includes('Academic')).toBe(false);
    expect(paragraphRewriteInstruction('academic')).toContain('IELTS Academic Writing');
  });

  it('gives no instruction without a known module, so the request is refused', () => {
    expect(paragraphRewriteInstruction(undefined)).toBe(null);
    expect(paragraphRewriteInstruction('gt')).toBe(null);
  });
});
