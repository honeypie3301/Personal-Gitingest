import React, { useState, useEffect, useRef } from 'react';
import { ArrowRight, ShieldCheck, Key, RefreshCw, ChevronDown, Lock, FolderGit2, XCircle, Check, Clock, X, Star } from 'lucide-react';
import { IngestRequest, PatternType, TokenStatus } from '../types';
import { getSavedPatterns, savePatterns, getSavedToken, getSavedDecompileClasses, saveDecompileClasses, getSavedMaxOutputSize, saveMaxOutputSize } from '../services/ingest';
import { fetchUserRepos, RepoSummary } from '../services/githubApi';
import { IngestionTimer } from './IngestionTimer';
import {
  getRecentIngests,
  addRecentIngest,
  removeRecentIngest,
  clearRecentIngests,
  formatTimeAgo,
  RecentIngest,
} from '../services/ingestionHistory';
import {
  getPatternItems,
  addRecentPattern,
  toggleFavoritePattern,
  removePatternItem,
  clearRecentPatterns,
  PatternItem,
} from '../services/patternHistory';

interface GitFormProps {
  onIngest: (req: IngestRequest) => void;
  isLoading: boolean;
  startTime?: number | null;
  tokenStatus: TokenStatus;
  onOpenTokenModal: () => void;
  onCancel?: () => void;
  initialUrl?: string;
  onUrlChange?: (url: string) => void;
}

type SizeUnit = 'KB' | 'MB' | 'GB';

