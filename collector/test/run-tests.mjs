// node collector/test/run-tests.mjs : offline tests with mocked responses shaped like each public API.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeFit, parseSalaries, chooseSalary, salaryTier, classifyLocation, classifyFunctions, weekWindow, relativePosted, htmlToText, extractSkills } from '../../assets/shared/core.mjs';
import { run } from '../collect.mjs';
import { runDigest } from '../digest.mjs';
import { extractResume } from '../../assets/shared/resume.mjs';

let pass = 0; const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, '\n', e.message); process.exitCode = 1; } };

/* ---------- salary */
t('base range starts at 200K', () => {
  const s = chooseSalary(parseSalaries('The base salary range for this role is $205,000 - $260,000 USD per year.'));
  assert.equal(s.kind, 'base'); assert.equal(s.min, 205000); assert.equal(salaryTier(s, 200000), 'starts');
});
t('reaches only', () => assert.equal(salaryTier(chooseSalary(parseSalaries('Annual salary range: $170,000—$230,000')), 200000), 'reaches'));
t('OTE never substituted', () => {
  const s = chooseSalary(parseSalaries('OTE: $300,000 - $360,000 (50/50 split)'));
  assert.equal(s.kind, 'ote_only'); assert.equal(salaryTier(s, 200000), 'ote_only');
});
t('base preferred over OTE when both present', () => {
  const s = chooseSalary(parseSalaries('Base salary: $180K-$210K. On-target earnings: $360K - $420K.'));
  assert.equal(s.kind, 'base'); assert.equal(s.min, 180000); assert.ok(s.ote);
});
t('Google style + bonus counts as base', () => {
  const s = chooseSalary(parseSalaries('US: $192000 - $278000 (USD) + 20% bonus target + equity + benefits'));
  assert.equal(s.kind, 'base'); assert.equal(s.max, 278000);
});
t('Amazon geo range', () => {
  const s = chooseSalary(parseSalaries('base pay for this position ranges from $136,000/year in our lowest geographic market up to $255,000/year in our highest geographic market'));
  assert.equal(s.min, 136000); assert.equal(s.max, 255000); assert.equal(s.kind, 'base');
});
t('NY zone preferred among zones', () => {
  const s = chooseSalary(parseSalaries('Zone 2 base salary: $150,000 - $190,000. New York base salary range: $210,000 - $250,000.'));
  assert.equal(s.min, 210000);
});
t('hourly annualized', () => { const s = chooseSalary(parseSalaries('Pay range: $50 - $60 per hour')); assert.equal(s.period, 'hour'); assert.equal(s.min, 104000); });
t('no salary', () => assert.equal(chooseSalary(parseSalaries('Great benefits and $5M funding')), null));

/* ---------- location */
t('NYC hybrid', () => { const l = classifyLocation({ locations: ['New York, NY'], title: 'PMM' }, { metro: 'new york|nyc|stamford|jersey city', state: 'NY' }); assert.equal(l.in_metro, true); assert.equal(l.eligibility, 'yes'); });
t('Remote US unknown NY', () => { const l = classifyLocation({ locations: ['Remote - US'], desc_text: 'Work from anywhere.' }, { metro: 'new york|nyc|stamford|jersey city', state: 'NY' }); assert.equal(l.remote_us, true); assert.equal(l.eligibility, 'unknown'); });
t('Remote US excludes NY', () => { const l = classifyLocation({ locations: ['Remote, United States'], desc_text: 'We are unable to hire employees located in California or New York at this time.' }, { metro: 'new york|nyc|stamford|jersey city', state: 'NY' }); assert.equal(l.eligibility, 'no'); });
t('Remote with NY pay range = likely', () => { const l = classifyLocation({ locations: ['Remote (US)'], desc_text: 'For New York based candidates the salary range is $200,000 - $240,000.' }, { metro: 'new york|nyc|stamford|jersey city', state: 'NY' }); assert.equal(l.eligibility, 'likely'); });
t('same remote job, Texas viewer', () => assert.equal(classifyLocation({ locations: ['Remote, United States'], desc_text: 'We are unable to hire employees located in California or New York at this time.' }, { state: 'TX' }).eligibility, 'unknown'));
t('non-US filtered', () => assert.equal(classifyLocation({ locations: ['Bengaluru, India'] }).us, false));
t('Stamford counts as metro', () => assert.equal(classifyLocation({ locations: ['Stamford, CT'] }, { metro: 'new york|nyc|stamford|jersey city', state: 'NY' }).in_metro, true));

/* ---------- functions */
t('GTM engineer flagged for review not dropped', () => { const f = classifyFunctions('GTM Engineer'); assert.equal(f.eng_review, true); });
t('software engineer not flagged', () => assert.equal(classifyFunctions('Senior Software Engineer').eng_review, false));
t('PMM', () => assert.deepEqual(classifyFunctions('Senior Product Marketing Manager, Identity').functions.includes('pmm'), true));
t('chief of staff', () => assert.ok(classifyFunctions('Chief of Staff to the CISO').functions.includes('cos')));
t('threat research category', () => { for (const x of ['Principal Security Researcher', 'Senior Threat Intelligence Analyst', 'Malware Reverse Engineer', 'CTI Lead']) assert.ok(classifyFunctions(x).functions.includes('threat'), x); assert.ok(!classifyFunctions('Business Intelligence Analyst').functions.includes('threat')); });
t('category edge cases', () => { assert.deepEqual(classifyFunctions('HR Business Partner').functions, ['people']); assert.ok(classifyFunctions('Solutions Engineer').functions.includes('se')); assert.ok(classifyFunctions('Staff Software Engineer').functions.includes('eng')); });
t('skills', () => assert.ok(extractSkills('Built GTM for Defender XDR and MDR; KQL; MBA; agentic AI').includes('KQL')));

/* ---------- dates */
t('week window in another tz', () => assert.equal(weekWindow(new Date('2026-11-17T06:30:00Z'), 'America/Los_Angeles').end, '2026-11-16'));
t('week window Thursday', () => assert.deepEqual([weekWindow(new Date('2026-11-19T18:00:00Z')).start, weekWindow(new Date('2026-11-19T18:00:00Z')).end], ['2026-11-16', '2026-11-19']));
t('week window Monday', () => assert.equal(weekWindow(new Date('2026-11-16T15:00:00Z')).start, '2026-11-16'));
t('week window Sunday', () => assert.equal(weekWindow(new Date('2026-11-22T15:00:00Z')).start, '2026-11-16'));
t('late evening NY is still same day', () => assert.equal(weekWindow(new Date('2026-11-20T03:30:00Z')).end, '2026-11-19'));
t('relative posted', () => assert.equal(relativePosted('Posted 3 Days Ago', new Date('2026-11-19T18:00:00Z')), '2026-11-16'));
t('30+ days is not a date', () => assert.equal(relativePosted('Posted 30+ Days Ago'), null));
t('greenhouse double-escaped html', () => assert.equal(htmlToText('&lt;p&gt;Base salary &amp;amp; equity&lt;/p&gt;'), 'Base salary & equity'));

/* ---------- resume parser */
{
// Layout mirrors a real resume header (fictional person), including the cases that broke before
const cv = `Jane Rivera   |   jane.rivera@example.com   |   https://www.linkedin.com/in/janerivera   /   Page   1   of   2
Jane Rivera, MBA, MS, MPH , PMP
Cybersecurity Strategist | Business Strategy · GTM · AI
Executive Summary
Strategic operator at the intersection of cybersecurity, AI, and GTM innovation. Proven record unifying
identity, data security, and compliance into a unified executive security strategy.
Executive - grade differentiation.
Professional Experience
Microsoft — Senior Security Strategy Operations Lead, GTM & Growth   Nov 2025 – Present
• Positioned against CrowdStrike, Palo Alto Networks and SentinelOne in competitive deals.
• Partnered with Google Cloud and AWS marketplaces on co-sell.
Senior Security Product Manager, Pre-
Intent Strategy | Microsoft | 2022 – 2025
Amazon Web Services (AWS)
Program Manager , Custom Billing Solutions   2017 – 2019
Memorial Sloan Kettering Cancer Center   2014 – 2016
Education
MBA, NYU Stern School of Business`;
const p = extractResume(cv, { knownEmployers: ['CrowdStrike', 'SentinelOne', 'Palo Alto Networks', 'Okta'] });
const ok = (n, c) => t('resume: ' + n.split(':')[0], () => assert.ok(c, n));
ok('name = Jane Rivera (not Executive Summary): ' + p.name, p.name === 'Jane Rivera');
ok('location not "MBA, MS": "' + p.location + '"', p.location === '');
ok('headline: ' + p.headline, p.headline.startsWith('Cybersecurity Strategist'));
ok('employers: ' + p.employers.join(', '), p.employers.includes('Microsoft') && p.employers.includes('Amazon Web Services') && p.employers.includes('Memorial Sloan Kettering') && !p.employers.includes('CrowdStrike') && !p.employers.includes('Google'));
ok('titles: ' + JSON.stringify(p.titles), p.titles.every(t => !/summary|unified|differentiation/i.test(t) && t.length) && p.titles.some(t => /Program Manager/.test(t)) && p.titles.includes('Senior Security Product Manager, Pre-Intent Strategy') && p.titles.includes('Program Manager, Custom Billing Solutions'));
ok('creds: ' + p.creds.join(','), ['MBA', 'MPH', 'MS / MSc', 'PMP'].every(c => p.creds.includes(c)));
const li = extractResume(`Contact\nwww.linkedin.com/in/sam-lee\nTop Skills\nGo-to-Market Strategy\nSam Lee\nDirector, Product Marketing at Acme\nBrooklyn, New York, United States\nSummary\nI build things.`);
ok('LinkedIn PDF name: ' + li.name, li.name === 'Sam Lee');
ok('LinkedIn PDF location: ' + li.location, li.location === 'Brooklyn, NY');
const caps = extractResume(`JOHN SMITH\nNew York, NY | john@x.com\nVP, Alliances`);
ok('ALL CAPS name: ' + caps.name + ' / loc ' + caps.location, caps.name === 'John Smith' && caps.location === 'New York, NY');

}

/* ---------- end-to-end collector with mocked fetch */
const NOW = new Date('2026-11-19T18:00:00Z');
const gh = { jobs: [
  { id: 1, title: 'Director, Product Marketing - Threat Intelligence', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1', updated_at: '2026-11-18T10:00:00Z', first_published: '2026-11-17T10:00:00Z', requisition_id: 'R-1', location: { name: 'New York, NY' }, departments: [{ name: 'Marketing' }], content: '&lt;p&gt;The base salary range is $210,000 - $250,000.&lt;/p&gt;' },
  { id: 2, title: 'Senior Software Engineer', absolute_url: 'https://x/2', updated_at: '2026-11-18T10:00:00Z', location: { name: 'Tel Aviv, Israel' }, content: '' },
  { id: 3, title: 'GTM Engineer', absolute_url: 'https://x/3', updated_at: '2026-11-18T10:00:00Z', location: { name: 'Remote - US' }, content: '&lt;p&gt;OTE $250,000 - $300,000&lt;/p&gt;' } ] };
const lever = [{ id: 'lv1', text: 'Head of Partnerships', hostedUrl: 'https://jobs.lever.co/beta/lv1', createdAt: Date.parse('2026-11-16T14:00:00Z'), workplaceType: 'remote', categories: { location: 'Remote - US', allLocations: ['Remote - US'], team: 'BD' }, descriptionPlain: 'Lead alliances with MSSPs and cloud marketplaces. Eligible in all 50 states.', lists: [], salaryRange: { min: 190000, max: 240000, currency: 'USD', interval: 'per-year-salary' } }];
const ashby = { jobs: [{ id: 'as1', title: 'Chief of Staff, GTM', jobUrl: 'https://jobs.ashbyhq.com/gamma/as1', location: 'New York', isRemote: false, workplaceType: 'Hybrid', publishedAt: '2026-11-18T12:00:00Z', descriptionPlain: 'Drive operating rhythm.', compensation: { compensationTierSummary: '$220K – $260K', summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 220000, maxValue: 260000 }] } }] };
const wdList = { total: 2, jobPostings: [{ title: 'Principal Product Manager, Security Copilot', externalPath: '/job/New-York/Principal-PM_R100', locationsText: 'New York, NY', postedOn: 'Posted Yesterday', bulletFields: ['R100'] }, { title: 'Warehouse Associate', externalPath: '/job/Ohio/WA_R101', locationsText: 'Columbus, OH', postedOn: 'Posted Today', bulletFields: ['R101'] }] };
const wdDetail = { jobPostingInfo: { title: 'Principal Product Manager, Security Copilot', jobDescription: '<p>Base pay range: $198,000 - $305,000</p>', location: 'New York, NY', startDate: '2026-11-18', jobReqId: 'R100', externalUrl: 'https://delta.wd5.myworkdayjobs.com/Ext/job/New-York/Principal-PM_R100' } };
const amazon = { hits: 1, jobs: [{ id_icims: '3100001', title: 'Sr. Product Marketing Manager, AWS Security', posted_date: 'November 17, 2026', normalized_location: 'New York, New York, USA', country_code: 'USA', job_path: '/en/jobs/3100001/sr-pmm', business_category: 'amazon-web-services', description: 'Own positioning for AWS security services.', preferred_qualifications: 'The base pay for this position ranges from $150,000/year in our lowest geographic market up to $250,000/year in our highest geographic market.' }] };

const calls = [];
const mockFetch = async (url, opts = {}) => {
  calls.push(url);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (url.includes('boards-api.greenhouse.io/v1/boards/acme/jobs?')) return J(gh);
  if (url.includes('boards-api.greenhouse.io/v1/boards/acme/jobs/3')) return J({ pay_input_ranges: [] });
  if (url.includes('api.lever.co/v0/postings/beta')) return J(lever);
  if (url.includes('api.ashbyhq.com/posting-api/job-board/gamma')) return J(ashby);
  if (url.includes('api.ashbyhq.com/posting-api/job-board/blocked')) return new Response('forbidden', { status: 403 });
  if (url.includes('delta.wd5.myworkdayjobs.com/wday/cxs/delta/Ext/jobs')) return J(wdList);
  if (url.includes('delta.wd5.myworkdayjobs.com/wday/cxs/delta/Ext/job/')) return J(wdDetail);
  if (url.includes('wrong.wd1.myworkdayjobs.com')) return new Response('nope', { status: 404 });
  if (url.includes('amazon.jobs/en/search.json')) return J(amazon);
  if (url.includes('apply.careers.microsoft.com/api/pcsx/search')) {
    const start = +new URL(url).searchParams.get('start');
    if (!['', 'United States'].includes(new URL(url).searchParams.get('location'))) return new Response('Forbidden', { status: 403 });
    const all = [{ id: 1970393557041105, displayJobId: '200001', name: 'Principal Product Manager, Security Copilot', standardizedLocations: ['New York, NY, US'], postedTs: Date.parse('2026-11-17T12:00:00Z') / 1000, creationTs: Date.parse('2026-11-10T12:00:00Z') / 1000, workLocationOption: 'onsite', positionUrl: '/careers/job/1970393557041105' },
                 { id: 1970393557041106, displayJobId: '200002', name: 'Software Engineer II', standardizedLocations: ['Redmond, WA, US'], postedTs: Date.parse('2026-11-18T12:00:00Z') / 1000 }];
    return new Response(JSON.stringify({ data: { count: 2, positions: all.slice(start, start + 1) } }), { status: 200 });
  }
  if (url.includes('apply.careers.microsoft.com/api/pcsx/position_details')) return new Response(JSON.stringify({ data: { jobDescription: '<p>The typical base pay range for this role across the U.S. is USD $163,600 - $303,600 per year.</p>', efcustomTextWorkSite: 'Up to 50% work from home' } }), { status: 200 });
  if (url.includes('careers.cisco.com/global/en/search-results')) return new Response(`<html data-ph-id="x"><script>phApp.ddo = {"eagerLoadRefineSearch":{"totalHits":1,"data":{"jobs":[{"jobId":"1450009","jobSeqNo":"CISCUS1450009EXTERNALENUS","title":"Head of Partner Marketing, Security","location":"New York, New York, US","multi_location":["New York, New York, US"],"postedDate":"2026-11-18T05:00:00.000+0000","category":"Marketing"}]}}}; phApp.sessionParams = {};</script></html>`, { status: 200 });
  if (url.includes('careers.cisco.com/global/en/job/1450009')) return new Response(`<script>phApp.ddo = {"jobDetail":{"data":{"job":{"description":"<p>US base salary range: $230,000 - $330,000</p>"}}}}; phApp.x = 1;</script>`, { status: 200 });
  if (url.includes('jobs.cisco.com/jobs/SearchJobs/')) return new Response(`<html><body><table><tr><th>Job Title</th><th>Area of Interest</th><th>Job Type</th><th>Location</th><th>Alternate Location</th></tr>
<tr><td><a href="https://jobs.cisco.com/jobs/ProjectDetail/Director-Product-Marketing-Security/1450001">Director, Product Marketing - Security</a></td><td>Marketing</td><td>Professional</td><td>New York, New York, US</td><td>Remote, US</td></tr>
<tr><td><a href="/jobs/ProjectDetail/Engineer/1450002">Software Engineer</a></td><td>Engineer - Software</td><td>Professional</td><td>Bangalore, India</td><td></td></tr></table></body></html>`, { status: 200 });
  if (url.includes('jobs.cisco.com/jobs/ProjectDetail/Director')) return new Response('<html><body><h1>Director</h1><p>The US base salary range for this position is $210,000 - $290,000.</p></body></html>', { status: 200 });
  if (url.includes('www.comeet.com/jobs/epsilon/11.001')) return new Response(`<html><script>var COMPANY_DATA = {"name":"Epsilon"};
var COMPANY_POSITIONS_DATA = [{"uid":"A1.001","name":"Director, Product Marketing [Data] \\"DSPM\\"","department":"Marketing","location":{"name":"New York, NY","city":"New York","state":"NY","country":"US","is_remote":false},"workplace_type":"Hybrid","time_updated":"2026-11-18T14:00:00Z","url_active_page":"https://www.comeet.com/jobs/epsilon/11.001/director-product-marketing/A1.001","custom_fields":{"details":[{"name":"Description","value":"<p>Own launches.</p>","order":1},{"name":"Compensation","value":"<p>The base salary range for this role is $210,000 - $250,000.</p>","order":2}]}},{"uid":"A1.002","name":"Talent Pool","is_talent_pool":true,"location":{}}];
var OTHER = 1;</script></html>`, { status: 200 });
  if (url.includes('flaky.example')) { flaky++; return flaky < 2 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : J({ jobs: [] }); }
  return new Response('not mocked', { status: 404 });
};
let flaky = 0;

