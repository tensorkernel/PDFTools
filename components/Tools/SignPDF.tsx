import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { loadPDFDocument, applySignaturesToPDF, SignaturePlacement } from '../../services/pdfService';
import { 
  FileSignature, Loader2, Save, Undo2, Redo2, Pen, Type, Upload as UploadIcon, 
  Trash2, Grip, Plus, Eraser, Check, X, MousePointer2, ArrowLeft, ArrowRight, Bookmark, Download
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';

// --- TYPE DEFINITIONS ---
interface SignatureItem extends SignaturePlacement {
  localId: string; // Internal ID for React keys
}

interface SavedSignature {
  id: string;
  dataUrl: string;
  date: number;
}

type Point = { x: number; y: number };
type Stroke = Point[];

// --- HELPER: TRIM CANVAS ---
const trimCanvas = (canvas: HTMLCanvasElement): string => {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas.toDataURL();

  const w = canvas.width;
  const h = canvas.height;
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  let minX = w, minY = h, maxX = 0, maxY = 0;
  let found = false;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const alpha = data[(y * w + x) * 4 + 3];
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  if (!found) return canvas.toDataURL(); // Return original if empty

  // Add padding
  const padding = 10;
  const contentW = maxX - minX + 1;
  const contentH = maxY - minY + 1;
  const trimWidth = contentW + (padding * 2);
  const trimHeight = contentH + (padding * 2);

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = trimWidth;
  tempCanvas.height = trimHeight;
  const tempCtx = tempCanvas.getContext('2d');
  
  if (!tempCtx) return canvas.toDataURL();

  // Draw the trimmed content centered in the new canvas
  tempCtx.drawImage(
    canvas, 
    minX, minY, contentW, contentH, 
    padding, padding, contentW, contentH
  );

  return tempCanvas.toDataURL('image/png');
};

// --- SUB-COMPONENTS ---

// 1. Draggable Signature Overlay
const DraggableSignature: React.FC<{
  item: SignatureItem;
  containerRef: React.RefObject<HTMLDivElement>;
  isSelected: boolean;
  onSelect: () => void;
  onUpdate: (id: string, updates: Partial<SignatureItem>) => void;
  onDelete: (id: string) => void;
}> = ({ item, containerRef, isSelected, onSelect, onUpdate, onDelete }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const initialResize = useRef({ w: 0, x: 0 });

  useEffect(() => {
    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!containerRef.current) return;
      const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
      const containerRect = containerRef.current.getBoundingClientRect();

      if (isDragging) {
        const xPixels = clientX - containerRect.left - dragOffset.current.x;
        const yPixels = clientY - containerRect.top - dragOffset.current.y;
        
        // Clamp to boundaries
        const maxX = containerRect.width - (item.width * containerRect.width);
        const maxY = containerRect.height - ((item.width * containerRect.width) / item.aspectRatio);
        
        const clampedX = Math.max(0, Math.min(xPixels, maxX));
        const clampedY = Math.max(0, Math.min(yPixels, maxY));

        onUpdate(item.localId, {
          x: clampedX / containerRect.width,
          y: clampedY / containerRect.height
        });
      }

      if (isResizing) {
        const deltaX = clientX - initialResize.current.x;
        const newWidthPixels = initialResize.current.w + deltaX;
        
        // Min/Max size constraints
        const minW = 30;
        const maxW = containerRect.width * 0.8;
        const finalW = Math.max(minW, Math.min(newWidthPixels, maxW));
        
        onUpdate(item.localId, {
          width: finalW / containerRect.width
        });
      }
    };

    const handleUp = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    if (isDragging || isResizing) {
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('touchmove', handleMove);
      window.addEventListener('mouseup', handleUp);
      window.addEventListener('touchend', handleUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchend', handleUp);
    };
  }, [isDragging, isResizing, item.localId, item.width, item.aspectRatio, onUpdate, containerRef]);

  const startDrag = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    onSelect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
    const rect = (e.target as HTMLElement).closest('.draggable-item')?.getBoundingClientRect();
    if (rect) {
      dragOffset.current = {
        x: clientX - rect.left,
        y: clientY - rect.top
      };
      setIsDragging(true);
    }
  };

  const startResize = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const rect = (e.target as HTMLElement).closest('.draggable-item')?.getBoundingClientRect();
    if (rect) {
      initialResize.current = { w: rect.width, x: clientX };
      setIsResizing(true);
    }
  };

  // Render logic
  // Positions are stored as percentages (0-1), convert to % style
  const style = {
    left: `${item.x * 100}%`,
    top: `${item.y * 100}%`,
    width: `${item.width * 100}%`,
    aspectRatio: `${item.aspectRatio}`,
  };

  return (
    <div
      className={`draggable-item absolute z-10 cursor-move group select-none ${isSelected ? 'z-20' : ''}`}
      style={style}
      onMouseDown={startDrag}
      onTouchStart={startDrag}
    >
      <div className={`relative w-full h-full ${isSelected ? 'ring-2 ring-blue-500 bg-blue-500/5' : 'hover:ring-1 hover:ring-blue-300'}`}>
        <img src={item.dataUrl} alt="Signature" className="w-full h-full object-contain pointer-events-none" />
        
        {/* Controls (Only show when selected) */}
        {isSelected && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(item.localId); }}
              className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full p-1.5 shadow-sm hover:bg-red-600 transition-colors"
            >
              <X size={12} />
            </button>
            <div
              onMouseDown={startResize}
              onTouchStart={startResize}
              className="absolute -bottom-2 -right-2 w-6 h-6 bg-white border-2 border-blue-500 rounded-full flex items-center justify-center cursor-nwse shadow-sm hover:scale-110 transition-transform"
            >
              <Grip size={12} className="text-blue-500" />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// 2. Signature Creation Modal
const SignatureModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSave: (dataUrl: string) => void;
}> = ({ isOpen, onClose, onSave }) => {
  const [activeTab, setActiveTab] = useState<'draw' | 'type' | 'upload' | 'saved'>('draw');
  
  // -- Draw State (Vector Based) --
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[]>([]);
  const currentStroke = useRef<Point[]>([]);

  // -- Saved State --
  const [savedSignatures, setSavedSignatures] = useState<SavedSignature[]>([]);
  const [saveLocally, setSaveLocally] = useState(false);
  
  // -- Type State --
  const [typedText, setTypedText] = useState('');
  const [fontFamily, setFontFamily] = useState('cursive');
  
  // -- Upload State --
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);

  // Load saved signatures on mount
  useEffect(() => {
    const saved = localStorage.getItem('zenpdf_signatures');
    if (saved) {
      try {
        setSavedSignatures(JSON.parse(saved));
      } catch (e) { console.error('Failed to load signatures'); }
    }
  }, []);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen || activeTab !== 'draw') return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, activeTab, strokes, redoStack]);

  // Redraw Canvas from Vector Strokes
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';

    strokes.forEach(stroke => {
      if (stroke.length < 1) return;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i++) {
        ctx.lineTo(stroke[i].x, stroke[i].y);
      }
      ctx.stroke();
    });
  }, [strokes]);

  useEffect(() => {
    if (activeTab === 'draw') redrawCanvas();
  }, [strokes, activeTab, redrawCanvas]);

  // Drawing Logic
  const getPoint = (e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
    
    // Scale coordinates to match canvas internal resolution
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return { 
      x: (clientX - rect.left) * scaleX, 
      y: (clientY - rect.top) * scaleY 
    };
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    setIsDrawing(true);
    const p = getPoint(e);
    currentStroke.current = [p];
    
    // Draw dot
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.fillStyle = '#000';
      ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return;
    const p = getPoint(e);
    currentStroke.current.push(p);

    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      const prev = currentStroke.current[currentStroke.current.length - 2];
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(p.x, p.y);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    if (currentStroke.current.length > 0) {
      const newStrokes = [...strokes, currentStroke.current];
      // Limit history depth
      if (newStrokes.length > 50) newStrokes.shift();
      setStrokes(newStrokes);
      setRedoStack([]); // Clear redo on new action
      currentStroke.current = [];
    }
  };

  const handleUndo = () => {
    if (strokes.length === 0) return;
    const last = strokes[strokes.length - 1];
    setRedoStack(prev => [last, ...prev]);
    setStrokes(prev => prev.slice(0, -1));
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[0];
    setStrokes(prev => [...prev, next]);
    setRedoStack(prev => prev.slice(1));
  };

  const clearCanvas = () => {
    setStrokes([]);
    setRedoStack([]);
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  };

  // --- SAVE ACTIONS ---

  const saveToLocal = (dataUrl: string) => {
    const newSig: SavedSignature = { id: uuidv4(), dataUrl, date: Date.now() };
    const updated = [newSig, ...savedSignatures];
    setSavedSignatures(updated);
    localStorage.setItem('zenpdf_signatures', JSON.stringify(updated));
  };

  const deleteSaved = (id: string) => {
    const updated = savedSignatures.filter(s => s.id !== id);
    setSavedSignatures(updated);
    localStorage.setItem('zenpdf_signatures', JSON.stringify(updated));
  };

  const handleFinalSave = () => {
    let finalDataUrl = '';

    if (activeTab === 'draw' && canvasRef.current) {
      // 1. Auto Trim
      finalDataUrl = trimCanvas(canvasRef.current);
      // 2. Save locally if requested
      if (saveLocally) {
        saveToLocal(finalDataUrl);
      }
    } else if (activeTab === 'type' && typedText) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx) {
        canvas.width = 600;
        canvas.height = 200;
        ctx.font = `60px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#000';
        ctx.fillText(typedText, 300, 100);
        // Trim typed text too
        finalDataUrl = trimCanvas(canvas);
      }
    } else if (activeTab === 'upload' && uploadedImage) {
      finalDataUrl = uploadedImage;
    }

    if (finalDataUrl) {
      onSave(finalDataUrl);
      onClose();
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result) setUploadedImage(ev.target.result as string);
      };
      reader.readAsDataURL(e.target.files[0]);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden border border-slate-200 dark:border-slate-700 flex flex-col max-h-[90vh]"
      >
        <div className="flex border-b border-slate-200 dark:border-slate-800">
          {[
            { id: 'draw', icon: Pen, label: 'Draw' },
            { id: 'type', icon: Type, label: 'Type' },
            { id: 'upload', icon: UploadIcon, label: 'Upload' },
            { id: 'saved', icon: Bookmark, label: 'Saved' }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex-1 py-4 flex items-center justify-center gap-2 font-medium transition-colors text-sm
                ${activeTab === tab.id 
                  ? 'bg-white dark:bg-slate-900 text-blue-600 border-b-2 border-blue-600' 
                  : 'bg-slate-50 dark:bg-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }
              `}
            >
              <tab.icon size={16} /> {tab.label}
            </button>
          ))}
        </div>

        <div className="p-6 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950 min-h-[300px] flex flex-col items-center">
          
          {/* DRAW TAB */}
          {activeTab === 'draw' && (
            <div className="w-full h-full flex flex-col">
              <div className="flex justify-between items-center mb-2">
                 <div className="text-xs text-slate-400">Draw your signature below</div>
                 <div className="flex gap-2">
                   <button onClick={handleUndo} disabled={strokes.length === 0} title="Undo (Cmd+Z)" className="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 disabled:opacity-30 text-slate-600 dark:text-slate-400">
                     <Undo2 size={16} />
                   </button>
                   <button onClick={handleRedo} disabled={redoStack.length === 0} title="Redo (Cmd+Shift+Z)" className="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 disabled:opacity-30 text-slate-600 dark:text-slate-400">
                     <Redo2 size={16} />
                   </button>
                   <button onClick={clearCanvas} title="Clear" className="p-1.5 rounded hover:bg-rose-100 dark:hover:bg-rose-900/30 text-rose-500">
                     <Trash2 size={16} />
                   </button>
                 </div>
              </div>
              <div className="bg-white rounded-xl shadow-inner border border-slate-200 dark:border-slate-700 overflow-hidden touch-none relative flex-1 min-h-[200px]">
                 <canvas
                    ref={canvasRef}
                    width={500}
                    height={200}
                    className="w-full h-full cursor-crosshair absolute inset-0"
                    onMouseDown={startDrawing}
                    onMouseMove={draw}
                    onMouseUp={stopDrawing}
                    onMouseLeave={stopDrawing}
                    onTouchStart={startDrawing}
                    onTouchMove={draw}
                    onTouchEnd={stopDrawing}
                 />
              </div>
              <div className="mt-4 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <input 
                  type="checkbox" 
                  id="saveLocally" 
                  checked={saveLocally} 
                  onChange={(e) => setSaveLocally(e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500" 
                />
                <label htmlFor="saveLocally" className="cursor-pointer select-none">Save signature for future use</label>
              </div>
            </div>
          )}

          {/* TYPE TAB */}
          {activeTab === 'type' && (
            <div className="w-full space-y-8 my-auto">
              <input
                type="text"
                placeholder="Type your name"
                className="w-full p-4 text-3xl text-center border-b-2 border-slate-300 dark:border-slate-700 bg-transparent outline-none focus:border-blue-500 text-slate-900 dark:text-white placeholder:text-slate-300"
                value={typedText}
                onChange={(e) => setTypedText(e.target.value)}
                style={{ fontFamily }}
                autoFocus
              />
              <div className="flex gap-2 justify-center">
                 {['cursive', 'fantasy', 'monospace', 'serif'].map(font => (
                   <button 
                     key={font} 
                     onClick={() => setFontFamily(font)}
                     className={`px-4 py-2 rounded-lg border transition-all ${fontFamily === font ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}
                     style={{ fontFamily: font }}
                   >
                     Sample
                   </button>
                 ))}
              </div>
            </div>
          )}

          {/* UPLOAD TAB */}
          {activeTab === 'upload' && (
            <div className="w-full h-full flex flex-col items-center justify-center">
               <label className="cursor-pointer w-full h-48 border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl hover:border-blue-500 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition-colors bg-white dark:bg-slate-900 flex items-center justify-center">
                 <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
                 {uploadedImage ? (
                   <img src={uploadedImage} alt="Preview" className="max-h-full max-w-full object-contain p-2" />
                 ) : (
                   <div className="flex flex-col items-center gap-2 text-slate-500">
                     <UploadIcon size={32} />
                     <span className="font-medium">Click to upload image</span>
                     <span className="text-xs opacity-70">PNG (Transparent) recommended</span>
                   </div>
                 )}
               </label>
            </div>
          )}

          {/* SAVED TAB */}
          {activeTab === 'saved' && (
            <div className="w-full h-full flex flex-col">
               {savedSignatures.length === 0 ? (
                 <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-center">
                   <Bookmark size={48} className="mb-2 opacity-20" />
                   <p>No saved signatures.</p>
                   <p className="text-xs mt-1">Check "Save signature" when drawing to add one here.</p>
                 </div>
               ) : (
                 <div className="grid grid-cols-1 gap-3">
                   {savedSignatures.map(sig => (
                     <div key={sig.id} className="group bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-3 flex items-center gap-4 hover:border-blue-500 transition-colors cursor-pointer" onClick={() => { onSave(sig.dataUrl); onClose(); }}>
                       <div className="flex-1 h-12 flex items-center justify-start pl-2">
                         <img src={sig.dataUrl} className="max-h-full max-w-full object-contain" alt="Signature" />
                       </div>
                       <div className="text-xs text-slate-400">
                         {new Date(sig.date).toLocaleDateString()}
                       </div>
                       <button 
                         onClick={(e) => { e.stopPropagation(); deleteSaved(sig.id); }}
                         className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg"
                       >
                         <Trash2 size={16} />
                       </button>
                     </div>
                   ))}
                 </div>
               )}
               <div className="mt-auto pt-4 text-center">
                 <p className="text-xs text-slate-400 flex items-center justify-center gap-1">
                   <Save size={10} /> Signatures are stored locally on your device.
                 </p>
               </div>
            </div>
          )}

        </div>

        {activeTab !== 'saved' && (
          <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-3 bg-white dark:bg-slate-900">
            <button onClick={onClose} className="px-4 py-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg font-medium transition-colors">Cancel</button>
            <button 
              onClick={handleFinalSave}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition-colors shadow-lg shadow-blue-500/20"
            >
              Use Signature
            </button>
          </div>
        )}
      </motion.div>
    </div>
  );
};


// --- MAIN COMPONENT ---
export const SignPDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  
  // PDF State
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.0); // Viewer scale
  
  // Signature State
  const [placedSignatures, setPlacedSignatures] = useState<SignatureItem[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);

  // 1. Load File
  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0 || files[0].type !== 'application/pdf') return;
    setFile({ id: uuidv4(), file: files[0], name: files[0].name, size: files[0].size });
    
    try {
      const doc = await loadPDFDocument(files[0]);
      setPdfDoc(doc);
      setNumPages(doc.numPages);
      setCurrentPageIndex(0);
    } catch (e) {
      console.error(e);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Could not load PDF' });
    }
  };

  // 2. Render Page
  useEffect(() => {
    const renderPage = async () => {
      if (!pdfDoc || !canvasRef.current) return;
      
      const page = await pdfDoc.getPage(currentPageIndex + 1);
      
      // Calculate responsive scale
      const containerWidth = pageContainerRef.current?.parentElement?.clientWidth || 800;
      const unscaledViewport = page.getViewport({ scale: 1 });
      const responsiveScale = Math.min(1.5, (containerWidth - 48) / unscaledViewport.width);
      setScale(responsiveScale);

      const viewport = page.getViewport({ scale: responsiveScale });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      if (!context) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport }).promise;
    };

    renderPage();
  }, [pdfDoc, currentPageIndex]); // Recalculate on page/doc change (resize omitted for brevity)

  // 3. Handlers
  const handleCreateSignature = (dataUrl: string) => {
    // Add new signature to current page center
    const newSig: SignatureItem = {
      id: uuidv4(),
      localId: uuidv4(),
      pageIndex: currentPageIndex,
      dataUrl,
      x: 0.35, // Center-ish
      y: 0.4,
      width: 0.3, // 30% width default
      aspectRatio: 2 // Default assumption, will correct if image loads but usually fine for signatures
    };
    
    // Load image to get true aspect ratio for better UX
    const img = new Image();
    img.onload = () => {
      newSig.aspectRatio = img.width / img.height;
      setPlacedSignatures(prev => [...prev, newSig]);
      setSelectedSignatureId(newSig.localId);
    };
    img.src = dataUrl;
  };

  const updateSignature = (id: string, updates: Partial<SignatureItem>) => {
    setPlacedSignatures(prev => prev.map(sig => sig.localId === id ? { ...sig, ...updates } : sig));
  };

  const deleteSignature = (id: string) => {
    setPlacedSignatures(prev => prev.filter(sig => sig.localId !== id));
  };

  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: 'Embedding signatures...' });
    
    try {
      const pdfBytes = await applySignaturesToPDF(file.file, placedSignatures);
      
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `signed-${file.name}`;
      a.click();
      
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus({ isProcessing: false, progress: 100, message: 'Done!' });
    } catch (e) {
      console.error(e);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Failed to save.' });
    }
  };

  return (
    <div className="max-w-7xl mx-auto py-8 px-4 h-[calc(100vh-80px)] flex flex-col">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
         <div>
            <Link to="/" className="text-sm font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors">← Back</Link>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              Sign PDF
            </h1>
         </div>
         {file && (
           <div className="flex gap-2">
             <button onClick={() => setFile(null)} className="px-4 py-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">
               Cancel
             </button>
             <button onClick={handleSave} disabled={status.isProcessing || placedSignatures.length === 0} className="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
               {status.isProcessing ? <Loader2 className="animate-spin" size={18}/> : <Save size={18}/>} Save Signed PDF
             </button>
           </div>
         )}
      </div>

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-3xl mx-auto mt-20">
             <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Drop PDF to sign" />
             <p className="text-center text-slate-400 mt-4 text-sm">
               Securely sign your documents locally. <br/>
               Signatures are never uploaded to any server.
             </p>
          </motion.div>
        ) : (
          <div className="flex-1 flex flex-col md:flex-row gap-6 overflow-hidden">
             
             {/* Left: Viewer & Overlay */}
             <div className="flex-1 bg-slate-100 dark:bg-slate-900/50 rounded-2xl overflow-auto border border-slate-200 dark:border-slate-800 relative flex justify-center p-8 select-none" 
                  onClick={() => setSelectedSignatureId(null)}>
                
                <div 
                  ref={pageContainerRef} 
                  className="relative shadow-xl bg-white"
                  style={{ width: canvasRef.current?.width || 'auto', height: canvasRef.current?.height || 'auto' }}
                >
                  <canvas ref={canvasRef} className="block pointer-events-none" />
                  
                  {/* Signatures for Current Page */}
                  {placedSignatures
                    .filter(s => s.pageIndex === currentPageIndex)
                    .map(sig => (
                      <DraggableSignature 
                        key={sig.localId}
                        item={sig}
                        containerRef={pageContainerRef}
                        isSelected={selectedSignatureId === sig.localId}
                        onSelect={() => setSelectedSignatureId(sig.localId)}
                        onUpdate={updateSignature}
                        onDelete={deleteSignature}
                      />
                    ))
                  }
                </div>
             </div>

             {/* Right: Sidebar Controls */}
             <div className="w-full md:w-72 bg-white dark:bg-slate-900 border-t md:border-t-0 md:border-l border-slate-200 dark:border-slate-800 p-4 flex flex-col gap-4">
                
                {/* Add Signature Button */}
                <button 
                  onClick={() => setIsModalOpen(true)}
                  className="w-full py-4 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border-2 border-dashed border-blue-200 dark:border-blue-800 rounded-xl font-bold flex flex-col items-center justify-center gap-2 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
                >
                  <div className="p-2 bg-blue-500 text-white rounded-full"><Plus size={24} /></div>
                  Create Signature
                </button>

                <div className="text-xs text-slate-400 text-center">
                   Drag signatures to position. <br/> Use handles to resize.
                </div>
                
                <div className="flex-1 overflow-y-auto">
                   <h3 className="font-bold text-slate-900 dark:text-white mb-2 text-sm">Placed Signatures</h3>
                   {placedSignatures.length === 0 ? (
                     <p className="text-sm text-slate-500 italic">No signatures added yet.</p>
                   ) : (
                     <div className="space-y-2">
                       {placedSignatures.map((sig, i) => (
                         <div 
                           key={sig.localId} 
                           onClick={() => { setCurrentPageIndex(sig.pageIndex); setSelectedSignatureId(sig.localId); }}
                           className={`p-2 rounded-lg border text-sm flex items-center gap-3 cursor-pointer ${selectedSignatureId === sig.localId ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700'}`}
                         >
                           <img src={sig.dataUrl} className="w-8 h-8 object-contain bg-white rounded border border-slate-200" alt="" />
                           <div className="flex-1">
                             <div className="font-medium">Signature {i + 1}</div>
                             <div className="text-xs text-slate-500">Page {sig.pageIndex + 1}</div>
                           </div>
                           <button onClick={(e) => { e.stopPropagation(); deleteSignature(sig.localId); }} className="text-slate-400 hover:text-red-500"><Trash2 size={16}/></button>
                         </div>
                       ))}
                     </div>
                   )}
                </div>

                {/* Pagination */}
                <div className="flex items-center justify-between bg-slate-100 dark:bg-slate-800 rounded-lg p-2 mt-auto">
                  <button 
                    disabled={currentPageIndex <= 0}
                    onClick={() => setCurrentPageIndex(p => p - 1)}
                    className="p-2 hover:bg-white dark:hover:bg-slate-700 rounded-md disabled:opacity-30"
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <span className="text-sm font-medium">Page {currentPageIndex + 1} of {numPages}</span>
                  <button 
                    disabled={currentPageIndex >= numPages - 1}
                    onClick={() => setCurrentPageIndex(p => p + 1)}
                    className="p-2 hover:bg-white dark:hover:bg-slate-700 rounded-md disabled:opacity-30"
                  >
                    <ArrowRight size={16} />
                  </button>
                </div>
             </div>
          </div>
        )}
      </AnimatePresence>

      <SignatureModal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        onSave={handleCreateSignature}
      />
    </div>
  );
};
