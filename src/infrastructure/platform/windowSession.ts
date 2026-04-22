export type WindowViewportSize = {
  width: number;
  height: number;
};

const getBrowserWindow = (): Window | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return window;
};

export const getWindowViewportSize = (
  fallback?: Partial<WindowViewportSize>,
): WindowViewportSize => {
  const browserWindow = getBrowserWindow();
  return {
    width: browserWindow?.innerWidth ?? fallback?.width ?? 0,
    height: browserWindow?.innerHeight ?? fallback?.height ?? 0,
  };
};

export const getDevicePixelRatio = (fallback = 1): number => {
  const browserWindow = getBrowserWindow();
  return browserWindow?.devicePixelRatio ?? fallback;
};
