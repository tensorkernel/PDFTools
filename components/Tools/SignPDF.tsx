
import React, { useState, useEffect, useRef } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { loadPDFDocument, applySignaturesToPDF, SignaturePlacement } from '../../services/pdfService';
import { 
  Loader2, Save, Plus, X
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';
import { ZoomControls } from '../UI/ZoomControls';
import { useZoom } from '../../hooks/useZoom';

interface SignatureItem {
  localId: string;
  id: string;
  pageIndex: number;
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  aspectRatio: number;
}

// --- VIRTUAL PAGE COMPONENT (Scaled) ---
const PDFPage: React.FC<{
  pageIndex: number;
  pdfDoc: any;
  signatures: SignatureItem[];
  selectedSignatureId: string | null;
  onSelectSignature: (id: string | null) => void;
  onUpdateSignature: (id: string, updates: Partial<SignatureItem>) => void;
  onDeleteSignature: (id: string) => void;
  onPageClick: (e: React.MouseEvent, pageIndex: number, rect: DOMRect) => void;
  zoom: number;
}> = ({ pageIndex, pdfDoc, signatures, selectedSignatureId, onSelectSignature, onUpdateSignature, onDeleteSignature, onPageClick, zoom }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isRendered, setIsRendered] = useState(false);
  
  // Dimensions state (logical points)
  const [dimensions, setDimensions] = useState({ width: 600, height: 850 });

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { rootMargin: '500px' }
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Render Page
  useEffect(() => {
    const render = async () => {
      if (!isVisible || isRendered || !pdfDoc || !canvasRef.current) return;
      try {
        const page = await pdfDoc.getPage(pageIndex + 1);
        const renderScale = 2.0; // High res render
        const viewport = page.getViewport({ scale: renderScale });
        setDimensions({ width: viewport.width / renderScale, height: viewport.height / renderScale });
        
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        await page.render({ canvasContext: ctx, viewport }).promise;
        setIsRendered(true);
      } catch (e) {
        console.error("Page render error", e);
      }
    };
    render();
  }, [isVisible, isRendered, pdfDoc]);

  const scaledW = dimensions.width * zoom;
  const scaledH = dimensions.height * zoom;

  return (
    <div 
      className="relative mb-8 shadow-lg transition-all duration-200 bg-white"
      style={{ width: scaledW, height: scaledH }}
      onClick={(e) => {
        if (containerRef.current) {
          onPageClick(e, pageIndex, containerRef.current.getBoundingClientRect());
        }
      }}
    >
       <div 
         ref={containerRef}
         className="relative origin-top-left bg-white"
         style={{ width: dimensions.width, height: dimensions.height, transform: `scale(${zoom})`, willChange: 'transform' }}
       >
          {!isRendered && (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-100 text-slate-400">
                <Loader2 className="animate-spin" />
            </div>
          )}
          <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none w-full h-full" />
          
          {signatures.map(sig => (
            <DraggableSignature 
              key={sig.localId}
              item={sig}
              containerRef={containerRef}
              isSelected={selectedSignatureId === sig.localId}
              onSelect={() => onSelectSignature(sig.localId)}
              onUpdate={onUpdateSignature}
              onDelete={onDeleteSignature}
            />
          ))}

          <div className="absolute -right-8 top-0 text-xs font-bold text-slate-300" style={{ transform: `scale(${1/zoom})`, transformOrigin: 0 }}>
              {pageIndex + 1}
          </div>
       </div>
    </div>
  );
};

