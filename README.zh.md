# motion_editor

[English](README.md) | 中文

`motion_editor` 是一个面向机器人模型与动作数据的网页编辑和可视化工具。它依托于 motion_viewer 项目构建，扩展了其功能以支持动作创建、编辑和导出。

它的核心用途是在浏览器中快速加载机器人模型，创建和编辑动作序列，并以各种格式导出，用于模型验证、数据检查、调试和演示。

## 使用方式

### 播放控制

- `Space`：播放 / 暂停
- `R`：重置到第 1 帧
- `Tab`：切换视图模式（`root lock` / `free`）
- `Shift`：切换 SMPL 网格 / 骨骼显示
- Motion 滑块：按帧定位
- Motion 面板：
  - `FPS` 输入框：调整 CSV 播放速度
  - `BVH Unit` 下拉框：切换 BVH 单位（`m`、`dm`、`cm`、`inch`、`feet`）

### 动作数据调整
- **创建动作**：如果没有动作文件，点击数据集面板中的 "Create Motion" 按钮创建新的动作文件。
- **调整总帧数**：修改总帧数输入字段以更改动作持续时间。
- **插入关键帧**：点击 "Insert Keyframe" 按钮在当前位置添加关键帧。
- **调整关节角度**：使用运动控制面板中的滑块调整每个关键帧的关节角度。
- **根关节控制**：使用滑块调整根关节位置和旋转（欧拉角）。
- **平滑根运动**：点击 "Smooth" 按钮平滑相邻关键帧之间的根运动。

### 动作数据导出
- **导出格式**：支持导出为 CSV、GMR .pkl 和 MimicKit .pkl 格式。
- **导出过程**：创建或编辑动作后，使用导出功能保存动作数据。

### 如何创建和导出动作
1. 通过拖放 URDF 文件夹加载 URDF 机器人模型。
2. 点击数据集面板中的 "Create Motion" 按钮。
3. 为新动作指定 FPS 和总帧数。
4. 使用时间线滑块导航到不同的帧。
5. 点击 "Insert Keyframe" 在所需位置添加关键帧。
6. 使用滑块调整关节角度和根关节参数。
7. 使用 "Smooth" 按钮平滑关键帧之间的根运动。
8. 使用播放控件预览动作。
9. 将动作导出为所需格式（CSV、GMR .pkl 或 MimicKit .pkl）。

## 本地运行

