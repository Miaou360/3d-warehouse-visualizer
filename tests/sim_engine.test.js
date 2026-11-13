// Tests for demo/sim_engine.js (Node 18+, no dependencies):  node --test tests/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SimEngine = require("../demo/sim_engine.js");

const MON_FRI = [1, 2, 3, 4, 5];

/** A tiny one-facility world: `bays` racks of `levels` levels, a calendar of `weeks` normal weeks. */
function world({ bays = 1, levels = 5, weeks = 2, stock = [], parts, bom, forecast, oms, calendar } = {}) {
  const rackBays = [];
  for (let b = 1; b <= bays; b++) {
    rackBays.push({ bay_id: `T-${String(b).padStart(2, "0")}`, in_capacity: true, max_levels: levels,
      max_boxes_per_level: 1, items: [] });
  }
  // the test stock goes into the first positions, oldest first
  stock.forEach((s, i) => {
    const bay = rackBays[Math.floor(i / levels)];
    bay.items.push({ part_no: s.part, qty: s.qty, level: (i % levels) + 1, slot: 0, age_days: s.age || 10,
      gr_date: s.gr_date || `2026-11-${String(10 - Math.min(9, i)).padStart(2, "0")}`, simulated: s.simulated });
  });
  const cal = calendar || Array.from({ length: weeks }, () => ({ prod: MON_FRI, recv: MON_FRI }));
  const monday = new Date("2026-11-16T00:00:00Z");
  const planning = {
    snapshot_date: "2026-11-16",
    weeks: cal.map((c, i) => ({
      index: i, label: `W${47 + i}`, start: new Date(monday.getTime() + i * 7 * 86400000).toISOString().slice(0, 10),
      prod_days: c.prod, recv_days: c.recv,
    })),
    parts,
    bom,
    forecast,
    oms,
  };
  return { facilities: { t: { bays: rackBays } }, planning };
}

test("explodeBom multiplies through every BOM level", () => {
  const bom = [
    { parent: "FG-1", child: "SUB-1", qty: 2 },
    { parent: "SUB-1", child: "P-1", qty: 3 },
    { parent: "FG-1", child: "P-2", qty: 1 },
    { parent: "FG-2", child: "SUB-1", qty: 1 },
  ];
  const req = SimEngine.explodeBom(bom, { "FG-1": [10, 0], "FG-2": [5, 1] }, 2);
  assert.deepEqual(Array.from(req.get("P-1")), [10 * 2 * 3 + 5 * 3, 1 * 3]);
  assert.deepEqual(Array.from(req.get("P-2")), [10, 0]);
  assert.equal(req.has("SUB-1"), false, "sub-assemblies are not leaves");
});

test("explodeBom applies the forecast multiplier and rejects BOM loops", () => {
  const req = SimEngine.explodeBom([{ parent: "FG", child: "P", qty: 4 }], { FG: [10] }, 1, 0.5);
  assert.equal(req.get("P")[0], 20);
  assert.throws(() => SimEngine.explodeBom([{ parent: "A", child: "B", qty: 1 }, { parent: "B", child: "A", qty: 1 }],
    { A: [1] }, 1), /BOM loop/);
});

test("inbound pallets = ceil(OMS qty / pallet qty) per weekly delivery", () => {
  const w = world({
    bays: 4, weeks: 1,
    parts: [{ part_no: "P-1", pallet_qty: 100, delivery_days: [1] }, { part_no: "P-2", pallet_qty: 40, delivery_days: [2] }],
    bom: [], forecast: {},
    oms: { "P-1": [250], "P-2": [80] }, // 2 full + 1 partial, 2 full
  });
  const r = SimEngine.simulate(w);
  assert.equal(r.weeks[0].inboundPallets, 5);
  assert.equal(r.weeks[0].endPallets, 5);
  assert.equal(r.capacity, 20);
  assert.equal(r.weeks[0].endPct, 25);
});

