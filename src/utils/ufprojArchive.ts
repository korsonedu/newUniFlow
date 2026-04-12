import JSZip from 'jszip';
import { ProjectPage } from '../domain/types';
import { parseSnapshotJson, snapshotToJson } from '../store/snapshot';
import { importDataUrlAsAsset, loadAssetBlob, saveAssetBlob } from './assetStore';

export type UfprojProjectMeta = {
  id?: string;
  name?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
};

type UfprojPageAsset = {
  path: string;
  mimeType: string;
};

type UfprojManifest = {
  format: 'ufproj';
  version: number;
  project?: UfprojProjectMeta;
  snapshot?: unknown;
  snapshotJson?: string;
  projectPages?: unknown;
  pageAssets?: Record<string, UfprojPageAsset>;
};

type LegacyUfprojPayload = {
  format?: string;
  version?: number;
  project?: UfprojProjectMeta;
  snapshot?: unknown;
  snapshotJson?: string;
  projectPages?: unknown;
};

export type DecodedUfproj = {
  project?: UfprojProjectMeta;
  snapshotJson: string;
  projectPages: ProjectPage[];
};

export type EncodeUfprojOptions = {
  project?: UfprojProjectMeta;
  snapshotJson: string;
  projectPages: ProjectPage[];
  onProgress?: (progress: number, message: string) => void;
  signal?: AbortSignal;
};

const ZIP_MAGIC_0 = 0x50;
const ZIP_MAGIC_1 = 0x4b;

const isZipFile = (bytes: Uint8Array): boolean => {
  return bytes.length >= 2 && bytes[0] === ZIP_MAGIC_0 && bytes[1] === ZIP_MAGIC_1;
};

const decodeText = (bytes: Uint8Array): string => {
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(bytes);
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object';
};

const normalizeProjectPages = (value: unknown): ProjectPage[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const pages = value
    .filter((item): item is ProjectPage => {
      if (!isObject(item)) {
        return false;
      }
      return (
        typeof item.id === 'string'
        && typeof item.name === 'string'
        && typeof item.assetType === 'string'
        && typeof item.order === 'number'
      );
    })
    .map((page) => ({
      ...page,
      width: typeof page.width === 'number' ? page.width : undefined,
      height: typeof page.height === 'number' ? page.height : undefined,
      sourceName: typeof page.sourceName === 'string' ? page.sourceName : undefined,
      sourcePageIndex: typeof page.sourcePageIndex === 'number' ? page.sourcePageIndex : undefined,
      backgroundUrl: typeof page.backgroundUrl === 'string' ? page.backgroundUrl : undefined,
      backgroundAssetKey: typeof page.backgroundAssetKey === 'string' ? page.backgroundAssetKey : undefined,
      thumbnailUrl: typeof page.thumbnailUrl === 'string' ? page.thumbnailUrl : undefined,
    }))
    .sort((a, b) => a.order - b.order)
    .map((page, index) => ({
      ...page,
      name: `Page ${index + 1}`,
      order: index,
    }));

  return pages;
};

const toExtensionFromMimeType = (mimeType: string): string => {
  const safe = mimeType.toLowerCase();
  if (safe.includes('png')) {
    return 'png';
  }
  if (safe.includes('jpeg') || safe.includes('jpg')) {
    return 'jpg';
  }
  if (safe.includes('webp')) {
    return 'webp';
  }
  return 'bin';
};

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};

const resolveBackgroundBlob = async (page: ProjectPage): Promise<Blob | null> => {
  if (page.backgroundAssetKey) {
    return loadAssetBlob(page.backgroundAssetKey);
  }
  if (!page.backgroundUrl) {
    return null;
  }
  try {
    const response = await fetch(page.backgroundUrl);
    if (!response.ok) {
      return null;
    }
    return response.blob();
  } catch {
    return null;
  }
};

const hydratePagesWithAssets = async (
  pages: ProjectPage[],
  zip: JSZip,
  pageAssets: Record<string, UfprojPageAsset> | undefined,
): Promise<ProjectPage[]> => {
  const hydrated: ProjectPage[] = [];
  for (const page of pages) {
    const asset = pageAssets?.[page.id];
    if (asset?.path) {
      const entry = zip.file(asset.path);
      if (entry) {
        try {
          const blob = await entry.async('blob');
          const stored = await saveAssetBlob(blob, page.backgroundAssetKey);
          hydrated.push({
            ...page,
            backgroundAssetKey: stored.key,
            backgroundUrl: undefined,
          });
          continue;
        } catch {
          // fallback to URL/data-url below
        }
      }
    }

    if (page.backgroundUrl?.startsWith('data:')) {
      try {
        const stored = await importDataUrlAsAsset(page.backgroundUrl, page.backgroundAssetKey);
        hydrated.push({
          ...page,
          backgroundAssetKey: stored.key,
        });
        continue;
      } catch {
        // keep inline fallback
      }
    }

    hydrated.push(page);
  }
  return hydrated;
};

