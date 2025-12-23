
import React, { useState, useEffect, useRef } from 'react';
import { FileUpload } from '../UI/FileUpload';
import { PDFFile, ProcessingStatus } from '../../types';
import { parsePDFToBlocks, generateReflowedPDF, LayoutBlock } from '../../services/pdfService';
import { Loader2, Save, Undo2, Image as ImageIcon, Trash2, GripVertical, AlertTriangle, ArrowDown } from 'lucide-react';
import { motion, Reorder, AnimatePresence } from 'framer-motion';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';

export const EditPDF: React.FC = () => {
  const [file, setFile] = useState<PDFFile | null>(null);
  const [status, setStatus] = useState<ProcessingStatus>({ isProcessing: false, progress: 0, message: '' });
  
  // Block Editor State
  const [blocks, setBlocks] = useState<LayoutBlock[]>([]);
  const [isParsing, setIsParsing] = useState(false);

  // 1. Load & Parse Document
  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0 || files[0].type !== 'application/pdf') return;
    const f = files[0];
    
    setFile({ id: uuidv4(), file: f, name: f.name, size: f.size });
    setIsParsing(true);
    
    try {
      const parsedBlocks = await parsePDFToBlocks(f);
      setBlocks(parsedBlocks);
      setIsParsing(false);
    } catch (e) {
      console.error(e);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Could not parse PDF layout' });
      setIsParsing(false);
    }
  };

  // 2. Editor Actions
  const handleTextChange = (id: string, newText: string) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, content: newText } : b));
  };

  const deleteBlock = (id: string) => {
    setBlocks(prev => prev.filter(b => b.id !== id));
  };

  const handleInsertImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result) {
          const newBlock: LayoutBlock = {
            id: uuidv4(),
            type: 'image',
            content: ev.target.result as string,
            width: 1, // Full width default
          };
          // Insert at top or focused index? Let's insert at top for now or allow drag
          setBlocks(prev => [newBlock, ...prev]);
        }
      };
      reader.readAsDataURL(e.target.files[0]);
    }
  };

  const handleSave = async () => {
    if (!file) return;
    setStatus({ isProcessing: true, progress: 10, message: 'Reflowing document...' });
    
    try {
      const pdfBytes = await generateReflowedPDF(blocks);
      
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reflowed-${file.name}`;
      a.click();
      
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus({ isProcessing: false, progress: 100, message: 'Done!' });
    } catch (e) {
      console.error(e);
      setStatus({ isProcessing: false, progress: 0, message: '', error: 'Failed to regenerate PDF' });
    }
  };

  // Auto-resize textarea
  const TextArea: React.FC<{ block: LayoutBlock }> = ({ block }) => {
    const ref = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
      if (ref.current) {
        ref.current.style.height = 'auto';
        ref.current.style.height = ref.current.scrollHeight + 'px';
      }
    }, [block.content]);

    return (
      <textarea
        ref={ref}
        value={block.content}
        onChange={(e) => handleTextChange(block.id, e.target.value)}
        className="w-full bg-transparent resize-none outline-none border-none focus:ring-0 p-0 text-slate-800 dark:text-slate-200 leading-relaxed font-serif"
        style={{ fontSize: (block.fontSize || 12) + 'px' }}
      />
    );
  };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 flex flex-col h-[calc(100vh-80px)]">
      {/* Header */}
      <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
         <div>
            <Link to="/" className="text-sm font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors">← Back</Link>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2 mt-1">
              Reflow Editor <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">New</span>
            </h1>
            <p className="text-sm text-slate-500">Reconstructs your PDF as editable blocks. Best for text documents.</p>
         </div>
         {file && (
           <div className="flex gap-2">
             <label className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg font-medium cursor-pointer transition-colors flex items-center gap-2">
               <ImageIcon size={18} /> Insert Image
               <input type="file" accept="image/*" className="hidden" onChange={handleInsertImage} />
             </label>
             <button onClick={handleSave} disabled={status.isProcessing || isParsing} className="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 flex items-center gap-2 disabled:opacity-50">
               {status.isProcessing ? <Loader2 className="animate-spin" size={18}/> : <Save size={18}/>} Export PDF
             </button>
           </div>
         )}
      </div>

      {/* Main Content */}
      <div className="flex-1 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden relative flex flex-col">
        
        <AnimatePresence mode="wait">
          {!file ? (
            <motion.div 
              key="upload"
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} 
              className="m-auto w-full max-w-xl p-8"
            >
               <FileUpload onFilesSelected={handleFilesSelected} accept=".pdf" label="Drop PDF to edit layout" />
               <div className="mt-6 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl flex items-start gap-3">
                 <AlertTriangle className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" size={18} />
                 <div className="text-sm text-amber-800 dark:text-amber-200">
                   <strong>Reflow Mode:</strong> This tool extracts text and rebuilds the document flow. 
                   Complex layouts or scanned PDFs may lose formatting. Ideal for contracts, essays, and reports.
                 </div>
               </div>
            </motion.div>
          ) : isParsing ? (
             <div className="m-auto flex flex-col items-center justify-center text-slate-500">
                <Loader2 className="animate-spin mb-4 text-blue-500" size={40} />
                <p className="font-medium text-lg">Analyzing Document Layout...</p>
                <p className="text-sm opacity-70">Extracting paragraphs and structure</p>
             </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
               {/* Paper View */}
               <div className="max-w-[595px] mx-auto bg-white min-h-[842px] shadow-lg p-[50px] relative">
                  <Reorder.Group axis="y" values={blocks} onReorder={setBlocks} className="space-y-4">
                    {blocks.map((block) => (
                      <Reorder.Item key={block.id} value={block} className="group relative">
                        {/* Drag Handle (Hover) */}
                        <div className="absolute -left-10 top-0 bottom-0 w-8 flex items-start pt-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500">
                           <GripVertical size={20} />
                        </div>

                        {/* Delete Handle */}
                        <button 
                           onClick={() => deleteBlock(block.id)}
                           className="absolute -right-10 top-0 p-1 text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                           <Trash2 size={16} />
                        </button>

                        {/* Content */}
                        {block.type === 'text' ? (
                           <TextArea block={block} />
                        ) : block.type === 'image' ? (
                           <div className="relative group/image">
                             <img src={block.content} alt="" className="w-full h-auto rounded-sm" />
                             <div className="absolute inset-0 bg-blue-500/10 border-2 border-blue-500 opacity-0 group-hover/image:opacity-100 pointer-events-none transition-opacity" />
                           </div>
                        ) : (
                           <div className="h-8 border-b border-dashed border-slate-200 w-full flex items-center justify-center text-[10px] text-slate-300 uppercase tracking-widest select-none">
                             Page Break
                           </div>
                        )}
                      </Reorder.Item>
                    ))}
                  </Reorder.Group>

                  {/* Empty State / Bottom Area */}
                  {blocks.length === 0 && (
                     <div className="text-center py-20 text-slate-300">
                        Document is empty. Start typing or insert content.
                     </div>
                  )}
               </div>
               
               <div className="h-20" />
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
