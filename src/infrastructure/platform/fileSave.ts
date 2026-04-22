import {
  createAnchorElement,
  createObjectUrl,
  revokeObjectUrl,
} from './domFactory';
import { platformSetTimeout } from './timer';

export const saveBlobWithDownload = (filename: string, blob: Blob): void => {
  const url = createObjectUrl(blob);
  const link = createAnchorElement();
  if (!url || !link) {
    return;
  }
  link.href = url;
  link.download = filename;
  link.click();
  platformSetTimeout(() => revokeObjectUrl(url), 1200);
};
