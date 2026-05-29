# motion_editor

[English](README.md) | 中文

## 摘要

`motion_editor` 是一个面向机器人模型与动作数据的网页可视化与编辑工具。它基于 `motion_viewer` 扩展而来，重点支持 `URDF` 机器人的动作加载、逐帧检查、通道级编辑、平滑处理与结果导出。

本文档的目标不是只提供一个快速上手说明，而是系统整理当前工程的能力边界、使用流程、数据语义、导出约束以及新机器人接入方式，使其更接近一份可以长期维护的项目说明文档。

## 导航

- [支持范围总览](#support-matrix-zh)
- [完整使用流程](#workflow-zh)
- [功能对应关系](#feature-map-zh)
- [Root、地面与高度语义](#root-ground-zh)
- [常见问题与排查](#troubleshooting-zh)
- [如何添加新机器人](#add-robot-zh)
- [数据集与资源说明](#datasets-zh)
- [更新日志](#changelog-zh)
- [参考](#references-zh)

<a id="support-matrix-zh"></a>
## 支持范围总览

| 场景 | 模型格式 | 动作格式 | 当前支持的编辑能力 |
| --- | --- | --- | --- |
| URDF 机器人 | `.urdf` + meshes | `.csv` / MimicKit `.pkl` / GMR `.pkl` | 支持完整编辑: 关节调节、root 平移/旋转、关键帧、Curve Editor、区间偏移/平滑、导出 |
| BVH 预览 | `.bvh` | `.bvh` | 以预览为主，不走 URDF 曲线编辑流程 |
| SMPL / SMPL-H / SMPL-X | 模型 `.npz` 或 legacy `.pkl` | 动作 `.npz` | 以人体动作可视化为主，不走 URDF 曲线编辑流程 |
| OMOMO | SMPL-X 模型 + 物体 OBJ + motion `.npz` | `.npz` | 以预览为主 |

这也回答了一个关键问题:

- 当前新增的编辑功能不是只能用于 `pkl`
- 只要当前加载的是 `URDF` 机器人动作，`csv`、`MimicKit pkl`、`GMR pkl` 都能进入同一套编辑流程
- `BVH` 和 `SMPL` 目前还是以可视化预览为主，不会显示 URDF 那套关节编辑和曲线编辑能力

<a id="workflow-zh"></a>
## 完整使用流程

### 1. 启动项目

1. 安装 [npm](https://nodejs.org/en/download/)。
2. 安装依赖并启动开发环境:

```bash
npm install
npm run build
npm run dev
```

3. 打开 Vite 输出的本地地址。

如果 `npm run dev` 报 `ENOSPC: System limit for number of file watchers reached`，
项目已默认使用轮询 watcher 规避 Linux `inotify` 配额限制。若仍想提高系统
watcher 配额，可以执行:

```bash
echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/99-motion-viewer.conf
sudo sysctl --system
```

### 2. 选择加载方式

你可以用两种方式开始:

1. 使用内置预设
2. 直接拖放本地文件或文件夹

推荐理解顺序:

1. 先用预设熟悉界面
2. 再用你自己的 URDF 和动作数据

### 3. 加载模型和动作

#### A. URDF 机器人工作流

这是当前编辑功能最完整的工作流。

1. 先加载机器人模型
   - 方式一: 在 `Models` 下拉框中选择内置模型
   - 方式二: 直接把包含 `.urdf` 和 meshes 的整个机器人文件夹拖入页面
2. 再加载动作
   - `CSV` 动作: 直接拖入 `.csv`
   - `MimicKit` 动作: 直接拖入 `.pkl`
   - `GMR` 动作: 直接拖入 `.pkl`
3. 加载完成后，会出现:
   - `Motion` 面板
   - `Joint Control` 面板
   - `Curve Editor` 面板
   - `Create Motion` 按钮

#### B. BVH 工作流

1. 直接拖入 `.bvh`
2. 页面进入 BVH 预览模式
3. 可以播放、切帧、切换单位，但不进入 URDF 的曲线编辑工作流

#### C. SMPL / AMASS / OMOMO 工作流

1. 先加载 SMPL / SMPL-H / SMPL-X 模型
   - 模型可以是 `.npz`
   - 兼容 legacy 的 `smpl_webuser` `.pkl`
2. 再加载动作 `.npz`
3. 如果是 OMOMO，还需要加载物体 OBJ
4. 当前以可视化预览为主，不走 URDF 机器人的关节曲线编辑流程

### 4. 拖放优先级

当你拖入一组混合文件时，应用会按下面顺序判断:

1. `URDF`
2. `CSV`
3. `BVH`
4. `MimicKit / GMR PKL`
5. `SMPL`

所以最稳妥的操作习惯是:

1. 先拖机器人模型
2. 再拖对应动作

### 5. 播放和查看

常用快捷键:

- `Space`: 播放 / 暂停
- `R`: 回到第 1 帧
- `Tab`: 切换视角模式 `root lock / free`
- `Shift`: 切换 SMPL 的 mesh / skeleton 显示

常用界面操作:

- `Motion slider`: 逐帧定位
- `FPS`: 修改当前动作的播放帧率
- `BVH Unit`: 调整 BVH 线性单位
- `Model` 面板: 切换 URDF `Visual / Collision`

### 6. 编辑 URDF 动作

只有 URDF 动作类型会进入这一套完整编辑流程，也就是:

- `csv`
- `mimickit pkl`
- `gmr pkl`

#### 时间线和关键帧

- `Insert Keyframe`: 在当前帧插入关键帧
- `Total Frames`: 修改动作总帧数
- `Insert Position`: 指定新增帧插到开头还是结尾
- 左右关键帧按钮: 在关键帧之间快速跳转

#### Joint Control 面板

- 直接调整每个关节的角度
- 直接调整 `root position`
- 直接调整 `root rotation`
- 支持对 root 的单轴平滑

`Joint Control` 和 `Curve Editor` 现在是联动的:

- 修改 `Joint Control` 时，`Curve Editor` 会同步显示对应通道的当前结果
- 如果 `Curve Editor` 已经框选了一个区间，再去 `Joint Control` 改值，这个改动会按“整段统一偏移”应用到选区，而不是只改当前一帧
- 如果没有选区，`Joint Control` 仍然保持“只改当前帧”的行为

#### Curve Editor 面板

`Curve Editor` 是这次迁移进来的核心能力之一。

现在面板里分成两级选择:

- `Target`: 你要编辑的对象
- `Axis / DOF`: 这个对象对应的轴向或自由度

对应关系是:

- `Root Translation`
  - `Axis / DOF` 里选择 `X / Y / Z`
- `Root Rotation`
  - `Axis / DOF` 里选择 `Roll / Pitch / Yaw`
- 每一个普通关节
  - `Axis / DOF` 里通常只有一个 `Value`

这里有一个很关键的概念:

- `root translation` 确实是 `xyz` 平移
- `root rotation` 不是位置偏移，而是姿态旋转
- 底层存储不是直接存 `rpy`，而是四元数 `qx/qy/qz/qw`
- 编辑器里显示 `roll / pitch / yaw`，只是为了让人更容易调；修改后会再写回四元数
- 普通关节大多数不是 3 自由度，所以它们不是 `xyz`
- 普通关节通常是 `revolute` 或 `prismatic`，本质上只有 1 个标量自由度，所以这里显示成一个 `Value`

也就是说:

- `root` 是一个 6 自由度对象: `xyz + rotation`
- 机器人普通关节通常不是 `xyz = rpy`
- 它们多数只是“沿着 URDF 定义轴的一个角度或位移值”

当前这套编辑器里，`Curve Editor` 仍然支持:

它支持的操作包括:

1. 单通道查看
2. 拖动曲线直接改当前帧值
3. `Ctrl/Cmd + 拖拽` 选择一个帧区间
4. 在选区内做整体抬高/降低
5. 对选区做平滑
6. 对整段 root motion 做整体平移

为了避免在曲线上直接拖拽时误改数据，曲线下方现在还提供了独立的 `Curve Frame` 定位区:

- 你可以拖动滑条定位当前帧
- 也可以直接输入具体帧号，例如输入 `90`
- 不会修改曲线数值
- 右侧会直接显示当前是第几帧，例如 `Frame 128 / 600`
- 推荐先用它快速定位到目标帧，再决定是否在曲线上做点编辑

如果你只想做机器人整体位移:

- 主要用 `Root Translation`
- 如果要让同一个 root 位移偏移作用到一段帧，用 `Curve Editor -> Apply Offset`

如果你想修机器人朝向:

- 再去编辑 `Root Rotation`

如果你想修单个关节动作:

- 选对应关节
- `Axis / DOF` 一般保持 `Value` 即可

区间编辑的几个关键参数:

- `Start / End`: 选区起止帧
- `Blend`: 选区边缘过渡帧数
- `Offset`: 在选区内整体升高或降低的幅度
- `Smooth Passes`: 平滑迭代次数

对应按钮说明:

- `Current -> Start`: 把当前帧设为选区起点
- `Current -> End`: 把当前帧设为选区终点
- `Apply Offset`: 在选区内整体加减偏移，并按 `Blend` 做过渡
- `Smooth Range`: 只对选区内部做平滑
- `Crop Range`: 只保留 `Start / End` 选区，并从第 1 帧重新编号
- `Clear Range`: 清空当前选区

锁定通道:

- `Value`: 要写入当前选中通道的恒定值
- `Use Current`: 把当前帧的通道值填入 `Value`
- `Apply Constant`: 把 `Value` 写入当前 `Start / End` 选区；如果没有选区，则只写当前帧。不改变帧数、stride 或 schema

#### Undo / Redo

为了减少误操作，URDF 动作工作流现在支持撤销和重做:

- `Undo`: 回退上一次编辑
- `Redo`: 恢复刚刚撤销的编辑
- 快捷键:
  - `Ctrl/Cmd + Z`: `Undo`
  - `Ctrl/Cmd + Shift + Z`: `Redo`
  - `Ctrl/Cmd + Y`: `Redo`

目前会进入历史栈的操作包括:

- `Joint Control` 修改
- `Curve Editor` 单点拖拽
- `Curve Editor` 选区 `Apply Offset`
- `Curve Editor` 选区 `Smooth Range`
- `Curve Editor` 选区 `Crop Range`
- `Curve Editor` 的 `Apply Constant`
- `FPS`
- `Total Frames`
- `Insert Keyframe`

如果你在没有 `floating_base_joint` 的机器人上编辑 `root`:

- 撤销和重做仍然支持
- 这类机器人不会通过真实的 floating root joint 驱动
- 编辑器会退回到“直接改机器人整体 transform”的 fallback 方式

这不是错误，而是当前这类 URDF 的正常兼容路径。

### 7. 从零创建动作

只要当前已经加载了一个 URDF 机器人，就可以点击 `Create Motion`。

创建时可设置:

- `Export Format`: `csv` / `gmr` / `mimickit`
- `FPS`
- `Total Frames`

创建后会得到一个初始为零姿态的新动作:

- root position = `0, 0, 0`
- root rotation = 单位四元数
- 所有关节角 = `0`

随后你就可以继续用:

- 时间线
- 关键帧
- Joint Control
- Curve Editor

来逐步搭动作。

### 8. 导出动作

当前导出只针对 URDF 动作工作流，支持:

- `CSV`
- `GMR PKL`
- `MimicKit PKL`

导出规则:

- 当前动作是 `csv` 时，导出 `modified_motion.csv`
- 当前动作是 `gmr` 时，导出 `modified_motion.pkl`
- 当前动作是 `mimickit` 时，导出 `modified_motion.pkl`

对于 `GMR PKL`，当前导出逻辑会尽量保持 GMR 需要的结构:

- `root_pos`: `numpy.ndarray`
- `root_rot`: `numpy.ndarray`
- `dof_pos`: `numpy.ndarray`
- `fps`: 数值

这样导出的文件可以继续被 GMR 的 `load_robot_motion()` 使用，而不是退化成普通 Python `list`。

<a id="feature-map-zh"></a>
## 功能对应关系

如果你想快速判断“我现在该用哪个面板”，可以参考下面这张表:

| 需求 | 对应功能 |
| --- | --- |
| 看动作是否正常 | `Play / Reset / Motion Slider` |
| 调整单个关节 | `Joint Control` |
| 调整 root 姿态 | `Joint Control` 里的 root controls |
| 调整某个通道的整体趋势 | `Curve Editor` |
| 调整一段区间的高低 | `Curve Editor -> Apply Offset` |
| 让一段动作更顺 | `Curve Editor -> Smooth Range` |
| 整段动作平移 | `Curve Editor -> Root Translation -> Apply Offset` |
| 从零开始做一个动作 | `Create Motion` |
| 输出训练或回放文件 | `Export` |

<a id="root-ground-zh"></a>
## Root、地面与高度语义

这部分很重要，因为很多“机器人浮空 / 陷地 / root z 改了但看起来没变化”的问题，都和这里有关。

### 1. 地面位置

当前 URDF 动作工作流采用的规则是:

- 地面固定在世界坐标原点
- 地板不会因为 root 编辑而跟着一起上移或下移
- 无限地板只是视觉上跟随相机平铺扩展，世界高度仍然保持不变

也就是说:

- 改 `root translation -> Z`
- 应该移动的是机器人
- 不应该移动的是地面

### 2. root translation 的含义

- `Root Translation -> X / Y / Z` 是机器人整体根位移
- `Z` 轴直接决定机器人相对地面的高度
- 如果 `root z` 增大，机器人应当离地面更高
- 如果 `root z` 减小，机器人会更接近地面，甚至可能陷入地面

### 3. 为什么不同机器人看到的最低点数值不同

你可能会看到不同机器人和不同数据集的最低点数值并不一致。

这不一定代表地面画错了，而更可能代表:

- 机器人几何模型的最低点本来就离 root 有不同静态距离
- 不同数据集对 `root z` 的定义不完全一样
- 某些官方数据是在它们自己的 XML / MJCF 场景里配套标定过的

所以:

- “最低点不是 0” 并不自动等于“地面有问题”
- 更准确的判断方式是看:
  - 地面是否固定在世界原点
  - root z 改动时地面是否保持不动
  - 同一份 motion 在不同 viewer 里是否使用了不同的 robot base / XML 标定

### 4. 为什么会出现 fallback root

有些 URDF 没有 `floating_base_joint`，所以:

- 编辑器找不到名为 `floating_base_joint` 的真实 root joint
- root motion 不会通过一个 URDF 浮动关节来驱动
- 编辑器会改用“直接修改机器人 transform”的 fallback 方式

这就是你会看到类似提示的原因:

- `Joint "floating_base_joint" was not found. Root motion is applied through the robot transform fallback for this model.`

这条提示的含义是:

- 不是报错
- 不是说 root 失效了
- 而是在告诉你: 当前模型没有 floating root joint，所以 root motion 通过模型整体变换应用

### 5. 什么时候才是真问题

下面这些现象才更值得重点排查:

- 改了 `root z`，曲线变了，但机器人完全不动
- `Undo` 后曲线恢复了，但机器人姿态没恢复
- 地板会跟着 root 一起移动
- 导出的 GMR PKL 在 GMR 里打不开

这些问题目前都已经做过对应修复。

<a id="troubleshooting-zh"></a>
## 常见问题与排查

### Q1. 我改了 `root translation -> Z`，为什么机器人还是像嵌在地里或者浮在空中？

先按这个顺序判断:

1. 确认地面没有跟着机器人一起动
2. 确认 `Curve Editor` 的 `Root Translation -> Z` 曲线确实已经变化
3. 确认当前机器人是否使用 fallback root
4. 对照官方场景，看差异是不是来自:
   - `root z` 本身
   - 机器人 base link 定义
   - 对应 XML / MJCF 的静态标定

### Q2. 为什么会提示 `floating_base_joint was not found`？

因为当前 URDF 本身没有这个 joint。

这意味着:

- 不是动作坏了
- 不是导入失败了
- 只是 root motion 改用 fallback 方式施加到机器人整体 transform

### Q3. 撤销后为什么还会看到 fallback 提示？

撤销和重做本质上会重新把历史快照加载回播放器。

对没有 floating root joint 的机器人来说:

- 每次重新绑定 clip 时，系统都会再次确认它需要走 fallback root
- 所以你可能再次看到这条提示

这条提示本身不是异常，而是当前模型 root 驱动方式的说明。

### Q4. 导出后的 GMR PKL 为什么以前在 GMR 里报错？

之前的问题是:

- key 名看起来还是 `root_pos/root_rot/dof_pos`
- 但底层已经被导成普通 Python `list`
- GMR 读取时希望拿到的是可以做 `[:, ...]` 切片的 `numpy.ndarray`

现在导出逻辑已经改成保留 GMR 所需的 `numpy.ndarray` 结构。

### Q5. 什么时候应该优先怀疑“地面问题”，什么时候应该怀疑“motion root 标定问题”？

优先怀疑地面问题的情况:

- 你改 `root z`，但地板也一起上移
- 不同帧切换时地面高度明显跳动

优先怀疑 motion / robot 标定问题的情况:

- 地面固定不动
- 但官方数据在当前 viewer 里仍整体浮空或陷地
- 不同机器人同样的 `root z` 量级对应到不同的足底高度

这种情况更可能是:

- root 到几何最低点的静态距离不同
- 官方 XML / MJCF 和当前 URDF 的基座定义不同
- 数据集在生成阶段已经做过 ground height 标定

<a id="add-robot-zh"></a>
## 如何添加新机器人

这里分成两种需求:

1. 只是临时加载并测试
2. 想把机器人正式加入到项目内置列表

### 方式一: 直接拖文件夹加载

这是最快的接入方式，适合先验证 URDF 是否能正常显示。

你需要准备:

1. 一个 `.urdf`
2. URDF 中引用到的所有 mesh 文件
3. 保证 URDF 里的相对路径能在该文件夹结构下被找到

例如:

```text
my_robot/
  urdf/
    my_robot.urdf
  meshes/
    base_link.STL
    arm_link.STL
```

如果你的 URDF 里写的是:

```xml
<mesh filename="../meshes/base_link.STL" />
```

那拖入时就必须保证这个相对关系成立。

本项目的 URDF 加载器会优先按:

1. `URDF 所在目录 + 请求路径`
2. 文件本身的相对路径
3. 同名文件兜底匹配

来寻找 mesh，所以目录结构越完整、越接近原始工程，成功率越高。

### 方式二: 加入内置预设

如果你想让机器人出现在界面的 `Models` 下拉框里，就需要把它做成 preset。

#### 第一步: 放置资源

建议把资源放到:

```text
public/presets/<robot_name>/
```

#### 第二步: 在 `public/presets/presets.json` 增加条目

URDF 机器人常见有两种写法。

##### 写法 A: 只有一个 `urdfPath`

适合资源路径非常简单，URDF 可以直接通过 public 路径访问的情况。

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

##### 写法 B: 使用 `model.files[] + selectedUrdfPath`

这是更稳妥、也更适合多 mesh 机器人资源包的写法。

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

字段含义:

- `path`: 实际 public 目录下的文件路径
- `mapAs`: 在程序内部模拟“拖入文件夹”时，这个文件应当映射成什么路径
- `selectedUrdfPath`: 当 `files[]` 里有多个文件时，明确指定哪一个是主 URDF

为什么 `mapAs` 很重要:

- 因为 URDF 中的 mesh 路径通常是相对路径
- 程序在加载 preset 时，会把这些资源先映射成一个“虚拟文件夹”
- `mapAs` 就是在告诉加载器，这个虚拟文件夹里的相对结构是什么
- 如果 `mapAs` 不对，URDF 虽然能被选中，但 meshes 很可能找不到

### `mapAs`、`selectedUrdfPath` 分别是做什么的

这两个字段是后续接新机器人时最容易写错的地方。

`mapAs` 的作用:

- 它决定 preset 文件在程序内部的“虚拟路径”
- `App.ts` 会先把 `files[]` 里的每个文件下载下来，再按 `mapAs` 建一个 `DroppedFileMap`
- 后面的 URDF 加载流程会把这份 map 当成“用户刚刚拖了一个文件夹进来”

`selectedUrdfPath` 的作用:

- 当 `files[]` 里同时有一个 URDF 和很多 meshes 时，需要明确告诉系统“哪一个是主 URDF”
- 这个值必须和某个 `mapAs` 完全一致

### 代码里实际是怎么加载这个 preset 的

你后续接新机器人时，不一定要改代码，但最好知道流程在哪。

整体链路是:

1. [presets.json](/home/nubot/workspace/Motion_Editor/public/presets/presets.json) 被 [App.ts](/home/nubot/workspace/Motion_Editor/src/app/App.ts) 读取
2. `AppController` 解析每个 preset 的 `model.files[]`
3. [App.ts](/home/nubot/workspace/Motion_Editor/src/app/App.ts) 中的 `fetchPresetFileMap(...)` 会把 `path` 下载成浏览器里的 `File`
4. 然后按 `mapAs` 放进一个虚拟的 `DroppedFileMap`
5. 再调用 [UrdfLoadService.ts](/home/nubot/workspace/Motion_Editor/src/io/urdf/UrdfLoadService.ts) 的 `loadFromDroppedFiles(...)`
6. `UrdfLoadService` 会把 `selectedUrdfPath` 当作主 URDF，再根据 URDF 里的相对路径去解析 mesh

所以从本质上说:

- 内置 preset 加载，本质上是在模拟“拖文件夹加载”

### 接入新机器人的推荐模板

后续如果你要接入其他机器人，最推荐直接套下面这个流程。

步骤 1: 准备原始目录

```text
my_robot/
  urdf/
    my_robot.urdf
  meshes/
    link_a.STL
    link_b.STL
```

步骤 2: 先验证“拖文件夹加载”能成功

- 先不要急着写 preset
- 先把整个目录拖进页面
- 确认 URDF 和 meshes 都能正确显示

步骤 3: 复制到 `public/presets/`

```text
public/presets/my_robot/
  urdf/
    my_robot.urdf
  meshes/
    link_a.STL
    link_b.STL
```

步骤 4: 在 [presets.json](/home/nubot/workspace/Motion_Editor/public/presets/presets.json) 增加条目

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

步骤 5: 逐项核对

- `path` 指向的文件在 `public/` 里真实存在
- `mapAs` 构成的虚拟目录结构与 URDF 中的相对路径一致
- `selectedUrdfPath` 与主 URDF 的 `mapAs` 完全一致
- 所有被 URDF 引用的 mesh 都已加入 `files[]`

#### 9. 最实用的排查清单

如果你以后接入一个新机器人失败，最优先检查这几项:

1. URDF 本身能不能通过“拖文件夹”方式正常加载
2. `public/presets/<robot_name>/` 下是否漏了任何 mesh
3. `mapAs` 是否真的保留了原始相对路径关系
4. `selectedUrdfPath` 是否和主 URDF 的 `mapAs` 完全一致
5. URDF 中是否使用了浏览器当前不支持的 mesh 格式

一个很稳的经验是:

- 先让“拖文件夹加载”成功
- 再把这套目录原样搬到 `public/presets/`
- 最后再写 `presets.json`

<a id="datasets-zh"></a>
## 数据集与资源说明

### LAFAN1

- 下载 [LAFAN1](https://github.com/ubisoft/ubisoft-laforge-animation-dataset/blob/master/lafan1/lafan1.zip) 或 [lafan1-resolved](https://github.com/orangeduck/lafan1-resolved#Download)。
- 将 `.bvh` 文件直接拖入页面。

### Unitree-LAFAN1-Retargeting

- 下载 [Unitree-LAFAN1-Retargeting](https://huggingface.co/datasets/lvhaidong/LAFAN1_Retargeting_Dataset)。
- 将 `robot_description` 下的 `g1/h1/h1_2` 文件夹拖入页面以加载 URDF。
- 再将对应目录下的任意 `.csv` 动作拖入页面。

### AMASS

- 下载 SMPL 模型 [SMPL-H (.npz)](https://download.is.tue.mpg.de/download.php?domain=mano&resume=1&sfile=smplh.tar.xz)、[SMPL-X](https://download.is.tue.mpg.de/download.php?domain=smplx&sfile=smplx_lockedhead_20230207.zip) 以及 [AMASS](https://amass.is.tue.mpg.de/download.php) 数据集。
- 根据想播放的动作文件，先拖入对应模型，再拖入动作 `.npz`。
- 例如可视化 `AMASS/ACCAD/SMPL-X G/Female1General_c3d/A1_-_Stand_stageii.npz` 时，应先选择 `SMPL-X` 模型。
- `SMPL-X` 文件建议统一放在 [public/presets/SMPL-X](/home/nubot/workspace/Motion_Editor/public/presets/SMPL-X) 目录下。
- 如果你本地补充 `SMPLX_FEMALE.npz`、`SMPLX_MALE.npz`、`SMPLX_NEUTRAL.npz`，推荐直接放到这个目录，并保持以下文件名不变:
  - [SMPLX_FEMALE.npz](/home/nubot/workspace/Motion_Editor/public/presets/SMPL-X/SMPLX_FEMALE.npz)
  - [SMPLX_MALE.npz](/home/nubot/workspace/Motion_Editor/public/presets/SMPL-X/SMPLX_MALE.npz)
  - [SMPLX_NEUTRAL.npz](/home/nubot/workspace/Motion_Editor/public/presets/SMPL-X/SMPLX_NEUTRAL.npz)
- 这些文件体积较大，当前默认已加入 [`.gitignore`](/home/nubot/workspace/Motion_Editor/.gitignore)，用于本地使用，不建议直接提交到 GitHub 仓库。
- 如果仓库中没有这些本地模型文件，你仍然可以:
  - 手动将 `SMPL-X` 模型文件夹拖入页面
  - 或按上面的固定命名复制到 `public/presets/SMPL-X/` 后，本地通过内置 preset 使用

### OMOMO

- 下载 [SMPL-X](https://smpl-x.is.tue.mpg.de/download.php) 模型。
- 原始 OMOMO 数据集中动作常以单个 `.p` 打包，体积较大，不适合直接在浏览器中加载。
- 你可以下载原始数据集 [OMOMO](https://drive.google.com/file/d/1tZVqLB7II0whI-Qjz-z-AU3ponSEyAmm/view?usp=sharing)，再使用 [脚本](tools/convert_omomo_seq_to_motion_npz.py) 进行转换:

```bash
pip install joblib
python3 tools/convert_omomo_seq_to_motion_npz.py \
  --data-root <path-to-omomo-dir> \
  --output-dir-name <path-to-output-dir> \
  --overwrite
```

- 或直接下载已经预处理好的 [omomo-resolved](https://huggingface.co/datasets/Kunzhao/omomo-resolved)。
- 将 `SMPL-X` 模型文件夹拖入页面。
- 将 `captured_objects` 物体模型文件夹拖入页面。
- 将动作 `.npz` 拖入页面。

### MimicKit

- 下载 [unitree_ros](https://github.com/unitreerobotics/unitree_ros.git) 获取 Unitree 机器人的 URDF。
- 将 `unitree_ros/robots` 下的 `g1_description/go2_description` 文件夹拖入页面。
- 按照 [MimicKit](https://github.com/xbpeng/MimicKit.git) 的 README 获取动作数据。
- 再拖入 `Mimickit/data/motions/` 下的任意 `.pkl`。

### GMR

- 下载 [unitree_ros](https://github.com/unitreerobotics/unitree_ros.git) 获取 Unitree 机器人的 URDF。
- 将 `unitree_ros/robots` 下的 `g1_description/go2_description` 文件夹拖入页面。
- 按照 [GMR](https://github.com/YanjieZe/GMR.git) 的 README 获取动作数据。
- 再拖入任意 GMR `.pkl` 动作文件。

### 内置预设来源

- `dance1_subject1.bvh` 来自 [LAFAN1](https://github.com/ubisoft/ubisoft-laforge-animation-dataset/blob/master/lafan1/lafan1.zip)。
- `g1`、`h1`、`h1_2` 的 URDF 以及对应的 `dance1_subject1.csv` 来自 [Unitree-LAFAN1-Retargeting](https://huggingface.co/datasets/lvhaidong/LAFAN1_Retargeting_Dataset)。
- `SMPL-X Female`、`SMPL-X Male` 和 `SMPL-X Neutral` 模型来自 [SMPL-X](https://download.is.tue.mpg.de/download.php?domain=smplx&sfile=smplx_lockedhead_20230207.zip)。
- `SMPL-X G/Male2MartialArtsExtended_c3d/Extended_3_stageii.npz` 来自 [ACCAD](https://amass.is.tue.mpg.de/download.php)。
- `largetable_cleaned_simplified.obj` 来自 [OMOMO](https://drive.google.com/file/d/1tZVqLB7II0whI-Qjz-z-AU3ponSEyAmm/view?usp=sharing)。
- `sub1_largetable_013.npz` 来自 [omomo-resolved](https://huggingface.co/datasets/Kunzhao/omomo-resolved)。
*这些动作仅用于网站功能演示。仓库不提供模型或动作资源下载，请从原始来源获取并遵循其许可证条款。如有问题，请通过 GitHub issues 进行交流。*

<a id="changelog-zh"></a>
## 更新日志

- 2026-03-20
  - 优化界面
  - 增加关键帧控制按钮
  - 优化关节控制窗口 UI
  - 增加关节高亮功能
- 2026-03-29
  - 增加调整动作总长度时的插入位置选择，可将新增帧插到开头或结尾

<a id="references-zh"></a>
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
- 本项目使用 Trae vibe coding 完成。
