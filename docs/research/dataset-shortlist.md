# Dataset Shortlist: Verified Candidates for Faceted People/Student Search + LLM-Column Experiments

Verification pass run 2026-08-04. Every claim below marked "verified" was reproduced in this session with `curl` (HTTP status + Content-Length), platform metadata APIs (Socrata, Dataverse, HuggingFace datasets-server), an actual file download and row count (OULAD), a ranged GET of file contents (Canvas, Stack Overflow header), or an in-browser fetch for the bot-blocked DOL host. Target profile: one row per person (or person-like record), 30K-700K rows, structured facets for a faceted-search demo, and at least one semi-structured or free-text field that requires LLM judgment.

## Ranked shortlist

| # | Dataset | Rows (verified how) | Download | License (verified how) | Auth | Judgment field |
|---|---------|---------------------|----------|------------------------|------|----------------|
| 1 | Stack Overflow Annual Developer Survey, 2023 (GitHub archive) | 89,184 (official count, appears 11x on survey.stackoverflow.co/2023) | HTTP 200, 158.6 MB CSV, direct | ODbL 1.0 + DbCL 1.0 (verbatim from repo README) | No | Semicolon multi-selects (DevType, LanguageHaveWorkedWith, LearnCode) |
| 2 | Djinni Recruitment Dataset, English candidate profiles (HuggingFace) | 210,250 exact (datasets-server size API) | HTTP 200, 237.4 MB parquet, direct | MIT (HF API cardData.license) | No | Long free text: CV, Highlights, Looking For, Moreinfo |
| 3 | US DOL OFLC PERM Disclosure Data FY2025 | est. 100-130K/FY (not published by DOL) | HTTP 200 in-browser, 87,007,731 bytes; curl gets 403 (bot-block) | US Government work, public domain (17 USC 105) | No (browser required) | Free-text job requirements/skills; messy employer + title strings |
| 4 | NYC Citywide Payroll (Socrata k397-673e) | 6,775,830 exact (Socrata count API) | HTTP 200 CSV export, direct | None: no licenseId in metadata (verified null); NYC Open Data terms | No | Messy agency_name + title_description strings; real names |
| 5 | SF Employee Compensation (Socrata 88g8-5mnd) | 1,138,740 exact (Socrata count API) | HTTP 200 CSV export, direct | PDDL (licenseId "PDDL" + terms link, verified in metadata) | No | Messy job-title strings, with 3-level taxonomy as ground truth |
| 6 | Canvas Network Person-Course 2014-2015 (Harvard Dataverse) | "over 325,000" records / 238 courses (Dataverse dsDescription) | HTTP 206 ranged GET succeeded, 43.9 MB TSV, anonymous | CC BY 4.0 (CC-BY badge + link in Dataverse termsOfUse) | No | Modest: discipline + primary_reason; no long text |
| 7 | Open University Learning Analytics (OULAD) | 32,593 students (downloaded zip, counted lines this session) | HTTP 200, 46.75 MB zip, direct | CC-BY 4.0 (verbatim on OU page; UCI mirror agrees) | No | Weakest: all categorical, anonymized module codes |
| 8 | US DOL OFLC H-1B LCA Disclosure Data FY2025 | est. 500-800K/FY (not published) | HTTP 200 in-browser, 79,134,156 bytes; curl gets 403 | US Government work, public domain | No (browser required) | Employer + job-title strings; thinner than PERM |

## Verification evidence per candidate

### 1. Stack Overflow Annual Developer Survey (GitHub archive) - PRIMARY

- Download URLs live, no auth, direct (follows 302 to media.githubusercontent.com):
  - 2023 `results.csv`: HTTP 200, Content-Length 158,626,799
  - 2024 `results.csv`: HTTP 200, Content-Length 159,525,875
  - 2025 `results.csv`: HTTP 200, Content-Length 140,893,245
  - 2023 `schema.csv` (codebook): HTTP 200, 16,442 bytes
  - URL pattern: `https://github.com/StackExchange/Survey/raw/refs/heads/main/packages/archive/<year>/results.csv`
