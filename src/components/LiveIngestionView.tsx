import React, { useMemo } from 'react';
import { IngestFileEvent } from '../types';
import { CheckCircle2, Cpu, X } from 'lucide-react';

interface LiveIngestionViewProps {
  events: IngestFileEvent[];
  isLoading: boolean;
  onClose?: () => void;
  onClear?: () => void;
}

function getFileTypeInfo(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.class')) {
    return { label: 'Decompiled Java', color: 'bg-purple-500/20 text-purple-300 border-purple-500/40' };
  }
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
    return { label: 'TS / React', color: 'bg-sky-500/20 text-sky-300 border-sky-500/40' };
  }
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) {
    return { label: 'JavaScript', color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' };
  }
  if (lower.endsWith('.py')) {
    return { label: 'Python', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' };
  }
  if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) {
    return { label: 'Config', color: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40' };
  }
  if (lower.endsWith('.md') || lower.endsWith('.txt')) {
    return { label: 'Docs', color: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40' };
  }
  return { label: 'Code', color: 'bg-gray-500/20 text-gray-300 border-gray-500/40' };
}

export const LiveIngestionView: React.FC<LiveIngestionViewProps> = React.memo(({
  events,
  isLoading,
  onClose,
  onClear,
}) => {
  const totalCount = events.length > 0 ? (events[events.length - 1].total || events.length) : 0;
  const currentCount = events.length > 0 ? events[events.length - 1].count : 0;

  // Performance optimization: limit DOM nodes to latest 150 items (no auto-scroll)
  const visibleEvents = useMemo(() => {
    return events.length > 150 ? events.slice(-150) : events;
  }, [events]);

  return (
    <div className="mt-3 relative z-20">
      <div className="w-full h-full absolute inset-0 bg-black rounded-xl translate-y-1 translate-x-1"></div>
      <div className="relative z-10 bg-[#0d1117] border-[3px] border-[#30363d] rounded-xl p-3 text-xs font-mono shadow-[2px_2px_0_0_#000000]">
        
        {/* Header Bar */}
        <div className="flex items-center justify-between pb-2 mb-2 border-b-2 border-[#30363d] gap-2">
          <div className="flex items-center gap-2">
            <span className="font-extrabold uppercase text-amber-400 tracking-wider text-[11px] sm:text-xs">
              Live Ingestion Process
            </span>
          </div>

          <div className="flex items-center gap-3">
            {totalCount > 0 && (
              <span className="text-[11px] font-mono text-gray-300">
                Files: <strong className="text-amber-400 font-bold">{currentCount}</strong>{totalCount ? ` / ${totalCount}` : ''}
              </span>
            )}

            {onClear && events.length > 0 && (
              <button
                type="button"
                onClick={onClear}
                className="text-[10px] text-gray-400 hover:text-amber-400 transition-colors cursor-pointer uppercase font-bold"
              >
                Clear Log
              </button>
            )}

            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="text-gray-400 hover:text-white p-1 rounded hover:bg-[#21262d] transition-colors cursor-pointer"
                title="Hide Live View"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Scrollable File Stream List (Compact, no auto-scroll) */}
        <div className="max-h-44 overflow-y-auto space-y-1 pr-1 scrollbar-thin scrollbar-thumb-amber-500/40">
          {visibleEvents.length === 0 ? (
            <div className="py-4 text-center text-gray-500 text-xs flex flex-col items-center gap-1.5">
              <Cpu className="w-4 h-4 text-gray-600" />
              <span>Waiting for ingestion stream to begin...</span>
            </div>
          ) : (
            visibleEvents.map((ev, idx) => {
              const typeInfo = getFileTypeInfo(ev.path);
              return (
                <div
                  key={`${ev.path}_${idx}`}
                  className="flex items-center justify-between px-2.5 py-1 rounded bg-[#161b22] border border-[#30363d] hover:border-amber-500/50 transition-all text-[11px] group gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="text-[10px] text-gray-500 w-6 shrink-0 text-right">
                      #{ev.count || idx + 1}
                    </span>
                    <span className="truncate text-gray-200 font-semibold group-hover:text-amber-300 transition-colors">
                      {ev.path}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-tight ${typeInfo.color}`}
                    >
                      {typeInfo.label}
                    </span>
                    {ev.status === 'decompiling' ? (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/40 flex items-center gap-1">
                        <Cpu className="w-2.5 h-2.5 animate-spin" />
                        <span>Decompiling</span>
                      </span>
                    ) : ev.status === 'binary' ? (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                        Binary
                      </span>
                    ) : (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center gap-0.5">
                        <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" />
                        <span>Ingested</span>
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
});
