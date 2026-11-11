import React, { useState, useEffect, useRef } from 'react';
import { Navbar } from './components/Navbar';
import { GitForm } from './components/GitForm';
import { ResultSection } from './components/ResultSection';
import { TokenModal } from './components/TokenModal';
import { WorkflowTabsBar, WorkflowTab } from './components/WorkflowTabsBar';
import { SparkleRed, SparkleGreen } from './components/Sparkles';
import {
  performIngest,
  checkServerTokenStatus,
  getSavedToken,
  setSavedToken,
  isVerifiedOwner,
  verifyAuthWithServer,
  OWNER_GITHUB_LOGIN,
  OWNER_GITHUB_ID,
  getCachedAuth,
  setCachedAuth,
  clearAuthCache,
} from './services/ingest';
import { fetchUserRepos, RepoSummary } from './services/githubApi';
import { IngestRequest, IngestResponse, TokenStatus } from './types';
import { Lock, ShieldCheck, Key, RefreshCw } from 'lucide-react';
import { notifier } from './services/notifications';
import { addRecentIngest } from './services/ingestionHistory';

interface WorkflowSession {
  id: string;
  url: string;
  result: IngestResponse | null;
  error: string | null;
  isLoading: boolean;
  startTime: number | null;
  durationMs: number | null;
  abortController: AbortController | null;
}

const MAX_WORKFLOWS = 10;

function createEmptySession(id: string, initialUrl = ''): WorkflowSession {
  return {
    id,
    url: initialUrl,
    result: null,
    error: null,
    isLoading: false,
    startTime: null,
    durationMs: null,
    abortController: null,
  };
}

function deriveTabTitle(url: string, result: IngestResponse | null): string {
  if (result?.subpath) {
    const parts = result.subpath.split('/');
    return parts[parts.length - 1] || result.subpath;
  }
  if (result?.repo_name) {
    const parts = result.repo_name.split('/');
    return parts[parts.length - 1] || result.repo_name;
  }
  if (!url) return 'New Ingest';
  try {
    const clean = url.replace(/^https?:\/\//i, '').replace(/^(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '');
    const parts = clean.split('/').filter(Boolean);
    if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
      return parts[parts.length - 1];
    }
    return parts[1] || parts[0] || 'New Ingest';
  } catch {
    return 'New Ingest';
  }
}

