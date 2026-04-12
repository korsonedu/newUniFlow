export type ToolParameterModel = {
  color: string;
  width: number;
  opacity: number;
  highlighterColor: string;
  highlighterWidth: number;
  highlighterOpacity: number;
  eraserRadius: number;
  smoothing: number;
  snap: boolean;
};

export const DEFAULT_TOOL_PARAMETERS: ToolParameterModel = {
  color: '#0f172a',
  width: 1.6,
  opacity: 1,
  highlighterColor: '#f59e0b',
  highlighterWidth: 12,
  highlighterOpacity: 0.34,
  eraserRadius: 14,
  smoothing: 0.6,
  snap: true,
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const normalizeHexColor = (value: string): string => {
  const raw = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
    return raw.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return DEFAULT_TOOL_PARAMETERS.color;
};

export const normalizeToolParameters = (params: Partial<ToolParameterModel>): ToolParameterModel => {
  const next = {
    ...DEFAULT_TOOL_PARAMETERS,
    ...params,
  };
  return {
    color: normalizeHexColor(next.color),
    width: clamp(Number(next.width) || DEFAULT_TOOL_PARAMETERS.width, 0.5, 24),
    opacity: clamp(Number(next.opacity) || DEFAULT_TOOL_PARAMETERS.opacity, 0.05, 1),
    highlighterColor: normalizeHexColor(next.highlighterColor),
    highlighterWidth: clamp(Number(next.highlighterWidth) || DEFAULT_TOOL_PARAMETERS.highlighterWidth, 4, 48),
    highlighterOpacity: clamp(Number(next.highlighterOpacity) || DEFAULT_TOOL_PARAMETERS.highlighterOpacity, 0.05, 1),
    eraserRadius: clamp(Number(next.eraserRadius) || DEFAULT_TOOL_PARAMETERS.eraserRadius, 4, 40),
    smoothing: clamp(Number(next.smoothing) || DEFAULT_TOOL_PARAMETERS.smoothing, 0, 1),
    snap: Boolean(next.snap),
  };
};

export const patchToolParameters = (
  current: ToolParameterModel,
  patch: Partial<ToolParameterModel>,
): ToolParameterModel => {
  return normalizeToolParameters({
    ...current,
    ...patch,
  });
};

export const colorWithOpacity = (hexColor: string, opacity: number): string => {
  const normalized = normalizeHexColor(hexColor);
  const alpha = clamp(opacity, 0, 1);
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
};
