
import { PDFDocument, rgb, degrees, StandardFonts, PDFFont, breakTextIntoLines } from 'pdf-lib';
import JSZip from 'jszip';
import { PDFMetadata } from '../types';
import * as pdfjsLib from 'pdfjs-dist';

// Fix for ESM import of pdfjs-dist which might be wrapped in default
const pdfjs = (pdfjsLib as any).default || pdfjsLib;

// Configure Worker
if (typeof window !== 'undefined') {
  // Ensure GlobalWorkerOptions exists before setting workerSrc
  if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
    // Use cdnjs for the worker as it is more reliable for classic script loading via importScripts
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
}

// Helper to read file as ArrayBuffer
const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
};

// Helper to safely get Uint8Array from ArrayBuffer
// Slicing ensures we pass a copy if needed and avoid detachment issues with some browser implementations of workers
const getSafeBuffer = (buffer: ArrayBuffer): Uint8Array => {
  return new Uint8Array(buffer).slice(0);
};

// --- Expose PDF.js Document for UI ---
export const loadPDFDocument = async (file: File) => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  return pdfjs.getDocument(getSafeBuffer(arrayBuffer)).promise;
};

// --- Analysis & Utilities ---

export const analyzePDF = async (file: File): Promise<{ isTextHeavy: boolean; pageCount: number }> => {
  try {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const loadingTask = pdfjs.getDocument(getSafeBuffer(arrayBuffer));
    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;
    const maxPagesToCheck = Math.min(numPages, 3);
    let totalTextItems = 0;

    for (let i = 1; i <= maxPagesToCheck; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      totalTextItems += textContent.items.length;
    }

    const avgTextItems = totalTextItems / maxPagesToCheck;
    return {
      isTextHeavy: avgTextItems > 20,
      pageCount: numPages
    };
  } catch (e) {
    console.error("Analysis failed", e);
    return { isTextHeavy: false, pageCount: 0 };
  }
};

export const getPdfPagePreviews = async (file: File): Promise<string[]> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjs.getDocument(getSafeBuffer(arrayBuffer));
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const previews: string[] = [];
  const maxPages = Math.min(numPages, 50); // Cap at 50 for performance safety in previews

  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 0.3 }); // Thumbnail scale
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    
    if (!context) continue;

    canvas.height = viewport.height;
    canvas.width = viewport.width;

    // Force opaque white background
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: context, viewport }).promise;
    previews.push(canvas.toDataURL('image/jpeg', 0.8));
  }
  return previews;
};

// --- Core PDF Functions ---

export const mergePDFs = async (files: File[]): Promise<Uint8Array> => {
  const mergedPdf = await PDFDocument.create();
  for (const file of files) {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const pdf = await PDFDocument.load(arrayBuffer);
    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }
  return mergedPdf.save();
};

export const createPDFFromImages = async (files: File[]): Promise<Uint8Array> => {
  const pdfDoc = await PDFDocument.create();
  for (const file of files) {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    let image;
    if (file.type === 'image/jpeg') {
      image = await pdfDoc.embedJpg(arrayBuffer);
    } else if (file.type === 'image/png') {
      image = await pdfDoc.embedPng(arrayBuffer);
    } else {
      continue;
    }
    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  return pdfDoc.save();
};

export const splitPDF = async (file: File): Promise<Blob> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const zip = new JSZip();
  const pageCount = pdfDoc.getPageCount();

  for (let i = 0; i < pageCount; i++) {
    const newPdf = await PDFDocument.create();
    const [page] = await newPdf.copyPages(pdfDoc, [i]);
    newPdf.addPage(page);
    const pdfBytes = await newPdf.save();
    zip.file(`${file.name.replace('.pdf', '')}_page_${i + 1}.pdf`, pdfBytes);
  }
  return zip.generateAsync({ type: 'blob' });
};

