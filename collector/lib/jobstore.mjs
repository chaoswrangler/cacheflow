// jobs.json in shards. GitHub refuses files over 100 MB (and warns over 50 MB); the single jobs.json had reached 64 MB.
// data/jobs.json keeps the run metadata and lists the shard files; the roles live in data/jobs/jobs-<n>.json, split by
// a stable hash of the source id so each file stays well under the limits. Older single-file data is still read.
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
export const SHARDS = 8;
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
export const shardOf = sourceId => hash(sourceId) % SHARDS;
export async function readJobs(dataDir) {
  let meta; try { meta = JSON.parse(await readFile(join(dataDir, 'jobs.json'), 'utf8')); } catch { return { jobs: [] }; }
  if (!Array.isArray(meta.shards) || !meta.shards.length) return { ...meta, jobs: meta.jobs || [] };
  const jobs = [];
  for (const f of meta.shards) { try { jobs.push(...(JSON.parse(await readFile(join(dataDir, f.replace(/^data\//, '')), 'utf8')).jobs || [])); } catch { /* a missing shard reads as empty */ } }
  return { ...meta, jobs };
}
export async function writeJobs(dataDir, out) {
  const { jobs, ...meta } = out;
  const parts = Array.from({ length: SHARDS }, () => []);
  for (const j of jobs) parts[shardOf(j.source_id)].push(j);
  await mkdir(join(dataDir, 'jobs'), { recursive: true });
  const shards = [];
  for (const [i, p] of parts.entries()) { const f = `jobs/jobs-${i}.json`; await writeFile(join(dataDir, f), JSON.stringify({ shard: i, jobs: p })); shards.push(`data/${f}`); }
  // remove shard files from an earlier, larger shard count
  try { for (const f of await readdir(join(dataDir, 'jobs'))) if (/^jobs-\d+\.json$/.test(f) && +f.match(/\d+/)[0] >= SHARDS) await unlink(join(dataDir, 'jobs', f)); } catch { /* none */ }
  await writeFile(join(dataDir, 'jobs.json'), JSON.stringify({ ...meta, shards, jobs: [] }));
  return shards;
}
