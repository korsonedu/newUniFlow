import {
  AudioSegment,
  createInitialProjectState,
  ProjectPage,
  TimelineEvent,
  WhiteboardObject,
} from '../domain/types';
import {
  applyEvent,
  getEventEndTime,
  sortEvents,
} from '../engine/timelineEngine';
import {
  getStrokePointPressuresAtTime,
  getStrokePointsAtTime,
  getVisibleObjects,
  getVisibleStrokes,
} from '../domain/selectors';
import {
  createCanvasElement,
  createImageElement,
  revokeObjectUrl,
} from '../infrastructure/platform/domFactory';
import { loadAssetObjectUrl } from './assetStore';
import { createAudioContext } from '../infrastructure/platform/audioContext';
import { requestPlatformFrame } from '../infrastructure/platform/frameScheduler';
import { buildPerfectStrokePath } from '../application/drawing/perfectStroke';

type ExportVideoOptions = {
  projectId: string;
  fileBaseName: string;
  pages: ProjectPage[];
  events: TimelineEvent[];
  audioSegments: AudioSegment[];
  fps?: number;
  onProgress?: (progress: number, message: string) => void;
  signal?: AbortSignal;
};

export type ExportProjectMp4Result = {
  blob: Blob;
  mimeType: string;
  ext: 'mp4' | 'webm';
};

