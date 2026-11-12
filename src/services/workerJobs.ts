import type { IngestResponse } from '../types';
import { readApiResponse } from './apiResponse';

export interface WorkerJob {
  id: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: IngestResponse;
  error?: string;
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Ingestion cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function waitForWorkerJob(initial: WorkerJob, headers: Record<string, string>, signal?: AbortSignal): Promise<IngestResponse> {
  let job = initial;
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
    }
  } finally { signal?.removeEventListener('abort', cancel); }
}
