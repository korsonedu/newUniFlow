import React, { useMemo } from 'react';
import {
  IoBackspaceOutline,
  IoColorWandOutline,
  IoHandLeftOutline,
  IoMagnetOutline,
  IoPencilOutline,
  IoSquareOutline,
} from 'react-icons/io5';
import { ToolId, ToolPhase } from '../../application/tools/toolStateMachine';
import { ToolParameterModel } from '../../application/tools/toolParameters';
import { CupertinoSwitch } from '../ui/CupertinoSwitch';

type ToolWorkbenchProps = {
  tool: ToolId;
  phase: ToolPhase;
  parameters: ToolParameterModel;
  disabled: boolean;
  onSelectTool: (tool: ToolId) => void;
  onStrokeColorChange: (value: string) => void;
  onStrokeWidthChange: (value: number) => void;
  onStrokeOpacityChange: (value: number) => void;
  onHighlighterColorChange: (value: string) => void;
  onHighlighterWidthChange: (value: number) => void;
  onHighlighterOpacityChange: (value: number) => void;
  onSnapChange: (value: boolean) => void;
  onEraserRadiusChange: (value: number) => void;
};

const TOOL_ITEMS: Array<{ id: ToolId; label: string; icon: React.ReactNode }> = [
  { id: 'pen', label: 'Pen', icon: <IoPencilOutline size={17} /> },
  { id: 'highlight', label: 'Highlighter', icon: <IoColorWandOutline size={17} /> },
  { id: 'rect', label: 'Shape', icon: <IoSquareOutline size={17} /> },
  { id: 'drag', label: 'Move', icon: <IoHandLeftOutline size={17} /> },
  { id: 'erase', label: 'Erase', icon: <IoBackspaceOutline size={17} /> },
];

const TOOL_COLORS = ['#111827', '#2563eb', '#ef4444', '#16a34a', '#d97706', '#7c3aed'];
const HIGHLIGHT_COLORS = ['#fde047', '#fb7185', '#38bdf8', '#86efac', '#f5d0fe', '#fdba74'];

const PEN_WIDTH_PRESETS = [2, 4, 8];
const HIGHLIGHT_WIDTH_PRESETS = [12, 20, 30];
const RECT_WIDTH_PRESETS = [2, 4, 8];
const ERASER_RADIUS_PRESETS = [8, 16, 26];
const OPACITY_PRESETS = [0.4, 0.7, 1];

const isNear = (a: number, b: number): boolean => Math.abs(a - b) < 0.25;

const resolveToolAccent = (toolId: ToolId, parameters: ToolParameterModel): string => {
  if (toolId === 'pen' || toolId === 'rect') {
    return parameters.color;
  }
  if (toolId === 'highlight') {
    return parameters.highlighterColor;
  }
  if (toolId === 'erase') {
    return '#ef4444';
  }
  return '#64748b';
};

const resolvePalette = (tool: ToolId): string[] => {
  if (tool === 'highlight') {
    return HIGHLIGHT_COLORS;
  }
  if (tool === 'pen' || tool === 'rect') {
    return TOOL_COLORS;
  }
  return [];
};

const resolvePhaseLabel = (phase: ToolPhase): string => {
  if (phase === 'drawing') {
    return 'DRAW';
  }
  if (phase === 'committing') {
    return 'SYNC';
  }
  return 'READY';
};