const dir = await mkdtemp(join(tmpdir(), 'jr-'));
const reg = { employers: [
  { employer: 'Acme', tier: 'core', sources: [{ id: 'gh:acme', ats: 'greenhouse', slug: 'acme' }] },
  { employer: 'Beta', tier: 'core', sources: [{ id: 'lever:beta', ats: 'lever', slug: 'beta' }] },
  { employer: 'Gamma', tier: 'core', sources: [{ id: 'ashby:gamma', ats: 'ashby', slug: 'gamma' }, { id: 'ashby:blocked', ats: 'ashby', slug: 'blocked' }] },
  { employer: 'Delta', tier: 'heavy', sources: [{ id: 'wd:delta', ats: 'workday', host: 'delta.wd5.myworkdayjobs.com', tenant: 'delta', site: 'Ext', queries: ['product manager'] }, { id: 'wd:wrong', ats: 'workday', host: 'wrong.wd1.myworkdayjobs.com', tenant: 'wrong', site: 'X', queries: ['a', 'b'] }] },
  { employer: 'Amazon / AWS', tier: 'heavy', sources: [{ id: 'amazon:jobs', ats: 'amazon', queries: ['product marketing'] }] },
  { employer: 'Cisco', tier: 'heavy', sources: [{ id: 'cisco:rss', ats: 'cisco_rss', queries: ['marketing'], phenom_base: 'https://careers.cisco.com/global/en', feed_url_template: 'https://jobs.cisco.com/jobs/SearchJobs/{q}/feed' }] },
  { employer: 'Microsoft', tier: 'heavy', sources: [{ id: 'ms:eightfold', ats: 'eightfold', host: 'apply.careers.microsoft.com', domain: 'microsoft.com', queries: ['product manager'] }] },
  { employer: 'Epsilon', tier: 'core', sources: [{ id: 'comeet:epsilon', ats: 'comeet', slug: 'epsilon', company_uid: '11.001' }] },
  { employer: 'Google', tier: 'heavy', sources: [{ id: 'google:link', ats: 'link_only', verification: { status: 'link_only', method: 'No feed' } }] },
] };
await writeFile(join(dir, 'sources.json'), JSON.stringify(reg));
const FAST = { http: { minDelayMs: 1, maxDelayMs: 2, concurrency: 4, timeoutMs: 2000, retries: 2 }, host_rules: [] };
try {
  const r1 = await run({ fetchImpl: mockFetch, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  const S = Object.fromEntries(r1.statusOut.sources.map(s => [s.id, s]));
  const J = Object.fromEntries(r1.jobsOut.jobs.map(j => [j.uid, j]));
  t('403 recorded as access failure, not empty', () => assert.equal(S['ashby:blocked'].result, 'http_403'));
  t('wrong workday config → 404 with hint', () => { assert.equal(S['wd:wrong'].result, 'http_404'); assert.match(S['wd:wrong'].message, /tenant\/site/); });
  t('wrong workday stops after first query (no hammering)', () => assert.equal(calls.filter(c => c.includes('wrong.wd1')).length, 1));
  t('link_only listed', () => assert.equal(S['google:link'].result, 'link_only'));
  t('non-US job dropped', () => assert.equal(J['gh:acme:2'], undefined));
  t('gh first_published used', () => assert.equal(J['gh:acme:1'].posted_kind, 'first_published'));
  t('gh salary base starts', () => assert.equal(salaryTier(J['gh:acme:1'].salary, 200000), 'starts'));
  t('gtm engineer kept for review, OTE only', () => { assert.equal(J['gh:acme:3'].eng_review, true); assert.equal(J['gh:acme:3'].salary.kind, 'ote_only'); });
  t('lever structured salary reaches', () => assert.equal(salaryTier(J['lever:beta:lv1'].salary, 200000), 'reaches'));
  t('lever eligible via all 50 states (any viewer)', () => { assert.equal(homeFit(J['lever:beta:lv1'], { state: 'NY' }).eligibility, 'yes'); assert.equal(homeFit(J['lever:beta:lv1'], { state: 'OR' }).eligibility, 'yes'); });
  t('ashby structured base', () => { assert.equal(J['ashby:gamma:as1'].salary.kind, 'base'); assert.equal(J['ashby:gamma:as1'].workplace, 'hybrid'); });
  t('workday detail gives exact start date', () => assert.equal(J['wd:delta:R100'].posted_kind, 'start_date'));
  t('workday irrelevant job not detailed', () => assert.equal(calls.filter(c => c.includes('/job/Ohio')).length, 0));
  t('cisco phenom JSON parsed', () => { const c = J['cisco:rss:CISCUS1450009EXTERNALENUS']; assert.ok(c, 'cisco job missing'); assert.equal(c.salary.min, 230000); assert.equal(c.posted_kind, 'posted_date'); });
  t('microsoft eightfold: pages by returned count, details give base pay + work site', () => { const m = J['ms:eightfold:1970393557041105']; assert.ok(m); assert.equal(m.salary.min, 163600); assert.equal(m.salary.kind, 'base'); assert.equal(m.workplace, 'hybrid'); assert.equal(m.posted_kind, 'posted_ts'); assert.ok(J['ms:eightfold:1970393557041106']); assert.equal(S['ms:eightfold'].result, 'ok'); });
  t('microsoft: US-filtered full list is read before any keyword search', () => { const ms = calls.filter(c => c.includes('/api/pcsx/search')); assert.ok(ms[0].includes('query=&location=United%20States&start=0'), ms[0]); assert.ok(ms.some(c => c.includes('query=product%20manager&location=United%20States&start=0'))); });
  t('comeet embedded positions parsed (talent pool skipped, base from text, hybrid)', () => { const c = J['comeet:epsilon:A1.001']; assert.ok(c, 'comeet job missing'); assert.equal(c.salary.min, 210000); assert.equal(c.workplace, 'hybrid'); assert.equal(c.posted_kind, 'updated_only'); assert.equal(J['comeet:epsilon:A1.002'], undefined); assert.equal(S['comeet:epsilon'].result, 'ok'); });
  t('amazon AWS tagged + salary', () => { const a = J['amazon:jobs:3100001']; assert.equal(a.employer, 'Amazon / AWS (AWS)'); assert.equal(a.salary.max, 250000); });

  // second run: Acme fails → its jobs are preserved and flagged stale, not deleted
  const failing = async (url, o) => url.includes('greenhouse.io/v1/boards/acme') ? new Response('err', { status: 503 }) : mockFetch(url, o);
  const r2 = await run({ fetchImpl: failing, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  const J2 = Object.fromEntries(r2.jobsOut.jobs.map(j => [j.uid, j]));
  t('failed refresh preserves roles', () => { assert.ok(J2['gh:acme:1']); assert.equal(J2['gh:acme:1'].stale, true); });
  t('first_observed preserved', () => assert.equal(J2['lever:beta:lv1'].first_observed, J['lever:beta:lv1'].first_observed));
  t('5xx retried with backoff', () => assert.ok(r2.statusOut.run.http.retries >= 2));
  const S2 = Object.fromEntries(r2.statusOut.sources.map(s => [s.id, s]));
  t('consecutive failures counted', () => assert.equal(S2['gh:acme'].consecutive_failures, 1));
  // ---------- email digest
  await copyFile(join(dir, 'sources.json'), join(dir, 'sources.json.bak'));
  const crit = { functions: ['product', 'tpm', 'pmm', 'sales', 'partner', 'ci', 'strategy'], engReview: true, minBase: 200000, salMode: 'starts_reaches', window: 'd7', firstSeen: true, updated: true,
    lMetro: true, lRemoteYes: true, lRemoteUnknown: true, lOther: false, metro: 'new york', state: 'NY', sen: 2, include: '', exclude: '', tiers: {}, sectors: [], verticals: [] };
  const sentMail = [];
  const mailFetch = async (url, o) => { sentMail.push({ url, body: JSON.parse(o.body) }); return new Response('{"id":"x"}', { status: 200 }); };
  const env = { SUBSCRIBERS: JSON.stringify([{ email: 'Person@Example.com', crit, tz: 'America/New_York' }]), RESEND_API_KEY: 'k', ALERT_FROM: 'Radar <a@b.c>', DIGEST_SALT: 'salt', SITE_URL: 'https://x.github.io/rr/' };
  const d1 = await runDigest({ env, fetchImpl: mailFetch, dataDir: dir, now: NOW });
  t('digest sends to subscriber', () => { assert.equal(sentMail.length, 1); assert.deepEqual(sentMail[0].body.to, ['Person@Example.com']); });
  t('digest has base-starts job, excludes OTE-only', () => { const h = sentMail[0].body.html; assert.match(h, /Director, Product Marketing/); assert.match(h, /Chief of Staff, GTM/); assert.doesNotMatch(h, /GTM Engineer/); });
  const stateTxt = await readFile(join(dir, 'digest-state.json'), 'utf8');
  t('digest state has no plaintext email', () => assert.doesNotMatch(stateTxt, /example\.com/i));
  await runDigest({ env, fetchImpl: mailFetch, dataDir: dir, now: NOW });
  t('no repeat email when nothing new', () => assert.equal(sentMail.length, 1));
  const d3 = await runDigest({ env: { SUBSCRIBERS: env.SUBSCRIBERS }, fetchImpl: mailFetch, dataDir: dir, now: NOW });
  t('no keys → skipped', () => assert.equal(d3.sent, 0));
} finally {}

/* ---------- Workday under rate limiting: partial results, detail reuse, search rotation */
{
  const wdPost = (path, title) => ({ externalPath: `/job/New-York/${path}`, title, locationsText: 'New York, NY', postedOn: 'Posted Today', bulletFields: [path] });
  const mkFetch = (plan, log) => async (url, init = {}) => {
    log.push(url + ' ' + (init.body || ''));
    const q = init.body ? JSON.parse(init.body).searchText : null;
    if (url.includes('/jobs')) { const r = plan[q]; if (r === 429) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }); return new Response(JSON.stringify({ jobPostings: r || [] }), { status: 200 }); }
    return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: '<p>Base salary range: $210,000 - $260,000</p>', location: 'New York, NY', startDate: '2026-11-18', jobReqId: url.split('_').pop() } }), { status: 200 });
  };
  const dir = await mkdtemp(join(tmpdir(), 'cf-wd-'));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'Echo', tier: 'heavy', sectors: 'Cybersecurity', sources: [{ id: 'wd:echo', ats: 'workday', host: 'echo.wd5.myworkdayjobs.com', tenant: 'echo', site: 'Ext', queries: ['product manager', 'threat intelligence'] }] }] }));
  const plan1 = { 'product manager': [wdPost('PM_R1', 'Senior Product Manager, Security')], 'threat intelligence': [wdPost('TI_R2', 'Threat Intelligence Lead')] };
  const L1 = []; await run({ fetchImpl: mkFetch(plan1, L1), env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  const L2 = []; const r2 = await run({ fetchImpl: mkFetch({ 'product manager': plan1['product manager'], 'threat intelligence': 429 }, L2), env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  const J2 = Object.fromEntries(r2.jobsOut.jobs.map(j => [j.uid, j])), S2 = r2.statusOut.sources.find(x => x.id === 'wd:echo');
  t('workday refused part-way → partial, earlier results kept', () => { assert.equal(S2.result, 'partial'); assert.equal(J2['wd:echo:R1'].status, 'open'); assert.ok(!J2['wd:echo:R1'].stale); });
  t('workday partial: unreached role stays open, marked not refreshed', () => { assert.equal(J2['wd:echo:R2'].status, 'open'); assert.equal(J2['wd:echo:R2'].stale, true); });
  t('workday known posting: details reused, not re-fetched', () => { assert.equal(L2.filter(u => u.includes('/job/New-York/PM_R1') && !u.includes('/jobs')).length, 0); assert.equal(J2['wd:echo:R1'].salary.min, 210000); assert.equal(J2['wd:echo:R1'].posted_kind, 'start_date'); });
  t('workday 429 message is about rate limits, not identifiers', () => assert.doesNotMatch(S2.message, /tenant\/site/));
  // rotation: 9 searches over 3 runs
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'Echo', tier: 'heavy', sources: [{ id: 'wd:echo', ats: 'workday', host: 'echo.wd5.myworkdayjobs.com', tenant: 'echo', site: 'Ext', queries: many }] }] }));
  const L3 = []; const r3 = await run({ fetchImpl: mkFetch({}, L3), env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: { ...FAST, workday_query_rotation: 3 } });
  const searched = L3.filter(u => u.includes('/jobs')).map(u => JSON.parse(u.slice(u.indexOf(' ') + 1)).searchText);
  t('workday rotation runs a third of the searches per run', () => { assert.equal(searched.length, 3); assert.match(r3.statusOut.sources.find(x => x.id === 'wd:echo').message, /rotation \d\/3 of 9/); });
  t('rotation keeps unseen roles open (not closed)', () => assert.equal(r3.jobsOut.jobs.find(j => j.uid === 'wd:echo:R2').status, 'open'));
}

