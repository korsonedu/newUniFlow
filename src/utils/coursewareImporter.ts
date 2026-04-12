import JSZip from 'jszip';
import {
  ProjectAssetType,
  ProjectPage,
} from '../domain/types';
import { saveAssetBlob, StoredAssetRef } from './assetStore';
import { generateId } from './id';

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjsModulePromise: Promise<PdfJsModule> | null = null;
let pdfWorkerConfigured = false;

const getPdfJs = async (): Promise<PdfJsModule> => {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  const mod = await pdfjsModulePromise;
  if (!pdfWorkerConfigured) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - Vite url import is resolved at build time.
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default as string;
    mod.GlobalWorkerOptions.workerSrc = workerUrl;
    pdfWorkerConfigured = true;
  }
  return mod;
};

const clampDimension = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(64, Math.round(value));
};

const canvasToBlob = async (
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number,
): Promise<Blob> => {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Canvas encode failed'));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
};

const emuToPx = (emu: number): number => {
  // Office EMU -> px at 96 DPI.
  return (emu / 914400) * 96;
};

const normalizeZipPath = (basePath: string, target: string): string => {
  const baseParts = basePath.split('/').slice(0, -1);
  const targetParts = target.replace(/\\/g, '/').split('/');
  const out = [...baseParts];
  for (const part of targetParts) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
};

const readZipText = async (zip: JSZip, path: string): Promise<string | null> => {
  const file = zip.file(path);
  if (!file) {
    return null;
  }
  return file.async('text');
};

const readZipBlob = async (zip: JSZip, path: string): Promise<Blob | null> => {
  const file = zip.file(path);
  if (!file) {
    return null;
  }
  const content = await file.async('uint8array');
  const copied = new Uint8Array(content.byteLength);
  copied.set(content);
  const lower = path.toLowerCase();
  let mimeType = 'application/octet-stream';
  if (lower.endsWith('.png')) {
    mimeType = 'image/png';
  } else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    mimeType = 'image/jpeg';
  } else if (lower.endsWith('.webp')) {
    mimeType = 'image/webp';
  }
  return new Blob([copied], { type: mimeType });
};

const parseXml = (xml: string): Document => {
  return new DOMParser().parseFromString(xml, 'application/xml');
};

const createPlaceholderSlideBlob = async (
  width: number,
  height: number,
  title: string,
): Promise<Blob> => {
  const w = clampDimension(width, 1366);
  const h = clampDimension(height, 768);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new Blob([], { type: 'image/png' });
  }
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) * 0.003));
  ctx.strokeRect(0, 0, w, h);
  ctx.fillStyle = '#0f172a';
  ctx.font = `${Math.max(20, Math.round(Math.min(w, h) * 0.04))}px "SF Pro Display", "PingFang SC", sans-serif`;
  ctx.fillText(title, Math.max(20, w * 0.06), Math.max(60, h * 0.12));
  ctx.fillStyle = '#64748b';
  ctx.font = `${Math.max(12, Math.round(Math.min(w, h) * 0.022))}px "SF Pro Text", "PingFang SC", sans-serif`;
  ctx.fillText('Slide background preview unavailable. Content imported as paged structure.', Math.max(20, w * 0.06), Math.max(92, h * 0.18));
  return canvasToBlob(canvas, 'image/png');
};

type ImportedPageDraft = {
  pageId: string;
  pageName: string;
  assetType: ProjectAssetType;
  order: number;
  width: number;
  height: number;
  sourcePageIndex: number;
  backgroundAssetKey: string;
};

export type CoursewareImportResult = {
  sourceName: string;
  sourceType: ProjectAssetType;
  pages: ImportedPageDraft[];
  warnings: string[];
};

const tryConvertOfficeViaTauri = async (file: File): Promise<Blob | null> => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const tauriCore = await import('@tauri-apps/api/core');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const converted = await tauriCore.invoke<number[]>('convert_office_to_pdf', {
      bytes: Array.from(bytes),
      fileName: file.name,
    });
    const uint8 = new Uint8Array(converted);
    if (uint8.byteLength <= 0) {
      return null;
    }
    return new Blob([uint8], { type: 'application/pdf' });
  } catch {
    return null;
  }
};

