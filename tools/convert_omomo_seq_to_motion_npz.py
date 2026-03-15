#!/usr/bin/env python3
"""Convert OMOMO sequence .p files into per-sequence SMPL motion .npz files.

Output files are compatible with this web viewer's SMPL motion path and
preserve OMOMO sequence fields consumed by the original pipeline.

Viewer keys:
- required: poses.npy, trans.npy
- optional: betas.npy, mocap_frame_rate.npy
- omomo extras: obj_trans.npy, obj_rot_mat.npy, obj_scale.npy, trans2joint.npy

Preserved sequence keys (from *_seq_joints24.p):
- root_orient.npy, pose_body.npy, rest_offsets.npy, obj_com_pos.npy
- obj_rot.npy (same content as obj_rot_mat.npy for compatibility)
- obj_bottom_rot.npy (same content as obj_bottom_rot_mat.npy when present)
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Dict, Iterable, Tuple

import numpy as np

try:
    import joblib
except Exception as exc:  # pragma: no cover - runtime dependency guard
    raise SystemExit(
        "joblib is required. Install with: uv pip install --system joblib"
    ) from exc


def to_float_array(value: object, shape_tail: Tuple[int, ...], label: str) -> np.ndarray:
    array = np.asarray(value, dtype=np.float32)
    if array.ndim != len(shape_tail) + 1:
        raise ValueError(f"{label} rank mismatch: expected {len(shape_tail) + 1}, got {array.ndim}")
    for axis, expected in enumerate(shape_tail, start=1):
        actual = array.shape[axis]
        if actual != expected:
            raise ValueError(
                f"{label} shape mismatch at axis {axis}: expected {expected}, got {actual}"
            )
    return array


def normalize_obj_trans(value: object) -> np.ndarray:
    array = np.asarray(value, dtype=np.float32)
    if array.ndim == 3 and array.shape[1:] == (3, 1):
        return array[:, :, 0]
    if array.ndim == 2 and array.shape[1] >= 3:
        return array[:, :3]
    raise ValueError(f"obj_trans shape not supported: {array.shape}")


def normalize_obj_scale(value: object) -> np.ndarray:
    array = np.asarray(value, dtype=np.float32)
    if array.ndim == 1:
        return array
    if array.ndim == 2 and array.shape[1] == 1:
        return array[:, 0]
    raise ValueError(f"obj_scale shape not supported: {array.shape}")


def normalize_trans2joint(value: object) -> np.ndarray:
    array = np.asarray(value, dtype=np.float32)
    if array.ndim == 1 and array.shape[0] >= 3:
        return array[:3]
    if array.ndim == 2 and array.shape[0] == 1 and array.shape[1] >= 3:
        return array[0, :3]
    if array.ndim == 2 and array.shape[1] == 1 and array.shape[0] >= 3:
        return array[:3, 0]
    raise ValueError(f"trans2joint shape not supported: {array.shape}")


def extract_gender(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="ignore")
    if isinstance(value, np.ndarray):
        if value.shape == ():
            return extract_gender(value.item())
        if value.size > 0:
            return extract_gender(value.reshape(-1)[0])
    return str(value)


def safe_seq_name(raw: object, fallback_index: int) -> str:
    name = str(raw).strip()
    if not name:
        name = f"seq_{fallback_index:06d}"
    return "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in name)


def require_entry_fields(entry: Dict[str, object], seq_name: str, field_names: Iterable[str]) -> None:
    missing = [field_name for field_name in field_names if field_name not in entry]
    if missing:
        missing_text = ", ".join(missing)
        raise ValueError(f"{seq_name} is missing required OMOMO fields: {missing_text}")


def convert_split(
    src_path: Path,
    dst_dir: Path,
    split_name: str,
    overwrite: bool,
) -> Tuple[int, int]:
    data: Dict[object, Dict[str, object]] = joblib.load(src_path)
    dst_dir.mkdir(parents=True, exist_ok=True)

    converted = 0
    skipped = 0

    for idx, key in enumerate(data.keys()):
        entry = data[key]
        seq_name = safe_seq_name(entry.get("seq_name", f"{split_name}_{idx:06d}"), idx)
        out_path = dst_dir / f"{seq_name}.npz"

        if out_path.exists() and not overwrite:
            skipped += 1
            continue

        require_entry_fields(
            entry,
            seq_name,
            (
                "pose_body",
                "root_orient",
                "trans",
                "obj_trans",
                "obj_rot",
                "obj_scale",
            ),
        )

        pose_body = to_float_array(entry["pose_body"], (63,), f"{seq_name}.pose_body")
        root_orient = to_float_array(entry["root_orient"], (3,), f"{seq_name}.root_orient")
        trans = to_float_array(entry["trans"], (3,), f"{seq_name}.trans")

        frame_count = min(pose_body.shape[0], root_orient.shape[0], trans.shape[0])
        if frame_count <= 0:
            raise ValueError(f"{seq_name} has no frames")

        poses = np.concatenate([root_orient[:frame_count], pose_body[:frame_count]], axis=1).astype(np.float32)
        trans_xyz = trans[:frame_count, :3].astype(np.float32)

        betas_raw = np.asarray(entry.get("betas", np.zeros((16,), dtype=np.float32)), dtype=np.float32).reshape(-1)
        betas = np.zeros((16,), dtype=np.float32)
        copy_len = min(16, betas_raw.shape[0])
        betas[:copy_len] = betas_raw[:copy_len]

        seq_tokens = seq_name.split("_")
        obj_name = seq_tokens[1] if len(seq_tokens) >= 2 else "unknown"

        obj_trans = normalize_obj_trans(entry["obj_trans"])[:frame_count]
        obj_rot_mat = to_float_array(entry["obj_rot"], (3, 3), f"{seq_name}.obj_rot")[:frame_count]
        obj_scale = normalize_obj_scale(entry["obj_scale"])[:frame_count]
        obj_com_pos = (
            to_float_array(entry["obj_com_pos"], (3,), f"{seq_name}.obj_com_pos")[:frame_count]
            if "obj_com_pos" in entry
            else np.zeros((frame_count, 3), dtype=np.float32)
        )
        rest_offsets = (
            np.asarray(entry["rest_offsets"], dtype=np.float32)
            if "rest_offsets" in entry
            else np.zeros((24, 3), dtype=np.float32)
        )
        if rest_offsets.ndim != 2 or rest_offsets.shape[1] != 3:
            raise ValueError(f"{seq_name}.rest_offsets shape mismatch: expected [J,3], got {rest_offsets.shape}")

        trans2joint = normalize_trans2joint(
            entry.get("trans2joint", np.asarray([0.0, 0.0, 0.0], dtype=np.float32))
        )

        payload = {
            "poses": poses,
            "trans": trans_xyz,
            "betas": betas,
            "mocap_frame_rate": np.asarray(30.0, dtype=np.float32),
            "seq_name": np.asarray(seq_name),
            "gender": np.asarray(extract_gender(entry.get("gender", "unknown"))),
            "obj_name": np.asarray(obj_name),
            "root_orient": root_orient[:frame_count].astype(np.float32),
            "pose_body": pose_body[:frame_count].astype(np.float32),
            "rest_offsets": rest_offsets.astype(np.float32),
            "obj_trans": obj_trans.astype(np.float32),
            "obj_com_pos": obj_com_pos.astype(np.float32),
            "obj_rot": obj_rot_mat.astype(np.float32),
            "obj_rot_mat": obj_rot_mat.astype(np.float32),
            "obj_scale": obj_scale.astype(np.float32),
            "trans2joint": trans2joint.astype(np.float32),
        }

        # OMOMO has extra dynamic bottom-part tracks for vacuum/mop.
        if "obj_bottom_trans" in entry and "obj_bottom_rot" in entry and "obj_bottom_scale" in entry:
            payload["obj_bottom_trans"] = normalize_obj_trans(entry["obj_bottom_trans"])[:frame_count].astype(
                np.float32
            )
            obj_bottom_rot_mat = to_float_array(
                entry["obj_bottom_rot"], (3, 3), f"{seq_name}.obj_bottom_rot"
            )[:frame_count].astype(np.float32)
            payload["obj_bottom_rot"] = obj_bottom_rot_mat
            payload["obj_bottom_rot_mat"] = obj_bottom_rot_mat
            payload["obj_bottom_scale"] = normalize_obj_scale(entry["obj_bottom_scale"])[:frame_count].astype(
                np.float32
            )

        np.savez(out_path, **payload)
        converted += 1

    return converted, skipped


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert OMOMO seq .p files into per-sequence motion .npz")
    parser.add_argument(
        "--data-root",
        type=Path,
        default=Path("motions/omomo/data"),
        help="OMOMO data root containing train/test *_seq_joints24.p",
    )
    parser.add_argument(
        "--output-dir-name",
        default="motions",
        help="Output subdirectory name under data root",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing output files",
    )
    return parser


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()

    data_root = args.data_root.resolve()
    output_root = (data_root / args.output_dir_name).resolve()

    train_src = data_root / "train_diffusion_manip_seq_joints24.p"
    test_src = data_root / "test_diffusion_manip_seq_joints24.p"

    missing = [path for path in (train_src, test_src) if not path.exists()]
    if missing:
        missing_text = "\n".join(str(path) for path in missing)
        raise SystemExit(f"Required OMOMO files not found:\n{missing_text}")

    train_out = output_root / "train"
    test_out = output_root / "test"

    train_converted, train_skipped = convert_split(train_src, train_out, "train", args.overwrite)
    test_converted, test_skipped = convert_split(test_src, test_out, "test", args.overwrite)

    print(f"Output root: {output_root}")
    print(
        "Train: converted={0}, skipped={1} | Test: converted={2}, skipped={3}".format(
            train_converted,
            train_skipped,
            test_converted,
            test_skipped,
        )
    )


if __name__ == "__main__":
    main()