/* ---------- Workday full scan (blank search) with resume after a refusal */
{
  const mk = n => Array.from({ length: n }, (_, i) => ({ externalPath: `/job/Remote/Role-${i}_F${i}`, title: `Account Executive ${i}`, locationsText: 'USA - Remote', postedOn: 'Posted Today' }));
  const all = mk(50);
  const dir = await mkdtemp(join(tmpdir(), 'cf-fs-'));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'Foxtrot', tier: 'heavy', sources: [{ id: 'wd:fox', ats: 'workday', host: 'fox.wd5.myworkdayjobs.com', tenant: 'fox', site: 'Ext', queries: [''], max_results: 2000 }] }] }));
  const offsets = []; let refuseAt = 20;
  const f = async (url, init = {}) => {
    if (url.includes('/jobs')) { const { offset, searchText } = JSON.parse(init.body); offsets.push(offset);
      if (searchText !== '') return new Response('{}', { status: 400 });
      if (offset === refuseAt) return new Response('slow', { status: 429, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify({ total: all.length, jobPostings: all.slice(offset, offset + 20) }), { status: 200 }); }
    return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: '', location: 'Remote, USA', startDate: '2026-11-18' } }), { status: 200 });
  };
  const a = await run({ fetchImpl: f, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  const sa = a.statusOut.sources.find(x => x.id === 'wd:fox');
  t('full scan refused at page 2 → partial with resume point', () => { assert.equal(sa.result, 'partial'); assert.equal(sa.resume_offset, 20); assert.equal(a.jobsOut.jobs.length, 20); });
  offsets.length = 0; refuseAt = -1;
  const b = await run({ fetchImpl: f, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  t('next run resumes at the refused page, then wraps to the start', () => { assert.deepEqual(offsets.slice(0, 3), [20, 40, 0]); assert.equal(b.statusOut.sources.find(x => x.id === 'wd:fox').result, 'ok'); assert.equal(b.jobsOut.jobs.filter(j => j.status === 'open').length, 50); });
  t('full scan under 2,000 listings: no cap warning', () => assert.doesNotMatch(b.statusOut.sources.find(x => x.id === 'wd:fox').message, /2,000/));
  t('completed full scan clears the resume point', () => assert.equal(b.statusOut.sources.find(x => x.id === 'wd:fox').resume_offset, null));
}

/* ---------- Workday: US-only filter read from the tenant's own facets, saved, reused; resume point survives a total refusal */
{
  const mk = (n, where, tag) => Array.from({ length: n }, (_, i) => ({ externalPath: `/job/${tag}/Role-${i}_${tag}${i}`, title: `Account Executive ${i}`, locationsText: where, postedOn: 'Posted Today' }));
  const us = mk(45, 'USA - Remote', 'U'), intl = mk(40, 'London, UK', 'X');
  const FACETS = [{ facetParameter: 'locationMainGroup', descriptor: 'Locations', values: [{ facetParameter: 'locationCountry', descriptor: 'Country', values: [{ descriptor: 'United Kingdom', id: 'uk1', count: 40 }, { descriptor: 'United States of America', id: 'us9', count: 45 }] }] }];
  const dir = await mkdtemp(join(tmpdir(), 'cf-us-'));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'Golf', tier: 'heavy', sources: [{ id: 'wd:golf', ats: 'workday', host: 'golf.wd5.myworkdayjobs.com', tenant: 'golf', site: 'Ext', queries: [''], max_results: 2000 }] }] }));
  const bodies = []; let mode = 'refuse20';
  const f = async (url, init = {}) => {
    if (url.includes('/jobs')) { const b = JSON.parse(init.body); bodies.push(b);
      if (mode === 'refuseAll' || (mode === 'refuse20' && b.offset === 20 && b.appliedFacets.locationCountry)) return new Response('slow', { status: 429, headers: { 'retry-after': '0' } });
      const list = b.appliedFacets.locationCountry ? us : [...us, ...intl];
      return new Response(JSON.stringify({ total: list.length, facets: FACETS, jobPostings: list.slice(b.offset, b.offset + 20) }), { status: 200 }); }
    return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: '', location: 'Remote, USA', startDate: '2026-11-18' } }), { status: 200 });
  };
  const a = await run({ fetchImpl: f, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  const sa = a.statusOut.sources.find(x => x.id === 'wd:golf');
  t('workday: US filter found in nested facets and applied', () => { assert.deepEqual(bodies[0].appliedFacets, {}); assert.deepEqual(bodies[1].appliedFacets, { locationCountry: ['us9'] }); assert.deepEqual(sa.us_facet, { locationCountry: ['us9'] }); assert.ok(a.jobsOut.jobs.every(j => !/London/.test(j.locations.join()))); });
  bodies.length = 0; mode = 'refuseAll';
  const b = await run({ fetchImpl: f, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  const sb = b.statusOut.sources.find(x => x.id === 'wd:golf');
  t('workday: a run refused outright keeps the resume point and the saved filter', () => { assert.equal(sb.result, 'http_429'); assert.equal(sb.resume_offset, 20); assert.deepEqual(sb.us_facet, { locationCountry: ['us9'] }); });
  bodies.length = 0; mode = 'ok';
  const c = await run({ fetchImpl: f, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  t('workday: next run uses the saved filter from the first request and resumes where it stopped', () => { assert.deepEqual(bodies[0].appliedFacets, { locationCountry: ['us9'] }); assert.equal(bodies[0].offset, 20); assert.equal(c.statusOut.sources.find(x => x.id === 'wd:golf').result, 'ok'); });
}

/* ---------- Avature (IBM-style): search link, keyword field and paging all discovered from the site's own pages */
{
  const dir = await mkdtemp(join(tmpdir(), 'cf-av-'));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'Hotel', tier: 'heavy', sources: [{ id: 'avature:hotel', ats: 'avature', seed_url: 'https://careers.hotel.test/en_US/careers/JobDetail?jobId=900', queries: ['product marketing'] }] }] }));
  const ld = (t, loc, d, min, max) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: t, datePosted: d, jobLocation: [{ address: { addressLocality: loc, addressRegion: 'NY', addressCountry: 'US' } }], baseSalary: { value: { minValue: min, maxValue: max, unitText: 'YEAR' } }, description: '<p>Lead launches.</p>' })}</script>`;
  const urls = [];
  const f = async url => { urls.push(url);
    const H = (b, st = 200) => new Response(b, { status: st, headers: { 'content-type': 'text/html' } });
    if (url.endsWith('/robots.txt')) return H('User-agent: *\nDisallow: /en_US/careers/Login');
    if (url.includes('JobDetail?jobId=900')) return H('<a href="/en_US/careers/SearchJobs/?listFilterMode=1">Back to search</a>');
    if (url.includes('/SearchJobs/') && !url.includes('kw=')) return H('<form action="/en_US/careers/SearchJobs/" method="get"><input type="text" name="kw"></form>');
    if (url.includes('kw=product+marketing') && !url.includes('jobOffset')) return H('<a href="/en_US/careers/JobDetail?jobId=101">Senior Product Marketing Manager, Security</a><a href="/en_US/careers/JobDetail?jobId=102">Backend Developer</a><a class="paginationNextLink" href="/en_US/careers/SearchJobs/?kw=product+marketing&amp;jobOffset=10">Next</a>');
    if (url.includes('jobOffset=10')) return H('<a href="/en_US/careers/JobDetail?jobId=103">Director, Product Marketing</a>');
    if (url.includes('jobId=101')) return H(ld('Senior Product Marketing Manager, Security', 'New York', '2026-11-18', 180000, 260000));
    if (url.includes('jobId=103')) return H(ld('Director, Product Marketing', 'Armonk', '2026-11-17', 220000, 300000));
    return H('nope', 404); };
  const r = await run({ fetchImpl: f, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  const st = r.statusOut.sources.find(x => x.id === 'avature:hotel'), J = Object.fromEntries(r.jobsOut.jobs.map(j => [j.uid, j]));
  t('avature: search link + keyword field + next page discovered; jobs read from JSON-LD', () => { assert.equal(st.result, 'ok'); assert.match(st.message, /keyword field "kw"/); assert.equal(r.jobsOut.jobs.length, 3); assert.equal(J['avature:hotel:101'].salary.min, 180000); assert.equal(J['avature:hotel:103'].posted_kind, 'json_ld_date_posted'); });
  t('avature: irrelevant titles are not opened', () => assert.ok(!urls.some(u => u.includes('jobId=102'))));
}

/* ---------- Company careers page with query-string job links (Check Point style) */
{
  const dir = await mkdtemp(join(tmpdir(), 'cf-cp-'));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'India', tier: 'named', sources: [{ id: 'html:india', ats: 'company_html', list_url: 'https://careers.india.test/jobs?country=United+States', link_pattern: '(?:job|jid|position|opening)\\D{0,25}\\d{4,7}' }] }] }));
  const f = async url => { const H = (b, st = 200) => new Response(b, { status: st, headers: { 'content-type': 'text/html' } });
    if (url.endsWith('/robots.txt')) return H('User-agent: *\nDisallow:');
    if (url.includes('/jobs?country=') && !url.includes('page=2')) return H('<a href="/jobs?country=Israel">Israel</a><a href="/index.php?m=cpcareers&amp;a=show&amp;jid=25973">Territory Account Manager - New York</a><a href="/job/25925/advanced-support-engineer">Advanced Support Engineer</a><a href="/jobs/7118273/area-manager-federal-sales">Area Manager, Federal Sales</a><a rel="next" href="/jobs?country=United+States&amp;page=2">Next</a>');
    if (url.includes('page=2')) return H('<a href="/jobs/7120001/product-marketing-manager">Product Marketing Manager</a>');
    if (url.includes('/jobs/7120001')) return H('<h1>Product Marketing Manager</h1>');
    if (url.includes('jid=25973')) return H('<h1>Territory Account Manager - New York</h1><p>United States: New York NY</p>');
    if (url.includes('/job/25925')) return H('<h1>Advanced Support Engineer</h1>');
    if (url.includes('/jobs/7118273')) return H('<h1>Area Manager, Federal Sales</h1>');
    return H('nope', 404); };
  const r = await run({ fetchImpl: f, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  const ids = r.jobsOut.jobs.map(j => j.uid).sort();
  t('company page: query-string and path job links found across next pages, numeric ids kept', () => assert.deepEqual(ids, ['html:india:25925', 'html:india:25973', 'html:india:7118273', 'html:india:7120001']));
}

/* ---------- Ashby pay: per-zone tiers and summary-line-only compensation */
{
  const { ADAPTERS: A } = await import('../../assets/shared/core.mjs');
  const jobsResp = { jobs: [
    { id: 't1', title: 'Solutions Consultant, Post Sales, Strategic', jobUrl: 'https://jobs.ashbyhq.com/ramp/t1', location: 'New York, NY', publishedAt: '2026-11-19T19:09:55Z', descriptionPlain: 'About Ramp',
      compensation: { summaryComponents: [], compensationTiers: [{ title: 'Zone 1', components: [{ compensationType: 'Salary', minValue: 160000, maxValue: 200000, currencyCode: 'USD', interval: '1 YEAR' }] }, { title: 'Zone 2', components: [{ compensationType: 'Salary', minValue: 144000, maxValue: 180000, currencyCode: 'USD', interval: '1 YEAR' }] }, { title: 'Toronto', components: [{ compensationType: 'Salary', minValue: 150000, maxValue: 190000, currencyCode: 'CAD', interval: '1 YEAR' }] }] } },
    { id: 't2', title: 'Product Marketing Lead', jobUrl: 'https://jobs.ashbyhq.com/ramp/t2', location: 'New York, NY', publishedAt: '2026-11-19T19:09:55Z', descriptionPlain: 'About Ramp', compensation: { scrapeableCompensationSalarySummary: '$172K - $215K', compensationTierSummary: '$172K – $215K • Offers Equity' } },
    { id: 't3', title: 'Account Executive', jobUrl: 'https://jobs.ashbyhq.com/ramp/t3', location: 'New York, NY', publishedAt: '2026-11-19T19:09:55Z', descriptionPlain: 'About Ramp', compensation: { compensationTierSummary: '$250K OTE • Offers Equity' } } ] };
  const http = { json: async () => ({ ok: true, status: 200, data: jobsResp }) };
  const out = await A.ashby({ id: 'ashby:ramp', slug: 'ramp' }, { employer: 'Ramp' }, http);
  const by = Object.fromEntries(out.jobs.map(j => [j.ext_id, j]));
  t('ashby: tiered pay read across US zones (CAD tier ignored)', () => { assert.equal(by.t1.salary_struct.min, 144000); assert.equal(by.t1.salary_struct.max, 200000); });
  t('ashby: summary-line-only pay is read', () => { assert.equal(by.t2.salary_struct.min, 172000); assert.equal(by.t2.salary_struct.max, 215000); });
  t('ashby: an OTE-only summary is not counted as base', () => assert.equal(by.t3.salary_struct, null));
}

/* ---------- Google Careers (experimental, shape-matched) and Radancy (robots → sitemap → JSON-LD) */
{
  const gJob = (id, title, loc, ts) => [id, title, `https://www.google.com/about/careers/applications/signin?jobId=${id}`, [null, '<ul><li>Lead launches</li></ul>'], [null, '<p>Minimum qualifications: 10 years.</p>'], null, null, 'Google', 'en-US', [[loc, [loc], loc.split(',')[0], null, 'NY', 'US']], [null, '<p>The US base salary range for this full-time position is $197,000-$291,000 + bonus + equity + benefits.</p>'], [ts, 0]];
  const gPage = jobs => `<html><script>AF_initDataCallback({key: 'ds:0', hash: '1', data:[1,2], sideChannel: {}});</script><script class="ds:1">AF_initDataCallback({key: 'ds:1', hash: '2', data:[[${jobs.map(j => JSON.stringify(j)).join(',')}],null,${jobs.length}], sideChannel: {}});</script></html>`;
  const dir = await mkdtemp(join(tmpdir(), 'cf-gr-'));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [
    { employer: 'Google', tier: 'heavy', sources: [{ id: 'google:careers', ats: 'google_careers', queries: ['threat intelligence'], max_pages: 2 }] },
    { employer: 'Palo Alto Networks', tier: 'heavy', sources: [{ id: 'radancy:panw', ats: 'radancy', base: 'https://jobs.example-radancy.com', lang: 'en' }] },
    { employer: 'Blocked Co', tier: 'core', sources: [{ id: 'radancy:blocked', ats: 'radancy', base: 'https://jobs.blocked-radancy.com', lang: 'en' }] } ] }));
  const calls = [];
  const f = async url => { calls.push(url);
    if (url.includes('google.com/about/careers') && url.includes('page=1')) return new Response(gPage([gJob('123456789012345678', 'Senior Threat Intelligence Analyst, Mandiant', 'New York, NY, USA', 1763500000)]), { status: 200 });
    if (url.includes('google.com/about/careers')) return new Response(gPage([]), { status: 200 });
    if (url === 'https://jobs.blocked-radancy.com/robots.txt') return new Response('User-agent: *\nDisallow: /en/job/\n', { status: 200 });
    if (url === 'https://jobs.example-radancy.com/robots.txt') return new Response('User-agent: *\nDisallow: /account/\nSitemap: https://jobs.example-radancy.com/sitemap.xml\n', { status: 200 });
    if (url.endsWith('/sitemap.xml')) return new Response('<urlset><url><loc>https://jobs.example-radancy.com/en/job/new-york/senior-product-marketing-manager/47263/9001</loc></url><url><loc>https://jobs.example-radancy.com/en/job/santa-clara/staff-software-engineer/47263/9002</loc></url></urlset>', { status: 200 });
    if (url.includes('/en/job/new-york/')) return new Response(`<html><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Senior Product Marketing Manager, Cortex', datePosted: '2026-11-17', identifier: { value: 'JR-123' }, description: '<p>The base salary range for this role is $180,000 - $250,000.</p>', jobLocation: [{ '@type': 'Place', address: { addressLocality: 'New York', addressRegion: 'NY', addressCountry: 'US' } }] })}</script></html>`, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const r = await run({ fetchImpl: f, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  const J = Object.fromEntries(r.jobsOut.jobs.map(j => [j.uid, j])), S = Object.fromEntries(r.statusOut.sources.map(x => [x.id, x]));
  t('google careers: job found by shape, base salary from text', () => { const g = J['google:careers:123456789012345678']; assert.ok(g, JSON.stringify(S['google:careers'])); assert.equal(g.salary.min, 197000); assert.ok(g.functions.includes('threat')); assert.match(g.locations[0], /New York/); });
  t('google careers: a short page (<20) is the last page', () => assert.equal(calls.filter(u => u.includes('google.com/about')).length, 1));
  t('radancy: sitemap → JSON-LD title, date, req id, base pay', () => { const p = J['radancy:panw:9001']; assert.equal(p.title, 'Senior Product Marketing Manager, Cortex'); assert.equal(p.posted_kind, 'json_ld_date_posted'); assert.equal(p.req_id, 'JR-123'); assert.equal(p.salary.min, 180000); });
  t('radancy: irrelevant posting listed from sitemap without a page fetch', () => { assert.ok(J['radancy:panw:9002']); assert.equal(calls.filter(u => u.includes('staff-software-engineer')).length, 0); });
  t('radancy: robots.txt disallow is honored', () => { assert.equal(S['radancy:blocked'].result, 'blocked_by_robots'); assert.equal(calls.filter(u => u.includes('blocked-radancy') && !u.endsWith('robots.txt')).length, 0); });
}

/* ---------- company careers page (Exaforce-style) and Apply-link discovery */
{
  const { atsLinks } = await import('../lib/adapters-server.mjs');
  t('atsLinks finds boards on a careers page', () => {
    const found = atsLinks('<a href="https://job-boards.greenhouse.io/atbayjobs/jobs/123">Apply</a><iframe src="https://boards.greenhouse.io/embed/job_board?for=Federato"></iframe><a href="https://jobs.lever.co/acme/abc">x</a><a href="https://acme.wd5.myworkdayjobs.com/en-US/AcmeCareers/job/x">y</a>');
    const k = found.map(f => `${f.ats}:${f.slug}`);
    for (const want of ['greenhouse:atbayjobs', 'greenhouse:federato', 'lever:acme', 'workday:acme/AcmeCareers']) assert.ok(k.includes(want), `${want} in ${k}`);
  });
  const dir = await mkdtemp(join(tmpdir(), 'cf-html-'));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'Exaforce', tier: 'core', sources: [{ id: 'html:exaforce', ats: 'company_html', list_url: 'https://www.exa.example/careers/', link_pattern: '/careers/[a-z0-9][a-z0-9-]+/?$' }] }] }));
  const calls = [];
  const f = async url => { calls.push(url);
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /admin/\n', { status: 200 });
    if (url === 'https://www.exa.example/careers/') return new Response('<nav><a href="/careers/">Careers</a><a href="/about">About</a></nav><a href="/careers/founding-product-marketing-manager">Founding Product Marketing Manager</a><a href="https://www.exa.example/careers/security-researcher/">Security Researcher</a>', { status: 200 });
    if (url.includes('founding-product-marketing')) return new Response('<html><body><h1>Founding Product Marketing Manager</h1><main><p>Location: New York, NY (Hybrid)</p><p>The base salary range for this role is $190,000 - $230,000.</p></main></body></html>', { status: 200 });
    if (url.includes('security-researcher')) return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Senior Security Researcher', description: '<p>Hunt threats.</p>', jobLocationType: 'TELECOMMUTE', jobLocation: { address: { addressCountry: 'US' } } })}</script>`, { status: 200 });
    return new Response('nf', { status: 404 }); };
  const r = await run({ fetchImpl: f, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: FAST });
  const J = Object.fromEntries(r.jobsOut.jobs.map(j => [j.uid, j]));
  t('company page: job links found, nav/self links skipped', () => assert.equal(r.jobsOut.jobs.length, 2));
  t('company page: heading + text when no JSON-LD (title, location, base pay)', () => { const j = J['html:exaforce:founding-product-marketing-manager']; assert.equal(j.title, 'Founding Product Marketing Manager'); assert.match(j.locations[0], /New York/); assert.equal(j.salary.min, 190000); assert.equal(j.posted_kind, 'unknown'); });
  t('company page: JSON-LD used when present', () => { const j = J['html:exaforce:security-researcher']; assert.equal(j.title, 'Senior Security Researcher'); assert.ok(j.functions.includes('threat')); });
}