export const extractPages = async (file: File, pageIndices: number[]): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const newPdf = await PDFDocument.create();
  const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
  copiedPages.forEach((page) => newPdf.addPage(page));
  return newPdf.save();
};

export const rotatePDF = async (file: File, rotation: 90 | 180 | 270): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const pages = pdfDoc.getPages();
  pages.forEach(page => {
    const currentRotation = page.getRotation();
    page.setRotation(degrees(currentRotation.angle + rotation));
  });
  return pdfDoc.save();
};

export const rotateSpecificPages = async (file: File, rotations: { pageIndex: number, rotation: number }[]): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const pages = pdfDoc.getPages();
  rotations.forEach(({ pageIndex, rotation }) => {
    if (pageIndex >= 0 && pageIndex < pages.length) {
      const page = pages[pageIndex];
      const currentRotation = page.getRotation();
      page.setRotation(degrees(currentRotation.angle + rotation));
    }
  });
  return pdfDoc.save();
};

export const protectPDF = async (file: File, password: string): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  (pdfDoc as any).encrypt({
    userPassword: password,
    ownerPassword: password,
    permissions: {
      printing: 'highResolution',
      modifying: false,
      copying: false,
      annotating: false,
      fillingForms: false,
      contentAccessibility: false,
      documentAssembly: false,
    },
  });
  return pdfDoc.save();
};

export const getPDFMetadata = async (file: File): Promise<PDFMetadata> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
  return {
    title: pdfDoc.getTitle(),
    author: pdfDoc.getAuthor(),
    subject: pdfDoc.getSubject(),
    keywords: pdfDoc.getKeywords(),
    creator: pdfDoc.getCreator(),
    producer: pdfDoc.getProducer(),
    creationDate: pdfDoc.getCreationDate(),
    modificationDate: pdfDoc.getModificationDate(),
  };
};

export const setPDFMetadata = async (file: File, metadata: PDFMetadata): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  if (metadata.title !== undefined) pdfDoc.setTitle(metadata.title);
  if (metadata.author !== undefined) pdfDoc.setAuthor(metadata.author);
  if (metadata.subject !== undefined) pdfDoc.setSubject(metadata.subject);
  if (metadata.keywords !== undefined) pdfDoc.setKeywords(metadata.keywords.split(' ')); 
  if (metadata.creator !== undefined) pdfDoc.setCreator(metadata.creator);
  if (metadata.producer !== undefined) pdfDoc.setProducer(metadata.producer);
  if (metadata.creationDate !== undefined) pdfDoc.setCreationDate(metadata.creationDate);
  if (metadata.modificationDate !== undefined) pdfDoc.setModificationDate(metadata.modificationDate);
  return pdfDoc.save();
};

export const getPDFPageCount = async (file: File): Promise<number> => {
  try {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
    return pdfDoc.getPageCount();
  } catch (e) {
    console.error("Error counting pages", e);
    return 0;
  }
};

// --- NEW CAPABILITIES ---

export const flattenPDF = async (file: File): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const form = pdfDoc.getForm();
  form.flatten();
  return pdfDoc.save();
};

export const unlockPDF = async (file: File, password: string): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  // Loading with password and saving without options removes encryption
  const pdfDoc = await PDFDocument.load(arrayBuffer, { password } as any);
  return pdfDoc.save();
};

export const extractTextFromPDF = async (file: File): Promise<string> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjs.getDocument(getSafeBuffer(arrayBuffer));
  const pdf = await loadingTask.promise;
  let fullText = '';
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str).join(' ');
    fullText += `--- Page ${i} ---\n${pageText}\n\n`;
  }
  return fullText;
};

// --- REFLOW / BLOCK EDITING LOGIC ---

export type BlockType = 'text' | 'image' | 'spacing';

export interface LayoutBlock {
  id: string;
  type: BlockType;
  content: string; // Text content or DataURL for image
  width?: number; // For images (px or ratio)
  height?: number; // For images
  fontSize?: number; // For text
  align?: 'left' | 'center' | 'right';
  fontFamily?: string; // standard font name
}

