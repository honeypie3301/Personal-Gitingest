import express from 'express';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import dotenv from 'dotenv';
import JSZip from 'jszip';
import { handleWorkerJob, submitWorkerJob } from './lib/worker-proxy.ts';
import { decompileJavaClass } from './src/services/decompiler/javaClassDecompiler.ts';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const rawExecFileAsync = promisify(execFile);
const execFileAsync = async (file: string, args: string[], options: any = {}): Promise<{ stdout: string; stderr: string }> => {
  const result: any = await rawExecFileAsync(file, args, {
    windowsHide: true,
    encoding: 'utf8',
    ...options,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(options.env || {}),
    },
  });
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') || '',
    stderr: typeof result.stderr === 'string' ? result.stderr : result.stderr?.toString('utf8') || '',
  };
};
const fsPromises = fs.promises;
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

function sanitizeSubpath(subpath: string): string {
  return subpath.replace(/\.\./g, '').replace(/^\/+|\/+$/g, '');
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp', 'pdf', 'zip', 'tar',
  'gz', '7z', 'rar', 'exe', 'dll', 'so', 'dylib', 'bin', 'pyc', 'pyo', 'pyd',
  'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'mov', 'wav', 'jar',
  'class', 'lockb', 'parquet', 'feather', 'wasm',
]);

function isBinaryExtension(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext ? BINARY_EXTENSIONS.has(ext) : false;
}

const OWNER_GITHUB_LOGIN = (process.env.OWNER_GITHUB_LOGIN || 'honeypie3301').toLowerCase();
const OWNER_GITHUB_ID = process.env.OWNER_GITHUB_ID ? Number(process.env.OWNER_GITHUB_ID) : 84184414;
const OWNER_ACCESS_KEY = (process.env.OWNER_ACCESS_KEY || process.env.OWNER_PASSPHRASE || 'honeypie3301-84184414').trim();
const OWNER_REPO_NAME = (process.env.OWNER_REPO_NAME || 'Personal-Gitingest').trim();

// In-memory token cache to prevent GitHub rate-limiting on repeated requests
interface VerifiedTokenCache {
  isOwner: boolean;
  user: any;
  cachedAt: number;
}
const tokenCache = new Map<string, VerifiedTokenCache>();
const TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Rate Limiter
interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const rateLimits = new Map<string, RateLimitEntry>();

function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) {
    return false;
  }
  entry.count++;
  return true;
}

