import { Dictionary } from '../types';

/** Uzbek (Latin) interface. Missing keys fall back to the English dictionary. */
export const uz: Dictionary = {
  brand: {
    name: 'Ever Study',
    tagline: 'Academic IELTS uchun AI-baholash tizimi',
  },

  common: {
    startPrep: 'Tayyorgarlikni boshlash',
    openPlatform: 'Platformani ochish',
    signIn: 'Kirish',
    back: 'Orqaga',
    close: 'Yopish',
    cancel: 'Bekor qilish',
    save: 'Saqlash',
    retry: 'Qayta urinish',
    loading: 'Yuklanmoqda…',
    minutes: '{count} daqiqa',
    band: 'Band',
    target: 'Maqsad',
    overall: 'Umumiy',
    language: 'Til',
    soon: 'Tez orada',
  },

  nav: {
    plan: 'Reja',
    planLong: 'Moslashuvchan reja',
    mocks: 'Sinov testlar',
    mocksLong: 'Testlar va mashqlar',
    exam: 'Imtihon rejimi',
    arcade: 'Speak or Die',
    stats: 'Statistika',
    preppy: 'Preppy AI',
    admin: 'Admin panel',
    account: 'Hisob',
    targetBand: 'Maqsadli ball',
  },

  landing: {
    nav: {
      platform: 'Platforma',
      reviews: 'Sharhlar',
      guarantee: 'Kafolat',
      faq: 'Savollar',
    },
    hero: {
      eyebrow: 'Academic IELTS',
      title: 'Kerakli ballni birinchi urinishdayoq oling',
      subtitle:
        'Bitta joyda yettita tayyorgarlik vositasi — markazida Writing va Speakingingizni rasmiy mezonlar bo‘yicha baholaydigan AI-imtihonchi.',
      primaryCta: 'Bepul boshlash',
      secondaryCta: 'Platformani ko‘rish',
      note: 'Karta kerak emas · To‘g‘ridan-to‘g‘ri brauzerda ishlaydi',
    },
    proof: {
      title: 'Haqiqiy imtihon asosida qurilgan, uning soddalashtirilgan nusxasi emas',
      modules: { value: '4', label: 'IELTS moduli' },
      questionTypes: { value: '16', label: 'rasmiy savol turi' },
      themes: { value: '36+', label: 'bazadagi imtihon mavzusi' },
      speed: { value: '<60s', label: 'odatdagi baholash vaqti' },
    },
    tools: {
      eyebrow: 'Platforma ichida',
      title: 'Tayyorgarlikka kerak bo‘lgan hamma narsa, ortiqchasisiz',
      subtitle: 'Vositalar bir-biriga ulangan: natijalar rejani o‘zgartiradi, reja ertangi mashqlarni belgilaydi.',
      plan: {
        title: 'Moslashuvchan reja',
        body: 'Maqsadli ballgacha sanali yo‘l xaritasi — har bir natijadan keyin o‘zini qayta yozadi, shuning uchun bugun nima qilishni doim bilasiz.',
      },
      mocks: {
        title: 'To‘liq sinov testlar',
        body: 'Listening, Reading, Writing va Speaking haqiqiy kompyuter formatida, real vaqt hisobi va darhol javob kalitlari bilan.',
      },
      writing: {
        title: 'Writing imtihonchisi',
        body: 'To‘rtta mezon bo‘yicha 0–9 ball, o‘z gaplaringiz matn ichida belgilangan holda: nima ball yo‘qotgani va qanday qayta yozish kerakligi.',
      },
      speaking: {
        title: 'Speaking imtihonchisi',
        body: 'To‘liq Part 1–3 suhbatini yozib oling. AI nutqni matnga aylantiradi, sur’at, pauza va ortiqcha so‘zlarni o‘lchaydi va har bir mezonni baholaydi.',
      },
      stats: {
        title: 'Progress tahlili',
        body: 'Har bir ko‘nikma bo‘yicha ball dinamikasi, hozirgi zaif nuqta va haqiqiy imtihonga tayyorlik — bitta ekranda.',
      },
      arcade: {
        title: 'Speak or Die arkadasi',
        body: 'Ravonlikni oshiradigan tezkor mashqlar — hech bir darslik o‘rgatolmaydigan narsa.',
      },
      preppy: {
        title: 'Preppy AI mentor',
        body: 'Tarixingizni biladigan repetitor: nega shu ball qo‘yilganini so‘rang va umumiy maslahat emas, aniq tahlil oling.',
      },
      vocab: {
        title: 'Lug‘at mashqi',
        body: 'O‘z xatolaringizdan yig‘ilgan Band 7+ darajasidagi kollokatsiyalar, interval takrorlash bilan mustahkamlanadi.',
      },
    },
    speaking: {
      eyebrow: 'Yolg‘iz mashq qilish eng qiyin bo‘lgan ko‘nikma',
      title: 'Sizni tinglaydigan Speaking imtihonchisi',
      body: 'Ko‘pchilik nomzod Speaking bali nega joyida turganini hech qachon bilmaydi. Ever Study javobingizni to‘liq yozib oladi, so‘zma-so‘z matnga aylantiradi va sertifikatlangan imtihonchi kabi baholaydi.',
      point1: 'Barcha pauzalar va ortiqcha so‘zlar saqlangan so‘zma-so‘z matn',
      point2: 'Obyektiv ko‘rsatkichlar: nutq sur’ati, pauzalar soni va uzunligi, filler chastotasi',
      point3: 'Fluency, Lexis, Grammar va Pronunciation alohida va asos bilan baholanadi',
      point4: 'Aynan sizning xatolaringizga qarab tuzilgan uchta aniq mashq',
      cta: 'Speaking testini sinab ko‘rish',
    },
    howItWorks: {
      eyebrow: 'Qanday ishlaydi',
      title: 'Uch qadam, keyin esa tartib',
      step1: { title: 'Diagnostikadan o‘ting', body: 'Bitta sinov test haqiqiy boshlang‘ich balingizni va zaif nuqtangizni aniqlaydi.' },
      step2: { title: 'Rejangizni oling', body: 'Maqsad sari sanali yo‘l xaritasi, eng zaif ko‘nikmaga urg‘u berilgan holda.' },
      step3: { title: 'Mashq qiling va qayta baholang', body: 'Har bir tekshirilgan urinish rejani va tayyorlik indeksini yangilaydi.' },
    },
    testimonials: {
      eyebrow: 'Natijalar',
      title: 'O‘quvchilar nima deydi',
    },
    faq: {
      eyebrow: 'Savollar',
      title: 'So‘rashga arziydigan savollar',
      q1: 'AI baholashi qanchalik aniq?',
      a1: 'Baholash IELTSning ochiq mezonlari bo‘yicha, mezonma-mezon amalga oshiriladi va har bir ballga asos ilova qilinadi. Buni yaxshi sozlangan mashq imtihonchisi deb biling: nimani tuzatish kerakligini a’lo darajada ko‘rsatadi, lekin rasmiy natijani almashtirmaydi.',
      q2: 'Bu rasmiy IELTS mahsulotimi?',
      a2: 'Yo‘q. Ever Study — mustaqil tayyorgarlik platformasi, IELTS hamkorlari bilan aloqador emas va ular tomonidan tasdiqlanmagan.',
      q3: 'Mikrofon kerakmi?',
      a3: 'Speaking uchun ha — noutbuk yoki telefonning istalgan mikrofoni yetarli. Listening, Reading va Writing uchun faqat brauzer kerak.',
      q4: 'Telefonda ishlatsa bo‘ladimi?',
      a4: 'Ha, platforma to‘liq moslashuvchan. To‘liq sinov testlarni noutbukda topshirgan qulayroq — haqiqiy imtihon sharoitiga yaqinroq.',
    },
    finalCta: {
      title: 'Maqsadli balingiz bitta diagnostikadan boshlanadi',
      body: 'Bugun sinov testdan o‘ting va maqsadgacha qancha qolganini — hamda nima qilish kerakligini ko‘ring.',
      cta: 'Bepul boshlash',
    },
    footer: {
      product: 'Mahsulot',
      company: 'Kompaniya',
      legal: 'Huquqiy',
      terms: 'Shartlar',
      privacy: 'Maxfiylik',
      contact: 'Aloqa',
      disclaimer:
        'Ever Study — mustaqil tayyorgarlik platformasi. Biz IELTS hamkorlari bilan aloqador emasmiz, ular tomonidan tasdiqlanmagan va sertifikatlanmaganmiz. IELTS® — British Council, IDP Education va Cambridge University Press & Assessment kompaniyalarining ro‘yxatdan o‘tgan savdo belgisi; bu nom bu yerda faqat imtihonni belgilash uchun ishlatiladi.',
      rights: 'Barcha huquqlar himoyalangan.',
    },
  },
};
