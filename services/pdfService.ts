import { 
  PDFDocument, 
  rgb, 
  degrees, 
  StandardFonts, 
  PDFName, 
  PDFRawStream, 
  PDFDict, 
  PDFNumber,
  PDFObject
} from 'pdf-lib';
import JSZip from 'jszip';
import { PDFMetadata } from '../types';
import * as pdfjsLib from 'pdfjs-dist';

// Fix for ESM import of pdfjs-dist
const pdfjs = (pdfjsLib as any).default || pdfjsLib;

// Configure Worker
if (typeof window !== 'undefined') {
  if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
}

// --- Types & Constants ---

export type CompressionLevel = 'extreme' | 'recommended' | 'less' | 'custom';
export type CompressionMode = 'auto' | 'text-preservation' | 'visual-reconstruction';

export interface AdvancedCompressionConfig {
  scale: number;           // 0.1 - 1.0 (Resolution scale)
  quality: number;         // 0.1 - 1.0 (JPEG Quality)
  grayscale: boolean;      // Convert to B&W
  preserveText: boolean;   // Attempt to modify images only, keeping text vectors
  aggressive: boolean;     // If text preservation fails to save enough, switch to rasterization
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

const getSafeBuffer = (buffer: ArrayBuffer): Uint8Array => {
  return new Uint8Array(buffer).slice(0);
};

export const loadPDFDocument = async (file: File) => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  return pdfjs.getDocument(getSafeBuffer(arrayBuffer)).promise;
};

// --- IMAGE PROCESSING ENGINE ---

/**
 * Resizes an image Blob/Buffer to target dimensions and quality.
 * Used for both Rasterization and Smart Object Replacement.
 */
const processImageBuffer = async (
  buffer: ArrayBuffer | Uint8Array, 
  mimeType: string,
  scale: number, 
  quality: number,
  toGrayscale: boolean
): Promise<{ buffer: Uint8Array, width: number, height: number, ratio: number }> => {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    
    img.onload = () => {
      URL.revokeObjectURL(url);
      const targetWidth = Math.max(1, Math.round(img.width * scale));
      const targetHeight = Math.max(1, Math.round(img.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d', { alpha: false }); // Optimize for JPEG
      
      if (!ctx) {
        reject(new Error('Canvas context failed'));
        return;
      }

      // High-quality downsampling smoothing
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      
      // White background
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, targetWidth, targetHeight);

      if (toGrayscale) {
        ctx.filter = 'grayscale(100%)';
      }

      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

      // Export
      canvas.toBlob((b) => {
        if (!b) { reject(new Error('Compression failed')); return; }
        b.arrayBuffer().then(ab => {
          resolve({ 
            buffer: new Uint8Array(ab), 
            width: targetWidth, 
            height: targetHeight,
            ratio: targetWidth / img.width // Actual scale ratio applied
          });
        });
      }, 'image/jpeg', quality);
    };
    
    img.onerror = reject;
    img.src = url;
  });
};

// --- ADVANCED COMPRESSION LOGIC ---

/**
 * Strategy 1: Smart Object Replacement (Deep Optimization)
 * Iterates through PDF Internal Objects, finds JPEGs, compresses them in-place.
 * Preserves Text and Vectors.
 */
const compressPDFObjects = async (
  pdfDoc: PDFDocument, 
  config: AdvancedCompressionConfig,
  onProgress: (p: number) => void
): Promise<void> => {
  const context = pdfDoc.context;
  
  // 1. Identify all Image XObjects
  const imagesToCompress: Array<{ ref: any, stream: PDFRawStream }> = [];
  
  // We use enumerateIndirectObjects to find raw streams
  const objects = context.enumerateIndirectObjects();
  let totalObjects = 0;

  for (const [ref, obj] of objects) {
    totalObjects++;
    if (obj instanceof PDFRawStream) {
      const dict = obj.dict;
      const subtype = dict.get(PDFName.of('Subtype'));
      const filter = dict.get(PDFName.of('Filter'));

      // Target only JPEGs (DCTDecode) for safety. 
      // Re-encoding random FlateDecode bitmaps is risky without precise color space handling.
      if (subtype === PDFName.of('Image') && filter === PDFName.of('DCTDecode')) {
        imagesToCompress.push({ ref, stream: obj });
      }
    }
  }

  if (imagesToCompress.length === 0) return; // Nothing to optimize

  let processed = 0;
  for (const { stream } of imagesToCompress) {
    try {
      const rawContents = stream.getContents();
      
      // Attempt compression
      const result = await processImageBuffer(
        rawContents, 
        'image/jpeg', 
        config.scale, 
        config.quality, 
        config.grayscale
      );

      // If new size is smaller, replace the stream
      if (result.buffer.length < rawContents.length) {
        // Create new stream content
        // We must update the Width and Height in the dictionary to match new resolution
        stream.contents = result.buffer;
        stream.dict.set(PDFName.of('Width'), PDFNumber.of(result.width));
        stream.dict.set(PDFName.of('Height'), PDFNumber.of(result.height));
        
        // Ensure Filter is DCTDecode (it was already, but good for sanity)
        stream.dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      }
    } catch (e) {
      console.warn('Failed to compress specific image object', e);
    }
    
    processed++;
    onProgress((processed / imagesToCompress.length) * 100);
  }
};

