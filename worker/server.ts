import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseGitHubUrl } from '../src/services/ingestFormatting.js';
import { downloadArchive, ingestArchive, ingestDirectory, sparseClone } from './archive.js';
import { ArtifactStorage } from './storage.js';
import type { IngestFileEvent, IngestRequest } from '../src/types/index.js';
import { GitHubRateLimitError, githubRateLimitMessage } from '../src/services/githubRateLimit.js';

type State = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
interface Job {
  id: string;
  key: string;
  state: State;
  phase: string;
  created: number;
  files_processed: number;
  progress?: IngestFileEvent[];
  commit: string;
  error?: string;
  timings?: Record<string, number>;
}

const TTL = 24 * 60 * 60 * 1000;
const BUDGET = 10 * 1024 ** 3;

function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function equal(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createWorkerApp() {
  const secret = process.env.INGEST_WORKER_SECRET || '';
  if (!secret) throw new Error('INGEST_WORKER_SECRET must be configured.');
  const root = path.resolve(process.env.INGEST_DATA_DIR || '.ingest-data');
  const publicUrl = (process.env.INGEST_WORKER_PUBLIC_URL || '').replace(/\/$/, '');
  if (!publicUrl) throw new Error('INGEST_WORKER_PUBLIC_URL must be configured for direct artifact downloads.');
  await Promise.all(['jobs', 'cache', 'archives'].map(name => mkdir(path.join(root, name), { recursive: true })));
  const storage = new ArtifactStorage();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const controllers = new Map<string, AbortController>();
  const liveJobs = new Map<string, Job>();
  const queue: Array<() => Promise<void>> = [];
  let busy = false;
  let activeKey: string | undefined;
  let activeArchive: string | undefined;
  const jobPath = (id: string) => path.join(root, 'jobs', `${id}.json`);
  const persist = async (job: Job) => {
    const temp = jobPath(job.id) + '.tmp';
    for (let attempt = 0; ; attempt++) {
      try {
        await writeFile(temp, JSON.stringify(job));
        await rename(temp, jobPath(job.id));
        return;
      } catch (error: any) {
        // Windows scanners/readers can temporarily hold a file across an atomic rename.
        if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  };
  const loadJob = async (id: string): Promise<Job> => JSON.parse(await readFile(jobPath(id), 'utf8'));
  const enqueue = (work: () => Promise<void>) => {
    queue.push(work);
    void drain();
  };
  const drain = async () => {
    if (busy) return;
    busy = true;
    try { while (queue.length) {
      try { await queue.shift()!(); }
      catch (error: any) { console.error('Worker could not save job state:', error?.code || error?.name || 'Error'); }
    } }
    finally { busy = false; }
  };

  // Never persist credentials. Interrupted jobs require a fresh authenticated request after restart.
  for (const filename of await readdir(path.join(root, 'jobs'))) {
    if (!filename.endsWith('.json')) continue;
    const job = JSON.parse(await readFile(path.join(root, 'jobs', filename), 'utf8')) as Job;
    if (job.state === 'queued' || job.state === 'running') {
      job.state = 'failed'; job.error = 'Worker restarted. Please retry ingestion.';
      await persist(job);
    }
  }

  async function prune() {
    const candidates: Array<{ filename: string; bytes: number; touched: number }> = [];
    for (const kind of ['cache', 'archives']) {
      for (const name of await readdir(path.join(root, kind))) {
        if (kind === 'cache' && name === activeKey) continue;
        const filename = path.join(root, kind, name);
        if (filename === activeArchive) continue;
        const info = await stat(filename);
        let bytes = info.size;
        if (info.isDirectory()) {
          bytes = 0;
          for (const entry of await readdir(filename)) bytes += (await stat(path.join(filename, entry))).size;
        }
        candidates.push({ filename, bytes, touched: info.mtimeMs });
      }
    }
    let total = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of candidates.sort((a, b) => a.touched - b.touched)) {
      if (Date.now() - entry.touched > TTL || total > BUDGET) {
        // Paths come only from our two fixed cache roots, never request input.
        await rm(entry.filename, { recursive: true, force: true });
        total -= entry.bytes;
      }
    }
    for (const name of await readdir(path.join(root, 'jobs'))) {
      const filename = path.join(root, 'jobs', name);
      const info = await stat(filename);
      if (Date.now() - info.mtimeMs > TTL) await rm(filename, { force: true });
    }
  }

  const signDownload = (key: string, expires: number) => createHmac('sha256', secret).update(`${key}:${expires}`).digest('hex');
  async function result(job: Job) {
    const directory = path.join(root, 'cache', job.key);
    const metadata = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    const remote = await storage.url(`gitingest/${job.key}.txt`);
    if (!remote) await stat(path.join(directory, 'digest.txt'));
    const expires = Date.now() + 15 * 60 * 1000;
    return { ...metadata, artifact_url: remote || `${publicUrl}/artifacts/${job.key}?expires=${expires}&signature=${signDownload(job.key, expires)}` };
  }

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/artifacts/:key', async (req, res) => {
    const key = req.params.key;
    const expires = Number(req.query.expires);
    if (!/^[a-f0-9]{64}$/.test(key) || !Number.isFinite(expires) || expires < Date.now() || !equal(String(req.query.signature || ''), signDownload(key, expires))) {
      res.status(403).json({ error: 'Download link expired or invalid. Ingest again to refresh it.' }); return;
    }
    res.setHeader('Access-Control-Allow-Origin', process.env.INGEST_WEB_ORIGIN || '*');
    res.setHeader('Cache-Control', 'private, no-store');
    let downloadName = 'repository_digest.txt';
    try {
      const metadata = JSON.parse(await readFile(path.join(root, 'cache', key, 'result.json'), 'utf8'));
      downloadName = `${metadata.repo_name.replace(/\//g, '_')}_digest.txt`;
    } catch { res.status(404).json({ error: 'Export expired. Please ingest again.' }); return; }
    res.download(path.join(root, 'cache', key, 'digest.txt'), downloadName, error => {
      if (error && !res.headersSent) res.status(404).json({ error: 'Export expired. Please ingest again.' });
    });
  });
  app.use((req, res, next) => {
    if (!equal(req.headers.authorization || '', `Bearer ${secret}`)) {
      res.status(401).json({ error: 'Unauthorized worker request.' }); return;
    }
    next();
  });

  app.post('/jobs', async (req, res) => {
    try {
      if (controllers.size >= 10) { res.status(429).json({ error: 'Ingestion queue is full. Please retry shortly.' }); return; }
      const input = req.body as IngestRequest;
      const parsed = typeof input.input_text === 'string' ? parseGitHubUrl(input.input_text) : null;
      if (!parsed || !/^[\w.-]+$/.test(parsed.owner) || !/^[\w.-]+$/.test(parsed.repo)) {
        res.status(400).json({ error: 'Invalid repository URL.' }); return;
      }
      if (input.max_file_size !== undefined && (!Number.isFinite(input.max_file_size) || input.max_file_size < 0)) {
        res.status(400).json({ error: 'Invalid maximum file size.' }); return;
      }
      if (input.pattern !== undefined && typeof input.pattern !== 'string') { res.status(400).json({ error: 'Invalid patterns.' }); return; }
      const token = typeof input.token === 'string' ? input.token : process.env.GITHUB_TOKEN || '';
      const headers = { 'User-Agent': 'GitIngest-Personal', Accept: 'application/vnd.github.v3+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const repoUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
      let branch = parsed.branch;
      if (!branch) {
        const response = await fetch(repoUrl, { headers, signal: AbortSignal.timeout(20_000) });
        const rateLimit = await githubRateLimitMessage(response);
        if (rateLimit) { res.status(429).json({ error: rateLimit }); return; }
        if (!response.ok) { res.status(response.status).json({ error: `Repository access failed (${response.status}).` }); return; }
        branch = (await response.json()).default_branch;
      }
      const commitResponse = await fetch(`${repoUrl}/commits/${encodeURIComponent(branch!)}`, { headers, signal: AbortSignal.timeout(20_000) });
      const rateLimit = await githubRateLimitMessage(commitResponse);
      if (rateLimit) { res.status(429).json({ error: rateLimit }); return; }
      if (!commitResponse.ok) { res.status(commitResponse.status).json({ error: `Branch access failed (${commitResponse.status}).` }); return; }
      const commit = (await commitResponse.json()).sha as string;
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid commit returned by GitHub.');
      const options = { owner: parsed.owner, repo: parsed.repo, branch: branch!, subpath: parsed.subpath, pattern: input.pattern || '', pattern_type: input.pattern_type || 'exclude' as const, max_file_size: input.max_file_size ?? 50, decompile_classes: Boolean(input.decompile_classes) };
      const key = hash(JSON.stringify({ version: 1, commit, ...options }));
      const job: Job = { id: randomUUID(), key, state: 'queued', phase: 'queued', created: Date.now(), files_processed: 0, commit };
      await persist(job);
      const directory = path.join(root, 'cache', key);
      try {
        const info = await stat(path.join(directory, 'result.json'));
        if (Date.now() - info.mtimeMs < TTL) {
          const cached = await result(job);
          job.state = 'completed'; job.phase = 'completed'; job.timings = { cache_hit: 1 };
          await persist(job);
          res.json({ ...job, result: cached }); return;
        }
      } catch { /* Missing/expired cache entries are rebuilt. */ }
      const controller = new AbortController();
      controllers.set(job.id, controller);
      liveJobs.set(job.id, job);
      enqueue(async () => {
        const started = performance.now();
        const archive = path.join(root, 'archives', `${hash(`${parsed.owner}/${parsed.repo}:${commit}`)}.zip`);
        const checkout = path.join(root, 'archives', `${job.id}.git`);
        const contentPart = path.join(directory, `${job.id}.content.part`);
        const digestPart = path.join(directory, `${job.id}.digest.part`);
        activeKey = key; activeArchive = archive;
        try {
          controller.signal.throwIfAborted();
          // An identical job may have completed while this request waited in the queue.
          try {
            const info = await stat(path.join(directory, 'result.json'));
            if (Date.now() - info.mtimeMs < TTL) {
              await result(job);
              job.state = 'completed'; job.phase = 'completed'; job.timings = { cache_hit: 1 };
              return;
            }
          } catch { /* Build a missing result. */ }
          job.state = 'running'; job.phase = 'downloading'; await persist(job);
          await mkdir(directory, { recursive: true });
          // A zipball always contains the whole repository. For a subpath, fetch only that folder with a sparse checkout.
          let sparse = Boolean(parsed.subpath);
          const beforeDownload = performance.now();
          if (sparse) {
            activeArchive = checkout;
            try { await sparseClone(parsed.owner, parsed.repo, commit, parsed.subpath, checkout, token, controller.signal); }
            catch (error) {
              if (controller.signal.aborted) throw error;
              console.error('Sparse checkout failed; falling back to the repository archive.');
              await rm(checkout, { recursive: true, force: true });
              sparse = false; activeArchive = archive;
            }
          }
          let archiveHit = false;
          if (!sparse) {
            try { await stat(archive); archiveHit = true; } catch { /* Cold commit. */ }
            if (!archiveHit) {
              await downloadArchive(`${repoUrl}/zipball/${commit}`, token, archive + '.part', controller.signal);
              await rename(archive + '.part', archive);
            }
          }
          job.timings = { download_ms: performance.now() - beforeDownload, archive_cache_hit: Number(archiveHit) };
          job.phase = 'processing'; await persist(job);
          let lastProgress = 0;
          const ingestOptions = {
            ...options, concurrency: Number(process.env.INGEST_CONCURRENCY || 4), signal: controller.signal,
            onProgress: (event: IngestFileEvent) => {
              job.files_processed = event.count;
              job.progress ||= [];
              job.progress.push(event);
              if (job.progress.length > 500) job.progress.splice(0, job.progress.length - 500);
              lastProgress = event.count;
            },
          };
          const processed = sparse
            ? await ingestDirectory(checkout, contentPart, digestPart, ingestOptions)
            : await ingestArchive(archive, contentPart, digestPart, ingestOptions);
          job.files_processed = lastProgress;
          job.timings.processing_ms = performance.now() - beforeDownload - job.timings.download_ms;
          job.phase = 'uploading'; await persist(job);
          const beforeUpload = performance.now();
          await storage.upload(`gitingest/${key}.txt`, digestPart, controller.signal, `${options.owner}_${options.repo}_digest.txt`);
          job.timings.upload_ms = performance.now() - beforeUpload;
          controller.signal.throwIfAborted();
          await rename(digestPart, path.join(directory, 'digest.txt'));
          await writeFile(path.join(directory, 'result.json'), JSON.stringify({ ...processed, commit }));
          job.timings.total_ms = performance.now() - started;
          job.state = 'completed'; job.phase = 'completed';
        } catch (error: any) {
          const failedPhase = job.phase;
          job.state = controller.signal.aborted ? 'cancelled' : 'failed'; job.phase = job.state;
          // Never serialize fetch errors or request headers containing credentials.
          job.error = controller.signal.aborted ? 'Ingestion cancelled.' : error instanceof GitHubRateLimitError ? error.message : 'Ingestion failed during ' + failedPhase + '. Please retry.';
          if (!controller.signal.aborted) console.error('Ingestion failed:', error?.name || 'Error');
          if (!controller.signal.aborted && failedPhase === 'processing') await rm(archive, { force: true });  // Directory checkouts are always removed below.
        } finally {
          const cleanup = await Promise.allSettled([rm(archive + '.part', { force: true }), rm(checkout, { recursive: true, force: true }), rm(contentPart, { force: true }), rm(digestPart, { force: true })]);
          for (const item of cleanup) if (item.status === 'rejected') console.error('Temporary ingestion file could not be removed:', item.reason?.code || 'Error');
          controllers.delete(job.id);
          // Keep the final in-memory status available if persistence fails; never leave clients polling a stale queued state.
          try { await persist(job); liveJobs.delete(job.id); }
          catch (error: any) { console.error('Final job state could not be saved:', error?.code || 'Error'); }
          activeKey = undefined; activeArchive = undefined;
          await prune().catch(() => {});
        }
      });
      res.status(202).json(job);
    } catch { res.status(502).json({ error: 'Unable to create ingestion job. Check GitHub access and worker storage.' }); }
  });

  app.get('/jobs/:id', async (req, res) => {
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) { res.sendStatus(404); return; }
    try {
      const job = liveJobs.get(req.params.id) || await loadJob(req.params.id);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ...job, ...(job.state === 'completed' ? { result: await result(job) } : {}) });
    } catch { res.status(404).json({ error: 'Job or export expired. Please ingest again.' }); }
  });
  app.delete('/jobs/:id', async (req, res) => {
    const controller = controllers.get(req.params.id);
    if (!controller) { res.status(404).json({ error: 'No active job.' }); return; }
    controller.abort(); res.json({ cancelled: true });
  });
  await prune();
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createWorkerApp();
  const port = Number(process.env.INGEST_WORKER_PORT || 3001);
  app.listen(port, '0.0.0.0', () => console.log(`GitIngest worker listening on ${port}`));
}