// 1. Parse PDF into Blocks
export const parsePDFToBlocks = async (file: File): Promise<LayoutBlock[]> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjs.getDocument(getSafeBuffer(arrayBuffer));
  const pdf = await loadingTask.promise;
  
  const blocks: LayoutBlock[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    
    // Sort items by Y (descending) then X (ascending)
    const items = content.items.map((item: any) => ({
      str: item.str,
      x: item.transform[4],
      y: item.transform[5], // PDF Y is bottom-up
      h: item.height || 12,
      fontName: item.fontName,
      hasEOL: item.hasEOL
    }));

    // Grouping Logic (Simplified)
    // We group items that are on the same line (approx Y)
    // Then group lines that are close (approx Y gap)
    
    // 1. Group by Lines
    items.sort((a: any, b: any) => {
      const yDiff = Math.abs(a.y - b.y);
      if (yDiff < 5) return a.x - b.x; // Same line
      return b.y - a.y; // Top to bottom
    });

    let currentBlock: LayoutBlock | null = null;
    let lastY = -999;

    items.forEach((item: any) => {
      // Basic gap detection for paragraph breaks
      const isNewLine = Math.abs(item.y - lastY) > (item.h * 1.5);
      
      if (!currentBlock || (isNewLine && Math.abs(item.y - lastY) > item.h * 2)) {
         // Start new block if gap is large
         if (currentBlock && currentBlock.content.trim().length > 0) blocks.push(currentBlock);
         
         currentBlock = {
           id: crypto.randomUUID(),
           type: 'text',
           content: item.str,
           fontSize: Math.round(item.h) || 12,
           align: 'left'
         };
      } else {
         // Append to current block
         const spacer = isNewLine ? ' ' : ''; // If strict newline, maybe \n? For flow, space is usually safer unless we detect bullets
         currentBlock.content += (currentBlock.content.endsWith(' ') ? '' : ' ') + item.str;
      }
      lastY = item.y;
    });

    if (currentBlock) blocks.push(currentBlock);
    
    // Add Page Break Spacer
    if (i < pdf.numPages) {
      blocks.push({ id: crypto.randomUUID(), type: 'spacing', content: '', height: 20 });
    }
  }

  return blocks;
};

// 2. Generate PDF from Blocks (Reflow Engine)
export const generateReflowedPDF = async (blocks: LayoutBlock[]): Promise<Uint8Array> => {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  
  // Page Settings
  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const margin = 50;
  const contentWidth = pageWidth - (margin * 2);
  
  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let cursorY = pageHeight - margin;

  const checkPageBreak = (neededHeight: number) => {
    if (cursorY - neededHeight < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      cursorY = pageHeight - margin;
    }
  };

  for (const block of blocks) {
    if (block.type === 'spacing') {
      cursorY -= (block.height || 20);
      continue;
    }

    if (block.type === 'image') {
       // Embed Image
       try {
         let image;
         if (block.content.startsWith('data:image/png')) image = await pdfDoc.embedPng(block.content);
         else image = await pdfDoc.embedJpg(block.content);
         
         // Calculate dimensions (fit to width)
         const imgDims = image.scale(1);
         let renderWidth = contentWidth;
         let renderHeight = (imgDims.height / imgDims.width) * renderWidth;
         
         // If block has specific width ratio (from resizing in UI), use it
         if (block.width && block.width > 0 && block.width <= 1) {
            renderWidth = contentWidth * block.width;
            renderHeight = (imgDims.height / imgDims.width) * renderWidth;
         }

         checkPageBreak(renderHeight + 20);

         // Center image if smaller than full width
         const xOffset = margin + (contentWidth - renderWidth) / 2;

         page.drawImage(image, {
           x: xOffset,
           y: cursorY - renderHeight,
           width: renderWidth,
           height: renderHeight
         });
         
         cursorY -= (renderHeight + 20); // Spacing after image
       } catch (e) {
         console.warn("Failed to embed image in reflow", e);
       }
    }

    if (block.type === 'text') {
      const fontSize = block.fontSize || 12;
      const lineHeight = fontSize * 1.2;
      
      // Word Wrap
      const paragraphs = block.content.split('\n');
      
      for (const p of paragraphs) {
        if (!p.trim()) {
           cursorY -= lineHeight; // Empty line
           continue; 
        }

        // Simple word wrap
        const words = p.split(' ');
        let currentLine = '';
        
        for (const word of words) {
           const testLine = currentLine ? `${currentLine} ${word}` : word;
           const width = font.widthOfTextAtSize(testLine, fontSize);
           
           if (width > contentWidth) {
              // Draw current line
              checkPageBreak(lineHeight);
              page.drawText(currentLine, { x: margin, y: cursorY, size: fontSize, font: font, lineHeight });
              cursorY -= lineHeight;
              currentLine = word;
           } else {
              currentLine = testLine;
           }
        }
        // Draw last line
        if (currentLine) {
           checkPageBreak(lineHeight);
           page.drawText(currentLine, { x: margin, y: cursorY, size: fontSize, font: font, lineHeight });
           cursorY -= lineHeight;
        }
        
        cursorY -= (lineHeight * 0.5); // Paragraph spacing
      }
      cursorY -= 10; // Block spacing
    }
  }

  return pdfDoc.save();
};