- Row count: survey.stackoverflow.co/2023 contains the string "89,184" 11 times (official response count). 2024 approx 65K, 2025 approx 49K (site claims, not re-counted this session). Stacking 2021-2025 gives roughly 350K rows with schema drift.
- License, quoted verbatim from `StackExchange/Survey` README ("License and data attribution"): "Data is published under the Open Database License (ODbL) 1.0; individual cell contents are published under the Database Contents License (DbCL) 1.0." README explicitly permits share/create/adapt with attribution and share-alike. Repo code is separately Apache 2.0.
- Header re-verified via ranged GET (84 columns): `ResponseId,Q120,MainBranch,Age,Employment,RemoteWork,CodingActivities,EdLevel,LearnCode,...,YearsCode,YearsCodePro,DevType,OrgSize,...,Country,Currency,CompTotal,LanguageHaveWorkedWith,...`
- Fit: the best facet set of any candidate (role, education, years of experience, country, org size, remote status, salary), one row per real respondent, ideal single-year size (89K), loads straight into MySQL/ES. Judgment fields are the semicolon multi-selects (DevType, LanguageHaveWorkedWith, CodingActivities, LearnCode), which need parsing and interpretation, good for LLM-computed columns. Weakness: no free-text prose (open-ends are not released), so pair with #2 for semantic-column experiments.

### 2. Djinni Recruitment Dataset, English candidate profiles (HuggingFace, lang-uk) - SECONDARY / COMPLEMENTARY

- Download URL live, no auth (anonymous signed CDN redirect): `https://huggingface.co/api/datasets/lang-uk/recruitment-dataset-candidate-profiles-english/parquet/default/train/0.parquet` resolves HTTP 200, Content-Length 237,415,736. That single parquet is the whole train split (num_bytes_parquet_files matches exactly).
- Row count exact via datasets-server size API: **210,250** rows, 308.2 MB in memory.
- License via HF API: `cardData.license: mit`, tag `license:mit`. Released by the lang-uk researchers with the Djinni platform, documented in an ACL 2024 UNLP workshop paper, anonymized. Cleanest redistribution position of any real-people corpus found.
- Columns verified via datasets-server first-rows API: `Position`, `Moreinfo`, `Looking For`, `Highlights`, `Primary Keyword`, `English Level`, `Experience Years`, `CV`, `CV_lang`, `id`.
- Fit: the only 100K+ real-people corpus with long free text and a clean license. Facets are usable but thin (Position, Primary Keyword, English Level, Experience Years); no location or education columns, which is itself a good LLM-column task (extract them from CV text). 210K rows sits in the upper half of the 30K-700K band. Caveats: IT-sector and Ukraine-centric; anonymized (no names); CV is concatenated text of variable quality.

### 3. US DOL OFLC PERM Disclosure Data (FY2025) - RICHEST FACETS, OPS FRICTION

- CLI access re-tested this session: `curl -sI` with a full Chrome user-agent returns **HTTP 403** on both PERM and LCA files. The block is real (Akamai-level, not UA-based).
- In-browser verification this session (fetch HEAD executed in a real browser tab on the dol.gov performance page):
  - `PERM_Disclosure_Data_FY2025_Q4.xlsx`: **HTTP 200**, Content-Length **87,007,731**, correct XLSX content-type.
  - Performance page still lists 89 `Disclosure_Data` links, 9 for FY2025 and 5 for FY2026.
- Row count: not published by DOL; est. 100-130K records per fiscal year (single annual file, approx 150 columns). Verify after download.
- License: US Government work, public domain under 17 USC 105 (no license text on the page itself; DOL datasets on data.gov carry the usa.gov public-domain label). Safe for redistribution.
- Fit: education level, months of required experience, foreign worker education and citizenship, offered wage, worksite location, and a free-text skills/requirements field: maps almost 1:1 to a people-search schema and provides genuine free text. Caveats: rows are applications, not people; XLSX needs conversion; ingestion must go through a real browser or manual download (confirmed again this session).

### 4. NYC Citywide Payroll (Fiscal Year), Socrata k397-673e - SCALE STRESSOR

