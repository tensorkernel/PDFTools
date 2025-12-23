
import React, { useState, useEffect } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { getPdfPagePreviews } from '../../services/pdfService';
import { Undo2, Move } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ZoomControls } from '../UI/ZoomControls';
import { useZoom } from '../../hooks/useZoom';

export const ComparePDF: React.FC = () => {
  const [file1, setFile1] = useState<File | null>(null);
  const [file2, setFile2] = useState<File | null>(null);
  const [preview1, setPreview1] = useState<string>('');
  const [preview2, setPreview2] = useState<string>('');
  
  const { zoom, zoomIn, zoomOut, resetZoom } = useZoom(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  useEffect(() => {
    if (file1) getPdfPagePreviews(file1).then(p => setPreview1(p[0]));
    if (file2) getPdfPagePreviews(file2).then(p => setPreview2(p[0]));
  }, [file1, file2]);

  // Reset pan on zoom out
  useEffect(() => { if (zoom === 1) setPan({ x: 0, y: 0 }); }, [zoom]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (zoom <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsPanning(true);
    const startX = e.clientX - pan.x;
    const startY = e.clientY - pan.y;

    const onMove = (mv: PointerEvent) => {
      setPan({ x: mv.clientX - startX, y: mv.clientY - startY });
    };
    const onUp = (up: PointerEvent) => {
      setIsPanning(false);
      e.currentTarget.releasePointerCapture(up.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="max-w-6xl mx-auto py-12 px-4 h-[calc(100vh-80px)] flex flex-col">
      <div className="mb-4 flex-shrink-0">
         <Link to="/" className="text-sm font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors">← Back to Dashboard</Link>
         <div className="flex justify-between items-center mt-2">
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Compare PDFs</h1>
            {file1 && file2 && (
               <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
            )}
         </div>
      </div>

      <AnimatePresence mode="wait">
        {(!file1 || !file2) ? (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="grid md:grid-cols-2 gap-8 flex-1">
             <div><h3 className="font-bold mb-4 text-center text-slate-500">Document A</h3><FileUpload onFilesSelected={f => f.length && setFile1(f[0])} accept=".pdf" label={file1 ? file1.name : "Upload First PDF"} /></div>
             <div><h3 className="font-bold mb-4 text-center text-slate-500">Document B</h3><FileUpload onFilesSelected={f => f.length && setFile2(f[0])} accept=".pdf" label={file2 ? file2.name : "Upload Second PDF"} /></div>
          </motion.div>
        ) : (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-6 flex-1 min-h-0">
             <button onClick={() => { setFile1(null); setFile2(null); }} className="self-center flex items-center gap-2 text-slate-500 hover:text-slate-900 bg-white dark:bg-slate-800 px-4 py-2 rounded-full border shadow-sm"><Undo2 size={16}/> Reset</button>
             
             <div className="flex-1 grid md:grid-cols-2 gap-8 overflow-hidden">
               <div className="flex flex-col gap-2 min-h-0">
                 <div className="font-bold text-center bg-slate-100 dark:bg-slate-800 py-2 rounded-lg">{file1.name}</div>
                 <div 
                    className={`flex-1 border-2 border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden bg-white dark:bg-slate-900 relative flex items-center justify-center ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
                    onPointerDown={handlePointerDown}
                 >
                   {preview1 && (
                     <img 
                        src={preview1} 
                        className="max-w-full max-h-full object-contain shadow-md transition-transform duration-75 will-change-transform select-none" 
                        alt="Doc 1" 
                        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                        draggable={false}
                     />
                   )}
                   {zoom > 1 && isPanning && <div className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded flex gap-1"><Move size={12}/> Synced</div>}
                 </div>
               </div>
               
               <div className="flex flex-col gap-2 min-h-0">
                 <div className="font-bold text-center bg-slate-100 dark:bg-slate-800 py-2 rounded-lg">{file2.name}</div>
                 <div 
                    className={`flex-1 border-2 border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden bg-white dark:bg-slate-900 relative flex items-center justify-center ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
                    onPointerDown={handlePointerDown}
                 >
                   {preview2 && (
                     <img 
                        src={preview2} 
                        className="max-w-full max-h-full object-contain shadow-md transition-transform duration-75 will-change-transform select-none" 
                        alt="Doc 2" 
                        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                        draggable={false}
                     />
                   )}
                 </div>
               </div>
             </div>
             <div className="text-center text-xs text-slate-400">Previews are synced. Zoom to inspect details.</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