// --- SIGNATURE SUPPORT ---

export interface SignaturePlacement {
  id: string;
  pageIndex: number;
  dataUrl: string; // PNG/JPEG base64
  x: number; // Percentage 0-1
  y: number; // Percentage 0-1
  width: number; // Percentage of page width 0-1
  aspectRatio: number; // width/height
}

export const applySignaturesToPDF = async (file: File, signatures: SignaturePlacement[]): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const pages = pdfDoc.getPages();

  for (const sig of signatures) {
    if (sig.pageIndex < 0 || sig.pageIndex >= pages.length) continue;
    
    const page = pages[sig.pageIndex];
    const { width: pageWidth, height: pageHeight } = page.getSize();
    
    // Embed the image
    let image;
    // Simple check for mime type signature in base64
    if (sig.dataUrl.startsWith('data:image/png')) {
      image = await pdfDoc.embedPng(sig.dataUrl);
    } else {
      image = await pdfDoc.embedJpg(sig.dataUrl);
    }
    
    // Calculate final dimensions based on percentage
    const finalWidth = pageWidth * sig.width;
    const finalHeight = finalWidth / sig.aspectRatio;
    
    // Calculate coordinates
    // PDF coordinates start at bottom-left
    // UI input 'y' is typically top-down percentage
    const pdfX = pageWidth * sig.x;
    const pdfY = pageHeight - (pageHeight * sig.y) - finalHeight;

    page.drawImage(image, {
      x: pdfX,
      y: pdfY,
      width: finalWidth,
      height: finalHeight,
    });
  }

  return pdfDoc.save();
};

// --- EDITING LOGIC (Redact & Replace) ---

export interface TextEdit {
  pageIndex: number;
  originalText: string;
  newText: string;
  x: number; // PDF Points
  y: number; // PDF Points (bottom-left origin)
  width: number; // PDF Points
  height: number; // PDF Points
  fontSize: number;
  fontName: string;
  backgroundColor: [number, number, number]; // RGB 0-255
}

