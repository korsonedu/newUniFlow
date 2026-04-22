export type AppLifecycleEvent =
  | 'foreground'
  | 'background'
  | 'focus'
  | 'blur'
  | 'pagehide'
  | 'beforeunload';

export type AppLifecycleDisposer = () => void;

const getBrowserWindow = (): Window | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return window;
};

const getBrowserDocument = (): Document | null => {
  if (typeof document === 'undefined') {
    return null;
  }
  return document;
};

export const subscribeAppLifecycle = (
  listener: (event: AppLifecycleEvent) => void,
): AppLifecycleDisposer => {
  const browserWindow = getBrowserWindow();
  const browserDocument = getBrowserDocument();
  if (!browserWindow || !browserDocument) {
    return () => undefined;
  }

  const onVisibilityChange = () => {
    listener(browserDocument.hidden ? 'background' : 'foreground');
  };
  const onFocus = () => {
    listener('focus');
  };
  const onBlur = () => {
    listener('blur');
  };
  const onPageHide = () => {
    listener('pagehide');
  };
  const onBeforeUnload = () => {
    listener('beforeunload');
  };

  browserDocument.addEventListener('visibilitychange', onVisibilityChange);
  browserWindow.addEventListener('focus', onFocus);
  browserWindow.addEventListener('blur', onBlur);
  browserWindow.addEventListener('pagehide', onPageHide);
  browserWindow.addEventListener('beforeunload', onBeforeUnload);

  return () => {
    browserDocument.removeEventListener('visibilitychange', onVisibilityChange);
    browserWindow.removeEventListener('focus', onFocus);
    browserWindow.removeEventListener('blur', onBlur);
    browserWindow.removeEventListener('pagehide', onPageHide);
    browserWindow.removeEventListener('beforeunload', onBeforeUnload);
  };
};