export const ToolWorkbench: React.FC<ToolWorkbenchProps> = ({
  tool,
  phase,
  parameters,
  disabled,
  onSelectTool,
  onStrokeColorChange,
  onStrokeWidthChange,
  onStrokeOpacityChange,
  onHighlighterColorChange,
  onHighlighterWidthChange,
  onHighlighterOpacityChange,
  onSnapChange,
  onEraserRadiusChange,
}) => {
  const palette = useMemo(() => resolvePalette(tool), [tool]);
  const selectedTool = useMemo(() => TOOL_ITEMS.find((item) => item.id === tool), [tool]);
  const sizePresets = useMemo(() => {
    if (tool === 'pen') {
      return PEN_WIDTH_PRESETS;
    }
    if (tool === 'highlight') {
      return HIGHLIGHT_WIDTH_PRESETS;
    }
    if (tool === 'rect') {
      return RECT_WIDTH_PRESETS;
    }
    if (tool === 'erase') {
      return ERASER_RADIUS_PRESETS;
    }
    return [];
  }, [tool]);

  const currentSize = tool === 'pen'
    ? parameters.width
    : tool === 'highlight'
      ? parameters.highlighterWidth
      : tool === 'rect'
        ? parameters.width
        : parameters.eraserRadius;
  const currentOpacity = tool === 'highlight' ? parameters.highlighterOpacity : parameters.opacity;

  const applySize = (value: number) => {
    if (tool === 'pen') {
      onStrokeWidthChange(value);
      return;
    }
    if (tool === 'highlight') {
      onHighlighterWidthChange(value);
      return;
    }
    if (tool === 'rect') {
      onStrokeWidthChange(value);
      return;
    }
    if (tool === 'erase') {
      onEraserRadiusChange(value);
    }
  };

  const applyOpacity = (value: number) => {
    if (tool === 'highlight') {
      onHighlighterOpacityChange(value);
      return;
    }
    onStrokeOpacityChange(value);
  };

  const applyColor = (value: string) => {
    if (tool === 'highlight') {
      onHighlighterColorChange(value);
      return;
    }
    onStrokeColorChange(value);
  };

  const currentColor = tool === 'highlight' ? parameters.highlighterColor : parameters.color;

  return (
    <div className="canvas-toolbar">
      <div className="panel tool-primary-rail">
        <div className="tool-rail-caption">TOOLS</div>
        {TOOL_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`icon-btn tool-main-btn ${tool === item.id ? 'selected' : ''}`}
            title={item.label}
            aria-label={item.label}
            disabled={disabled}
            onClick={() => onSelectTool(item.id)}
          >
            {item.icon}
            <span
              className="tool-main-accent"
              style={{ backgroundColor: resolveToolAccent(item.id, parameters) }}
              aria-hidden="true"
            />
          </button>
        ))}
      </div>

      <div className="panel tool-secondary-rail">
        <div className="tool-secondary-header">
          <strong>{selectedTool?.label ?? 'Tool'}</strong>
          <span className="mono tool-secondary-phase">{resolvePhaseLabel(phase)}</span>
        </div>

        {sizePresets.length > 0 ? (
          <div className="tool-quick-row">
            {sizePresets.map((size) => (
              <button
                key={size}
                type="button"
                className={`tool-quick-chip ${isNear(currentSize, size) ? 'selected' : ''}`}
                disabled={disabled}
                onClick={() => applySize(size)}
              >
                {Math.round(size)}
              </button>
            ))}
          </div>
        ) : null}

        {(tool === 'pen' || tool === 'highlight') ? (
          <div className="tool-quick-row">
            {OPACITY_PRESETS.map((opacity) => (
              <button
                key={opacity}
                type="button"
                className={`tool-quick-chip ${isNear(currentOpacity, opacity) ? 'selected' : ''}`}
                disabled={disabled}
                onClick={() => applyOpacity(opacity)}
              >
                {Math.round(opacity * 100)}%
              </button>
            ))}
          </div>
        ) : null}

        {palette.length > 0 ? (
          <div className="tool-secondary-row swatches">
            {palette.map((color) => (
              <button
                key={color}
                type="button"
                className={`swatch-btn ${currentColor === color ? 'selected' : ''}`}
                style={{ background: color }}
                disabled={disabled}
                onClick={() => applyColor(color)}
                title={color}
                aria-label={`Color ${color}`}
              />
            ))}
          </div>
        ) : null}

        {(tool === 'drag' || tool === 'rect') ? (
          <label className="tool-toggle-row">
            <span className="tool-toggle-label">
              <IoMagnetOutline size={14} />
              Snap
            </span>
            <CupertinoSwitch
              checked={parameters.snap}
              disabled={disabled}
              ariaLabel="Grid Snap"
              onChange={onSnapChange}
            />
          </label>
        ) : null}
      </div>
    </div>
  );
};
