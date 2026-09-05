export interface IELTSTheme {
  id: string;
  name: string;
  category: string;
  description: string;
}

export interface QuestionTypeDefinition {
  id: string;
  name: string;
  description: string;
  testedSkills: string[];
}

export type TargetBandTier = '5.0-5.5' | '6.0-6.5' | '7.0-7.5' | '8.0+';

export const IELTS_THEMES: IELTSTheme[] = [
  { id: 'theme-education', name: 'Education & Pedagogy', category: 'Society', description: 'Curriculum design, higher education funding, distance learning, and rote vs critical thinking.' },
  { id: 'theme-environment', name: 'Environmental Science & Climate', category: 'Science', description: 'Carbon sequestration, biodiversity loss, urban microclimates, and ocean acidification.' },
  { id: 'theme-technology-ai', name: 'Artificial Intelligence & Automation', category: 'Technology', description: 'Machine learning ethics, workforce automation, algorithmic bias, and neural computing.' },
  { id: 'theme-urbanization', name: 'Urban Planning & Megacities', category: 'Architecture', description: 'Smart transit, sustainable high-density housing, heat island effect, and public spaces.' },
  { id: 'theme-public-health', name: 'Public Health & Epidemiology', category: 'Medicine', description: 'Preventative medicine, lifestyle diseases, antimicrobial resistance, and healthcare economics.' },
  { id: 'theme-space', name: 'Astronomy & Space Exploration', category: 'Science', description: 'Planetary geology, satellite telecommunications, extraterrestrial habitability, and telescope technology.' },
  { id: 'theme-marine-biology', name: 'Marine Biology & Oceanography', category: 'Science', description: 'Coral reef restoration, deep-sea organisms, cephalopod intelligence, and maritime pollution.' },
  { id: 'theme-agriculture', name: 'Sustainable Agriculture & Food Security', category: 'Economy', description: 'Precision farming, hydroponics, genetic crop resilience, and global supply logistics.' },
  { id: 'theme-archaeology', name: 'Archaeology & Ancient Civilizations', category: 'History', description: 'Radiocarbon dating, decipherment of ancient scripts, settlement excavations, and museum artifacts.' },
  { id: 'theme-linguistics', name: 'Linguistics & Cognitive Communication', category: 'Humanities', description: 'Language acquisition, endangered dialects, phonetic evolution, and neurolinguistics.' },
  { id: 'theme-transport', name: 'Transport Engineering & Mobility', category: 'Infrastructure', description: 'High-speed rail, electric vehicle grid adoption, traffic flow algorithms, and aviation decarbonization.' },
  { id: 'theme-economy', name: 'Global Economics & Trade', category: 'Economy', description: 'Fiscal stimulus, inflation dynamics, developing nation industrialization, and trade tariffs.' },
  { id: 'theme-work-culture', name: 'Employment Dynamics & Remote Work', category: 'Society', description: 'Gig economy, workplace ergonomics, flexible scheduling, and lifelong vocational reskilling.' },
  { id: 'theme-media', name: 'Media Literacy & Digital Information', category: 'Media', description: 'Algorithmic feeds, misinformation detection, investigative journalism, and cognitive overload.' },
  { id: 'theme-psychology', name: 'Cognitive Psychology & Behavior', category: 'Social Science', description: 'Decision heuristics, habit formation, sleep neurology, and childhood resilience.' },
  { id: 'theme-arts-heritage', name: 'Cultural Heritage & The Arts', category: 'Culture', description: 'State funding for theatre, indigenous folklore preservation, architectural restoration, and digital galleries.' },
  { id: 'theme-sports-physiology', name: 'Sports Science & Human Physiology', category: 'Sports', description: 'Aerobic biomechanics, athletic recovery nutrition, community recreation, and cardiovascular health.' },
  { id: 'theme-energy', name: 'Renewable Energy & Power Grids', category: 'Energy', description: 'Offshore wind farms, photovoltaic efficiency, grid-scale battery storage, and nuclear fission safety.' },
  { id: 'theme-justice', name: 'Law, Criminology & Rehabilitation', category: 'Law', description: 'Restorative justice, juvenile delinquency prevention, custodial sentencing vs vocational training.' },
  { id: 'theme-tourism', name: 'Eco-Tourism & Cultural Travel', category: 'Travel', description: 'Overtourism mitigation, heritage site preservation, budget aviation, and community-based lodging.' },
  { id: 'theme-demographics', name: 'Demographic Shifts & Aging Societies', category: 'Society', description: 'Sub-replacement fertility rates, pension solvency, eldercare infrastructure, and intergenerational equity.' },
  { id: 'theme-water', name: 'Hydrology & Freshwater Scarcity', category: 'Environment', description: 'Desalination plants, aquifer depletion, glacial runoff monitoring, and agricultural irrigation efficiency.' },
  { id: 'theme-robotics', name: 'Robotics & Industrial Automation', category: 'Technology', description: 'Warehouse robotics, robotic surgery precision, tactile sensors, and human-robot interaction.' },
  { id: 'theme-consumerism', name: 'Consumerism & Circular Economy', category: 'Society', description: 'Fast fashion waste, planned obsolescence, consumer psychology, and repairability rights.' },
  { id: 'theme-materials', name: 'Material Science & Nanotechnology', category: 'Science', description: 'Carbon nanotubes, biodegradable polymers, self-healing concrete, and smart textiles.' },
  { id: 'theme-biodiversity', name: 'Ecological Conservation & Rewilding', category: 'Nature', description: 'Predator reintroduction, wildlife corridors, poaching surveillance, and habitat fragmentation.' },
  { id: 'theme-parenting', name: 'Childhood Development & Modern Parenting', category: 'Family', description: 'Screen time limits, early childhood socialization, compulsory kindergarten, and emotional intelligence.' },
  { id: 'theme-commerce', name: 'E-Commerce & Retail Transformation', category: 'Business', description: 'Last-mile fulfillment logistics, brick-and-mortar survival, cashless transactions, and consumer trust.' },
  { id: 'theme-mental-health', name: 'Mental Well-Being & Stress Dynamics', category: 'Health', description: 'Mindfulness clinical evidence, workplace burnout prevention, social isolation, and youth anxiety.' },
  { id: 'theme-museums', name: 'Museum Curation & Public Access', category: 'Culture', description: 'Free vs paid admission policies, repatriation of artifacts, immersive exhibitions, and educational outreach.' },
  { id: 'theme-privacy', name: 'Digital Privacy & Surveillance Ethics', category: 'Technology', description: 'Facial recognition regulation, biometric data sovereignty, cybersecurity laws, and targeted advertising.' },
  { id: 'theme-traditional-crafts', name: 'Traditional Crafts & Modern Industry', category: 'Culture', description: 'Artisanal weaving, apprenticeship decline, 3D printing integration, and intangible cultural heritage.' },
  { id: 'theme-meteorology', name: 'Meteorology & Extreme Weather', category: 'Science', description: 'Early warning radar systems, storm surge barriers, drought prediction, and atmospheric modeling.' },
  { id: 'theme-zoology', name: 'Animal Cognition & Ethology', category: 'Nature', description: 'Corvid problem-solving, primate communication, cetacean acoustics, and insect colony intelligence.' },
  { id: 'theme-telecom', name: 'Telecommunications & Global Connectivity', category: 'Infrastructure', description: 'Subsea fiber-optic cables, 6G development, low-Earth orbit satellite internet, and rural broadband access.' },
  { id: 'theme-architecture', name: 'Sustainable Architecture & Biophilic Design', category: 'Design', description: 'Passive solar heating, cross-laminated timber, vertical gardens, and natural ventilation in skyscrapers.' }
];