export const saveEditedPDF = async (file: File, edits: TextEdit[]): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  
  // Embed standard fonts
  const fontHelvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontTimes = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontCourier = await pdfDoc.embedFont(StandardFonts.Courier);

  const getFont = (name: string): PDFFont => {
    const n = name.toLowerCase();
    if (n.includes('times') || n.includes('roman')) return fontTimes;
    if (n.includes('courier') || n.includes('mono')) return fontCourier;
    return fontHelvetica;
  };

  const pages = pdfDoc.getPages();

  for (const edit of edits) {
    if (edit.pageIndex < 0 || edit.pageIndex >= pages.length) continue;
    const page = pages[edit.pageIndex];
    const { height } = page.getSize();

    // 1. REDACT (Draw rectangle over old text)
    // Need to handle coordinate flip (PDF is bottom-up, UI provided top-down usually, but let's assume UI passed PDF coords or we convert there)
    // Our UI implementation will pass PDF coords directly to keep this pure.
    
    // Background color 0-255 -> 0-1
    const bgR = edit.backgroundColor[0] / 255;
    const bgG = edit.backgroundColor[1] / 255;
    const bgB = edit.backgroundColor[2] / 255;

    page.drawRectangle({
      x: edit.x,
      y: edit.y,
      width: edit.width,
      height: edit.height * 1.2, // Slightly larger to cover ascenders/descenders
      color: rgb(bgR, bgG, bgB),
    });

    // 2. REPLACE (Draw new text)
    if (edit.newText.trim() !== "") {
      const font = getFont(edit.fontName);
      // Center vertically in the box approx
      page.drawText(edit.newText, {
        x: edit.x,
        y: edit.y + (edit.height * 0.1), // Slight bump for baseline
        size: edit.fontSize,
        font: font,
        color: rgb(0, 0, 0), // Assuming black text for MVP, could sample color too
      });
    }
  }

  return pdfDoc.save();
};

// --- COMPRESSION SERVICE ---

export type CompressionLevel = 'extreme' | 'recommended' | 'less';

export interface AdaptiveConfig {
  scale: number;
  quality: number;
  projectedDPI: number;
}

export const getAdaptiveConfig = (level: CompressionLevel, isTextHeavy: boolean): AdaptiveConfig => {
  // DPI reference: 1.0 scale is approx 72-96 DPI depending on PDF user unit, usually 72 PDF points = 1 inch.
  // We assume standard 72 DPI for scale 1.0.
  
  if (level === 'extreme') {
    return {
      scale: isTextHeavy ? 1.0 : 0.6, // Text needs readability
      quality: 0.5,
      projectedDPI: isTextHeavy ? 72 : 43
    };
  } else if (level === 'less') {
    return {
      scale: 2.0,
      quality: 0.9,
      projectedDPI: 144
    };
  } else {
    // Recommended
    return {
      scale: isTextHeavy ? 1.5 : 1.0,
      quality: 0.7,
      projectedDPI: isTextHeavy ? 108 : 72
    };
  }
};

export const getInterpolatedConfig = (sliderValue: number, isTextHeavy: boolean): AdaptiveConfig => {
  // slider 0-100
  // min scale 0.5 (36 DPI), max 2.5 (180 DPI)
  // quality 0.3 to 1.0
  
  const minScale = 0.5;
  const maxScale = 2.5;
  const scale = minScale + (sliderValue / 100) * (maxScale - minScale);
  
  const quality = 0.3 + (sliderValue / 100) * 0.7;
  
  return {
    scale,
    quality,
    projectedDPI: Math.round(scale * 72)
  };
};

export const calculateTargetSize = (originalSize: number, level: CompressionLevel, isTextHeavy: boolean): number => {
  const factors = {
    extreme: isTextHeavy ? 0.4 : 0.2,
    recommended: isTextHeavy ? 0.7 : 0.5,
    less: 0.9
  };
  return Math.round(originalSize * factors[level]);
};

