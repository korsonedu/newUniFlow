const getStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const readBrowserStorageItem = (key: string): string | null => {
  const storage = getStorage();
  if (!storage) {
    return null;
  }
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

export const writeBrowserStorageItem = (key: string, value: string): boolean => {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

export const removeBrowserStorageItem = (key: string): boolean => {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
};
