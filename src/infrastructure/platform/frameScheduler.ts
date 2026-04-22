import { platformClearTimeout, platformSetTimeout } from './timer';

let fallbackFrameId = 1;
const fallbackTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const platformNowMs = (): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

export const requestPlatformFrame = (callback: FrameRequestCallback): number => {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }

  const id = fallbackFrameId;
  fallbackFrameId += 1;
  const timer = platformSetTimeout(() => {
    fallbackTimers.delete(id);
    callback(platformNowMs());
  }, 16);
  fallbackTimers.set(id, timer);
  return id;
};

export const cancelPlatformFrame = (id: number): void => {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(id);
    return;
  }

  const timer = fallbackTimers.get(id);
  if (!timer) {
    return;
  }
  platformClearTimeout(timer);
  fallbackTimers.delete(id);
};