export default function App() {
  const [sessions, setSessions] = useState<WorkflowSession[]>([createEmptySession('session_1')]);
  const [activeSessionId, setActiveSessionId] = useState<string>('session_1');

  const [isTokenModalOpen, setIsTokenModalOpen] = useState(false);
  const [tokenStatus, setTokenStatus] = useState<TokenStatus>({
    configured: false,
    source: 'none',
  });

  const [userRepos, setUserRepos] = useState<RepoSummary[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);

  const [isLocked, setIsLocked] = useState(false);
  const [authInput, setAuthInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [isVerifyingAuth, setIsVerifyingAuth] = useState(false);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

  const refreshTokens = async () => {
    const savedPat = getSavedToken();
    if (savedPat) {
      // 1. Apply cached auth instantly so UI is ready immediately
      const cached = getCachedAuth(savedPat);
      if (cached) {
        setTokenStatus({ configured: true, source: 'saved_pat', user: cached });
        loadRepos(savedPat, cached.login);
        // Re-verify silently in background — don't await
        verifyAuthWithServer(savedPat).then((authRes) => {
          if (authRes.success && authRes.user) setCachedAuth(savedPat, authRes.user);
          else clearAuthCache();
        }).catch(() => {});
        return;
      }

      // 2. No cache — verify now (first load or cache expired)
      try {
        const authRes = await verifyAuthWithServer(savedPat);
        if (authRes.success && authRes.user) {
          setCachedAuth(savedPat, authRes.user);
          setTokenStatus({ configured: true, source: 'saved_pat', user: authRes.user });
          loadRepos(savedPat, authRes.user.login);
          return;
        }
      } catch {}
    }

    const status = await checkServerTokenStatus();
    if (status.configured && status.user) {
      setTokenStatus(status);
      loadRepos(undefined, status.user.login);
    } else {
      setTokenStatus({ configured: false, source: 'none', user: null });
      setUserRepos([]);
      try {
        localStorage.removeItem('gitingest_cached_repos');
      } catch {}
    }
  };

  const loadRepos = async (token?: string, username?: string) => {
    if (!token && !username) {
      setUserRepos([]);
      return;
    }
    setIsLoadingRepos(true);
    const repos = await fetchUserRepos(token, username);
    setUserRepos(repos);
    setIsLoadingRepos(false);
  };

  useEffect(() => {
    refreshTokens();
  }, []);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = authInput.trim();
    if (!input) return;

    setAuthError(null);
    setIsVerifyingAuth(true);

    try {
      const authRes = await verifyAuthWithServer(input);
      if (!authRes.success) {
        setAuthError(authRes.error || 'Authentication rejected by server.');
        return;
      }

      setSavedToken(input);
      if (authRes.user) setCachedAuth(input, authRes.user);
      setIsLocked(false);
      setAuthError(null);
      setAuthInput('');
      setTokenStatus({
        configured: true,
        source: 'saved_pat',
        user: authRes.user || null,
      });
      loadRepos(input, authRes.user?.login);
    } catch {
      setAuthError('Network error while connecting to authentication server.');
    } finally {
      setIsVerifyingAuth(false);
    }
  };

  const handleManualLock = () => {
    setSavedToken('');
    clearAuthCache();
    setTokenStatus({ configured: false, source: 'none', user: null });
    setIsLocked(true);
  };

  const updateActiveSession = (patch: Partial<WorkflowSession>) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? { ...s, ...patch } : s))
    );
  };

  const handleCancelSession = (sessionId = activeSessionId) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === sessionId && s.abortController) {
          s.abortController.abort();
          return { ...s, isLoading: false, error: 'Ingestion was cancelled.', abortController: null, startTime: null };
        }
        return s;
      })
    );
  };

  const handleAddTab = (initialUrl = '') => {
    if (sessions.length >= MAX_WORKFLOWS) return;
    const newId = `session_${Date.now()}`;
    const newSession = createEmptySession(newId, initialUrl);
    setSessions((prev) => [...prev, newSession]);
    setActiveSessionId(newId);
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (sessions.length <= 1) return;
    handleCancelSession(id);
    const newSessions = sessions.filter((s) => s.id !== id);
    setSessions(newSessions);
    if (activeSessionId === id) {
      setActiveSessionId(newSessions[newSessions.length - 1].id);
    }
  };

  const handleSelectRepo = (repoFullName: string) => {
    const fullUrl = `https://github.com/${repoFullName}`;
    // If active session is empty or done, update it, otherwise open new workflow tab if space available
    if (!activeSession.url || activeSession.result || activeSession.error) {
      updateActiveSession({ url: fullUrl });
    } else if (sessions.length < MAX_WORKFLOWS) {
      handleAddTab(fullUrl);
    } else {
      updateActiveSession({ url: fullUrl });
    }
  };

  const handleIngest = async (req: IngestRequest) => {
    const sessionId = activeSessionId;
    const abortController = new AbortController();
    const startTime = Date.now();

    // Prompt for notification permission on user action
    void notifier.requestPermission();

    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              url: req.input_text,
              isLoading: true,
              startTime,
              durationMs: null,
              error: null,
              result: null,
              abortController,
            }
          : s
      )
    );

    try {
      const data = await performIngest(req, abortController.signal);
      if (data.mode_switched) {
        try { localStorage.setItem('gitingest_fallback_active', 'true'); } catch {}
      }
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id === sessionId) {
            if (data.error) {
              return { ...s, isLoading: false, error: data.error, abortController: null, startTime: null };
            }
            const duration = Date.now() - startTime;
            const repoName = data.repo_name || req.input_text.replace(/^https?:\/\/github\.com\//i, '');
            addRecentIngest(req.input_text, repoName, data.files_analyzed || 0);
            notifier.notifyIngestionDone(
              repoName,
              data.files_analyzed || 0,
              duration / 1000
            );
            return {
              ...s,
              isLoading: false,
              result: data,
              durationMs: duration,
              abortController: null,
              startTime: null,
            };
          }
          return s;
        })
      );
    } catch (err: any) {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id === sessionId) {
            const isCancelled = err.name === 'AbortError' || abortController.signal.aborted || err.message?.includes('cancelled');
            return {
              ...s,
              isLoading: false,
              error: isCancelled ? 'Ingestion was cancelled.' : err.message || 'An error occurred during ingestion.',
              abortController: null,
              startTime: null,
            };
          }
          return s;
        })
      );
    }
  };

  const handleReset = () => {
    handleCancelSession();
    updateActiveSession({
      result: null,
      error: null,
      isLoading: false,
      startTime: null,
      durationMs: null,
      abortController: null,
    });
  };

  const tabsData: WorkflowTab[] = sessions.map((s) => ({
    id: s.id,
    url: s.url,
    title: deriveTabTitle(s.url, s.result),
    isLoading: s.isLoading,
    hasResult: Boolean(s.result),
    hasError: Boolean(s.error),
    startTime: s.startTime,
    filesCount: s.result?.files_analyzed,
  }));

  return (
    <div className="min-h-screen bg-[#0d1117] text-[#e6edf3] flex flex-col justify-between selection:bg-amber-500/30 selection:text-amber-200 w-full overflow-x-hidden">
      <div className="w-full">
        {/* Navigation Bar */}
        <Navbar
          tokenStatus={tokenStatus}
          isLocked={isLocked}
          onOpenTokenModal={() => setIsTokenModalOpen(true)}
          onReset={handleReset}
        />

        {isLocked ? (
          <div className="w-full max-w-md mx-auto px-4 pt-16 sm:pt-24 pb-16">
            <div className="relative">
              <div className="w-full h-full absolute inset-0 bg-black rounded-2xl translate-y-2 translate-x-2"></div>
              <div className="relative z-10 bg-[#161b22] border-[3px] border-[#30363d] rounded-2xl p-6 sm:p-8 text-center space-y-6">
                <div className="w-14 h-14 mx-auto rounded-full bg-amber-500/20 border-2 border-amber-500/50 flex items-center justify-center">
                  <ShieldCheck className="w-7 h-7 text-amber-400" />
                </div>
                <div>
                  <h2 className="text-xl sm:text-2xl font-extrabold text-white">Owner Access Restricted</h2>
                  <p className="text-xs text-gray-400 mt-1.5">
                    This personal instance is restricted to <span className="text-amber-400 font-bold">@{OWNER_GITHUB_LOGIN}</span> (ID: <span className="font-mono text-gray-300">{OWNER_GITHUB_ID}</span>).
                  </p>
                </div>

                <form onSubmit={handleUnlock} className="space-y-4">
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-300 mb-1.5 text-left">
                      GitHub PAT or Secret Access Key
                    </label>
                    <input
                      type="password"
                      value={authInput}
                      onChange={(e) => setAuthInput(e.target.value)}
                      placeholder="ghp_... or secret access key"
                      required
                      className="w-full px-4 py-2.5 bg-[#0d1117] border-2 border-[#30363d] focus:border-amber-400 rounded-lg text-white font-mono text-sm focus:outline-none placeholder-gray-500"
                    />
                  </div>

                  {authError && (
                    <div className="p-3 bg-red-950/40 border-2 border-red-700/60 rounded-lg text-red-300 text-xs text-left leading-relaxed">
                      {authError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isVerifyingAuth}
                    className="w-full py-2.5 px-4 rounded-lg bg-amber-500 hover:bg-amber-400 border-2 border-amber-600 text-gray-950 font-extrabold text-sm transition-transform cursor-pointer shadow-[2px_2px_0_0_#000000] flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isVerifyingAuth ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Verifying with Server...</span>
                      </>
                    ) : (
                      <>
                        <Lock className="w-4 h-4" />
                        <span>Verify & Unlock</span>
                      </>
                    )}
                  </button>
                </form>
              </div>
            </div>
          </div>
        ) : (
          <main className="w-full pt-6 sm:pt-10 pb-16">
            {/* Hero Section */}
            <div className="mb-6 sm:mb-8 text-center relative px-4">
              <div className="relative inline-block mx-auto">
                <SparkleRed className="sparkle-red hidden sm:block select-none" />
                <SparkleGreen className="sparkle-green hidden sm:block select-none" />

                <h1 className="landing-page-title text-3xl sm:text-5xl md:text-6xl font-black">
                  Prompt-friendly
                  <br />
                  codebase&nbsp;
                </h1>
              </div>

              <p className="mt-3 sm:mt-4 text-sm sm:text-base lg:text-lg text-gray-300 max-w-xl mx-auto font-medium">
                Turn any Git repository into a clean, consolidated text digest for LLMs.
              </p>
            </div>

            {/* Workspace Multi-Ingest Tabs Bar */}
            <WorkflowTabsBar
              tabs={tabsData}
              activeId={activeSessionId}
              onSelectTab={(id) => setActiveSessionId(id)}
              onCloseTab={handleCloseTab}
              onAddTab={() => handleAddTab()}
              maxTabs={MAX_WORKFLOWS}
            />

            {/* Form */}
            <GitForm
              key={activeSession.id}
              initialUrl={activeSession.url}
              onUrlChange={(newUrl) => updateActiveSession({ url: newUrl })}
              onIngest={handleIngest}
              isLoading={activeSession.isLoading}
              startTime={activeSession.startTime}
              tokenStatus={tokenStatus}
              onOpenTokenModal={() => setIsTokenModalOpen(true)}
              onCancel={() => handleCancelSession(activeSession.id)}
            />

            {/* Result Area */}
            <ResultSection
              key={`result_${activeSession.id}`}
              result={activeSession.result}
              error={activeSession.error}
              isLoading={activeSession.isLoading}
              startTime={activeSession.startTime}
              durationMs={activeSession.durationMs}
              onCancel={() => handleCancelSession(activeSession.id)}
            />
          </main>
        )}
      </div>

      {/* Footer */}
      <footer className="border-t-[3px] border-[#30363d] bg-[#161b22] py-6 sm:py-8 mt-12 sm:mt-16 text-gray-300 w-full">
        <div className="max-w-6xl 2xl:max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-center gap-4">
          <div className="flex items-center gap-4 text-xs font-bold text-gray-400">
            <a
              href={import.meta.env.VITE_GITHUB_REPO_URL || "https://github.com/honeypie3301"}
              target="_blank"
              rel="noreferrer"
              className="hover:text-amber-400 transition-colors"
            >
              Source Repo
            </a>
            <span>•</span>
            <a
              href="https://github.com/coderamp-labs/gitingest"
              target="_blank"
              rel="noreferrer"
              className="hover:text-amber-400 transition-colors"
            >
              original gitingest
            </a>
          </div>
        </div>
      </footer>

      {/* Token & Security Modal */}
      <TokenModal
        isOpen={isTokenModalOpen}
        onClose={() => setIsTokenModalOpen(false)}
        onTokenUpdated={refreshTokens}
      />
    </div>
  );
}
