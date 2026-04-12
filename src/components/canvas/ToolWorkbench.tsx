import React, { useMemo, useState } from 'react';
import {
  IoBackspaceOutline,
  IoColorWandOutline,
  IoHandLeftOutline,
  IoPencilOutline,
  IoSettingsOutline,
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
  onSmoothingChange: (value: number) => void;
  onSnapChange: (value: boolean) => void;
  onEraserRadiusChange: (value: number) => void;
};

const TOOL_ITEMS: Array<{ id: ToolId; title: string; icon: React.ReactNode }> = [
  { id: 'pen', title: 'Pen', icon: <IoPencilOutline size={16} /> },
  { id: 'highlight', title: 'Highlighter', icon: <IoColorWandOutline size={16} /> },
  { id: 'rect', title: 'Shape', icon: <IoSquareOutline size={16} /> },
  { id: 'drag', title: 'Move / Pan', icon: <IoHandLeftOutline size={16} /> },
  { id: 'erase', title: 'Erase', icon: <IoBackspaceOutline size={16} /> },
];

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const TOOL_COLORS = ['#0f172a', '#0a84ff', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'];
const HIGHLIGHT_COLORS = ['#fde047', '#f59e0b', '#a3e635', '#67e8f9', '#f9a8d4', '#c4b5fd'];

type SecondaryMenuProps = Pick<
ToolWorkbenchProps,
| 'tool'
| 'parameters'
| 'disabled'
| 'onStrokeColorChange'
| 'onStrokeWidthChange'
| 'onStrokeOpacityChange'
| 'onHighlighterColorChange'
| 'onHighlighterWidthChange'
| 'onHighlighterOpacityChange'
| 'onSmoothingChange'
| 'onSnapChange'
| 'onEraserRadiusChange'
>;

const SecondaryMenu: React.FC<SecondaryMenuProps> = ({
  tool,
  parameters,
  disabled,
  onStrokeColorChange,
  onStrokeWidthChange,
  onStrokeOpacityChange,
  onHighlighterColorChange,
  onHighlighterWidthChange,
  onHighlighterOpacityChange,
  onSmoothingChange,
  onSnapChange,
  onEraserRadiusChange,
}) => {
  if (tool === 'pen') {
    return (
      <div className="tool-secondary-panel">
        <div className="tool-secondary-row swatches">
          {TOOL_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`swatch-btn ${parameters.color === color ? 'selected' : ''}`}
              style={{ background: color }}
              disabled={disabled}
              onClick={() => onStrokeColorChange(color)}
              title={color}
              aria-label={`Pen color ${color}`}
            />
          ))}
        </div>
        <label className="tool-slider-row">
          <span>粗细</span>
          <input
            type="range"
            min={0.5}
            max={16}
            step={0.1}
            value={parameters.width}
            disabled={disabled}
            onChange={(event) => onStrokeWidthChange(clamp(Number(event.target.value) || 0.5, 0.5, 16))}
          />
        </label>
        <label className="tool-slider-row">
          <span>透明度</span>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.01}
            value={parameters.opacity}
            disabled={disabled}
            onChange={(event) => onStrokeOpacityChange(clamp(Number(event.target.value) || 0.05, 0.05, 1))}
          />
        </label>
        <label className="tool-slider-row">
          <span>平滑</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={parameters.smoothing}
            disabled={disabled}
            onChange={(event) => onSmoothingChange(clamp(Number(event.target.value) || 0, 0, 1))}
          />
        </label>
      </div>
    );
  }

  if (tool === 'highlight') {
    return (
      <div className="tool-secondary-panel">
        <div className="tool-secondary-row swatches">
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`swatch-btn ${parameters.highlighterColor === color ? 'selected' : ''}`}
              style={{ background: color }}
              disabled={disabled}
              onClick={() => onHighlighterColorChange(color)}
              title={color}
              aria-label={`Highlighter color ${color}`}
            />
          ))}
        </div>
        <label className="tool-slider-row">
          <span>粗细</span>
          <input
            type="range"
            min={4}
            max={42}
            step={0.5}
            value={parameters.highlighterWidth}
            disabled={disabled}
            onChange={(event) => onHighlighterWidthChange(clamp(Number(event.target.value) || 4, 4, 42))}
          />
        </label>
        <label className="tool-slider-row">
          <span>透明度</span>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.01}
            value={parameters.highlighterOpacity}
            disabled={disabled}
            onChange={(event) => onHighlighterOpacityChange(clamp(Number(event.target.value) || 0.05, 0.05, 1))}
          />
        </label>
      </div>
    );
  }

  if (tool === 'rect') {
    return (
      <div className="tool-secondary-panel">
        <div className="tool-secondary-hint">形状工具当前为矩形，后续将扩展圆形/箭头/文本。</div>
        <label className="tool-slider-row">
          <span>边框粗细</span>
          <input
            type="range"
            min={0.5}
            max={20}
            step={0.5}
            value={parameters.width}
            disabled={disabled}
            onChange={(event) => onStrokeWidthChange(clamp(Number(event.target.value) || 0.5, 0.5, 20))}
          />
        </label>
        <label className="tool-toggle-row">
          <span>网格吸附</span>
          <CupertinoSwitch
            checked={parameters.snap}
            disabled={disabled}
            ariaLabel="网格吸附"
            onChange={onSnapChange}
          />
        </label>
      </div>
    );
  }

  if (tool === 'erase') {
    return (
      <div className="tool-secondary-panel">
        <div className="tool-secondary-hint">橡皮按“整笔/整对象”擦除。</div>
        <label className="tool-slider-row">
          <span>擦除半径</span>
          <input
            type="range"
            min={4}
            max={40}
            step={0.5}
            value={parameters.eraserRadius}
            disabled={disabled}
            onChange={(event) => onEraserRadiusChange(clamp(Number(event.target.value) || 4, 4, 40))}
          />
        </label>
      </div>
    );
  }

  return (
    <div className="tool-secondary-panel">
      <div className="tool-secondary-hint">拖动对象或平移白板。</div>
      <label className="tool-toggle-row">
        <span>对象吸附</span>
        <CupertinoSwitch
          checked={parameters.snap}
          disabled={disabled}
          ariaLabel="对象吸附"
          onChange={onSnapChange}
        />
      </label>
    </div>
  );
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
  onSmoothingChange,
  onSnapChange,
  onEraserRadiusChange,
}) => {
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const selectedTool = useMemo(() => TOOL_ITEMS.find((item) => item.id === tool), [tool]);

  return (
    <div className="panel canvas-toolbar">
      <div className="tool-primary-row">
        {TOOL_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`icon-btn tool-main-btn ${tool === item.id ? 'selected' : ''}`}
            title={item.title}
            aria-label={item.title}
            disabled={disabled}
            onClick={() => {
              if (tool === item.id) {
                setSecondaryOpen((value) => !value);
                return;
              }
              onSelectTool(item.id);
              setSecondaryOpen(true);
            }}
          >
            {item.icon}
          </button>
        ))}
        <button
          type="button"
          className={`icon-btn tool-main-btn ${secondaryOpen ? 'selected' : ''}`}
          title="Tool Settings"
          aria-label="Tool Settings"
          disabled={disabled}
          onClick={() => setSecondaryOpen((value) => !value)}
        >
          <IoSettingsOutline size={15} />
        </button>
      </div>

      {secondaryOpen ? (
        <div className="panel tool-secondary-popover">
          <div className="tool-secondary-header">
            <strong>{selectedTool?.title ?? 'Tool'}</strong>
            <span className="mono">{phase}</span>
          </div>
          <SecondaryMenu
            tool={tool}
            parameters={parameters}
            disabled={disabled}
            onStrokeColorChange={onStrokeColorChange}
            onStrokeWidthChange={onStrokeWidthChange}
            onStrokeOpacityChange={onStrokeOpacityChange}
            onHighlighterColorChange={onHighlighterColorChange}
            onHighlighterWidthChange={onHighlighterWidthChange}
            onHighlighterOpacityChange={onHighlighterOpacityChange}
            onSmoothingChange={onSmoothingChange}
            onSnapChange={onSnapChange}
            onEraserRadiusChange={onEraserRadiusChange}
          />
        </div>
      ) : null}
    </div>
  );
};