test("a position frees only when its pallet is empty (FIFO, partial pallets keep their position)", () => {
  // 2 pallets of 100 in stock; consumption 150 over the week -> the oldest pallet empties, the second is half used
  const w = world({
    bays: 1, weeks: 1,
    stock: [{ part: "P-1", qty: 100, gr_date: "2026-11-01" }, { part: "P-1", qty: 100, gr_date: "2026-11-02" }],
    parts: [{ part_no: "P-1", pallet_qty: 100, delivery_days: [1] }],
    bom: [{ parent: "FG", child: "P-1", qty: 1 }], forecast: { FG: [150] }, oms: { "P-1": [0] },
  });
  const r = SimEngine.simulate(w);
  assert.equal(r.start.pallets, 2);
  assert.equal(r.weeks[0].freedPallets, 1);
  assert.equal(r.weeks[0].endPallets, 1, "the half-used pallet still takes a position");
  const snap = r.snapshots[0];
  const kept = Array.from(snap).filter((pid) => pid >= 0);
  assert.equal(kept.length, 1);
  assert.equal(r.pallets[kept[0]].initial, true);
  assert.equal(r.weeks[0].shortages.length, 0);
});

test("the mid-week peak is reported when deliveries arrive before production frees space", () => {
  // Monday: +4 pallets arrive; Monday-Friday: 4 old pallets are consumed (one position frees every 1.25 days)
  const stock = Array.from({ length: 4 }, (_, i) => ({ part: "P-1", qty: 10, gr_date: `2026-11-0${i + 1}` }));
  const w = world({
    bays: 2, weeks: 1, stock,
    parts: [{ part_no: "P-1", pallet_qty: 10, delivery_days: [1] }],
    bom: [{ parent: "FG", child: "P-1", qty: 1 }], forecast: { FG: [40] }, oms: { "P-1": [40] },
  });
  const r = SimEngine.simulate(w);
  const wk = r.weeks[0];
  assert.equal(wk.startPallets, 4);
  assert.equal(wk.peakPallets, 8, "Monday receipts land before Monday's consumption");
  assert.equal(wk.peakDay, 1);
  assert.equal(wk.endPallets, 4);
  assert.ok(wk.peakPct > wk.endPct);
});

test("front-loaded arrivals raise the peak compared with spread arrivals", () => {
  const stock = Array.from({ length: 6 }, (_, i) => ({ part: "P-1", qty: 10, gr_date: `2026-11-0${i + 1}` }));
  const base = {
    bays: 3, weeks: 1, stock,
    parts: [{ part_no: "P-1", pallet_qty: 10, delivery_days: [1, 3, 5] }],
    bom: [{ parent: "FG", child: "P-1", qty: 1 }], forecast: { FG: [60] }, oms: { "P-1": [60] },
  };
  const spread = SimEngine.simulate(world(base)).weeks[0].peakPallets;
  const front = SimEngine.simulate(world(base), { inboundTiming: "front" }).weeks[0].peakPallets;
  assert.ok(front > spread, `front ${front} should exceed spread ${spread}`);
});

test("pallets without a free position overflow and are put away once space frees", () => {
  const stock = Array.from({ length: 5 }, (_, i) => ({ part: "P-1", qty: 10, gr_date: `2026-11-0${i + 1}` }));
  const w = world({
    bays: 1, weeks: 2, stock, // 5 positions, all full
    parts: [{ part_no: "P-1", pallet_qty: 10, delivery_days: [1] }],
    bom: [{ parent: "FG", child: "P-1", qty: 1 }], forecast: { FG: [50, 0] }, oms: { "P-1": [30, 0] },
  });
  const r = SimEngine.simulate(w);
  const wk = r.weeks[0];
  assert.equal(wk.overflowMax, 3);
  assert.equal(wk.risk, "overflow");
  assert.ok(wk.peakPct > 100);
  assert.equal(wk.endPallets, 3, "five old pallets consumed, the three new ones moved into the racks");
  assert.equal(Array.from(r.snapshots[0]).filter((x) => x >= 0).length, 3);
});

test("extra floor positions add capacity", () => {
  const stock = Array.from({ length: 5 }, (_, i) => ({ part: "P-1", qty: 10, gr_date: `2026-11-0${i + 1}` }));
  const w = world({
    bays: 1, weeks: 1, stock,
    parts: [{ part_no: "P-1", pallet_qty: 10, delivery_days: [1] }],
    bom: [], forecast: {}, oms: { "P-1": [30] },
  });
  const r = SimEngine.simulate(w, { extraPositions: 5 });
  assert.equal(r.capacity, 10);
  assert.equal(r.weeks[0].overflowMax, 0);
  assert.equal(r.weeks[0].endPallets, 8);
});