// Helper to verify if a token or secret is authorized as the owner
async function verifyOwnerCredentials(tokenOrKey?: string): Promise<{ authorized: boolean; user?: any; reason?: string; status?: number }> {
  if (!tokenOrKey || !tokenOrKey.trim()) {
    return { authorized: false, reason: 'No authorization credentials provided.' };
  }

  let clean = tokenOrKey.trim();
  clean = clean.replace(/^["']|["']$/g, '').trim();
  clean = clean.replace(/^(bearer|token)\s+/i, '').trim();

  // 1. Direct match with configured server secret / access key
  if (OWNER_ACCESS_KEY && clean === OWNER_ACCESS_KEY) {
    return {
      authorized: true,
      user: {
        login: OWNER_GITHUB_LOGIN,
        id: OWNER_GITHUB_ID,
        name: 'Owner',
        avatar_url: '',
      },
    };
  }

  // 2. Check token cache for previously authorized owner token
  const cached = tokenCache.get(clean);
  const now = Date.now();
  if (cached && cached.isOwner && now - cached.cachedAt < TOKEN_CACHE_TTL) {
    return { authorized: true, user: cached.user };
  }

  // 3. Verify GitHub Token via GitHub API
  try {
    let ghRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${clean}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'GitIngest-OwnerAuth',
      },
      signal: AbortSignal.timeout(3000),
    });

    if (!ghRes.ok && ghRes.status === 401) {
      ghRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${clean}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'GitIngest-OwnerAuth',
        },
        signal: AbortSignal.timeout(3000),
      });
    }

    if (ghRes.status === 429 || (ghRes.status === 403 && ghRes.headers.get('x-ratelimit-remaining') === '0')) {
      const reset = Number(ghRes.headers.get('x-ratelimit-reset'));
      return { authorized: false, status: 429, reason: `GitHub API rate limit exceeded.${reset ? ` Retry after ${new Date(reset * 1000).toISOString()}.` : ' Retry after the rate limit resets.'}` };
    }

    // Fallback for fine-grained PATs without user profile permissions
    if (!ghRes.ok && (ghRes.status === 403 || ghRes.status === 404)) {
      // 1. Dynamically inspect accessible repositories using the PAT
      try {
        const userReposRes = await fetch('https://api.github.com/user/repos?per_page=10&affiliation=owner&sort=updated', {
          headers: {
            Authorization: `Bearer ${clean}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'GitIngest-OwnerAuth',
          },
        });
        if (userReposRes.ok) {
          const repos = await userReposRes.json();
          if (Array.isArray(repos) && repos.length > 0) {
            const matchedRepo = repos.find((r: any) => r.owner) || repos[0];
            if (matchedRepo?.owner) {
              const user = {
                id: matchedRepo.owner.id,
                login: matchedRepo.owner.login,
                avatar_url: matchedRepo.owner.avatar_url || '',
                name: matchedRepo.owner.login,
                html_url: matchedRepo.owner.html_url,
              };
              const isOwner = matchedRepo.owner.login.toLowerCase() === OWNER_GITHUB_LOGIN;
              tokenCache.set(clean, { isOwner, user, cachedAt: now });
              return { authorized: true, user };
            }
          }
        }
      } catch {
        // Fallback to candidate list
      }

      // 2. Candidate repo fallback
      const candidateRepos = Array.from(new Set([OWNER_REPO_NAME, 'Personal-Gitingest', 'Gitingest', 'gitingest']));
      for (const repoName of candidateRepos) {
        try {
          const repoCheck = await fetch(`https://api.github.com/repos/${OWNER_GITHUB_LOGIN}/${repoName}`, {
            headers: {
              Authorization: `Bearer ${clean}`,
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'GitIngest-OwnerAuth',
            },
          });
          if (repoCheck.ok) {
            const repoData = await repoCheck.json();
            if (repoData.owner) {
              const user = {
                id: repoData.owner.id,
                login: repoData.owner.login,
                avatar_url: repoData.owner.avatar_url || '',
                name: repoData.owner.login,
                html_url: repoData.owner.html_url,
              };
              const isOwner = repoData.owner.login.toLowerCase() === OWNER_GITHUB_LOGIN;
              tokenCache.set(clean, { isOwner, user, cachedAt: now });
              return { authorized: true, user };
            }
          }
        } catch {
          // try next candidate
        }
      }
    }

    if (!ghRes.ok) {
      const errText = await ghRes.text().catch(() => '');
      let errMsg = `GitHub API (${ghRes.status})`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.message) {
          errMsg += `: ${parsed.message}`;
          if (parsed.message.includes('Bad credentials')) {
            errMsg += ' — please check that the token is active and was copied completely.';
          } else if (parsed.message.includes('Resource not accessible')) {
            errMsg += ` — if using a Fine-Grained PAT, ensure repository access is granted in GitHub PAT settings.`;
          }
        }
      } catch {
        if (errText) errMsg += `: ${errText.slice(0, 100)}`;
      }
      return { authorized: false, reason: errMsg };
    }

    const userData = await ghRes.json();
    if (userData && userData.login) {
      const user = {
        id: userData.id,
        node_id: userData.node_id,
        login: userData.login,
        avatar_url: userData.avatar_url,
        name: userData.name || userData.login,
        html_url: userData.html_url,
      };
      const isOwner = userData.login.toLowerCase() === OWNER_GITHUB_LOGIN;
      tokenCache.set(clean, { isOwner, user, cachedAt: now });
      return { authorized: true, user };
    }

    return {
      authorized: false,
      reason: 'Invalid GitHub user data returned by API.',
    };
  } catch (err: any) {
    return { authorized: false, reason: `Failed to verify token: ${err.message}` };
  }
}

// Server-side Authentication Endpoint
app.post('/api/verify-auth', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(`auth:${ip}`, 10, 5 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many authentication attempts. Please try again in 5 minutes.' });
  }

  const { auth } = req.body || {};
  if (!auth || typeof auth !== 'string') {
    return res.status(400).json({ error: 'Authentication token or access key required' });
  }

  const check = await verifyOwnerCredentials(auth);
  if (check.authorized) {
    return res.json({ success: true, user: check.user });
  }

  return res.status(check.status || 401).json({ success: false, error: check.reason || 'Invalid credentials' });
});

// User & Token Status Endpoint
app.get('/api/user-status', async (req, res) => {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : null;

  if (!bearerToken) {
    return res.json({ configured: false, user: null, authorized: false });
  }

  const check = await verifyOwnerCredentials(bearerToken);
  return res.json({
    configured: check.authorized,
    authorized: check.authorized,
    user: check.user || null,
  });
});

