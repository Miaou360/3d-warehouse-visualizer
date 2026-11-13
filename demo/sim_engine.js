/* ==========================================================================
   3D Warehouse Visualizer (Demo) — Weekly Space Simulation Engine
   --------------------------------------------------------------------------
   Pure functions, no DOM: runs in the browser (window.SimEngine) and in Node (tests).

   Inbound   : OMS weekly quantity per part -> ceil(qty / pallet qty) pallets per weekly delivery
               (full pallets + one partial pallet), spread over the part's delivery days.
   Outbound  : weekly customer forecast per finished good -> multi-level BOM -> weekly requirement per
               purchased part, consumed evenly over the production days, first-in first-out.
   Space     : one pallet per rack position; a position frees only when its pallet is empty (a partial
               pallet still takes the whole position). Free location (whole warehouse = one pool).
   Results   : per week start / end / mid-week peak occupancy (pallets and %), inbound and freed pallets,
               overflow (pallets without a position), parts that would run short, top growing parts, and
               an end-of-week snapshot of which pallet sits in which position (for the 3D view).
   ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = {
    forecastMultiplier: 1.0, // scales the customer forecast (consumption); inbound (OMS) stays as planned
    inboundShiftWeeks: 0, // -1 = every delivery one week earlier, +1 = one week later
    inboundTiming: "spread", // "spread" over the delivery days | "front" = all on the first receiving day
    prodDaysPerWeek: null, // null = plant calendar; 6 = Mon-Sat in normal weeks
    extraPositions: 0, // temporary floor positions added to the rack capacity (used only when racks are full)
    warnPct: 85,
    critPct: 95,
    seed: 20261102,
  };

  // ------------------------------------------------------------------ helpers
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class MinHeap {
    constructor() {
      this.a = [];
    }
    get size() {
      return this.a.length;
    }
    push(v) {
      const a = this.a;
      a.push(v);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p] <= a[i]) break;
        [a[p], a[i]] = [a[i], a[p]];
        i = p;
      }
    }
    pop() {
      const a = this.a;
      if (a.length === 0) return undefined;
      const top = a[0];
      const last = a.pop();
      if (a.length > 0) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < a.length && a[l] < a[m]) m = l;
          if (r < a.length && a[r] < a[m]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]];
          i = m;
        }
      }
      return top;
    }
  }

  /** Weekly requirement of every leaf part: forecast (per finished good) exploded through the BOM. */
  function explodeBom(bom, forecast, horizon, multiplier) {
    const children = new Map();
    bom.forEach((b) => {
      if (!children.has(b.parent)) children.set(b.parent, []);
      children.get(b.parent).push([b.child, Number(b.qty)]);
    });
    const req = new Map();
    const walk = (node, qty, depth) => {
      if (depth > 20) throw new Error(`BOM loop at ${node}`);
      const kids = children.get(node);
      if (!kids) {
        if (!req.has(node)) req.set(node, new Float64Array(horizon));
        const acc = req.get(node);
        for (let i = 0; i < horizon; i++) acc[i] += qty[i];
        return;
      }
      kids.forEach(([child, per]) => walk(child, qty.map((q) => q * per), depth + 1));
    };
    Object.keys(forecast).forEach((fg) => {
      const series = forecast[fg].slice(0, horizon).map((x) => Number(x) * (multiplier == null ? 1 : multiplier));
      while (series.length < horizon) series.push(0);
      walk(fg, series, 0);
    });
    return req;
  }

  /** Pallet positions of the storage racks (bays with in_capacity) of all facilities. */
  function buildPositions(facilities, seed) {
    const positions = [];
    const keyIndex = new Map();
    Object.keys(facilities).forEach((fk) => {
      (facilities[fk].bays || []).forEach((bay) => {
        if (bay.in_capacity === false) return;
        const per = bay.max_boxes_per_level || 1;
        for (let lvl = 1; lvl <= bay.max_levels; lvl++) {
          for (let s = 0; s < per; s++) {
            const key = `${bay.bay_id}:${lvl}:${s}`;
            keyIndex.set(key, positions.length);
            positions.push({ key, facility: fk, bay_id: bay.bay_id, level: lvl, slot: s, virtual: false });
          }
        }
      });
    });
    // put-away order of free positions: a fixed pseudo-random order (free location)
    const rnd = mulberry32(seed || DEFAULTS.seed);
    const order = positions.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    order.forEach((posIdx, rank) => {
      positions[posIdx].rank = rank;
    });
    return { positions, keyIndex };
  }

  function dayOffset(isoDate, snapshot) {
    return Math.round((Date.parse(isoDate) - Date.parse(snapshot)) / 86400000);
  }

  /** Shift the OMS series; deliveries that land in a week without receiving days arrive the week before. */
  function shiftedOms(oms, weeks, shift) {
    const out = {};
    const h = weeks.length;
    Object.keys(oms).forEach((part) => {
      const arr = new Array(h).fill(0);
      oms[part].forEach((q, i) => {
        if (!q) return;
        let t = i + (shift || 0);
        if (t < 0) t = 0;
        if (t >= h) return; // beyond the horizon
        while (t > 0 && weeks[t].recv_days.length === 0) t -= 1;
        arr[t] += q;
      });
      out[part] = arr;
    });
    return out;
  }

  // ------------------------------------------------------------------ simulation
  function simulate(data, options) {
    const opt = Object.assign({}, DEFAULTS, options || {});
    const planning = data.planning;
    const weeks = planning.weeks;
    const horizon = weeks.length;
    const parts = new Map(planning.parts.map((p) => [p.part_no, p]));
    const req = explodeBom(planning.bom, planning.forecast, horizon, opt.forecastMultiplier);
    const oms = shiftedOms(planning.oms, weeks, opt.inboundShiftWeeks);
    const { positions, keyIndex } = buildPositions(data.facilities, opt.seed);
    const rackCount = positions.length;
    const extra = Math.max(0, Math.floor(opt.extraPositions || 0));
    for (let i = 0; i < extra; i++) {
      positions.push({ key: `TEMP:${i + 1}`, facility: "temp", bay_id: "TEMP", level: 0, slot: i, virtual: true,
        rank: rackCount + i });
    }
    const capacity = positions.length;

    // pallets: {id, part, qty, pos (-1 = overflow), arrival (day index), initial, sim}
    const pallets = [];
    const queues = new Map(); // part -> FIFO array of pallet ids (simulated parts only)
    const occupant = new Int32Array(capacity).fill(-1);
    const overflow = []; // FIFO of pallet ids waiting for a position
    let occupied = 0;

    const addToQueue = (pl) => {
      if (!queues.has(pl.part)) queues.set(pl.part, []);
      queues.get(pl.part).push(pl.id);
    };

    // initial stock from the facility snapshot (oldest goods-receipt first)
    const initial = [];
    Object.keys(data.facilities).forEach((fk) => {
      (data.facilities[fk].bays || []).forEach((bay) => {
        if (bay.in_capacity === false) return;
        (bay.items || []).forEach((it) => {
          const key = `${bay.bay_id}:${it.level}:${it.slot || 0}`;
          if (!keyIndex.has(key)) return;
          initial.push({ it, pos: keyIndex.get(key) });
        });
      });
    });
    initial.sort((a, b) => (a.it.gr_date < b.it.gr_date ? -1 : a.it.gr_date > b.it.gr_date ? 1 : a.pos - b.pos));
    initial.forEach(({ it, pos }) => {
      const sim = it.simulated !== false && parts.has(it.part_no);
      const pl = { id: pallets.length, part: it.part_no, qty: Number(it.qty), pos, arrival: -it.age_days || 0,
        initial: true, sim };
      pallets.push(pl);
      occupant[pos] = pl.id;
      occupied += 1;
      if (sim) addToQueue(pl);
    });
    const freeHeap = new MinHeap();
    const rankToPos = new Int32Array(capacity);
    positions.forEach((p, i) => {
      rankToPos[p.rank] = i;
      if (occupant[i] < 0) freeHeap.push(p.rank);
    });

    const place = (pl) => {
      if (freeHeap.size > 0) {
        const pos = rankToPos[freeHeap.pop()];
        pl.pos = pos;
        occupant[pos] = pl.id;
        occupied += 1;
      } else {
        pl.pos = -1;
        overflow.push(pl.id);
      }
    };
    const release = (pl) => {
      if (pl.pos >= 0) {
        occupant[pl.pos] = -1;
        freeHeap.push(positions[pl.pos].rank);
        occupied -= 1;
        pl.pos = -1;
      } else {
        const k = overflow.indexOf(pl.id);
        if (k >= 0) overflow.splice(k, 1);
      }
    };
    const putAwayOverflow = () => {
      while (overflow.length > 0 && freeHeap.size > 0) {
        const pl = pallets[overflow.shift()];
        place(pl);
      }
    };
    const palletCount = () => occupied + overflow.length;
    const partPallets = (part) => (queues.get(part) || []).length;

    const start = {
      pallets: palletCount(),
      pct: (100 * palletCount()) / capacity,
      rackPct: (100 * occupied) / rackCount,
    };

    const prodDaysOf = (w) => {
      if (w.prod_days.length === 0) return [];
      if (opt.prodDaysPerWeek === 6 && w.prod_days.length === 5) return [1, 2, 3, 4, 5, 6];
      return w.prod_days;
    };

    const snapshots = [];
    const results = [];
    for (let wi = 0; wi < horizon; wi++) {
      const w = weeks[wi];
      const weekStartDay = dayOffset(w.start, planning.snapshot_date);
      const startPallets = palletCount();
      const startByPart = new Map();
      queues.forEach((q, part) => startByPart.set(part, q.length));
      const recvDays = w.recv_days.length ? w.recv_days : [];
      const prodDays = prodDaysOf(w);

      // receipts of the week per day: part -> pallet quantities
      const receipts = new Map(); // day -> [{part, qty}]
      let inboundPallets = 0;
      planning.parts.forEach((p) => {
        const q = (oms[p.part_no] || [])[wi] || 0;
        if (!q || recvDays.length === 0) return;
        const full = Math.floor(q / p.pallet_qty);
        const rest = q - full * p.pallet_qty;
        const qtys = new Array(full).fill(p.pallet_qty);
        if (rest > 0) qtys.push(rest);
        inboundPallets += qtys.length;
        let days = (p.delivery_days || recvDays).filter((d) => recvDays.includes(d));
        if (days.length === 0) days = [recvDays[0]];
        if (opt.inboundTiming === "front") days = [recvDays[0]];
        qtys.forEach((qty, k) => {
          const d = days[k % days.length];
          if (!receipts.has(d)) receipts.set(d, []);
          receipts.get(d).push({ part: p.part_no, qty });
        });
      });

      let peak = startPallets;
      let peakDay = 0;
      let freed = 0;
      let maxOverflow = overflow.length;
      const shortages = new Map();
      for (let d = 1; d <= 7; d++) {
        (receipts.get(d) || []).forEach((r) => {
          const pl = { id: pallets.length, part: r.part, qty: r.qty, pos: -1, arrival: weekStartDay + d - 1,
            initial: false, sim: true };
          pallets.push(pl);
          addToQueue(pl);
          place(pl);
        });
        if (palletCount() > peak) {
          peak = palletCount();
          peakDay = d;
        }
        maxOverflow = Math.max(maxOverflow, overflow.length);
        if (prodDays.includes(d)) {
          req.forEach((series, part) => {
            if (!parts.has(part)) return;
            let need = series[wi] / prodDays.length;
            const q = queues.get(part) || [];
            while (need > 1e-9 && q.length > 0) {
              const pl = pallets[q[0]];
              const take = Math.min(pl.qty, need);
              pl.qty -= take;
              need -= take;
              if (pl.qty <= 1e-9) {
                q.shift();
                release(pl);
                freed += 1;
              }
            }
            if (need > 1e-6) shortages.set(part, (shortages.get(part) || 0) + need);
          });
          putAwayOverflow();
        }
      }
      const endPallets = palletCount();
      const growth = [];
      queues.forEach((q, part) => {
        const delta = q.length - (startByPart.get(part) || 0);
        if (delta > 0) growth.push({ part, delta, pallets: q.length });
      });
      growth.sort((a, b) => b.delta - a.delta || (a.part < b.part ? -1 : 1));
      const peakPct = (100 * peak) / capacity;
      const res = {
        index: wi,
        label: w.label,
        start: w.start,
        startDay: weekStartDay,
        startPallets,
        endPallets,
        peakPallets: peak,
        peakDay,
        startPct: (100 * startPallets) / capacity,
        endPct: (100 * endPallets) / capacity,
        peakPct,
        inboundPallets,
        freedPallets: freed,
        overflowMax: maxOverflow,
        prodDays: prodDays.length,
        recvDays: recvDays.length,
        shortages: Array.from(shortages.entries())
          .map(([part, qty]) => ({ part, qty: Math.ceil(qty) }))
          .sort((a, b) => b.qty - a.qty),
        topGrowth: growth.slice(0, 5),
        risk: peak > capacity ? "overflow" : peakPct >= opt.critPct ? "critical" : peakPct >= opt.warnPct ? "watch" : "ok",
      };
      results.push(res);
      snapshots.push(Int32Array.from(occupant));
    }

    return {
      options: opt,
      capacity,
      rackPositions: rackCount,
      extraPositions: extra,
      start,
      weeks: results,
      snapshots,
      positions,
      pallets: pallets.map((p) => ({ part: p.part, initial: p.initial, sim: p.sim, arrival: p.arrival })),
      summary: summarize(results, opt),
    };
  }

  function summarize(weeks, opt) {
    let worst = null;
    weeks.forEach((w) => {
      if (!worst || w.peakPct > worst.peakPct) worst = w;
    });
    const firstRisk = weeks.find((w) => w.peakPct >= opt.warnPct) || null;
    const firstCritical = weeks.find((w) => w.peakPct >= opt.critPct) || null;
    return {
      worstWeek: worst ? worst.label : null,
      worstPeakPct: worst ? worst.peakPct : 0,
      firstWatchWeek: firstRisk ? firstRisk.label : null,
      firstCriticalWeek: firstCritical ? firstCritical.label : null,
      riskWeeks: weeks.filter((w) => w.risk !== "ok").map((w) => w.label),
      shortageWeeks: weeks.filter((w) => w.shortages.length > 0).map((w) => w.label),
    };
  }

  return { DEFAULTS, explodeBom, buildPositions, shiftedOms, simulate, MinHeap, mulberry32 };
});
