# motion_editor

English | [中文](README.zh.md)

`motion_editor` is a web-based tool for editing and visualizing robot models and motion data. It is built on top of the motion_viewer project, extending its functionality to support motion creation, editing, and export.

Its core purpose is to quickly load robot models in the browser, create and edit motion sequences, and export them in various formats for model validation, data inspection, debugging, and demos.

## Usage

### Playback controls

- `Space`: play/pause
- `R`: reset to frame 1
- `Tab`: switch view mode (`root lock` / `free`)
- `Shift`: toggle SMPL mesh/skeleton
- Motion slider: seek by frame
- Motion panel:
  - `FPS` input for CSV playback speed
  - `BVH Unit` dropdown (`m`, `dm`, `cm`, `inch`, `feet`)

### Motion Data Adjustment
- **Create Motion**: Click the "Create Motion" button in the dataset panel to create a new motion file if you don't have motion file.
- **Adjust Total Frames**: Modify the total frames input field to change the motion duration.
- **Insert Keyframes**: Click the "Insert Keyframe" button to add keyframes at the current position.
- **Adjust Joint Angles**: Use the sliders in the motion controls panel to adjust joint angles for each keyframe.
- **Root Joint Controls**: Use the sliders to adjust root joint position and rotation (Euler angles).
- **Smooth Root Motion**: Click the "Smooth" button to smooth root motion between adjacent keyframes.

### Motion Data Export
- **Export Formats**: Support exporting to CSV, GMR .pkl, and MimicKit .pkl formats.
- **Export Process**: After creating or editing a motion, use the export functionality to save the motion data.

### How to Create and Export Motion
1. Load a URDF robot model by dragging and dropping the urdf folder.
2. Click the "Create Motion" button in the dataset panel.
3. Specify the FPS and total frames for the new motion.
4. Use the timeline slider to navigate to different frames.
5. Click "Insert Keyframe" to add keyframes at desired positions.
6. Adjust joint angles and root joint parameters using the sliders.
7. Use the "Smooth" button to smooth root motion between keyframes.
8. Preview the motion using the playback controls.
9. Export the motion to your desired format (CSV, GMR .pkl, or MimicKit .pkl).

## Run locally

1. Install [npm](https://nodejs.org/en/download/).
2. Install dependencies, build and start dev server:
```bash
npm install
npm run build
npm run dev
```
3. Open the URL printed by Vite.

## Update Log
- 2026-3-20：
1.Optimize the interface and add keyframe control buttons, allowing keyframes to be switched using the keyframe button.
2.Optimize joint control window UI
3.Add joint highlighting feature

## Datasets
### LAFAN1
- Download [LAFAN1](https://github.com/ubisoft/ubisoft-laforge-animation-dataset/blob/master/lafan1/lafan1.zip) or [lafan1-resolved](https://github.com/orangeduck/lafan1-resolved#Download).
- Drag and drop `.bvh` file.

### Unitree-LAFAN1-Retargeting
- Download [Unitree-LAFAN1-Retargeting](https://huggingface.co/datasets/lvhaidong/LAFAN1_Retargeting_Dataset).
- Drag and drop `g1/h1/h1_2` folder under `robot_description` to load urdf.
- Drag and drop any motion file (.csv) under corrospond folder. 

### AMASS
- Download SMPL model [SMPL-H (.npz)](https://download.is.tue.mpg.de/download.php?domain=mano&resume=1&sfile=smplh.tar.xz), [SMPL-X](https://download.is.tue.mpg.de/download.php?domain=smplx&sfile=smplx_lockedhead_20230207.zip) and [AMASS](https://amass.is.tue.mpg.de/download.php) dataset.
- According which motion you want to play, drag and drop corrospond model folder first, then drag and drop the motion file (.npz).
  - eg. To visualize `AMASS/ACCAD/SMPL-X G/Female1General_c3d/A1_-_Stand_stageii.npz`, choose `SMPL-X`.

### OMOMO
- Download [SMPL-X](https://smpl-x.is.tue.mpg.de/download.php) model.
- OMOMO dataset includes all motions in one .p file so it's to big to load using browser. 
- You can download original dataset [OMOMO](https://drive.google.com/file/d/1tZVqLB7II0whI-Qjz-z-AU3ponSEyAmm/view?usp=sharing) (~21G) and use [scripts](tools/convert_omomo_seq_to_motion_npz.py) to transfer and split it.
```bash
pip install joblib
python3 tools/convert_omomo_seq_to_motion_npz.py \
  --data-root <path-to-omomo-dir> \
  --output-dir-name <path-to-output-dir> \
  --overwrite
```
- Or you can download the preprocessed dataset [omomo-resolved](https://huggingface.co/datasets/Kunzhao/omomo-resolved).
- Drag and drop `SMPL-X` model folder.
- Drag and drop `captured_objects` object model folder.
- Drag and drop motion file (.npz).

### MimicKit
- Download [unitree_ros](https://github.com/unitreerobotics/unitree_ros.git) for unitree robots urdf.
- Drag and drop `g1_description/go2_description` folder under `unitree_ros/robots` to load urdf.
- Follow [MimicKit](https://github.com/xbpeng/MimicKit.git) readme to get motion data.
- Drag and drop any motion file (.pkl) under corrospond folder `Mimickit/data/motions/`.

### GMR
- Download [unitree_ros](https://github.com/unitreerobotics/unitree_ros.git) for unitree robots urdf.
- Drag and drop `g1_description/go2_description` folder under `unitree_ros/robots` to load urdf.
- Follow [GMR](https://github.com/YanjieZe/GMR.git) readme to get motion data.
- Drag and drop any GMR motion file (.pkl).

### Preset
- `dance1_subject1.bvh` bvh from [LAFAN1](https://github.com/ubisoft/ubisoft-laforge-animation-dataset/blob/master/lafan1/lafan1.zip).
- `g1`,`h1`,`h1_2` urdf and corrospnd `dance1_subject1.csv` from [Unitree-LAFAN1-Retargeting](https://huggingface.co/datasets/lvhaidong/LAFAN1_Retargeting_Dataset).
- `go2`
- `SMPL-X Female` model from [SMPL-X](https://download.is.tue.mpg.de/download.php?domain=smplx&sfile=smplx_lockedhead_20230207.zip).
- `SMPL-X G/Male2MartialArtsExtended_c3d/Extended_3_stageii.npz` from [ACCAD](https://amass.is.tue.mpg.de/download.php).
- `largetable_cleaned_simplified.obj` from [OMOMO](https://drive.google.com/file/d/1tZVqLB7II0whI-Qjz-z-AU3ponSEyAmm/view?usp=sharing).
- `sub1_largetable_013.npz` from [omomo-resolved](https://huggingface.co/datasets/Kunzhao/omomo-resolved).

*These motions are provided for website feature demonstration only. No model or motion downloads are offered. Please obtain assets from the original source and follow its license terms. If you have any issues, please communicate through GitHub issues.*





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
- This project was completed using Codex vibe coding.
