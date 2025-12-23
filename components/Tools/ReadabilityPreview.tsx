import React, { useEffect, useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ZoomIn, ZoomOut, AlertTriangle, Eye, X, Settings2, HardDrive, RotateCcw, Plus, Minus, Move, Grip } from 'lucide-react';
import { AdaptiveConfig, generatePreviewPair, getInterpolatedConfig } from '../../services/pdfService';

interface Props {
  file: File;
  config: AdaptiveConfig;
  isTextHeavy: boolean;
  onClose: () => void;
  onConfirm: (config: AdaptiveConfig) => void;
  onImprove: () => void;
}

export const ReadabilityPreview: React.FC<Props> = ({ file, config: initialConfig, isTextHeavy, onClose, onConfirm, onImprove }) => {
  const [images, setImages] = useState<{ original: string; compressed: string } | null>(null);
  const [loading, setLoading] = useState(true);
  
  // Quality Control State
  const [sliderValue, setSliderValue] = useState(50);
  const [currentConfig, setCurrentConfig] = useState<AdaptiveConfig>(initialConfig);
  const [sizeEstimate, setSizeEstimate] = useState<{ estimatedSize: number, ratio: number } | null>(null);
  
  // Viewport State (Zoom & Pan)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  
  // Image Metrics for Clamping
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [bounds, setBounds] = useState({ w: 0, h: 0, cw: 0, ch: 0 });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- 1. Initialization & Generation ---

  useEffect(() => {
    // Initialize slider based on incoming DPI
    const startDPI = initialConfig.projectedDPI;
    const approxSlider = Math.max(0, Math.min(100, ((startDPI - 43) / (144 - 43)) * 100));
    setSliderValue(Math.round(approxSlider));
    generate(currentConfig);
  }, []);

  const generate = async (cfg: AdaptiveConfig) => {
    setLoading(true);
    try {
      const result = await generatePreviewPair(file, cfg);
      setImages(result);
      setSizeEstimate({ 
        estimatedSize: result.metrics.estimatedTotalSize, 
        ratio: result.metrics.estimatedTotalSize / file.size
      });
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    setSliderValue(val);
    const newConfig = getInterpolatedConfig(val, isTextHeavy);
    setCurrentConfig(newConfig);
    setLoading(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      generate(newConfig);
    }, 200);
  };

  // --- 2. Zoom & Pan Logic ---

  // Update bounds on resize or image load
  const updateBounds = useCallback(() => {
    if (containerRef.current && imageRef.current) {
      // Get the *natural* rendered size of the image (before transform)
      // We can approximate this by resetting transform momentarily or using naturalWidth/Height logic mapped to object-fit
      // Simpler: The image is object-contain. Its rendered dimensions are determined by container aspect ratio.
      
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      const nw = imageRef.current.naturalWidth;
      const nh = imageRef.current.naturalHeight;
      
      if (!nw || !nh) return;

      const containerRatio = cw / ch;
      const imageRatio = nw / nh;

      let renderedW, renderedH;

      if (imageRatio > containerRatio) {
        // Limited by width
        renderedW = cw;
        renderedH = cw / imageRatio;
      } else {
        // Limited by height
        renderedH = ch;
        renderedW = ch * imageRatio;
      }

      setBounds({ w: renderedW, h: renderedH, cw, ch });
    }
  }, [images]);

  useEffect(() => {
    window.addEventListener('resize', updateBounds);
    return () => window.removeEventListener('resize', updateBounds);
  }, [updateBounds]);

  const handleZoom = (delta: number) => {
    setZoom(prev => {
      const next = Math.max(1, Math.min(4, prev + delta));
      if (next === 1) setPan({ x: 0, y: 0 }); // Reset pan on zoom out
      return next;
    });
  };

  const startPan = (e: React.PointerEvent) => {
    if (zoom <= 1) return;
    setIsPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    
    const startX = e.clientX;
    const startY = e.clientY;
    const initialPan = { ...pan };

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      // Calculate Clamping Limits
      // Max displacement = (ScaledDim - ContainerDim) / 2
      // If ScaledDim < ContainerDim, Max displacement = 0
      
      const scaledW = bounds.w * zoom;
      const scaledH = bounds.h * zoom;
      
      // We allow panning if the image is actually larger than the container visually?
      // No, we allow panning if the scaled image extends beyond the container edges?
      // Or simply: We are moving the center.
      // Limit X: +/- (scaledW - bounds.cw) / 2  (If scaledW > cw)
      // If scaledW < cw, keep centered (x=0)

      const maxPanX = Math.max(0, (scaledW - bounds.cw) / 2);
      const maxPanY = Math.max(0, (scaledH - bounds.ch) / 2);

      let nextX = initialPan.x + dx;
      let nextY = initialPan.y + dy;

      // Clamp
      nextX = Math.max(-maxPanX, Math.min(maxPanX, nextX));
      nextY = Math.max(-maxPanY, Math.min(maxPanY, nextY));

      setPan({ x: nextX, y: nextY });
    };

    const onUp = (upEvent: PointerEvent) => {
      setIsPanning(false);
      e.currentTarget.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const dpi = currentConfig.projectedDPI;
  const qualityLabel = dpi >= 120 ? 'Good' : dpi >= 100 ? 'Fair' : 'Poor';
  const labelColor = dpi >= 120 ? 'text-green-500' : dpi >= 100 ? 'text-amber-500' : 'text-rose-500';
  const formatSize = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + ' MB';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/90 backdrop-blur-sm" onClick={onClose} />
      
      <motion.div 
        initial={{ scale: 0.98, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-slate-900 w-full max-w-[95vw] h-[95vh] rounded-2xl flex flex-col shadow-2xl overflow-hidden relative z-10 border border-slate-700"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900 z-20">
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <Eye size={20} className="text-blue-500" /> Readability Check
            </h3>
            <p className="text-sm text-slate-400">
              Drag to pan. Zoom to inspect details.
            </p>
          </div>
          <div className="flex items-center gap-4">
             <div className="flex items-center gap-1 bg-slate-800 rounded-lg p-1">
                <button onClick={() => handleZoom(-0.5)} disabled={zoom <= 1} className="p-2 hover:bg-slate-700 rounded-md text-slate-300 disabled:opacity-30"><Minus size={18}/></button>
                <span className="w-12 text-center font-mono text-sm font-bold text-white">{Math.round(zoom * 100)}%</span>
                <button onClick={() => handleZoom(0.5)} disabled={zoom >= 4} className="p-2 hover:bg-slate-700 rounded-md text-slate-300 disabled:opacity-30"><Plus size={18}/></button>
                <div className="w-px h-5 bg-slate-700 mx-1" />
                <button onClick={() => { setZoom(1); setPan({x:0, y:0}); }} className="p-2 hover:bg-slate-700 rounded-md text-slate-300" title="Reset"><RotateCcw size={16}/></button>
             </div>
             <button onClick={onClose} className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors">
               <X size={24} />
             </button>
          </div>
        </div>

        {/* Viewport Area */}
        <div className="flex-1 relative bg-black/50 overflow-hidden flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-slate-800">
          
          {/* Frame 1: Original */}
          <div 
             ref={containerRef}
             className={`relative flex-1 overflow-hidden flex items-center justify-center bg-slate-100/5 ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
             onPointerDown={startPan}
          >
             {images ? (
                <>
                  <div className="absolute top-4 left-4 z-10 bg-black/60 backdrop-blur-sm text-white text-xs font-bold px-3 py-1 rounded-full border border-white/10 pointer-events-none">
                    Original
                  </div>
                  <img 
                    ref={imageRef}
                    src={images.original} 
                    alt="Original"
                    onLoad={updateBounds}
                    className="max-w-full max-h-full w-auto h-auto object-contain select-none transition-transform duration-75 ease-out will-change-transform origin-center shadow-2xl"
                    style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                    draggable={false}
                  />
                </>
             ) : <div className="text-slate-500 flex gap-2"><ZoomIn className="animate-pulse"/> Loading...</div>}
          </div>

          {/* Frame 2: Compressed */}
          <div 
             className={`relative flex-1 overflow-hidden flex items-center justify-center bg-slate-100/5 ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
             onPointerDown={startPan}
          >
             {images ? (
                <>
                   <div className="absolute top-4 left-4 z-10 flex gap-2 pointer-events-none">
                      <div className="bg-blue-600/90 backdrop-blur-sm text-white text-xs font-bold px-3 py-1 rounded-full shadow-lg">
                        Compressed
                      </div>
                      <div className={`backdrop-blur-sm text-white text-xs font-bold px-3 py-1 rounded-full shadow-lg border border-white/10 ${dpi < 100 ? 'bg-rose-500/80' : 'bg-black/60'}`}>
                         {dpi} DPI
                      </div>
                   </div>
                   
                   {/* Sync Indicator Overlay */}
                   {zoom > 1 && (
                      <div className="absolute inset-0 pointer-events-none border-2 border-blue-500/0 active:border-blue-500/20 transition-colors z-20 flex items-center justify-center">
                         {isPanning && <div className="bg-black/50 text-white px-4 py-2 rounded-full backdrop-blur-md flex items-center gap-2"><Move size={14}/> Panning Synced</div>}
                      </div>
                   )}

                   <img 
                    src={images.compressed} 
                    alt="Compressed"
                    className={`max-w-full max-h-full w-auto h-auto object-contain select-none transition-transform duration-75 ease-out will-change-transform origin-center shadow-2xl ${loading ? 'opacity-50 blur-sm' : 'opacity-100'}`}
                    style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                    draggable={false}
                  />
                </>
             ) : <div className="text-slate-500 flex gap-2"><ZoomIn className="animate-pulse"/> Loading...</div>}
          </div>

        </div>

        {/* Footer Controls */}
        <div className="p-6 border-t border-slate-800 bg-slate-900 flex flex-col lg:flex-row items-center justify-between gap-6 z-20">
          
          <div className="w-full lg:w-1/2 flex flex-col gap-2">
            <div className="flex justify-between items-center mb-1">
              <label className="text-sm font-bold text-slate-300 flex items-center gap-2">
                <Settings2 size={16} /> Compression Level
              </label>
              <span className="text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
                Scale: {currentConfig.scale.toFixed(1)}x • Quality: {Math.round(currentConfig.quality * 100)}%
              </span>
            </div>
            
            <div className="flex items-center gap-4">
               <span className="text-xs font-medium text-slate-500">Min Size</span>
               <input 
                 type="range" 
                 min="0" 
                 max="100" 
                 value={sliderValue}
                 onChange={handleSliderChange}
                 className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500 hover:accent-blue-400"
               />
               <span className="text-xs font-medium text-slate-500">Max Quality</span>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-6 w-full lg:w-auto">
            {sizeEstimate && (
              <div className={`flex flex-col items-end min-w-[140px] transition-opacity duration-200 ${loading ? 'opacity-50' : 'opacity-100'}`}>
                <div className="text-xs text-slate-500 uppercase tracking-wider font-bold mb-1">New Size</div>
                <div className="flex items-center gap-2 text-white font-mono text-xl font-bold leading-none">
                  <HardDrive size={18} className="text-slate-500" />
                  ~{formatSize(sizeEstimate.estimatedSize)}
                </div>
                <div className={`text-xs font-bold mt-1 px-1.5 py-0.5 rounded ${sizeEstimate.ratio >= 1 ? 'text-amber-400 bg-amber-900/30' : 'text-green-400 bg-green-900/30'}`}>
                  {sizeEstimate.ratio >= 1 ? 'No Reduction' : `-${Math.round((1 - sizeEstimate.ratio) * 100)}%`}
                </div>
              </div>
            )}

            <div className="h-10 w-px bg-slate-700 hidden sm:block" />

            <div className="flex items-center gap-3 w-full sm:w-auto">
               <button 
                onClick={() => onConfirm(currentConfig)}
                className={`w-full sm:w-auto px-6 py-3 rounded-xl font-bold text-white transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-900/20 ${dpi < 100 ? 'bg-rose-600 hover:bg-rose-500' : 'bg-blue-600 hover:bg-blue-500'}`}
              >
                {dpi < 100 && <AlertTriangle size={18} />}
                {dpi < 100 ? 'Use Anyway' : 'Apply Compression'}
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
