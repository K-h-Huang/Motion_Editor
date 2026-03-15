import type { ViewerState } from '../types/viewer';

export interface StateCopy {
  chip: string;
  title: string;
  dropHint: string;
}

const STATE_COPY: Record<ViewerState, StateCopy> = {
  idle: {
    chip: 'Idle',
    title: 'Wait for load',
    dropHint:
      'Use the Models / Motions / Objects dropdowns to browse presets.\nDrag and drop to load models (.bvh, .urdf, .npz/.pkl (SMPL)) or MimicKit motion (.pkl).',
  },
  drag_over: {
    chip: 'Drop',
    title: 'Drop To Load',
    dropHint: 'Release mouse to parse dropped folder or file.',
  },
  loading: {
    chip: 'Loading',
    title: 'Loading Files',
    dropHint: 'Loading is in progress. Please wait.',
  },
  model_ready: {
    chip: 'Model Ready',
    title: 'Model Loaded',
    dropHint:
      'Choose an optional object, then load a compatible motion from the dropdown or by drag and drop (.csv, MimicKit .pkl, .npz, .bvh).',
  },
  playing: {
    chip: 'Playing',
    title: 'Motion Playing',
    dropHint:
      '',
  },
  error: {
    chip: 'Error',
    title: 'Load Failed',
    dropHint:
      'Supported format .bvh, .urdf, .npz, .pkl, .csv.',
  },
};

export function getStateCopy(state: ViewerState): StateCopy {
  return STATE_COPY[state];
}
