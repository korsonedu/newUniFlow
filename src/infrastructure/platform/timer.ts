export type PlatformTimerHandle = ReturnType<typeof setTimeout>;

export const platformSetTimeout = (
  callback: () => void,
  delayMs: number,
): PlatformTimerHandle => setTimeout(callback, delayMs);

export const platformClearTimeout = (
  handle: PlatformTimerHandle | null | undefined,
): void => {
  if (handle === null || handle === undefined) {
    return;
  }
  clearTimeout(handle);
};