{ // tracker: roles the user marked keep showing after they leave the filters or close
  const C2 = await import('../../assets/shared/core.mjs');
  const crit = { functions: ['pm'], minBase: 150000, salMode: 'starts', sen: 1, lMetro: true, lRemoteYes: true, lRemoteUnknown: true, lOther: false, tiers: {} };
  const j = { uid: 'x:1', title: 'Barista', employer: 'Cafe', functions: [], seniority: 1, status: 'closed', salary: null, locations: ['Austin, TX'], remote_us: false, posted_at: null };
  t('tracker: untracked closed role is filtered out', () => assert.equal(C2.evaluateJob(j, { crit }), null));
  t('tracker: force keeps a closed, off-filter role visible', () => { const m = C2.evaluateJob(j, { crit, force: true }); assert.ok(m); assert.equal(typeof m.score, 'number'); assert.ok(!Number.isNaN(m.score)); });
}

{ // review follow-ups: JazzHR/Dayforce link discovery
  const { atsLinks: AL } = await import('../lib/adapters-server.mjs');
  const L = AL('<a href="https://bluevoyant.applytojob.com/apply/">Jobs</a><a href="https://jobs.dayforcehcm.com/en-US/esentire/CANDIDATEPORTAL/jobs/5648">x</a>');
  t('probe: JazzHR and Dayforce careers links recognized', () => { assert.ok(L.some(x => x.ats === 'jazzhr' && x.slug === 'bluevoyant')); assert.ok(L.some(x => x.ats === 'dayforce' && x.slug === 'esentire/CANDIDATEPORTAL')); });
}

{ // company types replace heavy/named/core
  const C3 = await import('../../assets/shared/core.mjs');
  t('company type: explicit type wins; old tiers map; aggregator by source', () => {
    assert.equal(C3.companyType({}, { type: 'security', tier: 'core' }), 'security');
    assert.equal(C3.companyType({}, { tier: 'heavy' }), 'big');
    assert.equal(C3.companyType({ source_class: 'aggregator' }, { type: 'big' }), 'aggregator');
    assert.deepEqual(C3.companyTypeFilter({ tiers: { heavy: false, core: true } }), { big: false });
  });
}

{ // Microsoft (Eightfold): budgeted, checkpointed reader. Full US list first, then searches breadth-first;
  // closures only after a complete pass; refusal stops the source and keeps progress; bad location filter falls back.
  const dir = await mkdtemp(join(tmpdir(), 'cf-ms-'));
  const msSrc = extra => ({ id: 'ms:eightfold', ats: 'eightfold', host: 'apply.careers.microsoft.com', domain: 'microsoft.com', queries: ['product manager', 'strategy', 'partner'], location: 'United States', list_budget: 2, search_budget: 2, detail_budget: 2, close_after_hours: 1, ...extra });
  const writeSrc = async extra => writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'Microsoft', type: 'big', sources: [msSrc(extra),
    { id: 'gh:microsoftcorporation', ats: 'greenhouse', slug: 'microsoftcorporation' }] }] }));
  await writeSrc();
  const loc = i => i <= 20 ? 'Redmond, WA, US' : i <= 23 ? 'London, United Kingdom' : i === 24 ? 'USA - Remote' : 'Multiple Locations';
  const pos = i => ({ id: 1000 + i, name: i === 1 ? 'Principal Product Manager' : i <= 4 ? `Senior Product Manager ${i}` : `Software Engineer ${i}`, displayJobId: `R${i}`, locations: [loc(i)], workLocationOption: 'onsite', postedTs: 1763500000 });
  let refuseQ = null, gone = new Set(), zeroFilter = false; const calls = [];
  const pools = { '': Array.from({ length: 25 }, (_, k) => k + 1), 'product manager': Array.from({ length: 15 }, (_, k) => k + 1), strategy: [5], partner: [6] };
  const f = async url => { calls.push(url);
    if (url.includes('/api/pcsx/search')) {
      const q = new URL(url).searchParams, start = +q.get('start'), query = q.get('query'), location = q.get('location');
      if (refuseQ !== null && query === refuseQ) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
      const pool = (pools[query] || []).filter(i => !gone.has(i));
      if (zeroFilter && location) return new Response(JSON.stringify({ data: { count: 0, positions: [] } }), { status: 200 });
      return new Response(JSON.stringify({ data: { count: pool.length, positions: pool.slice(start, start + 10).map(pos) } }), { status: 200 });
    }
    if (url.includes('position_details')) return new Response(JSON.stringify({ data: { jobDescription: '<p>Base pay range USD $150,000 - $250,000 per year.</p>', efcustomTextWorkSite: '100% remote' } }), { status: 200 });
    if (url.includes('boards-api.greenhouse.io/v1/boards/microsoftcorporation')) return new Response(JSON.stringify({ jobs: [{ id: 77, title: 'Principal Product Manager', absolute_url: 'https://job-boards.greenhouse.io/microsoftcorporation/jobs/77', location: { name: 'Redmond, WA' }, updated_at: '2026-11-18T00:00:00Z', first_published: '2026-11-18T00:00:00Z', content: '' }] }), { status: 200 });
    return new Response('nf', { status: 404 }); };
  const go = async h => { const r = await run({ fetchImpl: f, env: {}, now: new Date(NOW.getTime() + h * 36e5), dataDir: dir, argv: {}, cfgOverride: FAST });
    return { S: Object.fromEntries(r.statusOut.sources.map(x => [x.id, x])), J: Object.fromEntries(r.jobsOut.jobs.map(j => [j.uid, j])) }; };
  const msCalls = () => calls.filter(c => c.includes('/api/pcsx/search'));
  // run A: list pages 0 and 10, then one page each of the two oldest searches
  let n0 = calls.length; const A = await go(0); const a = msCalls().slice(0);
  const ck = A.S['ms:eightfold'].checkpoint;
  t('eightfold A: checkpoint saved (list at 20 of 25, not complete)', () => { assert.equal(ck.units['*'].offset, 20); assert.equal(ck.units['*'].count, 25); assert.equal(ck.units['*'].complete, false); });
  t('eightfold A: budget respected (2 list + 2 search pages), list read first', () => { assert.equal(a.length, 4); assert.ok(a[0].includes('query=&') && a[1].includes('query=&')); });
  t('eightfold A: breadth-first: "product manager" page 1 and "strategy" page 1, not "product manager" page 2', () => { assert.ok(a.some(c => c.includes('query=strategy'))); assert.ok(!a.some(c => c.includes('query=product%20manager') && c.includes('start=10'))); });
  t('eightfold A: detail budget caps detail reads at 2', () => assert.equal(calls.filter(c => c.includes('position_details')).length, 2));
  t('eightfold A: no complete pass yet, nothing closes', () => assert.match(A.S['ms:eightfold'].message, /no complete US pass yet/));
  t('eightfold: listing "onsite" ignored, detail work site decides', () => assert.equal(A.J['ms:eightfold:1001'].workplace, 'remote'));
  t('eightfold: Microsoft AI board role grouped with the same Microsoft role', () => { const x = A.J['ms:eightfold:1001'], y = A.J['gh:microsoftcorporation:77']; assert.ok(x && y); assert.equal(x.dup_count, 2); });
  // run B: resumes the list with a small overlap, completes the pass; then the never-scanned "partner" search comes first
  const nb = msCalls().length; const B = await go(4); const b = msCalls().slice(nb);
  const ckB = B.S['ms:eightfold'].checkpoint;
  t('eightfold B: list resumes at 18 (2-row overlap) and completes the pass', () => { assert.ok(b[0].includes('query=&') && b[0].includes('start=18'), b[0]); assert.ok(ckB.last_full_cycle_end); assert.equal(ckB.units['*'].offset, 0); });
  t('eightfold B: oldest search first ("partner" never scanned), then "product manager" page 2', () => { assert.ok(b[1].includes('query=partner'), b[1]); assert.ok(b[2].includes('query=product%20manager') && b[2].includes('start=8'), b[2]); });
  t('eightfold B: US + unclear remote kept, UK skipped', () => { assert.ok(B.J['ms:eightfold:1024']); assert.ok(B.J['ms:eightfold:1025']); assert.ok(!B.J['ms:eightfold:1021']); });
  t('eightfold B: remaining relevant detail read; known roles not re-read', () => assert.equal(calls.filter(c => c.includes('position_id=1001')).length, 1));
  // runs C and D: role 1007 disappears. C starts a new pass (not complete): no closure. D completes it: closed.
  gone = new Set([7]);
  const C = await go(8);
  t('eightfold C: a role missing from an unfinished pass stays open', () => assert.notEqual(C.J['ms:eightfold:1007'].status, 'closed'));
  const D = await go(12);
  t('eightfold D: after a complete pass that started after it was last seen, the role is closed', () => assert.equal(D.J['ms:eightfold:1007'].status, 'closed'));
  t('eightfold D: roles seen in the pass stay open', () => assert.notEqual(D.J['ms:eightfold:1015'].status, 'closed'));
  // run E: throttled on a search: stops there, keeps progress, makes no more Eightfold requests
  refuseQ = 'strategy'; const ne = calls.length;
  const E = await go(16); const e = calls.slice(ne).filter(c => c.includes('apply.careers.microsoft.com'));
  const ix = e.findIndex(c => c.includes('query=strategy'));
  t('eightfold E: refusal → partial, nothing after the refused request, checkpoint kept', () => { assert.equal(E.S['ms:eightfold'].result, 'partial'); assert.ok(ix >= 0); assert.equal(e.slice(ix + 1).filter(c => !c.includes('query=strategy')).length, 0); assert.ok(E.S['ms:eightfold'].checkpoint.units['*']); });
  t('eightfold E: roles not reached are kept (flagged stale, not closed)', () => { assert.notEqual(E.J['ms:eightfold:1024'].status, 'closed'); });
  // location filter that matches nothing → unfiltered fallback, remembered for later runs
  refuseQ = null; zeroFilter = true;
  const dir2 = await mkdtemp(join(tmpdir(), 'cf-ms2-'));
  await writeFile(join(dir2, 'sources.json'), JSON.stringify({ employers: [{ employer: 'Microsoft', type: 'big', sources: [msSrc({ queries: [] })] }] }));
  const nf = calls.length;
  const r1 = await run({ fetchImpl: f, env: {}, now: NOW, dataDir: dir2, argv: {}, cfgOverride: FAST });
  const s1 = r1.statusOut.sources.find(x => x.id === 'ms:eightfold');
  t('eightfold: empty location filter falls back to the unfiltered list and remembers it', () => { assert.equal(s1.checkpoint.location_ok, false); assert.match(s1.message, /matched nothing/); assert.ok(r1.jobsOut.jobs.some(j => j.uid === 'ms:eightfold:1001')); });
  const r2 = await run({ fetchImpl: f, env: {}, now: new Date(NOW.getTime() + 4 * 36e5), dataDir: dir2, argv: {}, cfgOverride: FAST });
  t('eightfold: next run goes straight to the unfiltered list', () => assert.ok(calls.slice(nf).filter(c => c.includes('pcsx/search')).slice(-2).every(c => c.includes('location=&'))));
}

{ // collection correctness: completeness states, evidence-based closures, Retry-After deferral, dedupe
  const dir = await mkdtemp(join(tmpdir(), 'cf-cc-'));
  const SRC = { employers: [
    { employer: 'HtmlCo', type: 'security', sources: [{ id: 'html:co', ats: 'company_html', list_url: 'https://careers.htmlco.example/jobs', link_pattern: '/jobs/\\d+$' }] },
    { employer: 'WdCo', type: 'security', sources: [{ id: 'wd:co', ats: 'workday', host: 'wdco.wd1.myworkdayjobs.com', tenant: 'wdco', site: 'Ext', queries: ['product manager', 'partner'], max_results: 60 }] },
    { employer: 'SlowCo', type: 'security', sources: [{ id: 'gh:slow', ats: 'greenhouse', slug: 'slowco' }] },
    { employer: 'DupCo', type: 'security', sources: [{ id: 'gh:dup', ats: 'greenhouse', slug: 'dupco' }] } ] };
  await writeFile(join(dir, 'sources.json'), JSON.stringify(SRC));
  let page2 = true, wdRefuseAt = null, wdDrop = new Set(), slow = 'ok'; const calls = [];
  const wdPool = { 'product manager': Array.from({ length: 50 }, (_, i) => i), partner: Array.from({ length: 70 }, (_, i) => 100 + i) };
  const H = (b, s = 200, h = {}) => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status: s, headers: h });
  const f = async (url, o = {}) => { calls.push(url);
    if (url.endsWith('/robots.txt')) return H('User-agent: *\n');
    if (url === 'https://careers.htmlco.example/jobs') return H('<a href="/jobs/101">Product Marketing Manager</a><a rel="next" href="/jobs?page=2">Next</a>');
    if (url === 'https://careers.htmlco.example/jobs?page=2') return page2 ? H('<a href="/jobs/102">Director, Partnerships</a>') : H('down', 503);
    if (/careers\.htmlco\.example\/jobs\/\d+$/.test(url)) return H('<h1>Role</h1><main>Location: New York, NY</main>');
    if (url.includes('wdco.wd1.myworkdayjobs.com/wday/cxs/wdco/Ext/jobs')) {
      const b = JSON.parse(o.body), q = b.searchText, off = b.offset;
      if (wdRefuseAt && wdRefuseAt.q === q && wdRefuseAt.off === off) return H('slow', 429, { 'retry-after': '0' });
      const pool = wdPool[q].filter(i => !wdDrop.has(i));
      return H({ total: pool.length, jobPostings: pool.slice(off, off + 20).map(i => ({ externalPath: `/job/NY/Role_R${i}`, title: `Senior Product Manager ${i}`, locationsText: 'New York, NY', postedOn: 'Posted Today' })) });
    }
    if (url.includes('/wday/cxs/') && url.includes('/job/')) return H({ jobPostingInfo: { jobDescription: '<p>x</p>', location: 'New York, NY' } });
    if (url.includes('boards/slowco')) return slow === 'ok' ? H({ jobs: [{ id: 1, title: 'Product Manager', absolute_url: 'u', location: { name: 'New York, NY' }, updated_at: '2026-11-18T00:00:00Z', content: '' }] }) : H('slow down', 429, { 'retry-after': '7200' });
    if (url.includes('boards/dupco')) return H({ jobs: [1, 2].map(i => ({ id: i, title: 'Account Executive', absolute_url: 'u' + i, location: { name: 'New York, NY' }, requisition_id: 'REQ-' + i, updated_at: '2026-11-18T00:00:00Z', content: '' })) });
    return H('nf', 404); };
  const go = async h => { const r = await run({ fetchImpl: f, env: {}, now: new Date(NOW.getTime() + h * 36e5), dataDir: dir, argv: {}, cfgOverride: { ...FAST, workday_max_per_query: 60 } });
    return { r, S: Object.fromEntries(r.statusOut.sources.map(x => [x.id, x])), J: Object.fromEntries(r.jobsOut.jobs.map(j => [j.uid, j])) }; };
  const A = await go(0);
  t('cc: complete runs are "complete" with last_success_at; run reports no incomplete sources', () => { assert.equal(A.S['html:co'].inventory, 'complete'); assert.ok(A.S['gh:slow'].last_success_at); assert.equal(A.r.statusOut.run.incomplete_sources, 0); assert.equal(A.r.statusOut.run.selection_limited, false); });
  t('cc: workday search capped at max_results is reported and not complete', () => { assert.match(A.S['wd:co'].message, /COVERAGE: partner hit the 60-result limit/); });
  t('cc: same board, same title + city, different requisition ids = separate openings', () => { assert.ok(!A.J['gh:dup:1'].dup_count && !A.J['gh:dup:2'].dup_count); });
  // B: html page 2 fails; Workday "product manager" refused at offset 20; greenhouse asks for a 2-hour wait
  page2 = false; wdRefuseAt = { q: 'product manager', off: 20 }; slow = 'wait';
  const nB = calls.length;
  const B = await go(4);
  t('cc: html listing with a failed later page is partial, its roles stay open (stale), last_success_at unchanged', () => { assert.equal(B.S['html:co'].result, 'partial'); assert.equal(B.S['html:co'].inventory, 'partial'); assert.notEqual(B.J['html:co:102'].status, 'closed'); assert.equal(B.J['html:co:102'].stale, true); assert.equal(B.S['html:co'].last_success_at, A.S['html:co'].last_success_at); assert.ok(B.S['html:co'].last_data_at > A.S['html:co'].last_data_at); });
  t('cc: workday refusal saves the interrupted search and offset', () => { const pd = B.S['wd:co'].checkpoint.pending; assert.equal(pd.q, 'product manager'); assert.equal(pd.offset, 20); });
  t('cc: long Retry-After → no retry, next_eligible_at set', () => { assert.ok(B.S['gh:slow'].next_eligible_at > B.S['gh:slow'].checked_at); assert.equal(calls.slice(nB).filter(c => c.includes('boards/slowco')).length, 1); assert.match(B.S['gh:slow'].message, /120-minute wait/); });
  t('cc: run reports incomplete sources', () => assert.ok(B.r.statusOut.run.incomplete_sources >= 2));
  // C (+1h): greenhouse still deferred (not asked); Workday resumes "product manager" at 0 (offset 20 less one page) and finishes it
  wdRefuseAt = null; wdDrop = new Set([5]); const nC = calls.length;
  const C = await go(5);
  const cWd = calls.slice(nC).filter(c => c.includes('wdco') && c.includes('/jobs'));
  t('cc: deferred source is skipped until its time, roles kept', () => { assert.equal(C.S['gh:slow'].result, 'deferred'); assert.equal(calls.slice(nC).filter(c => c.includes('boards/slowco')).length, 0); assert.notEqual(C.J['gh:slow:1'].status, 'closed'); });
  t('cc: workday resumes the interrupted search first; pending cleared when it completes', () => { assert.ok(cWd.length >= 1); assert.equal(C.S['wd:co'].checkpoint.pending, null); });
  t('cc: the resumed scan began in the earlier run, where the role was seen, so it is not closed yet', () => assert.notEqual(C.J['wd:co:R5'].status, 'closed'));
  wdDrop.add(150);
  const D = await go(9);
  t('cc: a role missing from a search read to its end (begun after it was last seen) closes with basis complete_search', () => { assert.equal(D.J['wd:co:R5'].status, 'closed'); assert.equal(D.J['wd:co:R5'].closed_basis, 'complete_search'); });
  t('cc: capped search ("partner") drops a role: kept open', () => assert.notEqual(D.J['wd:co:R150'].status, 'closed'));
  page2 = true;
  // E: html back; F after 31 days with greenhouse still asking to wait (deferred) → unverified_expired
  const E = await go(12);
  t('cc: html recovered → complete again', () => assert.equal(E.S['html:co'].inventory, 'complete'));
  slow = 'wait';
  const F = await go(24 * 32);
  t('cc: never re-verified for 30+ days → closed as unverified_expired', () => { const j = F.J['gh:slow:1']; assert.equal(j.status, 'closed'); assert.equal(j.closed_basis, 'unverified_expired'); });
  const closedCsv = await readFile(join(dir, 'archive', '2026-12-closed.csv'), 'utf8').catch(() => '') + await readFile(join(dir, 'archive', '2026-11-closed.csv'), 'utf8').catch(() => '');
  t('cc: archive closed rows carry the basis', () => { assert.match(closedCsv, /,basis\n/); assert.match(closedCsv, /complete_search|unverified_expired/); });
}