const buildPageDraft = async (options: {
  sourceType: ProjectAssetType;
  order: number;
  sourcePageIndex: number;
  width: number;
  height: number;
  blob: Blob;
}): Promise<ImportedPageDraft> => {
  const stored: StoredAssetRef = await saveAssetBlob(options.blob);
  return {
    pageId: generateId('page'),
    pageName: `Page ${options.order + 1}`,
    assetType: options.sourceType,
    order: options.order,
    width: clampDimension(options.width, 1366),
    height: clampDimension(options.height, 768),
    sourcePageIndex: options.sourcePageIndex,
    backgroundAssetKey: stored.key,
  };
};

const readImageDimension = async (file: File): Promise<{ width: number; height: number }> => {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = url;
    });
    return {
      width: clampDimension(image.naturalWidth, 1366),
      height: clampDimension(image.naturalHeight, 768),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
};

const importPdfFromBlob = async (
  blob: Blob,
  sourceName: string,
  sourceType: ProjectAssetType = 'pdf',
): Promise<CoursewareImportResult> => {
  const pdfjs = await getPdfJs();
  const arrayBuffer = await blob.arrayBuffer();
  const loadingTask = pdfjs.getDocument({
    data: arrayBuffer,
    cMapPacked: true,
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;
  const pages: ImportedPageDraft[] = [];
  const warnings: string[] = [];

  for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const width = clampDimension(viewport.width, 1366);
    const height = clampDimension(viewport.height, 768);
    const oversampleScale = Math.max(
      2,
      Math.min(4, Math.round((typeof window !== 'undefined' ? window.devicePixelRatio : 2) * 2) / 2),
    );
    const renderWidth = Math.max(width, Math.round(width * oversampleScale));
    const renderHeight = Math.max(height, Math.round(height * oversampleScale));
    const canvas = document.createElement('canvas');
    canvas.width = renderWidth;
    canvas.height = renderHeight;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      warnings.push(`PDF page ${pageIndex + 1} render context unavailable.`);
      continue;
    }

    await page.render({
      canvas,
      canvasContext: context,
      viewport: page.getViewport({
        scale: (renderWidth / Math.max(1, viewport.width)),
      }),
    }).promise;

    const blob = await canvasToBlob(canvas, 'image/png');
    pages.push(await buildPageDraft({
      sourceType,
      order: pageIndex,
      sourcePageIndex: pageIndex + 1,
      width,
      height,
      blob,
    }));
  }

  return {
    sourceName,
    sourceType,
    pages,
    warnings,
  };
};

const importPdf = async (file: File): Promise<CoursewareImportResult> => {
  return importPdfFromBlob(file, file.name, 'pdf');
};

const parseRelationships = (relsXml: string): Map<string, string> => {
  const doc = parseXml(relsXml);
  const map = new Map<string, string>();
  const rels = Array.from(doc.getElementsByTagName('Relationship'));
  for (const rel of rels) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (!id || !target) {
      continue;
    }
    map.set(id, target);
  }
  return map;
};

const importPptx = async (file: File): Promise<CoursewareImportResult> => {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const presentationXml = await readZipText(zip, 'ppt/presentation.xml');
  const relsXml = await readZipText(zip, 'ppt/_rels/presentation.xml.rels');
  if (!presentationXml || !relsXml) {
    throw new Error('Invalid PPTX package');
  }

  const presentationDoc = parseXml(presentationXml);
  const relMap = parseRelationships(relsXml);

  const slideSizeNode = presentationDoc.querySelector('p\\:sldSz, sldSz');
  const cx = Number(slideSizeNode?.getAttribute('cx') ?? 0);
  const cy = Number(slideSizeNode?.getAttribute('cy') ?? 0);
  const defaultWidth = clampDimension(emuToPx(cx), 1366);
  const defaultHeight = clampDimension(emuToPx(cy), 768);

  const slideIdNodes = Array.from(presentationDoc.querySelectorAll('p\\:sldId, sldId'));
  const slidePaths = slideIdNodes
    .map((node) => node.getAttribute('r:id'))
    .filter((value): value is string => !!value)
    .map((rId) => relMap.get(rId))
    .filter((value): value is string => !!value)
    .map((target) => normalizeZipPath('ppt/presentation.xml', target));

  const pages: ImportedPageDraft[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < slidePaths.length; i += 1) {
    const slidePath = slidePaths[i];
    const slideXml = await readZipText(zip, slidePath);
    let imageBlob: Blob | null = null;
    if (slideXml) {
      const slideDoc = parseXml(slideXml);
      const slideRelsPath = `${slidePath.substring(0, slidePath.lastIndexOf('/') + 1)}_rels/${slidePath.split('/').pop()}.rels`;
      const slideRelsXml = await readZipText(zip, slideRelsPath);
      const slideRelMap = slideRelsXml ? parseRelationships(slideRelsXml) : new Map<string, string>();
      const blips = Array.from(slideDoc.querySelectorAll('a\\:blip, blip'));
      for (const blip of blips) {
        const embedId = blip.getAttribute('r:embed');
        if (!embedId) {
          continue;
        }
        const target = slideRelMap.get(embedId);
        if (!target) {
          continue;
        }
        const mediaPath = normalizeZipPath(slidePath, target);
        const blob = await readZipBlob(zip, mediaPath);
        if (blob) {
          imageBlob = blob;
          break;
        }
      }
    }

    if (!imageBlob) {
      warnings.push(`Slide ${i + 1} has no raster preview. Imported as structured placeholder page.`);
      imageBlob = await createPlaceholderSlideBlob(defaultWidth, defaultHeight, `Slide ${i + 1}`);
    }

    pages.push(await buildPageDraft({
      sourceType: 'pptx',
      order: i,
      sourcePageIndex: i + 1,
      width: defaultWidth,
      height: defaultHeight,
      blob: imageBlob,
    }));
  }

  return {
    sourceName: file.name,
    sourceType: 'pptx',
    pages,
    warnings,
  };
};

