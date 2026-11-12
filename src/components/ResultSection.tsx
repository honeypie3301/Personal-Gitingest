import React, { useState, useMemo, useEffect } from 'react';
import { Copy, Check, Download, FolderTree, FileText, BarChart3, Hash, Cpu, XCircle, Timer, AlertCircle, FileArchive, Layers, FolderArchive } from 'lucide-react';
import { IngestResponse } from '../types';
import { IngestionTimer, formatDuration } from './IngestionTimer';
import { artifactUrl, fullDigestSection } from '../services/digestExport';
import { splitDigestSafely, downloadSplitPartsAsZip, SplitPart } from '../services/textSplitter';
import { downloadIndividualFilesAsZip, extractIndividualFiles } from '../services/zipExporter';
import { getSavedMaxOutputSize } from '../services/ingest';

// Threshold above which we avoid mounting a single giant string into a DOM textarea to prevent tab crashes
const MAX_PREVIEW_CHARS = 200_000; // ~200k chars for preview (~50k tokens)

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

interface ResultSectionProps {
  result: IngestResponse | null;
  error: string | null;
  isLoading: boolean;
  startTime?: number | null;
  durationMs?: number | null;
  onCancel?: () => void;
}

export const ResultSection: React.FC<ResultSectionProps> = React.memo(({
  result,
  error,
  isLoading,
  startTime,
  durationMs,
  onCancel,
}) => {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSplittingDownload, setIsSplittingDownload] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [zipProgress, setZipProgress] = useState<{ percent: number; file: string }>({ percent: 0, file: '' });
  const [showBreakdown, setShowBreakdown] = useState(false);

  const breakdownData = useMemo(() => {
    if (!result) return null;
    const extracted = extractIndividualFiles(result);
    if (!extracted || extracted.length === 0) return null;

    const fileStats = extracted.map((f) => {
      const chars = f.text.length;
      const tokens = Math.round(chars / 4);
      return { path: f.path, chars, tokens };
    });

    fileStats.sort((a, b) => b.tokens - a.tokens);

    const totalTokens = fileStats.reduce((sum, f) => sum + f.tokens, 0) || 1;
    const topFiles = fileStats.slice(0, 8);

    const dirMap: Record<string, number> = {};
    for (const f of fileStats) {
      const parts = f.path.split('/');
      const rootDir = parts.length > 1 ? parts[0] + '/' : 'root files';
      dirMap[rootDir] = (dirMap[rootDir] || 0) + f.tokens;
    }

    const dirStats = Object.entries(dirMap)
      .map(([dir, tokens]) => ({ dir, tokens, pct: Math.round((tokens / totalTokens) * 100) }))
      .sort((a, b) => b.tokens - a.tokens);

    return {
      totalFiles: fileStats.length,
      totalTokens,
      topFiles,
      dirStats: dirStats.slice(0, 6),
    };
  }, [result]);

  const handleDownloadZip = async () => {
    if (!result) return;
    try {
      setIsZipping(true);
      setZipProgress({ percent: 0, file: 'Packaging individual files...' });
      await downloadIndividualFilesAsZip(result, undefined, (percent, file) => {
        setZipProgress({ percent, file });
      });
    } catch (err: any) {
      setActionError(err.message || 'ZIP packaging failed');
    } finally {
      setIsZipping(false);
    }
  };

  const splitInfo = useMemo(() => {
    if (!result) return null;
    const maxOutputMb = getSavedMaxOutputSize();
    const maxOutputBytes = maxOutputMb * 1024 * 1024;
    // Lightweight estimation based on character count / content length to avoid main-thread freeze
    const totalLength = (result.total_chars ?? 0) || ((result.summary?.length ?? 0) + (result.tree?.length ?? 0) + (result.content?.length ?? 0));
    const estimatedParts = Math.max(1, Math.ceil(totalLength / maxOutputBytes));
    return {
      isSplit: estimatedParts > 1,
      estimatedParts,
      maxOutputMb,
    };
  }, [result]);
  useEffect(() => {
    setActionError(null);
  }, [result]);

  const estimatedBytes = useMemo(() => {
    if (!result) return 0;
    if (result.content_chars) return result.content_chars;
    if (result.total_chars) return result.total_chars;
    return result.content ? result.content.length : 0;
  }, [result]);

  const summaryWithFileSize = useMemo(() => {
    if (!result?.summary) return '';
    const formattedSize = formatBytes(estimatedBytes);
    const modeLabel = result.output_format === 'zip' ? 'Individual Files (.zip)' : 'Text Digest (.txt)';
    const lines = result.summary.split('\n');

    // Insert Mode and File size
    if (!lines.some((l) => /ingestion mode:/i.test(l))) {
      lines.push(`Ingestion mode: ${modeLabel}`);
    }
    if (!lines.some((l) => /(?:file\s*size|estimated\s*size|size):/i.test(l))) {
      const totalCharsIndex = lines.findIndex((l) => /total characters:/i.test(l));
      if (totalCharsIndex !== -1) {
        lines.splice(totalCharsIndex + 1, 0, `File size: ${formattedSize}`);
      } else {
        lines.push(`File size: ${formattedSize}`);
      }
    }
    return lines.join('\n');
  }, [result?.summary, result?.output_format, estimatedBytes]);

  const isHugeContent = useMemo(() => {
    return Boolean(result?.content_preview_truncated || (result?.content && result.content.length > MAX_PREVIEW_CHARS));
  }, [result?.content, result?.content_preview_truncated]);

  const displayedContent = useMemo(() => {
    if (!result?.content) return '';
    if (!isHugeContent) return result.content;
    return `${result.content.slice(0, MAX_PREVIEW_CHARS)}\n\n--- [PREVIEW TRUNCATED TO PREVENT BROWSER FREEZE: Remaining ${((result.content_chars ?? result.content.length) - MAX_PREVIEW_CHARS).toLocaleString()} characters omitted from preview. Use 'Copy Digest' or 'Download' to get the full file] ---`;
  }, [result?.content, result?.content_chars, isHugeContent]);

  const handleCopy = async (sectionName: 'all' | 'tree' | 'content') => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(await fullDigestSection(result, sectionName));
      setActionError(null);
      setCopiedSection(sectionName);
      setTimeout(() => {
        setCopiedSection((curr) => (curr === sectionName ? null : curr));
      }, 2000);
    } catch (error: any) { setActionError(error.message || 'Unable to copy. Use Download instead.'); }
  };

  const getDownloadFilename = () => {
    if (!result) return 'digest.txt';
    const baseRepo = (result.repo_name || 'repository').replace(/[\/\\:]/g, '_');
    if (result.subpath) {
      const cleanSub = result.subpath.replace(/^[\/\\]+|[\/\\]+$/g, '').replace(/[\/\\:]/g, '_');
      if (cleanSub) {
        return `${baseRepo}_${cleanSub}_digest.txt`;
      }
    }
    return `${baseRepo}_digest.txt`;
  };

  const handleDownload = async () => {
    if (!result) return;
    const filename = getDownloadFilename();
    const maxOutputMb = getSavedMaxOutputSize();
    const maxOutputBytes = maxOutputMb * 1024 * 1024;

    try {
      setIsSplittingDownload(true);
      let fullText: string;
      if (result.artifact_url) {
        fullText = await fullDigestSection(result, 'all');
      } else {
        fullText = `${result.summary}\n\n${result.tree}\n\n${result.content}`;
      }

      const parts = splitDigestSafely(fullText, maxOutputBytes, filename);

      if (parts.length > 1) {
        // Output text file size exceeds user threshold: split into safe parts inside a zip package
        const zipFilename = filename.replace(/\.txt$/i, '') + `_split_${parts.length}_parts.zip`;
        await downloadSplitPartsAsZip(parts, zipFilename);
      } else {
        // Single file within max output threshold
        const blob = new Blob([parts[0].content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = parts[0].filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      setActionError(err.message || 'Download failed');
    } finally {
      setIsSplittingDownload(false);
    }
  };

  if (isLoading) {
    return (
      <div className="w-full max-w-6xl 2xl:max-w-7xl mx-auto mt-8 px-2 sm:px-4">
        <div className="relative">
          <div className="w-full h-full absolute inset-0 bg-black rounded-xl translate-y-2 translate-x-2"></div>
          <div className="bg-[#161b22] rounded-xl border-[3px] border-[#30363d] p-8 sm:p-12 relative z-20 flex flex-col items-center justify-center space-y-4">
            <div className="w-14 h-14 border-4 border-[#30363d] border-t-4 border-t-amber-400 rounded-full animate-spin"></div>
            <div className="text-center space-y-1.5">
              <p className="text-xl font-extrabold text-white">Ingesting repository...</p>
              {startTime && (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#0d1117] border border-[#30363d] text-gray-300 font-mono text-xs sm:text-sm">
                  <Timer className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
                  <span>
                    Ingesting for:{' '}
                    <span className="text-amber-400 font-bold">
                      <IngestionTimer startTime={startTime} />
                    </span>
                  </span>
                </div>
              )}
            </div>
            <p className="text-sm text-gray-400 text-center max-w-md">
              Downloading repository archive, analyzing directory tree, filtering patterns, and consolidating codebase digest.
            </p>
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="mt-2 px-5 py-2.5 rounded-xl bg-red-600/90 hover:bg-red-500 border-2 border-red-700 text-white font-extrabold text-xs sm:text-sm flex items-center gap-2 cursor-pointer transition-transform active:translate-y-0.5 shadow-[2px_2px_0_0_#000000]"
              >
                <XCircle className="w-4 h-4" />
                <span>Cancel Ingestion</span>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full max-w-6xl 2xl:max-w-7xl mx-auto mt-8 px-2 sm:px-4">
        <div className="relative">
          <div className="w-full h-full absolute inset-0 bg-black rounded-xl translate-y-2 translate-x-2"></div>
          <div className="bg-red-950/40 rounded-xl border-[3px] border-red-700/60 p-6 relative z-20">
            <h4 className="text-base font-bold text-red-300 mb-1">Ingestion Notice</h4>
            <p className="text-sm text-red-200 leading-relaxed font-medium">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!result) return null;

  return (
    <div className="w-full max-w-6xl 2xl:max-w-7xl mx-auto mt-8 px-2 sm:px-4 space-y-6">
      {actionError && <p role="alert" className="text-red-300">{actionError}</p>}
      {/* Quick Metrics Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-[#161b22] border-2 border-[#30363d] rounded-xl p-3 flex items-center gap-2.5 shadow-[2px_2px_0_0_#000000]">
          <BarChart3 className="w-5 h-5 text-amber-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase font-bold text-gray-400">Files Analyzed</div>
            <div className="text-base font-extrabold text-white truncate">{result.files_analyzed ?? '0'}</div>
          </div>
        </div>

        <div className="bg-[#161b22] border-2 border-[#30363d] rounded-xl p-3 flex items-center gap-2.5 shadow-[2px_2px_0_0_#000000]">
          <Cpu className="w-5 h-5 text-emerald-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase font-bold text-gray-400">Tokens Estimate</div>
            <div className="text-base font-extrabold text-white truncate">{result.estimated_tokens ?? '0'}</div>
          </div>
        </div>

        <div className="bg-[#161b22] border-2 border-[#30363d] rounded-xl p-3 flex items-center gap-2.5 shadow-[2px_2px_0_0_#000000]">
          <Hash className="w-5 h-5 text-sky-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase font-bold text-gray-400">Characters</div>
            <div className="text-base font-extrabold text-white truncate">
              {result.total_chars ? result.total_chars.toLocaleString() : '0'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => handleCopy('all')}
            className="flex-1 h-full py-2.5 px-3 bg-amber-500 hover:bg-amber-400 border-2 border-amber-600 text-gray-950 font-extrabold rounded-xl text-xs sm:text-sm transition-transform active:translate-y-0.5 shadow-[2px_2px_0_0_#000000] flex items-center justify-center gap-1.5 cursor-pointer"
          >
            {copiedSection === 'all' ? (
              <>
                <Check className="w-4 h-4 text-emerald-950" />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                <span>Copy Digest</span>
              </>
            )}
          </button>

          <button
            onClick={handleDownload}
            disabled={isSplittingDownload}
            className="h-full py-2.5 px-3 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-50 border-2 border-[#30363d] text-white font-bold rounded-xl text-xs sm:text-sm transition-transform active:translate-y-0.5 shadow-[2px_2px_0_0_#000000] flex items-center justify-center gap-1.5 cursor-pointer"
            title={splitInfo?.isSplit ? `Download ${splitInfo.estimatedParts} split text files in .zip package` : "Download full digest as .txt file"}
          >
            {splitInfo?.isSplit ? <FileArchive className="w-4 h-4 text-amber-400" /> : <Download className="w-4 h-4" />}
            <span className="hidden sm:inline">
              {isSplittingDownload
                ? 'Packaging...'
                : splitInfo?.isSplit
                ? `Download (~${splitInfo.estimatedParts} parts)`
                : 'Download'}
            </span>
          </button>

          <button
            onClick={handleDownloadZip}
            disabled={isZipping}
            className="h-full py-2.5 px-3 bg-[#1e242c] hover:bg-[#28323d] disabled:opacity-50 border-2 border-amber-500/50 hover:border-amber-400 text-amber-300 font-bold rounded-xl text-xs sm:text-sm transition-transform active:translate-y-0.5 shadow-[2px_2px_0_0_#000000] flex items-center justify-center gap-1.5 cursor-pointer"
            title="Download all repository files individually packaged in a structured .zip archive"
          >
            <FolderArchive className="w-4 h-4 text-amber-400" />
            <span className="hidden sm:inline">
              {isZipping ? `Zipping (${zipProgress.percent}%)...` : 'Download ZIP'}
            </span>
          </button>
        </div>
      </div>

      {splitInfo?.isSplit && (
        <div className="bg-sky-500/10 border-2 border-sky-500/40 rounded-xl px-4 py-2.5 text-xs font-mono text-sky-200 shadow-[2px_2px_0_0_#000000] flex items-center gap-2.5">
          <Layers className="w-4 h-4 text-sky-400 shrink-0" />
          <div>
            <strong className="text-sky-300">Auto-Split Active:</strong> Total digest exceeds your configured <strong>{splitInfo.maxOutputMb} MB</strong> limit. Content will be safely partitioned into approximately <strong>{splitInfo.estimatedParts} text files</strong> (packaged as a .zip) along file boundaries without truncating code.
          </div>
        </div>
      )}

      {(result.mode_switched || (typeof window !== 'undefined' && localStorage.getItem('gitingest_fallback_active') === 'true')) && (
        <div className="bg-amber-500/10 border-2 border-amber-500/50 rounded-xl px-4 py-3 text-xs font-mono text-amber-300 shadow-[2px_2px_0_0_#000000] flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <div className="min-w-0">
              <span className="font-bold text-amber-400 uppercase tracking-wide mr-2">[⚠ RATE-LIMIT FALLBACK ACTIVE]</span>
              <span>GitHub API rate limit was encountered. Switched to offline Native Git CLI to complete your ingestion without interruption.</span>
            </div>
          </div>
          <button
            onClick={() => {
              try {
                localStorage.removeItem('gitingest_fallback_active');
                window.location.reload();
              } catch {}
            }}
            className="text-[11px] underline text-amber-400 hover:text-amber-200 cursor-pointer shrink-0"
            title="Reset fallback status"
          >
            Dismiss
          </button>
        </div>
      )}

      {result.mode_info && !result.mode_switched && (
        <div className="bg-[#161b22] border-2 border-[#30363d] rounded-xl px-4 py-2.5 text-xs font-mono text-amber-400 shadow-[2px_2px_0_0_#000000] flex items-center justify-between">
          <span className="font-bold uppercase tracking-wider text-gray-400">Mode:</span>
          <span className="font-semibold text-amber-300">{result.mode_info}</span>
        </div>
      )}

      {/* Main Container */}
      <div className="relative">
        <div className="w-full h-full absolute inset-0 bg-black rounded-2xl translate-y-2 translate-x-2"></div>
        <div className="bg-[#161b22] rounded-2xl border-[3px] border-[#30363d] p-4 sm:p-6 lg:p-8 relative z-20 space-y-6 text-gray-100">
          
          {/* Token Breakdown Visualizer Toggle Bar */}
          {breakdownData && (
            <div className="flex items-center justify-between pb-1 border-b border-[#30363d]">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-amber-400" />
                <span className="text-xs sm:text-sm font-extrabold text-white uppercase tracking-wider">
                  Token Breakdown & Distribution
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowBreakdown((prev) => !prev)}
                className={`px-3 py-1 rounded-lg text-xs font-bold border-2 transition-all flex items-center gap-1.5 cursor-pointer shadow-[1px_1px_0_0_#000000] ${
                  showBreakdown
                    ? 'bg-amber-500 text-gray-950 border-amber-600'
                    : 'bg-[#21262d] text-amber-300 border-[#30363d] hover:bg-[#30363d]'
                }`}
              >
                <span>{showBreakdown ? 'Hide Breakdown' : 'Show Token Breakdown'}</span>
              </button>
            </div>
          )}

          {/* Token & File Breakdown Visualizer Panel */}
          {showBreakdown && breakdownData && (
            <div className="bg-[#0d1117] border-[3px] border-[#30363d] rounded-xl p-4 space-y-4 font-mono text-xs shadow-[2px_2px_0_0_#000000] animate-in fade-in duration-200">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Top Token Consumers */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-amber-400 font-bold border-b border-[#30363d] pb-1 text-[11px] uppercase tracking-wider">
                    <span>Top Token-Heavy Files</span>
                    <span>Tokens (% share)</span>
                  </div>
                  <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                    {breakdownData.topFiles.map((file) => {
                      const pct = Math.round((file.tokens / breakdownData.totalTokens) * 100);
                      return (
                        <div key={file.path} className="space-y-0.5">
                          <div className="flex items-center justify-between text-gray-300 text-[11px]">
                            <span className="truncate max-w-[220px]" title={file.path}>
                              {file.path}
                            </span>
                            <span className="text-amber-300 font-bold shrink-0">
                              {file.tokens.toLocaleString()} ({pct}%)
                            </span>
                          </div>
                          <div className="w-full bg-[#161b22] h-1.5 rounded-full overflow-hidden border border-[#30363d]">
                            <div
                              className="bg-amber-400 h-full rounded-full transition-all duration-300"
                              style={{ width: `${Math.max(4, pct)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Directory Token Distribution */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-amber-400 font-bold border-b border-[#30363d] pb-1 text-[11px] uppercase tracking-wider">
                    <span>Folder Share</span>
                    <span>Tokens</span>
                  </div>
                  <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                    {breakdownData.dirStats.map((dir) => (
                      <div key={dir.dir} className="space-y-0.5">
                        <div className="flex items-center justify-between text-gray-300 text-[11px]">
                          <span className="truncate max-w-[180px] font-bold text-gray-200">
                            {dir.dir}
                          </span>
                          <span className="text-amber-300 font-bold shrink-0">
                            {dir.tokens.toLocaleString()} ({dir.pct}%)
                          </span>
                        </div>
                        <div className="w-full bg-[#161b22] h-1.5 rounded-full overflow-hidden border border-[#30363d]">
                          <div
                            className="bg-amber-500 h-full rounded-full transition-all duration-300"
                            style={{ width: `${Math.max(4, dir.pct)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Top Row: Summary & Tree */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            {/* Summary column */}
            <div className="lg:col-span-5 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-base sm:text-lg font-extrabold text-white flex items-center gap-2">
                  <span>Summary</span>
                  {durationMs !== undefined && durationMs !== null && (
                    <span className="text-xs font-mono font-bold text-amber-400 bg-[#0d1117] border border-[#30363d] px-2 py-0.5 rounded-full flex items-center gap-1">
                      <Timer className="w-3 h-3 text-amber-400" />
                      {formatDuration(durationMs)}
                    </span>
                  )}
                </h3>
                <span className="text-xs text-gray-400 font-mono">Overview</span>
              </div>
              <div className="relative flex-1 min-h-[180px]">
                <div className="w-full h-full rounded bg-black translate-y-1 translate-x-1 absolute inset-0"></div>
                <textarea
                  value={summaryWithFileSize}
                  readOnly
                  className="w-full h-full min-h-[180px] p-4 bg-[#0d1117] border-[3px] border-[#30363d] rounded font-mono text-xs sm:text-sm resize-none focus:outline-none relative z-10 text-amber-300"
                />
              </div>
            </div>

            {/* Directory Structure Column */}
            <div className="lg:col-span-7 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-base sm:text-lg font-extrabold text-white flex items-center gap-2">
                  <FolderTree className="w-5 h-5 text-amber-400" />
                  <span>Directory Structure</span>
                </h3>
                <button
                  onClick={() => handleCopy('tree')}
                  className="px-3 py-1 bg-[#21262d] hover:bg-[#30363d] border-[2px] border-[#30363d] text-amber-400 font-bold rounded text-xs transition-transform shadow-[1px_1px_0_0_#000000] flex items-center gap-1.5 cursor-pointer"
                >
                  {copiedSection === 'tree' ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Tree</span>
                    </>
                  )}
                </button>
              </div>

              <div className="relative flex-1 min-h-[220px]">
                <div className="w-full h-full rounded bg-black translate-y-1 translate-x-1 absolute inset-0"></div>
                <div className="w-full h-full min-h-[220px] max-h-[360px] p-4 bg-[#0d1117] border-[3px] border-[#30363d] rounded font-mono text-xs sm:text-sm overflow-auto relative z-10 text-emerald-400 whitespace-pre">
                  {result.tree}
                  {result.tree_preview_truncated && '\n[Tree preview limited. Copy Tree or Download includes the complete tree.]'}
                </div>
              </div>
            </div>
          </div>

          {/* Files Content Section */}
          <div className="pt-2 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base sm:text-lg font-extrabold text-white flex items-center gap-2">
                <FileText className="w-5 h-5 text-amber-400" />
                <span>Files Content</span>
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleCopy('content')}
                  className="px-3 py-1 bg-[#21262d] hover:bg-[#30363d] border-[2px] border-[#30363d] text-amber-400 font-bold rounded text-xs transition-transform shadow-[1px_1px_0_0_#000000] flex items-center gap-1.5 cursor-pointer"
                >
                  {copiedSection === 'content' ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Content</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="relative">
              <div className="w-full h-full rounded bg-black translate-y-1 translate-x-1 absolute inset-0"></div>
              <textarea
                value={displayedContent}
                readOnly
                className="w-full h-[55vh] min-h-[350px] p-4 bg-[#0d1117] border-[3px] border-[#30363d] rounded font-mono text-xs sm:text-sm resize-none focus:outline-none relative z-10 text-gray-200 leading-relaxed"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
