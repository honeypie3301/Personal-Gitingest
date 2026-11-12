import JSZip from 'jszip';
import { IngestResponse } from '../types';

export interface ExtractedFile {
  path: string;
  text: string;
}

/**
 * Extracts individual files from an IngestResponse (either from response.files or parsed from response.content).
 */
export function extractIndividualFiles(result: IngestResponse): ExtractedFile[] {
  if (result.files && result.files.length > 0) {
    return result.files.map((f) => ({
      path: f.path,
      text: f.text ?? '',
    }));
  }

  if (!result.content) return [];

  const delimiter = '================================================\nFile: ';
  if (!result.content.includes(delimiter)) return [];

  const chunks = result.content.split(delimiter);
  const files: ExtractedFile[] = [];

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const newlineIdx = chunk.indexOf('\n');
    if (newlineIdx === -1) continue;

    const filePath = chunk.slice(0, newlineIdx).trim();
    const rest = chunk.slice(newlineIdx + 1);

    const secondBarIdx = rest.indexOf('================================================\n');
    if (secondBarIdx === -1) continue;

    const fileText = rest.slice(secondBarIdx + 49);
    files.push({
      path: filePath,
      text: fileText.replace(/\r\n/g, '\n'),
    });
  }

  return files;
}

/**
 * Normalizes file paths for ZIP archives:
 * - Strips leading / and \
 * - Converts decompiled java paths e.g. 'Class.class [Decompiled Java]' to 'Class.java'
 */
export function normalizeZipPath(rawPath: string): string {
  let clean = rawPath.replace(/^[\\/]+/, '').trim();
  if (clean.endsWith(' [Decompiled Java]')) {
    clean = clean.replace(/\.class\s*\[Decompiled Java\]$/i, '.java');
  }
  return clean;
}

/**
 * Creates and downloads a .zip archive where each ingested file is individually placed
 * in its respective directory structure, with optional SUMMARY.txt and DIRECTORY_STRUCTURE.txt.
 */
export async function downloadIndividualFilesAsZip(
  result: IngestResponse,
  customZipName?: string,
  onProgress?: (percent: number, currentFile: string) => void
): Promise<void> {
  const files = extractIndividualFiles(result);
  const zip = new JSZip();

  // 1. Add SUMMARY and Directory Structure metadata files
  if (result.summary) {
    zip.file('SUMMARY.txt', result.summary);
  }
  if (result.tree) {
    zip.file('DIRECTORY_STRUCTURE.txt', result.tree);
  }

  // 2. Add individual files preserving directory hierarchy
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const zipPath = normalizeZipPath(file.path);
    if (zipPath) {
      zip.file(zipPath, file.text);
    }
    if (onProgress && i % 10 === 0) {
      onProgress(Math.round(((i + 1) / (files.length || 1)) * 50), zipPath);
    }
  }

  // 3. Generate ZIP binary blob with compression
  const blob = await zip.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    },
    (metadata) => {
      if (onProgress) {
        onProgress(50 + Math.round(metadata.percent / 2), metadata.currentFile || 'Compressing archive...');
      }
    }
  );

  // 4. Determine file name
  const repoSlug = (result.repo_name || 'repository').replace(/[/\\:]/g, '_');
  const subSlug = result.subpath
    ? `_${result.subpath.replace(/^[/\\]+|[/\\]+$/g, '').replace(/[/\\:]/g, '_')}`
    : '';
  const finalFilename = customZipName || `${repoSlug}${subSlug}_files.zip`;

  // 5. Trigger download
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = finalFilename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
