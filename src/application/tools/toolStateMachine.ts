export type ToolId = 'pen' | 'highlight' | 'rect' | 'drag' | 'erase';
export type ToolPhase = 'idle' | 'drawing' | 'committing';

export type ToolRuntimeState = {
  tool: ToolId;
  phase: ToolPhase;
};

export type ToolStateEvent =
  | { type: 'selectTool'; tool: ToolId }
  | { type: 'beginInteraction' }
  | { type: 'commitInteraction' }
  | { type: 'settle' }
  | { type: 'cancel' };

export const INITIAL_TOOL_STATE: ToolRuntimeState = {
  tool: 'pen',
  phase: 'idle',
};

export const transitionToolState = (
  state: ToolRuntimeState,
  event: ToolStateEvent,
): ToolRuntimeState => {
  switch (event.type) {
    case 'selectTool':
      return {
        tool: event.tool,
        phase: 'idle',
      };
    case 'beginInteraction':
      return {
        ...state,
        phase: 'drawing',
      };
    case 'commitInteraction':
      if (state.phase !== 'drawing') {
        return state;
      }
      return {
        ...state,
        phase: 'committing',
      };
    case 'settle':
      if (state.phase !== 'committing') {
        return state;
      }
      return {
        ...state,
        phase: 'idle',
      };
    case 'cancel':
      return {
        ...state,
        phase: 'idle',
      };
    default:
      return state;
  }
};