const importLegacyPpt = async (file: File): Promise<CoursewareImportResult> => {
  const placeholder = await createPlaceholderSlideBlob(1366, 768, 'PPT (Legacy)');
  const page = await buildPageDraft({
    sourceType: 'ppt',
    order: 0,
    sourcePageIndex: 1,
    width: 1366,
    height: 768,
    blob: placeholder,
  });
  return {
    sourceName: file.name,
    sourceType: 'ppt',
    pages: [page],
    warnings: [
      'Legacy .ppt currently imports as paged placeholder in web runtime. Use .pptx for full page extraction.',
    ],
  };
};

const importImageFile = async (file: File): Promise<CoursewareImportResult> => {
  const { width, height } = await readImageDimension(file);
  const page = await buildPageDraft({
    sourceType: 'image',
    order: 0,
    sourcePageIndex: 1,
    width,
    height,
    blob: file,
  });
  return {
    sourceName: file.name,
    sourceType: 'image',
    pages: [page],
    warnings: [],
  };
};

export const importCoursewareFile = async (file: File): Promise<CoursewareImportResult> => {
  const lower = file.name.toLowerCase();
  if (
    lower.endsWith('.png')
    || lower.endsWith('.jpg')
    || lower.endsWith('.jpeg')
    || lower.endsWith('.webp')
    || file.type.startsWith('image/')
  ) {
    return importImageFile(file);
  }
  if (lower.endsWith('.pdf')) {
    return importPdf(file);
  }
  if (lower.endsWith('.pptx')) {
    const convertedPdf = await tryConvertOfficeViaTauri(file);
    if (convertedPdf) {
      const result = await importPdfFromBlob(convertedPdf, file.name, 'pptx');
      return {
        ...result,
        warnings: [...result.warnings, 'PPTX imported via native Office->PDF converter.'],
      };
    }
    return importPptx(file);
  }
  if (lower.endsWith('.ppt')) {
    const convertedPdf = await tryConvertOfficeViaTauri(file);
    if (convertedPdf) {
      const result = await importPdfFromBlob(convertedPdf, file.name, 'ppt');
      return {
        ...result,
        warnings: [...result.warnings, 'PPT imported via native Office->PDF converter.'],
      };
    }
    return importLegacyPpt(file);
  }
  throw new Error('Unsupported file type. Please choose PDF / PPT / PPTX / image.');
};

export const toProjectPagesFromImport = (
  imported: CoursewareImportResult,
  startOrder = 0,
): ProjectPage[] => {
  return imported.pages.map((page, index) => ({
    id: page.pageId,
    name: `Page ${startOrder + index + 1}`,
    assetType: page.assetType,
    order: startOrder + index,
    backgroundAssetKey: page.backgroundAssetKey,
    width: page.width,
    height: page.height,
    sourceName: imported.sourceName,
    sourcePageIndex: page.sourcePageIndex,
  }));
};
