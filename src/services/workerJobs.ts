import type { IngestFileEvent, IngestResponse } from '../types';
import { readApiResponse } from './apiResponse';

export interface WorkerJob {
  id: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: IngestResponse;
  error?: string;
  progress?: IngestFileEvent[];
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Ingestion cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function waitForWorkerJob(
  initial: WorkerJob,
  headers: Record<string, string>,
  signal?: AbortSignal,
  onProgress?: (event: IngestFileEvent) => void
): Promise<IngestResponse> {
  let job = initial;
  let lastProgressCount = 0;
  const emitProgress = (next: WorkerJob) => {
    for (const event of next.progress || []) {
      if (event.count <= lastProgressCount) continue;
      onProgress?.(event);
      lastProgressCount = event.count;
    }
  };
  emitProgress(job);
  const url = `/api/ingest/jobs/${encodeURIComponent(job.id)}`;
  const cancel = () => { void fetch(url, { method: 'DELETE', headers, keepalive: true }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) { cancel(); signal.throwIfAborted(); }
    while (true) {
      signal?.throwIfAborted();
      if (job.state === 'completed' && job.result) return {
        ...job.result,
        refreshArtifactUrl: async () => {
          const response = await fetch(url, { headers, cache: 'no-store' });
          const refreshed = await readApiResponse(response, 'Unable to refresh export');
          if (!response.ok || !refreshed.result?.artifact_url) throw new Error(refreshed.error || 'Export expired. Please ingest again.');
          return refreshed.result.artifact_url;
        },
      };
      if (job.state === 'failed' || job.state === 'cancelled') throw new Error(job.error || `Ingestion ${job.state}.`);
      await wait(1500, signal);
      const response = await fetch(url, { headers, signal, cache: 'no-store' });
      const data = await readApiResponse<WorkerJob>(response, 'Unable to read ingestion progress');
      if (!response.ok) throw new Error(data.error || 'Unable to read ingestion progress.');
      job = data;
      emitProgress(job);
    }
  } finally { signal?.removeEventListener('abort', cancel); }
}
