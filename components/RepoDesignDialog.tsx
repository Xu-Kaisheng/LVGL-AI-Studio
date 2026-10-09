import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, FileJson2, FolderGit2, RefreshCw, X } from 'lucide-react';
import { ProjectFile } from '../types';
import {
  RepoDesignEntry,
  fetchRepoDesign,
  formatDesignSize,
  formatDesignTime,
  listRepoDesigns
} from '../services/repoDesign';

interface RepoDesignDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** 选定工程后交给 App 走标准的导入确认流程 */
  onLoad: (project: ProjectFile, file: string) => void;
}

/**
 * 列出宿主仓库 lvgl/ 目录下的设计稿工程（*.json），一键载入。
 * 启动时若扫描到文件，App 会自动打开本弹窗询问是否载入；手动入口是顶栏的 Design Files 按钮。
 */
const RepoDesignDialog: React.FC<RepoDesignDialogProps> = ({ isOpen, onClose, onLoad }) => {
  const [entries, setEntries] = useState<RepoDesignEntry[]>([]);
  const [dir, setDir] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setActionError(null);
    try {
      const { dir: designDir, files } = await listRepoDesigns();
      setDir(designDir);
      setEntries(files);
    } catch (err) {
      setEntries([]);
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) void refresh();
  }, [isOpen, refresh]);

  const handleLoad = async (entry: RepoDesignEntry) => {
    setLoadingFile(entry.file);
    setActionError(null);
    try {
      const project = await fetchRepoDesign(entry.file);
      onLoad(project, entry.file);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setLoadingFile(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="absolute inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 w-full max-w-lg rounded-xl shadow-2xl border border-slate-700 overflow-hidden animate-in fade-in zoom-in duration-200">
        <div className="p-4 border-b border-slate-700 flex justify-between items-center bg-slate-800">
          <h3 className="font-bold text-white flex items-center gap-2">
            <FolderGit2 className="text-emerald-400" size={20} />
            Repository Design Files
          </h3>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void refresh()}
              disabled={isLoading}
              className="p-1.5 text-slate-400 hover:text-white transition-colors disabled:opacity-40"
              title="Rescan tools/lvgl/"
            >
              <RefreshCw size={18} className={isLoading ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-white transition-colors" title="Close">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="px-4 pt-3">
          <p className="text-xs text-slate-400">
            Design projects found next to this tool. Directory:
            <span className="font-mono text-slate-500 break-all"> {dir || '../lvgl/'}</span>
          </p>
        </div>

        <div className="p-4 max-h-[55vh] overflow-y-auto">
          {isLoading && <p className="text-sm text-slate-400 py-6 text-center">Scanning…</p>}

          {!isLoading && error && (
            <div className="flex items-start gap-2 text-sm text-amber-400 bg-amber-950/30 border border-amber-900/50 rounded-lg p-3">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!isLoading && !error && entries.length === 0 && (
            <p className="text-sm text-slate-400 py-6 text-center">
              No <span className="font-mono">*.json</span> projects in the sibling{' '}
              <span className="font-mono">lvgl/</span> directory yet.
              <br />
              Export one from this tool, drop it there, then rescan.
            </p>
          )}

          {!isLoading && !error && entries.length > 0 && (
            <ul className="space-y-2">
              {entries.map((entry) => (
                <li
                  key={entry.file}
                  className="flex items-center justify-between gap-3 bg-slate-800/60 hover:bg-slate-800 border border-slate-700 rounded-lg p-3 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
                      <FileJson2 size={15} className="text-blue-400 shrink-0" />
                      <span className="font-mono truncate">{entry.file}</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      {entry.projectName && <span className="text-slate-300">{entry.projectName}</span>}
                      {entry.width && entry.height && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-700/70 font-mono">
                          {entry.width}×{entry.height}
                        </span>
                      )}
                      {typeof entry.screens === 'number' && <span>{entry.screens} screen(s)</span>}
                      {entry.version && <span className="font-mono">v{entry.version}</span>}
                      <span className="text-slate-500">
                        {formatDesignTime(entry.mtime)} · {formatDesignSize(entry.size)}
                      </span>
                    </div>
                    {entry.parseError && (
                      <div className="text-xs text-red-400 mt-1">Could not parse JSON: {entry.parseError}</div>
                    )}
                  </div>
                  <button
                    onClick={() => void handleLoad(entry)}
                    disabled={loadingFile !== null || !!entry.parseError}
                    className="shrink-0 px-3 py-1.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {loadingFile === entry.file ? 'Loading…' : 'Load'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {actionError && <p className="text-xs text-red-400 mt-3">{actionError}</p>}
        </div>

        <div className="p-4 bg-slate-800 border-t border-slate-700 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white transition-colors hover:bg-slate-700 rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default RepoDesignDialog;
