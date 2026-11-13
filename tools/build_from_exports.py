#!/usr/bin/env python3
"""Build the demo data bundles from your own CSV exports - for local use only.

The input folder (default ``data/real/``) and the output folder (``demo/data/local/``) are both git-ignored,
so real part numbers, quantities and layouts never reach the repository. Open the result with
``demo/index.html?data=local``.

Input files (UTF-8 or UTF-8 with BOM, header row, column names case-insensitive):

  parts.csv     part_no, description, pallet_qty
                [, material_type, supplier_code, supplier_name, uom, delivery_days, model]
                purchased parts (the ones the OMS orders and the BOM consumes)
  bom.csv       parent, child, qty                     multi-level; finished goods at the top
  forecast.csv  parent, week, qty                      customer forecast per finished good
  oms.csv       part_no, week, qty                     weekly order / delivery quantity per purchased part
  stock.csv     part_no, qty [, pallets, gr_date, description, material_type]
                one row per pallet, or one row per part with the number of pallets in ``pallets``;
                rows of parts that are not in parts.csv keep their positions for the whole horizon
                (material_type from the row, else shown as "other")
  calendar.csv  week, prod_days, recv_days             optional; weekdays 1-7 (``1 2 3 4 5``), empty = closed
  layout.csv    facility, bay_id, x, z, levels [, rack_id, positions_per_level, zone, in_capacity, name]
                optional; without it the synthetic 5-level rack layout of the demo is used

``week`` is an ISO week (``2026-W47``) or any date inside the week (``2026-11-18``).
Delivery days are weekday numbers separated by spaces, commas or ``/`` (``1 3 5``).
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import random
import re
import sys
from pathlib import Path
from typing import Any, Iterable

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from generate_fake_data import build_layout, facility_specs, pallets_for  # noqa: E402

DEFAULT_IN = REPO_ROOT / "data" / "real"
DEFAULT_OUT = REPO_ROOT / "demo" / "data" / "local"
MON_FRI = [1, 2, 3, 4, 5]
NO_DEMAND_COVER = 999.0          # turnover (cover days) shown for stock without requirement in the horizon


class InputError(ValueError):
    """A problem in the input files, reported without a traceback."""


# ----------------------------------------------------------------------------------------------- reading
def read_csv(path: Path, required: Iterable[str], optional: bool = False) -> list[dict[str, str]]:
    if not path.exists():
        if optional:
            return []
        raise InputError(f"missing input file: {path.name}")
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            raise InputError(f"{path.name}: empty file")
        names = {n: (n or "").strip().lower() for n in reader.fieldnames}
        rows = [{names[k]: (v or "").strip() for k, v in row.items() if k is not None} for row in reader]
    missing = [c for c in required if c not in names.values()]
    if missing:
        raise InputError(f"{path.name}: missing column(s) {', '.join(missing)}")
    return [r for r in rows if any(r.values())]


def number(value: str, where: str) -> float:
    try:
        return float(value.replace(",", "")) if value else 0.0
    except ValueError as exc:
        raise InputError(f"{where}: '{value}' is not a number") from exc


def weekdays(value: str) -> list[int]:
    return sorted({int(d) for d in re.findall(r"[1-7]", value or "")})


def week_monday(value: str, where: str) -> dt.date:
    m = re.fullmatch(r"(\d{4})-?W(\d{1,2})", value.strip(), flags=re.IGNORECASE)
    try:
        if m:
            return dt.date.fromisocalendar(int(m.group(1)), int(m.group(2)), 1)
        day = dt.date.fromisoformat(value.strip().replace("/", "-")[:10])
    except ValueError as exc:
        raise InputError(f"{where}: '{value}' is not an ISO week (2026-W47) or a date (2026-11-18)") from exc
    return day - dt.timedelta(days=day.weekday())


# ----------------------------------------------------------------------------------------------- building
def build_weeks(start: dt.date, count: int, calendar: dict[dt.date, tuple[list[int], list[int]]]
                ) -> list[dict[str, Any]]:
    weeks = []
    for i in range(count):
        monday = start + dt.timedelta(days=7 * i)
        prod, recv = calendar.get(monday, (MON_FRI, MON_FRI))
        iso = monday.isocalendar()
        weeks.append({"index": i, "label": f"W{iso[1]:02d}", "iso_year": iso[0], "iso_week": iso[1],
                      "start": monday.isoformat(), "prod_days": list(prod), "recv_days": list(recv)})
    return weeks


def weekly_series(rows: list[dict[str, str]], key: str, file: str, start: dt.date, count: int
                  ) -> tuple[dict[str, list[float]], int]:
    """Sum quantities per key and horizon week; returns the series and the number of rows outside it."""
    out: dict[str, list[float]] = {}
    outside = 0
    for n, r in enumerate(rows, start=2):
        idx = (week_monday(r["week"], f"{file} line {n}") - start).days // 7
        qty = number(r["qty"], f"{file} line {n}")
        if not 0 <= idx < count:
            outside += 1
            continue
        out.setdefault(r[key], [0.0] * count)[idx] += qty
    return out, outside


def check_bom(bom: list[dict[str, Any]]) -> None:
    children: dict[str, list[str]] = {}
    for b in bom:
        children.setdefault(b["parent"], []).append(b["child"])
    state: dict[str, int] = {}

    def visit(node: str, trail: list[str]) -> None:
        if state.get(node) == 2:
            return
        if state.get(node) == 1:
            raise InputError(f"bom.csv: loop {' -> '.join(trail + [node])}")
        state[node] = 1
        for c in children.get(node, []):
            visit(c, trail + [node])
        state[node] = 2

    for parent in list(children):
        visit(parent, [])


def custom_layout(rows: list[dict[str, str]]) -> dict[str, dict[str, Any]]:
    facilities: dict[str, dict[str, Any]] = {}
    for n, r in enumerate(rows, start=2):
        where = f"layout.csv line {n}"
        key = re.sub(r"[^a-z0-9_]+", "_", r["facility"].lower()).strip("_") or "main"
        fac = facilities.setdefault(key, {"name": r.get("name") or r["facility"], "bays": []})
        levels = int(number(r["levels"], where))
        per = int(number(r.get("positions_per_level") or "1", where)) or 1
        in_cap = (r.get("in_capacity") or "1").lower() not in ("0", "false", "no", "n")
        fac["bays"].append({
            "bay_id": r["bay_id"], "rack_id": r.get("rack_id") or r["bay_id"].split("-")[0],
            "bay_no": len(fac["bays"]) + 1, "zone": r.get("zone") or "Zone A",
            "storage": "rack" if levels > 1 else "floor", "in_capacity": in_cap,
            "world_x": number(r["x"], where), "world_z": number(r["z"], where),
            "bay_width": 2.0, "bay_depth": 2.1, "max_levels": levels, "max_boxes_per_level": per,
            "capacity_boxes": levels * per,
        })
    return facilities


def build(in_dir: Path, weeks_n: int, start_arg: str | None, seed: int) -> dict[str, Any]:
    parts_rows = read_csv(in_dir / "parts.csv", ["part_no", "description", "pallet_qty"])
    bom_rows = read_csv(in_dir / "bom.csv", ["parent", "child", "qty"])
    fc_rows = read_csv(in_dir / "forecast.csv", ["parent", "week", "qty"])
    oms_rows = read_csv(in_dir / "oms.csv", ["part_no", "week", "qty"])
    stock_rows = read_csv(in_dir / "stock.csv", ["part_no", "qty"])
    cal_rows = read_csv(in_dir / "calendar.csv", ["week", "prod_days", "recv_days"], optional=True)
    layout_rows = read_csv(in_dir / "layout.csv", ["facility", "bay_id", "x", "z", "levels"], optional=True)

    parts: dict[str, dict[str, Any]] = {}
    for n, r in enumerate(parts_rows, start=2):
        pq = number(r["pallet_qty"], f"parts.csv line {n}")
        if pq <= 0:
            raise InputError(f"parts.csv line {n}: pallet_qty of {r['part_no']} must be > 0")
        parts[r["part_no"]] = {
            "part_no": r["part_no"], "description": r["description"], "pallet_qty": pq,
            "material_type": r.get("material_type") or "", "supplier_code": r.get("supplier_code") or "",
            "supplier_name": r.get("supplier_name") or "", "uom": r.get("uom") or "EA",
            "delivery_days": weekdays(r.get("delivery_days", "")) or None, "model": r.get("model") or "",
        }
    bom = [{"parent": r["parent"], "child": r["child"], "qty": number(r["qty"], "bom.csv")} for r in bom_rows]
    check_bom(bom)

    week_starts = [week_monday(r["week"], "forecast.csv") for r in fc_rows] + \
                  [week_monday(r["week"], "oms.csv") for r in oms_rows]
    if start_arg:
        start = week_monday(start_arg, "--start")
    elif week_starts:
        start = min(week_starts)
    else:
        raise InputError("forecast.csv and oms.csv have no rows")
    calendar = {week_monday(r["week"], "calendar.csv"): (weekdays(r["prod_days"]), weekdays(r["recv_days"]))
                for r in cal_rows}
    weeks = build_weeks(start, weeks_n, calendar)
    forecast, fc_out = weekly_series(fc_rows, "parent", "forecast.csv", start, weeks_n)
    oms, oms_out = weekly_series(oms_rows, "part_no", "oms.csv", start, weeks_n)
    unknown_oms = sorted(p for p in oms if p not in parts)
    for p in unknown_oms:
        oms.pop(p)
    oms_int = {p: [int(math.ceil(q)) for q in series] for p, series in oms.items()}

    # model of each part = top-level parent (finished good) unless parts.csv names one
    parents: dict[str, list[str]] = {}
    for b in bom:
        parents.setdefault(b["child"], []).append(b["parent"])

    def top_parent(part_no: str) -> str:
        node, seen = part_no, set()
        while parents.get(node) and node not in seen:
            seen.add(node)
            node = parents[node][0]
        return node

    # layout
    if layout_rows:
        layout = custom_layout(layout_rows)
        subtitle = "Local layout (layout.csv)"
    else:
        layout = {k: {"name": s["name"], "bays": build_layout(s)} for k, s in facility_specs().items()}
        subtitle = "Synthetic 5-level rack layout"
    positions = [(k, bay, lvl, slot) for k, f in layout.items() for bay in f["bays"] if bay["in_capacity"]
                 for lvl in range(1, bay["max_levels"] + 1) for slot in range(bay["max_boxes_per_level"])]

    # stock -> pallets; cover days per part from the average requirement of the first three weeks
    snapshot = start
    children: dict[str, list[tuple[str, float]]] = {}
    for b in bom:
        children.setdefault(b["parent"], []).append((b["child"], float(b["qty"])))
    req_week: dict[str, float] = {}
    for fg, series in forecast.items():
        stack = [(fg, sum(series[:3]) / max(1, min(3, len(series))))]
        while stack:
            node, qty = stack.pop()
            if node not in children:
                req_week[node] = req_week.get(node, 0.0) + qty
                continue
            stack.extend((child, qty * per) for child, per in children[node])
    stock_total: dict[str, float] = {}
    pallets: list[dict[str, Any]] = []
    for n, r in enumerate(stock_rows, start=2):
        where = f"stock.csv line {n}"
        qty = number(r["qty"], where)
        if qty <= 0:
            continue
        gr = dt.date.fromisoformat(r["gr_date"][:10]) if r.get("gr_date") else snapshot
        pinfo = parts.get(r["part_no"])
        count = int(number(r.get("pallets") or "0", where))
        if count > 0:
            base, rest = divmod(int(round(qty)), count)
            qtys = [base + (1 if i < rest else 0) for i in range(count)]
        elif pinfo:
            qtys = pallets_for(int(round(qty)), int(pinfo["pallet_qty"]))
        else:
            qtys = [int(round(qty))]
        stock_total[r["part_no"]] = stock_total.get(r["part_no"], 0.0) + qty
        for q in qtys:
            pallets.append({"row": r, "part": pinfo, "qty": q, "gr": gr})
    rng = random.Random(seed)
    rng.shuffle(positions)
    dropped = max(0, len(pallets) - len(positions))
    pallets.sort(key=lambda p: p["gr"])

    items_by_bay: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for seq, (pl, (fk, bay, lvl, slot)) in enumerate(zip(pallets, positions), start=1):
        p = pl["part"]
        r = pl["row"]
        weekly = req_week.get(r["part_no"], 0.0)
        cover = NO_DEMAND_COVER
        if weekly > 0:
            cover = min(NO_DEMAND_COVER, stock_total.get(r["part_no"], 0.0) / weekly * 7)
        items_by_bay.setdefault((fk, bay["bay_id"]), []).append({
            "box_id": f"PLT-{seq:05d}", "lot_no": "", "level": lvl, "slot": slot,
            "part_no": r["part_no"], "description": (p or {}).get("description") or r.get("description") or "",
            "model": (p or {}).get("model") or top_parent(r["part_no"]),
            "material_type": (p or {}).get("material_type") or r.get("material_type") or "",
            "supplier_code": (p or {}).get("supplier_code") or "", "supplier_name": (p or {}).get("supplier_name") or "",
            "uom": (p or {}).get("uom") or "EA", "simulated": p is not None, "qty": pl["qty"],
            "gr_date": pl["gr"].isoformat(), "age_days": max(0, (snapshot - pl["gr"]).days),
            "turnover_days": round(cover, 1),
        })

    facilities: dict[str, Any] = {}
    for fk, f in layout.items():
        bays_out = []
        for bay in f["bays"]:
            items = sorted(items_by_bay.get((fk, bay["bay_id"]), []), key=lambda it: (it["level"], it["slot"]))
            n = len(items)
            bays_out.append({
                **bay, "box_count": n, "total_qty": sum(it["qty"] for it in items),
                "occupancy_pct": round(100.0 * n / bay["capacity_boxes"], 1) if bay["capacity_boxes"] else 0.0,
                "max_age_days": max((it["age_days"] for it in items), default=0),
                "avg_turnover_days": round(sum(it["turnover_days"] for it in items) / n, 1) if n else 0.0,
                "dominant_material_type": items[0]["material_type"] if items else "NONE",
                "items": items,
            })
        zones = []
        for z in sorted({b["zone"] for b in bays_out}):
            zb = [b for b in bays_out if b["zone"] == z]
            xs, zs = [b["world_x"] for b in zb], [b["world_z"] for b in zb]
            zones.append({"zone": z, "min_x": round(min(xs) - 2.6, 2), "max_x": round(max(xs) + 2.6, 2),
                          "min_z": round(min(zs) - 2.6, 2), "max_z": round(max(zs) + 2.6, 2), "bay_count": len(zb)})
        rack = [b for b in bays_out if b["in_capacity"]]
        facilities[fk] = {
            "facility_key": fk, "facility_name": f["name"], "subtitle": subtitle,
            "snapshot_date": snapshot.isoformat(), "seed": seed,
            "summary": {
                "total_bays": len(bays_out), "rack_bays": len(rack),
                "pallet_positions": sum(b["capacity_boxes"] for b in rack),
                "occupied_positions": sum(b["box_count"] for b in rack),
                "occupied_bays": sum(1 for b in bays_out if b["box_count"] > 0),
                "total_boxes": sum(b["box_count"] for b in bays_out),
                "total_qty": sum(b["total_qty"] for b in bays_out),
            },
            "zones": zones, "bays": bays_out,
        }

    fgs = sorted(forecast)
    planning = {
        "snapshot_date": snapshot.isoformat(), "seed": seed, "source": "local exports",
        "capacity_positions": len(positions), "weeks": weeks,
        "models": [{"model": fg, "fg_part": fg, "description": fg} for fg in fgs],
        "sub_assemblies": [],
        "parts": [{k: v for k, v in p.items() if v is not None} for p in parts.values()],
        "bom": bom, "forecast": forecast, "oms": oms_int,
        "notes": {"inbound": "oms.csv weekly quantity per part; pallets = ceil(qty / pallet_qty)",
                  "outbound": "forecast.csv exploded through bom.csv; a position frees only when its pallet is empty"},
    }
    report = {
        "weeks": f"{weeks[0]['label']} ({weeks[0]['start']}) .. {weeks[-1]['label']}",
        "positions": len(positions), "pallets": len(pallets) - dropped,
        "occupancy_pct": round(100.0 * (len(pallets) - dropped) / len(positions), 1) if positions else 0.0,
        "parts": len(parts), "finished_goods": len(fgs),
        "warnings": [w for w in [
            f"{dropped} stock pallets did not fit into the layout and were left out" if dropped else "",
            f"{len(unknown_oms)} oms.csv part(s) not in parts.csv were skipped" if unknown_oms else "",
            f"{fc_out} forecast.csv row(s) outside the horizon" if fc_out else "",
            f"{oms_out} oms.csv row(s) outside the horizon" if oms_out else "",
        ] if w],
    }
    return {"facilities": facilities, "planning": planning, "report": report}


def write_bundles(data: dict[str, Any], out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    names = []
    for key, payload in data["facilities"].items():
        target = out_dir / f"facility_{key}.js"
        compact = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
        target.write_text("window.DEMO_FACILITIES = window.DEMO_FACILITIES || {};\n"
                          f"window.DEMO_FACILITIES[{json.dumps(key)}] = {compact};\n", encoding="utf-8")
        written.append(target)
        names.append(target.name)
    target = out_dir / "planning.js"
    target.write_text(f"window.DEMO_PLANNING = {json.dumps(data['planning'], separators=(',', ':'))};\n",
                      encoding="utf-8")
    written.append(target)
    names.append(target.name)
    manifest = out_dir / "manifest.js"
    manifest.write_text(f'window.DEMO_DATA_MODE = "local";\nwindow.DEMO_DATA_FILES = {json.dumps(names)};\n',
                        encoding="utf-8")
    written.append(manifest)
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--in-dir", type=Path, default=DEFAULT_IN, help=f"CSV folder (default: {DEFAULT_IN})")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT, help=f"output folder (default: {DEFAULT_OUT})")
    parser.add_argument("--weeks", type=int, default=16, help="simulation horizon in weeks (default 16)")
    parser.add_argument("--start", help="first simulated week (ISO week or date); default = earliest input week")
    parser.add_argument("--seed", type=int, default=20261102, help="seed of the free-location placement")
    args = parser.parse_args(argv)
    try:
        data = build(args.in_dir, args.weeks, args.start, args.seed)
    except InputError as exc:
        print(f"input error: {exc}", file=sys.stderr)
        return 2
    for path in write_bundles(data, args.out_dir):
        print(f"wrote {path} ({path.stat().st_size / 1024.0:.1f} KB)")
    rep = data["report"]
    print(f"horizon {rep['weeks']} | {rep['positions']} positions | {rep['pallets']} pallets "
          f"({rep['occupancy_pct']}%) | {rep['parts']} parts | {rep['finished_goods']} finished goods")
    for w in rep["warnings"]:
        print(f"warning: {w}")
    print("open demo/index.html?data=local (serve demo/ over http)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
