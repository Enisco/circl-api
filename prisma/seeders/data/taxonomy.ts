import { TaxonomyKind } from '@prisma/client';

export interface TaxonomySeed {
  kind: TaxonomyKind;
  code: string;
  label: string;
  description?: string;
  sort: number;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

/** D1 and D22: seed the full vocabulary, activate the subset the app ships. */

// ─── Community categories (spec 0.7, D1) ──────────────────────────────────────
// The 15 the app ships, then the 8 the v2 product spec names and the app does not yet render.
const communityCategories: Array<[string, string, boolean, string[]]> = [
  ['UNIVERSITY_STUDY', 'University / Study', true, ['EDUCATION_TUTORING']],
  ['AIRPORT_PICKUP', 'Airport Pickup', true, ['LOGISTICS']],
  ['NHS_HEALTHCARE', 'NHS / Healthcare', true, ['HEALTHCARE']],
  ['BANK_ACCOUNT', 'Bank Account', true, ['FINANCE_ACCOUNTING']],
  ['ACCOMMODATION', 'Accommodation', true, ['PROPERTY_LETTINGS']],
  ['VISA_DOCS', 'Visa / COS / Docs', true, ['IMMIGRATION', 'LEGAL']],
  ['JOBS', 'Jobs', true, ['CAREERS_CV']],
  ['MOVING_HELP', 'Moving Help', true, ['LOGISTICS']],
  ['MAKE_FRIENDS', 'Make Friends', true, []],
  ['LANGUAGE_HELP', 'Language Help', true, ['TRANSLATION', 'EDUCATION_TUTORING']],
  ['SHOPPING_ERRANDS', 'Shopping / Errands', true, ['LOGISTICS']],
  ['CHILDCARE', 'Childcare', true, ['EDUCATION_TUTORING']],
  ['BEAUTY_HAIR', 'Beauty / Hair', true, ['BEAUTY_HAIR_SERVICES']],
  ['REPAIRS_HANDY', 'Repairs / Handy', true, ['TRADES_REPAIRS']],
  ['OTHER', 'Other', true, []],
  ['SETTLING_IN', 'Settling In', false, []],
  ['TRANSPORT', 'Transport', false, ['LOGISTICS']],
  ['LEGAL_RIGHTS', 'Legal Rights', false, ['LEGAL']],
  ['BENEFITS_SUPPORT', 'Benefits & Support', false, ['FINANCE_ACCOUNTING']],
  ['MENTAL_HEALTH', 'Mental Health', false, ['HEALTHCARE']],
  ['CHILDREN_FAMILY', 'Children & Family', false, ['EDUCATION_TUTORING']],
  ['BUSINESS_SETUP', 'Business Setup', false, ['BUSINESS_CONSULTING', 'FINANCE_ACCOUNTING']],
  ['JOB_SEARCH', 'Job Search', false, ['CAREERS_CV']],
];

// ─── Professions (D8) ─────────────────────────────────────────────────────────
// `isRegulated` and `credentialBodies` drive the credential step's field labels without a hardcoded map in the client (2.7.4), and — more importantly this release — let a regulated profile print the visible line saying Circl has not verified it (D13).
//
// Three flags, three different questions, and v2 made keeping them apart matter more rather than
// less:
//
//   - `isRegulated` — is there a **regulator**: a body you must be registered with to do the work
//     lawfully. Not the same as having a professional body to belong to, which is why `TRANSLATION`
//     carries CIOL, ITI and NRPSI in `credentialBodies` and is `isRegulated: false`: those are
//     membership and voluntary registers, and nobody commits an offence by translating a letter
//     without them.
//   - `requiresVerification` — may this person offer this **service** at all until somebody has
//     read their papers. False on every category and true on 35 subcategories, because
//     *Immigration* is not sensitive and *Immigration solicitor* is (§3.2).
//   - `requiresReview` — should a human read the whole **listing** before anybody can find it. Off
//     everywhere now. Holding a category grants nothing (§2.6), so there is nothing left for it to
//     protect; it stays because it is still the lever an operator can pull on a category that
//     starts going wrong, from `PUT admin/professional-reviews/categories` (permission
//     `professions:gate`).
//
// Both of the last two are operator-owned: a seed run must not undo a decision somebody made in
// the portal, which is why `seedTaxonomy` preserves the live value of those keys. See
// `prisma/seeders/taxonomy.seeder.ts`.
//
/**
 * The fourteen categories of Professionals v2 (§3.3), on the codes that were already live.
 *
 * **The codes are the existing ones wherever a category already existed**, which is the whole
 * reason no live listing has to be migrated. circl-mobile's note assumed eight codes and there
 * were twenty-one, so three of their "existing" codes were new spellings of ours — `FINANCE` for
 * `FINANCE_ACCOUNTING`, `CAREER` for `CAREERS_CV`, `TECH` for `TECH_SOFTWARE` — and five of their
 * "new" categories already existed under longer names. Labels are served, so the product's wording
 * ships without a release; a code is a foreign key in twenty thousand rows.
 *
 * The seven retired below are the ones whose work is now a subcategory of one of the fourteen.
 * They keep rendering wherever somebody already chose them (§8) and are never offered again.
 *
 * `requiresVerification` is **false on every category**: the gate lives on the subcategory,
 * because *Immigration* is not sensitive and *Immigration solicitor* is. `requiresReview` is the
 * old per-listing gate and is off everywhere now — holding a category grants nothing (§2.6), so
 * there is nothing for it to protect. Both keys are sent during the transition (§3.1).
 */
const professions: Array<[string, string, boolean, string[], boolean, boolean?]> = [
  // Giving immigration advice in the UK without IAA (ex-OISC) regulation or an exemption is a
  // criminal offence, and this audience is overwhelmingly people who need that advice.
  ['IMMIGRATION', 'Immigration', true, ['IAA', 'SRA'], false],
  ['LEGAL', 'Legal', true, ['SRA', 'BSB', 'CILEx'], false],
  ['HEALTHCARE', 'Healthcare', true, ['GMC', 'NMC', 'HCPC', 'GPhC', 'GDC', 'GOC'], false],
  ['FINANCE_ACCOUNTING', 'Finance', true, ['ACCA', 'ICAEW', 'CIMA', 'CIOT', 'FCA'], false],
  // Not regulated, and with three bodies: membership of CIOL or ITI, and the NRPSI register courts
  // ask for, are credentials rather than permission. A bad translation is a bad service.
  ['TRANSLATION', 'Translation', false, ['CIOL', 'ITI', 'NRPSI'], false],
  ['CAREERS_CV', 'Career', false, ['EAS'], false],
  ['TECH_SOFTWARE', 'Tech', false, [], false],
  ['LOGISTICS', 'Logistics', false, ['DVSA'], false],
  ['PROPERTY_LETTINGS', 'Property & Housing', true, ['ARLA', 'RICS', 'NAEA', 'PRS', 'TPO'], false],
  ['EDUCATION_TUTORING', 'Education & Tutoring', false, ['DVSA', 'Ofsted'], false],
  ['BUSINESS_CONSULTING', 'Business & Admin', false, [], false],
  ['TRADES_REPAIRS', 'Trades & Home', false, ['Gas Safe', 'NICEIC', 'NAPIT'], false],
  ['BEAUTY_HAIR_SERVICES', 'Beauty & Wellbeing', false, ['JCCP', 'Save Face'], false],
  ['EVENTS_CATERING', 'Events & Creative', false, [], false],
  // ── Retired: their work is a subcategory of one of the fourteen above ──────
  // Kept so a listing that already holds one still renders its label (§8), and never offered.
  ['THERAPY_COACHING', 'Therapy & Coaching', true, ['BACP', 'UKCP', 'HCPC'], false, false],
  ['CHILDCARE_SERVICES', 'Childcare', true, ['Ofsted'], false, false],
  ['RECRUITMENT', 'Recruitment', false, ['EAS'], false, false],
  ['DESIGN_CREATIVE', 'Design & Creative', false, [], false, false],
  ['MARKETING', 'Marketing & Social Media', false, [], false, false],
  ['PHOTOGRAPHY_VIDEO', 'Photography & Video', false, [], false, false],
  ['CLEANING', 'Cleaning', false, [], false, false],
  // The escape hatch stays open: a professional whose work fits none of the fourteen needs
  // somewhere to be, and the alternative is a member picking a category that is nearly right.
  ['OTHER', 'Other', false, [], false],
];

/**
 * Subcategories, and where the gate actually lives (§3.2).
 *
 * `[parent, code, label, requiresVerification, credentialBodies]`. A service needs verification iff
 * its subcategory says so, or — where the service has no subcategory — its category does. The
 * client computes the same thing to lock a chip without a round trip; **the server computes it
 * again on write and refuses independently**, because a client flag is a latency optimisation and
 * never a security boundary.
 *
 * The gates are the product's marks, checked against the UK regulator that would actually be
 * asked for. Three worth stating, because they are the ones a reviewer will query:
 *
 *  - **Accountant** is not a protected title in the UK — anyone may use it — but a tax agent acts
 *    on somebody else's behalf with HMRC and the audience here is people filing for the first
 *    time. Gated, as asked.
 *  - **Pest control** needs no licence to practise, though the pesticides do. Gated, as asked.
 *  - **Lived-experience guidance** under Immigration is deliberately *not* gated: somebody saying
 *    what happened to them is not giving regulated advice, and gating it would silence the most
 *    useful voice on the platform. It is also the subcategory most likely to be misused, which is
 *    why its label says what it is.
 */
const subcategories: Array<[string, string, string, boolean, string[]?]> = [
  // ── Immigration ───────────────────────────────────────────────────────────
  ['IMMIGRATION', 'IMMIGRATION_SOLICITOR', 'Immigration solicitor', true, ['SRA']],
  ['IMMIGRATION', 'IMMIGRATION_IAA_ADVISER', 'IAA-regulated adviser', true, ['IAA']],
  ['IMMIGRATION', 'IMMIGRATION_ASYLUM', 'Asylum & humanitarian', true, ['IAA', 'SRA']],
  ['IMMIGRATION', 'IMMIGRATION_VISA_SUPPORT', 'Visa application support', false],
  ['IMMIGRATION', 'IMMIGRATION_SPONSORSHIP', 'Sponsorship & right to work', false],
  ['IMMIGRATION', 'IMMIGRATION_SETTLEMENT', 'Settlement & citizenship', false],
  ['IMMIGRATION', 'IMMIGRATION_STUDENT', 'Student visas', false],
  ['IMMIGRATION', 'IMMIGRATION_LIVED_EXPERIENCE', 'Lived-experience guidance', false],
  // ── Legal ─────────────────────────────────────────────────────────────────
  ['LEGAL', 'LEGAL_SOLICITOR', 'Solicitor', true, ['SRA']],
  ['LEGAL', 'LEGAL_BARRISTER', 'Barrister', true, ['BSB']],
  ['LEGAL', 'LEGAL_NOTARY', 'Notary', true, ['Faculty Office']],
  ['LEGAL', 'LEGAL_FAMILY', 'Family law', true, ['SRA']],
  ['LEGAL', 'LEGAL_WILLS', 'Wills & probate', true, ['SRA', 'STEP']],
  ['LEGAL', 'LEGAL_PARALEGAL', 'Paralegal support', false],
  ['LEGAL', 'LEGAL_EMPLOYMENT', 'Employment rights', false],
  ['LEGAL', 'LEGAL_HOUSING', 'Tenancy & housing', false],
  ['LEGAL', 'LEGAL_DRAFTING', 'Document drafting', false],
  // ── Healthcare ────────────────────────────────────────────────────────────
  ['HEALTHCARE', 'HEALTH_DOCTOR', 'GP / doctor', true, ['GMC']],
  ['HEALTHCARE', 'HEALTH_DENTIST', 'Dentist', true, ['GDC']],
  ['HEALTHCARE', 'HEALTH_PHARMACIST', 'Pharmacist', true, ['GPhC']],
  ['HEALTHCARE', 'HEALTH_NURSE', 'Nurse / midwife', true, ['NMC']],
  ['HEALTHCARE', 'HEALTH_THERAPIST', 'Therapist / counsellor', true, ['BACP', 'HCPC', 'UKCP']],
  ['HEALTHCARE', 'HEALTH_PHYSIO', 'Physiotherapist', true, ['HCPC']],
  ['HEALTHCARE', 'HEALTH_OPTICIAN', 'Optician', true, ['GOC']],
  ['HEALTHCARE', 'HEALTH_NUTRITION', 'Nutritionist', false],
  ['HEALTHCARE', 'HEALTH_TRAINER', 'Personal trainer', false],
  ['HEALTHCARE', 'HEALTH_DOULA', 'Doula & birth support', false],
  // ── Finance ───────────────────────────────────────────────────────────────
  ['FINANCE_ACCOUNTING', 'FINANCE_ACCOUNTANT', 'Accountant', true, ['ACCA', 'ICAEW', 'CIMA']],
  ['FINANCE_ACCOUNTING', 'FINANCE_TAX_ADVISER', 'Chartered tax adviser', true, ['CIOT']],
  ['FINANCE_ACCOUNTING', 'FINANCE_IFA', 'Independent financial adviser', true, ['FCA']],
  ['FINANCE_ACCOUNTING', 'FINANCE_MORTGAGE', 'Mortgage broker', true, ['FCA']],
  ['FINANCE_ACCOUNTING', 'FINANCE_INSURANCE', 'Insurance broker', true, ['FCA']],
  ['FINANCE_ACCOUNTING', 'FINANCE_BOOKKEEPING', 'Bookkeeping', false],
  ['FINANCE_ACCOUNTING', 'FINANCE_SELF_ASSESSMENT', 'Self-assessment help', false],
  ['FINANCE_ACCOUNTING', 'FINANCE_FUNDING', 'Business plans & funding', false],
  ['FINANCE_ACCOUNTING', 'FINANCE_DEBT', 'Credit & debt guidance', false],
  // ── Translation ───────────────────────────────────────────────────────────
  ['TRANSLATION', 'TRANSLATION_CERTIFIED', 'Certified translation', true, ['CIOL', 'ITI']],
  ['TRANSLATION', 'TRANSLATION_COURT', 'Court interpreting', true, ['NRPSI']],
  ['TRANSLATION', 'TRANSLATION_MEDICAL', 'Medical interpreting', true, ['NRPSI']],
  ['TRANSLATION', 'TRANSLATION_DOCUMENT', 'Document translation', false],
  ['TRANSLATION', 'TRANSLATION_GENERAL', 'Interpreting (general)', false],
  ['TRANSLATION', 'TRANSLATION_TUTORING', 'Language tutoring', false],
  // ── Career ────────────────────────────────────────────────────────────────
  ['CAREERS_CV', 'CAREER_RECRUITMENT', 'Recruitment agency', true, ['EAS']],
  ['CAREERS_CV', 'CAREER_CV', 'CV & cover letters', false],
  ['CAREERS_CV', 'CAREER_INTERVIEW', 'Interview coaching', false],
  ['CAREERS_CV', 'CAREER_JOB_SEARCH', 'Job search support', false],
  ['CAREERS_CV', 'CAREER_QUALIFICATIONS', 'Qualification recognition', false],
  ['CAREERS_CV', 'CAREER_RETRAINING', 'Apprenticeships & retraining', false],
  ['CAREERS_CV', 'CAREER_BRAND', 'LinkedIn & personal brand', false],
  // ── Tech ──────────────────────────────────────────────────────────────────
  ['TECH_SOFTWARE', 'TECH_WEB', 'Web development', false],
  ['TECH_SOFTWARE', 'TECH_APP', 'App development', false],
  ['TECH_SOFTWARE', 'TECH_IT_SUPPORT', 'IT support', false],
  ['TECH_SOFTWARE', 'TECH_DATA', 'Data & analytics', false],
  ['TECH_SOFTWARE', 'TECH_SECURITY', 'Cybersecurity', false],
  ['TECH_SOFTWARE', 'TECH_DESIGN', 'UI/UX design', false],
  ['TECH_SOFTWARE', 'TECH_AUTOMATION', 'Automation & AI', false],
  // ── Logistics ─────────────────────────────────────────────────────────────
  ['LOGISTICS', 'LOGISTICS_PRIVATE_HIRE', 'Private hire driver', true, ['PHV licence']],
  ['LOGISTICS', 'LOGISTICS_VEHICLE_HIRE', 'Vehicle hire', true, []],
  ['LOGISTICS', 'LOGISTICS_MAN_VAN', 'Man & van', false],
  ['LOGISTICS', 'LOGISTICS_COURIER', 'Courier', false],
  ['LOGISTICS', 'LOGISTICS_AIRPORT', 'Airport transfers', false],
  ['LOGISTICS', 'LOGISTICS_FREIGHT', 'Freight & shipping', false],
  ['LOGISTICS', 'LOGISTICS_INTERNATIONAL', 'International shipping', false],
  // ── Property & Housing ────────────────────────────────────────────────────
  ['PROPERTY_LETTINGS', 'PROPERTY_LETTING_AGENT', 'Letting agent', true, ['PRS', 'TPO', 'ARLA']],
  ['PROPERTY_LETTINGS', 'PROPERTY_ESTATE_AGENT', 'Estate agent', true, ['PRS', 'TPO', 'NAEA']],
  ['PROPERTY_LETTINGS', 'PROPERTY_SURVEYOR', 'Surveyor', true, ['RICS']],
  ['PROPERTY_LETTINGS', 'PROPERTY_LANDLORD', 'Landlord services', false],
  ['PROPERTY_LETTINGS', 'PROPERTY_HOUSE_SHARE', 'House-share finding', false],
  ['PROPERTY_LETTINGS', 'PROPERTY_TENANCY', 'Tenancy setup support', false],
  ['PROPERTY_LETTINGS', 'PROPERTY_REMOVALS', 'Removals', false],
  ['PROPERTY_LETTINGS', 'PROPERTY_STORAGE', 'Storage', false],
  // ── Education & Tutoring ──────────────────────────────────────────────────
  ['EDUCATION_TUTORING', 'EDUCATION_DRIVING', 'Driving instructor', true, ['DVSA ADI']],
  ['EDUCATION_TUTORING', 'EDUCATION_CHILDCARE', 'Childminding & childcare', true, ['Ofsted']],
  ['EDUCATION_TUTORING', 'EDUCATION_PRIMARY', 'Primary tutoring', false],
  ['EDUCATION_TUTORING', 'EDUCATION_SECONDARY', 'Secondary tutoring', false],
  ['EDUCATION_TUTORING', 'EDUCATION_ADMISSIONS', 'University admissions', false],
  ['EDUCATION_TUTORING', 'EDUCATION_ENGLISH', 'English (ESOL / IELTS)', false],
  ['EDUCATION_TUTORING', 'EDUCATION_PROFESSIONAL_EXAMS', 'Professional exams', false],
  ['EDUCATION_TUTORING', 'EDUCATION_SEN', 'SEN support', false],
  // ── Business & Admin ──────────────────────────────────────────────────────
  ['BUSINESS_CONSULTING', 'BUSINESS_FORMATION', 'Company formation', false],
  ['BUSINESS_CONSULTING', 'BUSINESS_LICENSING', 'Licensing & permits', false],
  ['BUSINESS_CONSULTING', 'BUSINESS_HR', 'HR & payroll', false],
  ['BUSINESS_CONSULTING', 'BUSINESS_MARKETING', 'Marketing & social', false],
  ['BUSINESS_CONSULTING', 'BUSINESS_BRANDING', 'Branding & design', false],
  ['BUSINESS_CONSULTING', 'BUSINESS_BOOKKEEPING', 'Bookkeeping setup', false],
  ['BUSINESS_CONSULTING', 'BUSINESS_IMPORT_EXPORT', 'Import & export', false],
  // ── Trades & Home ─────────────────────────────────────────────────────────
  ['TRADES_REPAIRS', 'TRADES_ELECTRICIAN', 'Electrician', true, ['NICEIC', 'NAPIT', 'Part P']],
  ['TRADES_REPAIRS', 'TRADES_GAS', 'Gas engineer', true, ['Gas Safe']],
  ['TRADES_REPAIRS', 'TRADES_PEST_CONTROL', 'Pest control', true, ['BPCA']],
  ['TRADES_REPAIRS', 'TRADES_PLUMBER', 'Plumber', false],
  ['TRADES_REPAIRS', 'TRADES_BUILDER', 'Builder', false],
  ['TRADES_REPAIRS', 'TRADES_CARPENTER', 'Carpenter', false],
  ['TRADES_REPAIRS', 'TRADES_DECORATOR', 'Decorator', false],
  ['TRADES_REPAIRS', 'TRADES_ROOFER', 'Roofer', false],
  ['TRADES_REPAIRS', 'TRADES_LOCKSMITH', 'Locksmith', false],
  ['TRADES_REPAIRS', 'TRADES_CLEANER', 'Cleaner', false],
  ['TRADES_REPAIRS', 'TRADES_HANDYPERSON', 'Handyperson', false],
  ['TRADES_REPAIRS', 'TRADES_GARDENER', 'Gardener', false],
  // ── Beauty & Wellbeing ────────────────────────────────────────────────────
  [
    'BEAUTY_HAIR_SERVICES',
    'BEAUTY_AESTHETICS',
    'Aesthetics & injectables',
    true,
    ['JCCP', 'Save Face'],
  ],
  ['BEAUTY_HAIR_SERVICES', 'BEAUTY_HAIR', 'Hairdresser', false],
  ['BEAUTY_HAIR_SERVICES', 'BEAUTY_BARBER', 'Barber', false],
  ['BEAUTY_HAIR_SERVICES', 'BEAUTY_BRAIDING', 'Braiding & locs', false],
  ['BEAUTY_HAIR_SERVICES', 'BEAUTY_MAKEUP', 'Make-up artist', false],
  ['BEAUTY_HAIR_SERVICES', 'BEAUTY_NAILS', 'Nails', false],
  ['BEAUTY_HAIR_SERVICES', 'BEAUTY_MASSAGE', 'Massage therapist', false],
  ['BEAUTY_HAIR_SERVICES', 'BEAUTY_SKINCARE', 'Skincare', false],
  // ── Events & Creative ─────────────────────────────────────────────────────
  ['EVENTS_CATERING', 'EVENTS_PHOTOGRAPHY', 'Photographer', false],
  ['EVENTS_CATERING', 'EVENTS_VIDEOGRAPHY', 'Videographer', false],
  // `EVENTS_CATERER`, not `EVENTS_CATERING`: the parent category already owns that code, and a
  // string that means a category in one table and a subcategory in another is a bug waiting for
  // the first piece of code that looks one up without its kind.
  ['EVENTS_CATERING', 'EVENTS_CATERER', 'Caterer', false],
  ['EVENTS_CATERING', 'EVENTS_CAKE', 'Cake & baking', false],
  ['EVENTS_CATERING', 'EVENTS_DJ', 'DJ & music', false],
  ['EVENTS_CATERING', 'EVENTS_PLANNER', 'Event planner', false],
  ['EVENTS_CATERING', 'EVENTS_DECOR', 'Decoration & hire', false],
  ['EVENTS_CATERING', 'EVENTS_MC', 'MC & host', false],
  ['EVENTS_CATERING', 'EVENTS_TAILORING', 'Tailoring & alterations', false],
];

/**
 * What a professional actually does (§3.4), tagged with the categories it belongs to so the picker
 * can lead with the relevant ones.
 *
 * Coded, which is what makes "fourteen people here do ILR applications" answerable — a filter, a
 * count and a translation all need a code. The free-text half lives on the listing and is never
 * promoted into this list automatically: the admin portal surfaces the words that keep recurring
 * and a human decides, because a vocabulary that grows by itself grows typos.
 *
 * Leaning hard towards what *this* audience needs. A general skills taxonomy would be ten thousand
 * terms and would bury "ILR application" under "project management".
 */
const skills: Array<[string, string, string[]]> = [
  // ── Immigration ───────────────────────────────────────────────────────────
  ['ILR_APPLICATION', 'Indefinite leave to remain', ['IMMIGRATION']],
  ['SPOUSE_VISA', 'Spouse & partner visas', ['IMMIGRATION']],
  ['SKILLED_WORKER_VISA', 'Skilled Worker visas', ['IMMIGRATION']],
  ['SELF_SPONSORSHIP', 'Self-sponsorship route', ['IMMIGRATION', 'BUSINESS_CONSULTING']],
  ['SPONSOR_LICENCE', 'Sponsor licence applications', ['IMMIGRATION', 'BUSINESS_CONSULTING']],
  ['STUDENT_VISA', 'Student visas & CAS', ['IMMIGRATION', 'EDUCATION_TUTORING']],
  ['GRADUATE_ROUTE', 'Graduate route', ['IMMIGRATION']],
  ['ASYLUM_CLAIM', 'Asylum claims', ['IMMIGRATION', 'LEGAL']],
  ['APPEALS_TRIBUNAL', 'Immigration appeals & tribunals', ['IMMIGRATION', 'LEGAL']],
  ['CITIZENSHIP_APPLICATION', 'British citizenship', ['IMMIGRATION']],
  ['EU_SETTLEMENT', 'EU Settlement Scheme', ['IMMIGRATION']],
  ['FAMILY_REUNION', 'Family reunion', ['IMMIGRATION']],
  ['RIGHT_TO_WORK_CHECK', 'Right to work checks', ['IMMIGRATION', 'BUSINESS_CONSULTING']],
  ['BRP_REPLACEMENT', 'BRP & eVisa problems', ['IMMIGRATION']],
  ['DOCUMENT_CHECKING', 'Document checking before submission', ['IMMIGRATION', 'LEGAL']],
  // ── Legal ─────────────────────────────────────────────────────────────────
  ['TENANCY_DISPUTE', 'Tenancy disputes', ['LEGAL', 'PROPERTY_LETTINGS']],
  ['DEPOSIT_RECOVERY', 'Deposit recovery', ['LEGAL', 'PROPERTY_LETTINGS']],
  ['EMPLOYMENT_TRIBUNAL', 'Employment tribunals', ['LEGAL', 'CAREERS_CV']],
  ['UNFAIR_DISMISSAL', 'Unfair dismissal', ['LEGAL', 'CAREERS_CV']],
  ['WILL_WRITING', 'Will writing', ['LEGAL']],
  ['PROBATE', 'Probate', ['LEGAL']],
  ['DIVORCE', 'Divorce & separation', ['LEGAL']],
  ['CHILD_ARRANGEMENTS', 'Child arrangements', ['LEGAL']],
  ['CONTRACT_REVIEW', 'Contract review', ['LEGAL', 'BUSINESS_CONSULTING']],
  ['POWER_OF_ATTORNEY', 'Power of attorney', ['LEGAL']],
  ['DEBT_LETTERS', 'Debt & bailiff letters', ['LEGAL', 'FINANCE_ACCOUNTING']],
  // ── Healthcare ────────────────────────────────────────────────────────────
  ['NHS_REGISTRATION', 'Registering with a GP', ['HEALTHCARE']],
  ['MENTAL_HEALTH_SUPPORT', 'Mental health support', ['HEALTHCARE']],
  ['TRAUMA_COUNSELLING', 'Trauma & displacement counselling', ['HEALTHCARE']],
  ['SEXUAL_HEALTH', 'Sexual health', ['HEALTHCARE']],
  ['MATERNITY_CARE', 'Maternity & antenatal', ['HEALTHCARE']],
  ['CHILD_HEALTH', 'Child health', ['HEALTHCARE']],
  ['CHRONIC_CONDITIONS', 'Long-term conditions', ['HEALTHCARE']],
  ['PHYSIO_REHAB', 'Physiotherapy & rehab', ['HEALTHCARE']],
  ['NUTRITION_PLANS', 'Nutrition & diet plans', ['HEALTHCARE']],
  ['PERSONAL_TRAINING', 'Personal training', ['HEALTHCARE', 'BEAUTY_HAIR_SERVICES']],
  // ── Finance ───────────────────────────────────────────────────────────────
  ['SELF_ASSESSMENT', 'Self-assessment tax returns', ['FINANCE_ACCOUNTING']],
  ['CORPORATION_TAX', 'Corporation tax', ['FINANCE_ACCOUNTING']],
  ['VAT_REGISTRATION', 'VAT registration & returns', ['FINANCE_ACCOUNTING']],
  ['PAYROLL', 'Payroll & PAYE', ['FINANCE_ACCOUNTING', 'BUSINESS_CONSULTING']],
  ['BOOKKEEPING', 'Bookkeeping', ['FINANCE_ACCOUNTING']],
  ['CIS_RETURNS', 'CIS returns for trades', ['FINANCE_ACCOUNTING', 'TRADES_REPAIRS']],
  ['MORTGAGE_ADVICE', 'Mortgage advice', ['FINANCE_ACCOUNTING', 'PROPERTY_LETTINGS']],
  ['FIRST_TIME_BUYER', 'First-time buyers', ['FINANCE_ACCOUNTING', 'PROPERTY_LETTINGS']],
  ['CREDIT_BUILDING', 'Credit building', ['FINANCE_ACCOUNTING']],
  ['DEBT_MANAGEMENT', 'Debt management', ['FINANCE_ACCOUNTING']],
  ['PENSIONS', 'Pensions', ['FINANCE_ACCOUNTING']],
  ['BUSINESS_PLAN', 'Business plans', ['FINANCE_ACCOUNTING', 'BUSINESS_CONSULTING']],
  ['GRANT_FUNDING', 'Grants & funding', ['FINANCE_ACCOUNTING', 'BUSINESS_CONSULTING']],
  ['REMITTANCE_ADVICE', 'Sending money home', ['FINANCE_ACCOUNTING']],
  // ── Translation ───────────────────────────────────────────────────────────
  ['CERTIFIED_TRANSLATION', 'Certified document translation', ['TRANSLATION']],
  ['SWORN_TRANSLATION', 'Sworn & notarised translation', ['TRANSLATION', 'LEGAL']],
  ['COURT_INTERPRETING', 'Court interpreting', ['TRANSLATION', 'LEGAL']],
  ['MEDICAL_INTERPRETING', 'Medical interpreting', ['TRANSLATION', 'HEALTHCARE']],
  ['HOME_OFFICE_TRANSLATION', 'Home Office document translation', ['TRANSLATION', 'IMMIGRATION']],
  ['SIMULTANEOUS_INTERPRETING', 'Simultaneous interpreting', ['TRANSLATION']],
  ['TRANSCRIPTION', 'Transcription', ['TRANSLATION']],
  ['SUBTITLING', 'Subtitling', ['TRANSLATION', 'EVENTS_CATERING']],
  // ── Career ────────────────────────────────────────────────────────────────
  ['CV_WRITING', 'CV writing', ['CAREERS_CV']],
  ['COVER_LETTER', 'Cover letters', ['CAREERS_CV']],
  ['UK_CV_CONVERSION', 'Converting an overseas CV', ['CAREERS_CV']],
  ['INTERVIEW_PREP', 'Interview preparation', ['CAREERS_CV']],
  ['LINKEDIN_PROFILE', 'LinkedIn profiles', ['CAREERS_CV', 'BUSINESS_CONSULTING']],
  ['SALARY_NEGOTIATION', 'Salary negotiation', ['CAREERS_CV']],
  ['NARIC_RECOGNITION', 'Qualification recognition (ENIC)', ['CAREERS_CV', 'EDUCATION_TUTORING']],
  ['CAREER_CHANGE', 'Career change', ['CAREERS_CV']],
  ['APPRENTICESHIPS', 'Apprenticeships', ['CAREERS_CV', 'EDUCATION_TUTORING']],
  ['SPONSORED_JOB_SEARCH', 'Finding a sponsoring employer', ['CAREERS_CV', 'IMMIGRATION']],
  // ── Tech ──────────────────────────────────────────────────────────────────
  ['WEBSITE_BUILD', 'Website build', ['TECH_SOFTWARE', 'BUSINESS_CONSULTING']],
  ['ECOMMERCE_SETUP', 'Online shop setup', ['TECH_SOFTWARE', 'BUSINESS_CONSULTING']],
  ['MOBILE_APP', 'Mobile apps', ['TECH_SOFTWARE']],
  ['IT_SUPPORT', 'IT support', ['TECH_SOFTWARE']],
  ['DATA_ANALYSIS', 'Data analysis', ['TECH_SOFTWARE']],
  ['CYBER_SECURITY', 'Cybersecurity', ['TECH_SOFTWARE']],
  ['UI_UX', 'UI/UX design', ['TECH_SOFTWARE']],
  ['AUTOMATION', 'Automation & AI tools', ['TECH_SOFTWARE', 'BUSINESS_CONSULTING']],
  ['DEVICE_REPAIR', 'Phone & laptop repair', ['TECH_SOFTWARE', 'TRADES_REPAIRS']],
  // ── Logistics ─────────────────────────────────────────────────────────────
  ['AIRPORT_TRANSFER', 'Airport transfers', ['LOGISTICS']],
  ['MAN_AND_VAN', 'Man & van', ['LOGISTICS', 'PROPERTY_LETTINGS']],
  ['HOUSE_MOVE', 'House moves', ['LOGISTICS', 'PROPERTY_LETTINGS']],
  ['SAME_DAY_COURIER', 'Same-day courier', ['LOGISTICS']],
  ['BARREL_SHIPPING', 'Barrel & box shipping', ['LOGISTICS']],
  ['FREIGHT_FORWARDING', 'Freight forwarding', ['LOGISTICS', 'BUSINESS_CONSULTING']],
  ['CUSTOMS_CLEARANCE', 'Customs clearance', ['LOGISTICS', 'BUSINESS_CONSULTING']],
  ['PRIVATE_HIRE', 'Private hire driving', ['LOGISTICS']],
  // ── Property & Housing ────────────────────────────────────────────────────
  ['HOUSE_SHARE_FINDING', 'Finding a house share', ['PROPERTY_LETTINGS']],
  ['GUARANTOR_HELP', 'Guarantor & referencing help', ['PROPERTY_LETTINGS']],
  ['TENANCY_SETUP', 'Tenancy setup', ['PROPERTY_LETTINGS']],
  ['LANDLORD_COMPLIANCE', 'Landlord compliance', ['PROPERTY_LETTINGS']],
  ['PROPERTY_VIEWING', 'Viewings on your behalf', ['PROPERTY_LETTINGS']],
  ['HOME_SURVEY', 'Home surveys', ['PROPERTY_LETTINGS']],
  ['COUNCIL_HOUSING', 'Council & social housing', ['PROPERTY_LETTINGS', 'LEGAL']],
  ['STORAGE', 'Storage', ['PROPERTY_LETTINGS', 'LOGISTICS']],
  // ── Education ─────────────────────────────────────────────────────────────
  ['ESOL_TEACHING', 'English for speakers of other languages', ['EDUCATION_TUTORING']],
  ['IELTS_PREP', 'IELTS preparation', ['EDUCATION_TUTORING']],
  ['MATHS_TUTORING', 'Maths tutoring', ['EDUCATION_TUTORING']],
  ['SCIENCE_TUTORING', 'Science tutoring', ['EDUCATION_TUTORING']],
  ['ELEVEN_PLUS', '11+ and entrance exams', ['EDUCATION_TUTORING']],
  ['GCSE_SUPPORT', 'GCSE support', ['EDUCATION_TUTORING']],
  ['A_LEVEL_SUPPORT', 'A-level support', ['EDUCATION_TUTORING']],
  ['UCAS_APPLICATION', 'UCAS & personal statements', ['EDUCATION_TUTORING']],
  ['SEN_SUPPORT', 'SEN support', ['EDUCATION_TUTORING']],
  ['SCHOOL_PLACES', 'School places & appeals', ['EDUCATION_TUTORING', 'LEGAL']],
  ['DRIVING_LESSONS', 'Driving lessons', ['EDUCATION_TUTORING', 'LOGISTICS']],
  ['CHILDMINDING', 'Childminding', ['EDUCATION_TUTORING']],
  // ── Business & Admin ──────────────────────────────────────────────────────
  ['COMPANY_FORMATION', 'Company formation', ['BUSINESS_CONSULTING']],
  ['BUSINESS_LICENSING_HELP', 'Licences & permits', ['BUSINESS_CONSULTING']],
  ['FOOD_HYGIENE', 'Food hygiene & registration', ['BUSINESS_CONSULTING', 'EVENTS_CATERING']],
  ['HR_POLICIES', 'HR policies & contracts', ['BUSINESS_CONSULTING']],
  ['SOCIAL_MEDIA_MARKETING', 'Social media marketing', ['BUSINESS_CONSULTING']],
  ['BRAND_DESIGN', 'Logo & brand design', ['BUSINESS_CONSULTING', 'EVENTS_CATERING']],
  ['IMPORT_EXPORT', 'Import & export', ['BUSINESS_CONSULTING', 'LOGISTICS']],
  ['MARKET_STALL_SETUP', 'Market stall & pop-up setup', ['BUSINESS_CONSULTING']],
  // ── Trades & Home ─────────────────────────────────────────────────────────
  ['ELECTRICAL_WORK', 'Electrical work', ['TRADES_REPAIRS']],
  ['EICR_CERTIFICATE', 'EICR certificates', ['TRADES_REPAIRS', 'PROPERTY_LETTINGS']],
  ['BOILER_SERVICE', 'Boiler service & repair', ['TRADES_REPAIRS']],
  ['GAS_SAFETY_CERT', 'Gas safety certificates', ['TRADES_REPAIRS', 'PROPERTY_LETTINGS']],
  ['PLUMBING', 'Plumbing', ['TRADES_REPAIRS']],
  ['CARPENTRY', 'Carpentry', ['TRADES_REPAIRS']],
  ['PAINTING_DECORATING', 'Painting & decorating', ['TRADES_REPAIRS']],
  ['FLOORING', 'Flooring', ['TRADES_REPAIRS']],
  ['ROOFING', 'Roofing', ['TRADES_REPAIRS']],
  ['LOCKSMITH', 'Locksmithing', ['TRADES_REPAIRS']],
  ['END_OF_TENANCY_CLEAN', 'End-of-tenancy cleaning', ['TRADES_REPAIRS', 'PROPERTY_LETTINGS']],
  ['DEEP_CLEAN', 'Deep cleaning', ['TRADES_REPAIRS']],
  ['GARDENING', 'Gardening', ['TRADES_REPAIRS']],
  ['FLAT_PACK_ASSEMBLY', 'Flat-pack assembly', ['TRADES_REPAIRS']],
  ['PEST_CONTROL', 'Pest control', ['TRADES_REPAIRS']],
  // ── Beauty & Wellbeing ────────────────────────────────────────────────────
  ['AFRO_HAIR', 'Afro-textured hair', ['BEAUTY_HAIR_SERVICES']],
  ['BRAIDING', 'Braiding', ['BEAUTY_HAIR_SERVICES']],
  ['LOCS', 'Locs & twists', ['BEAUTY_HAIR_SERVICES']],
  ['WIG_INSTALL', 'Wigs & installs', ['BEAUTY_HAIR_SERVICES']],
  ['BARBERING', 'Barbering', ['BEAUTY_HAIR_SERVICES']],
  ['BRIDAL_HAIR', 'Bridal hair', ['BEAUTY_HAIR_SERVICES', 'EVENTS_CATERING']],
  ['BRIDAL_MAKEUP', 'Bridal make-up', ['BEAUTY_HAIR_SERVICES', 'EVENTS_CATERING']],
  ['NAILS', 'Nails', ['BEAUTY_HAIR_SERVICES']],
  ['LASHES_BROWS', 'Lashes & brows', ['BEAUTY_HAIR_SERVICES']],
  ['MASSAGE', 'Massage', ['BEAUTY_HAIR_SERVICES', 'HEALTHCARE']],
  ['SKINCARE_FACIALS', 'Skincare & facials', ['BEAUTY_HAIR_SERVICES']],
  // ── Events & Creative ─────────────────────────────────────────────────────
  ['EVENT_PHOTOGRAPHY', 'Event photography', ['EVENTS_CATERING']],
  ['PORTRAIT_PHOTOGRAPHY', 'Portraits & headshots', ['EVENTS_CATERING', 'CAREERS_CV']],
  ['VIDEOGRAPHY', 'Videography', ['EVENTS_CATERING']],
  ['WEDDING_PLANNING', 'Wedding planning', ['EVENTS_CATERING']],
  ['CATERING', 'Catering', ['EVENTS_CATERING']],
  ['AFRICAN_CUISINE', 'African & Caribbean cuisine', ['EVENTS_CATERING']],
  ['CAKE_BAKING', 'Cakes & baking', ['EVENTS_CATERING']],
  ['DJ_MUSIC', 'DJ & live music', ['EVENTS_CATERING']],
  ['EVENT_DECOR', 'Decoration & hire', ['EVENTS_CATERING']],
  ['MC_HOSTING', 'MC & hosting', ['EVENTS_CATERING']],
  ['TAILORING', 'Tailoring & alterations', ['EVENTS_CATERING']],
  ['TRADITIONAL_ATTIRE', 'Traditional attire', ['EVENTS_CATERING']],
];

// ─── Guide topics (spec 0.7) ──────────────────────────────────────────────────
const guideTopics: Array<[string, string]> = [
  ['FINANCE', 'Finance'],
  ['HEALTH', 'Health'],
  ['HOUSING', 'Housing'],
  ['VISA_DOCS', 'Visa & Docs'],
  ['JOBS', 'Jobs'],
  ['TRANSPORT', 'Transport'],
  ['EDUCATION', 'Education'],
  ['CULTURE', 'Culture'],
];

// ─── Heritage (3.1.4) ─────────────────────────────────────────────────────────
// One list used by three things: a member's heritage in Connect, a store's community tags in Commerce, and discovery filters in both.
const heritageTags: Array<[string, string]> = [
  ['WEST_AFRICAN', 'West African'],
  ['EAST_AFRICAN', 'East African'],
  ['NORTH_AFRICAN', 'North African'],
  ['SOUTHERN_AFRICAN', 'Southern African'],
  ['CENTRAL_AFRICAN', 'Central African'],
  ['CARIBBEAN', 'Caribbean'],
  ['SOUTH_ASIAN', 'South Asian'],
  ['EAST_ASIAN', 'East Asian'],
  ['SOUTH_EAST_ASIAN', 'South East Asian'],
  ['MIDDLE_EASTERN', 'Middle Eastern'],
  ['LATIN_AMERICAN', 'Latin American'],
  ['EASTERN_EUROPEAN', 'Eastern European'],
  ['SOUTHERN_EUROPEAN', 'Southern European'],
  ['BRITISH', 'British'],
  ['OTHER', 'Other'],
];

// ─── Journey stage ────────────────────────────────────────────────────────────
// `isNewToUk` is what the Connect `newToUk` filter reads, defined once here so the chip and the query cannot drift (3.4).
const journeyStages: Array<[string, string, boolean]> = [
  ['PLANNING', 'Planning to move', true],
  ['JUST_ARRIVED', 'Just arrived (0-3 months)', true],
  ['SETTLING_IN', 'Settling in (3-12 months)', false],
  ['ESTABLISHED', 'Established (1 year+)', false],
  ['CITIZEN_SETTLED', 'Settled or a citizen', false],
];

/**
 * What a member picks in onboarding, and the only thing the feed ranker can act on: it scores an
 * item when `viewer.interests` contains the item's `categoryCode`. So an interest that is not also
 * a community category can never move the feed, which is why the first fifteen here share their
 * codes with `communityCategories` exactly.
 *
 * The rest are the lifestyle topics, which have no category to match and earn their place in
 * Connect instead, where interests are what two people have in common.
 *
 * The four deactivated ones each say the same thing as a category above it — Study against
 * University / Study, Parenting against Children & Family — and one picker should not offer the
 * same idea twice. Deactivated rather than removed, so a member who already holds one still reads
 * a label rather than a raw code.
 */
const interests: Array<[string, string, boolean]> = [
  ['UNIVERSITY_STUDY', 'University / Study', true],
  ['AIRPORT_PICKUP', 'Airport Pickup', true],
  ['NHS_HEALTHCARE', 'NHS / Healthcare', true],
  ['BANK_ACCOUNT', 'Bank Account', true],
  ['ACCOMMODATION', 'Accommodation', true],
  ['VISA_DOCS', 'Visa / COS / Docs', true],
  ['JOB_SEARCH', 'Job Search', true],
  ['MAKE_FRIENDS', 'Make Friends', true],
  ['LANGUAGE_HELP', 'Language Help', true],
  ['TRANSPORT', 'Transport', true],
  ['CHILDREN_FAMILY', 'Children & Family', true],
  ['LEGAL_RIGHTS', 'Legal Rights', true],
  ['BENEFITS_SUPPORT', 'Benefits & Support', true],
  ['MENTAL_HEALTH', 'Mental Health', true],
  ['BUSINESS_SETUP', 'Business Setup', true],
  ['FOOD_COOKING', 'Food & Cooking', true],
  ['SPORT_FITNESS', 'Sport & Fitness', true],
  ['MUSIC', 'Music', true],
  ['FAITH_COMMUNITY', 'Faith & Community', true],
  ['TECH', 'Tech', true],
  ['TRAVEL', 'Travel', true],
  ['FASHION_BEAUTY', 'Fashion & Beauty', true],
  ['FILM_TV', 'Film & TV', true],
  ['ART_CULTURE', 'Art & Culture', true],
  ['VOLUNTEERING', 'Volunteering', true],
  ['GAMING', 'Gaming', true],
  ['READING', 'Reading', true],
  ['OUTDOORS', 'Outdoors', true],
  ['STUDY', 'Study', false],
  ['PARENTING', 'Parenting', false],
  ['LANGUAGES', 'Languages', false],
  ['BUSINESS', 'Business', false],
];

/**
 * What somebody is *into*, for the Connect profile and the Meet card.
 *
 * A separate vocabulary from `interests` above, and the reason is in that list: its first fifteen
 * codes are community categories, so the feed ranker can match a post's category against a
 * member's interests. That is right for the feed. It is wrong for a profile that asks "what you
 * have in common with people" and then offers Airport Pickup, Bank Account and Benefits & Support
 * — things people need help with, not things they are into.
 *
 * Both lists stay. `interests` still writes through to the user record and still shapes the feed;
 * `hobbies` lives on the Connect profile and shapes nothing but what a reader sees.
 *
 * Codes may be shared with `interests` where they mean the same thing — READING, MUSIC, TRAVEL,
 * FILM_TV, TECH, TRAVEL, VOLUNTEERING and LANGUAGES all appear in both. What must never happen is
 * a **community category** code appearing here, because that is the overlap that made the Connect
 * picker nonsense in the first place. `hobby-vocabulary.spec.ts` fails if one does.
 *
 * Ordered loosely by kind rather than alphabetically — moving, eating, watching, making, going out
 * — because fifty alphabetised chips is a search problem rather than a picker.
 */
const hobbies: Array<[string, string]> = [
  ['FOOTBALL', 'Football'],
  ['BASKETBALL', 'Basketball'],
  ['CRICKET', 'Cricket'],
  ['TENNIS', 'Tennis'],
  ['RUNNING', 'Running'],
  ['GYM', 'Gym & fitness'],
  ['YOGA', 'Yoga'],
  ['SWIMMING', 'Swimming'],
  ['CYCLING', 'Cycling'],
  ['HIKING', 'Hiking'],
  ['MARTIAL_ARTS', 'Martial arts'],
  ['DANCING', 'Dancing'],
  ['COOKING', 'Cooking'],
  ['BAKING', 'Baking'],
  ['EATING_OUT', 'Eating out'],
  ['COFFEE', 'Coffee'],
  ['READING', 'Reading'],
  ['WRITING', 'Writing'],
  ['MUSIC', 'Music'],
  ['INSTRUMENT', 'Playing an instrument'],
  ['SINGING', 'Singing'],
  ['FILM_TV', 'Film & TV'],
  ['THEATRE', 'Theatre'],
  ['COMEDY', 'Comedy'],
  ['MUSEUMS', 'Museums & galleries'],
  ['PHOTOGRAPHY', 'Photography'],
  ['ART', 'Art & drawing'],
  ['PODCASTS', 'Podcasts'],
  ['ANIME', 'Anime'],
  ['BOARD_GAMES', 'Board games'],
  ['VIDEO_GAMES', 'Video games'],
  ['KARAOKE', 'Karaoke'],
  ['NIGHTS_OUT', 'Nights out'],
  ['VOLUNTEERING', 'Volunteering'],
  ['FAITH', 'Faith & worship'],
  ['TRAVEL', 'Travel'],
  ['CAMPING', 'Camping'],
  ['GARDENING', 'Gardening'],
  ['FISHING', 'Fishing'],
  ['ROAD_TRIPS', 'Road trips'],
  ['DIY_CRAFTS', 'DIY & crafts'],
  ['LANGUAGES', 'Learning languages'],
  ['TECH', 'Tech & coding'],
  ['INVESTING', 'Investing'],
  ['SIDE_HUSTLE', 'Side hustles'],
  ['FASHION', 'Fashion'],
  ['SKINCARE', 'Beauty & skincare'],
  ['CARS', 'Cars'],
  ['DOGS', 'Dogs'],
  ['CATS', 'Cats'],
  ['THRIFTING', 'Thrifting & markets'],
  ['FESTIVALS', 'Festivals & gigs'],
];

/**
 * The third value is ISO 639-1 (639-3 where no two-letter code exists), served as `iso` so
 * the client can key on a standard identifier. `code` stays as it is because it is already
 * stored on member profiles and is stable against a label change on its own.
 */
const languages: Array<[string, string, string]> = [
  ['ENGLISH', 'English', 'en'],
  ['YORUBA', 'Yoruba', 'yo'],
  ['IGBO', 'Igbo', 'ig'],
  ['HAUSA', 'Hausa', 'ha'],
  ['NIGERIAN_PIDGIN', 'Nigerian Pidgin', 'pcm'],
  ['TWI', 'Twi', 'tw'],
  ['SWAHILI', 'Swahili', 'sw'],
  ['SOMALI', 'Somali', 'so'],
  ['AMHARIC', 'Amharic', 'am'],
  ['TIGRINYA', 'Tigrinya', 'ti'],
  ['ARABIC', 'Arabic', 'ar'],
  ['FRENCH', 'French', 'fr'],
  ['PORTUGUESE', 'Portuguese', 'pt'],
  ['SPANISH', 'Spanish', 'es'],
  ['URDU', 'Urdu', 'ur'],
  ['HINDI', 'Hindi', 'hi'],
  ['PUNJABI', 'Punjabi', 'pa'],
  ['BENGALI', 'Bengali', 'bn'],
  ['TAMIL', 'Tamil', 'ta'],
  ['GUJARATI', 'Gujarati', 'gu'],
  ['MANDARIN', 'Mandarin', 'zh'],
  ['CANTONESE', 'Cantonese', 'yue'],
  ['TAGALOG', 'Tagalog', 'tl'],
  ['POLISH', 'Polish', 'pl'],
  ['ROMANIAN', 'Romanian', 'ro'],
  ['RUSSIAN', 'Russian', 'ru'],
  ['UKRAINIAN', 'Ukrainian', 'uk'],
  ['TURKISH', 'Turkish', 'tr'],
  ['FARSI', 'Farsi', 'fa'],
  ['PASHTO', 'Pashto', 'ps'],
  ['KRIO', 'Krio', 'kri'],
  ['LINGALA', 'Lingala', 'ln'],
];

/** Why somebody is on Connect, and the sentence under each one on the setup screen (3.1). */
const connectionTypes: Array<[string, string, string]> = [
  ['FRIENDSHIP', 'Friendship', 'Meet people and build a circle where you live.'],
  ['NETWORKING', 'Networking', 'Meet people in your field or industry.'],
  ['LANGUAGE_EXCHANGE', 'Language Exchange', 'Practise a language, help with yours.'],
  ['STUDY_PARTNER', 'Study Partner', 'Revise, prepare and keep each other going.'],
  ['FLATMATE', 'Flatmate', 'Find someone to share a place with.'],
  ['DATING', 'Dating', 'Meet someone. 18+ only.'],
];

/**
 * The questions a Connect profile answers (3.3). Served rather than shipped so they can be
 * reworded without a release — and the question travels with the answer on read, so a rewording
 * never silently changes what somebody already said.
 *
 * Sixteen, open rather than yes/no, and none of them about dating: five of the six connection
 * types are not, and a prompt that only makes sense on a dating profile is dead on the other five.
 * The label IS the question, because that is what a profile renders.
 */
const connectPrompts: Array<[string, string]> = [
  ['FIRST_THING', "The first thing I'd show you in this city…"],
  ['MISS_MOST', 'What I miss most from home…'],
  ['ASK_ME_ABOUT', 'Ask me about…'],
  ['WEEKEND', 'A good weekend looks like…'],
  ['MOVED_HERE', 'What brought me here…'],
  ['GOOD_AT', "Something I'm unreasonably good at…"],
  ['LEARNING', "Something I'm learning…"],
  ['FOOD', 'The meal I cook when somebody comes over…'],
  ['SUNDAY', 'Where to find me on a Sunday…'],
  ['WISH_KNOWN', 'Something I wish I had known when I arrived…'],
  ['HELP_WITH', 'I can help somebody with…'],
  ['LOOKING_FOR_HELP', "I'd like help with…"],
  ['LANGUAGE', 'The language I switch to at home…'],
  ['PROUD_OF', 'Something I am proud of…'],
  ['UNPOPULAR', 'An opinion nobody here agrees with…'],
  ['NEXT_YEAR', 'Where I would like to be in a year…'],
];

// ─── Commerce (4.2, D22) ──────────────────────────────────────────────────────
// The app renders 8; the v2 spec lists 12. Same rule as D1.
const itemCategories: Array<[string, string, boolean]> = [
  ['FOOD_GROCERIES', 'Food & groceries', true],
  ['FRESH_FROZEN', 'Fresh & frozen', true],
  ['DRINKS', 'Drinks', true],
  ['BEAUTY_HAIR', 'Beauty & hair', true],
  ['CLOTHING', 'Clothing', true],
  ['HOME', 'Home', true],
  ['HEALTH', 'Health', true],
  ['OTHER', 'Other', true],
  ['BABY_KIDS', 'Baby & kids', false],
  ['ELECTRONICS', 'Electronics & accessories', false],
  ['JEWELLERY', 'Jewellery & accessories', false],
  ['RELIGIOUS_CULTURAL', 'Religious & cultural', false],
];

const itemUnits: Array<[string, string]> = [
  ['EACH', 'each'],
  ['PER_KG', 'per kg'],
  ['PER_500G', 'per 500g'],
  ['PER_PACK', 'per pack'],
  ['PER_LITRE', 'per litre'],
  ['PER_HOUR', 'per hour'],
];

// Bands carry their pence bounds rather than being parsed from a label.
const priceBands: Array<[string, string, number, number | null]> = [
  ['UNDER_5', 'Under £5', 0, 499],
  ['FROM_5_TO_10', '£5 – £10', 500, 1000],
  ['FROM_10_TO_20', '£10 – £20', 1001, 2000],
  ['OVER_20', 'Over £20', 2001, null],
];

const storeTypes: Array<[string, string, string]> = [
  [
    'LOCAL',
    'Local Store',
    'Native and cultural items — African groceries, Caribbean products, South Asian goods.',
  ],
  [
    'GENERAL',
    'General Store',
    'Everyday items — perfume, phone accessories, jewellery, clothing, home goods.',
  ],
];

const contactChannels: Array<[string, string]> = [
  ['PHONE', 'Phone'],
  ['WHATSAPP', 'WhatsApp'],
  ['INSTAGRAM', 'Instagram'],
  ['TIKTOK', 'TikTok'],
  ['WEBSITE', 'Website'],
];

const storeHelpAreas: Array<[string, string]> = [
  ['LISTINGS', 'Writing and photographing listings'],
  ['ADVERTISING', 'Advertising and reach'],
  ['SEO', 'Search and discovery'],
  ['DELIVERY', 'Delivery and collection'],
  ['PRICING', 'Pricing and stock'],
  // The honest answer from a seller who does not know where to start, and the one the app already
  // offered. Last, because it is the fallback rather than the first thing to reach for.
  ['EVERYTHING', 'All of it — I do not know where to start'],
];

// The tags a reviewer can attach (2.5.2, max 5).
const helpTags: Array<[string, string]> = [
  ['VISA_ADVICE', 'Visa advice'],
  ['HOUSING_HELP', 'Housing help'],
  ['JOB_HELP', 'Job help'],
  ['AIRPORT_PICKUP', 'Airport pickup'],
  ['TRANSLATION', 'Translation'],
  ['PAPERWORK', 'Paperwork'],
  ['MOVING', 'Moving'],
  ['CHILDCARE', 'Childcare'],
  ['NHS_HELP', 'NHS and GP help'],
  ['LOCAL_KNOWLEDGE', 'Local knowledge'],
  ['JUST_KIND', 'Just being kind'],
  ['WENT_ABOVE_AND_BEYOND', 'Went above and beyond'],
  ['QUICK_TO_REPLY', 'Quick to reply'],
  ['CLEAR_EXPLANATION', 'Clear explanation'],
  ['FAIR_PRICE', 'Fair price'],
  ['ON_TIME', 'On time'],
  ['GOOD_QUALITY', 'Good quality'],
];

// ─── Notification categories (spec 6.1.4, D38) ────────────────────────────────
// The rows of the preference matrix.
const notificationCategories: Array<[string, string, boolean, boolean, boolean]> = [
  // code, label, default push, default email, locked
  ['REPLIES', 'Replies to my posts', true, false, false],
  ['OFFERS', 'Offers of help', true, true, false],
  ['MESSAGES', 'Messages', true, false, false],
  ['GROUPS', 'Group activity', false, false, false],
  ['CONNECTIONS', 'Connection requests', true, false, false],
  ['BOOKINGS', 'Bookings & orders', true, true, false],
  ['COMPLIANCE', 'Verification & payments', true, true, true],
  ['ANNOUNCEMENTS', 'News from Circl', true, false, false],
  // Warnings, removals, suspensions and the appeal route (§7.3). Locked, like COMPLIANCE: a member
  // who has turned everything off still has to be told what was done to their account and how to
  // dispute it. A notice somebody can switch off is not a notice.
  ['ACCOUNT', 'Your account', true, true, true],
  // Likes and saves. The most mutable notification on the platform, so it is never locked, and
  // email defaults off because an email per like is how people turn off email entirely.
  ['REACTIONS', 'Likes and saves', true, false, false],
];

// ─── Guard categories (spec 6.3.1) ────────────────────────────────────────────
// What a private request to Circl is about.
const guardCategories: Array<[string, string]> = [
  ['HOUSING', 'Housing'],
  ['IMMIGRATION', 'Immigration'],
  ['SAFETY', 'Safety'],
  ['MONEY', 'Money'],
  ['HEALTH', 'Health'],
  ['WORK', 'Work'],
  ['OTHER', 'Something else'],
];

// ─── Vocabularies that were Dart constants until now (BACKEND-DATA-GAPS G1) ───
// Every one of them is content, not chrome: the wording is member-visible and the value is
// stored against a record, so it could not change without an app release.

const genders: Array<[string, string]> = [
  ['MALE', 'Male'],
  ['FEMALE', 'Female'],
  ['NON_BINARY', 'Non-binary'],
  ['OTHER', 'Other'],
];

/** Step 0 of the managed request flow. */
const managedCategories: Array<[string, string]> = [
  ['LEGAL_HELP', 'Legal help'],
  ['HEALTH_NHS', 'Health / NHS'],
  ['TAX_FINANCE', 'Tax / Finance'],
  ['IMMIGRATION', 'Immigration'],
  ['TRANSLATION', 'Translation'],
  ['CAREER_CV', 'Career / CV'],
  ['TECH_SUPPORT', 'Tech support'],
  ['LOGISTICS', 'Logistics'],
];

/** Matches the ExperienceLevel enum exactly: the label moves, the code does not. */
const experienceLevels: Array<[string, string]> = [
  ['BEGINNER', 'Beginner'],
  ['MID_LEVEL', 'Mid-level'],
  ['EXPERT', 'Expert'],
];

/** Matches BriefUrgency. */
const urgencyOptions: Array<[string, string]> = [
  ['ASAP', 'ASAP'],
  ['THIS_WEEK', 'This week'],
  ['THIS_MONTH', 'This month'],
  ['FLEXIBLE', 'Flexible'],
];

/**
 * Bounds rather than a label the client parses back into a range, which is the drift the price
 * bands were given minPence/maxPence to avoid. A null maxAge is open-ended, as in "45+".
 */
const connectAgeBands: Array<[string, string, number, number | null]> = [
  ['AGE_18_24', '18–24', 18, 24],
  ['AGE_25_34', '25–34', 25, 34],
  ['AGE_35_44', '35–44', 35, 44],
  ['AGE_45_PLUS', '45+', 45, null],
];

/** The keys the browse endpoint already accepts. Only the wording moves server-side. */
const professionalSortOptions: Array<[string, string]> = [
  ['RECOMMENDED', 'Recommended'],
  ['RATING', 'Highest rated'],
  ['REVIEWS', 'Most reviewed'],
  ['NEAREST', 'Nearest'],
  ['PRICE', 'Lowest price'],
  ['RESPONSE', 'Fastest to reply'],
];

/**
 * The feed filter row. The client used to pick these by array index, so a reorder filtered for
 * whatever happened to be third. "All" is the absence of `types`; there is no ALL member of
 * FeedItemType and sending one would be a 422.
 *
 * GUIDE is deliberately not here. It is a real FeedItemType, but the feed drops guides whether or
 * not they are asked for — they have their own tab — so a Guides chip would be a filter that can
 * only ever come back empty.
 */
const feedTypes: Array<[string, string]> = [
  ['UPDATE', 'Posts'],
  ['REQUEST', 'Requests'],
  ['OFFER', 'Services'],
];

/** What `GET /commerce/stores?sort=` and `GET /commerce/items?sort=` accept. */
const commerceSortOptions: Array<[string, string]> = [
  ['RECOMMENDED', 'Recommended'],
  ['NEAREST', 'Nearest'],
  ['RATING', 'Highest rated'],
  ['NEWEST', 'Newest'],
  ['PRICE_LOW', 'Price: low to high'],
  ['PRICE_HIGH', 'Price: high to low'],
];

/** What `GET /community/requests?status=` accepts. CLOSED covers resolved, closed and expired. */
const requestStatuses: Array<[string, string]> = [
  ['ALL', 'All'],
  ['OPEN', 'Open'],
  ['CLOSED', 'Closed'],
];

const pair = (kind: TaxonomyKind, rows: Array<[string, string]>): TaxonomySeed[] =>
  rows.map(([code, label], index) => ({ kind, code, label, sort: index + 1 }));

export const taxonomySeeds: TaxonomySeed[] = [
  ...communityCategories.map(([code, label, isActive, suggested], index) => ({
    kind: TaxonomyKind.COMMUNITY_CATEGORY,
    code,
    label,
    sort: index + 1,
    isActive,
    // The bridge that lets offer promotion prefill a profession (D8), so the member confirms rather than choosing from scratch.
    metadata: { suggestedProfessionCodes: suggested },
  })),
  ...professions.map(
    ([code, label, isRegulated, credentialBodies, requiresVerification, isActive], index) => ({
      kind: TaxonomyKind.PROFESSION,
      code,
      label,
      sort: (index + 1) * 10,
      isActive: isActive ?? true,
      /**
       * `requiresVerification` is the new name and the truth; `requiresReview` is the old
       * per-listing gate, sent as `false` during the transition because the client falls back to
       * it when the new key is missing and a stale build must not read a gate that has moved
       * (§3.1). Dropped once the portal has stopped writing it.
       */
      metadata: {
        isRegulated,
        credentialBodies,
        requiresVerification,
        requiresReview: false,
      },
    }),
  ),
  ...subcategories.map(
    ([parentCode, code, label, requiresVerification, credentialBodies], index) => ({
      kind: TaxonomyKind.PROFESSION_SUBCATEGORY,
      code,
      label,
      // Ten apart, and grouped by parent in declaration order: the portal reorders by rewriting
      // `sort`, and gaps mean a term can be moved between two others without renumbering the shelf.
      sort: (index + 1) * 10,
      metadata: { parentCode, requiresVerification, credentialBodies: credentialBodies ?? [] },
    }),
  ),
  ...skills.map(([code, label, categoryCodes], index) => ({
    kind: TaxonomyKind.SKILL,
    code,
    label,
    sort: (index + 1) * 10,
    metadata: { categoryCodes },
  })),
  ...pair(TaxonomyKind.GUIDE_TOPIC, guideTopics),
  ...pair(TaxonomyKind.HERITAGE_TAG, heritageTags),
  ...journeyStages.map(([code, label, isNewToUk], index) => ({
    kind: TaxonomyKind.JOURNEY_STAGE,
    code,
    label,
    sort: index + 1,
    metadata: { isNewToUk },
  })),
  ...interests.map(([code, label, isActive], index) => ({
    kind: TaxonomyKind.INTEREST,
    code,
    label,
    sort: index + 1,
    isActive,
  })),
  ...pair(TaxonomyKind.HOBBY, hobbies),
  ...languages.map(([code, label, isoCode], index) => ({
    kind: TaxonomyKind.LANGUAGE,
    code,
    label,
    sort: index + 1,
    metadata: { iso: isoCode },
  })),
  ...connectionTypes.map(([code, label, description], index) => ({
    kind: TaxonomyKind.CONNECTION_TYPE,
    code,
    label,
    description,
    sort: index + 1,
  })),
  ...connectPrompts.map(([code, question], index) => ({
    kind: TaxonomyKind.CONNECT_PROMPT,
    code,
    // The label is the question: a profile renders this string, not a name for it.
    label: question,
    sort: index + 1,
  })),
  ...itemCategories.map(([code, label, isActive], index) => ({
    kind: TaxonomyKind.ITEM_CATEGORY,
    code,
    label,
    sort: index + 1,
    isActive,
  })),
  ...pair(TaxonomyKind.ITEM_UNIT, itemUnits),
  ...priceBands.map(([code, label, minPence, maxPence], index) => ({
    kind: TaxonomyKind.ITEM_PRICE_BAND,
    code,
    label,
    sort: index + 1,
    metadata: { minPence, maxPence },
  })),
  ...storeTypes.map(([code, label, blurb], index) => ({
    kind: TaxonomyKind.STORE_TYPE,
    code,
    label,
    sort: index + 1,
    metadata: { blurb },
  })),
  ...pair(TaxonomyKind.STORE_CONTACT_CHANNEL, contactChannels),
  ...pair(TaxonomyKind.STORE_HELP_AREA, storeHelpAreas),
  ...pair(TaxonomyKind.HELP_TAG, helpTags),
  ...notificationCategories.map(([code, label, push, email, isLocked], index) => ({
    kind: TaxonomyKind.NOTIFICATION_CATEGORY,
    code,
    label,
    sort: index + 1,
    metadata: { defaultPush: push, defaultEmail: email, isLocked },
  })),
  ...pair(TaxonomyKind.GUARD_CATEGORY, guardCategories),
  ...pair(TaxonomyKind.GENDER, genders),
  ...pair(TaxonomyKind.MANAGED_CATEGORY, managedCategories),
  ...pair(TaxonomyKind.EXPERIENCE_LEVEL, experienceLevels),
  ...pair(TaxonomyKind.URGENCY, urgencyOptions),
  ...connectAgeBands.map(([code, label, minAge, maxAge], index) => ({
    kind: TaxonomyKind.CONNECT_AGE_BAND,
    code,
    label,
    sort: index + 1,
    metadata: { minAge, maxAge },
  })),
  ...pair(TaxonomyKind.PROFESSIONAL_SORT_OPTION, professionalSortOptions),
  ...pair(TaxonomyKind.FEED_TYPE, feedTypes),
  ...pair(TaxonomyKind.REQUEST_STATUS, requestStatuses),
  ...pair(TaxonomyKind.COMMERCE_SORT_OPTION, commerceSortOptions),
];