export const generatePreviewPair = async (file: File, config: AdaptiveConfig): Promise<{ original: string; compressed: string; metrics: { estimatedTotalSize: number } }> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjs.getDocument(getSafeBuffer(arrayBuffer));
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  
  // 1. Render Original (High Quality Reference) - scale 2.0 for crispness
  const viewportOrig = page.getViewport({ scale: 2.0 });
  const canvasOrig = document.createElement('canvas');
  canvasOrig.width = viewportOrig.width;
  canvasOrig.height = viewportOrig.height;
  const ctxOrig = canvasOrig.getContext('2d');
  if(ctxOrig) {
      ctxOrig.fillStyle = '#ffffff';
      ctxOrig.fillRect(0,0, canvasOrig.width, canvasOrig.height);
      await page.render({ canvasContext: ctxOrig, viewport: viewportOrig }).promise;
  }
  const originalUrl = canvasOrig.toDataURL('image/png'); // Lossless for preview

  // 2. Render Compressed (Target Config)
  const viewportComp = page.getViewport({ scale: config.scale });
  const canvasComp = document.createElement('canvas');
  canvasComp.width = viewportComp.width;
  canvasComp.height = viewportComp.height;
  const ctxComp = canvasComp.getContext('2d');
  if(ctxComp) {
      ctxComp.fillStyle = '#ffffff';
      ctxComp.fillRect(0,0, canvasComp.width, canvasComp.height);
      await page.render({ canvasContext: ctxComp, viewport: viewportComp }).promise;
  }
  
  // Get compressed data URL
  const compressedUrl = canvasComp.toDataURL('image/jpeg', config.quality);
  
  // Estimate size
  // Base64 length * 0.75 gives bytes approx.
  // This is for one page.
  const pageSizeBytes = (compressedUrl.length - 22) * 0.75; 
  const estimatedTotalSize = pageSizeBytes * pdf.numPages;

  return {
    original: originalUrl,
    compressed: compressedUrl,
    metrics: { estimatedTotalSize }
  };
};

export const compressPDFAdaptive = async (
  file: File, 
  level: CompressionLevel, 
  onProgress: (p: number) => void,
  overrideSafety: boolean = false,
  customConfig?: AdaptiveConfig
): Promise<{ status: 'success' | 'blocked'; data: Uint8Array; meta: { compressedSize: number; projectedDPI: number; strategyUsed: string } }> => {
  
  const analysis = await analyzePDF(file);
  const config = customConfig || getAdaptiveConfig(level, analysis.isTextHeavy);

  // If strict mode and safety not overriden
  if (!overrideSafety && config.projectedDPI < 70 && analysis.isTextHeavy) {
     if (level === 'extreme') return { status: 'blocked', data: new Uint8Array(0), meta: { compressedSize: 0, projectedDPI: 0, strategyUsed: '' } };
  }

  const arrayBuffer = await readFileAsArrayBuffer(file);
  const loadingTask = pdfjs.getDocument(getSafeBuffer(arrayBuffer));
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;

  const newPdfDoc = await PDFDocument.create();

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: config.scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    const context = canvas.getContext('2d');
    if (!context) continue;
    
    // White background is crucial for transparency handling
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    
    await page.render({ canvasContext: context, viewport }).promise;
    
    // Compression happens here
    const imgDataUrl = canvas.toDataURL('image/jpeg', config.quality);
    
    const embeddedImage = await newPdfDoc.embedJpg(imgDataUrl);
    
    // Maintain original dimensions
    const originalViewport = page.getViewport({ scale: 1.0 });
    
    const newPage = newPdfDoc.addPage([originalViewport.width, originalViewport.height]);
    newPage.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: originalViewport.width,
      height: originalViewport.height,
    });
    
    onProgress(Math.round((i / numPages) * 90));
  }

  const pdfBytes = await newPdfDoc.save();
  onProgress(100);

  return {
    status: 'success',
    data: pdfBytes,
    meta: {
      compressedSize: pdfBytes.byteLength,
      projectedDPI: config.projectedDPI,
      strategyUsed: `Rasterization (Scale ${config.scale.toFixed(1)}, Q${config.quality.toFixed(1)})`
    }
  };
};