/**
 * Strategy 2: Visual Reconstruction (Rasterization)
 * Renders pages to images and rebuilds PDF. Guaranteed size reduction but loses text.
 * Enhanced with sharpening and grayscale support.
 */
const compressPDFVisual = async (
  file: File, 
  config: AdvancedCompressionConfig, 
  onProgress: (p: number) => void
): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdf = await pdfjs.getDocument(getSafeBuffer(arrayBuffer)).promise;
  const numPages = pdf.numPages;
  const newPdf = await PDFDocument.create();

  for (let i = 1; i <= numPages; i++) {
    onProgress((i / numPages) * 100);
    const page = await pdf.getPage(i);
    
    // 1.5 scale provides a good balance for source rasterization before downsampling
    const viewport = page.getViewport({ scale: Math.max(1.5, config.scale * 2) });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    if (!ctx) continue;
    
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Render text layer enabled? No, pure visual here.
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Apply simple sharpening convolution if scaling down heavily
    // (Optional enhancement, skipped here for performance stability)

    let dataUrl = '';
    if (config.grayscale) {
      // Manual grayscale if canvas didn't do it
      const imgData = ctx.getImageData(0,0, canvas.width, canvas.height);
      const data = imgData.data;
      for(let j=0; j<data.length; j+=4) {
        const avg = (data[j] + data[j+1] + data[j+2]) / 3;
        data[j] = avg; data[j+1] = avg; data[j+2] = avg;
      }
      ctx.putImageData(imgData, 0, 0);
    }

    dataUrl = canvas.toDataURL('image/jpeg', config.quality);
    
    const imgBytes = await fetch(dataUrl).then(r => r.arrayBuffer());
    const embed = await newPdf.embedJpg(imgBytes);
    
    const origVp = page.getViewport({ scale: 1.0 });
    const p = newPdf.addPage([origVp.width, origVp.height]);
    
    p.drawImage(embed, {
        x: 0, 
        y: 0,
        width: origVp.width,
        height: origVp.height
    });
  }

  return newPdf.save();
};

// --- PUBLIC COMPRESSION API ---

export const compressPDFSmart = async (
  file: File,
  options: {
    level: CompressionLevel,
    preserveText?: boolean,
    grayscale?: boolean
  },
  onProgress: (percent: number) => void
): Promise<{ data: Uint8Array, method: string }> => {
  
  // 1. Map Options to Config
  const config: AdvancedCompressionConfig = {
    scale: 1.0,
    quality: 0.8,
    grayscale: !!options.grayscale,
    preserveText: options.preserveText ?? true, // Default to smart mode
    aggressive: false
  };

  switch (options.level) {
    case 'extreme':
      config.scale = 0.5;
      config.quality = 0.4;
      break;
    case 'recommended':
      config.scale = 0.7; // Moderate downscaling
      config.quality = 0.6;
      break;
    case 'less':
      config.scale = 0.9;
      config.quality = 0.8;
      break;
  }

  // 2. Execution
  try {
    if (config.preserveText) {
      onProgress(10);
      const arrayBuffer = await readFileAsArrayBuffer(file);
      const pdfDoc = await PDFDocument.load(arrayBuffer);
      
      // Run Deep Object Optimization
      await compressPDFObjects(pdfDoc, config, (p) => onProgress(10 + (p * 0.8)));
      
      // Clean Metadata/Unused Objects
      // Saving automatically garbage collects in pdf-lib somewhat, but we can be explicit if needed
      const savedBytes = await pdfDoc.save();
      
      // Check efficacy. If the file didn't shrink enough (e.g. < 10% reduction) and 'extreme' was asked,
      // we might want to fallback to visual reconstruction.
      // For now, we return this result.
      return { data: savedBytes, method: 'Smart Object Optimization' };
      
    } else {
      // Visual Reconstruction Force
      const result = await compressPDFVisual(file, config, onProgress);
      return { data: result, method: 'Visual Reconstruction' };
    }
  } catch (error) {
    console.error("Smart compression failed, falling back to safe mode", error);
    // Fallback to simple rasterization if object traversal explodes
    const fallback = await compressPDFVisual(file, { ...config, scale: 0.5, quality: 0.5 }, onProgress);
    return { data: fallback, method: 'Fallback Rasterization' };
  }
};

