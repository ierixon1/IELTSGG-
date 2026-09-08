import { ReadingData } from '../types';

/**
 * Academic Reading, full length: three passages, forty questions, sixty
 * minutes.
 *
 * The passages and questions are original to this project. They follow the
 * published Academic Reading specification — rising difficulty across the
 * three passages, paragraph markers where a matching task needs them, and the
 * task mix and rubrics as the paper prints them — but no text is taken from
 * Cambridge, the IELTS partners or any other provider's materials.
 *
 * Task distribution:
 *   Passage 1 (Q1–13):  note completion, TRUE/FALSE/NOT GIVEN, short answer
 *   Passage 2 (Q14–26): matching headings, matching features, sentence completion
 *   Passage 3 (Q27–40): YES/NO/NOT GIVEN, matching information, summary
 *                       completion, multiple choice
 */

const PASSAGE_1 = `[Paragraph A] The Aral Sea was once the fourth largest inland body of water on Earth, covering an area comparable to that of Ireland. Fed by two great rivers descending from the mountains of Central Asia, it supported a fishing industry that employed some sixty thousand people and sustained a chain of port towns along its shores. Within a single human lifetime, more than nine-tenths of that water disappeared. The story of how it vanished is not one of drought, and it is not, in any straightforward sense, a story of accident.

[Paragraph B] From the early 1960s, planners diverted the two feeder rivers into an expanding network of irrigation canals, intending to turn arid land into cotton fields. The engineering worked exactly as designed. Cotton production rose steeply and the region became one of the world's major exporters of the crop. What the plans did not account for was the efficiency of the canals themselves: many were unlined channels cut directly into sand, and by some estimates more than half the diverted water soaked away or evaporated before reaching a single field. The sea, meanwhile, received a diminishing fraction of its former inflow.

[Paragraph C] A body of water that loses more to evaporation than it gains from its rivers does not shrink evenly. As the shoreline retreated, the remaining water grew saltier, since the salts left behind by evaporation were now dissolved in a smaller volume. Salinity roughly tripled within two decades. The native fish species, adapted to brackish rather than saline conditions, could not reproduce. By 1987 the commercial catch had collapsed entirely, and the fishing fleets of towns such as Moynaq were left stranded on sand many kilometres from the nearest water.

[Paragraph D] The consequences did not stop at the waterline. A large sea moderates the climate around it, absorbing heat in summer and releasing it in winter. As the Aral contracted, summers in the surrounding region became hotter and winters colder, and the growing season shortened by several weeks — a bitter irony for an agricultural project. The exposed seabed, meanwhile, proved to be laden with salt and with residues of the fertilisers and pesticides that had drained off the cotton fields for decades. Wind lifted this material into the air, and dust storms carried it across hundreds of kilometres of inhabited land.

[Paragraph E] Attempts at reversal have been partial but instructive. In the northern portion of the basin, a dam completed in 2005 separated a smaller section of the sea and concentrated the flow of one river into it. The effect was faster than almost anyone predicted: water levels rose several metres within a few years, salinity fell, and fish returned in sufficient numbers to support a modest commercial catch once again. The southern portion, cut off from its own river and lying in a hotter and shallower basin, has continued to shrink.

[Paragraph F] What the northern recovery demonstrates is not that the damage was reversible in full — it plainly was not — but that the system retained more capacity to respond than the preceding decades had suggested. It also demonstrates the scale of intervention required. The dam and its associated works cost a sum that would have seemed extravagant set against the value of the cotton crop in any single year, and it restored a fraction of one portion of a sea that had taken forty years to empty.`;