export const READING_QUESTION_TYPES: QuestionTypeDefinition[] = [
  { id: 'multiple_choice', name: 'Multiple Choice (Single/Multi Answer)', description: 'Selecting 1 of 4 or 2 of 5 options based on passage details.', testedSkills: ['Detailed comprehension', 'Distractor elimination'] },
  { id: 'true_false_not_given', name: 'True / False / Not Given', description: 'Factual verification against stated facts in the text.', testedSkills: ['Factual precision', 'Distinguishing contradiction from lack of info'] },
  { id: 'yes_no_not_given', name: 'Yes / No / Not Given', description: 'Assessing author opinions, perspectives, and claims.', testedSkills: ['Writer stance identification', 'Hedging and tone recognition'] },
  { id: 'matching_headings', name: 'Matching Headings', description: 'Matching roman numeral headings to designated paragraphs.', testedSkills: ['Gist extraction', 'Main idea vs supporting detail separation'] },
  { id: 'matching_information', name: 'Matching Information', description: 'Identifying which paragraph contains a specific mentioned fact.', testedSkills: ['Non-sequential scanning', 'Paraphrase recognition'] },
  { id: 'matching_features', name: 'Matching Features', description: 'Connecting names of researchers or theories with statements.', testedSkills: ['Entity tracking across text', 'Theoretical synthesis'] },
  { id: 'sentence_completion', name: 'Sentence Completion', description: 'Filling gaps in sentences with exact words from text (NO MORE THAN X WORDS).', testedSkills: ['Grammatical fit', 'Precise text retrieval'] },
  { id: 'summary_completion', name: 'Summary / Note / Table Completion', description: 'Completing an academic summary with exact words or word bank.', testedSkills: ['Macro-comprehension', 'Syntactic transformation'] },
  { id: 'diagram_label_completion', name: 'Diagram / Flow-Chart Label Completion', description: 'Labeling steps in a scientific process or technical drawing.', testedSkills: ['Process sequence comprehension', 'Spatial/technical vocabulary'] },
  { id: 'short_answer', name: 'Short-Answer Questions', description: 'Answering direct analytical questions with strict word limits.', testedSkills: ['Direct information retrieval', 'Exact word counting'] }
];

