#!/usr/bin/env python3
"""D200H HID capture reconstruction and ZIP comparison helper.

Examples:
  python3 zkswe/recon/d200h_zip_tool.py reconstruct ~/.agentdeck/ulanzi-hid-capture/20260407-120000/raw
  python3 zkswe/recon/d200h_zip_tool.py summarize ~/.agentdeck/d200h-dumps/latest.zip
  python3 zkswe/recon/d200h_zip_tool.py compare ours.zip vendor.zip
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import sys
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PACKET_SIZE = 1024
HEADER = b"\x7c\x7c"
CMD_NAMES = {
    0x0001: "set_buttons",
    0x0006: "set_small_window",
    0x000A: "set_brightness",
    0x000B: "set_label_style",
    0x000D: "partial_update",
    0x0101: "in_button",
    0x0303: "in_device_info",
}


@dataclass
class Transfer:
    index: int
    command: int
    total_length: int
    packets: int
    payload: bytes
    first_file: str

    @property
    def command_name(self) -> str:
        return CMD_NAMES.get(self.command, f"cmd_{self.command:04x}")


def parse_packet(packet: bytes) -> tuple[int, int, bytes] | None:
    if len(packet) < 8 or not packet.startswith(HEADER):
        return None
    command = struct.unpack(">H", packet[2:4])[0]
    total_length = struct.unpack("<I", packet[4:8])[0]
    return command, total_length, packet[8:]


def reconstruct_transfers(capture_dir: Path) -> list[Transfer]:
    packets = sorted(p for p in capture_dir.iterdir() if p.suffix == ".bin")
    transfers: list[Transfer] = []
    current: dict[str, Any] | None = None

    for packet_file in packets:
        blob = packet_file.read_bytes()
        parsed = parse_packet(blob)
        if parsed:
            if current:
                payload = bytes(current["chunks"])[: current["total_length"]]
                transfers.append(
                    Transfer(
                        index=len(transfers),
                        command=current["command"],
                        total_length=current["total_length"],
                        packets=current["packets"],
                        payload=payload,
                        first_file=current["first_file"],
                    )
                )
            command, total_length, payload = parsed
            current = {
                "command": command,
                "total_length": total_length,
                "chunks": bytearray(payload),
                "packets": 1,
                "first_file": packet_file.name,
            }
            continue

        if current:
            current["chunks"].extend(blob[:PACKET_SIZE])
            current["packets"] += 1
            if len(current["chunks"]) >= current["total_length"]:
                payload = bytes(current["chunks"])[: current["total_length"]]
                transfers.append(
                    Transfer(
                        index=len(transfers),
                        command=current["command"],
                        total_length=current["total_length"],
                        packets=current["packets"],
                        payload=payload,
                        first_file=current["first_file"],
                    )
                )
                current = None

    if current:
        payload = bytes(current["chunks"])[: current["total_length"]]
        transfers.append(
            Transfer(
                index=len(transfers),
                command=current["command"],
                total_length=current["total_length"],
                packets=current["packets"],
                payload=payload,
                first_file=current["first_file"],
            )
        )
    return transfers


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def maybe_png_info(data: bytes) -> dict[str, Any] | None:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    width = struct.unpack(">I", data[16:20])[0]
    height = struct.unpack(">I", data[20:24])[0]
    color_type = data[25] if len(data) > 25 else None
    return {"width": width, "height": height, "colorType": color_type}


def zip_summary(zip_path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {"path": str(zip_path), "entries": []}
    with zipfile.ZipFile(zip_path, "r") as zf:
        manifest = None
        if "manifest.json" in zf.namelist():
            try:
                manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
            except Exception as exc:
                manifest = {"_error": str(exc)}
        result["manifest"] = manifest
        for info in sorted(zf.infolist(), key=lambda item: item.filename):
            entry: dict[str, Any] = {
                "name": info.filename,
                "fileSize": info.file_size,
                "compressSize": info.compress_size,
                "crc32": f"0x{info.CRC:08x}",
                "compressType": info.compress_type,
            }
            if not info.is_dir():
                png = maybe_png_info(zf.read(info.filename))
                if png:
                    entry["png"] = png
            result["entries"].append(entry)
    return result


def read_manifest_source(source: Path) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if source.suffix.lower() == ".zip":
        summary = zip_summary(source)
        manifest = summary.get("manifest")
        return summary, manifest if isinstance(manifest, dict) else None

    text = source.read_text(encoding="utf-8", errors="ignore").replace("\r", "")
    parsed = json.loads(text)
    manifest = parsed.get("manifest") if isinstance(parsed, dict) and "manifest" in parsed else parsed
    return None, manifest if isinstance(manifest, dict) else None


def flatten_json(value: Any, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(value, dict):
        for key in sorted(value):
            path = f"{prefix}.{key}" if prefix else str(key)
            out.update(flatten_json(value[key], path))
    elif isinstance(value, list):
        for idx, item in enumerate(value):
            path = f"{prefix}[{idx}]"
            out.update(flatten_json(item, path))
    else:
        out[prefix] = value
    return out


def normalize_buttons(manifest: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not isinstance(manifest, dict):
        return {}
    buttons = manifest.get("Buttons") if "Buttons" in manifest else manifest
    if not isinstance(buttons, dict):
        return {}
    return {str(key): value for key, value in buttons.items() if isinstance(value, dict)}


def extract_view(button: dict[str, Any]) -> dict[str, Any]:
    view = button.get("ViewParam", {})
    if isinstance(view, list):
        return view[0] if view and isinstance(view[0], dict) else {}
    return view if isinstance(view, dict) else {}


def parse_res_listing_sizes(res_listing: Path) -> dict[str, int]:
    sizes: dict[str, int] = {}
    current_dir = ""
    for raw_line in res_listing.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.endswith(":") and line.startswith("/"):
            current_dir = line[:-1]
            continue
        if current_dir != "/res/ui/default/Images":
            continue
        match = re.search(r"\s(\d+)\s+\w+\s+\d+\s+\d{4}\s+(.+\.png)$", raw_line)
        if not match:
            continue
        size = int(match.group(1))
        name = match.group(2).strip()
        sizes[name] = size
        sizes[f"Images/{name}"] = size
    return sizes


def print_button_profile(
    label: str,
    manifest: dict[str, Any] | None,
    *,
    summary: dict[str, Any] | None = None,
    res_listing: Path | None = None,
) -> None:
    buttons = normalize_buttons(manifest)
    print(f"\n{label} button profile:")
    if not buttons:
        print("  no buttons found")
        return

    action_counts: Counter[str] = Counter()
    state_counts: Counter[int] = Counter()
    icon_refs: list[str] = []
    texts_nonempty = 0
    texts_empty = 0

    for button in buttons.values():
        view = extract_view(button)
        action = button.get("Action")
        action_counts[str(action or "<none>")] += 1
        state_counts[int(button.get("State", 0))] += 1
        text = str(view.get("Text") or "")
        if text:
            texts_nonempty += 1
        else:
            texts_empty += 1
        icon = str(view.get("Icon") or "")
        if icon:
            icon_refs.append(icon)

    print(f"  buttons       : {len(buttons)}")
    print(f"  text non-empty: {texts_nonempty}")
    print(f"  text empty    : {texts_empty}")
    print(f"  actions       : {dict(action_counts.most_common(5))}")
    print(f"  states        : {dict(sorted(state_counts.items()))}")

    if icon_refs:
        unique_icons = sorted(set(icon_refs))
        print(f"  icon refs     : {len(unique_icons)} unique")
        print(f"  icon sample   : {unique_icons[:5]}")

    if summary:
        png_entries = [entry for entry in summary.get("entries", []) if entry["name"].endswith(".png")]
        if png_entries:
            sizes = [int(entry["fileSize"]) for entry in png_entries]
            print(
                "  zip png sizes : "
                f"count={len(sizes)} min={min(sizes)} max={max(sizes)} avg={round(sum(sizes) / len(sizes), 1)}"
            )

    if res_listing:
        sizes_by_name = parse_res_listing_sizes(res_listing)
        resolved = [sizes_by_name[name] for name in icon_refs if name in sizes_by_name]
        if resolved:
            print(
                "  icon file sizes: "
                f"count={len(resolved)} min={min(resolved)} max={max(resolved)} avg={round(sum(resolved) / len(resolved), 1)}"
            )

    print("  sample buttons:")
    for key in sorted(buttons)[:8]:
        button = buttons[key]
        view = extract_view(button)
        print(
            f"    {key}: "
            f"action={button.get('Action') or '<none>'} "
            f"text={view.get('Text')!r} "
            f"icon={view.get('Icon')!r} "
            f"state={button.get('State')!r}"
        )


def compare_sources(left: Path, right: Path) -> int:
    left_summary, left_manifest = read_manifest_source(left)
    right_summary, right_manifest = read_manifest_source(right)

    print(f"left : {left}")
    print(f"right: {right}")
    print_button_profile("left", left_manifest, summary=left_summary)
    print_button_profile("right", right_manifest, summary=right_summary)

    if left_summary and right_summary:
        left_entries = {entry["name"]: entry for entry in left_summary["entries"]}
        right_entries = {entry["name"]: entry for entry in right_summary["entries"]}

        left_only = sorted(set(left_entries) - set(right_entries))
        right_only = sorted(set(right_entries) - set(left_entries))
        if left_only:
            print("\nleft-only entries:")
            for name in left_only:
                print(f"  {name}")
        if right_only:
            print("\nright-only entries:")
            for name in right_only:
                print(f"  {name}")

        print("\nshared entry deltas:")
        delta_count = 0
        for name in sorted(set(left_entries) & set(right_entries)):
            left_entry = left_entries[name]
            right_entry = right_entries[name]
            diffs = []
            for field in ("fileSize", "compressSize", "crc32", "compressType", "png"):
                if left_entry.get(field) != right_entry.get(field):
                    diffs.append(f"{field}: {left_entry.get(field)} != {right_entry.get(field)}")
            if diffs:
                delta_count += 1
                print(f"  {name}")
                for diff in diffs:
                    print(f"    {diff}")
        if delta_count == 0:
            print("  no entry-level deltas")

    left_manifest = flatten_json(left_manifest)
    right_manifest = flatten_json(right_manifest)
    manifest_keys = sorted(set(left_manifest) | set(right_manifest))
    manifest_deltas = []
    for key in manifest_keys:
        if left_manifest.get(key) != right_manifest.get(key):
            manifest_deltas.append((key, left_manifest.get(key), right_manifest.get(key)))

    print("\nmanifest deltas:")
    if not manifest_deltas:
        print("  no manifest deltas")
    else:
        for key, left_val, right_val in manifest_deltas[:200]:
            print(f"  {key}: {left_val!r} != {right_val!r}")
        if len(manifest_deltas) > 200:
            print(f"  ... {len(manifest_deltas) - 200} more")

    return 0


def command_profile(args: argparse.Namespace) -> int:
    source = Path(args.source).expanduser().resolve()
    summary, manifest = read_manifest_source(source)
    res_listing = Path(args.res_listing).expanduser().resolve() if args.res_listing else None

    print(f"source: {source}")
    if res_listing:
        print(f"res listing: {res_listing}")
    print_button_profile("source", manifest, summary=summary, res_listing=res_listing)
    return 0


def command_reconstruct(args: argparse.Namespace) -> int:
    capture_dir = Path(args.capture_dir).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve() if args.out_dir else capture_dir.parent / "reconstructed"
    ensure_dir(out_dir)

    transfers = reconstruct_transfers(capture_dir)
    print(f"reconstructed transfers: {len(transfers)}")
    for transfer in transfers:
        print(
            f"[{transfer.index:03d}] {transfer.command_name} "
            f"cmd=0x{transfer.command:04x} bytes={transfer.total_length} packets={transfer.packets} "
            f"first={transfer.first_file}"
        )
        if transfer.command in (0x0001, 0x000D):
            zip_name = f"{transfer.index:03d}-{transfer.command_name}-{transfer.total_length}b.zip"
            zip_path = out_dir / zip_name
            zip_path.write_bytes(transfer.payload)
            summary = zip_summary(zip_path)
            (out_dir / f"{zip_name}.json").write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    return 0


def command_summarize(args: argparse.Namespace) -> int:
    zip_path = Path(args.zip_path).expanduser().resolve()
    print(json.dumps(zip_summary(zip_path), indent=2, sort_keys=True))
    return 0


def command_compare(args: argparse.Namespace) -> int:
    left = Path(args.left).expanduser().resolve()
    right = Path(args.right).expanduser().resolve()
    return compare_sources(left, right)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    reconstruct = sub.add_parser("reconstruct", help="reconstruct HID transfers from raw packet dumps")
    reconstruct.add_argument("capture_dir", help="directory of raw .bin packet dumps")
    reconstruct.add_argument("--out-dir", help="directory for reconstructed ZIP payloads")
    reconstruct.set_defaults(func=command_reconstruct)

    summarize = sub.add_parser("summarize", help="summarize a D200H ZIP payload")
    summarize.add_argument("zip_path", help="path to a reconstructed or dumped ZIP payload")
    summarize.set_defaults(func=command_summarize)

    profile = sub.add_parser("profile", help="profile button manifest semantics from a ZIP or manifest JSON")
    profile.add_argument("source", help="ZIP payload or manifest JSON/TXT path")
    profile.add_argument("--res-listing", help="stock res listing path for icon size resolution")
    profile.set_defaults(func=command_profile)

    compare = sub.add_parser("compare", help="compare two D200H ZIP payloads or manifest sources")
    compare.add_argument("left", help="first ZIP or manifest JSON/TXT path")
    compare.add_argument("right", help="second ZIP or manifest JSON/TXT path")
    compare.set_defaults(func=command_compare)

    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
