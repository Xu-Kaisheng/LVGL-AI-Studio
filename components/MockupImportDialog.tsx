import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Upload, Loader2, Image as ImageIcon, Sparkles, AlertTriangle, Code, LayoutGrid, ClipboardPaste } from 'lucide-react';
import { AISettings, CanvasSettings, CodeLanguage, AIImageAttachment, MockupTarget } from '../types';
import { getVisionSupport } from '../constants';
import { prepareImageForAI, formatBytes, estimateImageTokens } from '../services/imageUtils';

export interface MockupImportRequest {
  image: AIImageAttachment;
  target: MockupTarget;
  language: CodeLanguage;
  description: string;
  /** code mode: also fold the current canvas contents into the generated code. */
  includeProject: boolean;
  /** widgets mode: clear the active screen before adding the imported widgets. */
  replaceExisting: boolean;
}

interface MockupImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  aiSettings: AISettings;
  canvasSettings: CanvasSettings;
  activeScreenName: string;
  existingWidgetCount: number;
  onSubmit: (request: MockupImportRequest) => Promise<{ message: string }>;
}

const MockupImportDialog: React.FC<MockupImportDialogProps> = ({
  isOpen,
  onClose,
  aiSettings,
  canvasSettings,
  activeScreenName,
  existingWidgetCount,
  onSubmit
}) => {
  const [image, setImage] = useState<AIImageAttachment | null>(null);
  const [target, setTarget] = useState<MockupTarget>('widgets');
  const [language, setLanguage] = useState<CodeLanguage>('c');
  const [description, setDescription] = useState('');
  const [includeProject, setIncludeProject] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const visionSupport = getVisionSupport(aiSettings.provider, aiSettings.model);
  const visionBlocked = visionSupport === false;
  const visionUnknown = visionSupport === undefined;

  const loadFile = useCallback(async (file: File) => {
    setError(null);
    setNotice(null);
    try {
      const prepared = await prepareImageForAI(file);
      setImage(prepared);
    } catch (err) {
      setImage(null);
      setError((err as Error).message);
    }
  }, []);

  // Reset transient state whenever the dialog is (re)opened.
  useEffect(() => {
    if (isOpen) {
      setError(null);
      setNotice(null);
      setIsBusy(false);
    }
  }, [isOpen]);

  // Clipboard paste support (screenshots are usually pasted, not saved to disk).
  useEffect(() => {
    if (!isOpen) return;
    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            void loadFile(file);
            return;
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isOpen, loadFile]);

  if (!isOpen) return null;

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) await loadFile(file);
  };

  const handleChoose = () => fileInputRef.current?.click();

  const handleFileInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) await loadFile(file);
    event.target.value = '';
  };

  const handleSubmit = async () => {
    if (!image || isBusy) return;
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await onSubmit({
        image,
        target,
        language,
        description: description.trim(),
        includeProject,
        replaceExisting
      });
      setNotice(result.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsBusy(false);
    }
  };

  const submitLabel = target === 'widgets' ? 'Import to canvas' : 'Generate code';

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 w-full max-w-3xl max-h-[90vh] rounded-xl shadow-2xl flex flex-col border border-slate-700">

        {/* Header */}
        <div className="p-4 border-b border-slate-700 flex justify-between items-center shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-purple-600/20 border border-purple-500/40 p-1.5 rounded-lg">
              <Sparkles size={18} className="text-purple-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white leading-tight">Import Mockup / Screenshot</h2>
              <p className="text-xs text-slate-400">
                Turn a UI image into LVGL widgets or {language === 'c' ? 'C' : 'MicroPython'} code using a vision model.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" disabled={isBusy}>
            <X />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">

          {/* Vision capability banner */}
          {visionBlocked && (
            <div className="flex items-start gap-2 text-xs bg-red-900/20 border border-red-800/60 text-red-300 rounded-lg p-3">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <div>
                <strong className="text-red-200">{aiSettings.model}</strong> is a text-only model and cannot read images.
                {aiSettings.provider === 'deepseek'
                  ? ' Switch the model to "DeepSeek V4.1 Flash" (id: deepseek-flash) in Settings.'
                  : ' Pick a vision-capable model in Settings (e.g. gpt-4o, claude-3-5-sonnet, gemini-2.5-flash).'}
              </div>
            </div>
          )}
          {!visionBlocked && visionUnknown && (
            <div className="flex items-start gap-2 text-xs bg-amber-900/20 border border-amber-800/60 text-amber-300 rounded-lg p-3">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <div>
                Capability of <strong className="text-amber-200">{aiSettings.model}</strong> is unknown, so the image will be sent as-is.
                If the provider rejects it, switch to a known vision model.
              </div>
            </div>
          )}

          {/* Drop zone / preview */}
          <input
            type="file"
            ref={fileInputRef}
            accept="image/jpeg,image/png,image/gif,image/webp"
            onChange={handleFileInput}
            className="hidden"
          />

          {!image ? (
            <div
              onClick={handleChoose}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
                isDragging ? 'border-purple-500 bg-purple-500/10' : 'border-slate-700 hover:border-slate-500 bg-slate-800/40'
              }`}
            >
              <Upload size={28} className="mx-auto text-slate-500 mb-3" />
              <p className="text-sm text-slate-300 font-medium">Drop a mockup here, or click to browse</p>
              <p className="text-xs text-slate-500 mt-1 flex items-center justify-center gap-1">
                <ClipboardPaste size={12} /> You can also paste from the clipboard (Cmd/Ctrl + V)
              </p>
              <p className="text-[11px] text-slate-600 mt-3">JPEG, PNG, GIF or WebP — large images are downscaled automatically</p>
            </div>
          ) : (
            <div className="flex gap-4">
              <div className="w-40 h-40 shrink-0 bg-slate-950 border border-slate-700 rounded-lg flex items-center justify-center overflow-hidden">
                <img src={image.dataUrl} alt="Mockup preview" className="max-w-full max-h-full object-contain" />
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex items-center gap-2 text-sm text-white font-medium truncate">
                  <ImageIcon size={14} className="text-slate-400 shrink-0" />
                  <span className="truncate">{image.name}</span>
                </div>
                <div className="text-xs text-slate-400 space-y-1">
                  <div>Sent to the model at <span className="text-slate-200">{image.width}×{image.height}</span> px
                    {canvasSettings.width && canvasSettings.height && (
                      <span className="text-slate-500"> (canvas is {canvasSettings.width}×{canvasSettings.height})</span>
                    )}
                  </div>
                  <div>Payload <span className="text-slate-200">{formatBytes(image.bytes)}</span> · ~{estimateImageTokens(image).toLocaleString()} image tokens</div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button onClick={handleChoose} className="text-xs px-2.5 py-1 rounded bg-slate-800 border border-slate-600 text-slate-300 hover:text-white transition-colors">
                    Replace
                  </button>
                  <button
                    onClick={() => { setImage(null); setError(null); setNotice(null); }}
                    className="text-xs px-2.5 py-1 rounded bg-slate-800 border border-slate-600 text-slate-300 hover:text-white transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Target */}
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Output</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setTarget('widgets')}
                disabled={isBusy}
                className={`flex items-start gap-2 p-3 rounded-lg border text-left transition-colors ${
                  target === 'widgets' ? 'bg-blue-900/30 border-blue-500' : 'bg-slate-800 border-slate-700 hover:border-slate-600'
                }`}
              >
                <LayoutGrid size={16} className={target === 'widgets' ? 'text-blue-400 mt-0.5' : 'text-slate-500 mt-0.5'} />
                <span>
                  <span className="block text-sm font-medium text-white">Editable widgets</span>
                  <span className="block text-[11px] text-slate-400">Recreate the layout on the canvas so you can keep editing.</span>
                </span>
              </button>
              <button
                onClick={() => setTarget('code')}
                disabled={isBusy}
                className={`flex items-start gap-2 p-3 rounded-lg border text-left transition-colors ${
                  target === 'code' ? 'bg-blue-900/30 border-blue-500' : 'bg-slate-800 border-slate-700 hover:border-slate-600'
                }`}
              >
                <Code size={16} className={target === 'code' ? 'text-blue-400 mt-0.5' : 'text-slate-500 mt-0.5'} />
                <span>
                  <span className="block text-sm font-medium text-white">LVGL code</span>
                  <span className="block text-[11px] text-slate-400">Generate {language === 'c' ? 'C' : 'MicroPython'} directly from the image.</span>
                </span>
              </button>
            </div>
          </div>

          {/* Target-specific options */}
          {target === 'code' ? (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Language</label>
                <div className="flex bg-slate-800 rounded p-1 border border-slate-700 w-fit">
                  <button
                    onClick={() => setLanguage('c')}
                    disabled={isBusy}
                    className={`px-4 py-1 rounded text-xs font-bold transition-colors ${language === 'c' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
                  >
                    C
                  </button>
                  <button
                    onClick={() => setLanguage('micropython')}
                    disabled={isBusy}
                    className={`px-4 py-1 rounded text-xs font-bold transition-colors ${language === 'micropython' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
                  >
                    MicroPython
                  </button>
                </div>
              </div>
              <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeProject}
                  disabled={isBusy}
                  onChange={(e) => setIncludeProject(e.target.checked)}
                  className="mt-0.5 accent-blue-600"
                />
                <span>
                  Also include the current canvas contents
                  <span className="block text-slate-500">Off = the image is the only source of truth.</span>
                </span>
              </label>
            </div>
          ) : (
            <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={replaceExisting}
                disabled={isBusy}
                onChange={(e) => setReplaceExisting(e.target.checked)}
                className="mt-0.5 accent-blue-600"
              />
              <span>
                Replace the existing widgets on “{activeScreenName}”
                <span className="block text-slate-500">
                  Off = append to the current {existingWidgetCount} widget{existingWidgetCount === 1 ? '' : 's'}.
                </span>
              </span>
            </label>
          )}

          {/* Description */}
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase mb-2">
              Notes for the model <span className="text-slate-600 normal-case font-normal">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isBusy}
              rows={2}
              placeholder="e.g. Ignore the phone status bar, use Montserrat fonts, the top bar is a container"
              className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600 resize-none"
            />
          </div>

          {error && (
            <div className="text-xs bg-red-900/20 border border-red-800/60 text-red-300 rounded-lg p-3 whitespace-pre-wrap">
              {error}
            </div>
          )}
          {notice && (
            <div className="text-xs bg-emerald-900/20 border border-emerald-800/60 text-emerald-300 rounded-lg p-3">
              {notice}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 flex justify-between items-center gap-3 shrink-0">
          <p className="text-[11px] text-slate-500 truncate">
            {aiSettings.provider} · {aiSettings.model}
          </p>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={onClose}
              disabled={isBusy}
              className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-white transition-colors disabled:opacity-50"
            >
              Close
            </button>
            <button
              onClick={handleSubmit}
              disabled={!image || isBusy || visionBlocked}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors shadow-lg shadow-blue-900/20"
            >
              {isBusy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              {isBusy ? 'Working…' : submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MockupImportDialog;