- Row count exact via Socrata count API: **6,775,830**. Data refreshed 2026-04-16 (rowsUpdatedAt).
- CSV export endpoint verified HTTP 200, `text/csv`, attachment `Citywide_Payroll_Data__Fiscal_Year_.csv`. SoQL-filtered slices work for sampling (e.g. one fiscal year is roughly 600K rows).
- License verified absent: metadata `licenseId: None`, `license: None`, attribution "Office of Payroll Administration (OPA)". Governed by NYC Open Data terms (published without registration or use restriction, but no formal open license). Record as "NYC Open Data Terms of Use" and cite the source; avoid verbatim bulk redistribution in paper artifacts.
- Fit: real named individuals (first/last name), agency, title, agency_start_date (tenure), borough, salary, overtime. agency_name and title_description are messy real-world strings, ideal for LLM normalization columns. Best pure scale stressor at 6.78M rows with one-click CSV.

### 5. SF Employee Compensation, Socrata 88g8-5mnd - CLEANEST BIG-DATA LICENSE

- Row count exact via Socrata count API: **1,138,740**. Data refreshed 2026-08-03 (actively maintained).
- CSV export verified HTTP 200, `text/csv`.
- License verified in metadata: `licenseId: "PDDL"`, name "Open Data Commons Public Domain Dedication and License", terms link opendatacommons.org/licenses/pddl/1.0. The strongest license of any large candidate: explicit public-domain dedication, no strings on derived benchmark artifacts.
- Fit: named employees, Organization Group > Job Family > Job taxonomy (ground truth for evaluating LLM-inferred groupings), union, department, full salary/benefits breakdown. Weaknesses: no education/experience/free text; same person repeats across years (filter to one year for approx 45K distinct-person rows).

### 6. Canvas Network Person-Course (Harvard Dataverse, doi:10.7910/DVN/1XORAL) - STUDENT OPTION

- Dataset RELEASED; files confirmed via Dataverse API: `CNPC_1401-1509_DI_v1_1_2016-03-01.tab` 43,856,468 bytes, plus documentation and de-identification PDFs.
- Anonymous download confirmed: HEAD on the presigned S3 redirect 403s (signature is GET-only), but a ranged GET through `https://dataverse.harvard.edu/api/access/datafile/2789854` returned **HTTP 206 with file content**. No login, no terms-click required via the API.
- Header verified from that ranged GET (26 columns): `course_id_DI, discipline, userid_DI, registered, viewed, explored, grade, grade_reqs, completed_%, course_reqs, final_cc_cname_DI, primary_reason, learner_type, expected_hours_week, LoE_DI, age_DI, gender, start_time_DI, course_start, course_end, last_event_DI, nevents, ndays_act, ncontent, nforum_posts, course_length`. This confirms the discipline facet, education level (LoE_DI), age, gender, country (final_cc_cname_DI), learner_type, primary_reason, and engagement counts.
- Row count: Dataverse description states "over 325,000 aggregate records, and each record represents one individual's activity in one of 238 Canvas Network courses."
- License: the Dataverse structured `license` field is null; the CC BY 4.0 grant lives in `termsOfUse` as the Creative Commons badge and link (creativecommons.org/licenses/by/4.0). This corrects the earlier note that claimed it was in the license field; the grant is still CC BY 4.0, just recorded in terms text.
- Fit: best student-framed candidate. In-band scale (325K), real discipline facet plus demographics, clean license, anonymous direct download. Caveats: person-course grain (one learner can appear in several courses), course ids are numeric de-identified codes (first data value seen: 832945), no free text, so LLM columns lean on discipline/engagement interpretation rather than prose.

### 7. Open University Learning Analytics Dataset (OULAD) - STUDENT FALLBACK, FULLY VERIFIED

- Downloaded the full zip this session from `http://schools.stem.open.ac.uk/cdn/files/anonymisedData.zip` (HTTP 200, 46,750,706 bytes) and counted every table:
  - `studentInfo.csv`: **32,593** data rows (matches the Sci Data paper figure exactly)
  - `studentRegistration.csv`: 32,593; `studentAssessment.csv`: 173,912; `studentVle.csv`: 10,655,280; `courses.csv`: 22; `assessments.csv`: 206; `vle.csv`: 6,364
