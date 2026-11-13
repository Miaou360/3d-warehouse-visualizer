#!/usr/bin/env python3
"""Deterministic synthetic warehouse + planning data generator for the 3D Warehouse Visualizer demo.

Everything here is generated from a fixed PRNG seed and reads zero external files:

* two facilities of 5-level pallet racks at a realistic plant scale (~3,800 pallet positions in total),
  a small floor staging area and a quality-hold rack per facility;
* a material (raw-material) warehouse: every pallet is a purchased part of type ROH1, ROH2 or ROH3;
* one pallet per rack position, 68.6 % of the rack positions occupied at the snapshot, with fast, moderate,
  slow and dormant parts mixed over all racks (free location), so stock age runs from days to well over a year;
* the planning data for the weekly space simulation (demo/sim_engine.js): part master with pallet
  quantities, a multi-level BOM, a weekly customer forecast per finished-goods model and the weekly
  inbound quantities of an order management system (OMS) for every purchased part.

Rack names, part numbers, suppliers, models and quantities are invented - no real facility floorplan or
operational record is used.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import random
from pathlib import Path
from typing import Any

DEFAULT_SEED = 20261102
SNAPSHOT_DATE = dt.date(2026, 11, 16)          # Monday of ISO week 47 = start of the simulation
HORIZON_WEEKS = 16
START_OCCUPANCY = 0.686                        # share of rack pallet positions occupied at the snapshot

MODIFIERS = ["Upper", "Lower", "Front", "Rear", "Inner", "Outer", "Center", "Primary", "Auxiliary", "Compact",
             "Standard", "Linear", "Rotary", "Optical", "Thermal", "Digital"]
QUALIFIERS = ["Mounting", "Support", "Control", "Sensor", "Signal", "Drive", "Guide", "Filter", "Protective",
              "Flexible", "Precision", "Modular"]
NOUNS = ["Bracket", "Lens", "Housing", "Connector", "Assembly", "Module", "Gasket", "Bearing", "Actuator", "Cover",
         "Plate", "Spring", "Switch", "Cable", "Frame", "Panel", "Relay", "Clamp", "Socket", "Cooler", "Adapter"]

MODELS = ["Model A", "Model B", "Model C", "Model D", "Model E", "Model F"]
UNITS = ["EA", "SET", "PCS"]

# weekly finished-goods volume per model (units) before seasonality; Model F launches in the horizon
BASE_VOLUME = {"Model A": 620, "Model B": 490, "Model C": 730, "Model D": 340, "Model E": 250, "Model F": 0}
LAUNCH_MODEL, LAUNCH_WEEK_INDEX = "Model F", 11                       # ISO week 5 of 2027
LAUNCH_RAMP = [140, 290, 440, 570, 650]

# size classes of purchased parts: (name, share, pallet quantity choices, usage per parent choices)
SIZE_CLASSES = [
    ("bulky", 0.30, [48, 64, 80, 96, 120], [1, 1, 1, 2]),
    ("medium", 0.45, [240, 320, 400, 480, 600, 800], [1, 1, 2, 2, 4]),
    ("small", 0.25, [1600, 2000, 2400, 3200, 4000, 4800], [2, 4, 4, 6, 8]),
]
LAUNCH_PARTS = 12                              # the last purchased parts are new parts of the launch model
OMS_COVER_FACTOR = 1.0                         # OMS cover target vs. the snapshot cover of fast / moderate parts

# raw-material types of the material warehouse and their share of the purchased parts
MATERIAL_TYPES = (("ROH1", 0.46), ("ROH2", 0.33), ("ROH3", 0.21))

# Stock profile at the snapshot. As in most plants, a minority of high runners turns most of the pallets, while
# many low runners sit on stock: the parts that use the fewest pallets per day are the slow and dormant ones.
# (class, share of the rack pallets, cover range in days of the coming requirement, share of that cover the
#  pallets' receipts are spread over - dormant parts were last received months ago)
VELOCITY = (
    ("dormant", 0.13, 190.0, 640.0, 0.45),
    ("slow", 0.21, 42.0, 170.0, 0.6),
    ("moderate", 0.36, 17.0, 36.0, 1.0),
    ("fast", 0.30, 5.0, 14.0, 1.0),
)
SLOW_ORDER_COVER_WEEKS = 3.0                   # slow parts: reorder point ~3 weeks, then full pallets
DORMANT_ORDER_COVER_WEEKS = 2.0                # planners do not reorder dormant parts within the horizon


# ----------------------------------------------------------------------------------------------- calendar
def build_weeks(start: dt.date = SNAPSHOT_DATE, count: int = HORIZON_WEEKS) -> list[dict[str, Any]]:
    """ISO weeks of the horizon with production and receiving weekdays (1 = Monday ... 7 = Sunday).
    Synthetic plant calendar: short Christmas week (Mon-Wed) and a shutdown week between the holidays."""
    weeks = []
    for i in range(count):
        monday = start + dt.timedelta(days=7 * i)
        sunday = monday + dt.timedelta(days=6)
        iso = monday.isocalendar()
        prod = recv = [1, 2, 3, 4, 5]
        if monday <= dt.date(monday.year, 12, 25) <= sunday:
            prod = recv = [1, 2, 3]
        elif monday.month == 12 and monday.day >= 26:                 # week between Christmas and New Year
            prod = recv = []
        weeks.append({
            "index": i, "label": f"W{iso[1]:02d}", "iso_year": iso[0], "iso_week": iso[1],
            "start": monday.isoformat(), "prod_days": list(prod), "recv_days": list(recv),
        })
    return weeks


# ----------------------------------------------------------------------------------------------- catalog / BOM
def material_type_for(u: float) -> str:
    """ROH1 / ROH2 / ROH3 from one uniform draw (MATERIAL_TYPES shares)."""
    acc = 0.0
    for name, share in MATERIAL_TYPES:
        acc += share
        if u < acc:
            return name
    return MATERIAL_TYPES[-1][0]


def build_part_catalog(rng: random.Random, count: int = 200) -> list[dict[str, Any]]:
    """Purchased parts (ROH1 / ROH2 / ROH3) with pallet quantity, supplier, delivery pattern and order policy."""
    suppliers = [{"code": f"SUP-{i:03d}", "name": f"Supplier {i:03d}"} for i in range(1, 25)]
    used: set[str] = set()
    parts = []
    for idx in range(1, count + 1):
        while True:
            desc = f"{rng.choice(MODIFIERS)} {rng.choice(QUALIFIERS)} {rng.choice(NOUNS)}"
            if desc not in used:
                used.add(desc)
                break
        roll, acc, size = rng.random(), 0.0, SIZE_CLASSES[-1]
        for cls in SIZE_CLASSES:
            acc += cls[1]
            if roll <= acc:
                size = cls
                break
        sup = rng.choice(suppliers)
        parts.append({
            "part_no": f"PART-{idx:04d}",
            "description": desc,
            "material_type": material_type_for(rng.random()),
            "supplier_code": sup["code"],
            "supplier_name": sup["name"],
            "size_class": size[0],
            "pallet_qty": rng.choice(size[2]),
            "usage_choices": size[3],
            "uom": rng.choices(UNITS, weights=[0.75, 0.15, 0.10], k=1)[0],
            "delivery_days": rng.choice([[1, 2, 3, 4, 5], [1, 3, 5], [2, 4], [1, 4], [2], [3], [5]]),
            "lead_time_weeks": rng.choice([1, 1, 2, 2, 3]),
            "order_policy": rng.choices(["weekly", "biweekly", "monthly"], weights=[0.6, 0.3, 0.1], k=1)[0],
            "cover_weeks": round(rng.uniform(1.6, 3.4), 2),
        })
    for p in parts[-LAUNCH_PARTS:]:
        p["launch_part"] = True
    return parts


def build_bom(rng: random.Random, parts: list[dict[str, Any]]
              ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Finished goods (one per model) -> sub-assemblies (HALB, partly shared) -> purchased parts, plus a few
    purchased parts used directly by the finished goods. The launch model uses only its own new parts."""
    fgs = [{"part_no": f"FG-{m[-1]}", "description": f"Finished Module {m[-1]}", "model": m} for m in MODELS]
    halbs = [{"part_no": f"SUB-{i:03d}", "description": f"Sub-Assembly {rng.choice(QUALIFIERS)} {i:03d}"}
             for i in range(1, 15)]
    model_halbs = {
        "Model A": ["SUB-001", "SUB-002", "SUB-003"], "Model B": ["SUB-003", "SUB-004", "SUB-005"],
        "Model C": ["SUB-006", "SUB-007", "SUB-008"], "Model D": ["SUB-008", "SUB-009", "SUB-010"],
        "Model E": ["SUB-011", "SUB-012"], "Model F": ["SUB-013", "SUB-014"],
    }
    launch_halbs = set(model_halbs[LAUNCH_MODEL])
    pool = [p for p in parts if not p.get("launch_part")]
    launch = [p for p in parts if p.get("launch_part")]
    rng.shuffle(pool)
    bom: list[dict[str, Any]] = []
    cursor = 0
    regular_halbs = [h for h in halbs if h["part_no"] not in launch_halbs]
    for h in regular_halbs:
        n = rng.randint(10, 15)
        chosen = pool[cursor:cursor + n]
        cursor += n
        if len(chosen) < n:                          # common parts shared once the pool is used up
            chosen += rng.sample(pool[:cursor], n - len(chosen))
        for p in chosen:
            bom.append({"parent": h["part_no"], "child": p["part_no"], "qty": rng.choice(p["usage_choices"])})
    for p in pool[cursor:]:                          # every purchased part is used somewhere
        h = rng.choice(regular_halbs)
        bom.append({"parent": h["part_no"], "child": p["part_no"], "qty": rng.choice(p["usage_choices"])})
    for i, p in enumerate(launch):
        bom.append({"parent": model_halbs[LAUNCH_MODEL][i % 2], "child": p["part_no"],
                    "qty": rng.choice(p["usage_choices"])})
    for fg in fgs:
        for h in model_halbs[fg["model"]]:
            bom.append({"parent": fg["part_no"], "child": h, "qty": 1})
        if fg["model"] != LAUNCH_MODEL:
            for p in rng.sample(pool, 3):
                bom.append({"parent": fg["part_no"], "child": p["part_no"], "qty": rng.choice(p["usage_choices"])})
    return fgs, halbs, bom


