export type OpenFileDialogOptions = {
  accept?: string;
  multiple?: boolean;
};

type TauriInvoke = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

type PickerHandle = {
  getFile: () => Promise<File>;
};

type PickerType = {
  description?: string;
  accept: Record<string, string[]>;
};

type PickerWindow = Window & typeof globalThis & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: PickerType[];
  }) => Promise<PickerHandle[]>;
};

type TauriPickedFilePayload = {
  name: string;
  bytes: number[];
};

const parseAcceptTokens = (accept: string): string[] => {
  return accept
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
};

const buildPickerTypesFromAccept = (accept?: string): PickerType[] => {
  if (!accept || accept.trim().length === 0) {
    return [];
  }
  const tokens = parseAcceptTokens(accept);
  const extensions = tokens.filter((token) => token.startsWith('.'));
  if (extensions.length === 0) {
    return [];
  }
  return [{
    description: 'Allowed files',
    accept: {
      'application/octet-stream': extensions,
    },
  }];
};

const matchesAcceptToken = (file: File, token: string): boolean => {
  if (token.startsWith('.')) {
    return file.name.toLowerCase().endsWith(token);
  }
  if (token.endsWith('/*')) {
    const prefix = token.slice(0, -1);
    return file.type.toLowerCase().startsWith(prefix);
  }
  return file.type.toLowerCase() === token;
};

const filterFilesByAccept = (files: File[], accept?: string): File[] => {
  if (!accept || accept.trim().length === 0) {
    return files;
  }
  const tokens = parseAcceptTokens(accept);
  if (tokens.length === 0) {
    return files;
  }
  return files.filter((file) => tokens.some((token) => matchesAcceptToken(file, token)));
};

const getExtensionTokens = (accept?: string): string[] => {
  if (!accept || accept.trim().length === 0) {
    return [];
  }
  const tokens = parseAcceptTokens(accept);
  const seen = new Set<string>();
  const extensions: string[] = [];
  for (const token of tokens) {
    if (!token.startsWith('.')) {
      continue;
    }
    const normalized = token.slice(1).trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    extensions.push(normalized);
  }
  return extensions;
};

const openFileDialogInTauri = async (
  options: OpenFileDialogOptions,
): Promise<File[] | null> => {
  if (typeof window === 'undefined') {
    return null;
  }
  const tauriWindow = window as PickerWindow;
  if (!tauriWindow.__TAURI_INTERNALS__ && !tauriWindow.__TAURI__) {
    return null;
  }
  const extensions = getExtensionTokens(options.accept);
  if (extensions.length === 0) {
    return null;
  }
  try {
    const tauriCore = await import('@tauri-apps/api/core');
    const invoke = tauriCore.invoke as TauriInvoke;
    const picked = await invoke<TauriPickedFilePayload[]>('pick_files_by_extensions', {
      extensions,
      multiple: !!options.multiple,
    });
    if (!Array.isArray(picked) || picked.length === 0) {
      return [];
    }
    return picked
      .filter((item) => item && typeof item.name === 'string' && Array.isArray(item.bytes))
      .map((item) => new File([new Uint8Array(item.bytes)], item.name));
  } catch {
    return null;
  }
};

export const openFileDialog = async (
  options: OpenFileDialogOptions = {},
): Promise<File[]> => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return [];
  }
  const tauriFiles = await openFileDialogInTauri(options);
  if (tauriFiles) {
    return filterFilesByAccept(tauriFiles, options.accept);
  }
  const pickerWindow = window as PickerWindow;
  const pickerTypes = buildPickerTypesFromAccept(options.accept);
  if (typeof pickerWindow.showOpenFilePicker === 'function' && pickerTypes.length > 0) {
    try {
      const handles = await pickerWindow.showOpenFilePicker({
        multiple: !!options.multiple,
        excludeAcceptAllOption: true,
        types: pickerTypes,
      });
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      return filterFilesByAccept(files, options.accept);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return [];
      }
      // fallback to input dialog below
    }
  }
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = options.accept ?? '';
    input.multiple = !!options.multiple;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    document.body.appendChild(input);

    const cleanup = () => {
      input.remove();
    };

    input.addEventListener('change', () => {
      const files = input.files ? Array.from(input.files) : [];
      const acceptedFiles = filterFilesByAccept(files, options.accept);
      cleanup();
      resolve(acceptedFiles);
    }, { once: true });

    input.click();
  });
};