export const LISTENING_QUESTION_TYPES: QuestionTypeDefinition[] = [
  { id: 'form_completion', name: 'Form / Note / Table Completion', description: 'Filling in customer records, reservation details, or seminar schedules.', testedSkills: ['Spelling accuracy', 'Number/date decoding'] },
  { id: 'multiple_choice', name: 'Multiple Choice', description: 'Selecting correct option from dialogue or lecture.', testedSkills: ['Handling speaker self-correction', 'Distractor awareness'] },
  { id: 'matching', name: 'Matching Options', description: 'Matching categories (e.g., pros/cons, research methods) to proposals.', testedSkills: ['Discourse tracking', 'Opinion attribution'] },
  { id: 'map_diagram_labelling', name: 'Plan / Map / Diagram Labelling', description: 'Orienting through campus maps, room floor plans, or device blueprints.', testedSkills: ['Spatial prepositions', 'Directional cue tracking'] },
  { id: 'sentence_completion', name: 'Sentence Completion', description: 'Completing lecture takeaways using speaker exact words.', testedSkills: ['Syntactic prediction', 'Auditory parsing'] },
  { id: 'short_answer', name: 'Short-Answer Questions', description: 'Brief factual responses to questions from the audio script.', testedSkills: ['Precise auditory extraction', 'Constraint obedience'] }
];

export const WRITING_TASK1_ACADEMIC_TYPES = [
  { id: 'line_graph', name: 'Line Graph (Trends over time)' },
  { id: 'bar_chart', name: 'Bar Chart (Comparative categories)' },
  { id: 'pie_chart', name: 'Pie Chart (Proportional distributions)' },
  { id: 'data_table', name: 'Data Table (Dense statistical comparison)' },
  { id: 'process_diagram', name: 'Process Diagram (Man-made or natural cycle)' },
  { id: 'map_comparison', name: 'Map Comparison (Site changes over past/future)' },
  { id: 'mixed_charts', name: 'Mixed Charts (e.g. Bar Chart + Pie Chart)' }
];

export const WRITING_TASK1_GT_TYPES = [
  { id: 'formal_letter', name: 'Formal Letter (To authority, employer, company)' },
  { id: 'semi_formal_letter', name: 'Semi-Formal Letter (To landlord, colleague, club)' },
  { id: 'informal_letter', name: 'Informal Letter (To close friend or family member)' }
];

export const WRITING_TASK2_TYPES = [
  { id: 'opinion', name: 'Opinion Essay (To what extent do you agree or disagree?)' },
  { id: 'discussion', name: 'Discussion Essay (Discuss both views and give your opinion)' },
  { id: 'advantages_disadvantages', name: 'Advantages vs Disadvantages (Neutral or Outweigh)' },
  { id: 'problem_solution', name: 'Problem & Solution / Causes & Solutions' },
  { id: 'cause_effect', name: 'Cause & Effect (Analytical, objective examination)' },
  { id: 'two_part', name: 'Two-Part Question (Two distinct direct questions)' }
];

export const SPEAKING_PART2_CATEGORIES = [
  { id: 'person', name: 'Describe a person (Mentor, artist, family member, stranger)' },
  { id: 'place', name: 'Describe a place (Historic building, natural spot, city, quiet haven)' },
  { id: 'object', name: 'Describe an object (Piece of technology, heirloom, book, gift)' },
  { id: 'event', name: 'Describe an event (Celebration, cultural festival, achievement)' },
  { id: 'experience', name: 'Describe an experience (Time you helped someone, made a tough choice)' },
  { id: 'activity', name: 'Describe an activity (New hobby, sport, outdoor excursion, daily routine)' }
];
