import { Dictionary } from '../types';

/**
 * English is the reference dictionary. Add every new key here first — the
 * other locales fall back to these strings until they are translated.
 */
export const en: Dictionary = {
  brand: {
    name: 'Ever Study',
    tagline: 'AI band engine for Academic IELTS',
  },

  common: {
    startPrep: 'Start preparing',
    openPlatform: 'Open the platform',
    signIn: 'Sign in',
    back: 'Back',
    close: 'Close',
    cancel: 'Cancel',
    save: 'Save',
    retry: 'Try again',
    loading: 'Loading…',
    minutes: '{count} min',
    band: 'Band',
    target: 'Target',
    overall: 'Overall',
    language: 'Language',
    soon: 'Soon',
  },

  nav: {
    plan: 'Plan',
    planLong: 'Adaptive plan',
    mocks: 'Mock tests',
    mocksLong: 'Mocks & drills',
    exam: 'Exam mode',
    arcade: 'Speak or Die',
    stats: 'Statistics',
    preppy: 'Preppy AI',
    admin: 'Admin CMS',
    account: 'Account',
    targetBand: 'Target band',
  },

  skills: {
    listening: 'Listening',
    reading: 'Reading',
    writing: 'Writing',
    speaking: 'Speaking',
  },

  plan: {
    eyebrow: 'Adaptive preparation strategy',
    title: 'Target: Band {band} Academic',
    subtitle:
      'Your roadmap leans into your weakest module ({skill}) while keeping the other three exam-ready.',
    starting: 'Starting',
    target: 'Target',
    weekly: 'Weekly study',
    hours: '{count}h',
    completion: 'Roadmap completion',
    tasksProgress: '{done} of {total} tasks',
    recalculate: 'Recalculate from recent results',
    updateNotice: 'Plan updated',
    tasksTitle: 'Assigned tasks',
    tasksSubtitle: 'Open any task to jump straight into that drill or mock.',
    totalTasks: '{count} tasks',
    highPriority: 'Priority',
    due: 'Due {date}',
    start: 'Start',
    review: 'Retake',
    emptyTitle: 'No tasks yet',
    emptyBody: 'Set your target band to generate a study plan.',
  },

  mocks: {
    eyebrow: 'Modular practice & diagnostics',
    subtitle:
      'Take one section for a targeted drill, or sit the whole test under real timing with instant AI scoring.',
    difficulty: 'Difficulty',
    start: 'Start section',
    listening: {
      meta: '~30 min · 4 parts',
      title: 'Listening',
      body: 'Four recorded sections across British, Australian and American voices, with answer checking and band conversion.',
    },
    reading: {
      meta: '60 min · 3 passages',
      title: 'Reading',
      body: 'Academic passages in the authentic computer-delivered format, marked against the official raw-score bands.',
    },
    writing: {
      meta: '60 min · Task 1 & 2',
      title: 'Writing',
      body: 'Both tasks graded by the AI examiner: four criteria, a band each, and your own sentences annotated in place.',
    },
    speaking: {
      meta: '11–14 min · 3 parts',
      title: 'Speaking',
      body: 'A full interview with preparation timers, live recording, pace and hesitation metrics, and a band per criterion.',
    },
  },

  stats: {
    eyebrow: 'Diagnostics & readiness',
    title: 'Your performance',
    subtitle: 'Tracked against the official band descriptors, with your bottleneck called out automatically.',
    readiness: 'Exam readiness',
    readyState: 'On track for your target',
    prepState: 'Still preparing',
    bottleneckTitle: 'Current bottleneck',
    bottleneckBody:
      '{skill} is your weakest module at Band {band} — {gap} below your target of {target}. The plan has shifted priority drills onto it.',
    runMock: 'Run a full mock',
    targetLabel: 'Target {band}',
    noData: 'No graded attempts yet — the starting band from your profile is shown instead.',
    checklistTitle: 'Weekly milestones',
    checklistSubtitle: 'The practice volume that reliably moves a band score.',
    week: 'Week {number}',
    fullMocks: 'Full mock simulations',
    essays: 'Essays graded',
    recordings: 'Speaking answers assessed',
    roadmapTasks: 'Plan tasks completed',
    ratio: '{done} / {total}',
  },

  landing: {
    nav: {
      platform: 'Platform',
      reviews: 'Reviews',
      guarantee: 'Guarantee',
      faq: 'FAQ',
    },
    hero: {
      eyebrow: 'Academic IELTS',
      title: 'Get the band you need, on the first attempt',
      subtitle:
        'Seven preparation tools in one place, wrapped around an AI examiner that grades your Writing and Speaking against the official band descriptors.',
      primaryCta: 'Start preparing free',
      secondaryCta: 'See the platform',
      note: 'No card required · Works in your browser',
    },
    proof: {
      title: 'Built on the real exam, not a simplified version of it',
      modules: { value: '4', label: 'IELTS modules covered' },
      questionTypes: { value: '16', label: 'Official question types' },
      themes: { value: '36+', label: 'Exam themes in the bank' },
      speed: { value: '<60s', label: 'Typical grading time' },
    },
    tools: {
      eyebrow: 'Inside the platform',
      title: 'Everything your preparation needs, nothing it does not',
      subtitle: 'Each tool feeds the next: your results reshape the plan, the plan sets tomorrow’s drills.',
      plan: {
        title: 'Adaptive study plan',
        body: 'A dated roadmap to your target band that rewrites itself after every result, so you always know what to do today.',
      },
      mocks: {
        title: 'Full mock tests',
        body: 'Listening, Reading, Writing and Speaking in the authentic computer-delivered format, with real timing and instant answer keys.',
      },
      writing: {
        title: 'Writing examiner',
        body: 'Band 0–9 across all four criteria with your own sentences annotated inline — what cost you marks and how to rewrite it.',
      },
      speaking: {
        title: 'Speaking examiner',
        body: 'Record a full Part 1–3 interview. The AI transcribes you, measures pace, pauses and fillers, then grades every criterion.',
      },
      stats: {
        title: 'Progress analytics',
        body: 'Band trajectory per skill, your current bottleneck, and readiness for the real exam at a glance.',
      },
      arcade: {
        title: 'Speak or Die arcade',
        body: 'Fast fluency drills that kill hesitation — the part of Speaking no textbook can train.',
      },
      preppy: {
        title: 'Preppy AI mentor',
        body: 'A tutor that knows your history: ask why a band was given and get the fix, not a generic tip.',
      },
      vocab: {
        title: 'Vocabulary trainer',
        body: 'Band 7+ collocations pulled from your own mistakes, drilled with spaced repetition.',
      },
    },
    speaking: {
      eyebrow: 'The hardest skill to practise alone',
      title: 'A Speaking examiner that listens to you, not to a checkbox',
      body: 'Most candidates never hear why their Speaking band is stuck. Ever Study records your full answer, transcribes it word for word, and marks it the way a certified examiner would.',
      point1: 'Verbatim transcript with every hesitation and filler kept in',
      point2: 'Objective metrics: speech rate, pause count and length, filler frequency',
      point3: 'Fluency, Lexis, Grammar and Pronunciation scored separately with evidence',
      point4: 'Three targeted drills generated from what you actually got wrong',
      cta: 'Try a Speaking mock',
    },
    howItWorks: {
      eyebrow: 'How it works',
      title: 'Three steps, then a routine',
      step1: { title: 'Take a diagnostic', body: 'One mock sets your true starting band and finds your bottleneck.' },
      step2: { title: 'Get your plan', body: 'A dated roadmap to your target, weighted towards your weakest skill.' },
      step3: { title: 'Practise and re-score', body: 'Every graded attempt updates the plan and your readiness index.' },
    },
    testimonials: {
      eyebrow: 'Results',
      title: 'What learners say',
    },
    faq: {
      eyebrow: 'FAQ',
      title: 'Questions worth answering',
      q1: 'How accurate is the AI grading?',
      a1: 'Grading follows the public IELTS band descriptors criterion by criterion, and every band comes with the evidence it was based on. Treat it as a well-calibrated practice examiner: excellent for spotting what to fix, not a substitute for your official result.',
      q2: 'Is this an official IELTS product?',
      a2: 'No. Ever Study is an independent preparation platform, not affiliated with or endorsed by the IELTS partners.',
      q3: 'Do I need a microphone?',
      a3: 'For Speaking, yes — any laptop or phone microphone works. Listening, Reading and Writing need nothing but a browser.',
      q4: 'Can I use it on my phone?',
      a4: 'Yes. The platform is fully responsive, though full mock tests are best taken on a laptop to mirror real exam conditions.',
    },
    finalCta: {
      title: 'Your target band starts with one diagnostic',
      body: 'Take a mock today and see exactly how far you are — and what to do about it.',
      cta: 'Start preparing free',
    },
    footer: {
      product: 'Product',
      company: 'Company',
      legal: 'Legal',
      terms: 'Terms',
      privacy: 'Privacy',
      contact: 'Contact',
      disclaimer:
        'Ever Study is an independent preparation platform. We are not affiliated with, approved by or certified by the IELTS partners. IELTS® is a registered trademark of British Council, IDP Education and Cambridge University Press & Assessment; the name is used here solely to identify the exam.',
      rights: 'All rights reserved.',
    },
  },
};