1. 安装 [npm](https://nodejs.org/en/download/)。
2. 安装依赖、构建并启动开发服务器：
```bash
npm install
npm run build
npm run dev
```
3. 打开 Vite 输出的 URL。

## 更新日志

- 2026-3-20：
1.优化界面，增加关键帧控制按钮，可通过关键帧按钮切换关键帧。
2.优化关节控制窗口ui
3.增加关节高亮功能


## 数据集
### LAFAN1
- 下载 [LAFAN1](https://github.com/ubisoft/ubisoft-laforge-animation-dataset/blob/master/lafan1/lafan1.zip) 或 [lafan1-resolved](https://github.com/orangeduck/lafan1-resolved#Download)。
- 将 `.bvh` 文件直接拖入页面。

### Unitree-LAFAN1-Retargeting
- 下载 [Unitree-LAFAN1-Retargeting](https://huggingface.co/datasets/lvhaidong/LAFAN1_Retargeting_Dataset)。
- 将 `robot_description` 下的 `g1/h1/h1_2` 文件夹拖入页面以加载 URDF。
- 再将对应目录下的任意动作文件（`.csv`）拖入页面。

### AMASS
- 下载 SMPL 模型 [SMPL-H (.npz)](https://download.is.tue.mpg.de/download.php?domain=mano&resume=1&sfile=smplh.tar.xz)、[SMPL-X](https://download.is.tue.mpg.de/download.php?domain=smplx&sfile=smplx_lockedhead_20230207.zip) 以及 [AMASS](https://amass.is.tue.mpg.de/download.php) 数据集。
- 根据想播放的动作文件，先拖入对应的模型文件夹，再拖入动作文件（`.npz`）。
  - 例如：若要可视化 `AMASS/ACCAD/SMPL-X G/Female1General_c3d/A1_-_Stand_stageii.npz`，应选择 `SMPL-X` 模型。

### OMOMO
- 下载 [SMPL-X](https://smpl-x.is.tue.mpg.de/download.php) 模型。
- OMOMO 数据集会把所有动作打包在一个 `.p` 文件里，文件太大，不适合直接在浏览器中加载。
- 你可以下载原始数据集 [OMOMO](https://drive.google.com/file/d/1tZVqLB7II0whI-Qjz-z-AU3ponSEyAmm/view?usp=sharing)（约 21G），然后使用 [脚本](tools/convert_omomo_seq_to_motion_npz.py) 进行转换和拆分。
```bash
pip install joblib
python3 tools/convert_omomo_seq_to_motion_npz.py \
  --data-root <path-to-omomo-dir> \
  --output-dir-name <path-to-output-dir> \
  --overwrite
```
- 或者直接下载已经预处理好的数据集 [omomo-resolved](https://huggingface.co/datasets/Kunzhao/omomo-resolved)。
- 将 `SMPL-X` 模型文件夹拖入页面。
- 将 `captured_objects` 物体模型文件夹拖入页面。
- 将动作文件（`.npz`）拖入页面。

### MimicKit
- 下载 [unitree_ros](https://github.com/unitreerobotics/unitree_ros.git) 以获取 Unitree 机器人的 URDF。
- 将 `unitree_ros/robots` 下的 `g1_description/go2_description` 文件夹拖入页面以加载 URDF。
- 按照 [MimicKit](https://github.com/xbpeng/MimicKit.git) 的 README 获取动作数据。
- 将对应文件夹 `Mimickit/data/motions/` 下的任意动作文件（`.pkl`）拖入页面。

### GMR
- 下载 [unitree_ros](https://github.com/unitreerobotics/unitree_ros.git) 以获取 Unitree 机器人的 URDF。
- 将 `unitree_ros/robots` 下的 `g1_description/go2_description` 文件夹拖入页面以加载 URDF。
- 按照 [GMR](https://github.com/YanjieZe/GMR.git) 的 README 获取动作数据。
- 将任意 GMR 动作文件（`.pkl`）拖入页面。

### 预设
- `dance1_subject1.bvh` BVH 文件来自 [LAFAN1](https://github.com/ubisoft/ubisoft-laforge-animation-dataset/blob/master/lafan1/lafan1.zip)。
- `g1`、`h1`、`h1_2` 的 URDF 以及对应的 `dance1_subject1.csv` 来自 [Unitree-LAFAN1-Retargeting](https://huggingface.co/datasets/lvhaidong/LAFAN1_Retargeting_Dataset)。
- `go2`
- `SMPL-X Female` 模型来自 [SMPL-X](https://download.is.tue.mpg.de/download.php?domain=smplx&sfile=smplx_lockedhead_20230207.zip)。
- `SMPL-X G/Male2MartialArtsExtended_c3d/Extended_3_stageii.npz` 来自 [ACCAD](https://amass.is.tue.mpg.de/download.php)。
- `largetable_cleaned_simplified.obj` 来自 [OMOMO](https://drive.google.com/file/d/1tZVqLB7II0whI-Qjz-z-AU3ponSEyAmm/view?usp=sharing)。
- `sub1_largetable_013.npz` 来自 [omomo-resolved](https://huggingface.co/datasets/Kunzhao/omomo-resolved)。

*这些动作仅用于网站功能演示。仓库不提供模型或动作资源下载，请从原始来源获取并遵循其许可证条款。如有问题，请通过 GitHub issues 进行交流。*



## 参考
- [motion_viewer](https://github.com/Renkunzhao/motion_viewer.git)
- [robot_viewer](https://github.com/fan-ziqi/robot_viewer.git)
- [urdf-loaders](https://github.com/gkjohnson/urdf-loaders.git)
- [BVHView](https://github.com/orangeduck/BVHView.git)
- [amass](https://github.com/nghorbani/amass)
- [body_visualizer](https://github.com/nghorbani/body_visualizer.git)
- [human_body_prior](https://github.com/nghorbani/human_body_prior.git)
- [omomo_release](https://github.com/lijiaman/omomo_release.git)
- [GMR](https://github.com/YanjieZe/GMR.git)
- 本项目使用 Codex vibe coding 完成。