const PASSAGE_2 = `[Paragraph A] For most of the twentieth century, the study of how animals find their way relied on a simple and appealing assumption: that navigation is a matter of following cues in the environment. A bird tracks a coastline; an insect follows a scent gradient; a mammal recognises a landmark. Each of these is real, and each has been demonstrated experimentally. Yet none of them accounts for the performances that first drew researchers to the problem — the shearwater released in an unfamiliar ocean that returns to its own burrow, or the desert ant that walks a hundred metres of foraging zigzags and then runs straight home.

[Paragraph B] The explanation that has gradually displaced the cue-following model is that many animals carry an internal representation of their own displacement. In its simplest form, known as path integration, an animal continuously updates an estimate of the direction and distance back to its starting point, using its own movement as the input. Nothing external is required. The desert ant, studied intensively in the salt pans of North Africa, appears to combine a celestial compass with a step counter: researchers who lengthened the ants' legs with stilts found that the insects overshot their nests by a predictable margin, and those whose legs were shortened stopped short.

[Paragraph C] Path integration has a fundamental weakness, however, which is that errors accumulate. Every estimate of distance and heading carries a small inaccuracy, and because each new estimate is built on the last, those inaccuracies compound with every step. Over a short foraging trip the drift is tolerable. Over an ocean crossing it would be ruinous. Animals that travel far therefore need some means of correcting the running total against something external and stable.

[Paragraph D] Several such corrections have been identified, and they differ markedly in the demands they place on the animal. A magnetic sense, documented in species ranging from turtles to robins, offers a stable directional reference but a coarse one. Olfactory maps, proposed for homing pigeons on the basis of experiments in which the birds' sense of smell was disrupted, may provide positional information over a hundred kilometres or so. Celestial cues offer high precision but require the animal to compensate for the movement of the sun or stars across the sky, which in turn requires an internal clock of considerable accuracy.

[Paragraph E] The interesting question is no longer which of these mechanisms an animal uses, since the answer in most well-studied species is several. It is how they are weighted against one another when they disagree. Experiments in which a magnetic field is artificially rotated while celestial cues remain intact have produced varied results: some species follow the manipulated magnetic cue, others ignore it, and in several cases the response depends on the age of the animal or the stage of its journey. The emerging picture is of a system that assigns confidence to each source and reweights them as conditions change — closer to a statistical estimator than to a compass.

[Paragraph F] This shift has practical consequences beyond biology. Engineers building autonomous vehicles face a structurally identical problem: an inertial system that drifts, several external references of differing reliability, and the need to combine them without a supervisor to say which is right. The algorithms developed for that purpose were arrived at independently, but they resemble the animal solution closely enough that each field has begun to read the other's literature.`;

const PASSAGE_3 = `[Paragraph A] The claim that a language shapes the thought of those who speak it has had an unusually turbulent history. Advanced in strong form in the middle of the twentieth century, it held that the categories available in a language determine what its speakers are able to conceive. This position collapsed under evidence that speakers routinely think about distinctions their language does not encode, and for some decades the entire question was treated as disreputable. Its revival, over the past thirty years, has depended on replacing a claim about what speakers can think with a much narrower claim about what they habitually do think.

[Paragraph B] The most persuasive evidence has come from spatial reference. Most European languages describe location relative to the speaker: the cup is to the left of the plate. A number of other languages, including several spoken in northern Australia and in Mesoamerica, instead use absolute directions in ordinary conversation: the cup is to the north of the plate. Speakers of these languages remain oriented with striking reliability, reporting cardinal directions accurately indoors, in unfamiliar buildings, and after being deliberately disoriented. Whatever cognitive machinery supports this, it is exercised constantly, because the language cannot be spoken without it.

[Paragraph C] Whether that constant exercise amounts to language shaping thought, or simply to a culture that rewards a skill which the language then reflects, has proved difficult to settle. The two explanations predict the same correlation. Attempts to separate them have turned to cases where a linguistic feature is unlikely to have any cultural motivation. Grammatical gender is a favoured example: the arbitrariness of whether a bridge is masculine or feminine offers a lever, and several studies have reported that speakers describe such objects using adjectives stereotypically associated with the assigned gender. Replication has been uneven, and the effects, where found, are small.

[Paragraph D] A more robust line of work concerns colour. Languages divide the spectrum differently, and where a language marks a boundary that another does not, its speakers discriminate across that boundary slightly faster. The effect is real, has replicated well, and is measured in tens of milliseconds. It also disappears when speakers perform a verbal task at the same time, which suggests that language is being recruited during the discrimination rather than having permanently reorganised perception. That is a considerably weaker claim than the one the field began with, and a considerably better supported one.

[Paragraph E] The pattern across these findings is consistent. Where a language obliges its speakers to attend to something — direction, or the completion of an action, or the source of a piece of information — they attend to it more readily in non-linguistic tasks as well. Where a language merely permits a distinction, no such advantage appears. Obligation, not vocabulary, is what carries the effect, which is why counting words for snow was never going to settle anything.

[Paragraph F] What remains contested is the mechanism. One account holds that speakers silently name things as they perceive them, and that the naming does the work; the interference from verbal tasks supports this. Another holds that a lifetime of obligatory attention tunes perception itself, in which case the effect should survive interference, and some studies report that it does. The disagreement is now narrow enough to be settled empirically, which is a considerable advance on a debate that spent decades being unfalsifiable.`;

