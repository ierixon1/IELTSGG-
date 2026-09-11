# IELTS Exam Correctness Audit (Phase 15)

This audit checks the platform against what IELTS publishes about the test: its structure, timing, question types, marking and band scores. Each finding keeps three things apart:

- **the official requirement**, with a source;
- **what the application does**;
- **the product decision.**

Where the official sources say nothing, or are ambiguous, the item is marked **unresolved** and has not been "corrected".

Scope rules:
- Book → Test, the Source Library and the CDI parser were not changed.
- The bundle architecture was not rebuilt.
- No AI judge and no learner UX redesign were added.

## Sources

| Id | Source |
|---|---|
| S1 | IELTS.org — IELTS scoring in detail: https://ielts.org/take-a-test/your-results/ielts-scoring-in-detail |
| S2 | IELTS.org — Academic test format, Listening: https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-listening |
| S3 | IELTS.org — Academic test format, Reading: https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-reading |
| S4 | IELTS.org — General Training test format, Reading: https://ielts.org/take-a-test/test-types/ielts-general-training-test/ielts-general-training-format-reading |
| S5 | IELTS.org — Academic test format, Writing: https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-writing |
| S6 | IELTS.org — General Training test format, Writing: https://ielts.org/take-a-test/test-types/ielts-general-training-test/ielts-general-training-format-writing |
| S7 | IELTS.org — Academic test format, Speaking: https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-speaking |
| S8 | IELTS.org — IELTS General Training test ("Listening and Speaking are the same for both tests"): https://ielts.org/take-a-test/test-types/ielts-general-training-test |
| S9 | IDP IELTS — How to calculate the IELTS Listening band score (raw score table): https://ielts.idp.com/egypt/results/scores/listening |
| S10 | IDP IELTS — How to calculate the IELTS Reading band score (Academic and General Training tables): https://ielts.idp.com/egypt/results/scores/reading |
| S11 | IDP IELTS — How computer-delivered IELTS works: https://ielts.idp.com/prepare/article-how-computer-delivered-ielts-works |

British Council pages were tried but did not load (timeouts). Nothing in this audit relies on them.

Caveats the sources themselves attach:
- S1 says the precise raw marks for each band "vary slightly from test version to test version".
- S9 and S10 present their tables as average marks.

The platform has no per-version tables, so it uses the published tables as fixed tables.

## Audit matrix

Status values:
- **OK** — matches the official requirement.
- **Fixed** — was wrong; corrected in this phase.
- **Non-official** — a deliberate product behaviour, not an IELTS rule.
- **Unresolved** — the sources are silent or ambiguous.
- **Partial** — supported with a known gap.

### Listening

| Area | Official requirement | Current implementation | Status | Evidence | Required fix |
|---|---|---|---|---|---|
| Parts and questions | 4 parts, 10 questions each, 40 in total (S2) | The bundle gate refuses to publish a Listening part that does not have exactly 10 questions (`question_count`) | Fixed | `src/services/bundleGate.ts` `LISTENING_QUESTIONS_PER_PART`; `tests/bundleGate.test.ts` | Done — previously any number of questions was accepted and scaled to /40 |
| Marks | 1 mark per question (S2) | `objectiveSectionScore` counts 1 per correct question; a 40-question exam converts raw /40 directly | OK | `src/utils/ieltsScoring.ts`; `tests/examIntegrity.test.ts` | — |
| Raw → band | Published table: 39–40→9 … 11–12→4 (S9); anchors 16→5, 23→6, 30→7, 35→8 (S1) | `listeningRawToBand` follows every published row. Raw 10 used to give 4.0, although the band-4 row starts at 11 | Fixed | `tests/examIntegrity.test.ts` "converts Listening…", "does not give a raw score below the lowest published row…" | Done |
| Below 11 | Not published (S9) | 7–10 → 3.5, 4–6 → 3.0, 0–3 → 2.5 | Unresolved | Code comment "Unpublished below this line" | None — values are placeholders, not asserted by tests |
| Same test for both modules | Listening is the same for Academic and GT (S8) | One table for both modules | OK | `tests/examRun.test.ts` (GT exam: Listening band unchanged) | — |
| Recording heard once | "You will hear the recordings once only" (S2) | Exam mode: one "Play recording (once only)" button per part. The server records `audio_started` with its own clock and ignores repeats. The button stays disabled after reload. No seek bar or controls. Practice mode keeps normal controls | Fixed | `src/services/examRun.ts` `audio_started`; `tests/examSession.test.ts`; browser check below | Done — the exam previously showed a normal `<audio controls>` that could be replayed and scrubbed |
| Timing | About 30 minutes. Paper adds 10 minutes transfer time; computer-delivered has a 2-minute review and no transfer time (S2, S11) | Reference timing is 30 minutes; bundles may set custom minutes | Non-official | `IELTS_REFERENCE_MINUTES` in `src/types/bundle.ts` | None — the 2-minute review is not modelled (see limitations) |
| Word limits | Writing more than the word limit loses the mark; a hyphenated word counts as one (S2) | Answers are matched against the key; extra words fail the match. The word limit is shown to the learner | Partial | `checkAnswer` | See "Unresolved" — hyphen handling |
| Task types | MC; matching; plan/map/diagram labelling; form/note/table/flow-chart completion; sentence completion; short answer (S2) | See the question-type table | Partial | `src/schemas/question.ts` | — |