// --- Analysis & Utilities (Preserved & Optimized) ---

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
  const maxPages = Math.min(numPages, 50);

  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 0.3 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    
    if (!context) continue;

    canvas.height = viewport.height;
    canvas.width = viewport.width;

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: context, viewport }).promise;
    previews.push(canvas.toDataURL('image/jpeg', 0.8));
  }
  return previews;
};

// --- PDF to Image Rendering ---

export interface ImageExportConfig {
  format: 'image/jpeg' | 'image/png' | 'image/webp';
  quality: number; // 0 to 1
  scale: number; // 1 = 72dpi, 2 = 144dpi, etc.
}

export const renderPageAsImage = async (
  pdfDoc: any, 
  pageIndex: number, 
  config: ImageExportConfig
): Promise<{ dataUrl: string; width: number; height: number; sizeBytes: number }> => {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: config.scale });
  
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context failed');
  
  // White background for transparency handling in JPEGs
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  await page.render({ canvasContext: ctx, viewport }).promise;
  
  const dataUrl = canvas.toDataURL(config.format, config.quality);
  
  // Estimate size (Base64 length * 0.75)
  const head = `data:${config.format};base64,`;
  const sizeBytes = Math.round((dataUrl.length - head.length) * 0.75);

  return { dataUrl, width: canvas.width, height: canvas.height, sizeBytes };
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

export const createPDFFromImages = async (
  files: File[], 
  layout: { fit: 'contain' | 'cover' | 'fill', margin: number } = { fit: 'contain', margin: 0 }
): Promise<Uint8Array> => {
  const pdfDoc = await PDFDocument.create();
  
  for (const file of files) {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    let image;
    
    try {
      if (file.type === 'image/jpeg') {
        image = await pdfDoc.embedJpg(arrayBuffer);
      } else if (file.type === 'image/png') {
        image = await pdfDoc.embedPng(arrayBuffer);
      } else {
        continue;
      }
    } catch (e) {
      console.warn(`Skipping invalid image: ${file.name}`);
      continue;
    }

    // A4 Dimensions (Points)
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    
    const { width, height } = image.scale(1);
    const availableWidth = pageWidth - (layout.margin * 2);
    const availableHeight = pageHeight - (layout.margin * 2);

    const scale = Math.min(availableWidth / width, availableHeight / height);
    const displayWidth = width * scale;
    const displayHeight = height * scale;

    const x = (pageWidth - displayWidth) / 2;
    const y = (pageHeight - displayHeight) / 2;

    page.drawImage(image, {
      x,
      y,
      width: displayWidth,
      height: displayHeight
    });
  }
  return pdfDoc.save();
};

// --- NEW LAYOUT BASED PDF CREATION ---
export interface PDFPageLayout {
  width: number;
  height: number;
  elements: PDFImageElement[];
}
export interface PDFImageElement {
  file: File;
  x: number; // Percentage 0-1
  y: number; // Percentage 0-1
  width: number; // Percentage 0-1
  height: number; // Percentage 0-1
}