const chooseRecorderMimeType = (): string | null => {
  const candidates = [
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const mimeType of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return null;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const loadImage = async (src: string): Promise<HTMLImageElement> => {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = createImageElement();
    if (!img) {
      reject(new Error('Image element unavailable'));
      return;
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
};

const drawRectObject = (
  ctx: CanvasRenderingContext2D,
  object: WhiteboardObject,
  transform: {
    xScale: number;
    yScale: number;
    viewportX: number;
    viewportY: number;
  },
) => {
  if (object.type !== 'rect') {
    return;
  }
  const x = (object.x - transform.viewportX) * transform.xScale;
  const y = (object.y - transform.viewportY) * transform.yScale;
  const w = object.width * transform.xScale;
  const h = object.height * transform.yScale;

  const fill = (object.style?.fill as string) ?? 'rgba(14, 165, 233, 0.15)';
  const stroke = (object.style?.stroke as string) ?? '#0ea5e9';
  const strokeWidth = Number(object.style?.strokeWidth ?? 2) * ((transform.xScale + transform.yScale) / 2);

  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1, strokeWidth);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.stroke();
};

const scheduleAudioTracks = async (
  context: AudioContext,
  destination: MediaStreamAudioDestinationNode,
  segments: AudioSegment[],
  timelineOriginSec: number,
): Promise<void> => {
  for (const segment of segments) {
    if (!segment.sourceUrl || segment.muted) {
      continue;
    }
    try {
      const response = await fetch(segment.sourceUrl);
      const bytes = await response.arrayBuffer();
      const decoded = await context.decodeAudioData(bytes.slice(0));
      const source = context.createBufferSource();
      source.buffer = decoded;
      source.connect(destination);

      const offsetSec = Math.max(0, (segment.sourceOffsetMs ?? 0) / 1000);
      const available = Math.max(0.001, decoded.duration - offsetSec);
      const timelineSec = Math.max(0.001, (segment.endTime - segment.startTime) / 1000);
      const sourceDurationSec = segment.sourceDurationMs
        ? Math.max(0.001, segment.sourceDurationMs / 1000)
        : timelineSec;
      const durationSec = Math.max(0.001, Math.min(available, sourceDurationSec, timelineSec));
      const startAt = timelineOriginSec + (segment.startTime / 1000);
      source.start(startAt, offsetSec, durationSec);
    } catch {
      // ignore broken segment audio during export
    }
  }
};

export const exportProjectMp4 = async (options: ExportVideoOptions): Promise<ExportProjectMp4Result> => {
  const report = (progress: number, message: string) => {
    options.onProgress?.(clamp(progress, 0, 1), message);
  };
  const ensureNotAborted = () => {
    if (options.signal?.aborted) {
      throw new DOMException('Export canceled', 'AbortError');
    }
  };
  ensureNotAborted();
  report(0.01, 'Preparing exporter');

  const fps = Math.max(24, Math.min(60, Math.round(options.fps ?? 60)));
  const mimeType = chooseRecorderMimeType();
  if (!mimeType) {
    throw new Error('当前运行环境不支持视频导出编码（MediaRecorder）。');
  }

  const orderedPages = [...options.pages].sort((a, b) => a.order - b.order);
  const firstPage = orderedPages[0];
  const baseWidth = firstPage?.width ?? 1280;
  const baseHeight = firstPage?.height ?? 720;
  const scale = Math.min(1, 1920 / Math.max(1, baseWidth), 1080 / Math.max(1, baseHeight));
  const outWidth = Math.max(640, Math.round(baseWidth * scale));
  const outHeight = Math.max(360, Math.round(baseHeight * scale));

  const canvas = createCanvasElement();
  if (!canvas) {
    throw new Error('视频导出失败：无法创建渲染画布。');
  }
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    throw new Error('视频导出失败：无法创建渲染上下文。');
  }

  const events = sortEvents(options.events);
  const maxEvent = events.length > 0 ? Math.max(...events.map((event) => getEventEndTime(event))) : 0;
  const maxAudio = options.audioSegments.length > 0
    ? Math.max(...options.audioSegments.map((segment) => segment.endTime))
    : 0;
  const durationMs = Math.max(1, maxEvent, maxAudio);

  const pageMetaById = new Map(orderedPages.map((page) => [page.id, page]));
  const bgImageByPageId = new Map<string, HTMLImageElement>();
  const revokeUrls: string[] = [];
  for (let i = 0; i < orderedPages.length; i += 1) {
    ensureNotAborted();
    const page = orderedPages[i];
    const sourceUrl = page.backgroundUrl
      ? page.backgroundUrl
      : page.backgroundAssetKey
        ? await loadAssetObjectUrl(page.backgroundAssetKey)
        : null;
    if (!sourceUrl) {
      continue;
    }
    try {
      const img = await loadImage(sourceUrl);
      bgImageByPageId.set(page.id, img);
      if (!page.backgroundUrl) {
        revokeUrls.push(sourceUrl);
      }
    } catch {
      if (!page.backgroundUrl) {
        revokeObjectUrl(sourceUrl);
      }
    }
    if (orderedPages.length > 0) {
      report(0.08 + (i + 1) / orderedPages.length * 0.14, `Loading pages ${i + 1}/${orderedPages.length}`);
    }
  }

  const stream = canvas.captureStream(fps);
  const audioContext = createAudioContext();
  if (!audioContext) {
    throw new Error('当前运行环境不支持导出音频混流（AudioContext 不可用）。');
  }
  const audioDestination = audioContext.createMediaStreamDestination();
  await audioContext.resume();
  const exportTimelineOriginSec = audioContext.currentTime + 0.03;
  ensureNotAborted();
  report(0.24, 'Preparing audio tracks');
  await scheduleAudioTracks(audioContext, audioDestination, options.audioSegments, exportTimelineOriginSec);
  for (const track of audioDestination.stream.getAudioTracks()) {
    stream.addTrack(track);
  }
  report(0.3, 'Starting encoder');

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const initialPageId = orderedPages[0]?.id ?? 'page-1';
  let state = createInitialProjectState(options.projectId, initialPageId);
  let cursor = 0;
  const drawAtTime = (timeMs: number) => {
    while (cursor < events.length && events[cursor].time <= timeMs) {
      state = applyEvent(state, events[cursor]);
      cursor += 1;
    }

    const pageId = state.currentPageId;
    const page = state.pages[pageId];
    const pageMeta = pageMetaById.get(pageId);
    const boardWidth = pageMeta?.width ?? baseWidth;
    const boardHeight = pageMeta?.height ?? baseHeight;
    const viewport = page.viewport;

    const xScale = (outWidth * viewport.zoom) / Math.max(1, boardWidth);
    const yScale = (outHeight * viewport.zoom) / Math.max(1, boardHeight);
    const transform = {
      xScale,
      yScale,
      viewportX: viewport.x,
      viewportY: viewport.y,
    };

    ctx.fillStyle = '#fffdf8';
    ctx.fillRect(0, 0, outWidth, outHeight);

    const bg = bgImageByPageId.get(pageId);
    if (bg) {
      const x = (0 - viewport.x) * xScale;
      const y = (0 - viewport.y) * yScale;
      const w = boardWidth * xScale;
      const h = boardHeight * yScale;
      ctx.drawImage(bg, x, y, w, h);
    }

    const visibleStrokes = getVisibleStrokes(state, timeMs);
    for (const stroke of visibleStrokes) {
      const points = getStrokePointsAtTime(stroke, timeMs);
      const pointPressures = getStrokePointPressuresAtTime(stroke, timeMs);
      if (points.length === 0) {
        continue;
      }
      const d = buildPerfectStrokePath(points.map((point) => ({
        x: (point.x - viewport.x) * xScale,
        y: (point.y - viewport.y) * yScale,
      })), Math.max(0.5, stroke.width * ((xScale + yScale) / 2)), {
        complete: true,
        pressures: pointPressures,
        variant: stroke.kind ?? 'auto',
      });
      if (!d) {
        continue;
      }
      const path2d = new Path2D(d);
      ctx.fillStyle = stroke.color;
      ctx.fill(path2d);
    }

    const visibleObjects = getVisibleObjects(state, timeMs);
    for (const object of visibleObjects) {
      drawRectObject(ctx, object, transform);
    }
  };

  const finished = new Promise<void>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('视频导出失败：录制器异常。'));
    recorder.onstop = () => resolve();
  });

  recorder.start(120);
  report(0.32, 'Rendering frames');
  let renderResolved = false;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      if (renderResolved) {
        return;
      }
      renderResolved = true;
      try {
        recorder.stop();
      } catch {
        // ignore
      }
      resolve();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const loop = () => {
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      const elapsedMs = Math.max(0, (audioContext.currentTime - exportTimelineOriginSec) * 1000);
      const timeMs = clamp(elapsedMs, 0, durationMs);
      drawAtTime(timeMs);
      report(0.32 + (timeMs / durationMs) * 0.62, `Rendering ${Math.round((timeMs / durationMs) * 100)}%`);
      if (timeMs >= durationMs) {
        setTimeout(() => {
          if (!renderResolved) {
            renderResolved = true;
          }
          try {
            recorder.stop();
          } catch (error) {
            reject(error instanceof Error ? error : new Error('录制器停止失败'));
            return;
          }
          resolve();
        }, 120);
        return;
      }
      requestPlatformFrame(loop);
    };
    requestPlatformFrame(loop);
  });

  await finished;
  ensureNotAborted();
  report(0.96, 'Finalizing file');

  const blob = new Blob(chunks, { type: mimeType });
  const ext: 'mp4' | 'webm' = mimeType.includes('mp4') ? 'mp4' : 'webm';
  report(1, `Export done (${ext.toUpperCase()})`);

  for (const url of revokeUrls) {
    revokeObjectUrl(url);
  }
  try {
    await audioContext.close();
  } catch {
    // ignore
  }

  return {
    blob,
    mimeType,
    ext,
  };
};
