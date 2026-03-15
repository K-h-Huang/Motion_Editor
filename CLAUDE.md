# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server (http://localhost:5173)
npm run build     # Type-check + production build (tsc --noEmit && vite build)
npm run test      # Run all tests once (vitest run)
npm run preview   # Preview production build
```

Run a single test file:
```bash
npx vitest run src/io/motion/BvhMotionService.test.ts
```

Tests live alongside source in `src/**/*.test.ts` and run in a Node environment (no DOM).

## Architecture

**Entry point:** `src/main.ts` instantiates `AppController` and wires up error display.

**`src/app/App.ts` — `AppController`** is the central coordinator. It owns:
- Drag-and-drop ingestion (`io/drop/`)
- Preset loading from `public/presets/presets.json`
- Routing dropped files to the correct service
- Player lifecycle (only one player is active at a time)
- All DOM state updates (status chip, title, detail text, controls)

**`src/app/state.ts`** maps `ViewerState` (`idle | drag_over | loading | ready | error`) to UI copy strings.

**`src/viewer/SceneController.ts`** owns Three.js: camera, lights, grid, ground, and view mode (`free` / `root_lock`). Players interact with the scene through it.

### IO Services (parse/load, no playback)

| Service | Input | Output |
|---|---|---|
| `io/urdf/UrdfLoadService.ts` | URDF + mesh file map | Loaded robot + `MotionSchema` |
| `io/motion/CsvMotionService.ts` | CSV file map | `MotionClip` (header or ordered mode) |
| `io/motion/BvhMotionService.ts` | BVH file map | BVH data + skeleton helper |
| `io/motion/SmplMotionService.ts` | NPZ/PKL file map | SMPL rig + motion data |
| `io/object/ObjLoadService.ts` | OBJ file map | Mesh geometry |

`io/motion/NumpyIO.ts` — pure NPZ/NPY parser (no dependencies on Three.js or browser APIs except `DecompressionStream`).
`io/motion/PythonPickleIO.ts` — parses legacy `basicmodel_*.pkl` SMPL webuser files via `pickleparser`.
`io/motion/MotionSchema.ts` / `G1MotionSchema.ts` — schema definitions for URDF joint layouts.

### Motion Players (runtime animation)

| Player | Drives |
|---|---|
| `motion/G1MotionPlayer.ts` | URDF robot via `MotionClip` from CSV |
| `motion/BvhMotionPlayer.ts` | BVH skeleton |
| `motion/SmplMotionPlayer.ts` | SMPL skinned mesh / skeleton |

Players expose a common interface: `play()`, `pause()`, `reset()`, `seekFrame()`, `dispose()`.

### Drop routing order (do not change)

`AppController.handleDroppedFileMap()` checks dropped files in this priority:
1. URDF → `UrdfLoadService` → `G1MotionPlayer`
2. CSV → `CsvMotionService` → `G1MotionPlayer`
3. BVH → `BvhMotionService` → `BvhMotionPlayer`
4. SMPL (NPZ/PKL) → `SmplMotionService` → `SmplMotionPlayer`

### SMPL-specific notes

- A motion-only NPZ drop requires an SMPL model already loaded (checked by entry keys: `poses.npy`, `trans.npy`).
- A model NPZ is identified by having all of: `v_template.npy`, `shapedirs.npy`, `weights.npy`, `kintree_table.npy`, `J_regressor.npy`, `f.npy`.
- When multiple candidates are found in the file map, the service auto-selects one and appends warnings.
- OMOMO dataset sequences (`sub\d+_[a-z0-9]+_\d+`) trigger object-track binding logic with gender-specific hip offset fallbacks.

### Preset mechanism

Manifest at `public/presets/presets.json`. Each preset has optional `model` and `motion` blocks:
- `model.urdfPath` — preferred for URDF presets
- `model.files[]` — `{ path, mapAs }` pairs for SMPL / multi-file assets
- `motion.kind: "csv" | "bvh" | "smpl"`
- `motion.path` or `motion.files[]`

Static preset assets (models, motions, OBJ captures) live under `public/presets/`.

## Key types (`src/types/viewer.ts`)

- `DroppedFileMap = Map<string, File>` — normalized path → File, produced by `io/drop/`
- `MotionClip` — parsed CSV motion with `data: Float32Array`, `stride`, `fps`, `schema`
- `MotionSchema` — `rootJointName`, `rootComponentCount`, `jointNames[]`
- `ViewerState` — drives all UI copy and DOM `data-viewer-state` attribute

## Additional guidance

See `AGENTS.md` for dataset/model links, asset directory conventions (`models/`, `motions/`), and the full list of supported format entry requirements.
