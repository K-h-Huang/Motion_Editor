# Motion Viewer — Repository Agent Rules

## Required workflow
- Always output in this structure:
  1) Plan (files to touch + validation steps)
  2) Resource findings (ref/ + models/ + motions paths)
  3) Changes (what and why)
  4) Validation (how to verify)
- When adding new features, do not break existing functionality or workflows unless explicitly requested.
- Prefer minimal, localized changes; add comments where helpful, but avoid redundancy.

## Repository quick reference (for Codex)

### Stack and run commands
- Stack: Vite + TypeScript + Three.js + urdf-loader + pickleparser.
- Entry: `src/main.ts` creates `AppController`.
- Common commands:
  - `npm run dev`
  - `npm run build`
  - `npm run test`

### Code architecture
- App orchestration:
  - `src/app/App.ts`
  - `AppController` is the main coordinator of file drop, preset loading, scene state, and player switching.
- Scene and rendering:
  - `src/viewer/SceneController.ts`
  - Owns camera/light/grid/ground/view mode behavior (`free` / `root lock`).
- Input parsing services:
  - `src/io/urdf/UrdfLoadService.ts`: URDF + mesh resource resolution from drop map or preset URL.
  - `src/io/motion/CsvMotionService.ts`: CSV parsing in header mode and ordered mode.
  - `src/io/motion/BvhMotionService.ts`: BVH parsing + unit scaling + skeleton helper setup.
  - `src/io/motion/SmplMotionService.ts`: SMPL model/motion scanning and loading from NPZ/PKL.
- Playback layer:
  - `src/motion/G1MotionPlayer.ts`: URDF + CSV motion playback.
  - `src/motion/BvhMotionPlayer.ts`: BVH playback.
  - `src/motion/SmplMotionPlayer.ts`: SMPL playback.

### Directory structure
- `src/`: frontend source.
  - `app/`: app state and UI orchestration.
  - `io/drop/`: drag/drop and `DataTransfer` to file map.
  - `io/urdf/`: URDF and mesh path resolving/loading.
  - `io/motion/`: CSV/BVH/SMPL parsers and loaders.
  - `motion/`: runtime players.
  - `viewer/`: three.js scene controller.
- `public/presets/`: static preset manifest and bundled demo assets.
  - `public/presets/presets.json`
- `models/`: model assets and upstream model repos.
  - SMPL/SMPL-H/SMPL-X examples exist under `models/smpl/`.
- `motions/`: motion datasets and references.
  - Contains BVH/CSV/NPZ/FBX and OMOMO-related `.p` / `.npy` data.
- `ref/`: reference repositories. Primary reference for structure/doc style includes:
  - `ref/GMR/CLAUDE.md`

### Drop routing order (important)
`AppController.handleDroppedFileMap()` processes dropped payload in this priority:
1. URDF
2. CSV
3. BVH
4. SMPL

Do not change this order unless explicitly requested.

### Supported model and motion formats (current implementation)
- Model formats:
  - URDF (`.urdf`)
  - SMPL/SMPL-H/SMPL-X model NPZ (`.npz`) with required entries:
    - `v_template.npy`, `shapedirs.npy`, `weights.npy`, `kintree_table.npy`, `J_regressor.npy`, `f.npy`
  - Legacy SMPL `smpl_webuser` model PKL (`basicmodel_*.pkl`)
- Motion formats:
  - CSV (`.csv`) for URDF joint playback
  - BVH (`.bvh`)
  - SMPL motion NPZ (`.npz`) with required entries:
    - `poses.npy`, `trans.npy`
    - optional: `betas.npy`, `mocap_framerate.npy`, `mocap_frame_rate.npy`

### Dataset/model links shown in UI
The left `Datasets` panel (defined in `index.html`) groups links by source family:
- LAFAN1 / lafan1-resolved:
  - Motion: BVH
  - Model: Skeleton
- unitree-LAFAN1-Retarget:
  - Motion: CSV
  - Models: G1 / H1 / H1-2 URDF
- AMASS:
  - Motion: NPZ
  - Models: SMPL / SMPL-H / SMPL-X (`.npz/.pkl`)

### Preset mechanism
- Manifest path: `public/presets/presets.json`.
- Preset definitions support:
  - `model.urdfPath` (preferred for URDF)
  - `model.files[]` (legacy/SMPL)
  - `motion.kind: "csv" | "bvh" | "smpl"`
  - `motion.path` or `motion.files[]`
- Current bundled presets include:
  - G1/H1/H1-2 + LAFAN1 retarget CSV
  - LAFAN1 BVH preview
  - SMPL-H + AMASS-style motion NPZ

### Data roots and real asset conventions
- `models/` keeps robot/human model files and related metadata.
- `motions/` keeps dataset files and raw references.
- Real examples in this repo include:
  - `motions/LAFAN1_Retargeting_Dataset/*/*.csv`
  - `motions/lafan1-resolved/bvh/*.bvh`
  - `motions/AMASS/**/SMPL+H G/*.npz`
  - `motions/omomo/data/*.p` and object BPS/SDF `.npy`

### SMPL-specific behavior notes
- Motion-only NPZ drop is allowed only when an SMPL model is already active.
- When multiple model/motion candidates are found, services auto-select one and push warnings.
- `SmplMotionService` handles model+motion scanning by checking internal NPZ entries, not only file extension.