def build_forecast(rng: random.Random, weeks: list[dict[str, Any]]) -> dict[str, list[int]]:
    """Weekly customer forecast per finished-goods model (units)."""
    out: dict[str, list[int]] = {}
    for m in MODELS:
        series = []
        for w in weeks:
            share = len(w["prod_days"]) / 5.0
            if m == LAUNCH_MODEL:
                k = w["index"] - LAUNCH_WEEK_INDEX
                base = LAUNCH_RAMP[min(k, len(LAUNCH_RAMP) - 1)] if k >= 0 else 0
            else:
                base = BASE_VOLUME[m] * (1 + 0.004 * w["index"])
            series.append(int(round(base * share * rng.uniform(0.94, 1.06) / 10.0) * 10) if share else 0)
        out[f"FG-{m[-1]}"] = series
    return out


def explode(bom: list[dict[str, Any]], forecast: dict[str, list[int]], horizon: int) -> dict[str, list[float]]:
    """Weekly requirement of every leaf (purchased) part = forecast exploded through the multi-level BOM."""
    children: dict[str, list[tuple[str, float]]] = {}
    for b in bom:
        children.setdefault(b["parent"], []).append((b["child"], float(b["qty"])))
    req: dict[str, list[float]] = {}

    def walk(node: str, qty: list[float]) -> None:
        if node not in children:
            acc = req.setdefault(node, [0.0] * horizon)
            for i, q in enumerate(qty):
                acc[i] += q
            return
        for child, per in children[node]:
            walk(child, [q * per for q in qty])

    for fg, series in forecast.items():
        walk(fg, [float(x) for x in series])
    return req