// High-speed Ingest Endpoint
app.all('/api/ingest/jobs/:id', handleWorkerJob);
app.post('/api/ingest', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(`ingest:${ip}`, 30, 60 * 1000)) {
    return res.status(429).json({ error: 'Rate limit exceeded: max 30 ingestions per minute.' });
  }

  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : null;
  const incomingToken = bearerToken || req.body.token || process.env.GITHUB_TOKEN;

  // In public mode, all users can ingest repositories without owner PIN/key


  const isNdjson = Boolean(req.headers.accept?.includes('application/x-ndjson'));
  if (isNdjson) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    if (res.socket) {
      res.socket.setNoDelay(true);
    }
    res.flushHeaders?.();
  }

  const sendProgress = (filePath: string, count: number, total?: number, status?: string) => {
    if (isNdjson && !res.writableEnded) {
      try {
        const cleanPath = filePath.replace(/\s*\[Decompiled Java\]$/i, '');
        res.write(JSON.stringify({ type: 'progress', path: cleanPath, count, total, status }) + '\n');
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
      } catch {}
    }
  };

  const sendResult = (data: any) => {
    if (isNdjson) {
      if (!res.writableEnded) {
        res.write(JSON.stringify({ type: 'result', data }) + '\n');
        res.end();
      }
    } else {
      res.json(data);
    }
  };

  const { input_text, max_file_size = 50, pattern_type = 'exclude', pattern = '', token, decompile_classes = false } = req.body;

  if (!input_text || typeof input_text !== 'string') {
    return res.status(400).json({ error: 'Please provide a valid repository URL or path' });
  }

  if (process.env.INGEST_WORKER_URL) return submitWorkerJob(req, res);

  const activeToken = (bearerToken || token || process.env.GITHUB_TOKEN || '').trim();

  const patterns = (pattern as string)
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const compiledPatterns = patterns.map((pat) => {
    const escaped = pat.replace(/\./g, '\\.').replace(/\*/g, '.*');
    try {
      return { regex: new RegExp(escaped, 'i'), raw: pat };
    } catch {
      return { regex: null, raw: pat };
    }
  });

  const isPathAllowed = (relPath: string): boolean => {
    if (compiledPatterns.length === 0) return true;
    const matched = compiledPatterns.some(({ regex, raw }) => (regex ? regex.test(relPath) : relPath.includes(raw)));
    return pattern_type === 'include' ? matched : !matched;
  };

  const maxBytes = max_file_size * 1024 * 1024;

  // Local Directory Ingestion Support (Offline, 0 Network Calls, 0 Rate Limit)
  const potentialLocalPath = input_text.trim();
  if (fs.existsSync(potentialLocalPath)) {
    try {
      const stats = fs.statSync(potentialLocalPath);
      if (stats.isDirectory()) {
        const localRoot = path.resolve(potentialLocalPath);
        const collectedFiles: Array<{ relPath: string; fullPath: string; size: number }> = [];

        function walkLocalDir(currentDir: string) {
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.venv' || entry.name === '$RECYCLE.BIN') continue;
            const full = path.join(currentDir, entry.name);
            const rel = path.relative(localRoot, full).replace(/\\/g, '/');

            try {
              if (entry.isDirectory()) {
                walkLocalDir(full);
              } else if (entry.isFile()) {
                if (!isPathAllowed(rel)) continue;
                try {
                  const stat = fs.statSync(full);
                  if (stat.size <= maxBytes) {
                    collectedFiles.push({ relPath: rel, fullPath: full, size: stat.size });
                  }
                } catch {}
              }
            } catch {}
          }
        }

        walkLocalDir(localRoot);

        const paths = collectedFiles.map((f) => f.relPath);
        const treeText = buildAsciiTree(path.basename(localRoot), paths);

        const fileContents: string[] = [];
        let totalChars = 0;
        const MAX_LOCAL_DIGEST_CHARS = 40 * 1024 * 1024; // 40MB text limit to prevent Node OOM
        let isLocalTruncated = false;

        for (const file of collectedFiles) {
          if (totalChars >= MAX_LOCAL_DIGEST_CHARS) {
            isLocalTruncated = true;
            break;
          }
          try {
            const buf = fs.readFileSync(file.fullPath);
            if (buf.length > maxBytes) continue;
            let content: string;
            let fileHeader = file.relPath;
            if (file.relPath.toLowerCase().endsWith('.class')) {
              if (decompile_classes) {
                content = decompileJavaClass(buf, path.basename(file.relPath, '.class'));
                fileHeader += ' [Decompiled Java]';
              } else {
                content = '[Binary file: Java Class file]';
              }
            } else if (isBinaryBuffer(buf)) {
              content = '[Binary file]';
            } else {
              content = buf.toString('utf-8');
            }
            totalChars += content.length;
            fileContents.push(
              `================================================\nFile: ${fileHeader}\n================================================\n${content}\n`
            );
            const isClass = fileHeader.includes('[Decompiled Java]');
            const isBin = content.startsWith('[Binary file');
            sendProgress(
              fileHeader,
              fileContents.length,
              collectedFiles.length,
              isClass ? 'decompiling' : isBin ? 'binary' : 'completed'
            );
          } catch {}
        }

        if (isLocalTruncated) {
          fileContents.push(`\n[Notice: Digest capped at 40MB for browser rendering stability. Use pattern filters for targeted ingestion.]\n`);
        }

        const estimatedTokens = formatTokenCount(Math.round(totalChars / 4));
        const summary = [
          `Local Directory: ${localRoot}`,
          `Files analyzed: ${fileContents.length}`,
          `Estimated tokens: ${estimatedTokens}`,
          `Total characters: ${totalChars.toLocaleString()}`,
          isLocalTruncated ? `(Digest capped at 40MB for stability)` : null,
        ].filter(Boolean).join('\n');

        const responsePayload = {
          summary,
          tree: `Directory structure:\n${treeText}`,
          content: fileContents.join('\n'),
          repo_name: path.basename(localRoot),
          files_analyzed: fileContents.length,
          estimated_tokens: estimatedTokens,
          total_chars: totalChars,
          mode_info: 'Local Directory (Offline, 0 Network Calls)',
        };

        if (typeof global.gc === 'function') {
          setImmediate(() => {
            try { global.gc!(); } catch {}
          });
        }

        return sendResult(responsePayload);
      }
    } catch (err: any) {
      console.error('Local directory read error:', err);
    }
  }

  let clean = input_text.trim();
  let isSshUrl = false;
  if (/^git@github\.com:/i.test(clean)) {
    isSshUrl = true;
    clean = clean.replace(/^git@github\.com:/i, '');
  } else {
    clean = clean.replace(/^https?:\/\//i, '');
    clean = clean.replace(/^(?:www\.)?(?:github\.com|gitingest\.com)\//i, '');
  }
  clean = clean.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');

  const parts = clean.split('/');
  if (parts.length < 2) {
    return res.status(400).json({ error: 'Invalid URL. Expected format: owner/repo or https://github.com/owner/repo' });
  }

  const owner = parts[0];
  const repo = parts[1];
  let branch: string | undefined;
  let subpath: string | undefined;

  if (parts.length > 3 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    branch = parts[3];
    if (parts.length > 4) {
      subpath = sanitizeSubpath(parts.slice(4).join('/'));
    }
  }

  const abortController = new AbortController();
  let clientDisconnected = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      abortController.abort();
    }
  });

  let wasRateLimited = false;

  // FAST PATH: In-memory Zipball extraction (0 disk I/O, matching & beating real GitIngest)
  try {
    sendProgress(`Connecting to ${owner}/${repo}...`, 0, undefined, 'ingesting');
    let resolvedBranch: string = branch || '';
    let zipRes: Response | undefined;

    const zipHeaders: Record<string, string> = {
      'User-Agent': 'GitIngest-Fast',
    };
    if (activeToken) zipHeaders.Authorization = `Bearer ${activeToken}`;

    sendProgress(`Downloading zipball archive for ${owner}/${repo}...`, 0, undefined, 'ingesting');

    if (resolvedBranch) {
      zipRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(resolvedBranch)}`, {
        headers: zipHeaders,
        signal: abortController.signal,
      });
      if (zipRes && (zipRes.status === 403 || zipRes.status === 429)) {
        wasRateLimited = true;
      }
    } else {
      const repoHeaders: Record<string, string> = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'GitIngest-Fast',
      };
      if (activeToken) repoHeaders.Authorization = `Bearer ${activeToken}`;

      // Parallel speculative fetch for default branch metadata and main branch zipball
      const [repoMetaRes, zipMainRes] = await Promise.all([
        fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: repoHeaders,
          signal: abortController.signal,
        }),
        fetch(`https://api.github.com/repos/${owner}/${repo}/zipball/main`, {
          headers: zipHeaders,
          signal: abortController.signal,
        }).catch(() => null),
      ]);

      if (repoMetaRes.status === 403 || repoMetaRes.status === 429) {
        wasRateLimited = true;
      }

      if (repoMetaRes.ok) {
        const repoMetaData = await repoMetaRes.json();
        resolvedBranch = repoMetaData.default_branch || 'main';
      } else {
        resolvedBranch = 'main';
      }

      if (resolvedBranch === 'main' && zipMainRes && zipMainRes.ok) {
        zipRes = zipMainRes;
      } else {
        zipRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(resolvedBranch)}`, {
          headers: zipHeaders,
          signal: abortController.signal,
        });
        if (zipRes && (zipRes.status === 403 || zipRes.status === 429)) {
          wasRateLimited = true;
        }
      }
    }

    if (zipRes && zipRes.ok) {
      sendProgress(`Archive downloaded. Extracting and analyzing repository...`, 0, undefined, 'ingesting');
      const arrayBuf = await zipRes.arrayBuffer();
      // Cap raised from 100MB to 300MB
      if (arrayBuf.byteLength > 0 && arrayBuf.byteLength < 300 * 1024 * 1024) {
        const zip = await JSZip.loadAsync(arrayBuf);
        const fileKeys = Object.keys(zip.files);
        const firstKey = fileKeys[0] || '';
        const rootPrefix = firstKey.includes('/') ? firstKey.split('/')[0] + '/' : '';

        const fileEntries: Array<{ relPath: string; obj: JSZip.JSZipObject }> = [];
        const allPaths: string[] = [];

        for (const rawPath of fileKeys) {
          const obj = zip.files[rawPath];
          if (obj.dir) continue;
          const relPath = rootPrefix && rawPath.startsWith(rootPrefix)
            ? rawPath.substring(rootPrefix.length)
            : rawPath;

          if (!relPath || relPath.startsWith('.git/')) continue;
          if (subpath && !relPath.startsWith(subpath)) continue;
          if (!isPathAllowed(relPath)) continue;

          allPaths.push(relPath);
          fileEntries.push({ relPath, obj });
        }

        const treeText = buildAsciiTree(subpath || repo, allPaths);
        const fileContents: string[] = [];
        let totalChars = 0;
        const MAX_ZIP_DIGEST_CHARS = 40 * 1024 * 1024; // 40MB limit
        let isZipTruncated = false;

        const ZIP_CHUNK = 2; // Micro-chunking for instant live streaming
        for (let i = 0; i < fileEntries.length; i += ZIP_CHUNK) {
          if (clientDisconnected) return;
          if (totalChars >= MAX_ZIP_DIGEST_CHARS) {
            isZipTruncated = true;
            break;
          }
          const chunk = fileEntries.slice(i, i + ZIP_CHUNK);
          const chunkResults = await Promise.all(
            chunk.map(async ({ relPath, obj }) => {
              try {
                let content: string;
                let fileHeader = relPath;
                if (relPath.toLowerCase().endsWith('.class')) {
                  const buf = await obj.async('nodebuffer');
                  if (decompile_classes) {
                    content = decompileJavaClass(buf, path.basename(relPath, '.class'));
                    fileHeader += ' [Decompiled Java]';
                  } else {
                    content = '[Binary file: Java Class file]';
                  }
                } else {
                  const buf = await obj.async('nodebuffer');
                  if (buf.length > maxBytes) return null;
                  if (isBinaryBuffer(buf)) {
                    content = '[Binary file]';
                  } else {
                    content = buf.toString('utf-8');
                  }
                }
                return { relPath: fileHeader, content, len: content.length };
              } catch {
                return null;
              }
            })
          );

          for (const item of chunkResults) {
            if (item) {
              totalChars += item.len;
              fileContents.push(
                `================================================\nFile: ${item.relPath}\n================================================\n${item.content}\n`
              );
              const isClass = item.relPath.includes('[Decompiled Java]');
              const isBin = item.content.startsWith('[Binary file');
              sendProgress(
                item.relPath,
                fileContents.length,
                fileEntries.length,
                isClass ? 'decompiling' : isBin ? 'binary' : 'completed'
              );
              if (totalChars >= MAX_ZIP_DIGEST_CHARS) {
                isZipTruncated = true;
                break;
              }
            }
          }
        }

        if (isZipTruncated) {
          fileContents.push(`\n[Notice: Codebase digest capped at 40MB for browser rendering stability. Use subpaths or pattern filters for targeted ingestion.]\n`);
        }

        const estimatedTokens = formatTokenCount(Math.round(totalChars / 4));
        const summaryParts = [
          `Repository: ${owner}/${repo}`,
          resolvedBranch ? `Branch: ${resolvedBranch}` : null,
          subpath ? `Subpath: ${subpath}` : null,
          `Files analyzed: ${fileContents.length}`,
          `Estimated tokens: ${estimatedTokens}`,
          `Total characters: ${totalChars.toLocaleString()}`,
          isZipTruncated ? `(Digest capped at 40MB for browser rendering stability)` : null,
        ].filter(Boolean);

        return sendResult({
          summary: summaryParts.join('\n'),
          tree: `Directory structure:\n${treeText}`,
          content: fileContents.join('\n'),
          repo_name: `${owner}/${repo}`,
          subpath: subpath || undefined,
          files_analyzed: fileContents.length,
          estimated_tokens: estimatedTokens,
          total_chars: totalChars,
        });
      }
    }
  } catch (zipErr) {
    if (clientDisconnected) return;
    // Fall back to git clone if zipball fails
  }

  // FALLBACK: Shallow Git Clone on Disk
  const tempDir = path.join(os.tmpdir(), `gitingest_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`);

  try {
    // If no user token was provided, check if local machine has active GitHub CLI auth
    let effectiveToken = activeToken;
    if (!effectiveToken) {
      try {
        const { stdout: ghToken } = await execFileAsync('gh', ['auth', 'token'], { timeout: 3000 });
        if (ghToken && ghToken.trim()) {
          effectiveToken = ghToken.trim();
        }
      } catch {}
    }

    const cloneUrl = isSshUrl
      ? `git@github.com:${owner}/${repo}.git`
      : effectiveToken
      ? `https://x-access-token:${encodeURIComponent(effectiveToken)}@github.com/${owner}/${repo}.git`
      : `https://github.com/${owner}/${repo}.git`;

    // 1. High-Performance Clone Strategy:
    // If subpath is specified, use blobless + sparse clone without checkout.
    // If full repository, use standard shallow clone (--depth 1) which downloads a single compressed packfile
    // in one fast stream (avoiding on-demand individual HTTP roundtrips per file).
    const cloneArgs = [
      'clone',
      '--depth', '1',
      '--single-branch',
      '--no-tags',
      '-c', 'core.packedGitLimit=128m',
      '-c', 'core.deltaBaseCacheLimit=128m',
    ];
    if (subpath) {
      cloneArgs.push('--filter=blob:none', '--no-checkout', '--sparse');
    }
    if (branch) {
      cloneArgs.push('-b', branch);
    }
    cloneArgs.push(cloneUrl, tempDir);

    try {
      // 5-minute timeout
      await execFileAsync('git', cloneArgs, { timeout: 300000 });
    } catch (gitErr: any) {
      // If git clone fails on local run, attempt GitHub CLI `gh repo clone` fallback
      let ghCloneSucceeded = false;
      try {
        const ghCloneArgs = ['repo', 'clone', `${owner}/${repo}`, tempDir, '--', '--depth', '1', '--single-branch', '--no-tags'];
        if (branch) ghCloneArgs.push('-b', branch);
        await execFileAsync('gh', ghCloneArgs, { timeout: 300000 });
        ghCloneSucceeded = true;
      } catch {}

      if (!ghCloneSucceeded) {
        const errMsg = gitErr.stderr || gitErr.message || '';
        if (errMsg.includes('could not read Username') || errMsg.includes('Authentication failed') || errMsg.includes('Repository not found')) {
          return res.status(403).json({
            error: `Could not access repository "${owner}/${repo}". If this is a private repository, please ensure your GitHub Personal Access Token is configured with 'repo' scope, or run 'gh auth login' locally.`,
          });
        }

        // Fallback: if server rejects options, retry standard minimal shallow clone
        const fallbackArgs = [
          'clone',
          '--depth', '1',
          '--single-branch',
          '--no-tags',
          '-c', 'core.packedGitLimit=128m',
          '-c', 'core.deltaBaseCacheLimit=128m',
        ];
        if (branch) fallbackArgs.push('-b', branch);
        fallbackArgs.push(cloneUrl, tempDir);
        await execFileAsync('git', fallbackArgs, { timeout: 300000 });
      }
    }

    // 2. Optimization: Sparse-checkout & checkout for subpaths
    if (subpath) {
      try {
        await execFileAsync('git', ['-C', tempDir, 'sparse-checkout', 'set', subpath], { timeout: 30000 });
        await execFileAsync('git', ['-C', tempDir, 'checkout'], { timeout: 60000 });
      } catch {
        // Fallback checkout if sparse fails
        try {
          await execFileAsync('git', ['-C', tempDir, 'checkout'], { timeout: 60000 });
        } catch {
          // Continue if already checked out
        }
      }
    }

    const targetRoot = subpath ? path.join(tempDir, subpath) : tempDir;
    if (!fs.existsSync(targetRoot)) {
      return res.status(404).json({ error: `Subpath "${subpath}" does not exist in repository.` });
    }

    const collectedFiles: Array<{ relPath: string; fullPath: string; size: number }> = [];

    // Directory names to immediately prune without recursing
    const PRUNED_DIR_NAMES = new Set([
      '.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'out',
      'target', '.next', '.nuxt', 'coverage', '.cache', 'vendor', 'bin',
      'obj', '.gradle', '.idea', '.vscode', '__pycache__', '.turbo'
    ]);

    // Fast indexed file acquisition via git ls-files if available
    let usedGitLs = false;
    try {
      const { stdout: lsOut } = await execFileAsync('git', ['-C', targetRoot, 'ls-files', '-z'], { timeout: 15000 });
      const rawPaths = lsOut.split('\0').filter(Boolean);
      for (const rel of rawPaths) {
        if (!isPathAllowed(rel)) continue;
        const full = path.join(targetRoot, rel);
        try {
          const stat = await fsPromises.stat(full);
          if (stat.size <= maxBytes) {
            collectedFiles.push({ relPath: rel, fullPath: full, size: stat.size });
          }
        } catch {
          // skip
        }
      }
      usedGitLs = true;
    } catch {
      usedGitLs = false;
    }

    // Fallback directory traversal if git ls-files is unavailable
    if (!usedGitLs) {
      async function walkDirFast(currentDir: string): Promise<void> {
        const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
        await Promise.all(
          entries.map(async (entry) => {
            if (PRUNED_DIR_NAMES.has(entry.name)) return;
            const full = path.join(currentDir, entry.name);
            const rel = path.relative(targetRoot, full).replace(/\\/g, '/');

            if (entry.isDirectory()) {
              await walkDirFast(full);
            } else if (entry.isFile()) {
              if (!isPathAllowed(rel)) return;
              try {
                const stat = await fsPromises.stat(full);
                if (stat.size <= maxBytes) {
                  collectedFiles.push({ relPath: rel, fullPath: full, size: stat.size });
                }
              } catch {
                // skip
              }
            }
          })
        );
      }
      await walkDirFast(targetRoot);
    }

    // Build directory tree
    const paths = collectedFiles.map((f) => f.relPath);
    const treeText = buildAsciiTree(subpath || repo, paths);

    // 3. Optimization: Memory-safe micro-chunked reading for instant live streaming
    const CHUNK_SIZE = 2;
    const fileContents: string[] = [];
    let totalChars = 0;
    const MAX_DIGEST_CHARS = 40 * 1024 * 1024; // 40MB text limit to prevent browser tab & Node.js OOM
    let isTruncated = false;

    for (let i = 0; i < collectedFiles.length; i += CHUNK_SIZE) {
      if (clientDisconnected) return;
      if (totalChars >= MAX_DIGEST_CHARS) {
        isTruncated = true;
        break;
      }

      const chunk = collectedFiles.slice(i, i + CHUNK_SIZE);
      const readResults = await Promise.all(
        chunk.map(async (file) => {
          try {
            const buf = await fsPromises.readFile(file.fullPath);
            let content: string;
            let fileHeader = file.relPath;
            if (file.relPath.toLowerCase().endsWith('.class')) {
              if (decompile_classes) {
                content = decompileJavaClass(buf, path.basename(file.relPath, '.class'));
                fileHeader += ' [Decompiled Java]';
              } else {
                content = '[Binary file: Java Class file]';
              }
            } else if (isBinaryBuffer(buf)) {
              content = '[Binary file]';
            } else {
              content = buf.toString('utf-8');
            }
            return {
              relPath: fileHeader,
              content,
              length: content.length,
            };
          } catch {
            return null;
          }
        })
      );

      for (const resItem of readResults) {
        if (resItem) {
          totalChars += resItem.length;
          fileContents.push(
            `================================================\nFile: ${resItem.relPath}\n================================================\n${resItem.content}\n`
          );
          const isClass = resItem.relPath.includes('[Decompiled Java]');
          const isBin = resItem.content.startsWith('[Binary file');
          sendProgress(
            resItem.relPath,
            fileContents.length,
            collectedFiles.length,
            isClass ? 'decompiling' : isBin ? 'binary' : 'completed'
          );
          if (totalChars >= MAX_DIGEST_CHARS) {
            isTruncated = true;
            break;
          }
        }
      }
    }

    if (isTruncated) {
      fileContents.push(`\n[Notice: Codebase digest capped at 40MB for browser rendering stability. Use subpaths or pattern filters for targeted ingestion.]\n`);
    }

    const fullContent = fileContents.join('\n');
    const estimatedTokens = formatTokenCount(Math.round(totalChars / 4));

    const summaryParts = [
      `Repository: ${owner}/${repo}`,
      branch ? `Branch: ${branch}` : null,
      subpath ? `Subpath: ${subpath}` : null,
      `Files analyzed: ${fileContents.length}`,
      `Estimated tokens: ${estimatedTokens}`,
      `Total characters: ${totalChars.toLocaleString()}`,
      isTruncated ? `(Digest capped at 40MB for browser rendering stability)` : null,
    ].filter(Boolean);

    const summary = summaryParts.join('\n');

    return sendResult({
      summary,
      tree: `Directory structure:\n${treeText}`,
      content: fullContent,
      repo_name: `${owner}/${repo}`,
      subpath: subpath || undefined,
      files_analyzed: fileContents.length,
      estimated_tokens: estimatedTokens,
      total_chars: totalChars,
      mode_switched: wasRateLimited,
      mode_info: wasRateLimited ? 'Switched to Native Git CLI (Rate-limit bypassed)' : (isSshUrl ? 'Native Git CLI (SSH)' : undefined),
    });
  } catch (err: any) {
    if (clientDisconnected) return;
    console.error('Ingestion error:', err);
    return res.status(500).json({ error: err.message || 'Failed to process repository ingestion' });
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (cleanErr) {
      console.error('Failed to cleanup temp dir:', cleanErr);
    }
    // Memory optimization: Prompt V8 to free memory after large digest payloads
    if (typeof global.gc === 'function') {
      setImmediate(() => {
        try {
          global.gc!();
        } catch {}
      });
    }
  }
});

