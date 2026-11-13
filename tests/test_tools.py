"""Tests for tools/generate_fake_data.py and tools/build_from_exports.py (stdlib only).

Run:  python -m unittest discover -s tests
"""

from __future__ import annotations

import contextlib
import csv
import io
import json
import math
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))

import build_from_exports as bfe  # noqa: E402
import generate_fake_data as gen  # noqa: E402

DATA = gen.build_all(gen.DEFAULT_SEED)


class GeneratorTest(unittest.TestCase):
    def test_deterministic(self) -> None:
        again = gen.build_all(gen.DEFAULT_SEED)
        self.assertEqual(json.dumps(DATA, sort_keys=True), json.dumps(again, sort_keys=True))

    def test_layout_is_five_level_racks_at_plant_scale(self) -> None:
        positions = 0
        for fac in DATA["facilities"].values():
            rack = [b for b in fac["bays"] if b["in_capacity"]]
            self.assertGreater(len(rack), 300)
            five = sum(1 for b in rack if b["max_levels"] == 5)
            self.assertGreater(five / len(rack), 0.8, "mostly 5-level racks")
            positions += fac["summary"]["pallet_positions"]
        self.assertEqual(positions, DATA["planning"]["capacity_positions"])
        self.assertGreater(positions, 3000)

    def test_start_occupancy_is_686_percent_per_facility(self) -> None:
        for fac in DATA["facilities"].values():
            s = fac["summary"]
            self.assertEqual(s["occupied_positions"], round(s["pallet_positions"] * gen.START_OCCUPANCY))
            for bay in fac["bays"]:
                levels = [(it["level"], it["slot"]) for it in bay["items"]]
                self.assertEqual(len(levels), len(set(levels)), f"{bay['bay_id']}: one pallet per position")
                self.assertLessEqual(len(levels), bay["capacity_boxes"])

    def test_planning_is_consistent(self) -> None:
        p = DATA["planning"]
        parts = {x["part_no"] for x in p["parts"]}
        subs = {x["part_no"] for x in p["sub_assemblies"]}
        fgs = {m["fg_part"] for m in p["models"]}
        self.assertEqual(len(p["weeks"]), gen.HORIZON_WEEKS)
        self.assertEqual(set(p["oms"]), parts)
        self.assertEqual(set(p["forecast"]), fgs)
        for b in p["bom"]:
            self.assertIn(b["parent"], subs | fgs)
            self.assertIn(b["child"], parts | subs)
        used = {b["child"] for b in p["bom"]}
        self.assertTrue(parts <= used, "every purchased part is consumed by some BOM")
        for x in p["parts"]:
            self.assertGreater(x["pallet_qty"], 0)

    def test_calendar_has_short_christmas_week_and_shutdown(self) -> None:
        weeks = {w["label"]: w for w in DATA["planning"]["weeks"]}
        self.assertEqual(weeks["W52"]["prod_days"], [1, 2, 3])
        self.assertEqual(weeks["W53"]["prod_days"], [])
        self.assertEqual(weeks["W53"]["recv_days"], [])
        for label, series in DATA["planning"]["oms"].items():
            self.assertEqual(series[[w["label"] for w in DATA["planning"]["weeks"]].index("W53")], 0, label)

    def test_only_synthetic_identifiers(self) -> None:
        text = json.dumps(DATA)
        for part in DATA["planning"]["parts"]:
            self.assertRegex(part["part_no"], r"^PART-\d{4}$")
            self.assertRegex(part["supplier_name"], r"^Supplier \d{3}$")
        for fac in DATA["facilities"].values():
            for bay in fac["bays"]:
                self.assertRegex(bay["bay_id"], r"^[NS](\d{2}-\d{2}|-STG-\d{2}|-QH-\d{2})$")
        self.assertNotIn("http", text)