const decodeFromManifest = async (
  manifest: UfprojManifest | LegacyUfprojPayload,
  zip?: JSZip,
): Promise<DecodedUfproj | null> => {
  if (!isObject(manifest)) {
    return null;
  }
  const format = typeof manifest.format === 'string' ? manifest.format : undefined;
  if (format && format !== 'ufproj') {
    return null;
  }

  const snapshotJson = typeof manifest.snapshotJson === 'string'
    ? manifest.snapshotJson
    : JSON.stringify(manifest.snapshot ?? {});
  const snapshot = parseSnapshotJson(snapshotJson);
  if (!snapshot) {
    return null;
  }

  const parsedPages = normalizeProjectPages(manifest.projectPages);
  const pages = zip
    ? await hydratePagesWithAssets(parsedPages, zip, (manifest as UfprojManifest).pageAssets)
    : await hydratePagesWithAssets(parsedPages, new JSZip(), undefined);

  return {
    project: manifest.project,
    snapshotJson: snapshotToJson(snapshot),
    projectPages: pages,
  };
};

const tryDecodeZipUfproj = async (bytes: Uint8Array): Promise<DecodedUfproj | null> => {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const manifestEntry = zip.file('manifest.json') ?? zip.file('project.json');
    if (!manifestEntry) {
      return null;
    }
    const manifestText = await manifestEntry.async('string');
    const manifest = JSON.parse(manifestText) as UfprojManifest;
    return decodeFromManifest(manifest, zip);
  } catch {
    return null;
  }
};

const tryDecodeLegacyUfproj = async (bytes: Uint8Array): Promise<DecodedUfproj | null> => {
  const rawText = decodeText(bytes);

  // Legacy support: a raw snapshot json file can be imported as a project.
  const rawSnapshot = parseSnapshotJson(rawText);
  if (rawSnapshot) {
    return {
      project: undefined,
      snapshotJson: snapshotToJson(rawSnapshot),
      projectPages: [],
    };
  }

  try {
    const legacy = JSON.parse(rawText) as LegacyUfprojPayload;
    return decodeFromManifest(legacy);
  } catch {
    return null;
  }
};

export const decodeUfprojFile = async (file: File): Promise<DecodedUfproj | null> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isZipFile(bytes)) {
    const decoded = await tryDecodeZipUfproj(bytes);
    if (decoded) {
      return decoded;
    }
  }
  return tryDecodeLegacyUfproj(bytes);
};

export const encodeUfprojBlob = async (options: EncodeUfprojOptions): Promise<Blob> => {
  const report = (progress: number, message: string) => {
    options.onProgress?.(Math.max(0, Math.min(1, progress)), message);
  };
  const ensureNotAborted = () => {
    if (options.signal?.aborted) {
      throw new DOMException('Export canceled', 'AbortError');
    }
  };
  ensureNotAborted();
  report(0.05, 'Preparing project package');

  const snapshot = parseSnapshotJson(options.snapshotJson);
  if (!snapshot) {
    throw new Error('导出失败：工程快照无效');
  }

  const normalizedPages = normalizeProjectPages(options.projectPages);
  const zip = new JSZip();
  const pageAssets: Record<string, UfprojPageAsset> = {};
  const pagesToSave: ProjectPage[] = [];
  const dedupedAssets = new Map<string, UfprojPageAsset>();

  for (let i = 0; i < normalizedPages.length; i += 1) {
    ensureNotAborted();
    const page = normalizedPages[i];
    const sourceKey = page.backgroundAssetKey
      ? `asset:${page.backgroundAssetKey}`
      : (page.backgroundUrl ? `url:${hashString(page.backgroundUrl)}` : undefined);

    if (sourceKey) {
      const reused = dedupedAssets.get(sourceKey);
      if (reused) {
        pageAssets[page.id] = reused;
        pagesToSave.push({
          ...page,
          backgroundAssetKey: undefined,
          backgroundUrl: undefined,
        });
        continue;
      }
    }

    const blob = await resolveBackgroundBlob(page);
    if (blob && blob.size > 0) {
      const mimeType = blob.type || 'application/octet-stream';
      const ext = toExtensionFromMimeType(mimeType);
      const path = `assets/${page.id}.${ext}`;
      zip.file(path, blob);
      const saved: UfprojPageAsset = { path, mimeType };
      pageAssets[page.id] = saved;
      if (sourceKey) {
        dedupedAssets.set(sourceKey, saved);
      }
      pagesToSave.push({
        ...page,
        backgroundAssetKey: undefined,
        backgroundUrl: undefined,
      });
      continue;
    }

    pagesToSave.push({
      ...page,
      backgroundAssetKey: undefined,
    });
    if (normalizedPages.length > 0) {
      report(0.15 + ((i + 1) / normalizedPages.length) * 0.7, `Packing pages ${i + 1}/${normalizedPages.length}`);
    }
  }

  const manifest: UfprojManifest = {
    format: 'ufproj',
    version: 3,
    project: options.project,
    snapshot,
    projectPages: pagesToSave,
    pageAssets,
  };

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  report(0.9, 'Compressing project package');
  ensureNotAborted();
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  ensureNotAborted();
  report(1, 'Project package ready');
  return blob;
};
