import React from 'react';
import { Key, Github, ShieldCheck, Lock } from 'lucide-react';
import { TokenStatus } from '../types';

interface NavbarProps {
  tokenStatus: TokenStatus;
  isLocked: boolean;
  onOpenTokenModal: () => void;
  onReset: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  tokenStatus,
  isLocked,
  onOpenTokenModal,
  onReset,
}) => {
  return (
    <header className="w-full border-b-[3px] border-[#30363d] bg-[#161b22] sticky top-0 z-40">
      <div className="max-w-6xl 2xl:max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-2.5 min-h-[3.75rem] flex items-center justify-between gap-2">
        {/* Brand / Logo */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <button
            onClick={onReset}
            className="flex items-center gap-2 text-left group transition-transform cursor-pointer"
          >
            <div className="w-7 h-7 sm:w-9 sm:h-9 rounded-lg bg-black border-2 border-amber-500/80 flex items-center justify-center p-1 shadow-[2px_2px_0_0_#000000] shrink-0">
              <span className="font-mono font-black text-amber-400 text-sm sm:text-lg">G</span>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2">
              <span className="font-extrabold text-lg sm:text-2xl tracking-tight text-white group-hover:text-amber-400 transition-colors">
                gitdigest
              </span>
              <span className="bg-amber-500/20 border border-amber-500/60 px-1.5 py-0.2 rounded text-[10px] sm:text-[11px] font-bold text-amber-300 uppercase tracking-wider">
                2
              </span>
            </div>
          </button>
        </div>

        {/* Right side controls */}
        <div className="flex items-center gap-2 shrink-0">

          {/* GitHub Token / Private Access Pill */}
          <button
            onClick={onOpenTokenModal}
            className={`flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg border-2 text-[11px] sm:text-xs font-bold transition-all cursor-pointer ${
              tokenStatus.configured
                ? 'bg-emerald-950/50 border-emerald-500/60 text-emerald-300 hover:bg-emerald-900/50 shadow-[2px_2px_0_0_#000000]'
                : 'bg-[#21262d] border-[#30363d] text-gray-300 hover:bg-[#30363d] shadow-[2px_2px_0_0_#000000]'
            }`}
            title="Manage GitHub Token & Security"
          >
            {tokenStatus.configured ? (
              <>
                <ShieldCheck className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-400 shrink-0" />
                <span className="hidden md:inline">
                  {tokenStatus.user ? `@${tokenStatus.user.login}` : 'PAT Saved'}
                </span>
                <span className="md:hidden">PAT Active</span>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              </>
            ) : (
              <>
                <Key className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-400 shrink-0" />
                <span>Configure PAT</span>
              </>
            )}
          </button>

          {/* GitHub Repo Link */}
          <a
            href="https://github.com/honeypie3301/Personal-Gitingest"
            target="_blank"
            rel="noreferrer"
            className="hidden sm:flex items-center gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg border-2 border-[#30363d] text-xs font-bold bg-[#21262d] text-gray-200 hover:bg-[#30363d] hover:text-white transition-colors shadow-[2px_2px_0_0_#000000]"
          >
            <Github className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">Source Repo</span>
          </a>

          {/* Original GitIngest Link */}
          <a
            href="https://github.com/coderamp-labs/gitingest"
            target="_blank"
            rel="noreferrer"
            className="hidden sm:flex items-center gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg border-2 border-[#30363d] text-xs font-bold bg-[#21262d] text-gray-200 hover:bg-[#30363d] hover:text-white transition-colors shadow-[2px_2px_0_0_#000000]"
          >
            <Github className="w-3.5 h-3.5" />
            <span>original gitingest</span>
          </a>
        </div>
      </div>
    </header>
  );
};