export const READING_TEST_1: ReadingData = {
  passages: [
    {
      passageNumber: 1,
      title: 'The draining of the Aral Sea',
      subheading: 'How an irrigation project emptied an inland sea in forty years',
      content: PASSAGE_1,
      questions: [
        {
          id: 'r1-q1',
          questionNumber: 1,
          type: 'note_completion',
          instruction:
            'Questions 1–5\nComplete the notes below.\nChoose ONE WORD ONLY from the passage for each answer.',
          prompt: 'Before the diversions, the Aral Sea supported an industry based on ________.',
          wordLimit: 'ONE WORD ONLY',
          correctAnswer: ['fishing', 'fishery'],
          explanation:
            'Paragraph A: "supported a fishing industry that employed some sixty thousand people".',
        },
        {
          id: 'r1-q2',
          questionNumber: 2,
          type: 'note_completion',
          prompt: 'The rivers were diverted in order to grow ________.',
          wordLimit: 'ONE WORD ONLY',
          correctAnswer: 'cotton',
          explanation: 'Paragraph B: "intending to turn arid land into cotton fields".',
        },
        {
          id: 'r1-q3',
          questionNumber: 3,
          type: 'note_completion',
          prompt:
            'Much of the diverted water was lost because the canals were cut into ________.',
          wordLimit: 'ONE WORD ONLY',
          correctAnswer: 'sand',
          explanation: 'Paragraph B: "unlined channels cut directly into sand".',
        },
        {
          id: 'r1-q4',
          questionNumber: 4,
          type: 'note_completion',
          prompt: 'Within twenty years the ________ of the remaining water had roughly tripled.',
          wordLimit: 'ONE WORD ONLY',
          correctAnswer: 'salinity',
          explanation: 'Paragraph C: "Salinity roughly tripled within two decades".',
        },
        {
          id: 'r1-q5',
          questionNumber: 5,
          type: 'note_completion',
          prompt: 'Material blown from the dry seabed included salt, fertilisers and ________.',
          wordLimit: 'ONE WORD ONLY',
          correctAnswer: ['pesticides', 'pesticide'],
          explanation:
            'Paragraph D: "residues of the fertilisers and pesticides that had drained off the cotton fields".',
        },
        {
          id: 'r1-q6',
          questionNumber: 6,
          type: 'true_false_not_given',
          instruction:
            'Questions 6–10\nDo the following statements agree with the information given in the passage?\nWrite TRUE if the statement agrees with the information, FALSE if the statement contradicts the information, or NOT GIVEN if there is no information on this.',
          prompt: 'The loss of water from the Aral Sea was primarily caused by a fall in rainfall.',
          options: ['TRUE', 'FALSE', 'NOT GIVEN'],
          correctAnswer: 'FALSE',
          explanation:
            'Paragraph A states directly that the story "is not one of drought"; the cause given is diversion for irrigation.',
        },
        {
          id: 'r1-q7',
          questionNumber: 7,
          type: 'true_false_not_given',
          prompt: 'The irrigation scheme failed to increase cotton production.',
          options: ['TRUE', 'FALSE', 'NOT GIVEN'],
          correctAnswer: 'FALSE',
          explanation:
            'Paragraph B: "The engineering worked exactly as designed. Cotton production rose steeply."',
        },
        {
          id: 'r1-q8',
          questionNumber: 8,
          type: 'true_false_not_given',
          prompt: 'Native fish species were unable to breed as the water became saltier.',
          options: ['TRUE', 'FALSE', 'NOT GIVEN'],
          correctAnswer: 'TRUE',
          explanation:
            'Paragraph C: the species "adapted to brackish rather than saline conditions, could not reproduce".',
        },
        {
          id: 'r1-q9',
          questionNumber: 9,
          type: 'true_false_not_given',
          prompt: 'The population of Moynaq has fallen since the fishing industry collapsed.',
          options: ['TRUE', 'FALSE', 'NOT GIVEN'],
          correctAnswer: 'NOT GIVEN',
          explanation:
            'The passage mentions the stranded fleets at Moynaq but says nothing about how many people live there.',
        },
        {
          id: 'r1-q10',
          questionNumber: 10,
          type: 'true_false_not_given',
          prompt: 'The northern dam restored the sea to its original size.',
          options: ['TRUE', 'FALSE', 'NOT GIVEN'],
          correctAnswer: 'FALSE',
          explanation:
            'Paragraph F: it "restored a fraction of one portion" and the damage was "plainly" not reversible in full.',
        },
        {
          id: 'r1-q11',
          questionNumber: 11,
          type: 'short_answer',
          instruction:
            'Questions 11–13\nAnswer the questions below.\nChoose NO MORE THAN TWO WORDS AND/OR A NUMBER from the passage for each answer.',
          prompt: 'In which year did the commercial catch collapse completely?',
          wordLimit: 'NO MORE THAN TWO WORDS AND/OR A NUMBER',
          correctAnswer: '1987',
          explanation: 'Paragraph C: "By 1987 the commercial catch had collapsed entirely".',
        },
        {
          id: 'r1-q12',
          questionNumber: 12,
          type: 'short_answer',
          prompt: 'By roughly how much did the growing season shorten?',
          wordLimit: 'NO MORE THAN TWO WORDS AND/OR A NUMBER',
          correctAnswer: ['several weeks', 'weeks'],
          explanation: 'Paragraph D: "the growing season shortened by several weeks".',
        },
        {
          id: 'r1-q13',
          questionNumber: 13,
          type: 'short_answer',
          prompt: 'In what year was the northern dam completed?',
          wordLimit: 'NO MORE THAN TWO WORDS AND/OR A NUMBER',
          correctAnswer: '2005',
          explanation: 'Paragraph E: "a dam completed in 2005".',
        },
      ],
    },
    {
      passageNumber: 2,
      title: 'How animals find their way',
      subheading: 'From following cues to weighing evidence',
      content: PASSAGE_2,
      questions: [
        {
          id: 'r2-q14',
          questionNumber: 14,
          type: 'matching_headings',
          instruction:
            'Questions 14–19\nThe passage has six paragraphs, A–F.\nChoose the correct heading for each paragraph from the list of headings below.',
          prompt: 'Paragraph A',
          options: [
            'i. A weakness that grows with every step',
            'ii. An old explanation and what it cannot account for',
            'iii. External references and what each one costs',
            'iv. Navigating without any external information',
            'v. A problem engineers arrived at independently',
            'vi. Deciding which source to trust',
            'vii. Why young animals navigate less accurately',
          ],
          correctAnswer: 'ii',
          explanation:
            'Paragraph A sets out the cue-following assumption and the performances it fails to explain.',
        },
        {
          id: 'r2-q15',
          questionNumber: 15,
          type: 'matching_headings',
          prompt: 'Paragraph B',
          options: [
            'i. A weakness that grows with every step',
            'ii. An old explanation and what it cannot account for',
            'iii. External references and what each one costs',
            'iv. Navigating without any external information',
            'v. A problem engineers arrived at independently',
            'vi. Deciding which source to trust',
            'vii. Why young animals navigate less accurately',
          ],
          correctAnswer: 'iv',
          explanation:
            'Paragraph B introduces path integration, where "nothing external is required".',
        },
        {
          id: 'r2-q16',
          questionNumber: 16,
          type: 'matching_headings',
          prompt: 'Paragraph C',
          options: [
            'i. A weakness that grows with every step',
            'ii. An old explanation and what it cannot account for',
            'iii. External references and what each one costs',
            'iv. Navigating without any external information',
            'v. A problem engineers arrived at independently',
            'vi. Deciding which source to trust',
            'vii. Why young animals navigate less accurately',
          ],
          correctAnswer: 'i',
          explanation:
            'Paragraph C is about accumulating error: "those inaccuracies compound with every step".',
        },
        {
          id: 'r2-q17',
          questionNumber: 17,
          type: 'matching_headings',
          prompt: 'Paragraph D',
          options: [
            'i. A weakness that grows with every step',
            'ii. An old explanation and what it cannot account for',
            'iii. External references and what each one costs',
            'iv. Navigating without any external information',
            'v. A problem engineers arrived at independently',
            'vi. Deciding which source to trust',
            'vii. Why young animals navigate less accurately',
          ],
          correctAnswer: 'iii',
          explanation:
            'Paragraph D lists magnetic, olfactory and celestial references and the demands each places on the animal.',
        },
        {
          id: 'r2-q18',
          questionNumber: 18,
          type: 'matching_headings',
          prompt: 'Paragraph E',
          options: [
            'i. A weakness that grows with every step',
            'ii. An old explanation and what it cannot account for',
            'iii. External references and what each one costs',
            'iv. Navigating without any external information',
            'v. A problem engineers arrived at independently',
            'vi. Deciding which source to trust',
            'vii. Why young animals navigate less accurately',
          ],
          correctAnswer: 'vi',
          explanation:
            'Paragraph E is about how conflicting cues are weighted — "closer to a statistical estimator than to a compass".',
        },
        {
          id: 'r2-q19',
          questionNumber: 19,
          type: 'matching_headings',
          prompt: 'Paragraph F',
          options: [
            'i. A weakness that grows with every step',
            'ii. An old explanation and what it cannot account for',
            'iii. External references and what each one costs',
            'iv. Navigating without any external information',
            'v. A problem engineers arrived at independently',
            'vi. Deciding which source to trust',
            'vii. Why young animals navigate less accurately',
          ],
          correctAnswer: 'v',
          explanation:
            'Paragraph F describes autonomous vehicle engineers meeting a "structurally identical problem".',
        },
        {
          id: 'r2-q20',
          questionNumber: 20,
          type: 'matching_features',
          instruction:
            'Questions 20–23\nMatch each description with the correct navigational reference, A–D.\nA. path integration   B. a magnetic sense   C. an olfactory map   D. celestial cues',
          prompt: 'It requires an accurate internal clock.',
          options: ['A. path integration', 'B. a magnetic sense', 'C. an olfactory map', 'D. celestial cues'],
          correctAnswer: 'D',
          explanation:
            'Paragraph D: celestial cues "require the animal to compensate for the movement of the sun or stars", needing "an internal clock of considerable accuracy".',
        },
        {
          id: 'r2-q21',
          questionNumber: 21,
          type: 'matching_features',
          prompt: 'Its accuracy degrades progressively over the course of a journey.',
          options: ['A. path integration', 'B. a magnetic sense', 'C. an olfactory map', 'D. celestial cues'],
          correctAnswer: 'A',
          explanation: 'Paragraph C: errors in path integration "compound with every step".',
        },
        {
          id: 'r2-q22',
          questionNumber: 22,
          type: 'matching_features',
          prompt: 'It gives a dependable direction but little precision.',
          options: ['A. path integration', 'B. a magnetic sense', 'C. an olfactory map', 'D. celestial cues'],
          correctAnswer: 'B',
          explanation:
            'Paragraph D: a magnetic sense "offers a stable directional reference but a coarse one".',
        },
        {
          id: 'r2-q23',
          questionNumber: 23,
          type: 'matching_features',
          prompt: 'Evidence for it came from interfering with a particular sense.',
          options: ['A. path integration', 'B. a magnetic sense', 'C. an olfactory map', 'D. celestial cues'],
          correctAnswer: 'C',
          explanation:
            'Paragraph D: olfactory maps were "proposed for homing pigeons on the basis of experiments in which the birds\' sense of smell was disrupted".',
        },
        {
          id: 'r2-q24',
          questionNumber: 24,
          type: 'sentence_completion',
          instruction:
            'Questions 24–26\nComplete the sentences below.\nChoose NO MORE THAN TWO WORDS from the passage for each answer.',
          prompt:
            'Ants fitted with ________ travelled further than the true distance to their nest.',
          wordLimit: 'NO MORE THAN TWO WORDS',
          correctAnswer: 'stilts',
          explanation:
            'Paragraph B: researchers "lengthened the ants\' legs with stilts" and the insects overshot.',
        },
        {
          id: 'r2-q25',
          questionNumber: 25,
          type: 'sentence_completion',
          prompt:
            'Most well-studied species rely on ________ mechanisms rather than a single one.',
          wordLimit: 'NO MORE THAN TWO WORDS',
          correctAnswer: 'several',
          explanation:
            'Paragraph E: "the answer in most well-studied species is several".',
        },
        {
          id: 'r2-q26',
          questionNumber: 26,
          type: 'sentence_completion',
          prompt:
            'How an animal responds to a rotated magnetic field can depend on its age or the ________ of its journey.',
          wordLimit: 'NO MORE THAN TWO WORDS',
          correctAnswer: 'stage',
          explanation:
            'Paragraph E: "the response depends on the age of the animal or the stage of its journey".',
        },
      ],
    },
    {
      passageNumber: 3,
      title: 'Does language shape thought?',
      subheading: 'A discredited claim, narrowed until it could be tested',
      content: PASSAGE_3,
      questions: [
        {
          id: 'r3-q27',
          questionNumber: 27,
          type: 'yes_no_not_given',
          instruction:
            'Questions 27–31\nDo the following statements agree with the claims of the writer?\nWrite YES if the statement agrees with the claims of the writer, NO if the statement contradicts the claims of the writer, or NOT GIVEN if it is impossible to say what the writer thinks about this.',
          prompt: 'The original strong version of the claim was correctly abandoned.',
          options: ['YES', 'NO', 'NOT GIVEN'],
          correctAnswer: 'YES',
          explanation:
            'Paragraph A: it "collapsed under evidence", and the writer treats the narrower revival as the improvement.',
        },
        {
          id: 'r3-q28',
          questionNumber: 28,
          type: 'yes_no_not_given',
          prompt: 'Grammatical gender has produced the field\'s most dependable findings.',
          options: ['YES', 'NO', 'NOT GIVEN'],
          correctAnswer: 'NO',
          explanation:
            'Paragraph C: "Replication has been uneven, and the effects, where found, are small." Paragraph D calls colour "a more robust line of work".',
        },
        {
          id: 'r3-q29',
          questionNumber: 29,
          type: 'yes_no_not_given',
          prompt:
            'The colour findings show that perception has been permanently restructured by language.',
          options: ['YES', 'NO', 'NOT GIVEN'],
          correctAnswer: 'NO',
          explanation:
            'Paragraph D: the effect vanishes under a verbal task, suggesting language is "recruited" rather than having "permanently reorganised perception".',
        },
        {
          id: 'r3-q30',
          questionNumber: 30,
          type: 'yes_no_not_given',
          prompt:
            'Speakers of absolute-direction languages perform better at mathematics than other speakers.',
          options: ['YES', 'NO', 'NOT GIVEN'],
          correctAnswer: 'NOT GIVEN',
          explanation: 'The passage discusses orientation only and never mentions mathematics.',
        },
        {
          id: 'r3-q31',
          questionNumber: 31,
          type: 'yes_no_not_given',
          prompt: 'The remaining disagreement can now be resolved by experiment.',
          options: ['YES', 'NO', 'NOT GIVEN'],
          correctAnswer: 'YES',
          explanation:
            'Paragraph F: "The disagreement is now narrow enough to be settled empirically".',
        },
        {
          id: 'r3-q32',
          questionNumber: 32,
          type: 'matching_information',
          instruction:
            'Questions 32–35\nThe passage has six paragraphs, A–F.\nWhich paragraph contains the following information?',
          prompt: 'a reason why one type of evidence was chosen to separate two explanations',
          options: [
            'A. Paragraph A',
            'B. Paragraph B',
            'C. Paragraph C',
            'D. Paragraph D',
            'E. Paragraph E',
            'F. Paragraph F',
          ],
          correctAnswer: 'C',
          explanation:
            'Paragraph C: gender is favoured because its arbitrariness "offers a lever" against the cultural explanation.',
        },
        {
          id: 'r3-q33',
          questionNumber: 33,
          type: 'matching_information',
          prompt: 'a statement of what actually determines whether an effect appears',
          options: [
            'A. Paragraph A',
            'B. Paragraph B',
            'C. Paragraph C',
            'D. Paragraph D',
            'E. Paragraph E',
            'F. Paragraph F',
          ],
          correctAnswer: 'E',
          explanation: 'Paragraph E: "Obligation, not vocabulary, is what carries the effect".',
        },
        {
          id: 'r3-q34',
          questionNumber: 34,
          type: 'matching_information',
          prompt: 'a description of behaviour observed after participants were disoriented',
          options: [
            'A. Paragraph A',
            'B. Paragraph B',
            'C. Paragraph C',
            'D. Paragraph D',
            'E. Paragraph E',
            'F. Paragraph F',
          ],
          correctAnswer: 'B',
          explanation:
            'Paragraph B: speakers report directions accurately "after being deliberately disoriented".',
        },
        {
          id: 'r3-q35',
          questionNumber: 35,
          type: 'matching_information',
          prompt: 'two competing accounts of how an established effect is produced',
          options: [
            'A. Paragraph A',
            'B. Paragraph B',
            'C. Paragraph C',
            'D. Paragraph D',
            'E. Paragraph E',
            'F. Paragraph F',
          ],
          correctAnswer: 'F',
          explanation:
            'Paragraph F sets silent naming against tuned perception as rival mechanisms.',
        },
        {
          id: 'r3-q36',
          questionNumber: 36,
          type: 'summary_completion',
          instruction:
            'Questions 36–38\nComplete the summary below.\nChoose NO MORE THAN TWO WORDS from the passage for each answer.\n\nThe revived claim succeeded by narrowing itself: instead of asking what speakers are able to conceive, it asks what they (36) ________ think. The strongest evidence concerns (37) ________ reference, where some languages require absolute directions in everyday speech. Effects in colour discrimination are measured in tens of (38) ________.',
          prompt: 'Question 36',
          wordLimit: 'NO MORE THAN TWO WORDS',
          correctAnswer: 'habitually',
          explanation:
            'Paragraph A: "a much narrower claim about what they habitually do think".',
        },
        {
          id: 'r3-q37',
          questionNumber: 37,
          type: 'summary_completion',
          prompt: 'Question 37',
          wordLimit: 'NO MORE THAN TWO WORDS',
          correctAnswer: 'spatial',
          explanation: 'Paragraph B: "The most persuasive evidence has come from spatial reference."',
        },
        {
          id: 'r3-q38',
          questionNumber: 38,
          type: 'summary_completion',
          prompt: 'Question 38',
          wordLimit: 'NO MORE THAN TWO WORDS',
          correctAnswer: ['milliseconds', 'a millisecond'],
          explanation: 'Paragraph D: "measured in tens of milliseconds".',
        },
        {
          id: 'r3-q39',
          questionNumber: 39,
          type: 'multiple_choice',
          instruction: 'Questions 39–40\nChoose the correct letter, A, B, C or D.',
          prompt: 'Why does the writer mention counting words for snow?',
          options: [
            'A. to give an example of a well-designed study',
            'B. to show that vocabulary size alone settles nothing',
            'C. to argue that some languages are more precise than others',
            'D. to explain why the field abandoned colour research',
          ],
          correctAnswer: 'B',
          explanation:
            'Paragraph E contrasts obligation with vocabulary: "counting words for snow was never going to settle anything".',
        },
        {
          id: 'r3-q40',
          questionNumber: 40,
          type: 'multiple_choice',
          prompt: 'What is the writer\'s overall assessment of the field?',
          options: [
            'A. It has returned to the position it held originally.',
            'B. Its central question has been shown to be unanswerable.',
            'C. It now makes a smaller claim that the evidence can support.',
            'D. Its findings apply only to languages with grammatical gender.',
          ],
          correctAnswer: 'C',
          explanation:
            'Paragraph D calls it "a considerably weaker claim... and a considerably better supported one", and Paragraph F calls the narrowing "a considerable advance".',
        },
      ],
    },
  ],
};