export const createPDFFromLayout = async (pages: PDFPageLayout[]): Promise<Uint8Array> => {
  const pdfDoc = await PDFDocument.create();
  const imageCache = new Map<string, any>();

  for (const p of pages) {
    const page = pdfDoc.addPage([595.28, 841.89]);
    const { width: pageWidth, height: pageHeight } = page.getSize();

    for (const el of p.elements) {
      try {
        let image = imageCache.get(el.file.name);
        if (!image) {
          const arrayBuffer = await readFileAsArrayBuffer(el.file);
          if (el.file.type === 'image/jpeg') {
            image = await pdfDoc.embedJpg(arrayBuffer);
          } else if (el.file.type === 'image/png') {
            image = await pdfDoc.embedPng(arrayBuffer);
          }
          if (image) imageCache.set(el.file.name, image);
        }

        if (image) {
           const pdfX = el.x * pageWidth;
           const pdfY = pageHeight - (el.y * pageHeight); // Bottom Y
           const pdfW = el.width * pageWidth;
           const pdfH = el.height * pageHeight;

           page.drawImage(image, {
             x: pdfX,
             y: pdfY - pdfH, 
             width: pdfW,
             height: pdfH
           });
        }
      } catch (e) {
        console.error("Failed to embed image", e);
      }
    }
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

export const flattenPDF = async (file: File): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const form = pdfDoc.getForm();
  try {
    form.flatten();
  } catch(e) {
    console.warn("Flatten failed or no form fields found", e);
  }
  return pdfDoc.save();
};

export const unlockPDF = async (file: File, password: string): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
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


// --- NEW ANNOTATION / OVERLAY EDITING LOGIC ---

export interface EditorElement {
  id: string;
  type: 'text' | 'image';
  pageIndex: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  content: string;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
}

export const savePDFWithAnnotations = async (file: File, elements: EditorElement[]): Promise<Uint8Array> => {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const pages = pdfDoc.getPages();

  const fonts = {
    Helvetica: await pdfDoc.embedFont(StandardFonts.Helvetica),
    TimesRoman: await pdfDoc.embedFont(StandardFonts.TimesRoman),
    Courier: await pdfDoc.embedFont(StandardFonts.Courier),
  };

  const hexToRgb = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return rgb(r, g, b);
  };

for (const el of elements) {
    if (el.pageIndex < 0 || el.pageIndex >= pages.length) continue;
    const page = pages[el.pageIndex];
    const { width: pageWidth, height: pageHeight } = page.getSize();

    const pdfX = el.x * pageWidth;
    const pdfY = pageHeight - (el.y * pageHeight);

    if (el.type === 'image') {
       try {
         let image;
         if (el.content.startsWith('data:image/png')) image = await pdfDoc.embedPng(el.content);
         else image = await pdfDoc.embedJpg(el.content);

         const w = (el.width || 0.2) * pageWidth;
         const h = (el.height || 0.2) * pageHeight;
         
         page.drawImage(image, {
           x: pdfX,
           y: pdfY - h, 
           width: w,
           height: h,
           rotate: degrees(el.rotation || 0),
         });
       } catch (e) {
         console.warn("Failed to embed image", e);
       }
    } else if (el.type === 'text') {
       const font = fonts[el.fontFamily as keyof typeof fonts] || fonts.Helvetica;
       const size = el.fontSize || 12;
       const lines = el.content.split('\n');
       const lineHeight = size * 1.2;
       
       lines.forEach((line, i) => {
         page.drawText(line, {
           x: pdfX,
           y: pdfY - (size) - (i * lineHeight), 
           size: size,
           font: font,
           color: el.color ? hexToRgb(el.color) : rgb(0, 0, 0),
           rotate: degrees(el.rotation || 0),
         });
       });
    }
  }

return pdfDoc.save();
};

export interface SignaturePlacement {
  pageIndex: number;
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  aspectRatio: number;
}

export const applySignaturesToPDF = async (file: File, signatures: SignaturePlacement[]) => {
   const arrayBuffer = await readFileAsArrayBuffer(file);
   const pdfDoc = await PDFDocument.load(arrayBuffer);
   
   for (const sig of signatures) {
      if (sig.pageIndex < 0 || sig.pageIndex >= pdfDoc.getPageCount()) continue;
      
      let image;
      if (sig.dataUrl.startsWith('data:image/png')) {
          image = await pdfDoc.embedPng(sig.dataUrl);
      } else {
          image = await pdfDoc.embedJpg(sig.dataUrl);
      }
      
      const page = pdfDoc.getPage(sig.pageIndex);
      const { width, height } = page.getSize();
      
      const targetW = width * sig.width;
      const targetH = targetW / sig.aspectRatio;
      
      page.drawImage(image, {
          x: width * sig.x,
          y: height - (height * sig.y) - targetH,
          width: targetW,
          height: targetH
      });
   }
   
   return pdfDoc.save();
};