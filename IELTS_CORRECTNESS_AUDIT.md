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
| Flow-chart completion | L, R | `flow_chart_completion` is stored as `diagram_label`; CDI rubrics "Complete the flow-chart" become `summary_completion` | Supported — a typed gap with the flow chart shown from the source page. Only the stored classification is merged (reviewed in Phase 16) |
| Diagram label completion | L, R | `diagram_label` | Supported |
| Plan / map labelling | L | `map_label` | Supported as a typed gap. Whether the answer must be a selection control is unresolved (Phase 16) |
| Short-answer questions | L, R | `short_answer` | Supported |
| (generic gap) | — | `fill_in_blank` | Platform type, used by imported content |

No official task family is entirely unsupported. One gap remains: `acceptableAnswers` (alternative keys) is stored but not consulted when marking.

## Unresolved (official sources silent or ambiguous)

- **Bands below the lowest published row:** Listening raw 0–10, Academic Reading 0–3, GT Reading 0–8. Placeholder values are used. Tests assert only that each is lower than the row it falls outside of.
- **Per-version variation of raw → band tables (S1).** The platform uses one fixed table per module.
- **Rounding of the weighted Writing score.** The overall-band rounding is used.
- **Writing score when only one task is written.**
- **Hyphenated answers.** S2 counts a hyphenated word as one word. `checkAnswer` strips punctuation, including hyphens, before comparing, so "well-known" and "wellknown" are treated alike. Whether that matches official marking is not published.
- **Question numbering continuity** (1–40 across parts) is not enforced by the gate. The sources do not describe it as a marking rule.
- **Computer-delivered review, flag and highlight tools** are not described in the sources used.
- **Listening plan/map/diagram labelling control.** S2 says "You have to select your answers from a list". The player shows a typed gap, where the learner enters the letter or word from the list printed with the picture. The sources do not say what on-screen control computer-delivered IELTS uses, so the control is unchanged (Phase 16).

## Known limitations

- **Listening part navigation is free**, while computer-delivered IELTS plays the recording continuously.
- **A reload during a recording cannot resume it.** The part is recorded as started and cannot be replayed, by design.
- **The audio file itself** remains fetchable through `/api/assets/:id` by an authenticated learner. The once-only rule is enforced on the exam, not on the file.
- **Presentation labels found in Phase 15** — fixed in Phase 16 (see below):
  - Listening part headings;
  - "Report" on General Training Task 1;
  - "Standard Academic" on General Training materials.
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

## Phase 16 — fidelity corrections

This phase covers only the terminology and UI items the Phase 15 audit left open. Scoring, band conversion, Book → Test, the CDI parser and the bundle architecture are unchanged.

### Sources re-checked

- **S2 (Listening).**
  - Form/note/table/flow-chart completion: "fill in gaps in an outline of part or all of the recording".
  - Plan/map/diagram labelling: "complete labels on a visual … You have to select your answers from a list".
- **S3 (Academic Reading).**
  - Summary/note/table/flow-chart completion: complete it "using words taken from the text", with a word limit.
  - Diagram label completion: "Type the words into the gap", with a word limit.
  - The page speaks of "texts", not "passages".
- **S4 (General Training Reading).** "There are three sections of increasing difficulty". The page uses "section" and "text", not "passage".
- **S6 (General Training Writing).**
  - Task 1 is "a response of at least 150 words in the form of a letter", which may be "personal, semi-formal or formal in style".
  - Task 2 is a "semi-formal/neutral discursive essay".
  - The page never calls Task 1 a report.

### Changed

| Issue | Evidence | Change |
|---|---|---|
| Every Listening part was headed "Questions 1–N" | Phase 15 limitation: the questions under the Part 2 heading are numbered 11–20 | The heading uses the first and last question numbers the part carries ("Questions 11–20"; "Question 7" for a single question), in practice and in the exam. `src/utils/questionNumbers.ts` |
| General Training Task 1 was labelled "Report" | S6 (a letter) | The task switcher reads "Task 1 · Letter" for General Training, in practice and in the exam (the exam now passes the bundle module to Writing). Academic keeps "Task 1 · Report" |
| Empty-editor hint for General Training Task 1 described a report (overview, trends) | S6 | General Training Task 1 shows a letter-shaped hint: greeting, purpose, the points asked for, closing in a personal, semi-formal or formal style. Task 2 and Academic keep the existing hint |
| Practice header showed "Difficulty: Standard Academic" for every test and material | Phase 15 limitation; the material/bundle module is known | The header shows "Module: Academic" or "Module: General Training" from the actual material or bundle. The fixed `difficulty` value was removed from `SittableTest` |
| Reading card and Reading screen said "Academic passages" / "Three academic passages" for General Training | S4 | General Training shows "General Training texts … General Training raw-score bands" on the card and "Three General Training sections …" on the Reading screen, in practice and in the exam. Academic wording unchanged |
| The "Rewrite at Band 8" tutor was told every paragraph was Academic Writing | S6; the same inconsistency Phase 15 fixed for the grader | The tutor instruction names the module (`paragraphRewriteInstruction`). The route refuses a request without a module (400), and practice sends the material module |