const DraggableSignature: React.FC<any> = ({ item, containerRef, isSelected, onSelect, onUpdate, onDelete }) => {
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const handleStart = (e: any) => {
    e.stopPropagation();
    onSelect();
    const clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
    const clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
    const rect = e.target.getBoundingClientRect();
    dragOffset.current = { x: clientX - rect.left, y: clientY - rect.top };
    setIsDragging(true);
  };

  useEffect(() => {
    const handleMove = (e: any) => {
      if (!isDragging || !containerRef.current) return;
      const clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
      const clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
      const containerRect = containerRef.current.getBoundingClientRect();
      const xPixels = clientX - containerRect.left - dragOffset.current.x;
      const yPixels = clientY - containerRect.top - dragOffset.current.y;
      
      const xPct = Math.max(0, Math.min(xPixels / containerRect.width, 1 - item.width));
      const yPct = Math.max(0, Math.min(yPixels / containerRect.height, 1 - (item.width/item.aspectRatio)));
      
      onUpdate(item.localId, { x: xPct, y: yPct });
    };
    
    const handleEnd = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleMove);
      window.addEventListener('touchend', handleEnd);
    }
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleEnd);
    };
  }, [isDragging, item, containerRef, onUpdate]);

  return (
    <div 
      className={`absolute z-20 cursor-move ${isSelected ? 'ring-2 ring-blue-500' : 'hover:ring-1 ring-blue-300'}`}
      style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${item.width * 100}%`, aspectRatio: item.aspectRatio }}
      onMouseDown={handleStart}
      onTouchStart={handleStart}
    >
      <img src={item.dataUrl} className="w-full h-full object-contain pointer-events-none" />
      {isSelected && (
        <button onClick={(e) => { e.stopPropagation(); onDelete(item.localId); }} className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full p-1"><X size={12}/></button>
      )}
    </div>
  );
};

export const SignPDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  
  const [signatures, setSignatures] = useState<SignatureItem[]>([]);
  const [selectedSigId, setSelectedSigId] = useState<string | null>(null);
  const { zoom, zoomIn, zoomOut, resetZoom } = useZoom(1.0);

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0) return;
    const f = files[0];
    setFile({ id: uuidv4(), file: f, name: f.name, size: f.size });
    try {
      const doc = await loadPDFDocument(f);
      setPdfDoc(doc);
    } catch (e) {
      console.error(e);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Failed load' });
    }
  };

  const addSignature = (dataUrl: string) => {
    const newSig: SignatureItem = {
      localId: uuidv4(),
      id: uuidv4(),
      pageIndex: 0, 
      dataUrl,
      x: 0.35, y: 0.4, width: 0.3, aspectRatio: 2
    };
    const img = new Image();
    img.onload = () => {
      newSig.aspectRatio = img.width / img.height;
      setSignatures(prev => [...prev, newSig]);
      setSelectedSigId(newSig.localId);
    };
    img.src = dataUrl;
  };

  const updateSignature = (id: string, updates: Partial<SignatureItem>) => {
    setSignatures(prev => prev.map(s => s.localId === id ? { ...s, ...updates } : s));
  };

  const deleteSignature = (id: string) => {
    setSignatures(prev => prev.filter(s => s.localId !== id));
  };

  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: 'Signing...' });
    try {
       const bytes = await applySignaturesToPDF(file.file, signatures);
       const blob = new Blob([bytes], { type: 'application/pdf' });
       const url = URL.createObjectURL(blob);
       const a = document.createElement('a');
       a.href = url;
       a.download = `signed-${file.name}`;
       a.click();
       setStatus({ isProcessing: false, progress: 100, message: 'Done' });
    } catch (e) { console.error(e); }
  };

  const [showModal, setShowModal] = useState(false);

  return (
    <div className="max-w-7xl mx-auto py-6 px-4 h-[calc(100vh-80px)] flex flex-col">
       <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div>
            <Link to="/" className="text-sm font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors">← Back</Link>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white mt-1">Sign PDF</h1>
          </div>
          {file && (
             <div className="flex gap-2">
               <button onClick={() => setShowModal(true)} className="px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg font-bold hover:bg-slate-200 flex items-center gap-2">
                 <Plus size={18}/> New Signature
               </button>
               <button onClick={handleSave} className="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 flex items-center gap-2">
                 {status.isProcessing ? <Loader2 className="animate-spin" size={18}/> : <Save size={18}/>} Save
               </button>
             </div>
          )}
       </div>

       <AnimatePresence mode="wait">
          {!file ? (
             <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="m-auto w-full max-w-xl">
                <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Drop PDF to sign" />
             </motion.div>
          ) : (
             <div className="flex-1 flex flex-col min-h-0 bg-slate-100 dark:bg-slate-950/50 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden relative">
                
                <div className="absolute bottom-6 right-6 z-30">
                  <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar p-8 flex flex-col items-center">
                    {Array.from({ length: pdfDoc?.numPages || 0 }).map((_, i) => (
                      <PDFPage 
                        key={i}
                        pageIndex={i}
                        pdfDoc={pdfDoc}
                        signatures={signatures.filter(s => s.pageIndex === i)}
                        selectedSignatureId={selectedSigId}
                        onSelectSignature={setSelectedSigId}
                        onUpdateSignature={updateSignature}
                        onDeleteSignature={deleteSignature}
                        onPageClick={(e, idx, rect) => setSelectedSigId(null)}
                        zoom={zoom}
                      />
                    ))}
                    <div className="h-20" />
                </div>
             </div>
          )}
       </AnimatePresence>

       {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
             <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl shadow-2xl max-w-md w-full">
                <h3 className="font-bold mb-4">Add Signature</h3>
                <div className="h-40 bg-slate-50 border-2 border-dashed border-slate-300 rounded-xl mb-4 flex items-center justify-center text-slate-400">
                   Draw here (Mock)
                </div>
                <div className="flex justify-end gap-2">
                   <button onClick={() => setShowModal(false)} className="px-4 py-2 text-slate-500">Cancel</button>
                   <button onClick={() => { 
                      addSignature('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='); 
                      setShowModal(false); 
                   }} className="px-4 py-2 bg-blue-600 text-white rounded-lg">Use Mock Sig</button>
                </div>
             </div>
          </div>
       )}
    </div>
  );
};