### Reading

| Area | Official requirement | Current implementation | Status | Evidence | Required fix |
|---|---|---|---|---|---|
| Sections and questions | 3 sections, 40 questions, both modules (S3, S4) | When all three passages are pinned, the bundle gate refuses publication unless they total 40 | Fixed | `readingCountBlockers` in `src/services/bundleGate.ts`; `tests/bundleGate.test.ts` | Done |
| Timing | 60 minutes, no extra transfer time (S3, S4) | Reference timing is 60 minutes | OK | `IELTS_REFERENCE_MINUTES` | — |
| Academic raw → band | 39–40→9 … 4–5→2.5 (S10); anchors 15→5, 23→6, 30→7, 35→8 (S1) | `academicReadingRawToBand` follows every published row. It used to give 7→3.5 and 4–5→3.0, and raw 0–3 fell inside the 2.5 row | Fixed | `tests/examIntegrity.test.ts` | Done |
| GT raw → band | 40→9, 39→8.5, 37–38→8 … 9–11→3 (S10); anchors 15→4, 23→5, 30→6, 35→7 (S1) | `generalReadingRawToBand` is a separate table. **General Training Reading used to be converted with the Academic table**: 30/40 gave 7 instead of 6 | Fixed | `tests/examIntegrity.test.ts`, `tests/examRun.test.ts`, `tests/practiceKeys.test.ts`; browser check below | Done |
| Module carried to marking | The module decides the Reading table (S1, S10) | The exam plan carries `module` from the bundle; practice carries it from the material (`SittableTest.module`) | Fixed | `src/services/examRun.ts`, `src/services/sittingAdapters.ts`, `src/services/practiceMarking.ts` | Done |
| Task types, Academic | 11 types, including YNNG (S3) | See the question-type table | OK | — | — |
| Task types, GT | 8 types; section 1 short texts, section 2 work-related, section 3 one long text (S4) | Question types are shared. Text genre per section is not validated | Non-official | — | None — genre is authoring, not marking |

### Writing

| Area | Official requirement | Current implementation | Status | Evidence | Required fix |
|---|---|---|---|---|---|
| Tasks and timing | 60 minutes, 2 tasks. Task 1 ≥150 words (~20 min); Task 2 ≥250 words (~40 min) (S5, S6) | Two tasks. Reference 60 minutes. Word counts use 150/250, and the result reports `meets_word_limit` | OK | `src/services/grading.ts` | — |
| Task 1 by module | Academic: describe visual information. GT: a letter (personal, semi-formal or formal) (S5, S6) | The grader instruction names the module and the task. The module is required (400 without it). Exam passes the bundle module; practice passes the material module. **Previously every task was graded as "Academic"**, so a GT letter was assessed as a chart description | Fixed | `writingExaminerInstruction`; `tests/writingModule.test.ts`; `tests/examSession.test.ts` "a General Training sitting"; browser check below | Done |
| Task 2 weighting | "Task 2 contributes twice as much as Task 1" (S5) | `writingSectionBand = roundIeltsBand((t1 + 2·t2) / 3)` | OK | `tests/examIntegrity.test.ts` "weights Writing Task 2 twice…" | — |
| Section rounding | Not published how the weighted Writing score is rounded | Rounded with the overall-band rounding rule | Unresolved | `writingSectionBand` | None |
| Criteria | Task Achievement / Task Response, Coherence and Cohesion, Lexical Resource, Grammatical Range and Accuracy (S5) | The instruction names these criteria; the AI model assigns bands | Non-official (AI) | `writingExaminerInstruction` | None |
| Missing task | A candidate who writes one task still gets a Writing score (the sources do not say how it is computed) | The Writing section "expires" with no band and the attempt has no overall | Non-official / Unresolved | `tests/examSession.test.ts` "records a sitting whose Writing ran out of time as incomplete" | None |

