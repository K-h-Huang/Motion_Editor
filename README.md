# motion_editor

English | [中文](README.zh.md)

## Abstract

`motion_editor` is a browser-based system for robot-model and motion-data visualization and editing. It extends `motion_viewer` with a workflow centered on `URDF` robots, including motion loading, frame-wise inspection, per-channel editing, smoothing, and export.

This document is intended as more than a quick-start guide. It is organized as a maintainable technical reference that explains the current scope, workflow, data semantics, export behavior, and robot-integration path of the project.

## Navigation

- [Support Matrix](#support-matrix-en)
- [End-to-End Workflow](#workflow-en)
- [Feature-to-Task Map](#feature-map-en)
- [Root, Ground, and Height Semantics](#root-ground-en)
- [Troubleshooting](#troubleshooting-en)
- [How to Add a New Robot](#add-robot-en)
- [Datasets and Asset Notes](#datasets-en)
- [Update Log](#changelog-en)
- [References](#references-en)

<a id="support-matrix-en"></a>
## Support Matrix

| Use case | Model format | Motion format | Editing support |
| --- | --- | --- | --- |
| URDF robots | `.urdf` + meshes | `.csv` / MimicKit `.pkl` / GMR `.pkl` | Full editing workflow: joint editing, root edit, keyframes, curve editor, range offset/smoothing, export |
| BVH preview | `.bvh` | `.bvh` | Preview-oriented, not the URDF curve-editing workflow |
| SMPL / SMPL-H / SMPL-X | model `.npz` or legacy `.pkl` | motion `.npz` | Visualization-oriented, not the URDF curve-editing workflow |
| OMOMO | SMPL-X model + captured OBJ + motion `.npz` | `.npz` | Visualization-oriented |

Important clarification:

- the recent editing features are not limited to `pkl`
- they apply to URDF motion workflows in `csv`, `mimickit pkl`, and `gmr pkl`
- `BVH` and `SMPL` playback currently remain preview-first paths

<a id="workflow-en"></a>
## End-to-End Workflow

### 1. Run locally

1. Install [npm](https://nodejs.org/en/download/).
2. Install dependencies and start the dev environment:

```bash
npm install
npm run build
npm run dev
```

3. Open the URL printed by Vite.

### 2. Choose how to load assets

You can start in two ways:

1. pick a built-in preset
2. drag local files or folders into the page

For onboarding, presets are the easiest place to start.

### 3. Load models and motions

#### A. URDF robot workflow

This is the main editing path.

1. Load a robot model
   - choose a model from the `Models` dropdown, or
   - drag a folder that contains the `.urdf` and all referenced meshes
2. Load a motion
   - drag a `.csv`
   - or drag a MimicKit `.pkl`
   - or drag a GMR `.pkl`
3. After load, the app enables:
   - `Motion`
   - `Joint Control`
   - `Curve Editor`
   - `Create Motion`

#### B. BVH workflow

1. Drag a `.bvh`
2. The app enters BVH preview mode
3. You can play, seek, and change BVH units, but this does not enter the URDF joint/curve editing flow

#### C. SMPL / AMASS / OMOMO workflow

1. Load the SMPL / SMPL-H / SMPL-X model first
   - model files can be `.npz`
   - legacy `smpl_webuser` `.pkl` is also supported for models
2. Load motion `.npz`
3. For OMOMO, also load the captured object OBJ assets
4. This path is currently focused on visualization rather than URDF-style curve editing

### 4. Drag-and-drop priority

When a dropped payload contains mixed assets, the app checks them in this order:

1. `URDF`
2. `CSV`
3. `BVH`
4. `MimicKit / GMR PKL`
5. `SMPL`

The safest workflow is still:

1. load the model first
2. load the motion second

### 5. Playback and inspection

Keyboard shortcuts:

- `Space`: play / pause
- `R`: reset to frame 1
- `Tab`: toggle `root lock / free`
- `Shift`: toggle SMPL mesh / skeleton

Common controls:

- `Motion slider`: seek frame-by-frame
- `FPS`: change motion playback rate
- `BVH Unit`: switch BVH linear units
- `Visual / Collision`: switch URDF display mode

### 6. Edit URDF motion

The full editing workflow is available for these URDF motion kinds:

- `csv`
- `mimickit`
- `gmr`

#### Timeline and keyframes

- `Insert Keyframe`: add a keyframe at the current frame
- `Total Frames`: resize motion duration
- `Insert Position`: choose whether added frames go to the start or end
- previous / next keyframe buttons: jump across keyframes

#### Joint Control

Use this panel to:

- edit individual joints
- edit `root position`
- edit `root rotation`
- smooth selected root axes

`Joint Control` and `Curve Editor` now stay in sync:

- when you edit from `Joint Control`, `Curve Editor` updates to show the matching channel result
- if a frame range is already selected in `Curve Editor`, then edits from `Joint Control` are applied as a uniform offset across that whole selected range instead of only the current frame
- if no range is selected, `Joint Control` still edits only the current frame

#### Curve Editor

`Curve Editor` is the main channel-level editing tool now integrated into the app.

The panel now uses two levels of selection:

- `Target`: which object you want to edit
- `Axis / DOF`: which axis or degree of freedom inside that target

That maps to:

- `Root Translation`
  - `Axis / DOF`: `X / Y / Z`
- `Root Rotation`
  - `Axis / DOF`: `Roll / Pitch / Yaw`
- each regular robot joint
  - `Axis / DOF`: usually a single `Value`

This distinction matters:

- `root translation` is true `xyz` position
- `root rotation` is orientation, not positional offset
- the clip stores root orientation internally as a quaternion `qx/qy/qz/qw`
- the editor exposes `roll / pitch / yaw` only as a friendlier editing view, then converts back to quaternion
- most regular joints are not 3-DOF, so they are not edited as `xyz`
- most regular URDF joints are effectively a single scalar DOF, so they appear as one `Value`

In other words:

- the root is a 6-DOF object: `xyz + rotation`
- regular robot joints are not `xyz = rpy`
- they are usually a single angle or displacement defined along the URDF joint axis

It supports:

1. channel visualization
2. direct point dragging
3. `Ctrl/Cmd + drag` range selection
4. range offset up/down editing
5. in-range smoothing
6. whole-clip root translation

To reduce accidental edits from dragging directly on the curve, the panel now also includes a dedicated `Curve Frame` seek area below the plot:

- you can drag the slider to seek the current frame
- or type an exact frame number such as `90`
- it does not modify curve values
- the label shows the exact frame, for example `Frame 128 / 600`
- the recommended workflow is to seek with the slider first, then edit the curve only when needed

If your goal is only to shift the robot in space:

- use `Root Translation`
- use `Curve Editor -> Apply Offset` when the same root translation offset should affect a frame range

If you want to fix heading or base attitude:

- use `Root Rotation`

If you want to fix a single limb or actuator trajectory:

- pick that joint
- leave `Axis / DOF` on `Value`

Range editing fields:

- `Start / End`: selected frame range
- `Blend`: transition width at both range boundaries
- `Offset`: amount added to the selected range
- `Smooth Passes`: smoothing iterations

Range actions:

- `Current -> Start`
- `Current -> End`
- `Apply Offset`
- `Smooth Range`
- `Crop Range`: keep only `Start / End` and renumber the result from frame 1
- `Clear Range`

Lock channel:

- `Value`: constant value to write into the selected channel
- `Use Current`: copy the selected channel's current-frame value into `Value`
- `Apply Constant`: write `Value` to the selected `Start / End` range; if no range is selected, write only the current frame. Frame count, stride, and schema stay unchanged.

#### Undo / Redo

The URDF motion workflow now includes motion history:

- `Undo`: revert the last edit
- `Redo`: restore the reverted edit
- shortcuts:
  - `Ctrl/Cmd + Z`: `Undo`
  - `Ctrl/Cmd + Shift + Z`: `Redo`
  - `Ctrl/Cmd + Y`: `Redo`

The history currently includes:

- `Joint Control` edits
- direct `Curve Editor` point edits
- `Curve Editor` range `Apply Offset`
- `Curve Editor` range `Smooth Range`
- `Curve Editor` range `Crop Range`
- `Curve Editor` `Apply Constant`
- `FPS`
- `Total Frames`
- `Insert Keyframe`

If you edit `root` on robots that do not define a real `floating_base_joint`:

- undo and redo still work
- the robot is not driven by a true URDF floating root joint
- the app falls back to applying root motion through the robot transform itself

That fallback path is expected behavior for those models, not a failure.

### 7. Create a motion from scratch

After a URDF robot is loaded, click `Create Motion`.

You can set:

- `Export Format`: `csv`, `gmr`, or `mimickit`
- `FPS`
- `Total Frames`

The new clip starts from a zero pose:

- root position = `0, 0, 0`
- root rotation = identity quaternion
- all joint values = `0`

You can then build the motion through:

- timeline edits
- keyframes
- joint controls
- curve editor

### 8. Export

Export is currently available for URDF motion workflows only:

- `CSV`
- `GMR PKL`
- `MimicKit PKL`

Current export behavior:

- `csv` motion exports as `modified_motion.csv`
- `gmr` motion exports as `modified_motion.pkl`
- `mimickit` motion exports as `modified_motion.pkl`

For `GMR PKL`, the exporter now keeps the structure expected by GMR as closely as possible:

- `root_pos`: `numpy.ndarray`
- `root_rot`: `numpy.ndarray`
- `dof_pos`: `numpy.ndarray`
- `fps`: numeric scalar

This keeps the exported file compatible with GMR's `load_robot_motion()` instead of degrading those arrays into plain Python `list` values.

<a id="feature-map-en"></a>
## Feature-to-Task Map

| Goal | Use this |
| --- | --- |
| Check whether playback looks correct | `Play / Reset / Motion Slider` |
| Adjust one joint | `Joint Control` |
| Adjust root pose | root controls inside `Joint Control` |
| Adjust a whole channel trend | `Curve Editor` |
| Raise or lower a frame range | `Curve Editor -> Apply Offset` |
| Smooth a selected segment | `Curve Editor -> Smooth Range` |
| Move the whole robot trajectory | `Curve Editor -> Root Translation -> Apply Offset` |
| Start a new motion from zero | `Create Motion` |
| Save the edited result | `Export` |

<a id="root-ground-en"></a>
## Root, Ground, and Height Semantics

This section is important because many "floating above the floor", "sinking into the floor", and "root z changed but the robot still looks wrong" issues come from these semantics.

### 1. Ground position

The current URDF motion workflow uses this rule:

- the ground is anchored at the world origin
- the floor does not move when you edit root motion
- the infinite floor only follows the camera visually for tiling coverage; its world height stays fixed

In other words:

- editing `root translation -> Z`
- should move the robot
- should not move the ground

### 2. What root translation means

- `Root Translation -> X / Y / Z` is the global root displacement of the robot
- `Z` directly controls robot height relative to the floor
- if `root z` increases, the robot should rise relative to the ground
- if `root z` decreases, the robot moves closer to the ground and may penetrate it

### 3. Why different robots show different lowest-point values

You may observe different lowest-point values across robot models and datasets.

That does not automatically mean the floor plane is wrong. It can also mean:

- each robot geometry has a different static offset between its root and its lowest mesh point
- different datasets encode `root z` with slightly different conventions
- some official datasets are already calibrated inside their own XML / MJCF scenes

So:

- "the lowest point is not zero" does not automatically mean "the ground is wrong"
- the better checks are:
  - whether the ground stays fixed at world origin
  - whether editing root z leaves the floor untouched
  - whether the official viewer uses a different robot base or XML calibration than this URDF workflow

### 4. Why root fallback can appear

Some URDFs do not define a `floating_base_joint`, so:

- the editor cannot drive root motion through a real floating root joint
- root motion is applied through a robot transform fallback instead

That is why you may see a message such as:

- `Joint "floating_base_joint" was not found. Root motion is applied through the robot transform fallback for this model.`

The meaning of that message is:

- it is not an error
- it does not mean root editing failed
- it only explains that the current model is using the transform fallback path

### 5. What actually counts as a real problem

These are the cases that deserve investigation:

- you change `root z`, the curve changes, but the robot does not move
- `Undo` restores the curve but not the rendered robot pose
- the floor moves together with root edits
- exported GMR PKL files stop working in GMR

Those specific issues have already been addressed in the current implementation.

<a id="troubleshooting-en"></a>
## Troubleshooting

### Q1. I changed `root translation -> Z`, but the robot still looks embedded in the ground or floating above it

Check in this order:

1. confirm the floor is not moving together with the robot
2. confirm the `Root Translation -> Z` curve actually changed in `Curve Editor`
3. confirm whether the current robot is using root fallback
4. compare against the official viewer to see whether the difference comes from:
   - `root z` itself
   - robot base link definition
   - static XML / MJCF calibration

### Q2. Why does the app say `floating_base_joint was not found`?

Because that joint does not exist in the active URDF.

That means:

- the motion is not broken
- the import did not fail
- root motion is simply being applied through the robot transform fallback

### Q3. Why do I still see a fallback-root warning after undo?

Undo and redo reload a motion snapshot back into the player.

For robots that do not define a floating root joint:

- every rebind still needs to confirm that root fallback is being used
- so you may see that explanatory message again

The message itself is not an exception. It is a note about how root motion is being applied for that model.

### Q4. Why did exported GMR PKL files fail in GMR before?

The earlier problem was:

- the keys still looked like `root_pos/root_rot/dof_pos`
- but the values had been exported as plain Python `list`
- GMR expects `numpy.ndarray` values that support slicing like `[:, ...]`

The exporter now preserves the array-based structure that GMR expects.

### Q5. When should I suspect the ground logic, and when should I suspect motion/root calibration?

Suspect the ground logic first when:

- changing `root z` also moves the floor
- ground height visibly jumps frame-to-frame

Suspect motion / robot calibration first when:

- the ground stays fixed
- but official data still looks globally floating or sinking in this viewer
- similar `root z` ranges produce different foot clearance across different robots

That usually points to:

- different static offsets from root to geometry bottom
- different base definitions between official XML / MJCF assets and the URDF here
- dataset-side ground-height calibration during retargeting

<a id="add-robot-en"></a>
## How to Add a New Robot

There are two common goals:

1. load a robot temporarily for testing
2. add a robot as a built-in preset

### Option A: load by dragging a folder

This is the fastest way to verify a new URDF.

You need:

1. one `.urdf`
2. every mesh referenced by that URDF
3. a folder structure that preserves the relative paths used in the URDF

Example:

```text
my_robot/
  urdf/
    my_robot.urdf
  meshes/
    base_link.STL
    arm_link.STL
```

If your URDF contains:

```xml
<mesh filename="../meshes/base_link.STL" />
```

then the dropped folder needs to preserve that relative relationship.

The URDF loader resolves resources roughly by:

1. `URDF directory + requested relative path`
2. direct normalized path lookup
3. basename fallback lookup

So the closer your folder is to the original robot package layout, the better.

### Option B: add a built-in preset

If you want the robot to appear in the `Models` dropdown, add it to `public/presets/presets.json`.

#### Step 1: place assets under `public/presets`

A typical location is:

```text
public/presets/<robot_name>/
```

#### Step 2: add a preset entry

There are two common URDF preset patterns.

##### Pattern A: `urdfPath`

Use this when the URDF can be loaded directly from a public path.

```json
{
  "id": "my-robot-model",
  "label": "My Robot",
  "description": "My robot URDF preset model.",
  "model": {
    "urdfPath": "presets/my_robot/urdf/my_robot.urdf"
  }
}
```

##### Pattern B: `model.files[] + selectedUrdfPath`

This is the more robust pattern for robot packages with multiple mesh assets.

```json
{
  "id": "my-robot-model",
  "label": "My Robot",
  "description": "My robot URDF preset model.",
  "model": {
    "files": [
      {
        "path": "presets/my_robot/urdf/my_robot.urdf",
        "mapAs": "my_robot/urdf/my_robot.urdf"
      },
      {
        "path": "presets/my_robot/meshes/base_link.STL",
        "mapAs": "my_robot/meshes/base_link.STL"
      }
    ],
    "selectedUrdfPath": "my_robot/urdf/my_robot.urdf"
  }
}
```

Field meanings:

- `path`: the real file path under `public/`
- `mapAs`: the virtual path used when the app reconstructs a dropped-file map
- `selectedUrdfPath`: which URDF inside `files[]` should be treated as the main one

Why `mapAs` matters:

- URDF mesh references are usually relative
- preset loading internally rebuilds a virtual file tree
- `mapAs` defines that virtual file tree
- if `mapAs` does not preserve the right structure, the URDF may load but meshes may fail to resolve

### What `mapAs` and `selectedUrdfPath` really do

These are the two fields that are easiest to get wrong when adding a new robot.

What `mapAs` does:

- it defines the virtual internal path of each preset file
- [App.ts](/home/nubot/workspace/Motion_Editor/src/app/App.ts) fetches every file listed in `files[]`, then rebuilds a `DroppedFileMap` using `mapAs`
- the URDF loader then treats that map as if the user had manually dropped a folder

What `selectedUrdfPath` does:

- when `files[]` contains one URDF and many meshes, it explicitly marks which entry is the main URDF
- its value must exactly match the `mapAs` of the intended URDF file

### How the code actually loads this preset

You usually do not need to edit the code path, but it is useful to understand where it happens.

The load chain is:

1. [presets.json](/home/nubot/workspace/Motion_Editor/public/presets/presets.json) is loaded by [App.ts](/home/nubot/workspace/Motion_Editor/src/app/App.ts)
2. `AppController` parses each preset entry
3. `fetchPresetFileMap(...)` in [App.ts](/home/nubot/workspace/Motion_Editor/src/app/App.ts) fetches every `path` as a browser `File`
4. those files are inserted into a virtual `DroppedFileMap` using `mapAs`
5. [UrdfLoadService.ts](/home/nubot/workspace/Motion_Editor/src/io/urdf/UrdfLoadService.ts) is then called through `loadFromDroppedFiles(...)`
6. `UrdfLoadService` uses `selectedUrdfPath` as the primary URDF and resolves mesh paths relative to it

So conceptually:

- built-in preset loading is a structured simulation of folder drag-and-drop

### Recommended template for adding another robot

For future robots, the most reliable workflow is the following.

Step 1: prepare an original asset folder

```text
my_robot/
  urdf/
    my_robot.urdf
  meshes/
    link_a.STL
    link_b.STL
```

Step 2: verify folder-drag loading first

- do not write the preset yet
- drag the whole folder into the app
- make sure the URDF and meshes already resolve correctly

Step 3: copy the working layout into `public/presets/`

```text
public/presets/my_robot/
  urdf/
    my_robot.urdf
  meshes/
    link_a.STL
    link_b.STL
```

Step 4: add a preset entry to [presets.json](/home/nubot/workspace/Motion_Editor/public/presets/presets.json)

```json
{
  "id": "my-robot-model",
  "label": "My Robot",
  "description": "My robot URDF preset model.",
  "model": {
    "files": [
      {
        "path": "presets/my_robot/urdf/my_robot.urdf",
        "mapAs": "my_robot/urdf/my_robot.urdf"
      },
      {
        "path": "presets/my_robot/meshes/link_a.STL",
        "mapAs": "my_robot/meshes/link_a.STL"
      },
      {
        "path": "presets/my_robot/meshes/link_b.STL",
        "mapAs": "my_robot/meshes/link_b.STL"
      }
    ],
    "selectedUrdfPath": "my_robot/urdf/my_robot.urdf"
  }
}
```

Step 5: verify the following items one by one

- every `path` really exists under `public/`
- the virtual directory defined by `mapAs` matches the relative paths used inside the URDF
- `selectedUrdfPath` exactly matches the main URDF `mapAs`
- every mesh referenced by the URDF is included in `files[]`

#### 9. Practical troubleshooting checklist

If a future robot fails to load, these are the highest-priority checks:

1. can the raw robot folder already load by drag-and-drop
2. is any mesh missing under `public/presets/<robot_name>/`
3. does `mapAs` truly preserve the original relative path structure
4. does `selectedUrdfPath` exactly match the intended URDF `mapAs`
5. is the URDF using a mesh format that the browser-side loader supports

A very reliable habit is:

- make folder-drag loading work first
- then copy that structure into `public/presets/`
- only then write the preset entry

<a id="datasets-en"></a>
## Datasets and Asset Notes

### LAFAN1

- Download [LAFAN1](https://github.com/ubisoft/ubisoft-laforge-animation-dataset/blob/master/lafan1/lafan1.zip) or [lafan1-resolved](https://github.com/orangeduck/lafan1-resolved#Download).
- Drag a `.bvh` file into the page.

### Unitree-LAFAN1-Retargeting

- Download [Unitree-LAFAN1-Retargeting](https://huggingface.co/datasets/lvhaidong/LAFAN1_Retargeting_Dataset).
- Drag `g1/h1/h1_2` under `robot_description` to load the URDF.
- Then drag any matching `.csv` motion.

### AMASS

- Download SMPL model files [SMPL-H (.npz)](https://download.is.tue.mpg.de/download.php?domain=mano&resume=1&sfile=smplh.tar.xz), [SMPL-X](https://download.is.tue.mpg.de/download.php?domain=smplx&sfile=smplx_lockedhead_20230207.zip), and the [AMASS](https://amass.is.tue.mpg.de/download.php) dataset.
- Load the matching model first, then the motion `.npz`.
- Example: to visualize `AMASS/ACCAD/SMPL-X G/Female1General_c3d/A1_-_Stand_stageii.npz`, load an `SMPL-X` model first.
- `SMPL-X` files are expected under [public/presets/SMPL-X](/home/nubot/workspace/Motion_Editor/public/presets/SMPL-X).
- If you add local copies of `SMPLX_FEMALE.npz`, `SMPLX_MALE.npz`, and `SMPLX_NEUTRAL.npz`, place them in that directory and keep these filenames:
  - [SMPLX_FEMALE.npz](/home/nubot/workspace/Motion_Editor/public/presets/SMPL-X/SMPLX_FEMALE.npz)
  - [SMPLX_MALE.npz](/home/nubot/workspace/Motion_Editor/public/presets/SMPL-X/SMPLX_MALE.npz)
  - [SMPLX_NEUTRAL.npz](/home/nubot/workspace/Motion_Editor/public/presets/SMPL-X/SMPLX_NEUTRAL.npz)
- These files are large and are now ignored by [`.gitignore`](/home/nubot/workspace/Motion_Editor/.gitignore) for local use, so they should not be committed directly to GitHub.
- If the repository does not contain those local model files, you can still:
  - drag the `SMPL-X` model folder into the page manually
  - or copy the files into `public/presets/SMPL-X/` with the fixed names above to use the local bundled presets

### OMOMO

- Download the [SMPL-X](https://smpl-x.is.tue.mpg.de/download.php) model.
- Original OMOMO motions are often packed in a large `.p` file and are not practical to load directly in the browser.
- You can convert the original [OMOMO](https://drive.google.com/file/d/1tZVqLB7II0whI-Qjz-z-AU3ponSEyAmm/view?usp=sharing) release with [tools/convert_omomo_seq_to_motion_npz.py](tools/convert_omomo_seq_to_motion_npz.py):

```bash
pip install joblib
python3 tools/convert_omomo_seq_to_motion_npz.py \
  --data-root <path-to-omomo-dir> \
  --output-dir-name <path-to-output-dir> \
  --overwrite
```

- Or download the preprocessed [omomo-resolved](https://huggingface.co/datasets/Kunzhao/omomo-resolved).
- Load the `SMPL-X` model folder.
- Load the `captured_objects` OBJ folder.
- Load the motion `.npz`.

### MimicKit

- Download [unitree_ros](https://github.com/unitreerobotics/unitree_ros.git) for Unitree URDF assets.
- Drag `g1_description/go2_description` under `unitree_ros/robots` into the page.
- Follow the [MimicKit](https://github.com/xbpeng/MimicKit.git) instructions to obtain motion data.
- Drag any `.pkl` motion from `Mimickit/data/motions/`.

### GMR

- Download [unitree_ros](https://github.com/unitreerobotics/unitree_ros.git) for Unitree URDF assets.
- Drag `g1_description/go2_description` under `unitree_ros/robots` into the page.
- Follow the [GMR](https://github.com/YanjieZe/GMR.git) instructions to obtain motion data.
- Drag any GMR `.pkl` motion.

### Preset sources

- `dance1_subject1.bvh` comes from [LAFAN1](https://github.com/ubisoft/ubisoft-laforge-animation-dataset/blob/master/lafan1/lafan1.zip).
- `g1`, `h1`, `h1_2` URDFs and matching `dance1_subject1.csv` come from [Unitree-LAFAN1-Retargeting](https://huggingface.co/datasets/lvhaidong/LAFAN1_Retargeting_Dataset).
- `SMPL-X Female`, `SMPL-X Male`, and `SMPL-X Neutral` come from [SMPL-X](https://download.is.tue.mpg.de/download.php?domain=smplx&sfile=smplx_lockedhead_20230207.zip).
- `SMPL-X G/Male2MartialArtsExtended_c3d/Extended_3_stageii.npz` comes from [ACCAD](https://amass.is.tue.mpg.de/download.php).
- `largetable_cleaned_simplified.obj` comes from [OMOMO](https://drive.google.com/file/d/1tZVqLB7II0whI-Qjz-z-AU3ponSEyAmm/view?usp=sharing).
- `sub1_largetable_013.npz` comes from [omomo-resolved](https://huggingface.co/datasets/Kunzhao/omomo-resolved).

*These assets are included only to demonstrate viewer features. This repository does not redistribute third-party datasets for general use. Please obtain assets from the original sources and follow their licenses.*

<a id="changelog-en"></a>
## Update Log

- 2026-03-20
  - UI improvements
  - added keyframe control buttons
  - improved joint control window UI
  - added joint highlighting
- 2026-03-29
  - added start/end insertion choice when extending total frame count

<a id="references-en"></a>
## References

- [motion_viewer](https://github.com/Renkunzhao/motion_viewer)
- [robot_viewer](https://github.com/fan-ziqi/robot_viewer.git)
- [urdf-loaders](https://github.com/gkjohnson/urdf-loaders.git)
- [BVHView](https://github.com/orangeduck/BVHView.git)
- [amass](https://github.com/nghorbani/amass)
- [body_visualizer](https://github.com/nghorbani/body_visualizer.git)
- [human_body_prior](https://github.com/nghorbani/human_body_prior.git)
- [omomo_release](https://github.com/lijiaman/omomo_release.git)
- [GMR](https://github.com/YanjieZe/GMR.git)
- This project was completed using Trae vibe coding.