function isBinaryBuffer(buf: Buffer): boolean {
  const maxBytes = Math.min(buf.length, 512);
  for (let i = 0; i < maxBytes; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function buildAsciiTree(rootName: string, paths: string[]): string {
  interface TreeNode {
    [key: string]: TreeNode;
  }
  const root: TreeNode = {};

  for (const p of paths) {
    const parts = p.split('/');
    let curr = root;
    for (const part of parts) {
      if (!curr[part]) curr[part] = {};
      curr = curr[part];
    }
  }

  function render(node: TreeNode, prefix = ''): string {
    const keys = Object.keys(node).sort((a, b) => {
      const aIsDir = Object.keys(node[a]).length > 0;
      const bIsDir = Object.keys(node[b]).length > 0;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.localeCompare(b);
    });

    let result = '';
    keys.forEach((key, index) => {
      const isLast = index === keys.length - 1;
      const isDir = Object.keys(node[key]).length > 0;
      const connector = isLast ? '└── ' : '├── ';
      result += `${prefix}${connector}${key}${isDir ? '/' : ''}\n`;
      if (isDir) {
        result += render(node[key], prefix + (isLast ? '    ' : '│   '));
      }
    });
    return result;
  }

  return `└── ${rootName}/\n${render(root, '    ')}`;
}

async function startServer() {
  // Cleanup any orphaned temp directories from previous crashes/reboots
  try {
    const tmp = os.tmpdir();
    const files = await fsPromises.readdir(tmp);
    for (const f of files) {
      if (f.startsWith('gitingest_')) {
        await fsPromises.rm(path.join(tmp, f), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {}

  const distPath = path.join(process.cwd(), 'dist');
  const isExplicitDev = process.env.NODE_ENV === 'development';
  const hasDist = fs.existsSync(path.join(distPath, 'index.html'));

  if (!isExplicitDev && hasDist) {
    app.use(express.static(distPath, { maxAge: '1d' }));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`GitIngest server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
