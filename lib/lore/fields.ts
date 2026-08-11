import type { FieldDef } from "@lore/core";

/**
 * Field catalog for the `profiles` corpus (Stack Overflow Developer Survey
 * 2023, ODbL). Single source of truth shared by both adapters, the table UI,
 * and the NL->FilterSpec compiler (which uses names/descriptions/vocab for
 * schema linking).
 */
export const PROFILE_FIELDS: FieldDef[] = [
  { name: "response_id", type: "integer", description: "Stable respondent id" },
  {
    name: "main_branch",
    type: "keyword",
    description: "Professional status, e.g. developer by profession, hobbyist, student",
  },
  { name: "age", type: "keyword", description: "Age bracket, e.g. '25-34 years old'" },
  {
    name: "employment",
    type: "keyword",
    multiValued: true,
    description: "Employment statuses (full-time, freelancer, student, retired...)",
  },
  {
    name: "remote_work",
    type: "keyword",
    description: "Remote, In-person, or Hybrid (some remote, some in-person)",
  },
  {
    name: "coding_activities",
    type: "keyword",
    multiValued: true,
    description: "Coding outside work: hobby, open-source, freelance...",
  },
  {
    name: "ed_level",
    type: "keyword",
    description: "Highest education level, e.g. Bachelor's, Master's, doctoral",
  },
  {
    name: "learn_code",
    type: "keyword",
    multiValued: true,
    description: "How they learned to code (school, online courses, bootcamp...)",
  },
  { name: "years_code", type: "float", description: "Total years coding (0.5-51)" },
  {
    name: "years_code_pro",
    type: "float",
    description: "Years coding professionally (0.5-51)",
  },
  {
    name: "dev_type",
    type: "keyword",
    description: "Primary role, e.g. 'Developer, back-end', 'Data scientist or machine learning specialist'",
  },
  { name: "org_size", type: "keyword", description: "Employer size bracket" },
  { name: "country", type: "keyword", description: "Country of residence (full name)" },
  { name: "comp_total", type: "float", description: "Raw compensation in local currency (noisy)" },
  {
    name: "converted_comp_yearly",
    type: "float",
    description: "Yearly compensation converted to USD",
  },
  {
    name: "languages",
    type: "keyword",
    multiValued: true,
    description: "Programming languages worked with, e.g. Python, TypeScript, Rust",
  },
  {
    name: "databases",
    type: "keyword",
    multiValued: true,
    description: "Databases worked with, e.g. PostgreSQL, MySQL, Elasticsearch",
  },
  {
    name: "platforms",
    type: "keyword",
    multiValued: true,
    description: "Cloud platforms worked with, e.g. AWS, Vercel, Google Cloud",
  },
  {
    name: "webframes",
    type: "keyword",
    multiValued: true,
    description: "Web frameworks worked with, e.g. React, Next.js, Django",
  },
  {
    name: "misc_tech",
    type: "keyword",
    multiValued: true,
    description: "Other tech: .NET, NumPy, Pandas, TensorFlow...",
  },
  {
    name: "tools_tech",
    type: "keyword",
    multiValued: true,
    description: "Dev tools: Docker, Kubernetes, npm, Terraform...",
  },
  {
    name: "op_sys_pro",
    type: "keyword",
    multiValued: true,
    description: "Operating systems used professionally",
  },
  {
    name: "ai_search",
    type: "keyword",
    multiValued: true,
    description: "AI search tools used, e.g. ChatGPT, Bing AI",
  },
  {
    name: "ai_dev",
    type: "keyword",
    multiValued: true,
    description: "AI developer tools used, e.g. GitHub Copilot, Tabnine",
  },
  {
    name: "ai_select",
    type: "keyword",
    description: "Whether they use AI tools in development (Yes / No, but... / No)",
  },
  { name: "ai_sent", type: "keyword", description: "Sentiment toward AI tools" },
  {
    name: "ic_or_pm",
    type: "keyword",
    description: "Individual contributor or people manager",
  },
  { name: "work_exp", type: "float", description: "Total years of professional work experience" },
  { name: "industry", type: "keyword", description: "Industry of employer" },
];

export const PROFILE_ID_FIELD = "response_id";
export const PROFILE_TABLE = "profiles";
export const PROFILE_ES_INDEX = "lore-profiles";
