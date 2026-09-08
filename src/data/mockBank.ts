import { READING_TEST_1 } from './readingTest1';
import { MockTest } from '../types';

export const MOCK_TEST_1: MockTest = {
  id: 'test-1',
  testNumber: 1,
  title: 'Academic Practice Test 1 (Full Simulation)',
  difficulty: 'Standard Academic',
  listening: {
    parts: [
      {
        partNumber: 1,
        title: 'Part 1: Eco-Lodge Rental Enquiry',
        accent: 'British',
        audioDescription: 'A phone conversation between a traveler, Marcus, and a customer service representative at GreenPines Eco-Lodges.',
        transcript: `Representative: Good morning! GreenPines Eco-Lodges, Sarah speaking. How may I assist you today?
Marcus: Good morning, Sarah. I am planning a family retreat for next month and wanted to inquire about rental availability for your timber lodges.
Representative: Certainly, sir. Let me take down a few details first. Could I have your full surname and initial, please?
Marcus: It is Marcus Vance. That is V-A-N-C-E.
Representative: Thank you, Mr. Vance. And what dates are you considering?
Marcus: We would like to check in on the 14th of October and stay for four nights, leaving on the 18th.
Representative: Perfect. That falls right into our autumn foliage season. How many adults and children will be in your party?
Marcus: There will be three adults and two children, aged seven and ten.
Representative: Right. In that case, our Forest View Cabin would be ideal. It features three bedrooms, a fully equipped kitchen, and solar-assisted heating. The total rate for four nights is 420 pounds, including parking.
Marcus: That sounds very reasonable. Does the rate include access to the bicycle rental station?
Representative: Yes, mountain bicycles and safety helmets are complimentary for all lodge guests. However, if you would like guided nature walks, there is a small surcharge of 15 pounds per adult.
Marcus: Wonderful. I also saw on your website that you provide a welcome breakfast basket on the first morning. Could you confirm what is inside?
Representative: Yes, indeed! We provide artisan sourdough bread, organic farm eggs, local honey, and a carton of fresh oat milk.
Marcus: Superb. My wife has a dairy sensitivity, so oat milk is just right. How do I secure the booking?
Representative: We require a deposit of 20 percent today by credit or debit card, and the balance is payable upon arrival.
Marcus: That suits me. Let me give you my card number now.`,
        questions: [
          {
            id: 'l1-q1',
            questionNumber: 1,
            type: 'fill_in_blank',
            prompt: 'Caller’s surname: [ 1 ]',
            correctAnswer: ['Vance', 'VANCE'],
            explanation: 'Marcus spells his surname: V-A-N-C-E.',
          },
          {
            id: 'l1-q2',
            questionNumber: 2,
            type: 'fill_in_blank',
            prompt: 'Date of arrival: [ 2 ] October',
            correctAnswer: ['14', '14th', 'fourteenth'],
            explanation: 'He says: "check in on the 14th of October".',
          },
          {
            id: 'l1-q3',
            questionNumber: 3,
            type: 'fill_in_blank',
            prompt: 'Recommended accommodation type: [ 3 ] Cabin',
            correctAnswer: ['Forest View', 'forest view'],
            explanation: 'Representative says: "our Forest View Cabin would be ideal".',
          },
          {
            id: 'l1-q4',
            questionNumber: 4,
            type: 'fill_in_blank',
            prompt: 'Total price for four nights: £ [ 4 ]',
            correctAnswer: ['420', 'four hundred and twenty', '420 pounds'],
            explanation: 'The representative states: "The total rate for four nights is 420 pounds".',
          },
          {
            id: 'l1-q5',
            questionNumber: 5,
            type: 'fill_in_blank',
            prompt: 'Complimentary items provided for guests: mountain bicycles and safety [ 5 ]',
            correctAnswer: ['helmets', 'safety helmets', 'helmet'],
            explanation: 'She says: "mountain bicycles and safety helmets are complimentary".',
          },
          {
            id: 'l1-q6',
            questionNumber: 6,
            type: 'multiple_choice',
            prompt: 'What additional service requires a surcharge of £15 per adult?',
            options: ['A) High-speed broadband access', 'B) Guided nature walks', 'C) Electric vehicle charging'],
            correctAnswer: 'B) Guided nature walks',
            explanation: 'She mentions: "if you would like guided nature walks, there is a small surcharge of 15 pounds per adult".',
          },
          {
            id: 'l1-q7',
            questionNumber: 7,
            type: 'fill_in_blank',
            prompt: 'Breakfast basket includes sourdough bread, organic eggs, local honey, and [ 7 ] milk.',
            correctAnswer: ['oat', 'fresh oat'],
            explanation: 'She says: "a carton of fresh oat milk".',
          },
          {
            id: 'l1-q8',
            questionNumber: 8,
            type: 'fill_in_blank',
            prompt: 'Deposit percentage required to confirm booking: [ 8 ] %',
            correctAnswer: ['20', '20%', 'twenty'],
            explanation: 'Representative notes: "We require a deposit of 20 percent today".',
          },
          {
            id: 'l1-q9',
            questionNumber: 9,
            type: 'multiple_choice',
            prompt: 'When must the remaining balance of the payment be settled?',
            options: ['A) 48 hours before check-in', 'B) Upon arrival at the lodge', 'C) At the end of the stay'],
            correctAnswer: 'B) Upon arrival at the lodge',
            explanation: 'Representative specifies: "the balance is payable upon arrival".',
          },
          {
            id: 'l1-q10',
            questionNumber: 10,
            type: 'multiple_choice',
            prompt: 'What special dietary consideration did Marcus note?',
            options: ['A) Gluten intolerance', 'B) Nut allergy', 'C) Dairy sensitivity'],
            correctAnswer: 'C) Dairy sensitivity',
            explanation: 'Marcus notes: "My wife has a dairy sensitivity".',
          },
        ],
      },
      {
        partNumber: 2,
        title: 'Part 2: Community Botanical Reserve Volunteer Program',
        accent: 'Australian',
        audioDescription: 'A presentation given by the head coordinator of the Kingfisher Botanical Reserve to newly recruited volunteer guides.',
        transcript: `Welcome everyone to the Kingfisher Botanical Reserve. My name is Liam, and I coordinate our volunteer conservation community. Today, our 120-hectare reserve stands as a sanctuary for endangered coastal flora and migratory songbirds, but achieving this status has taken over fifteen years of continuous habitat regeneration.
When the municipal trust took over the site in 2008, it was largely degraded grazing pasture with severe soil erosion. Our initial priority was stabilizing the creek banks using native sedges and paperbark trees. Today, visitors can enjoy over six kilometers of boardwalks and elevated canopy pathways.
As volunteers, your primary role will be welcoming weekend visitors and leading thirty-minute interpretive walks. Most visitors enter through the Visitor Pavilion near the north car park. Directly adjacent to the pavilion on the eastern side is our newly opened Heritage Seed Nursery, where we propagate rare orchids. If you walk along the main trail toward the wetlands, you will arrive at the Kingfisher Observation Hide. Please remind guests that flash photography is strictly prohibited inside the hide, as it disturbs nesting grebes and bitterns.
Regarding safety protocol: all volunteers must wear high-visibility vests and carry a two-way radio at all times. In case of extreme fire danger ratings, which occasionally occur during midsummer heatwaves, the entire reserve is closed to the public by 9:00 AM, and all staff gather at the emergency assembly point behind the maintenance shed.`,
        questions: [
          {
            id: 'l1-q11',
            questionNumber: 11,
            type: 'multiple_choice',
            prompt: 'What was the site primarily used for prior to 2008?',
            options: ['A) An industrial timber mill', 'B) Degraded grazing pasture', 'C) A municipal landfill'],
            correctAnswer: 'B) Degraded grazing pasture',
            explanation: 'Liam notes: "it was largely degraded grazing pasture with severe soil erosion".',
          },
          {
            id: 'l1-q12',
            questionNumber: 12,
            type: 'fill_in_blank',
            prompt: 'Initial conservation work focused on planting native sedges and [ 12 ] trees.',
            correctAnswer: ['paperbark', 'paperbark trees', 'paper bark'],
            explanation: 'He states: "native sedges and paperbark trees".',
          },
          {
            id: 'l1-q13',
            questionNumber: 13,
            type: 'multiple_choice',
            prompt: 'Where is the Heritage Seed Nursery located in relation to the Visitor Pavilion?',
            options: ['A) Directly to the western side', 'B) Adjacent on the eastern side', 'C) Behind the wetlands hide'],
            correctAnswer: 'B) Adjacent on the eastern side',
            explanation: 'He states: "Directly adjacent to the pavilion on the eastern side is our newly opened Heritage Seed Nursery".',
          },
          {
            id: 'l1-q14',
            questionNumber: 14,
            type: 'multiple_choice',
            prompt: 'What rule must visitors obey at the Kingfisher Observation Hide?',
            options: ['A) No binoculars allowed', 'B) Flash photography is prohibited', 'C) Children under ten cannot enter'],
            correctAnswer: 'B) Flash photography is prohibited',
            explanation: 'He emphasizes: "flash photography is strictly prohibited inside the hide".',
          },
          {
            id: 'l1-q15',
            questionNumber: 15,
            type: 'fill_in_blank',
            prompt: 'Mandatory safety equipment includes high-visibility vests and a [ 15 ] radio.',
            correctAnswer: ['two-way', 'two way', '2-way'],
            explanation: 'He reminds: "wear high-visibility vests and carry a two-way radio".',
          },
        ],
      },
      {
        partNumber: 3,
        title: 'Part 3: Marine Kelp Forest Ecosystem Study',
        accent: 'North American',
        audioDescription: 'A tutorial discussion between two graduate students, Chloe and Ethan, and their biology professor, Dr. Miller.',
        transcript: `Dr. Miller: Welcome Chloe, Ethan. Let’s look at your preliminary methodology for monitoring giant kelp decline along the western coastline.
Chloe: Thanks Dr. Miller. We’ve noticed that while sea surface temperature anomalies are the primary focus of most literature, the proliferation of purple sea urchins appears to be the immediate driving force behind the formation of urchin barrens.
Ethan: Exactly. Over the past five years, the local sea otter population—which acts as a keystone predator keeping urchin densities checked—has experienced severe predation pressure from transient orcas. Without otter predation, the urchins graze down kelp holdfasts with astonishing speed.
Dr. Miller: That trophic cascade is well documented. But how are you proposing to collect empirical field measurements without disturbing the marine sanctuary boundaries?
Chloe: We propose using remote underwater acoustic telemetry sensors alongside quadcopter aerial drone imagery. The drone surveys can quantify canopy surface area during low tide at 10-centimeter resolution.
Ethan: And for sub-surface density, we’ll dive along fixed 50-meter transect lines at six designated coordinates twice monthly.
Dr. Miller: That combination sounds robust. However, you must account for seasonal water turbidity in your drone imagery calibration. If chlorophyll blooms peak in May, water clarity drops dramatically, skewing edge-detection algorithms.
Chloe: That is a great point. We can integrate a water clarity Secchi disk reading into every flight dataset to normalize the optical variance.`,
        questions: [
          {
            id: 'l1-q16',
            questionNumber: 16,
            type: 'multiple_choice',
            prompt: 'According to the students, what directly causes the rapid destruction of kelp holdfasts?',
            options: ['A) Direct heatwave bleaching', 'B) Overgrazing by purple sea urchins', 'C) Chemical agricultural runoff'],
            correctAnswer: 'B) Overgrazing by purple sea urchins',
            explanation: 'They note: "the proliferation of purple sea urchins appears to be the immediate driving force... urchins graze down kelp holdfasts".',
          },
          {
            id: 'l1-q17',
            questionNumber: 17,
            type: 'multiple_choice',
            prompt: 'Why has the local sea otter population declined in the studied area?',
            options: ['A) Severe disease outbreaks', 'B) Lack of shellfish food', 'C) Predation by transient orcas'],
            correctAnswer: 'C) Predation by transient orcas',
            explanation: 'Ethan states: "sea otter population... has experienced severe predation pressure from transient orcas".',
          },
          {
            id: 'l1-q18',
            questionNumber: 18,
            type: 'fill_in_blank',
            prompt: 'Drone surveys will measure kelp canopy during [ 18 ] tide.',
            correctAnswer: ['low', 'low tide'],
            explanation: 'Chloe says: "quantify canopy surface area during low tide".',
          },
          {
            id: 'l1-q19',
            questionNumber: 19,
            type: 'fill_in_blank',
            prompt: 'Underwater diver surveys will follow [ 19 ] -meter transect lines.',
            correctAnswer: ['50', 'fifty'],
            explanation: 'Ethan states: "dive along fixed 50-meter transect lines".',
          },
          {
            id: 'l1-q20',
            questionNumber: 20,
            type: 'multiple_choice',
            prompt: 'What potential challenge does Dr. Miller highlight regarding drone aerial imagery?',
            options: ['A) Battery life in cold weather', 'B) Water turbidity from algal blooms', 'C) Licensing restrictions over sanctuaries'],
            correctAnswer: 'B) Water turbidity from algal blooms',
            explanation: 'Dr. Miller warns: "account for seasonal water turbidity... chlorophyll blooms peak in May, water clarity drops".',
          },
        ],
      },
      {
        partNumber: 4,
        title: 'Part 4: Biomimetic Architecture and Urban Thermodynamic Design',
        accent: 'British',
        audioDescription: 'An academic lecture on how principles derived from natural organisms are transforming passive cooling in modern skyscrapers.',
        transcript: `Good afternoon, colleagues. Today we examine how biomimicry—the intentional emulation of biological strategies—is offering sustainable solutions to the escalating thermodynamic demands of modern architecture.
Traditional commercial towers expend between forty and fifty percent of their total operational energy on mechanical HVAC systems. Yet in arid ecosystems, social insects such as macrotermes termites maintain brood chamber temperatures at an unvarying thirty degrees Celsius, despite ambient external fluctuations ranging from two degrees at night to over forty-five degrees during peak daylight.
Termite mounds achieve this feat not through active refrigeration, but through a complex network of internal air shafts driven by solar buoyancy. The outer porous walls absorb heat during the day, creating convective currents that draw cool air from underground subterranean reservoirs into the lower galleries, while warm, stale air exits through the central chimney stack.
Architect Mick Pearce famously translated this thermodynamic mechanism into the Eastgate Centre in Harare, Zimbabwe. By eliminating conventional air conditioning machinery, the building consumes thirty-five percent less energy than comparable commercial offices in the region, saving the building owners millions of dollars in mechanical upkeep.
Contemporary structural engineers are extending these principles further by utilizing passive evaporative facades modeled after human sweat pores and hydrophilic surfaces inspired by the Namib Desert beetle. The beetle captures microscopic water droplets from morning fog on the hydrophobic ridges of its carapace, funneling moisture directly toward its mouthparts. Integrated onto high-rise cladding, such surfaces can harvest atmospheric condensation for secondary graywater systems.`,
        questions: [
          {
            id: 'l1-q21',
            questionNumber: 21,
            type: 'fill_in_blank',
            prompt: 'Standard commercial towers spend [ 21 ] % to 50% of energy on mechanical cooling.',
            correctAnswer: ['40', 'forty'],
            explanation: 'Lecturer states: "between forty and fifty percent of their total operational energy".',
          },
          {
            id: 'l1-q22',
            questionNumber: 22,
            type: 'fill_in_blank',
            prompt: 'Termite mounds maintain brood chambers at a stable temperature of [ 22 ] degrees Celsius.',
            correctAnswer: ['30', 'thirty'],
            explanation: 'The lecture mentions: "maintain brood chamber temperatures at an unvarying thirty degrees Celsius".',
          },
          {
            id: 'l1-q23',
            questionNumber: 23,
            type: 'fill_in_blank',
            prompt: 'Mound ventilation relies on convective currents driven by [ 23 ] buoyancy.',
            correctAnswer: ['solar', 'solar buoyancy'],
            explanation: 'He states: "internal air shafts driven by solar buoyancy".',
          },
          {
            id: 'l1-q24',
            questionNumber: 24,
            type: 'fill_in_blank',
            prompt: 'The famous building inspired by termite thermodynamics in Harare is the [ 24 ] Centre.',
            correctAnswer: ['Eastgate', 'Eastgate Centre'],
            explanation: 'He refers to "the Eastgate Centre in Harare, Zimbabwe".',
          },
          {
            id: 'l1-q25',
            questionNumber: 25,
            type: 'fill_in_blank',
            prompt: 'Water harvesting facades are modeled on the carapace ridges of the Namib Desert [ 25 ].',
            correctAnswer: ['beetle', 'Namib Desert beetle'],
            explanation: 'He explains: "surfaces inspired by the Namib Desert beetle".',
          },
        ],
      },
    ],
  },
  reading: READING_TEST_1,
  writing: {
    task1: {
      taskNumber: 1,
      title: 'Academic Writing Task 1: Renewable Energy Generation Comparison',
      chartType: 'bar_chart',
      prompt: `The chart below shows the percentage of electricity generated from renewable sources across five countries (Sweden, Germany, Spain, United Kingdom, and Canada) in 2010, 2018, and 2025 (projected).

Summarize the information by selecting and reporting the main features, and make comparisons where relevant.
Write at least 150 words.`,
      chartDescription: 'Comparative Bar Chart: Renewable Energy Generation (% of Total Electricity)',
      chartDataSummary: `Data Breakdown (%):
• Sweden: 2010: 48% | 2018: 56% | 2025 (proj): 67%
• Canada: 2010: 59% | 2018: 65% | 2025 (proj): 72%
• Germany: 2010: 17% | 2018: 38% | 2025 (proj): 54%
• Spain: 2010: 32% | 2018: 40% | 2025 (proj): 50%
• United Kingdom: 2010: 7% | 2018: 33% | 2025 (proj): 52%`,
      minWordCount: 150,
      recommendedMinutes: 20,
      sampleBand9Excerpt: `The bar chart delineates the proportion of electricity produced via renewable resources across five distinct nations between 2010 and 2025. Overall, renewable energy generation experienced substantial upward trajectories across all examined countries, with Canada consistently maintaining the highest baseline share and the United Kingdom demonstrating the most pronounced percentage growth over the fifteen-year period.`,
    },
    task2: {
      taskNumber: 2,
      title: 'Academic Writing Task 2: Artificial Intelligence in Education',
      prompt: `Some educational theorists contend that artificial intelligence and automated tutoring systems will largely replace human classroom teachers within the next two decades. Others insist that human educators are irreplaceable due to socio-emotional guidance and critical mentorship.

Discuss both these views and give your own opinion.
Give reasons for your answer and include any relevant examples from your own knowledge or experience.
Write at least 250 words.`,
      minWordCount: 250,
      recommendedMinutes: 40,
      sampleBand9Excerpt: `Whether artificial intelligence will supplant pedagogical professionals or merely supplement them remains a subject of intense academic discourse. While automated adaptive algorithms offer unprecedented efficiency in individualized content delivery, I firmly argue that human teachers remain indispensable because authentic education requires emotional empathy, moral development, and personalized mentorship that algorithms cannot synthesize.`,
    },
  },
  speaking: {
    parts: [
      {
        partNumber: 1,
        topic: 'Daily Routines, Technology & Hobbies',
        questions: [
          'Could you tell me what you usually do during the first hour after waking up?',
          'How has your daily routine changed compared to when you were younger?',
          'Do you prefer studying or working in complete silence, or with background sound?',
          'What is one hobby you have maintained for several years, and why do you enjoy it?',
        ],
      },
      {
        partNumber: 2,
        topic: 'Describe a challenging skill or subject you learned recently',
        questions: [],
        cueCard: {
          topic: 'Describe a challenging skill or subject you learned recently that required significant persistence.',
          points: [
            'What the skill or subject was',
            'Why you decided to learn it and what resources you used',
            'What specific difficulties you encountered initially',
            'And explain how you felt once you achieved competence in it.',
          ],
          prepTimeSeconds: 60,
          speakTimeSeconds: 120,
        },
      },
      {
        partNumber: 3,
        topic: 'Technological Learning & Future Skills in Modern Society',
        questions: [
          'In what ways has the internet altered how older adults and children acquire new capabilities?',
          'Do you believe formal university degrees will remain the primary qualification for employment in future decades?',
          'How can educational institutions better equip students with critical thinking rather than rote memorization?',
          'Some argue that automation will render learning certain traditional technical skills obsolete. What is your perspective?',
        ],
      },
    ],
  },
};

