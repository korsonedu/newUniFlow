export const saveBlobWithDownload = (filename: string, blob: Blob): void => {
  if (typeof window === 'undefined') {
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
};