{ // stored details are refreshed once old (relevant roles only)
  const { detailStale } = await import('../lib/adapters-server.mjs');
  const now = new Date('2026-11-21T00:00:00Z');
  t('details: relevant role read 40 days ago is due a refresh; 10 days ago is not; irrelevant never', () => {
    assert.equal(detailStale({ title: 'Senior Product Manager', details_from: '2026-10-12T00:00:00Z' }, { now }), true);
    assert.equal(detailStale({ title: 'Senior Product Manager', details_from: '2026-11-11T00:00:00Z' }, { now }), false);
    assert.equal(detailStale({ title: 'Software Engineer II', details_from: '2026-01-01T00:00:00Z' }, { now }), false); });
}

{ // a board that suddenly returns far fewer roles: closures held for one run, then confirmed
  const dir = await mkdtemp(join(tmpdir(), 'cf-drop-'));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'DropCo', type: 'security', sources: [{ id: 'gh:drop', ats: 'greenhouse', slug: 'dropco' }] }] }));
  let n = 30;
  const f = async url => url.includes('boards/dropco') ? new Response(JSON.stringify({ jobs: Array.from({ length: n }, (_, i) => ({ id: i, title: 'Product Manager ' + i, absolute_url: 'u' + i, location: { name: 'New York, NY' }, updated_at: '2026-11-18T00:00:00Z', content: '' })) }), { status: 200 }) : new Response('nf', { status: 404 });
  const go = h => run({ fetchImpl: f, env: {}, now: new Date(NOW.getTime() + h * 36e5), dataDir: dir, argv: {}, cfgOverride: FAST });
  await go(0); n = 3;
  const b = await go(4); const jb = b.jobsOut.jobs.find(j => j.uid === 'gh:drop:20');
  t('drop guard: 30 → 3 roles holds closures and raises an alert', () => { assert.notEqual(jb.status, 'closed'); assert.match(b.statusOut.sources.find(x => x.id === 'gh:drop').message, /ALERT: 3 roles vs 30/); });
  const c = await go(8); const jc = c.jobsOut.jobs.find(j => j.uid === 'gh:drop:20');
  t('drop guard: a second scan confirming the drop closes them (complete_scan)', () => { assert.equal(jc.status, 'closed'); assert.equal(jc.closed_basis, 'complete_scan'); });
}

{ // EU Greenhouse board whose API can't be reached: public board page fallback; real network error cause shown
  const dir = await mkdtemp(join(tmpdir(), 'cf-gheu-'));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'EuCo', type: 'security', sources: [{ id: 'gh:euco', ats: 'greenhouse', slug: 'euco', region: 'eu', board_url: 'https://job-boards.eu.greenhouse.io/euco' }] }] }));
  const f = async url => {
    if (url.includes('boards-api')) { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }; throw e; }
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\n', { status: 200 });
    if (url === 'https://job-boards.eu.greenhouse.io/euco') return new Response('<table><tr><td><a href="https://job-boards.eu.greenhouse.io/euco/jobs/4952570101"><p>Customer Success Manager</p><p>Remote</p></a></td></tr><tr><td><a href="/euco/jobs/4982982101"><p>Senior Security Analyst</p><p>Bucharest</p></a></td></tr></table>', { status: 200 });
    if (url.includes('/euco/jobs/4952570101')) return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Customer Success Manager', datePosted: '2026-11-18', description: '<p>Base salary $120,000 - $150,000.</p>', jobLocation: [{ address: { addressLocality: 'New York', addressRegion: 'NY', addressCountry: 'US' } }] })}</script>`, { status: 200 });
    if (url.includes('/euco/jobs/')) return new Response('<h1>Senior Security Analyst</h1><main>Location: Bucharest, Romania</main>', { status: 200 });
    return new Response('nf', { status: 404 }); };
  const r = await run({ fetchImpl: f, env: {}, now: NOW, dataDir: dir, argv: {}, cfgOverride: { ...FAST, http: { ...FAST.http, retries: 0 } } });
  const s = r.statusOut.sources.find(x => x.id === 'gh:euco'), J = Object.fromEntries(r.jobsOut.jobs.map(j => [j.uid, j]));
  t('greenhouse EU: API unreachable → public board page read, same job ids', () => { assert.equal(s.result, 'ok', s.message); assert.ok(J['gh:euco:4952570101']); assert.equal(J['gh:euco:4952570101'].salary.min, 120000); });
  t('greenhouse EU: the network error cause (ENOTFOUND) is in the note', () => assert.match(s.message, /ENOTFOUND/));
}

{ // Amazon pay: location-line ranges ("… - 169,000.00 - 228,600.00 USD annually"), NY line preferred; job page read when missing
  const C6 = await import('../../assets/shared/core.mjs');
  const aws = 'The base salary range for this position is listed below. Your Amazon package will include sign-on payments.\nUSA, CA, San Francisco - 180,000.00 - 243,300.00 USD annually\nUSA, NY, New York - 169,000.00 - 228,600.00 USD annually\nUSA, WA, Seattle - 152,000.00 - 205,700.00 USD annually';
  const s = C6.chooseSalary(C6.parseSalaries(aws));
  t('aws pay: every location line parsed as base; New York chosen', () => { assert.equal(C6.parseSalaries(aws).length, 3); assert.equal(s.min, 169000); assert.equal(s.max, 228600); assert.equal(s.kind, 'base'); });
  t('aws pay: hourly line read as hourly; dates and "million" figures ignored', () => {
    const h = C6.chooseSalary(C6.parseSalaries('The base pay range for this position is listed below. USA, TN, Nashville - 61.50 - 85.00 USD hourly')); assert.equal(h.period, 'hour');
    assert.equal(C6.parseSalaries('Revenue grew from 1,000,000 - 2,000,000 USD million').length, 0); });
  const { ADAPTERS: SA2 } = await import('../lib/adapters-server.mjs');
  const pages = [];
  const http = { json: async () => ({ ok: true, status: 200, data: { jobs: [{ id_icims: '10608735', title: 'Sr Solutions Architect, Media Enablement Team', job_path: '/en/jobs/10608735/sr-solutions-architect', normalized_location: 'New York, New York, USA', country_code: 'USA', posted_date: 'November 18, 2026', description: 'Own publisher integrations.' }] } }),
    text: async u => { pages.push(u); return { ok: true, status: 200, data: `<div>Preferred qualifications ...</div><p>The base salary range for this position is listed below.<br>USA, NY, New York - 169,000.00 - 228,600.00 USD annually</p>` }; } };
  const a = await SA2.amazon({ id: 'amazon:jobs', ats: 'amazon', queries: ['solutions architect'] }, { employer: 'Amazon / AWS' }, http, { maxPerQuery: 100, prevStatusById: new Map(), prevBySource: new Map(), now: NOW });
  const ej = C6.enrichJob(a.jobs[0]);
  t('aws pay: missing from search data → posting page read, base range found', () => { assert.equal(pages[0], 'https://www.amazon.jobs/en/jobs/10608735/sr-solutions-architect'); assert.equal(ej.salary.min, 169000); assert.ok(a.jobs[0].pay_checked_at); });
  const a2 = await SA2.amazon({ id: 'amazon:jobs', ats: 'amazon', queries: ['solutions architect'] }, { employer: 'Amazon / AWS' }, http, { maxPerQuery: 100, prevStatusById: new Map(), prevBySource: new Map([['amazon:jobs', new Map([['10608735', { ...ej, details_from: NOW.toISOString() }]])]]), now: NOW });
  t('aws pay: next run reuses the stored pay without reading the page again', () => { assert.equal(pages.length, 1); assert.equal(C6.enrichJob(a2.jobs[0]).salary.min, 169000); });
}

{ // multi-run full-list passes (AWS): closures need a pass that began at the top in a tracked run
  const { sweepCycle } = await import('../lib/adapters-server.mjs');
  const a = sweepCycle({}, { nowIso: 'T1', fromStart: false, wrapped: true, rows: 50 });
  t('sweep: pass that began before tracking is not used for closures', () => { assert.ok(!a.ck.last_full_cycle_start); assert.match(a.early, /before pass tracking/); });
  const b = sweepCycle(a.ck, { nowIso: 'T2', fromStart: true, wrapped: false, rows: 400 });
  const c = sweepCycle(b.ck, { nowIso: 'T3', fromStart: false, wrapped: true, rows: 100 });
  t('sweep: tracked pass from the top completes, start time recorded', () => { assert.equal(c.ck.last_full_cycle_start, 'T2'); assert.equal(c.ck.last_full_cycle_rows, 500); });
  const d = sweepCycle(sweepCycle(c.ck, { nowIso: 'T4', fromStart: true, wrapped: false, rows: 100 }).ck, { nowIso: 'T5', fromStart: false, wrapped: true, rows: 50 });
  t('sweep: a pass far shorter than the last one is not trusted', () => { assert.equal(d.ck.last_full_cycle_start, 'T2'); assert.match(d.early, /ended early/); });
}

{ // HTTP: a long Retry-After isn't waited out; the shared slot is released during backoff
  const { Http: HttpClient } = await import('../lib/http.mjs');
  let n = 0;
  const h = new HttpClient({ minDelay: 1, maxDelay: 2, concurrency: 1, retries: 2, fetchImpl: async u => { n++; return new Response('x', { status: 429, headers: { 'retry-after': u.includes('long') ? '3600' : '0' } }); } });
  const r = await h.json('https://a.example/long');
  t('http: Retry-After 3600 → one request, defer flag, retryAfterMs', () => { assert.equal(n, 1); assert.equal(r.defer, true); assert.equal(r.retryAfterMs, 3600000); });
  const order = [];
  const h2 = new HttpClient({ minDelay: 1, maxDelay: 2, concurrency: 1, retries: 1, fetchImpl: async u => { order.push(u); return u.includes('slow') && order.filter(x => x.includes('slow')).length === 1 ? new Response('x', { status: 503, headers: { 'retry-after': '0.3' } }) : new Response('{}', { status: 200 }); } });
  const p1 = h2.json('https://slow.example/a'); await new Promise(r => setTimeout(r, 30)); const p2 = h2.json('https://fast.example/b');
  await Promise.all([p1, p2]);
  t('http: another host gets the slot while one host waits to retry', () => assert.deepEqual(order.map(u => new URL(u).host), ['slow.example', 'fast.example', 'slow.example']));
}

{ // roles no category recognizes are stored as "Other roles" (off by default), never silently dropped
  const C5 = await import('../../assets/shared/core.mjs');
  t('other: unrecognized title → "other"; recognized title never gets it', () => { assert.deepEqual(C5.classifyFunctions('Executive Business Administrator').functions, ['other']); assert.ok(!C5.classifyFunctions('Strategic Initiatives Lead').functions.includes('other')); });
  t('other: broad, so off by default and not "relevant" for detail reads', () => { assert.ok(C5.FUNCTIONS.other.broad); assert.ok(!C5.DEFAULT_FUNCTIONS.includes('other')); });
  t('audit: Business Planner / Initiatives Manager → strategy; Global Black Belt / Industry Executive → sales', () => { assert.ok(C5.classifyFunctions('Senior Business Planner').functions.includes('strategy')); assert.ok(C5.classifyFunctions('Initiatives Manager').functions.includes('strategy')); assert.ok(C5.classifyFunctions('Global Black Belt').functions.includes('sales')); assert.ok(C5.classifyFunctions('Industry Executive').functions.includes('sales')); });
}

