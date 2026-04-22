type RuntimeWindow = Window & typeof globalThis & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

const getRuntimeWindow = (): RuntimeWindow | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return window as RuntimeWindow;
};

export const hasTauriRuntime = (): boolean => {
  const runtimeWindow = getRuntimeWindow();
  if (!runtimeWindow) {
    return false;
  }
  return !!runtimeWindow.__TAURI__ || !!runtimeWindow.__TAURI_INTERNALS__;
};

export const isMacOsPlatform = (): boolean => {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  return platform.includes('mac') || userAgent.includes('mac os');
};

export const isNativeMacDesktop = (): boolean => hasTauriRuntime() && isMacOsPlatform();
