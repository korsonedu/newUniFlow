const getDocument = (): Document | null => {
  if (typeof document === 'undefined') {
    return null;
  }
  return document;
};

export const createCanvasElement = (): HTMLCanvasElement | null => {
  const doc = getDocument();
  if (!doc) {
    return null;
  }
  return doc.createElement('canvas');
};

export const createAudioElement = (): HTMLAudioElement | null => {
  const doc = getDocument();
  if (!doc) {
    return null;
  }
  return doc.createElement('audio');
};

export const createAnchorElement = (): HTMLAnchorElement | null => {
  const doc = getDocument();
  if (!doc) {
    return null;
  }
  return doc.createElement('a');
};

export const createFileInputElement = (): HTMLInputElement | null => {
  const doc = getDocument();
  if (!doc) {
    return null;
  }
  return doc.createElement('input');
};

export const createImageElement = (): HTMLImageElement | null => {
  if (typeof Image !== 'undefined') {
    return new Image();
  }
  const doc = getDocument();
  if (!doc) {
    return null;
  }
  return doc.createElement('img');
};

export const appendElementToBody = (element: HTMLElement): boolean => {
  const doc = getDocument();
  if (!doc?.body) {
    return false;
  }
  doc.body.appendChild(element);
  return true;
};

export const createObjectUrl = (blob: Blob): string | null => {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  return URL.createObjectURL(blob);
};

export const revokeObjectUrl = (url: string): void => {
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
    return;
  }
  URL.revokeObjectURL(url);
};