def export_synthetic_csvs(folder: Path) -> int:
    """Write the synthetic demo as the CSV exports build_from_exports.py reads; returns the stock pallets."""
    p = DATA["planning"]
    weeks = p["weeks"]

    def write(name: str, header: list[str], rows: list[list[object]]) -> None:
        with (folder / name).open("w", encoding="utf-8-sig", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(header)
            w.writerows(rows)

    write("parts.csv", ["Part_No", "Description", "Pallet_Qty", "Material_Type", "Delivery_Days"],
          [[x["part_no"], x["description"], x["pallet_qty"], x["material_type"],
            " ".join(map(str, x["delivery_days"]))] for x in p["parts"]])
    write("bom.csv", ["parent", "child", "qty"], [[b["parent"], b["child"], b["qty"]] for b in p["bom"]])
    write("forecast.csv", ["parent", "week", "qty"],
          [[fg, f"{w['iso_year']}-W{w['iso_week']:02d}", s[w["index"]]] for fg, s in p["forecast"].items()
           for w in weeks if s[w["index"]]])
    write("oms.csv", ["part_no", "week", "qty"],
          [[part, w["start"], s[w["index"]]] for part, s in p["oms"].items() for w in weeks if s[w["index"]]])
    write("calendar.csv", ["week", "prod_days", "recv_days"],
          [[w["start"], " ".join(map(str, w["prod_days"])), " ".join(map(str, w["recv_days"]))] for w in weeks])
    rows = []
    for fac in DATA["facilities"].values():
        for bay in fac["bays"]:
            if not bay["in_capacity"]:
                continue
            for it in bay["items"]:
                rows.append([it["part_no"], it["qty"], 1, it["gr_date"]])
    write("stock.csv", ["part_no", "qty", "pallets", "gr_date"], rows)
    return len(rows)


class BuildFromExportsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="wh_exports_"))
        self.in_dir = self.tmp / "in"
        self.out_dir = self.tmp / "out"
        self.in_dir.mkdir()
        self.n_pallets = export_synthetic_csvs(self.in_dir)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_round_trip_rebuilds_the_same_plan(self) -> None:
        data = bfe.build(self.in_dir, 16, None, 7)
        plan = data["planning"]
        self.assertEqual(plan["weeks"][0]["start"], DATA["planning"]["weeks"][0]["start"])
        self.assertEqual([w["prod_days"] for w in plan["weeks"]], [w["prod_days"] for w in DATA["planning"]["weeks"]])
        self.assertEqual(plan["oms"], DATA["planning"]["oms"])
        self.assertEqual({k: [int(v) for v in s] for k, s in plan["forecast"].items()}, DATA["planning"]["forecast"])
        self.assertEqual(plan["capacity_positions"], DATA["planning"]["capacity_positions"])
        self.assertEqual(data["report"]["pallets"], self.n_pallets)
        self.assertEqual(data["report"]["warnings"], [])
        self.assertAlmostEqual(data["report"]["occupancy_pct"], 68.6, places=1)
        held = sum(1 for f in data["facilities"].values() for b in f["bays"] for it in b["items"] if not it["simulated"])
        self.assertGreater(held, 0, "sub-assembly / finished-goods pallets are held")

    def test_writes_bundles_and_manifest(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            rc = bfe.main(["--in-dir", str(self.in_dir), "--out-dir", str(self.out_dir)])
        self.assertEqual(rc, 0)
        names = sorted(p.name for p in self.out_dir.iterdir())
        self.assertEqual(names, ["facility_north.js", "facility_south.js", "manifest.js", "planning.js"])
        manifest = (self.out_dir / "manifest.js").read_text(encoding="utf-8")
        self.assertIn('window.DEMO_DATA_MODE = "local"', manifest)

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_engine_runs_on_the_local_bundles(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            bfe.main(["--in-dir", str(self.in_dir), "--out-dir", str(self.out_dir)])
        script = (
            "const vm=require('vm'),fs=require('fs'),path=require('path');"
            "const E=require(process.argv[1]);const ctx={window:{}};vm.createContext(ctx);"
            "for(const f of fs.readdirSync(process.argv[2]))vm.runInContext(fs.readFileSync(path.join(process.argv[2],f),'utf8'),ctx);"
            "const r=E.simulate({facilities:ctx.window.DEMO_FACILITIES,planning:ctx.window.DEMO_PLANNING});"
            "console.log(JSON.stringify({start:r.start.pct,worst:r.summary.worstWeek,weeks:r.weeks.length}));"
        )
        out = subprocess.run(["node", "-e", script, str(REPO / "demo" / "sim_engine.js"), str(self.out_dir)],
                             capture_output=True, text=True, check=True)
        res = json.loads(out.stdout)
        self.assertAlmostEqual(res["start"], 68.6, places=1)
        self.assertEqual(res["weeks"], 16)
        self.assertEqual(res["worst"], "W52")

    def test_reports_input_problems(self) -> None:
        (self.in_dir / "bom.csv").write_text("parent,child,qty\nA,B,1\nB,A,1\n", encoding="utf-8")
        with self.assertRaisesRegex(bfe.InputError, "loop"):
            bfe.build(self.in_dir, 16, None, 7)
        (self.in_dir / "parts.csv").write_text("part_no,description\nP,x\n", encoding="utf-8")
        with self.assertRaisesRegex(bfe.InputError, "pallet_qty"):
            bfe.build(self.in_dir, 16, None, 7)

    def test_week_parsing(self) -> None:
        self.assertEqual(bfe.week_monday("2026-W47", "t").isoformat(), "2026-11-16")
        self.assertEqual(bfe.week_monday("2026-11-19", "t").isoformat(), "2026-11-16")
        self.assertEqual(bfe.week_monday("2026/11/22", "t").isoformat(), "2026-11-16")
        with self.assertRaises(bfe.InputError):
            bfe.week_monday("next week", "t")
        self.assertEqual(bfe.weekdays("1 3 5"), [1, 3, 5])
        self.assertEqual(bfe.weekdays(""), [])
        self.assertEqual(math.ceil(250 / 100), 3)


if __name__ == "__main__":
    unittest.main()