### Speaking

| Area | Official requirement | Current implementation | Status | Evidence | Required fix |
|---|---|---|---|---|---|
| Structure | 11–14 minutes. Part 1 4–5 min; Part 2 3–4 min incl. 1 min preparation, speak ~2 min; Part 3 4–5 min (S7) | Three parts; Part 2 has a 60-second preparation timer; Part 3 follows the Part 2 topic. Reference 14 minutes | OK | `src/components/SpeakingSession.tsx` | — |
| Completion | The test is all three parts | The section cannot finish until all 3 parts are graded | OK | `tests/examRun.test.ts`, `tests/examSession.test.ts` | — |
| Scoring | Four equally weighted criteria, assessed across the whole test (S1, S7) | Each part is graded by AI; the section band is the half-band average of the 3 parts | Non-official | `speakingSectionBand` | None — documented as mock scoring |
| Examiner | Face-to-face with a certified examiner (S7) | AI grading of a recording or typed transcript | Non-official | — | None |
| Same for both modules | (S8) | Not module-specific | OK | — | — |

### Overall score

| Area | Official requirement | Current implementation | Status | Evidence | Required fix |
|---|---|---|---|---|---|
| Average and rounding | Mean of the four bands, to the nearest half; .25 goes up to .5 and .75 goes up to the next whole (S1) | `roundIeltsBand` | OK | `tests/examIntegrity.test.ts` — ielts.org worked examples (6.25→6.5, 6.125→6.0) | — |
| A band of 0 | 0 is a band score (S1: bands run 0–9) | **A section band of 0 was dropped from the average**, raising the overall | Fixed | `tests/examIntegrity.test.ts` "counts a section band of 0…" | Done |
| Overall only when complete | An overall band needs all four section bands | No overall unless all four sections are complete | OK | `examResult` in `src/services/examRun.ts` | — |

### Computer-delivered IELTS interaction (only what is publicly documented)

| Area | Official requirement | Current implementation | Status | Evidence | Required fix |
|---|---|---|---|---|---|
| Section order | Listening, Reading and Writing are taken together; Speaking may be on another day (S11) | Fixed order L → R → W → S in one sitting, run on the server clock | Non-official (ordering) | `src/services/examRun.ts` | None |
| Listening review | 2-minute review at the end, no transfer time (S11) | No separate review period | Non-official | — | None — see limitations |
| Audio | Recordings play once (S2) | Once-only start per part, enforced by the server | Fixed | above | Done |
| Review / flag / highlight tools | Not specified in the sources used | Not implemented | Unresolved | — | None |

## Confirmed defects fixed in this phase

1. **General Training Reading was converted with the Academic table.** A GT candidate with 30/40 got band 7 instead of 6.
   - Added `generalReadingRawToBand` and `readingRawToBand(raw, module)`.
   - `module` now flows from the bundle (exam) and from the material (practice).
2. **Academic Reading and Listening tables disagreed with the published rows at the bottom.**
   - Academic 7→3.5 and 4–5→3.0 corrected to 3.0 and 2.5.
   - Raw 0–3 no longer gets the 2.5 band of the 4–5 row.
   - Listening raw 10 no longer gets the band 4 that starts at 11.
3. **An overall band dropped a section band of 0** instead of averaging it.
4. **Listening in exam mode could be replayed and scrubbed**, although IELTS plays each recording once.
   - One start per part, recorded by the server (`audio_started`) and surviving reload.
   - No controls in exam mode.
5. **Writing was always graded as Academic.** The grader is now told the module:
   - General Training Task 1 is assessed as a letter;
   - Academic Task 1 is assessed as a description of visual information.
   - A request without a module is refused.
