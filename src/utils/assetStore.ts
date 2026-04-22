import { createObjectUrl } from '../infrastructure/platform/domFactory';
import { generateId } from './id';

const DB_NAME = 'uniflow.assets.db';
const DB_VERSION = 1;
const STORE_ASSETS = 'assets';

export type StoredAssetRef = {
  key: string;
  mimeType: string;
  size: number;
};

const openDb = async (): Promise<IDBDatabase> => {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        db.createObjectStore(STORE_ASSETS);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open asset db'));
  });
};

const withStore = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, tx: IDBTransaction) => Promise<T> | T,
): Promise<T> => {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_ASSETS, mode);
    const store = tx.objectStore(STORE_ASSETS);
    const value = await run(store, tx);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    return value;
  } finally {
    db.close();
  }
};

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
};

export const saveAssetBlob = async (blob: Blob, key?: string): Promise<StoredAssetRef> => {
  const assetKey = key ?? generateId('asset');
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.put(blob, assetKey));
  });
  return {
    key: assetKey,
    mimeType: blob.type || 'application/octet-stream',
    size: blob.size,
  };
};

export const loadAssetBlob = async (key: string): Promise<Blob | null> => {
  return withStore('readonly', async (store) => {
    const result = await requestToPromise(store.get(key));
    if (!result) {
      return null;
    }
    return result instanceof Blob ? result : null;
  });
};

export const deleteAssetBlob = async (key: string): Promise<void> => {
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.delete(key));
  });
};

export const loadAssetObjectUrl = async (key: string): Promise<string | null> => {
  const blob = await loadAssetBlob(key);
  if (!blob) {
    return null;
  }
  return createObjectUrl(blob);
};

const blobToDataUrl = async (blob: Blob): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob as data url'));
    reader.readAsDataURL(blob);
  });
};

export const exportAssetAsDataUrl = async (key: string): Promise<string | null> => {
  const blob = await loadAssetBlob(key);
  if (!blob) {
    return null;
  }
  return blobToDataUrl(blob);
};

const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => {
  const response = await fetch(dataUrl);
  return response.blob();
};

export const importDataUrlAsAsset = async (
  dataUrl: string,
  preferredKey?: string,
): Promise<StoredAssetRef> => {
  const blob = await dataUrlToBlob(dataUrl);
  return saveAssetBlob(blob, preferredKey);
};