# ----------------------------------------------------------------------------------------------- OMS (inbound)
def build_oms(rng: random.Random, parts: list[dict[str, Any]], req: dict[str, list[float]],
              weeks: list[dict[str, Any]], start_stock: dict[str, int], cover_scale: float = 1.0
              ) -> dict[str, list[int]]:
    """Weekly inbound quantity per purchased part as an order management system would show it: periodic
    order-up-to planning on the forecast requirement with a cover target and order multiples. Suppliers are
    closed in the shutdown week, so those deliveries arrive a week early (holiday build-ahead); the launch
    model's new parts are stocked two weeks before its first production week."""
    horizon = len(weeks)
    period = {"weekly": 1, "biweekly": 2, "monthly": 4}
    oms: dict[str, list[int]] = {}
    for p in parts:
        r = req.get(p["part_no"], [0.0] * horizon)
        nonzero = [x for x in r if x > 0]
        avg = sum(nonzero) / len(nonzero) if nonzero else 0.0
        step = p["pallet_qty"] if rng.random() < 0.5 else max(1, p["pallet_qty"] // rng.choice([4, 6, 8]))
        if p.get("velocity") in ("slow", "dormant"):    # low runners are bought in whole pallets
            step = p["pallet_qty"]
        per = period[p["order_policy"]]
        offset = rng.randrange(per)
        first_use = next((i for i, x in enumerate(r) if x > 0), horizon)
        on_hand = float(start_stock.get(p["part_no"], 0))
        arrivals = [0] * horizon
        for t in range(horizon):
            due = (t - offset) % per == 0 or (p.get("launch_part") and t == first_use - 2)
            if due and avg > 0 and t >= first_use - 2:
                look = max(per, 2 if p.get("launch_part") and t < first_use else per)
                ahead = 0.0
                if t + 2 < horizon and not weeks[t + 1]["recv_days"]:   # last delivery before the shutdown:
                    ahead = sum(r[t + 1:t + look + 1]) + 0.6 * r[t + look + 1]  # most of the restart week pre-built
                need = sum(r[t:t + look]) + ahead + OMS_COVER_FACTOR * p["cover_weeks"] * cover_scale * avg - on_hand
                if need > 0:
                    arrivals[t] = int(math.ceil(need / step) * step)
            on_hand += arrivals[t] - r[t]
        for t, w in enumerate(weeks):                # supplier shutdown: deliver one week earlier
            if not w["recv_days"] and arrivals[t] and t > 0:
                arrivals[t - 1] += arrivals[t]
                arrivals[t] = 0
        for t in range(horizon - 1, 0, -1):          # a little real-life noise: 8 % of deliveries slip a week
            if arrivals[t - 1] and weeks[t]["recv_days"] and rng.random() < 0.08:
                arrivals[t] += arrivals[t - 1]
                arrivals[t - 1] = 0
        oms[p["part_no"]] = arrivals
    return oms


# ----------------------------------------------------------------------------------------------- layout
def facility_specs() -> dict[str, dict[str, Any]]:
    """Rack lines per facility as (bays per line, levels); back-to-back pairs with forklift aisles between."""
    return {
        "north": {"name": "Facility North", "subtitle": "Material Warehouse (Synthetic, 5-Level Racks)",
                  "letter": "N", "lines": [(22, 5)] * 14 + [(20, 5)] * 2, "pair_pitch": 8.0, "bay_pitch": 2.4},
        "south": {"name": "Facility South", "subtitle": "Material Warehouse (Synthetic, 5-Level Racks)",
                  "letter": "S", "lines": [(24, 5)] * 13 + [(20, 5)] * 2 + [(24, 4)] * 3, "pair_pitch": 8.0,
                  "bay_pitch": 2.35},
    }


def build_layout(spec: dict[str, Any]) -> list[dict[str, Any]]:
    lines = spec["lines"]
    pairs = (len(lines) + 1) // 2
    x0 = -(pairs - 1) * spec["pair_pitch"] / 2.0
    max_bays = max(b for b, _ in lines)
    z0 = -(max_bays - 1) * spec["bay_pitch"] / 2.0 - 3.0
    half = len(lines) // 2
    bays = []
    for li, (n_bays, levels) in enumerate(lines, start=1):
        pair = (li - 1) // 2
        world_x = round(x0 + pair * spec["pair_pitch"] + (-1.15 if li % 2 == 1 else 1.15), 2)
        rack_id = f"{spec['letter']}{li:02d}"
        for b in range(1, n_bays + 1):
            bays.append({
                "bay_id": f"{rack_id}-{b:02d}", "rack_id": rack_id, "bay_no": b,
                "zone": "Zone A" if li <= half else "Zone B", "storage": "rack", "in_capacity": True,
                "world_x": world_x, "world_z": round(z0 + (b - 1) * spec["bay_pitch"], 2),
                "bay_width": 2.0, "bay_depth": 2.1, "max_levels": levels, "max_boxes_per_level": 1,
                "capacity_boxes": levels,
            })
    z_front = round(z0 + max_bays * spec["bay_pitch"] + 4.5, 2)
    for i in range(1, 9):              # dock-side floor staging lanes (not storage capacity)
        bays.append({
            "bay_id": f"{spec['letter']}-STG-{i:02d}", "rack_id": f"{spec['letter']}-STG", "bay_no": i,
            "zone": "Staging", "storage": "floor", "in_capacity": False,
            "world_x": round(x0 - 2.0 + (i - 1) * 2.6, 2), "world_z": z_front,
            "bay_width": 2.2, "bay_depth": 2.4, "max_levels": 1, "max_boxes_per_level": 3, "capacity_boxes": 3,
        })
    for i in range(1, 7):              # quality-hold rack (not storage capacity)
        bays.append({
            "bay_id": f"{spec['letter']}-QH-{i:02d}", "rack_id": f"{spec['letter']}-QH", "bay_no": i,
            "zone": "Special", "storage": "rack", "in_capacity": False,
            "world_x": round(-x0 - 10.0 + (i - 1) * 2.4, 2), "world_z": z_front,
            "bay_width": 2.0, "bay_depth": 2.1, "max_levels": 3, "max_boxes_per_level": 1, "capacity_boxes": 3,
        })
    return bays


# ----------------------------------------------------------------------------------------------- stock
def pallets_for(qty: int, pallet_qty: int) -> list[int]:
    """Full pallets plus one partial pallet."""
    full, rest = divmod(int(qty), int(pallet_qty))
    return [int(pallet_qty)] * full + ([rest] if rest else [])


def daily_use(req: dict[str, list[float]], part_no: str) -> float:
    """Average daily requirement of the first three weeks (pieces per calendar day)."""
    r = req.get(part_no, [0.0])[:3]
    return sum(r) / max(1, len(r)) / 7.0


def build_start_stock(rng: random.Random, parts: list[dict[str, Any]], req: dict[str, list[float]],
                      target_pallets: int) -> dict[str, dict[str, Any]]:
    """Snapshot stock per purchased part: velocity class, pieces on hand and cover days.

    Parts are ranked by the pallets they use per day; the lowest runners fill the dormant and slow shares of the
    pallets (VELOCITY), the rest are moderate and fast. Covers are drawn inside each class range and scaled
    together so the pallets (full pallets + one partial pallet per part) fill exactly target_pallets positions;
    the last few pallets are added to / taken from fast and moderate parts."""
    regular = [p for p in parts if not p.get("launch_part") and daily_use(req, p["part_no"]) > 0]
    use = {p["part_no"]: daily_use(req, p["part_no"]) for p in regular}

    def rate(p: dict[str, Any]) -> float:                        # pallets used per day
        return use[p["part_no"]] / p["pallet_qty"]

    ranked = sorted(regular, key=lambda p: (rate(p), p["part_no"]))
    profile: dict[str, dict[str, Any]] = {}
    i = 0
    for k, (cls, share, lo, hi, spread) in enumerate(VELOCITY):
        goal, got, last = share * target_pallets, 0.0, k == len(VELOCITY) - 1
        while i < len(ranked) and (last or got < goal):
            p = ranked[i]
            i += 1
            cover = lo * (hi / lo) ** rng.random() if hi / lo > 3 else rng.uniform(lo, hi)
            profile[p["part_no"]] = {"class": cls, "cover": cover, "spread": spread}
            got += rate(p) * cover + 0.5                         # + the partial pallet

    def pieces(p: dict[str, Any], scale: float) -> int:
        return int(round(use[p["part_no"]] * profile[p["part_no"]]["cover"] * scale))

    def count(scale: float) -> int:
        return sum(len(pallets_for(pieces(p, scale), p["pallet_qty"])) for p in regular if pieces(p, scale) > 0)

    lo_s, hi_s = 0.2, 5.0
    for _ in range(60):
        mid = (lo_s + hi_s) / 2
        if count(mid) < target_pallets:
            lo_s = mid
        else:
            hi_s = mid
    stock = {p["part_no"]: pieces(p, lo_s) for p in regular}
    n = count(lo_s)
    movers = [p for p in regular if profile[p["part_no"]]["class"] in ("fast", "moderate")]
    guard = 0
    while n != target_pallets and guard < 20000:                  # exact pallet count with whole pallets
        guard += 1
        p = rng.choice(movers)
        if n < target_pallets:
            stock[p["part_no"]] += p["pallet_qty"]
            n += 1
        elif stock[p["part_no"]] > p["pallet_qty"]:
            stock[p["part_no"]] -= p["pallet_qty"]
            n -= 1
    out = {}
    for p in regular:
        q = stock[p["part_no"]]
        if q > 0:
            prof = profile[p["part_no"]]
            out[p["part_no"]] = {"class": prof["class"], "qty": q, "spread": prof["spread"],
                                 "cover_days": q / use[p["part_no"]]}
    return out


# ----------------------------------------------------------------------------------------------- assemble
def build_all(base_seed: int = DEFAULT_SEED) -> dict[str, Any]:
    rng = random.Random(base_seed)
    weeks = build_weeks()
    parts = build_part_catalog(rng)
    fgs, halbs, bom = build_bom(rng, parts)
    forecast = build_forecast(rng, weeks)
    req = explode(bom, forecast, len(weeks))

    parents: dict[str, list[str]] = {}
    for b in bom:
        parents.setdefault(b["child"], []).append(b["parent"])

    def model_for(part_no: str) -> str:
        todo, seen = [part_no], set()
        while todo:
            n = todo.pop(0)
            if n.startswith("FG-"):
                return f"Model {n[-1]}"
            for par in parents.get(n, []):
                if par not in seen:
                    seen.add(par)
                    todo.append(par)
        return "Model A"

    model_of = {p["part_no"]: model_for(p["part_no"]) for p in parts}
    specs = facility_specs()
    layouts = {k: build_layout(s) for k, s in specs.items()}
    positions = {k: [(b, lvl) for b in bays if b["in_capacity"] for lvl in range(1, b["max_levels"] + 1)]
                 for k, bays in layouts.items()}
    occupied = {k: int(round(len(v) * START_OCCUPANCY)) for k, v in positions.items()}
    sim_n = sum(occupied.values())                       # material warehouse: every rack pallet is a purchased part
    srng = random.Random(base_seed + 7)                  # stock-profile draws, separate from the planning draws
    stock = build_start_stock(srng, parts, req, sim_n)
    order_cover = {"dormant": DORMANT_ORDER_COVER_WEEKS, "slow": SLOW_ORDER_COVER_WEEKS}
    for p in parts:              # OMS cover target: fast / moderate keep their snapshot cover, low runners reorder late
        s = stock.get(p["part_no"])
        if s:
            p["velocity"] = s["class"]
            p["cover_weeks"] = order_cover.get(s["class"], round(s["cover_days"] / 7, 2))
    oms = build_oms(rng, parts, req, weeks, {k: v["qty"] for k, v in stock.items()})

    sim_pallets: list[dict[str, Any]] = []
    for p in parts:
        s = stock.get(p["part_no"])
        if not s:
            continue
        pls = pallets_for(s["qty"], p["pallet_qty"])
        for i, qty in enumerate(pls):                                 # first pallet = oldest (FIFO); receipts
            age = int(round(s["cover_days"] * (1 - s["spread"] * i / len(pls)))) + srng.randint(0, 3)
            sim_pallets.append({"part": p, "qty": qty, "age": age, "turnover": s["cover_days"]})
    rng.shuffle(sim_pallets)                                          # free location: any position, all racks

    datasets: dict[str, Any] = {}
    box_seq = 0
    cursor = 0
    for k, spec in specs.items():
        pos = list(positions[k])
        rng.shuffle(pos)
        chosen = pos[:occupied[k]]
        n_sim = occupied[k]
        items_by_bay: dict[str, list[dict[str, Any]]] = {}

        def add(bay_id: str, level: int, slot: int, rec: dict[str, Any], qty: int, age: int, turn: float) -> None:
            nonlocal box_seq
            box_seq += 1
            items_by_bay.setdefault(bay_id, []).append({
                "box_id": f"PLT-{box_seq:05d}", "lot_no": f"SYN-LT-{box_seq:05d}", "level": level, "slot": slot,
                **rec, "qty": int(qty), "gr_date": (SNAPSHOT_DATE - dt.timedelta(days=age)).isoformat(),
                "age_days": int(age), "turnover_days": round(turn, 1),
            })

        def part_rec(p: dict[str, Any], simulated: bool) -> dict[str, Any]:
            return {"part_no": p["part_no"], "description": p["description"], "model": model_of[p["part_no"]],
                    "material_type": p["material_type"], "supplier_code": p["supplier_code"],
                    "supplier_name": p["supplier_name"], "uom": p["uom"], "simulated": simulated}

        for (bay, lvl), pl in zip(chosen, sim_pallets[cursor:cursor + n_sim]):
            add(bay["bay_id"], lvl, 0, part_rec(pl["part"], True), pl["qty"], pl["age"], pl["turnover"])
        cursor += n_sim
        for bay in layouts[k]:                    # staging: inbound pallets waiting for put-away
            if bay["zone"] == "Staging" and rng.random() < 0.65:
                for slot in range(rng.randint(1, 3)):
                    p = rng.choice([x for x in parts if not x.get("launch_part")])
                    add(bay["bay_id"], 1, slot, part_rec(p, False), p["pallet_qty"], 0, 1.5)

        bays_out = []
        for bay in layouts[k]:
            items = sorted(items_by_bay.get(bay["bay_id"], []), key=lambda it: (it["level"], it["slot"]))
            n = len(items)
            bays_out.append({
                **bay, "box_count": n, "total_qty": sum(it["qty"] for it in items),
                "occupancy_pct": round(100.0 * n / bay["capacity_boxes"], 1),
                "max_age_days": max((it["age_days"] for it in items), default=0),
                "avg_turnover_days": round(sum(it["turnover_days"] for it in items) / n, 1) if n else 0.0,
                "dominant_material_type": items[0]["material_type"] if items else "NONE",
                "items": items,
            })
        zones = []
        for z in ["Zone A", "Zone B", "Staging", "Special"]:
            zb = [b for b in bays_out if b["zone"] == z]
            if zb:
                xs, zs = [b["world_x"] for b in zb], [b["world_z"] for b in zb]
                zones.append({"zone": z, "min_x": round(min(xs) - 2.6, 2), "max_x": round(max(xs) + 2.6, 2),
                              "min_z": round(min(zs) - 2.6, 2), "max_z": round(max(zs) + 2.6, 2),
                              "bay_count": len(zb)})
        rack = [b for b in bays_out if b["in_capacity"]]
        datasets[k] = {
            "facility_key": k, "facility_name": spec["name"], "subtitle": spec["subtitle"],
            "snapshot_date": SNAPSHOT_DATE.isoformat(), "seed": base_seed,
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
    planning = {
        "snapshot_date": SNAPSHOT_DATE.isoformat(), "seed": base_seed, "start_occupancy_target": START_OCCUPANCY,
        "capacity_positions": sum(len(v) for v in positions.values()), "weeks": weeks,
        "models": [{"model": f["model"], "fg_part": f["part_no"], "description": f["description"]} for f in fgs],
        "sub_assemblies": halbs,
        "parts": [{k2: v for k2, v in p.items() if k2 != "usage_choices"} for p in parts],
        "bom": bom, "forecast": forecast, "oms": oms,
        "notes": {
            "inbound": "OMS weekly order quantity per part; pallets = ceil(qty / pallet_qty) per weekly delivery",
            "outbound": "forecast exploded through the BOM; a pallet position frees only when its pallet is empty",
            "calendar": "Christmas week Mon-Wed, shutdown week between the holidays (no production, no deliveries)",
            "launch": f"{LAUNCH_MODEL} starts in week index {LAUNCH_WEEK_INDEX}; its new parts arrive 2 weeks earlier",
            "stock": "material warehouse: purchased parts only (ROH1 / ROH2 / ROH3); fast, moderate, slow and "
                     "dormant parts mixed over all racks; dormant parts are not reordered within the horizon",
            "static": "floor staging pallets are held constant",
        },
    }
    return {"facilities": datasets, "planning": planning}


def build_all_facilities(base_seed: int = DEFAULT_SEED) -> dict[str, dict[str, Any]]:
    """Synthetic datasets for Facility North and Facility South (kept for the optional FastAPI backend)."""
    return build_all(base_seed)["facilities"]


def build_planning(base_seed: int = DEFAULT_SEED) -> dict[str, Any]:
    return build_all(base_seed)["planning"]


def write_demo_js_bundles(output_dir: Path, base_seed: int = DEFAULT_SEED) -> list[Path]:
    """Write compact JS bundles into demo/data/ so index.html works offline or over HTTP."""
    output_dir.mkdir(parents=True, exist_ok=True)
    data = build_all(base_seed)
    written: list[Path] = []
    for key, payload in data["facilities"].items():
        target = output_dir / f"facility_{key}.js"
        compact = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
        target.write_text("window.DEMO_FACILITIES = window.DEMO_FACILITIES || {};\n"
                          f'window.DEMO_FACILITIES["{key}"] = {compact};\n', encoding="utf-8")
        written.append(target)
    target = output_dir / "planning.js"
    compact = json.dumps(data["planning"], separators=(",", ":"), ensure_ascii=True)
    target.write_text(f"window.DEMO_PLANNING = {compact};\n", encoding="utf-8")
    written.append(target)
    names = [p.name for p in written]
    target = output_dir / "manifest.js"                # the data files index.html loads, in order
    target.write_text(f'window.DEMO_DATA_MODE = "synthetic";\nwindow.DEMO_DATA_FILES = {json.dumps(names)};\n',
                      encoding="utf-8")
    written.append(target)
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate deterministic synthetic warehouse and planning data.")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help=f"random seed (default: {DEFAULT_SEED})")
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).resolve().parent.parent / "demo" / "data",
                        help="target directory for the generated JS data bundles")
    args = parser.parse_args()
    for fpath in write_demo_js_bundles(output_dir=args.out_dir, base_seed=args.seed):
        print(f"Generated {fpath.name} ({fpath.stat().st_size / 1024.0:.1f} KB)")


if __name__ == "__main__":
    main()
