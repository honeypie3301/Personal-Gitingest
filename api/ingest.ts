import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArchiveDownloadError, downloadArchive, ingestArchive } from '../worker/archive';
import { parseGitHubUrl } from '../src/services/ingestFormatting';
import { isLocalPath } from '../src/services/ingest';
import { checkOwnerAuth } from '../lib/owner-auth';
import { submitWorkerJob } from '../lib/worker-proxy';
import { GitHubRateLimitError, githubRateLimitMessage } from '../src/services/githubRateLimit';

export const config = {
  maxDuration: 60, // allow up to 60s execution for large repos
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers?.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : null;
  const incomingAuth = bearerToken || req.body?.token || process.env.GITHUB_TOKEN;

  // In public mode, ingestion is open to all visitors


  const { input_text, max_file_size = 50, pattern_type = 'exclude', pattern = '', token, decompile_classes = false } = req.body || {};

  if (!input_text || typeof input_text !== 'string') {
    return res.status(400).json({ error: 'Please provide a valid repository URL' });
  }

  if (process.env.INGEST_WORKER_URL) {
    return submitWorkerJob(req, res);
  }

  const controller = new AbortController();
  res.on?.('close', () => { if (!res.writableEnded) controller.abort(); });

  const parsed = parseGitHubUrl(input_text);
  if (!parsed && !isLocalPath(input_text)) {
    return res.status(400).json({ error: 'Invalid URL. Expected format: owner/repo or https://github.com/owner/repo' });
  }

  // Local paths cannot be processed by this Node.js handler; they must go through the Python server.
  if (!parsed && isLocalPath(input_text)) {
    return res.status(400).json({
      error: 'Local path ingestion is only supported through the Python backend. Make sure the Python server is running and reachable.',
    });
  }

  const { owner, repo } = parsed!;
  const activeToken = (bearerToken || token || process.env.GITHUB_TOKEN || '').trim();

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'GitIngest-Personal',
  };
  if (activeToken) {
    headers.Authorization = `Bearer ${activeToken}`;
  }

  try {
    // 1. Resolve branch
    let branch: string = parsed!.branch || '';
    if (!branch) {
      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers, signal: controller.signal });
      const rateLimit = await githubRateLimitMessage(repoRes);
      if (rateLimit) return res.status(429).json({ error: rateLimit });
      if (!repoRes.ok) {
        const errJson = await repoRes.json().catch(() => null);
        const msg = errJson?.message || repoRes.statusText || 'Unknown GitHub API error';
        if (repoRes.status === 401) {
          return res.status(401).json({
            error: `GitHub API authentication failed (401): ${msg}. Please check that your token is active and has access.`,
          });
        }
        if (repoRes.status === 404) {
          return res.status(404).json({
            error: `Repository "${owner}/${repo}" not found or is private. Make sure your PAT has 'repo' scope.`,
          });
        }
        if (repoRes.status === 403) {
          return res.status(403).json({
            error: `GitHub API access forbidden: ${msg}. Check your Personal Access Token permissions.`,
          });
        }
        return res.status(repoRes.status).json({ error: `GitHub API error (${repoRes.status}): ${msg}` });
      }
      const repoData = await repoRes.json();
      branch = repoData.default_branch || 'main';
    }

    // Native decompression and a disk-backed archive avoid JSZip's full in-memory archive.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'gitingest-'));
    try {
      const archive = path.join(directory, 'repository.zip');
      await downloadArchive(`https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(branch)}`, activeToken, archive, controller.signal);
      const result = await ingestArchive(archive, path.join(directory, 'content.txt'), path.join(directory, 'digest.txt'), {
        owner, repo, branch, subpath: parsed!.subpath, max_file_size, pattern_type, pattern,
        decompile_classes,
        preview_chars: Number.MAX_SAFE_INTEGER,
        signal: controller.signal,
      });
      // Keep the original synchronous response contract when no worker is configured.
      return res.status(200).json({
        summary: result.summary, tree: result.tree, content: result.content,
        repo_name: result.repo_name, files_analyzed: result.files_analyzed,
        estimated_tokens: result.estimated_tokens, total_chars: result.total_chars,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } catch (err: any) {
    if (controller.signal.aborted) return;
    if (err instanceof GitHubRateLimitError) return res.status(429).json({ error: err.message });
    if (err instanceof ArchiveDownloadError) return res.status(err.status).json({ error: err.message });
    console.error('Vercel Ingestion Error:', err.name);
    return res.status(500).json({ error: 'Failed to process repository ingestion. Please retry or use the ingestion worker for large repositories.' });
  }
}