6. **Arbitrary question counts were accepted and scaled to /40.** Product decision: enforce at publish.
   - A bundle cannot be published unless every Listening part has 10 questions and Reading has 40 in total.
   - An exam then converts the raw /40 directly.
   - The test fixtures and the deterministic seed fixture (`scripts/seedExamFixture.ts`) are now full size.

## Intentional non-official and mock behaviours

- **Single-part practice bands are estimates.** A practice material with, e.g., 13 questions scales the raw score to /40 before converting. Only a full 40-question exam converts directly.
- **Writing and Speaking bands are assigned by an AI model** against the public band descriptors, not by a certified examiner. Results are labelled as training estimates in the UI.
- **Speaking is scored per part and averaged.** IELTS assesses Speaking holistically across the whole test.
- **A typed transcript can be graded** when no recording is available.
- **Timing is configurable per bundle.** "IELTS reference timing" is 30 / 60 / 60 / 14 minutes: Speaking uses the upper bound of 11–14, and the Listening review/transfer time is not added.
- **Early finish** can be enabled per bundle.
- **Fixed order L → R → W → S in one sitting.**
- **Stricter module rule.** A bundle requires Listening and Speaking components to match the bundle module (`module_mismatch`), although IELTS uses the same Listening and Speaking for both modules (S8). This is stricter than official, not wrong for the candidate.
- **An incomplete Writing section has no band and no overall** (see matrix).

## Question-type support

The canonical types are defined in `src/schemas/question.ts`. The CDI parser emits all canonical types.

| Official family | Modules / sections | Platform type(s) | Status |
|---|---|---|---|
| Multiple choice (single answer) | L, R (Ac, GT) | `multiple_choice` | Supported |
| Multiple choice (more than one answer) | L, R | `multi_select` (marked as a set) | Supported |
| True / False / Not Given | R (Ac, GT) | `true_false_not_given` | Supported |
| Yes / No / Not Given | R (Academic only, S3) | `yes_no_not_given` | Supported |
| Matching information | R | `matching_information` | Supported |
| Matching headings | R | `matching_headings` | Supported |
| Matching features | R | `matching_features` | Supported |
| Matching sentence endings | R (Academic list, S3) | `matching_sentence_endings` | Supported |
| Matching (Listening) | L | `matching` | Supported |
| Sentence completion | L, R | `sentence_completion` | Supported |
| Summary completion | R | `summary_completion` | Supported |
| Note completion | L, R | `note_completion` | Supported |
| Table completion | L, R | `table_completion` | Supported |
| Form completion | L | `form_completion` | Supported |
| Flow-chart completion | L, R | `flow_chart_completion` is an alias stored as `diagram_label` | Partial — no distinct type, so a flow chart is authored and rendered as a labelled diagram |
| Diagram label completion | L, R | `diagram_label` | Supported |
| Plan / map labelling | L | `map_label` | Supported |
| Short-answer questions | L, R | `short_answer` | Supported |
| (generic gap) | — | `fill_in_blank` | Platform type, used by imported content |

No official task family is entirely unsupported. Two gaps remain:
- `acceptableAnswers` (alternative keys) is stored but not consulted when marking.
- Flow-chart completion is partial (see the table).

## Unresolved (official sources silent or ambiguous)

- **Bands below the lowest published row:** Listening raw 0–10, Academic Reading 0–3, GT Reading 0–8. Placeholder values are used. Tests assert only that each is lower than the row it falls outside of.
- **Per-version variation of raw → band tables (S1).** The platform uses one fixed table per module.
- **Rounding of the weighted Writing score.** The overall-band rounding is used.
- **Writing score when only one task is written.**
- **Hyphenated answers.** S2 counts a hyphenated word as one word. `checkAnswer` strips punctuation, including hyphens, before comparing, so "well-known" and "wellknown" are treated alike. Whether that matches official marking is not published.
- **Question numbering continuity** (1–40 across parts) is not enforced by the gate. The sources do not describe it as a marking rule.
- **Computer-delivered review, flag and highlight tools** are not described in the sources used.

## Known limitations

