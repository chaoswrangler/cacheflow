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
t('chief of staff', () => assert.ok(classifyFunctions('Chief of Staff to the CISO').functions.includes('strategy')));
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
Senior Security Product Manager | Microsoft | 2022 – 2025
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
ok('titles: ' + JSON.stringify(p.titles), p.titles.every(t => !/summary|unified|differentiation/i.test(t) && t.length) && p.titles.some(t => /Program Manager/.test(t)));
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
  { employer: 'Google', tier: 'heavy', sources: [{ id: 'google:link', ats: 'link_only', verification: { status: 'link_only', method: 'No feed' } }] },
] };
await writeFile(join(dir, 'sources.json'), JSON.stringify(reg));
const FAST = { http: { minDelayMs: 1, maxDelayMs: 2, concurrency: 4, timeoutMs: 2000, retries: 2 } };
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
console.log(`${pass} tests passed${process.exitCode ? ' (with failures)' : ''}`);
