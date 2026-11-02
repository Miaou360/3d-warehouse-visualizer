#!/usr/bin/env python3
"""Deterministic synthetic inventory & rack-layout generator for the 3D Warehouse Visualizer demo.

This script generates 100% synthetic warehouse topologies, parts catalogs, and bin-level
inventory records using a fixed PRNG seed. It reads zero external files.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import random
from pathlib import Path
from typing import Any

DEFAULT_SEED = 20261102
SNAPSHOT_DATE = dt.date(2026, 10, 15)

MODIFIERS = [
    "Upper",
    "Lower",
    "Front",
    "Rear",
    "Inner",
    "Outer",
    "Center",
    "Primary",
    "Auxiliary",
    "Compact",
    "Standard",
    "Linear",
    "Rotary",
    "Optical",
    "Thermal",
    "Digital",
]

QUALIFIERS = [
    "Mounting",
    "Support",
    "Control",
    "Sensor",
    "Signal",
    "Drive",
    "Guide",
    "Filter",
    "Protective",
    "Flexible",
    "Precision",
    "Modular",
]

NOUNS = [
    "Bracket",
    "Lens",
    "Housing",
    "Connector",
    "Assembly",
    "Module",
    "Gasket",
    "Bearing",
    "Actuator",
    "Cover",
    "Plate",
    "Spring",
    "Switch",
    "Cable",
    "Frame",
    "Panel",
    "Relay",
    "Clamp",
    "Socket",
    "Cooler",
    "Adapter",
]

MODELS = ["Model A", "Model B", "Model C", "Model D", "Model E", "Model F"]
MATERIAL_TYPES = ["ROH1", "ROH2", "HALB", "FERT"]
UNITS = ["EA", "SET", "PCS"]


def build_part_catalog(rng: random.Random, count: int = 150) -> list[dict[str, Any]]:
    """Build a deterministic catalog of generic synthetic parts."""
    suppliers = [
        {"code": f"SUP-{idx:03d}", "name": f"Supplier {idx:03d}"}
        for idx in range(1, 21)
    ]

    used_names: set[str] = set()
    catalog: list[dict[str, Any]] = []

    for idx in range(1, count + 1):
        while True:
            desc = f"{rng.choice(MODIFIERS)} {rng.choice(QUALIFIERS)} {rng.choice(NOUNS)}"
            if desc not in used_names:
                used_names.add(desc)
                break

        mat_type = rng.choices(MATERIAL_TYPES, weights=[0.42, 0.26, 0.20, 0.12], k=1)[0]
        supplier = rng.choice(suppliers)
        model = rng.choice(MODELS)
        pack_size = rng.choice([10, 12, 20, 24, 30, 40, 50, 60, 80, 100])
        base_turnover = round(rng.uniform(4.0, 68.0), 1)

        catalog.append(
            {
                "part_no": f"PART-{idx:04d}",
                "description": desc,
                "model": model,
                "material_type": mat_type,
                "supplier_code": supplier["code"],
                "supplier_name": supplier["name"],
                "pack_size": pack_size,
                "uom": rng.choices(UNITS, weights=[0.75, 0.15, 0.10], k=1)[0],
                "base_turnover_days": base_turnover,
            }
        )
    return catalog


def _generate_zone_racks(
    zone_name: str,
    prefix: str,
    rack_count: int,
    bays_per_rack: int,
    levels: int,
    origin_x: float,
    origin_z: float,
    rack_pitch_x: float,
    bay_pitch_z: float,
    max_boxes_per_level: int,
) -> list[dict[str, Any]]:
    """Create a regular synthetic grid of rack bays for one warehouse zone."""
    bays: list[dict[str, Any]] = []
    for r_idx in range(1, rack_count + 1):
        sep = "-" if len(prefix) > 1 else ""
        rack_id = f"{prefix}{sep}{r_idx:02d}"
        # Pair racks back-to-back with wide forklift aisles between pairs
        pair_idx = (r_idx - 1) // 2
        side_offset = -1.15 if (r_idx % 2 == 1) else 1.15
        if len(prefix) > 1:
            # Staging / Special lanes spaced evenly
            world_x = round(origin_x + (r_idx - 1) * rack_pitch_x, 2)
        else:
            world_x = round(origin_x + pair_idx * rack_pitch_x + side_offset, 2)

        for b_idx in range(1, bays_per_rack + 1):
            world_z = round(origin_z + (b_idx - 1) * bay_pitch_z, 2)
            bay_id = f"{rack_id}-{b_idx:02d}"
            bays.append(
                {
                    "bay_id": bay_id,
                    "rack_id": rack_id,
                    "bay_no": b_idx,
                    "zone": zone_name,
                    "world_x": world_x,
                    "world_z": world_z,
                    "bay_width": 2.0,
                    "bay_depth": 2.1,
                    "max_levels": levels,
                    "capacity_boxes": levels * max_boxes_per_level,
                    "max_boxes_per_level": max_boxes_per_level,
                }
            )
    return bays


def generate_facility_dataset(
    facility_key: str,
    facility_name: str,
    subtitle: str,
    zone_specs: list[dict[str, Any]],
    seed: int,
) -> dict[str, Any]:
    """Generate a complete synthetic warehouse dataset for one facility."""
    rng = random.Random(seed)
    catalog = build_part_catalog(rng, count=150)

    all_bays: list[dict[str, Any]] = []
    for spec in zone_specs:
        all_bays.extend(_generate_zone_racks(**spec))

    box_seq = 0
    lot_seq = 0

    populated_bays: list[dict[str, Any]] = []
    total_boxes = 0
    total_qty = 0

    for bay in all_bays:
        zone = bay["zone"]
        # Target occupancy probability varies slightly by synthetic zone
        occ_prob = {
            "Zone A": 0.84,
            "Zone B": 0.78,
            "Zone C": 0.72,
            "Staging": 0.65,
            "Special": 0.52,
        }.get(zone, 0.75)

        items: list[dict[str, Any]] = []
        max_levels = bay["max_levels"]
        max_per_lvl = bay["max_boxes_per_level"]

        # Pick 1-2 primary parts per bay for realistic put-away grouping
        bay_parts = rng.sample(catalog, k=2 if rng.random() < 0.45 else 1)

        for lvl in range(1, max_levels + 1):
            if rng.random() > occ_prob:
                continue

            boxes_in_level = rng.randint(1, max_per_lvl)
            part = rng.choice(bay_parts)

            # Sample synthetic age bucket: 70% <=30d, 20% 31-90d, 10% >90d
            bucket_roll = rng.random()
            if zone == "Special":
                age_days = rng.randint(45, 165)
            elif zone == "Staging":
                age_days = rng.randint(1, 14)
            elif bucket_roll < 0.70:
                age_days = rng.randint(1, 30)
            elif bucket_roll < 0.90:
                age_days = rng.randint(31, 90)
            else:
                age_days = rng.randint(91, 180)

            gr_date = (SNAPSHOT_DATE - dt.timedelta(days=age_days)).strftime("%Y-%m-%d")
            turnover_days = max(
                1.5,
                round(part["base_turnover_days"] * rng.uniform(0.65, 1.45), 1),
            )

            lot_seq += 1
            lot_no = f"SYN-LT-{lot_seq:04d}"

            for _ in range(boxes_in_level):
                box_seq += 1
                qty = part["pack_size"]
                if rng.random() < 0.12:
                    qty = max(2, int(part["pack_size"] * rng.uniform(0.4, 0.9)))

                items.append(
                    {
                        "box_id": f"SYN-BX-{box_seq:04d}",
                        "lot_no": lot_no,
                        "level": lvl,
                        "part_no": part["part_no"],
                        "description": part["description"],
                        "model": part["model"],
                        "material_type": part["material_type"],
                        "supplier_code": part["supplier_code"],
                        "supplier_name": part["supplier_name"],
                        "qty": qty,
                        "uom": part["uom"],
                        "gr_date": gr_date,
                        "age_days": age_days,
                        "turnover_days": turnover_days,
                    }
                )
                total_boxes += 1
                total_qty += qty

        box_count = len(items)
        capacity = bay["capacity_boxes"]
        occupancy_pct = round(min(100.0, (box_count / capacity) * 100.0), 1) if capacity else 0.0
        max_age = max((it["age_days"] for it in items), default=0)
        avg_turnover = (
            round(sum(it["turnover_days"] for it in items) / box_count, 1)
            if box_count
            else 0.0
        )
        dominant_mat = items[0]["material_type"] if items else "NONE"

        populated_bays.append(
            {
                **bay,
                "box_count": box_count,
                "total_qty": total_qty_for_bay(items),
                "occupancy_pct": occupancy_pct,
                "max_age_days": max_age,
                "avg_turnover_days": avg_turnover,
                "dominant_material_type": dominant_mat,
                "items": items,
            }
        )

    zones_summary: list[dict[str, Any]] = []
    seen_zones: list[str] = []
    for b in populated_bays:
        if b["zone"] not in seen_zones:
            seen_zones.append(b["zone"])

    for z_name in seen_zones:
        z_bays = [b for b in populated_bays if b["zone"] == z_name]
        xs = [b["world_x"] for b in z_bays]
        zs = [b["world_z"] for b in z_bays]
        zones_summary.append(
            {
                "zone": z_name,
                "min_x": round(min(xs) - 2.6, 2),
                "max_x": round(max(xs) + 2.6, 2),
                "min_z": round(min(zs) - 2.6, 2),
                "max_z": round(max(zs) + 2.6, 2),
                "bay_count": len(z_bays),
            }
        )

    return {
        "facility_key": facility_key,
        "facility_name": facility_name,
        "subtitle": subtitle,
        "snapshot_date": SNAPSHOT_DATE.isoformat(),
        "seed": seed,
        "summary": {
            "total_bays": len(populated_bays),
            "occupied_bays": sum(1 for b in populated_bays if b["box_count"] > 0),
            "total_boxes": total_boxes,
            "total_qty": total_qty,
        },
        "zones": zones_summary,
        "bays": populated_bays,
    }


def total_qty_for_bay(items: list[dict[str, Any]]) -> int:
    return sum(int(it["qty"]) for it in items)


def build_all_facilities(base_seed: int = DEFAULT_SEED) -> dict[str, dict[str, Any]]:
    """Build synthetic datasets for Facility North and Facility South."""
    north_specs = [
        {
            "zone_name": "Zone A",
            "prefix": "A",
            "rack_count": 8,
            "bays_per_rack": 10,
            "levels": 5,
            "origin_x": -34.0,
            "origin_z": -24.0,
            "rack_pitch_x": 8.0,
            "bay_pitch_z": 2.4,
            "max_boxes_per_level": 2,
        },
        {
            "zone_name": "Zone B",
            "prefix": "B",
            "rack_count": 8,
            "bays_per_rack": 10,
            "levels": 5,
            "origin_x": 8.0,
            "origin_z": -24.0,
            "rack_pitch_x": 8.0,
            "bay_pitch_z": 2.4,
            "max_boxes_per_level": 2,
        },
        {
            "zone_name": "Zone C",
            "prefix": "C",
            "rack_count": 6,
            "bays_per_rack": 8,
            "levels": 4,
            "origin_x": -34.0,
            "origin_z": 8.0,
            "rack_pitch_x": 8.0,
            "bay_pitch_z": 2.4,
            "max_boxes_per_level": 2,
        },
        {
            "zone_name": "Staging",
            "prefix": "STG",
            "rack_count": 4,
            "bays_per_rack": 6,
            "levels": 1,
            "origin_x": 8.0,
            "origin_z": 10.0,
            "rack_pitch_x": 5.2,
            "bay_pitch_z": 2.6,
            "max_boxes_per_level": 3,
        },
        {
            "zone_name": "Special",
            "prefix": "SPC",
            "rack_count": 2,
            "bays_per_rack": 6,
            "levels": 3,
            "origin_x": 30.0,
            "origin_z": 10.0,
            "rack_pitch_x": 5.5,
            "bay_pitch_z": 2.6,
            "max_boxes_per_level": 2,
        },
    ]

    south_specs = [
        {
            "zone_name": "Zone A",
            "prefix": "A",
            "rack_count": 6,
            "bays_per_rack": 12,
            "levels": 6,
            "origin_x": -28.0,
            "origin_z": -26.0,
            "rack_pitch_x": 8.5,
            "bay_pitch_z": 2.35,
            "max_boxes_per_level": 2,
        },
        {
            "zone_name": "Zone B",
            "prefix": "B",
            "rack_count": 6,
            "bays_per_rack": 12,
            "levels": 5,
            "origin_x": 6.0,
            "origin_z": -26.0,
            "rack_pitch_x": 8.5,
            "bay_pitch_z": 2.35,
            "max_boxes_per_level": 2,
        },
        {
            "zone_name": "Zone C",
            "prefix": "C",
            "rack_count": 4,
            "bays_per_rack": 8,
            "levels": 4,
            "origin_x": -28.0,
            "origin_z": 10.0,
            "rack_pitch_x": 8.5,
            "bay_pitch_z": 2.4,
            "max_boxes_per_level": 2,
        },
        {
            "zone_name": "Staging",
            "prefix": "STG",
            "rack_count": 5,
            "bays_per_rack": 6,
            "levels": 1,
            "origin_x": 2.0,
            "origin_z": 10.0,
            "rack_pitch_x": 5.0,
            "bay_pitch_z": 2.5,
            "max_boxes_per_level": 3,
        },
        {
            "zone_name": "Special",
            "prefix": "SPC",
            "rack_count": 2,
            "bays_per_rack": 6,
            "levels": 3,
            "origin_x": 28.0,
            "origin_z": 10.0,
            "rack_pitch_x": 5.5,
            "bay_pitch_z": 2.5,
            "max_boxes_per_level": 2,
        },
    ]

    return {
        "north": generate_facility_dataset(
            facility_key="north",
            facility_name="Facility North",
            subtitle="High-Bay Distribution Hub (Synthetic)",
            zone_specs=north_specs,
            seed=base_seed,
        ),
        "south": generate_facility_dataset(
            facility_key="south",
            facility_name="Facility South",
            subtitle="Cross-Dock & Component Center (Synthetic)",
            zone_specs=south_specs,
            seed=base_seed + 101,
        ),
    }


def write_demo_js_bundles(output_dir: Path, base_seed: int = DEFAULT_SEED) -> list[Path]:
    """Write compact JS bundles into demo/data/ so index.html works offline or over HTTP."""
    output_dir.mkdir(parents=True, exist_ok=True)
    datasets = build_all_facilities(base_seed=base_seed)
    written: list[Path] = []

    for key, payload in datasets.items():
        target = output_dir / f"facility_{key}.js"
        compact_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
        js_source = (
            "window.DEMO_FACILITIES = window.DEMO_FACILITIES || {};\n"
            f'window.DEMO_FACILITIES["{key}"] = {compact_json};\n'
        )
        target.write_text(js_source, encoding="utf-8")
        written.append(target)

    return written


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate deterministic synthetic warehouse datasets for the 3D demo."
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help=f"Deterministic random seed (default: {DEFAULT_SEED})",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "demo" / "data",
        help="Target output directory for generated JS data bundles",
    )
    args = parser.parse_args()

    files = write_demo_js_bundles(output_dir=args.out_dir, base_seed=args.seed)
    for fpath in files:
        size_kb = fpath.stat().st_size / 1024.0
        print(f"Generated {fpath.name} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()