- License, quoted verbatim from the OU dataset page: "This dataset is released under CC-BY 4.0 license." UCI mirror (dataset 349) also serves HTTP 200 and states CC BY 4.0.
- Fit: genuinely student-level (one row per student) and the most rigorously verified download in this pass, but it just clears the 30K floor, module codes are anonymized (AAA-GGG, no real majors), and every field is categorical (region, highest_education, imd_band, age_band, disability, final_result), so there is no judgment-requiring field. Use only if the student demo must be person-grain rather than person-course grain.

### 8. US DOL OFLC H-1B LCA Disclosure Data (FY2025)

- Same host behavior as PERM: curl 403 (re-confirmed), in-browser fetch HEAD this session: `LCA_Disclosure_Data_FY2025_Q4.xlsx` **HTTP 200**, Content-Length **79,134,156**.
- Est. 500-800K records per fiscal year across 4 quarterly files (counts not published). Public domain (US Government work).
- Fit: bigger than PERM but thinner facets (no education/experience fields, no free-text requirements). Use as the public-domain scale stressor if NYC's informal license is a concern; otherwise PERM dominates it for facet richness.

## Also verified, not shortlisted

| Dataset | Status this session | Why not shortlisted |
|---------|--------------------|---------------------|
| freeCodeCamp 2018 New Coder Survey | CSV HTTP 200, 17,883,699 bytes; ODbL 1.0 + DbCL quoted verbatim from `readme.md` (lowercase file; `README.md` 404s); repo headline "more than 30,000 developers"; 31,226 rows counted in prior pass | Raw Typeform dump, heavy ETL, facets weaker than SO survey; student angle better served by Canvas/OULAD |
| JetBrains DevEco 2025 raw data | Zip HTTP 200, 98,301,992 bytes (matches prior pass, which also verified CC BY 4.0 LICENSE.txt inside the zip and 24,534 rows) | 24.5K rows below the 30K bar; one-hot wide format; no free text |
| freeCodeCamp 2017 (clean) | ODbL quoted verbatim from repo README this session; 18,175 rows (prior pass download) | Under the bar alone; useful only as schema template for stacking fCC years |
| HarvardX-MITx Person-Course | Dataverse API confirms `license: null` with custom terms ("Dataverse Community Norms", anonymity obligations) | 641K rows but custom terms, weaker than CC for publishing benchmark artifacts; Canvas offers CC BY 4.0 at 325K with a near-identical schema |
| Kaggle-hosted (SO 2018 mirror, HackerRank 2018, 54k Resume, LinkedIn postings sets) | Not re-verified this session (prior pass verified in-browser); all require Kaggle API token | Auth requirement; and the LinkedIn/resume sets carry provenance or PII flags that the no-auth candidates avoid |
| Chicago current employees; Chile MINEDUC; UCI dropout; College Scorecard | Not re-verified this session | Revocable terms (Chicago); unverified license + RAR + Spanish (Chile); 4.4K rows (UCI); institutions not people (Scorecard) |

## Recommendation

- **Primary: Stack Overflow 2023** (89,184 rows, direct CSV, ODbL, richest facets). Build the faceted people-search demo on it; run LLM-column experiments on the multi-select fields; stack 2021-2025 (approx 350K) for scale variants.
- **Secondary: Djinni English candidate profiles** (210,250 rows, direct parquet, MIT). Adds the missing ingredient, long free text per person, for semantic LLM columns (extract location/education/seniority from CVs). If a pure scale stressor is wanted instead, NYC payroll (6.78M, exact count verified) is the one-click choice, with SF (PDDL) as the license-clean 1.1M alternative.
- **Student option: Canvas Network person-course** (325K, CC BY 4.0, discipline + demographics verified in the actual file header, anonymous download). OULAD (32,593 students, CC-BY 4.0, fully re-verified by download) is the fallback when person-grain matters more than scale.