export const STANDALONE_SPEAK_OR_DIE_TOPICS = [
  {
    id: 'sod-1',
    topic: 'Describe a time when you had to make an important decision under pressure',
    bulletPoints: ['What the situation was', 'Why the decision was difficult', 'Who you consulted', 'What the outcome was'],
  },
  {
    id: 'sod-2',
    topic: 'Describe a piece of advice you received that positively transformed your habits',
    bulletPoints: ['Who gave it to you', 'What the circumstances were', 'Why it was impactful', 'How your life changed'],
  },
  {
    id: 'sod-3',
    topic: 'Describe an environmental challenge affecting your city or region',
    bulletPoints: ['What the problem is', 'What causes it', 'What measures are being taken', 'What additional steps are needed'],
  },
  {
    id: 'sod-4',
    topic: 'Describe a technological device or software that saves you significant time',
    bulletPoints: ['What it is', 'How often you use it', 'How it works', 'Why it is superior to older methods'],
  },
  {
    id: 'sod-5',
    topic: 'Describe a leader or mentor whose dedication inspired you',
    bulletPoints: ['Who this person is', 'What they accomplished', 'What specific qualities you admire', 'How they influenced your goals'],
  },
  {
    id: 'sod-6',
    topic: 'Describe an unforgettable journey or trip you took that did not go as planned',
    bulletPoints: ['Where you were going', 'What unexpected event happened', 'How you reacted', 'Why it remains memorable'],
  },
  {
    id: 'sod-7',
    topic: 'Describe a historical event or landmark that you find fascinating',
    bulletPoints: ['What the landmark/event is', 'Where or when it happened', 'What makes it unique', 'Why you find it compelling'],
  },
  {
    id: 'sod-8',
    topic: 'Describe a book, article, or documentary that changed how you view a global issue',
    bulletPoints: ['What it was called', 'What the central premise was', 'Why it surprised you', 'How it affected your perspective'],
  },
];