test("deliveries shifted into a week without receiving days arrive the week before", () => {
  const weeks = [{ recv_days: [1] }, { recv_days: [] }, { recv_days: [1] }];
  const out = SimEngine.shiftedOms({ P: [5, 0, 7] }, weeks, 1);
  assert.deepEqual(out.P, [5, 0, 0], "week 0 -> week 1 has no receiving -> stays in week 0; week 2 -> beyond horizon");
  const early = SimEngine.shiftedOms({ P: [0, 0, 7] }, weeks, -1);
  assert.deepEqual(early.P, [7, 0, 0]);
});

test("a shutdown week has no production and no receipts", () => {
  const stock = [{ part: "P-1", qty: 10 }];
  const w = world({
    bays: 1, stock,
    calendar: [{ prod: [], recv: [] }],
    parts: [{ part_no: "P-1", pallet_qty: 10, delivery_days: [1] }],
    bom: [{ parent: "FG", child: "P-1", qty: 1 }], forecast: { FG: [10] }, oms: { "P-1": [10] },
  });
  const wk = SimEngine.simulate(w).weeks[0];
  assert.equal(wk.inboundPallets, 0);
  assert.equal(wk.freedPallets, 0);
  assert.equal(wk.prodDays, 0);
});

test("held pallets (sub-assemblies, finished goods) keep their positions", () => {
  const w = world({
    bays: 1, weeks: 1,
    stock: [{ part: "FG", qty: 12, simulated: false }, { part: "P-1", qty: 10 }],
    parts: [{ part_no: "P-1", pallet_qty: 10, delivery_days: [1] }],
    bom: [{ parent: "FG", child: "P-1", qty: 1 }], forecast: { FG: [10] }, oms: { "P-1": [0] },
  });
  const r = SimEngine.simulate(w);
  assert.equal(r.weeks[0].endPallets, 1);
  const pid = Array.from(r.snapshots[0]).find((x) => x >= 0);
  assert.equal(r.pallets[pid].sim, false);
});

test("shortages are reported when demand exceeds stock plus receipts", () => {
  const w = world({
    bays: 1, weeks: 1, stock: [{ part: "P-1", qty: 10 }],
    parts: [{ part_no: "P-1", pallet_qty: 10, delivery_days: [1] }],
    bom: [{ parent: "FG", child: "P-1", qty: 1 }], forecast: { FG: [25] }, oms: { "P-1": [0] },
  });
  const wk = SimEngine.simulate(w).weeks[0];
  assert.deepEqual(wk.shortages, [{ part: "P-1", qty: 15 }]);
});

// ------------------------------------------------------------------ the bundled synthetic demo data
function loadDemo() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  ["facility_north.js", "facility_south.js", "planning.js"].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "demo", "data", f), "utf8"), ctx);
  });
  return { facilities: ctx.window.DEMO_FACILITIES, planning: ctx.window.DEMO_PLANNING };
}

test("synthetic demo: 68.6 % occupied at the snapshot, 16 weeks, Christmas peak is the worst week", () => {
  const data = loadDemo();
  const r = SimEngine.simulate(data);
  assert.equal(r.weeks.length, 16);
  assert.equal(r.capacity, data.planning.capacity_positions);
  assert.ok(Math.abs(r.start.pct - 68.6) < 0.05, `start ${r.start.pct}`);
  assert.equal(r.summary.worstWeek, "W52");
  assert.equal(r.weeks.find((w) => w.label === "W52").risk, "critical");
  assert.equal(r.weeks.find((w) => w.label === "W53").inboundPallets, 0, "shutdown week");
  assert.ok(r.weeks.every((w) => w.overflowMax === 0), "the baseline plan fits the racks");
  r.weeks.forEach((w) => {
    assert.ok(w.peakPallets >= Math.max(w.startPallets, w.endPallets), `${w.label} peak below start/end`);
  });
});

test("synthetic demo: deterministic and stress scenarios move in the expected direction", () => {
  const data = loadDemo();
  const a = SimEngine.simulate(data);
  const b = SimEngine.simulate(data);
  assert.deepEqual(a.weeks.map((w) => w.peakPallets), b.weeks.map((w) => w.peakPallets));
  const low = SimEngine.simulate(data, { forecastMultiplier: 0.8 });
  const worst = (r) => Math.max(...r.weeks.map((w) => w.peakPct));
  assert.ok(worst(low) > worst(a), "less consumption with unchanged orders fills the warehouse");
  const roomy = SimEngine.simulate(data, { extraPositions: 200 });
  assert.ok(worst(roomy) < worst(a));
});
