export type WindowEventDisposer = () => void;

type BrowserWindow = Window & typeof globalThis;

const getBrowserWindow = (): BrowserWindow | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return window;
};

export const subscribeWindowEvent = <K extends keyof WindowEventMap>(
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): WindowEventDisposer => {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return () => undefined;
  }
  const wrapped = listener as EventListener;
  browserWindow.addEventListener(type, wrapped, options);
  return () => {
    browserWindow.removeEventListener(type, wrapped, options);
  };
};

export const subscribeWindowEscape = (
  listener: (event: KeyboardEvent) => void,
): WindowEventDisposer => subscribeWindowEvent('keydown', (event) => {
  if (event.key === 'Escape') {
    listener(event);
  }
});

export const subscribeWindowPointerDown = (
  listener: (event: PointerEvent) => void,
): WindowEventDisposer => subscribeWindowEvent('pointerdown', listener);

export const subscribeWindowKeyDown = (
  listener: (event: KeyboardEvent) => void,
): WindowEventDisposer => subscribeWindowEvent('keydown', listener);

export const subscribeWindowResize = (
  listener: (event: UIEvent) => void,
): WindowEventDisposer => subscribeWindowEvent('resize', listener);

export const subscribeWindowBlur = (
  listener: (event: FocusEvent) => void,
): WindowEventDisposer => subscribeWindowEvent('blur', listener);

export const combineWindowEventDisposers = (
  ...disposers: WindowEventDisposer[]
): WindowEventDisposer => () => {
  for (const dispose of disposers) {
    dispose();
  }
};