- **Listening part navigation is free**, while computer-delivered IELTS plays the recording continuously.
- **A reload during a recording cannot resume it.** The part is recorded as started and cannot be replayed, by design.
- **The audio file itself** remains fetchable through `/api/assets/:id` by an authenticated learner. The once-only rule is enforced on the exam, not on the file.
- **Presentation labels not changed in this phase** (outside the no-UX-change scope):
  - The Listening questions heading reads "Questions 1–10" on every part, although the question badges carry their real numbers (11–20 on Part 2).
  - The practice Writing tab labels Task 1 "Report" for a General Training letter.
  - The practice header shows "Standard Academic" for a General Training material.
- **The Listening 2-minute computer-delivered review time is not modelled.**
- **Speaking and Writing bands depend on an external AI model.** When it is unavailable, no band is recorded rather than a fallback.

## Verification

### Tests

Regression tests were added in:
- `tests/examIntegrity.test.ts`: official worked examples; every published row of all three tables; below-table ordering; 0-band counted; Task 2 weighting; direct 40-question conversion.
- `tests/examRun.test.ts`: GT exam uses the GT table; `audio_started` once-only and Listening-only.
- `tests/examSession.test.ts`: recording started once on the server clock and kept across reload; forged time refused; GT sitting sends `module: general` to the grader.
- `tests/practiceKeys.test.ts`: GT practice material marked with the GT table.
- `tests/bundleGate.test.ts`: Listening 10-per-part and Reading 40-total blockers.
- `tests/writingModule.test.ts`: grader instruction per module and task; module required.

### Mutation checks

17 mutants were applied one at a time, and each file was restored. **All 17 were killed**:

| # | Mutant | Status |
|---|---|---|
| 1 | Overall rounding: .25 rounds down | Killed |
| 2 | Overall rounding: .75 rounds to .5 | Killed |
| 3 | Task 2 weighted equally | Killed |
| 4 | Academic / GT Reading tables swapped | Killed |
| 5 | Writing completes after Task 1 only | Killed |
| 6 | Speaking completes after Part 1 only | Killed |
| 7 | Listening 10-per-part gate removed | Killed |
| 8 | Reading 40-total gate removed | Killed |
| 9 | Band 0 dropped from the overall | Killed |
| 10 | Recording may start twice | Killed |
| 11 | Grader told every task is Academic | Killed |
| 12 | Exam session grades Writing as Academic | Killed |
| 13 | Exam plan ignores the bundle module | Killed |
| 14 | Practice material ignores GT | Killed |
| 15 | Listening raw 10 → band 4 | Killed |
| 16 | Academic Reading raw 3 → band 2.5 | Killed |
| 17 | Grader accepts a missing module | Killed |

Mutants 12 and 15 first survived. The GT-sitting test and the below-table test were added for them, and they were then killed.

### Browser (Chrome, local server)

Real admin and learner sessions were used, with the full-size seed fixture.

- **Bundle Builder, Listening part with 2 questions.** Check showed ``question_count Listening Part 1 ("P15 Short Listening Part 1") has 2 questions; an IELTS Listening part has 10.`` The bundle was not publishable, and a direct publish request returned 409 `question_count`.
- **Bundle Builder, Reading with 29 questions.** Check showed "Reading has 29 questions across its passages; an IELTS Reading test has 40."
- **Bundle Builder, full-size bundle.** "Ready to publish."; published.
- **Exam, Listening.**
  - Part 1 shows "Play recording (once only)", with the audio hidden and no controls.
  - Clicking it disabled the button, and the server session recorded `audioStarted {1: <server time>}`.
  - After a page reload the button read "Recording played — heard once only" and stayed disabled. After clicking it, `audioStarted` was unchanged.
  - Part 2's button was still available.
  - Chrome kept the automation tab "hidden", so the media element did not load. The asset was fetched separately and is a valid 4-second WAV (RIFF/WAVE, 64 KB).
- **Practice, Listening.** The normal audio player with controls is unchanged.
- **Practice, GT Reading.** A material with 10/13 correct showed "10 of 13", band **6.0**; the Academic table would give 7.
- **Practice, GT Writing Task 1.**
  - The request body to `/api/grade/writing` was `{taskType: "task1", prompt, essay, module: "general"}`, and the response was 200.
  - The model's summary assessed it as "IELTS General Training Task 1".

Local data was restored to its pre-verification state afterwards.