English, Russian and Uzbek strings were all updated.

### Unchanged, and why

- **Flow-chart completion stored as `diagram_label`.**
  - Not an interaction requirement: S2 and S3 describe filling gaps with words from the recording or text within a word limit. The player does exactly that for both flow-chart and diagram questions (a typed gap), with the visual from the source page.
  - Marking is identical.
  - The question type is never shown to the learner; rubric instructions come from the authored content.
  - The merged classification is a product detail, and changing it would mean changing the CDI parser.
- **Listening map/plan labelling as a typed gap.** See "Unresolved": S2 describes choosing from a list, not the on-screen control.
- **"Passage" on the Reading screen for both modules.** Neither S3 nor S4 uses "passage" (both use "text", and S4 "section"), so it is product terminology for both modules, not Academic leakage. The GT subtitle now says "sections".
- **Learner-profile branding** ("AI band engine for Academic IELTS", "Target: Band X Academic", Academic plan tasks such as "describing a chart"). These describe the product and the learner's plan, which has no module setting. They are not a General Training material or bundle shown in Academic terms.
- **Material catalog module text** shows the stored module ("academic" / "general") capitalised. It already matches the material's module.
- **Writing criteria labels** ("Task achievement" for Task 1, "Task response" for Task 2) are the same in both modules.
- **Speaking and Listening screens** have no module-specific wording, and these tests are the same in both modules (S8).

### Verification

- **Tests.**
  - `tests/moduleLabels.test.ts` (new, 11 tests) renders the learner screens and checks Academic and General Training separately:
    - Listening headings for Parts 1, 2, 3 (exam) and 4;
    - the practice header per module;
    - the Reading card, practice screen and exam screen per module;
    - Writing Task 1 label and hint for Academic, General Training practice and the General Training exam, with Task 2 still "Essay".
  - `tests/writingModule.test.ts` adds the rewrite-tutor instruction per module and its refusal without one.
- **Mutation checks: 11 of 11 killed.**
  - Heading counts from 1; range from question count.
  - Task 1 label ignores module; hint ignores module; "Letter" leaks to Task 2.
  - Header always Academic; Reading card always Academic; hub does not pass module to Reading; Reading subtitle always Academic.
  - Rewrite tutor always Academic; rewrite accepts any module.
- **Browser (Chrome, local server, learner session, Russian interface).**
  - **Setup.** Full-size fixture, plus General Training copies of it, an Academic bundle and a General Training bundle, all published through the store's gates.
  - **Practice, Academic Reading.** Module "Academic"; card "Академические тексты…"; screen "Три академических текста…".
  - **Practice, General Training Reading.**
    - Module "General Training"; no "Standard Academic".
    - Card "Тексты General Training… шкале сырых баллов General Training".
    - Screen "Три секции General Training…"; no "академическ".
  - **Practice, Academic Writing.** Module "Academic"; switcher "Task 1 · Отчёт" / "Task 2 · Эссе"; the report/essay hint on Task 1.
  - **Practice, General Training Writing.**
    - Module "General Training"; switcher "Task 1 · Письмо" / "Task 2 · Эссе"; the letter hint on Task 1; no "Отчёт".
    - Grading sent `module: "general"` (200).
    - "Переписать на Band 8" sent `module: "general"` (200) and rendered "Ваш абзац на Band 8.0".
    - A rewrite request without a module returned 400.
  - **Exam, Academic bundle.**
    - Listening headings "Вопросы 1–10", "11–20", "21–30", "31–40" on Parts 1–4; Part 4's questions are numbered 31, 32, 33….
    - Reading "Три академических текста…"; Writing "Task 1 · Отчёт".
  - **Exam, General Training bundle.** Reading "Три секции General Training…"; Writing "Task 1 · Письмо" with the letter hint; no "Отчёт".
  - **Clean-up.** Local data was restored to its pre-verification state afterwards.