{ // Google: master US list walked from a checkpoint; overlap; schema check; closures only after a complete clean pass
  const SA = (await import('../lib/adapters-server.mjs')).ADAPTERS;
  const emp = { employer: 'Google' };
  const rec = (id, title, loc = 'New York, NY, USA') => [String(id), title, 'u', [null, '<p>Do things.</p>'], null, null, null, 'Google', 'en-US', [[loc, [loc]]], [1763500000, 0]];
  const pageOf = recs => `<script>AF_initDataCallback({key: 'ds:1', data:[[${recs.map(r => JSON.stringify(r)).join(',')}],null,45]});</script>`;
  const all = Array.from({ length: 45 }, (_, k) => rec(8000000000 + k, `Role number ${k}`));
  let broken = false; const calls = [];
  const http = { text: async u => { calls.push(u); const q = new URL(u).searchParams, pg = +q.get('page');
    if (q.get('q')) return { ok: true, status: 200, data: pageOf([rec(9000000000, 'Threat Intelligence Lead')]) };
    let recs = all.slice((pg - 1) * 20, pg * 20);
    if (broken && pg === 2) recs = recs.map(r => ['x', r[1]]).concat([[ '1234567890123', '<b>bad</b>' ]]);
    return { ok: true, status: 200, data: pageOf(recs) }; } };
  const src = { id: 'google:careers', ats: 'google_careers', queries: ['threat'], max_pages: 1, full_scan: true, scan_pages_per_run: 2 };
  const g1 = await SA.google_careers(src, emp, http, { prevStatusById: new Map() });
  t('google list: 2 pages, checkpoint at page 3, no closures yet', () => { assert.equal(g1.checkpoint.list.page, 3); assert.equal(g1.close_before, null); assert.equal(g1.jobs.length, 41); });
  const n2 = calls.length;
  const g2 = await SA.google_careers(src, emp, http, { prevStatusById: new Map([['google:careers', { checkpoint: g1.checkpoint }]]) });
  t('google list: resumes one page back (overlap), reaches the end, pass complete → close_before set', () => { assert.ok(/page=2/.test(calls[n2]) && !/q=/.test(calls[n2]), calls[n2]); assert.ok(g2.close_before); assert.equal(g2.checkpoint.list.page, 1); assert.match(g2.note, /pass complete/); });
  t('google: total from the page block reported', () => assert.match(g2.note, /page reports 45 US roles/));
  t('google: schema check reported', () => assert.match(g2.note, /parser check: \d+ records, 0 failed/));
  broken = true;
  const g3 = await SA.google_careers({ ...src, scan_pages_per_run: 5 }, emp, http, { prevStatusById: new Map([['google:careers', { checkpoint: g2.checkpoint }]]) });
  t('google: a page that mostly fails the schema taints the pass (no new close_before), result partial', () => { assert.equal(g3.close_before, g2.close_before); assert.equal(g3.result, 'partial'); assert.match(g3.note, /ended early|mostly unreadable/); });
  t('google: invalid records are not stored', () => assert.ok(!g3.jobs.some(j => /<b>/.test(j.title))));
  const { googleValid } = await import('../lib/adapters-server.mjs');
  t('google validator: id, plain title, location strings', () => { assert.ok(googleValid({ id: '1234567890', title: 'Product Lead', locations: ['NY'] }).ok); assert.deepEqual(googleValid({ id: '12', title: '<b>x</b>', locations: [1] }).why, ['id', 'title', 'locations']); });
}

{ // pay in other currencies and non-salary amounts never count as US base pay
  const C4 = await import('../../assets/shared/core.mjs');
  const pick = s => C4.chooseSalary(C4.parseSalaries(s))?.min ?? null;
  t('salary: peso range written as "$… MXN" is skipped', () => assert.equal(pick('The typical base salary range for this position is $912,000 - $1,254,000 MXN annually.'), null));
  t('salary: US range kept when a peso range is also listed', () => assert.equal(pick('US: base salary range $150,000 - $190,000. Mexico: $912,000 - $1,254,000 MXN.'), 150000));
  t('salary: CA$ / A$ ranges skipped, "USD" kept', () => { assert.equal(pick('Base salary CA$140,000 - CA$170,000'), null); assert.equal(pick('Salary A$150,000 - $180,000'), null); assert.equal(pick('Base salary $150,000 - $200,000 USD per year'), 150000); });
  t('salary: $5M grant or EUR structured pay is not base salary', () => { assert.equal(C4.chooseSalary([], { min: 5e6, max: 5e6, kind: 'base' }), null); assert.equal(C4.chooseSalary([], { min: 9e4, max: 12e4, kind: 'base', currency: 'EUR' }), null); });
}

{ // seed probe: boards found from company sites or guessed names, kept only with ownership evidence
  const SD = await import('../lib/seeds.mjs');
  t('seeds: slug guesses from name and domain', () => { const g = SD.guessSlugs({ name: 'Credal.ai', website: 'https://www.credal.ai' }); assert.ok(g.includes('credalai')); assert.ok(g.includes('credal')); });
  t('seeds: identity — domain in postings passes, unrelated same-name board fails', () => {
    assert.equal(SD.identityCheck({ name: 'Castle', website: 'https://castle.io' }, { jobs: 3, name: null, texts: ['Engineer at castle.io'] }, false).ok, true);
    assert.equal(SD.identityCheck({ name: 'Castle', website: 'https://castle.io' }, { jobs: 3, name: null, texts: ['Join our roofing crew'] }, false).ok, false);
    assert.equal(SD.identityCheck({ name: 'Infisical', website: 'https://infisical.com' }, { jobs: 2, name: null, texts: ['At Infisical we build secrets management'] }, false).ok, true);
  });
  const calls = [];
  const resp = (b, st = 200) => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status: st });
  const f = async url => { calls.push(url);
    if (url === 'https://alpha.example/robots.txt') return resp('User-agent: *\nDisallow: /admin');
    if (url === 'https://alpha.example/') return resp('<a href="https://jobs.ashbyhq.com/alpha-sec">Careers</a>');
    if (url.includes('job-board/alpha-sec')) return resp({ jobs: [{ title: 'Director of Product', jobUrl: 'https://jobs.ashbyhq.com/alpha-sec/1', descriptionPlain: 'x' }] });
    if (url.startsWith('https://beta.example')) return resp('nf', 404);
    if (url.includes('job-board/beta')) return resp({ jobs: [{ title: 'PM', jobUrl: 'u', descriptionPlain: 'Beta is hiring; see beta.example' }] });
    if (url.includes('boards/gamma/jobs')) return resp({ name: 'Gamma Roofing LLC', jobs: [{ title: 'Roofer', absolute_url: 'u', content: 'Roofing work' }] });
    if (url.startsWith('https://gamma.example')) return resp('nf', 404);
    return resp('nf', 404); };
  const { Http } = await import('../lib/http.mjs').catch(() => ({}));
  const http = Http ? new Http({ minDelay: 0, maxDelay: 1, retries: 0, fetchImpl: f, log: () => {} }) : { json: async u => { const r = await f(u); return r.ok ? { ok: true, data: await r.json() } : { ok: false, status: r.status }; }, text: async u => { const r = await f(u); return r.ok ? { ok: true, data: await r.text() } : { ok: false, status: r.status }; } };
  const seeds = { seeds: [{ name: 'Alpha', website: 'https://alpha.example', size: 20, sector: 'Cybersecurity', source: 'yc' }, { name: 'Beta', website: 'https://beta.example', size: 120, source: 'yc' }, { name: 'Gamma', website: 'https://gamma.example', size: 8, source: 'yc' }, { name: 'Known Co', known: true }] };
  const discovered = { employers: [] }, state = {};
  const res = await SD.seedProbe({ seeds, discovered, state, http, now: NOW, batch: 10 });
  const by = Object.fromEntries(discovered.employers.map(e => [e.employer, e]));
  t('seeds: board linked from the company site is accepted', () => { assert.equal(by.Alpha.sources[0].id, 'ashby:alphasec'); assert.equal(by.Alpha.size, 20); assert.match(by.Alpha.sources[0].verification.method, /linked from alpha\.example/); });
  t('seeds: guessed board accepted when postings mention the domain', () => assert.equal(by.Beta?.sources[0].ats, 'ashby'));
  t('seeds: same-named board for another company rejected; known seeds skipped', () => { assert.ok(!by.Gamma); assert.equal(res.done, 3); assert.match(state.checked.gamma.tried.join(' '), /rejected/); });
}

{ // Canada-first postings with CAD-only pay are not US roles, even when "United States" is also listed
  const C5 = await import('../../assets/shared/core.mjs');
  const raw = { source_id: 'gh:tailscale', ext_id: '4756305005', ats: 'greenhouse', employer: 'Tailscale', title: 'Senior Business Operations & Strategy Manager', url: 'u',
    locations: ['Remote (Canada)', 'Canada', 'United States'], desc_text: 'Individual offers may vary. CAN Pay Range $166,160 — $241,200 CAD What We Offer' };
  const j = C5.enrichJob(raw);
  t('location: Remote (Canada) + CAD-only pay → not a US role, no base salary', () => { assert.equal(j.us, false); assert.equal(j.salary, null); });
  const j2 = C5.enrichJob({ ...raw, desc_text: 'US Pay Range $180,000 — $250,000 USD. CAN Pay Range $166,160 — $241,200 CAD' });
  t('location: same posting with a US range stays a US role', () => { assert.notEqual(j2.us, false); assert.equal(j2.salary.min, 180000); });
  const stored = { ...j, us: true, remote_us: true, salary: { min: 166160, max: 241200, kind: 'base', snippet: 'CAN Pay Range $166,160 — $241,200 CAD What' }, functions: ['strategy'], seniority: 3, status: 'open' };
  t('location: already-stored Canada/CAD posting is dropped from matches', () => assert.equal(C5.evaluateJob(stored, { crit: { functions: ['strategy'], salMode: 'any', lMetro: true, lRemoteYes: true, lRemoteUnknown: true, lOther: true } }), null));
}