export const GitForm: React.FC<GitFormProps> = React.memo(({
  onIngest,
  isLoading,
  startTime,
  tokenStatus,
  onOpenTokenModal,
  onCancel,
  initialUrl = '',
  onUrlChange,
}) => {
  const [url, setUrl] = useState(initialUrl);

  useEffect(() => {
    setUrl(initialUrl);
  }, [initialUrl]);
  const [patternType, setPatternType] = useState<PatternType>('exclude');
  const [pattern, setPattern] = useState('');
  const [maxFileSize, setMaxFileSize] = useState(50); // In MB
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('MB');
  const [displaySize, setDisplaySize] = useState('50');

  // Max Output Text File Size (Split threshold, max 1024 MB = 1 GB)
  const [maxOutputSize, setMaxOutputSize] = useState(50); // In MB
  const [outputUnit, setOutputUnit] = useState<SizeUnit>('MB');
  const [displayOutputSize, setDisplayOutputSize] = useState('50');

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isUnitDropdownOpen, setIsUnitDropdownOpen] = useState(false);
  const [isOutputUnitDropdownOpen, setIsOutputUnitDropdownOpen] = useState(false);
  const [isPatternHistoryOpen, setIsPatternHistoryOpen] = useState(false);
  const [patternFavorites, setPatternFavorites] = useState<PatternItem[]>([]);
  const [patternRecents, setPatternRecents] = useState<PatternItem[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const unitDropdownRef = useRef<HTMLDivElement>(null);
  const outputUnitDropdownRef = useRef<HTMLDivElement>(null);
  const patternInputContainerRef = useRef<HTMLDivElement>(null);

  const [userRepos, setUserRepos] = useState<RepoSummary[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [decompileClasses, setDecompileClasses] = useState(false);
  const [recentIngests, setRecentIngests] = useState<RecentIngest[]>([]);

  useEffect(() => {
    const saved = getSavedPatterns();
    setPatternType(saved.type);
    setPattern(saved.pattern);
    const savedMb = saved.maxFileSize || 50;
    setMaxFileSize(savedMb);
    setDisplaySize(String(savedMb));
    setSizeUnit('MB');

    const savedOutMb = saved.maxOutputSize || getSavedMaxOutputSize() || 50;
    setMaxOutputSize(savedOutMb);
    setDisplayOutputSize(String(savedOutMb));
    setOutputUnit('MB');

    setDecompileClasses(getSavedDecompileClasses());
    setRecentIngests(getRecentIngests());

    const { favorites, recents } = getPatternItems();
    setPatternFavorites(favorites);
    setPatternRecents(recents);

    loadDynamicRepos();
  }, [tokenStatus]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
      if (unitDropdownRef.current && !unitDropdownRef.current.contains(event.target as Node)) {
        setIsUnitDropdownOpen(false);
      }
      if (outputUnitDropdownRef.current && !outputUnitDropdownRef.current.contains(event.target as Node)) {
        setIsOutputUnitDropdownOpen(false);
      }
      if (patternInputContainerRef.current && !patternInputContainerRef.current.contains(event.target as Node)) {
        setIsPatternHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const refreshPatternItems = () => {
    const { favorites, recents } = getPatternItems();
    setPatternFavorites(favorites);
    setPatternRecents(recents);
  };

  const handleSelectPatternItem = (item: PatternItem) => {
    setPatternType(item.type);
    setPattern(item.pattern);
    savePatterns(item.type, item.pattern, maxFileSize);
    setIsPatternHistoryOpen(false);
  };

  const handleToggleStar = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!pattern.trim()) return;
    toggleFavoritePattern(pattern, patternType);
    refreshPatternItems();
  };

  const handleDeletePatternItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removePatternItem(id);
    refreshPatternItems();
  };

  const handleClearRecents = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearRecentPatterns();
    refreshPatternItems();
  };

  const loadDynamicRepos = async () => {
    const token = getSavedToken();
    const userLogin = tokenStatus.user?.login;
    if (!token && !userLogin) {
      setUserRepos([]);
      return;
    }
    setIsLoadingRepos(true);
    const repos = await fetchUserRepos(token || undefined, userLogin);
    setUserRepos(repos);
    setIsLoadingRepos(false);
  };

  const handleDecompileChange = (enabled: boolean) => {
    setDecompileClasses(enabled);
    saveDecompileClasses(enabled);
  };

  const handlePatternTypeSelect = (type: PatternType) => {
    setPatternType(type);
    savePatterns(type, pattern, maxFileSize);
    setIsDropdownOpen(false);
  };

  const handlePatternChange = (newPattern: string) => {
    setPattern(newPattern);
    savePatterns(patternType, newPattern, maxFileSize);
  };

  const convertToMb = (val: number, unit: SizeUnit): number => {
    if (unit === 'KB') return +(val / 1024).toFixed(4);
    if (unit === 'GB') return +(val * 1024).toFixed(2);
    return +val.toFixed(2);
  };

  const convertFromMb = (mb: number, unit: SizeUnit): number => {
    if (unit === 'KB') return Math.round(mb * 1024);
    if (unit === 'GB') return +(mb / 1024).toFixed(2);
    return +mb.toFixed(2);
  };

  const handleUnitChange = (newUnit: SizeUnit) => {
    setSizeUnit(newUnit);
    setIsUnitDropdownOpen(false);
    const converted = convertFromMb(maxFileSize, newUnit);
    setDisplaySize(String(converted));
  };

  const handleSizeInputChange = (rawVal: string) => {
    setDisplaySize(rawVal);
    const num = parseFloat(rawVal);
    if (!isNaN(num) && num > 0) {
      const mb = convertToMb(num, sizeUnit);
      handleFileSizeChange(mb);
    }
  };

  const handleSliderChange = (sliderVal: number) => {
    setDisplaySize(String(sliderVal));
    const mb = convertToMb(sliderVal, sizeUnit);
    handleFileSizeChange(mb);
  };

  const handleFileSizeChange = (newSize: number) => {
    setMaxFileSize(newSize);
    savePatterns(patternType, pattern, newSize, maxOutputSize);
  };

  const handleOutputUnitChange = (newUnit: SizeUnit) => {
    setOutputUnit(newUnit);
    setIsOutputUnitDropdownOpen(false);
    const converted = convertFromMb(maxOutputSize, newUnit);
    setDisplayOutputSize(String(converted));
  };

  const handleOutputSizeInputChange = (rawVal: string) => {
    setDisplayOutputSize(rawVal);
    const num = parseFloat(rawVal);
    if (!isNaN(num) && num > 0) {
      const mb = Math.min(1024, Math.max(0.01, convertToMb(num, outputUnit)));
      setMaxOutputSize(mb);
      saveMaxOutputSize(mb);
      savePatterns(patternType, pattern, maxFileSize, mb);
    }
  };

  const handleOutputSliderChange = (sliderVal: number) => {
    setDisplayOutputSize(String(sliderVal));
    const mb = Math.min(1024, Math.max(0.01, convertToMb(sliderVal, outputUnit)));
    setMaxOutputSize(mb);
    saveMaxOutputSize(mb);
    savePatterns(patternType, pattern, maxFileSize, mb);
  };

  const currentValNum = parseFloat(displaySize) || 1;
  const sliderMin = sizeUnit === 'GB' ? 0.1 : sizeUnit === 'KB' ? 10 : 1;
  const defaultMax = sizeUnit === 'GB' ? 10 : sizeUnit === 'KB' ? 10240 : 500;
  const sliderMax = Math.max(defaultMax, Math.ceil(currentValNum * 1.2));
  const sliderStep = sizeUnit === 'GB' ? 0.1 : sizeUnit === 'KB' ? 10 : 1;

  // Max Output Text File Slider (Capped at exactly 1 GB = 1024 MB)
  const currentOutputValNum = parseFloat(displayOutputSize) || 1;
  const outputSliderMin = outputUnit === 'GB' ? 0.01 : outputUnit === 'KB' ? 10 : 1;
  const outputSliderMax = outputUnit === 'GB' ? 1 : outputUnit === 'KB' ? 1048576 : 1024;
  const outputSliderStep = outputUnit === 'GB' ? 0.05 : outputUnit === 'KB' ? 100 : 1;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    savePatterns(patternType, pattern, maxFileSize);
    addRecentPattern(pattern, patternType);
    refreshPatternItems();
    const updated = addRecentIngest(url.trim());
    setRecentIngests(updated);
    onIngest({
      input_text: url.trim(),
      pattern_type: patternType,
      pattern: pattern.trim(),
      max_file_size: maxFileSize,
      decompile_classes: decompileClasses,
    });
  };

  const handleRepoClick = (repoFullName: string) => {
    const repoUrl = `https://github.com/${repoFullName}`;
    setUrl(repoUrl);
    onUrlChange?.(repoUrl);
    savePatterns(patternType, pattern, maxFileSize);
    addRecentPattern(pattern, patternType);
    refreshPatternItems();
    const updated = addRecentIngest(repoUrl);
    setRecentIngests(updated);
    onIngest({
      input_text: repoUrl,
      pattern_type: patternType,
      pattern: pattern.trim(),
      max_file_size: maxFileSize,
      decompile_classes: decompileClasses,
    });
  };

  const handleRecentClick = (recentUrl: string) => {
    setUrl(recentUrl);
    onUrlChange?.(recentUrl);
    savePatterns(patternType, pattern, maxFileSize);
    addRecentPattern(pattern, patternType);
    refreshPatternItems();
    const updated = addRecentIngest(recentUrl);
    setRecentIngests(updated);
    onIngest({
      input_text: recentUrl,
      pattern_type: patternType,
      pattern: pattern.trim(),
      max_file_size: maxFileSize,
      decompile_classes: decompileClasses,
    });
  };

  const handleRemoveRecent = (recentUrl: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = removeRecentIngest(recentUrl);
    setRecentIngests(updated);
  };

  const handleClearRecent = () => {
    const updated = clearRecentIngests();
    setRecentIngests(updated);
  };

  return (
    <div className="w-full max-w-5xl 2xl:max-w-6xl mx-auto px-3 sm:px-6 relative z-10">
      {/* Dark Brutalist Shadow Box */}
      <div className="relative">
        <div className="w-full h-full absolute inset-0 bg-black rounded-2xl translate-y-1.5 translate-x-1.5 sm:translate-y-2 sm:translate-x-2"></div>

        {/* Main Container */}
        <div className="rounded-2xl relative z-20 p-3.5 sm:p-6 lg:p-8 border-[3px] border-[#30363d] bg-[#161b22] text-gray-100">
          <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5">
            {/* Main URL Input Row */}
            <div className="flex flex-col sm:flex-row gap-2.5 sm:gap-3 items-stretch">
              <div className="relative flex-1 min-w-0">
                <div className="w-full h-full rounded bg-black translate-y-1 translate-x-1 absolute inset-0 z-10"></div>
                <div className="relative z-20 flex items-center bg-[#0d1117] border-[3px] border-[#30363d] focus-within:border-amber-400 rounded transition-colors">
                  <input
                    type="text"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      onUrlChange?.(e.target.value);
                    }}
                    placeholder="https://github.com/owner/repository"
                    required
                    className="w-full px-3.5 sm:px-5 py-2.5 sm:py-3.5 bg-transparent placeholder-gray-500 text-white font-medium text-xs sm:text-base focus:outline-none"
                  />
                </div>
              </div>

              <div className="relative shrink-0 flex items-center gap-2">
                <div className="w-full h-full rounded bg-black translate-y-1 translate-x-1 absolute inset-0 z-10"></div>
                {isLoading ? (
                  <div className="relative z-20 flex items-center gap-2 w-full sm:w-auto">
                    <div className="flex-1 sm:flex-initial px-4 sm:px-6 py-2.5 sm:py-3.5 rounded border-[3px] border-amber-500 font-extrabold text-sm sm:text-base bg-amber-500 text-gray-950 flex items-center justify-center gap-2 shadow-[2px_2px_0_0_#000000]">
                      <RefreshCw className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" />
                      <span>Ingesting...</span>
                      {startTime && (
                        <span className="font-mono text-xs sm:text-sm bg-gray-950/15 px-1.5 py-0.5 rounded font-bold">
                          <IngestionTimer startTime={startTime} />
                        </span>
                      )}
                    </div>
                    {onCancel && (
                      <button
                        type="button"
                        onClick={onCancel}
                        className="px-4 py-2.5 sm:py-3.5 rounded border-[3px] border-red-600 font-extrabold text-sm sm:text-base bg-red-600 hover:bg-red-500 text-white flex items-center justify-center gap-1.5 cursor-pointer shadow-[2px_2px_0_0_#000000] active:translate-y-0.5 transition-transform"
                        title="Cancel current ingestion"
                      >
                        <XCircle className="w-4 h-4" />
                        <span>Cancel</span>
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    type="submit"
                    disabled={!url.trim()}
                    className="w-full sm:w-auto relative z-20 px-5 sm:px-8 py-2.5 sm:py-3.5 rounded border-[3px] border-amber-500 font-extrabold text-sm sm:text-base lg:text-lg bg-amber-500 text-gray-950 hover:bg-amber-400 active:translate-y-0.5 active:translate-x-0.5 transition-all disabled:opacity-60 flex items-center justify-center gap-2 cursor-pointer shadow-[2px_2px_0_0_#000000]"
                  >
                    <span>Ingest</span>
                    <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5" />
                  </button>
                )}
              </div>
            </div>

            {/* Dynamic Personal Repositories Section */}
            {userRepos.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 pt-0.5">
                <span className="text-[11px] sm:text-xs font-bold text-gray-400 uppercase tracking-wider mr-1 flex items-center gap-1">
                  <FolderGit2 className="w-3.5 h-3.5 text-amber-400" />
                  <span>Your Repos:</span>
                </span>

                {isLoadingRepos && (
                  <span className="text-[11px] text-gray-500 flex items-center gap-1">
                    <RefreshCw className="w-3 h-3 animate-spin text-amber-500" />
                    <span>Loading repos...</span>
                  </span>
                )}

                {!isLoadingRepos && userRepos.slice(0, 8).map((repo) => (
                  <button
                    key={repo.full_name}
                    type="button"
                    onClick={() => handleRepoClick(repo.full_name)}
                    className="text-[11px] sm:text-xs font-semibold px-2 py-1 bg-[#21262d] hover:bg-[#30363d] text-gray-200 hover:text-white rounded border border-[#30363d] hover:border-amber-500/60 transition-colors flex items-center gap-1 shadow-[1px_1px_0_0_#000000] cursor-pointer"
                    title={repo.is_private ? 'Private Repository' : 'Public Repository'}
                  >
                    {repo.is_private && <Lock className="w-3 h-3 text-amber-400 shrink-0" />}
                    <span className="truncate max-w-[140px] sm:max-w-none">{repo.name}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Recent Ingestions History Section */}
            {recentIngests.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 pt-1 border-t border-[#30363d]/60">
                <span className="text-[11px] sm:text-xs font-bold text-gray-400 uppercase tracking-wider mr-1 flex items-center gap-1 shrink-0">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  <span>Recent:</span>
                </span>

                {recentIngests.slice(0, 8).map((item) => (
                  <div key={item.id} className="inline-flex items-center group shrink-0">
                    <button
                      type="button"
                      onClick={() => handleRecentClick(item.url)}
                      className="text-[11px] sm:text-xs font-semibold px-2 py-1 bg-[#1c2128] hover:bg-[#2d333b] text-gray-300 hover:text-white rounded-l border border-r-0 border-[#30363d] hover:border-amber-500/60 transition-colors flex items-center gap-1 cursor-pointer"
                      title={`${item.url} (${formatTimeAgo(item.timestamp)})`}
                    >
                      <span className="truncate max-w-[130px] sm:max-w-[180px]">{item.repoName}</span>
                      <span className="text-[10px] text-gray-400 font-mono">({formatTimeAgo(item.timestamp)})</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleRemoveRecent(item.url, e)}
                      className="px-1.5 py-1 bg-[#1c2128] hover:bg-red-950/80 text-gray-400 hover:text-red-400 rounded-r border border-l-0 border-[#30363d] hover:border-red-600/80 transition-colors cursor-pointer"
                      title="Remove from history"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={handleClearRecent}
                  className="text-[10px] font-bold text-gray-400 hover:text-amber-400 transition-colors ml-auto shrink-0 cursor-pointer"
                >
                  Clear history
                </button>
              </div>
            )}

            {/* Controls Row: Pattern filter & Max Size Slider (up to 500 MB) */}
            <div className="pt-3 border-t-2 border-[#30363d] grid grid-cols-1 md:grid-cols-12 gap-3 sm:gap-4 items-center">
              {/* Pattern Type & Pattern Input */}
              <div className="md:col-span-7 relative">
                <div className="w-full h-full rounded bg-black translate-y-1 translate-x-1 absolute inset-0"></div>
                <div className="relative z-10 flex border-[3px] border-[#30363d] rounded bg-[#0d1117] focus-within:border-amber-400 transition-colors">
                  
                  {/* Custom Dropdown */}
                  <div className="relative shrink-0" ref={dropdownRef}>
                    <button
                      type="button"
                      onClick={() => setIsDropdownOpen((prev) => !prev)}
                      className="h-full bg-[#1e242c] hover:bg-[#252d37] font-extrabold text-[11px] sm:text-xs uppercase px-2.5 sm:px-3 py-2 border-r-2 border-[#30363d] text-amber-400 flex items-center gap-1 focus:outline-none cursor-pointer transition-colors select-none"
                    >
                      <span>{patternType}</span>
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {isDropdownOpen && (
                      <div className="absolute left-0 top-full mt-1.5 w-36 bg-[#161b22] border-2 border-amber-500/80 rounded-lg shadow-[4px_4px_0_0_#000000] py-1 z-50 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => handlePatternTypeSelect('exclude')}
                          className={`w-full text-left px-3.5 py-2 text-xs font-bold uppercase tracking-wider flex items-center justify-between cursor-pointer transition-colors ${
                            patternType === 'exclude'
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'text-gray-300 hover:bg-[#21262d] hover:text-white'
                          }`}
                        >
                          <span>EXCLUDE</span>
                          {patternType === 'exclude' && <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>}
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePatternTypeSelect('include')}
                          className={`w-full text-left px-3.5 py-2 text-xs font-bold uppercase tracking-wider flex items-center justify-between cursor-pointer transition-colors ${
                            patternType === 'include'
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'text-gray-300 hover:bg-[#21262d] hover:text-white'
                          }`}
                        >
                          <span>INCLUDE</span>
                          {patternType === 'include' && <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="relative flex-1 flex items-center min-w-0" ref={patternInputContainerRef}>
                    <input
                      type="text"
                      value={pattern}
                      onFocus={() => {
                        refreshPatternItems();
                        setIsPatternHistoryOpen(true);
                      }}
                      onChange={(e) => handlePatternChange(e.target.value)}
                      placeholder="e.g. *.md, tests/, docs/"
                      className="w-full px-3 py-2 text-xs sm:text-sm text-white focus:outline-none placeholder-gray-500 font-mono bg-transparent min-w-0 pr-8"
                    />

                    {/* Quick Star/Bookmark button inside input */}
                    {pattern.trim() && (
                      <button
                        type="button"
                        onClick={handleToggleStar}
                        title={
                          patternFavorites.some((f) => f.pattern === pattern.trim() && f.type === patternType)
                            ? 'Remove from favorites'
                            : 'Save as favorite preset'
                        }
                        className="absolute right-2 p-1 text-gray-500 hover:text-amber-400 transition-colors"
                      >
                        <Star
                          className={`w-3.5 h-3.5 ${
                            patternFavorites.some((f) => f.pattern === pattern.trim() && f.type === patternType)
                              ? 'text-amber-400 fill-amber-400'
                              : ''
                          }`}
                        />
                      </button>
                    )}

                    {/* Clean History & Presets Popover */}
                    {isPatternHistoryOpen && (patternFavorites.length > 0 || patternRecents.length > 0) && (
                      <div className="absolute left-0 top-full mt-2 w-full min-w-[280px] sm:min-w-[340px] max-w-md bg-[#161b22] border-2 border-[#30363d] rounded-lg shadow-[4px_4px_0_0_#000000] p-2 z-[200] overflow-y-auto max-h-72 text-xs">
                        {/* Favorites / Presets */}
                        {patternFavorites.length > 0 && (
                          <div className="mb-2">
                            <div className="px-2 py-1 text-[10px] font-extrabold uppercase text-amber-400/90 tracking-wider flex items-center gap-1">
                              <Star className="w-2.5 h-2.5 fill-amber-400" />
                              <span>Favorites & Presets</span>
                            </div>
                            <div className="space-y-0.5">
                              {patternFavorites.map((item) => (
                                <div
                                  key={item.id}
                                  onClick={() => handleSelectPatternItem(item)}
                                  className="group flex items-center justify-between px-2.5 py-1.5 rounded hover:bg-[#21262d] cursor-pointer transition-colors"
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span
                                      className={`text-[9px] font-mono font-bold px-1 py-0.5 rounded uppercase shrink-0 ${
                                        item.type === 'include'
                                          ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                                          : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                      }`}
                                    >
                                      {item.type}
                                    </span>
                                    <div className="truncate">
                                      {item.label && <span className="font-semibold text-gray-200 block truncate">{item.label}</span>}
                                      <span className="font-mono text-gray-400 text-[11px] truncate block">{item.pattern}</span>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={(e) => handleDeletePatternItem(item.id, e)}
                                    title="Delete preset"
                                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 p-1 shrink-0 transition-opacity"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Recent History */}
                        {patternRecents.length > 0 && (
                          <div>
                            <div className="px-2 py-1 text-[10px] font-extrabold uppercase text-gray-400 tracking-wider flex items-center justify-between">
                              <div className="flex items-center gap-1">
                                <Clock className="w-2.5 h-2.5" />
                                <span>Recent Filters</span>
                              </div>
                              <button
                                type="button"
                                onClick={handleClearRecents}
                                className="text-[9px] text-gray-500 hover:text-amber-400 transition-colors uppercase cursor-pointer"
                              >
                                Clear
                              </button>
                            </div>
                            <div className="space-y-0.5">
                              {patternRecents.map((item) => (
                                <div
                                  key={item.id}
                                  onClick={() => handleSelectPatternItem(item)}
                                  className="group flex items-center justify-between px-2.5 py-1.5 rounded hover:bg-[#21262d] cursor-pointer transition-colors"
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span
                                      className={`text-[9px] font-mono font-bold px-1 py-0.5 rounded uppercase shrink-0 ${
                                        item.type === 'include'
                                          ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                                          : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                      }`}
                                    >
                                      {item.type}
                                    </span>
                                    <span className="font-mono text-gray-300 text-[11px] truncate">{item.pattern}</span>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={(e) => handleDeletePatternItem(item.id, e)}
                                    title="Delete from history"
                                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 p-1 shrink-0 transition-opacity"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Max File Size Slider + Input + Unit Selector */}
              <div className="md:col-span-5 flex items-center justify-between gap-2 bg-[#0d1117] p-2 sm:p-2.5 rounded border-[3px] border-[#30363d] shadow-[2px_2px_0_0_#000000]">
                <span className="text-[10px] sm:text-xs font-extrabold text-gray-300 uppercase tracking-wider whitespace-nowrap shrink-0" title="Maximum individual file size to include in the ingestion">
                  Max Size:
                </span>
                <input
                  type="range"
                  min={sliderMin}
                  max={sliderMax}
                  step={sliderStep}
                  value={Math.min(sliderMax, Math.max(sliderMin, currentValNum))}
                  onChange={(e) => handleSliderChange(Number(e.target.value))}
                  className="w-full min-w-[50px] accent-amber-500 cursor-pointer"
                />
                <div className="flex items-center gap-1 shrink-0">
                  <input
                    type="number"
                    min="0.01"
                    step="any"
                    value={displaySize}
                    onChange={(e) => handleSizeInputChange(e.target.value)}
                    className="w-14 sm:w-16 px-1.5 py-0.5 bg-[#161b22] border border-[#30363d] focus:border-amber-400 rounded text-center font-mono font-bold text-xs sm:text-sm text-amber-300 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none transition-colors"
                    title="Enter custom file size"
                  />
                  <div className="relative" ref={unitDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setIsUnitDropdownOpen((prev) => !prev)}
                      className="bg-[#1e242c] hover:bg-[#252d37] font-extrabold text-[10px] sm:text-xs uppercase px-1.5 py-1 border border-amber-500/50 rounded text-amber-300 flex items-center gap-0.5 focus:outline-none cursor-pointer transition-colors shadow-[1px_1px_0_0_#000000]"
                      title="Switch unit: KB, MB, GB"
                    >
                      <span>{sizeUnit}</span>
                      <ChevronDown className={`w-3 h-3 transition-transform ${isUnitDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {isUnitDropdownOpen && (
                      <div className="absolute right-0 top-full mt-1.5 w-16 bg-[#161b22] border-2 border-amber-500/80 rounded-lg shadow-[3px_3px_0_0_#000000] py-1 z-50 overflow-hidden">
                        {(['KB', 'MB', 'GB'] as const).map((unit) => (
                          <button
                            key={unit}
                            type="button"
                            onClick={() => handleUnitChange(unit)}
                            className={`w-full text-left px-2 py-1 text-xs font-bold uppercase transition-colors ${
                              sizeUnit === unit
                                ? 'bg-amber-500/20 text-amber-300'
                                : 'text-gray-300 hover:bg-[#21262d] hover:text-white'
                            }`}
                          >
                            {unit}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Second Slider Row: Max Output Text File Size (Split threshold up to 1GB) */}
            <div className="pt-2.5 pb-1 border-t border-[#30363d]/60 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 bg-[#0d1117]/60 p-2 sm:p-2.5 rounded-lg border border-[#30363d]">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] sm:text-xs font-extrabold text-amber-400 uppercase tracking-wider whitespace-nowrap shrink-0">
                  Max Output File Size:
                </span>
                <span className="hidden sm:inline text-[11px] text-gray-400">
                  (Split text file if output exceeds this limit, max 1 GB)
                </span>
              </div>

              <div className="flex items-center gap-2.5 w-full sm:w-1/2 md:w-2/5 shrink-0 justify-end">
                <input
                  type="range"
                  min={outputSliderMin}
                  max={outputSliderMax}
                  step={outputSliderStep}
                  value={Math.min(outputSliderMax, Math.max(outputSliderMin, currentOutputValNum))}
                  onChange={(e) => handleOutputSliderChange(Number(e.target.value))}
                  className="w-full accent-amber-500 cursor-pointer"
                  title="Configure max text file size (splits safely into multiple parts if exceeded, max 1 GB)"
                />
                <div className="flex items-center gap-1 shrink-0">
                  <input
                    type="number"
                    min={outputSliderMin}
                    max={outputSliderMax}
                    step="any"
                    value={displayOutputSize}
                    onChange={(e) => handleOutputSizeInputChange(e.target.value)}
                    className="w-14 sm:w-16 px-1.5 py-0.5 bg-[#161b22] border border-[#30363d] focus:border-amber-400 rounded text-center font-mono font-bold text-xs sm:text-sm text-amber-300 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none transition-colors"
                    title="Enter custom output file limit (up to 1 GB)"
                  />
                  <div className="relative" ref={outputUnitDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setIsOutputUnitDropdownOpen((prev) => !prev)}
                      className="bg-[#1e242c] hover:bg-[#252d37] font-extrabold text-[10px] sm:text-xs uppercase px-1.5 py-1 border border-amber-500/50 rounded text-amber-300 flex items-center gap-0.5 focus:outline-none cursor-pointer transition-colors shadow-[1px_1px_0_0_#000000]"
                      title="Switch unit: KB, MB, GB (max 1 GB)"
                    >
                      <span>{outputUnit}</span>
                      <ChevronDown className={`w-3 h-3 transition-transform ${isOutputUnitDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {isOutputUnitDropdownOpen && (
                      <div className="absolute right-0 top-full mt-1.5 w-16 bg-[#161b22] border-2 border-amber-500/80 rounded-lg shadow-[3px_3px_0_0_#000000] py-1 z-50 overflow-hidden">
                        {(['KB', 'MB', 'GB'] as const).map((unit) => (
                          <button
                            key={unit}
                            type="button"
                            onClick={() => handleOutputUnitChange(unit)}
                            className={`w-full text-left px-2 py-1 text-xs font-bold uppercase transition-colors ${
                              outputUnit === unit
                                ? 'bg-amber-500/20 text-amber-300'
                                : 'text-gray-300 hover:bg-[#21262d] hover:text-white'
                            }`}
                          >
                            {unit}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Private Repository / PAT Custom Status Bar */}
            <div className="p-2.5 sm:p-3 bg-[#0d1117] rounded-xl border-2 border-[#30363d] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5">
              <div className="flex items-center gap-2">
                {tokenStatus.configured ? (
                  <>
                    <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div className="text-[11px] sm:text-xs text-gray-300">
                      <span className="font-bold text-emerald-300">Private Repos Ready:</span>{' '}
                      {tokenStatus.user ? (
                        <span>Connected as <strong className="text-white">@{tokenStatus.user.login}</strong></span>
                      ) : (
                        <span>Saved PAT will auto-authenticate private repos</span>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <Key className="w-4 h-4 text-amber-400 shrink-0" />
                    <div className="text-[11px] sm:text-xs text-gray-300">
                      <span className="font-bold text-white">Private Repos:</span>{' '}
                      Configure Personal Access Token to unlock private repositories.
                    </div>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto justify-between sm:justify-end">
                <label
                  className={`flex items-center gap-2 cursor-pointer select-none text-[11px] sm:text-xs px-2.5 py-1.5 rounded-lg border-2 transition-all shadow-[1px_1px_0_0_#000000] ${
                    decompileClasses
                      ? 'border-amber-500/80 bg-amber-500/10 text-amber-300'
                      : 'border-[#30363d] bg-[#161b22] text-gray-300 hover:border-gray-500 hover:text-white'
                  }`}
                  title="Decompile Java .class bytecode files into readable source code"
                >
                  <input
                    type="checkbox"
                    checked={decompileClasses}
                    onChange={(e) => handleDecompileChange(e.target.checked)}
                    className="sr-only"
                  />
                  <div
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors shadow-[1px_1px_0_0_#000000] ${
                      decompileClasses
                        ? 'bg-amber-500 border-amber-400 text-gray-950 font-black'
                        : 'bg-[#0d1117] border-[#30363d]'
                    }`}
                    aria-hidden="true"
                  >
                    {decompileClasses && <Check className="w-3 h-3 stroke-[3.5]" />}
                  </div>
                  <span className="font-bold tracking-tight">Decompile .class</span>
                </label>

                <button
                  type="button"
                  onClick={onOpenTokenModal}
                  className="text-[11px] sm:text-xs font-bold px-3 py-1 rounded-lg border-2 border-[#30363d] bg-[#21262d] text-gray-200 hover:bg-[#30363d] hover:text-white transition-colors shrink-0 shadow-[1px_1px_0_0_#000000] cursor-pointer"
                >
                  {tokenStatus.configured ? 'Manage PAT' : 'Configure PAT'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
});
