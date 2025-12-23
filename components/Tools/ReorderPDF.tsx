import React, { useState, useEffect, useRef } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { getPDFPageCount, getPdfPagePreviews, extractPages } from '../../services/pdfService';
import { Loader2, Save, Undo2, Redo2, History } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';
import { createPortal } from 'react-dom';

interface PageItem {
  id: string;
  index: number;
  originalIndex: number; // For PDF extraction mapping
  url: string;
}

export const ReorderPDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });

  // State for Pages and History
  const [items, setItems] = useState<PageItem[]>([]);
  const [history, setHistory] = useState<PageItem[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Dragging State
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overlayPos, setOverlayPos] = useState({ x: 0, y: 0 });
  
  // Refs for Drag Logic
  const itemsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragOffset = useRef({ x: 0, y: 0 });
  const scrollInterval = useRef<number | null>(null);
  const pointerY = useRef<number | null>(null);

  // 1. Keyboard Support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        e.shiftKey ? handleRedo() : handleUndo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [historyIndex, history]);

  // 2. Initial Load
  useEffect(() => {
    if (file) {
      setLoadingPreviews(true);
      getPdfPagePreviews(file.file).then(urls => {
        const initialPages = urls.map((url, i) => ({ 
          id: `page-${i}`, 
          index: i, 
          originalIndex: i, 
          url 
        }));
        setItems(initialPages);
        setHistory([initialPages]);
        setHistoryIndex(0);
        setLoadingPreviews(false);
      });
    } else {
      setItems([]);
      setHistory([]);
      setHistoryIndex(-1);
    }
  }, [file]);

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0) return;
    const f = files[0];
    if (f.type !== 'application/pdf') return;
    setFile({ id: uuidv4(), file: f, name: f.name, size: f.size, pageCount: await getPDFPageCount(f) });
  };

  // --- HISTORY LOGIC ---

  const commitToHistory = (newItems: PageItem[]) => {
    const current = history[historyIndex];
    // Simple comparison of IDs to check if order changed
    if (current && JSON.stringify(newItems.map(p => p.id)) === JSON.stringify(current.map(p => p.id))) {
      return; 
    }
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newItems);
    if (newHistory.length > 30) newHistory.shift();
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      const prevIndex = historyIndex - 1;
      setItems(history[prevIndex]);
      setHistoryIndex(prevIndex);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const nextIndex = historyIndex + 1;
      setItems(history[nextIndex]);
      setHistoryIndex(nextIndex);
    }
  };

  // --- DRAG & DROP LOGIC (Robust Index-Based) ---

  const handleDragStart = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    const el = itemsRef.current.get(id);
    if (!el) return;

    const rect = el.getBoundingClientRect();
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setOverlayPos({ x: rect.left, y: rect.top });
    setActiveId(id);
    pointerY.current = e.clientY;

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    
    // Start Auto Scroll Loop
    startAutoScroll();
  };

  const handlePointerMove = (e: PointerEvent) => {
    pointerY.current = e.clientY;
    setOverlayPos({ 
      x: e.clientX - dragOffset.current.x, 
      y: e.clientY - dragOffset.current.y 
    });
    
    // Core Reordering Logic
    checkIntersection(e.clientX, e.clientY);
  };

  const checkIntersection = (x: number, y: number) => {
    // Find item closest to cursor (simple centroid distance)
    let closestId = null;
    let minDist = Infinity;

    itemsRef.current.forEach((el, id) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.hypot(cx - x, cy - y);
      
      if (dist < minDist) {
        minDist = dist;
        closestId = id;
      }
    });

    if (closestId && closestId !== activeId) {
      setItems(prev => {
        const oldIndex = prev.findIndex(item => item.id === activeId);
        const newIndex = prev.findIndex(item => item.id === closestId);
        
        if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return prev;

        const newItems = [...prev];
        const [moved] = newItems.splice(oldIndex, 1);
        newItems.splice(newIndex, 0, moved);
        return newItems;
      });
    }
  };

  const handlePointerUp = () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    stopAutoScroll();
    
    // Final commit is handled via state update check in effect? No, we need current state.
    // Since 'items' state updates live, we just commit current 'items' to history.
    // However, inside this event listener, we don't have access to fresh 'items' closure easily without refs.
    // Solution: We trigger a state update that also commits, or use a ref for items.
    // Let's use a functional update on setItems to get latest and commit.
    setItems(currentItems => {
      commitToHistory(currentItems);
      return currentItems;
    });
    setActiveId(null);
  };

  // --- AUTO SCROLL ---

  const startAutoScroll = () => {
    const loop = () => {
      if (pointerY.current !== null) {
        const y = pointerY.current;
        const h = window.innerHeight;
        const zone = 100;
        const baseSpeed = 5;
        const maxSpeed = 20;

        if (y < zone) {
           const intensity = (zone - y) / zone;
           window.scrollBy(0, -(baseSpeed + intensity * maxSpeed));
        } else if (y > h - zone) {
           const intensity = (y - (h - zone)) / zone;
           window.scrollBy(0, baseSpeed + intensity * maxSpeed);
        }
      }
      scrollInterval.current = requestAnimationFrame(loop);
    };
    scrollInterval.current = requestAnimationFrame(loop);
  };

  const stopAutoScroll = () => {
    if (scrollInterval.current) cancelAnimationFrame(scrollInterval.current);
    scrollInterval.current = null;
    pointerY.current = null;
  };

  // --- SAVE ---
  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: 'Reordering pages...' });
    try {
      // Use originalIndex to map back to source PDF pages
      const newOrderIndices = items.map(p => p.originalIndex);
      const pdfBytes = await extractPages(file.file, newOrderIndices);
      
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reordered-${file.name}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus({ isProcessing: false, progress: 100, message: 'Done!' });
    } catch (error) {
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Save failed' });
    }
  };

  const activeItem = items.find(i => i.id === activeId);

  return (
    <div className="max-w-6xl mx-auto py-12 px-4">
      <div className="mb-8">
         <Link to="/" className="text-sm font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors">← Back to Dashboard</Link>
         <h1 className="text-3xl font-bold text-slate-900 dark:text-white mt-2">Reorder PDF Pages</h1>
         <p className="text-slate-500 dark:text-slate-400">Drag pages to rearrange. Scroll automatically near edges.</p>
      </div>

      <AnimatePresence mode="wait">
        {!file ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-3xl mx-auto">
             <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Drop PDF to reorder" />
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-6">
            
            {/* Sticky Toolbar */}
            <div className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-md rounded-2xl p-4 flex items-center justify-between sticky top-4 z-40 shadow-lg border border-slate-200 dark:border-slate-800 ring-1 ring-black/5">
               <div className="flex items-center gap-4 min-w-0">
                 <button onClick={() => setFile(null)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-500" title="Change File">
                   <History size={20}/>
                 </button>
                 <div className="h-8 w-px bg-slate-200 dark:bg-slate-800 hidden sm:block" />
                 <div className="flex items-center gap-2">
                   <button onClick={handleUndo} disabled={historyIndex <= 0} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-700 dark:text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"><Undo2 size={20}/></button>
                   <button onClick={handleRedo} disabled={historyIndex >= history.length - 1} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-700 dark:text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"><Redo2 size={20}/></button>
                 </div>
                 <h3 className="font-bold text-slate-900 dark:text-white truncate hidden md:block max-w-[200px] ml-2">{file.name}</h3>
               </div>
               <button onClick={handleSave} disabled={status.isProcessing} className="px-6 py-2.5 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors flex items-center gap-2 shadow-md shadow-blue-500/20">
                 {status.isProcessing ? <Loader2 className="animate-spin" size={18}/> : <Save size={18}/>} <span className="hidden sm:inline">Save</span>
               </button>
            </div>

            {/* Grid Container */}
            <div className="bg-slate-50/50 dark:bg-slate-900/50 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-800 p-6 min-h-[500px] relative select-none">
               {loadingPreviews ? (
                 <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                   <Loader2 className="animate-spin mb-4" size={32} />
                   <p>Generating previews...</p>
                 </div>
               ) : (
                 <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                   {items.map((item) => (
                     <motion.div
                       layout
                       key={item.id}
                       ref={(el) => { if(el) itemsRef.current.set(item.id, el); }}
                       onPointerDown={(e) => handleDragStart(e, item.id)}
                       className={`relative aspect-[3/4] rounded-lg overflow-hidden border-2 bg-white dark:bg-slate-800 shadow-sm
                         ${activeId === item.id ? 'opacity-30 border-dashed border-slate-400' : 'border-slate-200 dark:border-slate-700 hover:border-blue-400'}
                         touch-none cursor-grab active:cursor-grabbing
                       `}
                     >
                        <img src={item.url} alt="" className="w-full h-full object-contain p-2 pointer-events-none" />
                        <div className="absolute bottom-0 left-0 right-0 bg-slate-900/80 text-white text-xs py-1.5 text-center font-mono pointer-events-none">
                          Page {item.originalIndex + 1}
                        </div>
                     </motion.div>
                   ))}
                 </div>
               )}
            </div>
            
            <div className="text-center text-xs text-slate-400 pb-8">
              {historyIndex + 1} / {history.length} states • Drag to reorder
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Drag Overlay Portal */}
      {activeId && activeItem && createPortal(
        <div 
          className="fixed pointer-events-none z-50 shadow-2xl rounded-lg overflow-hidden border-2 border-blue-500 bg-white dark:bg-slate-800"
          style={{ 
            left: overlayPos.x, 
            top: overlayPos.y, 
            width: itemsRef.current.get(activeId)?.offsetWidth || 200, 
            height: itemsRef.current.get(activeId)?.offsetHeight || 260,
            transform: 'scale(1.05)',
            boxShadow: '0 20px 40px -10px rgba(0,0,0,0.3)'
          }}
        >
          <img src={activeItem.url} alt="" className="w-full h-full object-contain p-2" />
          <div className="absolute bottom-0 left-0 right-0 bg-blue-600 text-white text-xs py-1.5 text-center font-bold">
            Moving Page {activeItem.originalIndex + 1}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};