{ // the location shown is the one that matched, not just the first listed
  const C6 = await import('../../assets/shared/core.mjs');
  const job = { locations: ['San Francisco, CA, USA', 'New York, NY, USA'], remote_us: false };
  const fit = C6.homeFit(job, { metro: 'new york|brooklyn|jersey city', state: 'NY' });
  t('location: SF + NY role shows New York when NY is the commute match', () => { assert.equal(fit.metro_loc, 'New York, NY, USA'); const s = C6.shownLocation(job, fit, 'metro'); assert.equal(s.text, 'New York, NY, USA'); assert.equal(s.more, 1); });
  t('location: non-US first location skipped for display', () => assert.equal(C6.shownLocation({ locations: ['London, UK', 'Austin, TX'] }, {}, 'other').text, 'Austin, TX'));
}
{
  const C7 = await import('../../assets/shared/core.mjs');
  const ids = C7.SKILLS.map(s => s.id);
  t('skills: ids unique', () => assert.equal(new Set(ids).size, ids.length));
  t('skills: cyber + GTM breadth', () => { const k = C7.extractSkills('Partner marketing with MSSPs and GSIs; FedRAMP; detection engineering; MEDDICC; AWS Marketplace private offers; RSAC sponsorship'); for (const x of ['Partner marketing', 'MSSP / MSP partners', 'GSI & consulting partners', 'FedRAMP, CMMC & public sector', 'Detection engineering', 'Sales methodology (MEDDICC, Challenger)', 'Cloud marketplace & private offers', 'Field & event marketing']) assert.ok(k.includes(x), x); });
  t('skills: employer name not tagged as vendor skill', () => { assert.ok(!C7.jobSkills('Cloudflare, Inc.', 'Join Cloudflare to sell network security').includes('Zscaler / Netskope / Cloudflare')); assert.ok(C7.jobSkills('Acme', 'Experience with Cloudflare and Zscaler').includes('Zscaler / Netskope / Cloudflare')); });
  t('skills: EEO boilerplate is not a public-sector or fraud signal', () => { const k = C7.extractSkills('We comply with federal, state and local laws. Beware of recruitment fraud. Read our privacy policy.'); for (const x of ['Public sector & federal', 'Fraud & trust and safety', 'Privacy']) assert.ok(!k.includes(x), x); });
}
{
  const C8 = await import('../../assets/shared/core.mjs');
  t('functions: counsel is legal only', () => { assert.deepEqual(C8.classifyFunctions('Senior Product Counsel - HR Products').functions, ['legal']); assert.deepEqual(C8.classifyFunctions('Commercial Counsel - US Sales').functions, ['legal']); });
  t('functions: senior product designer/security are not PM', () => { assert.ok(!C8.classifyFunctions('Senior Product Designer').functions.includes('product')); assert.ok(!C8.classifyFunctions('Staff Product Security Engineer').functions.includes('product')); assert.ok(C8.classifyFunctions('Sr Product Mgr, Identity').functions.includes('product')); });
}
{
  const C9 = await import('../../assets/shared/core.mjs');
  t('functions: ML engineer is mleng, AI strategy stays ai', () => { assert.deepEqual(C9.classifyFunctions('Staff Machine Learning Engineer, Homefeed & Search Quality').functions, ['mleng']); assert.ok(C9.classifyFunctions('Director, AI Go-to-Market').functions.includes('ai')); assert.ok(C9.classifyFunctions('AI Solutions Engineer').functions.includes('ai')); });
  t('location: remote tied to an out-of-state city is not remote', () => { const f = C9.homeFit({ remote_us: true, locations: ['Santa Clara, California, United States'], excerpt: 'Work Personas: flexible or remote' }, { metro: 'new york', state: 'NY' }); assert.equal(f.tied, true); });
  t('location: remote anywhere in the US is not tied', () => { const f = C9.homeFit({ remote_us: true, locations: ['San Francisco, CA, US; Remote, US'] }, { metro: 'new york', state: 'NY' }); assert.equal(f.tied, false); const g = C9.homeFit({ remote_us: true, locations: ['Austin, TX'], excerpt: 'This role can be based anywhere in the US.' }, { state: 'NY' }); assert.equal(g.tied, false); });
  t('location: tied role in the home state still matches', () => { const f = C9.homeFit({ remote_us: true, locations: ['New York, New York, United States'] }, { metro: 'new york', state: 'NY' }); assert.equal(f.tied, false); assert.equal(f.in_metro, true); });
}
{
  const L = await import('../../assets/shared/core.mjs'); const home = { metro: 'new york|nyc|pelham', state: 'NY' };
  const fit = j => L.homeFit({ remote_us: true, ...j }, home);
  t('location: foreign-only remote is not US', () => { assert.equal(fit({ title: 'PM', locations: ['Costa Rica, Remote'] }).foreign, true); assert.equal(fit({ title: 'PM', locations: ['Remote - Canada', 'Remote - U.S.'] }).foreign, false); });
  t('location: remote limited to other states is tied', () => { assert.equal(fit({ title: 'SE', locations: ['REMCO - Remote Colorado', 'REMTX - Remote Texas'] }).tied, true); assert.equal(fit({ title: 'PM', locations: ['Remote - New York'] }).tied, false); });
  t('location: territory in the title', () => { assert.equal(fit({ title: 'Senior Customer Engineer, Named - LA', locations: ['Distributed', 'Los Angeles, CA'] }).tied, true); assert.equal(fit({ title: 'Account Executive - East', locations: ['Remote'] }).tied, false); assert.equal(fit({ title: 'Enterprise AE - Central', locations: ['Remote, US'] }).tied, true); });
  t('location: combined "City; Remote, USA" stays open remote', () => assert.equal(fit({ title: 'Finance Manager', locations: ['Palo Alto, California; Remote, USA'] }).tied, false));
  t('functions: strategic finance is finance, not strategy', () => { assert.deepEqual(L.classifyFunctions('Senior Strategic Finance Manager').functions, ['finance']); assert.ok(L.classifyFunctions('Senior Manager, Strategy & Operations').functions.includes('strategy')); assert.ok(!L.classifyFunctions('Content Strategist').functions.includes('strategy')); });
}
{
  const P = await import('../../assets/shared/core.mjs');
  t('location: whole-state search location matches in-office roles there', () => { const j = { title: 'PM', locations: ['Austin, TX'] }; assert.equal(P.homeFit(j, { metro: 'new york', state: 'NY', states: ['TX'] }).in_metro, true); assert.equal(P.homeFit(j, { metro: 'new york', state: 'NY' }).in_metro, false); });
  t('location: territory in a searched state is not tied', () => assert.equal(P.homeFit({ remote_us: true, title: 'Enterprise AE - Texas', locations: ['Remote, US'] }, { state: 'NY', states: ['TX'] }).tied, false));
}
{
  const Q = await import('../../assets/shared/core.mjs');
  const job = (min, max) => ({ uid: 'x', status: 'open', us: true, title: 'Director, Product Marketing', employer: 'Acme', locations: ['New York, NY'], salary: { min, max, kind: 'base', period: 'year' }, functions: ['pmm'], seniority: 5, posted_at: new Date().toISOString(), posted_kind: 'first_published' });
  const crit = { functions: ['pmm'], minBase: 200000, maxBase: 300000, salMode: 'starts_reaches', window: 'all', metro: 'new york', state: 'NY', lMetro: true, types: {}, sectors: [], verticals: [], blockEmp: [], sen: 2 };
  t('pay: top-of-range filter keeps 200-420K, drops 200-220K', () => { assert.ok(Q.evaluateJob(job(200000, 420000), { crit })); assert.equal(Q.evaluateJob(job(200000, 220000), { crit }), null); });
  t('pay: baseTop ignores OTE-only', () => { assert.equal(Q.baseTop({ min: 150000, max: 300000, kind: 'ote_only' }), null); assert.equal(Q.baseTop({ min: 210000, max: null, kind: 'base' }), 210000); });
}
{
  const S0 = await import('../../assets/shared/core.mjs');
  const jb = sen => ({ uid: 'y', status: 'open', us: true, title: 'Product Marketing Manager', employer: 'Acme', locations: ['New York, NY'], salary: null, functions: ['pmm'], seniority: sen, posted_at: new Date().toISOString(), posted_kind: 'first_published' });
  const cr = sen => ({ functions: ['pmm'], minBase: 0, salMode: 'any', window: 'all', metro: 'new york', state: 'NY', lMetro: true, types: {}, sectors: [], verticals: [], blockEmp: [], sen });
  t('seniority: optional (0 = any level)', () => { assert.equal(S0.evaluateJob(jb(2), { crit: cr(4) }), null); assert.ok(S0.evaluateJob(jb(2), { crit: cr(0) })); assert.equal(S0.evaluateJob(jb(2), { crit: cr(0) }).parts.level ?? 10, 10); });
}
{
  const M = await import('../../assets/shared/core.mjs');
  const rj = { uid: 'r', status: 'open', us: true, remote_us: true, title: 'Director, Product Marketing', employer: 'Acme', locations: ['Remote - New Jersey', 'Remote - Texas'], elig_text: null, salary: null, functions: ['pmm'], seniority: 5, posted_at: new Date().toISOString(), posted_kind: 'first_published' };
  const cr = rs => ({ functions: ['pmm'], minBase: 0, maxBase: 0, salMode: 'any', window: 'all', metro: '', state: 'NY', remoteStates: rs, lMetro: false, lRemoteYes: rs.length > 0, lRemoteUnknown: false, lOther: false, types: {}, sectors: [], verticals: [], blockEmp: [], sen: 0 });
  t('location: "open to candidates in <states>" is a state list', () => { const f = st => M.homeFit({ remote_us: true, title: 'PM', locations: ['Remote - US'], elig_text: 'This role is open to candidates in New Jersey, Texas and California.' }, { state: st }).eligibility; assert.equal(f('NJ'), 'yes'); assert.equal(f('NY'), 'no'); });
  t('location: combined entry with a foreign city still matches the metro', () => assert.equal(M.homeFit({ title: 'PM', locations: ['Denver, CO - Hybrid; New York, NY - Hybrid; Toronto, Ontario - Remote'] }, { metro: 'new york|nyc', state: 'NY' }).in_metro, true));
  t('location: remote eligibility checks every chosen state', () => { assert.equal(M.evaluateJob(rj, { crit: cr(['NY']) }), null); assert.equal(M.evaluateJob(rj, { crit: cr(['NY', 'NJ']) })?.loc, 'remote_yes'); });
}
{
  const U = await import('../../assets/shared/core.mjs');
  const uj = (title, locs) => ({ uid: 'u', status: 'open', us: true, remote_us: false, workplace: 'onsite', title, employer: 'Acme', locations: locs, salary: null, functions: ['sales'], seniority: 4, posted_at: new Date().toISOString(), posted_kind: 'first_published' });
  const ucr = extra => ({ functions: ['sales'], minBase: 0, maxBase: 0, salMode: 'any', window: 'all', metro: 'new york|nyc', state: 'NY', remoteStates: ['NY'], lMetro: true, lRemoteYes: true, lRemoteUnknown: false, lOther: false, types: {}, sectors: [], verticals: [], blockEmp: [], sen: 0, ...extra });
  t('location: bare "United States" is its own bucket', () => { assert.equal(U.evaluateJob(uj('Enterprise Account Executive', ['United States']), { crit: ucr() }), null); assert.equal(U.evaluateJob(uj('Enterprise Account Executive', ['United States']), { crit: ucr({ lUnlisted: true }) })?.loc, 'unlisted'); });
  t('location: bare US with a city in the title matches the metro', () => assert.equal(U.evaluateJob(uj('Account Executive (San Francisco, Chicago, New York)', ['United States']), { crit: ucr() })?.loc, 'metro'));
  t('location: bare US with (Remote) in the title is remote', () => assert.equal(U.evaluateJob(uj('Enterprise Account Executive (Remote)', ['USA']), { crit: ucr({ lRemoteUnknown: true }) })?.loc, 'remote_unknown'));
}
{
  const O = await import('../../assets/shared/core.mjs');
  const oj = (locs, remote) => ({ uid: 'o', status: 'open', us: true, remote_us: remote, title: 'Director, Product Marketing', employer: 'Acme', locations: locs, salary: null, functions: ['pmm'], seniority: 5, posted_at: new Date().toISOString(), posted_kind: 'first_published' });
  const oc = { functions: ['pmm'], minBase: 0, maxBase: 0, salMode: 'any', window: 'all', metro: 'new york', state: 'NY', remoteStates: ['NY'], lMetro: true, lRemoteYes: true, lRemoteUnknown: true, lOther: false, types: {}, sectors: [], verticals: [], blockEmp: [], sen: 0 };
  t('location: every selected location earns the same score (OR, no discount)', () => { const a = O.evaluateJob(oj(['New York, NY'], false), { crit: oc }), b = O.evaluateJob(oj(['Remote - US'], true), { crit: oc }); assert.equal(a.parts.loc, 15); assert.equal(b.parts.loc, 15); });
}
{
  const H = await import('../../assets/shared/core.mjs');
  t('functions: HR partner roles for GTM/security orgs are People only', () => { for (const x of ['HRBP, GTM', 'People Partner, Sales', 'Talent Acquisition Partner, GTM', 'Sr HR Business Partner, Agentic AI']) assert.deepEqual(H.classifyFunctions(x).functions, ['people'], x); assert.ok(H.classifyFunctions('Principal Product Manager, HR Experiences').functions.includes('product')); assert.ok(H.classifyFunctions('Sales Compensation Analyst').functions.includes('sales')); });
}
{
  const W = await import('../../assets/shared/core.mjs'); const now = new Date('2026-11-20T15:00:00Z');
  t('window: custom range, open ends and swapped dates', () => {
    assert.deepEqual([W.windowFor('custom', now, 'America/New_York', '2026-10-01', '2026-10-31').start, W.windowFor('custom', now, 'America/New_York', '2026-10-01', '2026-10-31').end], ['2026-10-01', '2026-10-31']);
    assert.equal(W.windowFor('custom', now, 'America/New_York', '2026-11-01', '').end, '2026-11-20');
    assert.equal(W.windowFor('custom', now, 'America/New_York', '', '2026-11-01').start, '2000-01-01');
    assert.equal(W.windowFor('custom', now, 'America/New_York', '2026-11-10', '2026-11-01').start, '2026-11-01');
    assert.equal(W.windowFor('d90', now).start, '2026-08-23');
  });
}
t('functions: legal-team titles are legal, not partnerships; selling to legal stays sales', () => {
  const f = x => classifyFunctions(x).functions;
  assert.deepEqual(f('Legal, Partnerships'), ['legal']); assert.deepEqual(f('Head of Legal'), ['legal']); assert.deepEqual(f('Legal Operations Manager'), ['legal']);
  assert.ok(f('Account Executive, Legal').includes('sales')); assert.deepEqual(f('Strategic Partnerships Lead'), ['partner']);
  assert.deepEqual(f('Vice President, Total Rewards'), ['people']);
});
t('functions: analyst-firm research roles land in market intelligence; finance analysts do not', () => {
  const f = x => classifyFunctions(x).functions;
  assert.ok(f('Senior Analyst, Security & Risk').includes('ci')); assert.ok(f('Research Director, Security').includes('ci'));
  assert.ok(f('Analyst Relations Manager').includes('ci')); assert.ok(!f('Senior Analyst, Finance').includes('ci'));
});
{
  const D = JSON.parse(await readFile(new URL('../../data/sources.json', import.meta.url), 'utf8'));
  t('sources: consulting & analyst firms present, every source has an id, ats and verification note', () => {
    const by = Object.fromEntries(D.employers.map(e => [e.id, e]));
    for (const id of ['adobe', 'nvidia', 'broadcom', 'atlassian', 'zoom', 'apple', 'meta', 'workday-inc', 'gartner', 'forrester', 'idc', 'ians-research', 'deloitte', 'pwc', 'ey', 'kpmg', 'accenture', 'booz-allen', 'guidehouse', 'protiviti', 'bcg', 'bain', 'mckinsey']) assert.ok(by[id], id);
    assert.equal(by.sophos.sources[0].ats, 'ashby');
    const ids = new Set(); for (const e of D.employers) for (const s of e.sources || []) { assert.ok(s.id && s.ats && s.verification?.method, s.id); assert.ok(!ids.has(s.id), 'duplicate ' + s.id); ids.add(s.id); }
  });
}
{ // rotating full sweeps: AWS, Oracle, Google
  const { ADAPTERS: SA } = await import('../lib/adapters-server.mjs');
  const emp = { employer: 'X' };
  const mk = handler => ({ json: async (u, o) => handler(u, o), text: async (u, o) => handler(u, o) });
  // AWS: 250 US postings, 100 per page
  const az = Array.from({ length: 250 }, (_, k) => ({ id_icims: String(5000 + k), title: 'Role ' + k, normalized_location: 'Seattle, Washington, USA', country_code: 'USA', job_path: '/en/jobs/' + k }));
  const hAz = u => { const q = new URL(u).searchParams; const off = +q.get('offset'); const base = q.get('base_query');
    const pool = base ? az.slice(0, 3) : az; return { ok: true, status: 200, data: { jobs: base && off ? [] : pool.slice(off, off + 100) } }; };
  const src = { id: 'amazon:jobs', ats: 'amazon', queries: ['pm'], full_scan: true, scan_pages_per_run: 2 };
  const a1 = await SA.amazon(src, emp, mk(hAz), { maxPerQuery: 200, prevStatusById: new Map() });
  const a2 = await SA.amazon(src, emp, mk(hAz), { maxPerQuery: 200, prevStatusById: new Map([['amazon:jobs', { resume_offset: a1.resume_offset }]]) });
  t('aws full sweep: 2 pages then resume at 200; next run reads the rest and wraps to 0', () => {
    assert.equal(a1.resume_offset, 200); assert.equal(a1.jobs.length, 200); assert.ok(a1.rotated);
    assert.equal(a2.resume_offset, 0); assert.ok(a2.jobs.some(j => j.ext_id === '5249')); });
  const a3 = await SA.amazon(src, emp, mk(u => new URL(u).searchParams.get('base_query') ? hAz(u) : { ok: false, status: 429 }), { maxPerQuery: 200, prevStatusById: new Map([['amazon:jobs', { resume_offset: 100 }]]) });
  t('aws full sweep refused: partial, resume point kept', () => { assert.equal(a3.result, 'partial'); assert.equal(a3.resume_offset, 100); });
  // Oracle: 120 requisitions worldwide, 50 per page; every third outside the US
  const reqs = Array.from({ length: 120 }, (_, k) => ({ Id: 9000 + k, Title: 'Req ' + k, PrimaryLocation: k % 3 ? 'Austin, TX, United States' : 'Bangalore, India', PrimaryLocationCountry: k % 3 ? 'US' : 'IN', PostedDate: '2026-11-18' }));
  const hOr = u => { if (u.includes('recruitingCEJobRequisitionDetails')) return { ok: true, data: { items: [] } };
    const f = decodeURIComponent(new URL(u).searchParams.get('finder')); const off = +f.match(/offset=(\d+)/)[1]; const kw = /keyword=/.test(f);
    const pool = kw ? reqs.slice(0, 70) : reqs; return { ok: true, status: 200, data: { items: [{ TotalJobsCount: pool.length, requisitionList: pool.slice(off, off + 50) }] } }; };
  const o = await SA.oracle_hcm({ id: 'orc:x', host: 'h', site: 'S', queries: ['pm'], full_scan: true, scan_pages_per_run: 5 }, emp, mk(hOr), { maxPerQuery: 200, detailCap: 0, prevStatusById: new Map() });
  t('oracle: searches page past 50, full list reaches the end, non-US skipped', () => {
    assert.equal(o.resume_offset, 0); assert.equal(o.jobs.length, 80); assert.ok(o.jobs.every(j => j.country === 'US')); assert.match(o.note, /40 outside the US skipped/); });
  // Google: full list ends on a short page and wraps to page 1
  const gPage = n => `<script>AF_initDataCallback({key: 'ds:1', data:[[${Array.from({ length: n }, (_, k) => `["${7000000000 + k}","Job ${k}"]`).join(',')}]]});</script>`;
  const calls = []; const hG = u => { calls.push(u); const pg = +new URL(u).searchParams.get('page'); return { ok: true, status: 200, data: new URL(u).searchParams.get('q') ? gPage(0) : gPage(pg < 3 ? 20 : 5) }; };
  const g = await SA.google_careers({ id: 'google:careers', queries: ['x'], max_pages: 1, full_scan: true, scan_pages_per_run: 10 }, emp, mk(hG), { prevStatusById: new Map([['google:careers', { resume_offset: 2 }]]) });
  t('google full sweep: resumes at the saved page and wraps to 1 at the end', () => { assert.ok(calls.some(c => /page=2/.test(c) && !/q=/.test(c))); assert.equal(g.resume_offset, 1); });
}
{ // Ashby: on-target earnings entered in the Salary field are not base pay
  const job = (extra, comp) => ({ id: 'a' + Math.random(), title: 'Sales Manager, Majors - East', jobUrl: 'u', location: 'New York, NY', isListed: true,
    descriptionPlain: extra, compensation: comp });
  const sal = { compensationType: 'Salary', currencyCode: 'USD', minValue: 240000, maxValue: 300000, interval: '1 YEAR' };
  const feed = { ok: true, status: 200, data: { jobs: [
    job('Great role.', { compensationTierSummary: '$240K – $300K OTE • Offers Equity', summaryComponents: [sal] }),
    job('Compensation: OTE of $240,000 - $300,000 plus equity.', { compensationTierSummary: '$240K – $300K • Offers Equity', summaryComponents: [sal] }),
    job('Base salary $150,000 - $170,000; OTE $240,000 - $300,000.', { compensationTierSummary: '$240K – $300K • Offers Equity', summaryComponents: [sal] }),
    job('Great role.', { compensationTierSummary: '$240K – $300K • Offers Equity', summaryComponents: [sal] }),
  ] } };
  const { ADAPTERS: SH, enrichJob } = await import('../../assets/shared/core.mjs');
  const out = await SH.ashby({ id: 'ashby:serval', slug: 'Serval' }, { employer: 'Serval' }, { json: async () => feed });
  const pay = out.jobs.map(r => enrichJob({ ...r, employer: 'Serval' }).salary);
  t('ashby: OTE in the summary line or description is not base; a stated base wins; plain salary stays base', () => {
    assert.equal(pay[0].kind, 'ote_only'); assert.equal(pay[1].kind, 'ote_only');
    assert.equal(pay[2].min, 150000); assert.equal(pay[2].max, 170000);
    assert.equal(pay[3].min, 240000); assert.equal(pay[3].kind, 'base');
  });
}
{
  const { payCheck } = await import('../../assets/shared/core.mjs');
  const b = (min, max) => ({ min, max, kind: 'base' }), ote = { kind: 'ote_only', min: null, max: null, ote: { min: 250000, max: 300000 } };
  t('pay: target base must fall inside the stated base range', () => {
    const c = { targetBase: 200000 };
    assert.ok(payCheck(b(180000, 240000), c).ok); assert.ok(!payCheck(b(220000, 260000), c).ok); assert.ok(!payCheck(b(150000, 190000), c).ok);
    assert.ok(payCheck(b(200000, 200000), c).ok); assert.ok(payCheck(b(210000, 210000), c).ok); assert.ok(!payCheck(b(190000, 190000), c).ok);
  });
  t('pay: no-pay and OTE-only roles are separate opt-ins; bars combine', () => {
    assert.ok(!payCheck(null, { targetBase: 200000 }).ok); assert.ok(payCheck(null, { targetBase: 200000, payNoComp: true }).ok);
    assert.ok(!payCheck(ote, { targetBase: 200000, payNoComp: true }).ok); assert.ok(payCheck(ote, { targetBase: 200000, payOte: true }).ok);
    assert.ok(!payCheck(b(180000, 240000), { targetBase: 200000, maxBase: 250000 }).ok);
    assert.ok(payCheck(b(180000, 260000), { targetBase: 200000, maxBase: 250000 }).ok);
    assert.ok(payCheck(null, {}).ok); assert.ok(payCheck(ote, {}).ok);
  });
  t('pay: older saved rules still behave the same', () => {
    assert.ok(payCheck(null, { minBase: 150000, salMode: 'starts_unknown' }).ok); assert.ok(payCheck(ote, { minBase: 150000, salMode: 'starts_unknown' }).ok);
    assert.ok(!payCheck(null, { minBase: 150000, salMode: 'starts' }).ok);
    assert.ok(payCheck(b(120000, 180000), { minBase: 150000, salMode: 'starts_reaches' }).ok); assert.ok(!payCheck(b(120000, 180000), { minBase: 150000, salMode: 'starts' }).ok);
  });
}
{ // shared Workday queue: boards on different hosts never overlap
  const { Http } = await import('../lib/http.mjs');
  let active = 0, peak = 0, other = 0;
  const fetchImpl = async u => { const wd = /myworkdayjobs/.test(u); if (wd) { active++; peak = Math.max(peak, active); } else other++;
    await new Promise(r => setTimeout(r, 15)); if (wd) active--; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const h = new Http({ fetchImpl, concurrency: 6, minDelay: 1, maxDelay: 2, hostRules: [{ suffix: 'myworkdayjobs.com', group: 'workday', minDelayMs: 1, maxDelayMs: 2 }] });
  await Promise.all(['a.wd1', 'b.wd5', 'c.wd103', 'a.wd1'].map(x => h.json(`https://${x}.myworkdayjobs.com/x`)).concat([h.json('https://boards-api.greenhouse.io/x')]));
  t('http: all Workday boards share one queue (one request at a time), other hosts unaffected', () => { assert.equal(peak, 1); assert.equal(other, 1); });
}
{ // market archive
  const { archiveRun } = await import('../archive.mjs');
  const { gunzipSync } = await import('node:zlib');
  const { readdir: rd } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'cf-arch-'));
  const reg = { employers: [{ employer: 'Acme', sector: 'Cybersecurity', type: 'security', sources: [{ id: 'gh:acme' }] }] };
  const J = (uid, first, extra = {}) => ({ uid, source_id: 'gh:acme', ats: 'greenhouse', employer: 'Acme', title: 'PMM, "Cloud"', locations: ['New York, NY'], functions: ['pmm'],
    salary: { min: 180000, max: 220000, kind: 'base' }, kw: ['siem', 'xdr'], first_observed: first, status: 'open', url: 'https://x/' + uid,
    excerpt: 'About Acme\nAcme is a leading security company.\nAbout the role\nYou will own positioning for our cloud detection products, partnering with product and sales.', ...extra });
  const r1 = await archiveRun({ dataDir: dir, nowIso: '2026-11-21T20:00:00.000Z', registry: reg,
    jobs: [J('gh:acme:1', '2026-10-30T10:00:00.000Z'), J('gh:acme:2', '2026-11-20T10:00:00.000Z', { status: 'closed', closed_at: '2026-11-21T01:00:00.000Z' })] });
  const files1 = (await rd(join(dir, 'archive'))).sort();
  const nov = await readFile(join(dir, 'archive', '2026-11-postings.csv'), 'utf8');
  const oct = gunzipSync(await readFile(join(dir, 'archive', '2026-10-postings.csv.gz'))).toString();
  const r2 = await archiveRun({ dataDir: dir, nowIso: '2026-11-22T15:00:00.000Z', registry: reg,
    jobs: [J('gh:acme:1', '2026-10-30T10:00:00.000Z', { status: 'closed', closed_at: '2026-11-22T15:00:00.000Z' }), J('gh:acme:3', '2026-11-22T15:00:00.000Z', { excerpt: null, _blurb: 'Fresh summary.' })] });
  const nov2 = await readFile(join(dir, 'archive', '2026-11-postings.csv'), 'utf8');
  const closed2 = await readFile(join(dir, 'archive', '2026-11-closed.csv'), 'utf8');
  const r3 = await archiveRun({ dataDir: dir, nowIso: '2026-12-01T11:00:00.000Z', registry: reg, jobs: [] });
  const files3 = (await rd(join(dir, 'archive'))).sort();
  t('archive: first run backfills by month (past months compressed), summary skips company boilerplate', () => {
    assert.equal(r1.backfilled, 3); assert.deepEqual(files1, ['2026-10-postings.csv.gz', '2026-11-closed.csv', '2026-11-postings.csv', 'README.md', 'sources.csv', 'weekly.csv']);
    assert.match(oct, /gh:acme:1/); assert.match(nov, /gh:acme:2/); assert.match(nov, /"PMM, ""Cloud"""/);
    assert.match(nov, /You will own positioning for our cloud detection products/); assert.doesNotMatch(nov, /leading security company/);
    assert.match(nov, /Cybersecurity,security/); assert.match(nov, /siem\|xdr/); assert.match(nov, /,NY,/);
  });
  t('archive: later runs append only new and newly closed postings', () => {
    assert.equal(r2.added, 1); assert.equal(r2.closed, 1);
    assert.equal(nov2.split('\n').filter(Boolean).length, 3); assert.match(nov2, /gh:acme:3.*Fresh summary\./);
    assert.match(closed2, /gh:acme:1,2026-11-22T15:00:00.000Z,2026-10-30T10:00:00.000Z,23.2,Acme/);
  });
  t('archive: a new month compresses the finished one', () => { assert.equal(r3.rolled, 2); assert.ok(files3.includes('2026-11-postings.csv.gz') && !files3.includes('2026-11-postings.csv')); });
}
{ // Greenhouse region fallback
  const { ADAPTERS: G } = await import('../../assets/shared/core.mjs');
  const asked = [];
  const http = { json: async u => { asked.push(new URL(u).host); return u.includes('.eu.') ? { ok: true, status: 200, data: { jobs: [{ id: 1, title: 'Product Marketing Manager', absolute_url: 'u', location: { name: 'Remote, US' }, content: '' }] } } : { ok: false, error: 'network_error' }; } };
  const out = await G.greenhouse({ id: 'gh:x', slug: 'x' }, { employer: 'X' }, http);
  const http2 = { json: async u => (asked.push('2:' + new URL(u).host), u.includes('.eu.') ? { ok: false, error: 'network_error' } : { ok: true, status: 200, data: { jobs: [] } }) };
  const out2 = await G.greenhouse({ id: 'gh:y', slug: 'y', region: 'eu' }, { employer: 'Y' }, http2);
  t('greenhouse: falls back to the other region when the expected host fails', () => {
    assert.equal(out.result, 'ok'); assert.deepEqual(asked.slice(0, 2), ['boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io']); assert.match(out.note, /EU region/);
    assert.equal(out2.result, 'empty'); assert.deepEqual(asked.slice(2), ['2:boards-api.eu.greenhouse.io', '2:boards-api.greenhouse.io']);
  });
}
{ // a source refused (403) 3 runs in a row is paused for a week
  const dir = await mkdtemp(join(tmpdir(), 'cf-pause-'));
  await mkdir(join(dir), { recursive: true });
  const day = 864e5, now = new Date('2026-11-22T15:00:00Z');
  const prev = { schema: 1, generated_at: '2026-11-22T11:00:00Z', sources: [{ id: 'gh:blocked', employer: 'B', ats: 'greenhouse', result: 'http_403', http_status: 403, consecutive_failures: 3, checked_at: new Date(now - day).toISOString() }] };
  await writeFile(join(dir, 'status.json'), JSON.stringify(prev)); await writeFile(join(dir, 'jobs.json'), JSON.stringify({ jobs: [] }));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'B', id: 'b', tier: 'core', sources: [{ id: 'gh:blocked', ats: 'greenhouse', slug: 'blocked' }] }] }));
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('nope', { status: 403 }); };
  const r = await run({ fetchImpl, env: {}, now, dataDir: dir, argv: {}, cfgOverride: FAST }).catch(e => ({ err: e }));
  t('collector: a source refused 3 runs in a row is paused (no request) until a week has passed', () => {
    if (r.err) throw r.err;
    const st = r.statusOut.sources.find(x => x.id === 'gh:blocked');
    assert.equal(st.result, 'blocked_paused'); assert.equal(calls, 0);
  });
}
{ // Cloudflare bot check: no retries, rest of that site skipped, other sites unaffected, source labelled
  const { Http } = await import('../lib/http.mjs');
  const hits = {};
  const fetchImpl = async u => { const h = new URL(u).host; hits[h] = (hits[h] || 0) + 1;
    return h.startsWith('a.') ? new Response('challenge', { status: 429, headers: { 'cf-mitigated': 'challenge' } }) : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const h = new Http({ fetchImpl, minDelay: 1, maxDelay: 2, retries: 3, hostRules: [{ suffix: 'myworkdayjobs.com', group: 'workday', minDelayMs: 1, maxDelayMs: 2, retries: 5, backoffMs: 1 }] });
  const r1 = await h.json('https://a.wd5.myworkdayjobs.com/x'), r2 = await h.json('https://a.wd5.myworkdayjobs.com/y'), r3 = await h.json('https://b.wd5.myworkdayjobs.com/x');
  t('http: a Cloudflare challenge is not retried; that site is skipped for the rest of the run; other boards continue', () => {
    assert.equal(r1.challenge, true); assert.equal(r1.mitigated, 'challenge'); assert.equal(hits['a.wd5.myworkdayjobs.com'], 1);
    assert.equal(r2.skipped, true); assert.equal(r3.ok, true); assert.equal(h.stats.challenges, 1);
  });
  const dir = await mkdtemp(join(tmpdir(), 'cf-chal-'));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ employers: [{ employer: 'Co', id: 'co', tier: 'core', sources: [{ id: 'wd:co', ats: 'workday', host: 'co.wd5.myworkdayjobs.com', tenant: 'co', site: 'Ext', queries: [''] }] }] }));
  await writeFile(join(dir, 'jobs.json'), JSON.stringify({ jobs: [{ uid: 'wd:co:1', source_id: 'wd:co', title: 'PMM', status: 'open', first_observed: '2026-11-01T00:00:00Z', last_seen: '2026-11-20T00:00:00Z', locations: ['NY'] }] }));
  let n = 0;
  const r = await run({ fetchImpl: async () => (n++, new Response('x', { status: 429, headers: { 'cf-mitigated': 'challenge' } })), env: {}, now: new Date(), dataDir: dir, argv: {}, cfgOverride: FAST }).catch(e => ({ err: e }));
  t('collector: a bot-checked source is labelled blocked_challenge, makes one request, keeps its previous roles', () => {
    if (r.err) throw r.err;
    const st = r.statusOut.sources.find(x => x.id === 'wd:co');
    assert.equal(st.result, 'blocked_challenge'); assert.equal(st.bot_check, 'challenge'); assert.match(st.message, /Not evidence of zero jobs/);
    assert.equal(n, 1); assert.ok(r.jobsOut.jobs.some(j => j.uid === 'wd:co:1' && j.status === 'open'));
  });
}
{ // BambooHR: list + detail for category roles, US places, reuse
  const { ADAPTERS: SA } = await import('../lib/adapters-server.mjs');
  const asked = [];
  const http = { json: async u => { asked.push(u);
    if (u.endsWith('/careers/list')) return { ok: true, status: 200, data: { meta: { totalCount: 2 }, result: [
      { id: '846', jobOpeningName: 'Partner Development Manager', departmentLabel: 'Sales', location: { city: 'Austin', state: 'Texas', country: 'United States' }, isRemote: true },
      { id: '900', jobOpeningName: 'SOC Analyst II', departmentLabel: 'SOC', location: { city: 'Zurich', country: 'Switzerland' }, isRemote: false } ] } };
    if (u.endsWith('/846/detail')) return { ok: true, status: 200, data: { result: { jobOpening: { description: '<p>Own the Microsoft co-sell motion.</p>', compensation: '$150,000 - $180,000 base', datePosted: '2026-11-18' } } } };
    return { ok: false, status: 404 }; } };
  const out = await SA.bamboohr({ id: 'bamboohr:ontinue', slug: 'ontinue' }, { employer: 'Ontinue' }, http, { detailCap: 10 });
  t('bamboohr: lists postings, reads detail for category roles (pay, date), builds job links', () => {
    assert.equal(out.result, 'ok'); assert.equal(out.jobs.length, 2);
    const pdm = out.jobs.find(j => j.ext_id === '846');
    assert.equal(pdm.url, 'https://ontinue.bamboohr.com/careers/846'); assert.deepEqual(pdm.locations, ['Austin, Texas, United States']); assert.equal(pdm.remote_hint, true);
    assert.match(pdm.desc_text, /150,000/); assert.equal(pdm.posted_at.slice(0, 10), '2026-11-18');
    assert.ok(asked.includes('https://ontinue.bamboohr.com/careers/list'));
  });
}
{ // native Node transport (Workday): real local server, gzip JSON, POST body, redirect, challenge header
  const { Http } = await import('../lib/http.mjs');
  const { createServer } = await import('node:http');
  const { gzipSync } = await import('node:zlib');
  const seen = [];
  const srv = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      seen.push({ url: req.url, method: req.method, ua: req.headers['user-agent'], body });
      if (req.url === '/old') { res.writeHead(301, { location: '/jobs' }); return res.end(); }
      if (req.url === '/blocked') { res.writeHead(429, { 'cf-mitigated': 'challenge' }); return res.end('challenge'); }
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(gzipSync(JSON.stringify({ total: 1, jobPostings: [{ title: 'PMM' }] })));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const h = new Http({ minDelay: 1, maxDelay: 2, retries: 2, userAgent: 'cache-flow-collector/test', hostRules: [{ suffix: '127.0.0.1:' + srv.address().port, transport: 'node', minDelayMs: 1, maxDelayMs: 2 }] });
  const a = await h.json(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 20 }) });
  const b = await h.json(`${base}/old`);
  const c = await h.json(`${base}/blocked`);
  srv.close();
  t('http: native Node transport sends the same honest request (UA, body), decodes gzip, follows redirects, still detects challenges', () => {
    assert.equal(a.ok, true); assert.equal(a.data.jobPostings[0].title, 'PMM');
    assert.equal(seen[0].method, 'POST'); assert.equal(seen[0].body, '{"limit":20}'); assert.equal(seen[0].ua, 'cache-flow-collector/test');
    assert.equal(b.ok, true); assert.deepEqual(seen.slice(1, 3).map(x => x.url), ['/old', '/jobs']);
    assert.equal(c.challenge, true); assert.equal(h.stats.transport.node, 3);
  });
}
{ // ledger: changes file and weekly rollup
  const { archiveRun, weeklyRollup, parseCsv, weekOf } = await import('../archive.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'cf-ledger-'));
  const reg = { employers: [{ employer: 'Acme', sector: 'Cybersecurity', type: 'security', sources: [{ id: 'gh:acme' }, { id: 'gh:new' }] }] };
  const J = (uid, first, extra = {}) => ({ uid, source_id: uid.split(':').slice(0, 2).join(':'), ats: 'greenhouse', employer: 'Acme', title: 'Partner Manager', locations: ['Remote, US'], functions: ['partner'],
    salary: { min: 150000, max: 190000, kind: 'base' }, remote_us: true, first_observed: first, status: 'open', url: 'u', ...extra });
  const t0 = '2026-11-02T12:00:00.000Z', t1 = '2026-11-10T12:00:00.000Z';
  await archiveRun({ dataDir: dir, nowIso: t0, registry: reg, jobs: [J('gh:acme:1', t0), J('gh:acme:2', t0)] });
  const prev = new Map([J('gh:acme:1', t0), J('gh:acme:2', t0)].map(j => [j.uid, j]));
  const r = await archiveRun({ dataDir: dir, nowIso: t1, registry: reg, prevById: prev, jobs: [
    J('gh:acme:1', t0, { salary: { min: 170000, max: 210000, kind: 'base' }, title: 'Senior Partner Manager', posted_at: '2026-11-09T00:00:00.000Z', date_history: [{ was: '2026-10-30T00:00:00.000Z', seen: t1 }] }),
    J('gh:acme:2', t0, { status: 'closed', closed_at: t1 }), J('gh:acme:3', t1), J('gh:new:9', t1, { functions: ['pmm'], salary: { kind: 'ote_only', ote: { min: 1, max: 2 } } }) ] });
  const ch = parseCsv(await readFile(join(dir, 'archive', '2026-11-changes.csv'), 'utf8'));
  const wk = parseCsv(await readFile(join(dir, 'archive', 'weekly.csv'), 'utf8'));
  const row = (w, sec, cat) => wk.find(x => x.week === w && x.sector === sec && x.category === cat);
  t('ledger: pay, title and repost changes are recorded with before/after', () => {
    assert.equal(r.changes, 3);
    assert.deepEqual(ch.map(c => c.change).sort(), ['pay', 'reposted', 'title']);
    assert.equal(ch.find(c => c.change === 'pay').was, '150000-190000'); assert.equal(ch.find(c => c.change === 'pay').now, '170000-210000');
  });
  t('ledger: weekly rollup counts new/closed, same-store excludes newly covered sources, pay medians and OTE share', () => {
    assert.equal(weekOf('2026-11-10T12:00:00Z'), '2026-11-09');
    const w2 = row('2026-11-09', 'all', 'all');
    assert.equal(w2.new_postings, '2'); assert.equal(w2.new_same_store, '1'); assert.equal(w2.closed, '1'); assert.equal(w2.median_days_open, '8');
    assert.equal(w2.ote_only, '1'); assert.equal(w2.with_base_pay, '1'); assert.equal(w2.remote_us, '2');
    assert.equal(row('2026-11-02', 'all', 'all').new_same_store, '0');
    assert.equal(row('2026-11-09', 'Cybersecurity', 'pmm').new_postings, '1');
  });
}
console.log(`${pass} tests passed${process.exitCode ? ' (with failures)' : ''}`);
