/* ==========================================================================
   3D Warehouse Visualizer (Demo) — Three.js WebGL Rendering Engine
   Racks, beams and pallets are drawn as instanced meshes so a plant-scale layout (hundreds of bays,
   thousands of pallet positions) stays smooth. One pallet instance per position; empty positions are hidden.
   The whole facility is about ten draw calls: signs share one texture atlas, zone floors and lane pads are
   merged, and the click / hover targets are kept outside the scene graph (ray tests only).
   ========================================================================== */

(function () {
  "use strict";

  const PALETTES = {
    occupancy: {
      high: 0xf43f5e,
      medium: 0x38bdf8,
      low: 0x10b981,
      empty: 0x334155,
    },
    // stock age: one-hue ordinal ramp, validated on the scene background (#090f1d) - older = lighter, so aged
    // stock stands out
    aging: {
      d30: 0x1c5cab,
      d90: 0x2a78d6,
      d180: 0x5598e7,
      d365: 0x86b6ef,
      d365p: 0xb7d3f6,
    },
    turnover: {
      fast: 0x10b981,
      moderate: 0x38bdf8,
      slow: 0xa855f7,
    },
    // material warehouse: raw-material types only (categorical slots 1-3, all pairs CVD-checked on the scene)
    material: {
      ROH1: 0x3987e5,
      ROH2: 0xd95926,
      ROH3: 0x199e70,
      OTHER: 0x94a3b8,
    },
    forecast: {
      kept: 0x3987e5, // pallet already in stock at the snapshot
      arrived: 0x199e70, // pallet received in an earlier simulated week (validated pair with kept: CVD dE 19.6)
      week: 0x8af5d0, // pallet received in the selected week (lighter step of the same hue = newest)
      fixed: 0x64748b, // staging / hold pallets and stock without a plan (not simulated)
    },
  };
  const DIM = 0x1e293b;

  /** Stock age buckets: upper bound in days (inclusive) -> legend key. */
  const AGE_BUCKETS = [
    [30, "d30"],
    [90, "d90"],
    [180, "d180"],
    [365, "d365"],
    [Infinity, "d365p"],
  ];
  function ageBucket(days) {
    for (let i = 0; i < AGE_BUCKETS.length; i++) if (days <= AGE_BUCKETS[i][0]) return AGE_BUCKETS[i][1];
    return "d365p";
  }

  /** Render profile from the GPU: 'lite' without a GPU (SwiftShader / WARP / llvmpipe: remote desktops, VMs),
   *  'balanced' on integrated GPUs (Intel UHD / Iris, mobile), 'high' otherwise. ?quality=lite|balanced|high
   *  overrides; ?perf=1 shows frame rate, draw calls and resolution in the corner of the 3D view. */
  function detectQuality() {
    const q = (window.location.search.match(/[?&]quality=(lite|balanced|high)/) || [])[1];
    let name = "unknown";
    let mode = "high";
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) {
        name = "no WebGL";
        mode = "lite";
      } else {
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
        if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(name)) mode = "lite";
        else if (/intel|mali|adreno|powervr|videocore/i.test(name)) mode = "balanced";
      }
    } catch (e) {
      name = "unknown";
    }
    return { mode: q || mode, renderer: name, override: !!q };
  }
  const QUALITY = detectQuality();
  // high: up to 1.5 device pixels per CSS pixel; balanced: 1 (about a third fewer pixels on 125 % displays);
  // lite: 1 and a lower resolution while the camera moves
  const PROFILE = {
    high: { dprCap: 1.5, fog: true, adaptive: false, minRes: 1 },
    balanced: { dprCap: 1.0, fog: true, adaptive: false, minRes: 1 },
    lite: { dprCap: 1.0, fog: false, adaptive: true, minRes: 0.5 },
  }[QUALITY.mode];
  const PERF_HUD = /[?&]perf=1(&|$)/.test(window.location.search);

  const ZONE_TINTS = {
    "Zone A": "#38bdf8",
    "Zone B": "#818cf8",
    "Zone C": "#34d399",
    Staging: "#fbbf24",
    Special: "#fb7185",
  };

  const LEVEL_H = 1.05;
  const CAM_3D = { x: 0, y: 50, z: 69 };
  const TARGET_3D = { x: 0, y: 2, z: 3 };
  const CAM_2D = { x: 0, y: 104, z: 0.1 };

  let scene = null;
  let camera = null;
  let renderer = null;
  let controls = null;
  let facilityRoot = null;
  let selectionBoxMesh = null;

  let raycaster = null;
  let pointerNDC = null;
  let pointerDownPos = { x: 0, y: 0 };

  let hitProxies = []; // invisible bay boxes for clicks / hover - ray tests only, never drawn or traversed
  const proxyGeoms = new Map(); // shared proxy geometries by size
  let disposables = []; // per-facility textures / materials / geometries outside facilityRoot
  let signAtlas = null; // { canvas, texture, signs } - redrawn once the web fonts are ready
  let bayVisualMap = new Map();
  let palletMesh = null; // InstancedMesh, one instance per position slot
  const hiddenByGroup = {}; // legend categories switched off, per colour mode and for the weekly view ('forecast')
  const NONE = new Set();
  let categoryCounts = {}; // pallets per legend category in the last paint
  const res = { base: 1, base0: 1, cur: 1, min: 0.6, changed: 0 }; // render resolution (pixel ratio)
  let slotRecords = []; // instance index -> { bay, level, slot, item, matrix, key }
  let forecastState = null; // Map positionKey -> { status, part } while the weekly view is on
  let currentMode = "occupancy";
  let lastFilter = { bays: null, items: null };
  let cameraViewMode = "3d";
  let onBayClickCallback = null;
  let tooltipFormatter = null;

  const sharedMats = {};
  let tmpColor = null;
  let HIDDEN = null;

  function init(canvasEl, onBayClick) {
    onBayClickCallback = onBayClick;
    tmpColor = new THREE.Color();
    HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
    const wrapper = canvasEl.parentElement;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x090f1d);
    if (PROFILE.fog) scene.fog = new THREE.FogExp2(0x090f1d, 0.0031);

    const aspect = Math.max(1, wrapper.clientWidth) / Math.max(1, wrapper.clientHeight);
    camera = new THREE.PerspectiveCamera(45, aspect, 0.5, 600);
    camera.position.set(CAM_3D.x, CAM_3D.y, CAM_3D.z);

    // Light by design (playable on office laptops): pixel ratio capped per profile, MSAA only below 1.5 device
    // pixels per CSS pixel, no shadow pass, Lambert materials, frames drawn only when something changed
    const lite = QUALITY.mode === "lite";
    const dpr = Math.min(window.devicePixelRatio || 1, PROFILE.dprCap);
    renderer = new THREE.WebGLRenderer({
      canvas: canvasEl,
      antialias: !lite && dpr < 1.5,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(dpr);
    res.base = dpr;
    res.base0 = dpr;
    res.cur = dpr;
    res.min = PROFILE.minRes;
    document.documentElement.dataset.quality = QUALITY.mode;
    renderer.setSize(wrapper.clientWidth, wrapper.clientHeight);
    renderer.shadowMap.enabled = false;

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minDistance = 10;
    controls.maxDistance = 240;
    controls.target.set(TARGET_3D.x, TARGET_3D.y, TARGET_3D.z);
    controls.addEventListener("change", requestRender);

    scene.add(new THREE.HemisphereLight(0xdbeafe, 0x0f172a, 0.85));

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.95);
    keyLight.position.set(46, 80, 40);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.35);
    rimLight.position.set(-55, 40, -45);
    scene.add(rimLight);
    scene.children.forEach((o) => {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });

    sharedMats.upright = new THREE.MeshLambertMaterial({ color: 0x64748b });
    sharedMats.beam = new THREE.MeshLambertMaterial({ color: 0xd97706 });
    sharedMats.stagingPad = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
    });
    sharedMats.proxy = new THREE.MeshBasicMaterial({ visible: false });
    sharedMats.pallet = new THREE.MeshLambertMaterial({ color: 0xffffff });

    buildBaseFloor();

    facilityRoot = new THREE.Group();
    scene.add(facilityRoot);

    raycaster = new THREE.Raycaster();
    pointerNDC = new THREE.Vector2(-10, -10);

    bindEvents(canvasEl, wrapper);
    if (PERF_HUD) buildPerfHud(wrapper);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(redrawSigns);
    animate();
  }

  function buildBaseFloor() {
    const floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(124, 112),
      new THREE.MeshBasicMaterial({ color: 0x0f172a })
    );
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -0.04;
    scene.add(floorMesh);

    const grid = new THREE.GridHelper(120, 60, 0x1e293b, 0x162033);
    grid.position.y = 0.02; // above the (opaque) zone floors
    scene.add(grid);
    [floorMesh, grid].forEach((o) => {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
  }

  function clearFacilityScene() {
    if (!facilityRoot) return;
    while (facilityRoot.children.length > 0) {
      const child = facilityRoot.children[0];
      facilityRoot.remove(child);
      if (child.geometry) child.geometry.dispose();
    }
    disposables.forEach((d) => d.dispose());
    disposables = [];
    signAtlas = null;
    hitProxies = [];
    bayVisualMap.clear();
    slotRecords = [];
    palletMesh = null;
    selectionBoxMesh = null;
  }

  /** Text signs of the facility in ONE mesh: a canvas atlas of 256 x 64 cells and one quad per sign.
   *  sign = { text, accent, w, h, fontPx, x, y, z, flat } - flat signs lie on the floor, readable from +z. */
  const SIGN_W = 256;
  const SIGN_H = 64;
  const SIGN_COLS = 4;

  function drawSigns(atlas) {
    const ctx = atlas.canvas.getContext("2d");
    ctx.clearRect(0, 0, atlas.canvas.width, atlas.canvas.height);
    atlas.signs.forEach((s, i) => {
      const cx = (i % SIGN_COLS) * SIGN_W;
      const cy = Math.floor(i / SIGN_COLS) * SIGN_H;
      ctx.fillStyle = "rgba(11, 17, 32, 0.88)";
      ctx.fillRect(cx, cy, SIGN_W, SIGN_H);
      ctx.strokeStyle = s.accent;
      ctx.lineWidth = 4;
      ctx.strokeRect(cx + 4, cy + 4, SIGN_W - 8, SIGN_H - 8);
      ctx.fillStyle = "#f8fafc";
      ctx.font = `700 ${s.fontPx || 26}px Outfit, Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(s.text, cx + SIGN_W / 2, cy + 33);
    });
    atlas.texture.needsUpdate = true;
  }

  function redrawSigns() {
    if (!signAtlas) return;
    drawSigns(signAtlas);
    requestRender();
  }

  function buildSigns(signs) {
    if (!signs.length) return null;
    const rows = Math.ceil(signs.length / SIGN_COLS);
    const canvas = document.createElement("canvas");
    canvas.width = SIGN_W * SIGN_COLS;
    canvas.height = THREE.MathUtils.ceilPowerOfTwo(rows * SIGN_H);
    const texture = new THREE.CanvasTexture(canvas);
    signAtlas = { canvas, texture, signs };
    drawSigns(signAtlas);
    const pos = [];
    const uv = [];
    const idx = [];
    signs.forEach((s, i) => {
      const u0 = ((i % SIGN_COLS) * SIGN_W) / canvas.width;
      const u1 = u0 + SIGN_W / canvas.width;
      const v1 = 1 - (Math.floor(i / SIGN_COLS) * SIGN_H) / canvas.height; // top of the cell (flipY)
      const v0 = v1 - SIGN_H / canvas.height;
      const hw = s.w / 2;
      const hh = s.h / 2;
      const b = pos.length / 3;
      if (s.flat) {
        pos.push(s.x - hw, s.y, s.z + hh, s.x + hw, s.y, s.z + hh, s.x + hw, s.y, s.z - hh, s.x - hw, s.y, s.z - hh);
      } else {
        pos.push(s.x - hw, s.y - hh, s.z, s.x + hw, s.y - hh, s.z, s.x + hw, s.y + hh, s.z, s.x - hw, s.y + hh, s.z);
      }
      uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geom.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    disposables.push(texture, mat);
    return new THREE.Mesh(geom, mat);
  }

  /** Zone floors as one opaque mesh (the 5 % zone tint pre-mixed into the floor colour, so no blending) and the
   *  zone outlines as one line set. */
  function buildZoneFloors(zones) {
    const floor = new THREE.Color(0x0f172a);
    const pos = [];
    const col = [];
    const idx = [];
    const lpos = [];
    const lcol = [];
    zones.forEach((z) => {
      const tint = new THREE.Color(ZONE_TINTS[z.zone] || "#38bdf8");
      const fill = floor.clone().lerp(tint, 0.05);
      const edge = floor.clone().lerp(tint, 0.4);
      const b = pos.length / 3;
      const y = 0.01;
      pos.push(z.min_x, y, z.min_z, z.max_x, y, z.min_z, z.max_x, y, z.max_z, z.min_x, y, z.max_z);
      for (let k = 0; k < 4; k++) col.push(fill.r, fill.g, fill.b);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      const ly = 0.03;
      const c = [
        [z.min_x, z.min_z], [z.max_x, z.min_z], [z.max_x, z.max_z], [z.min_x, z.max_z],
      ];
      for (let k = 0; k < 4; k++) {
        const a = c[k];
        const n = c[(k + 1) % 4];
        lpos.push(a[0], ly, a[1], n[0], ly, n[1]);
        lcol.push(edge.r, edge.g, edge.b, edge.r, edge.g, edge.b);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const fillMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(lpos, 3));
    lg.setAttribute("color", new THREE.Float32BufferAttribute(lcol, 3));
    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
    disposables.push(fillMat, lineMat);
    return [new THREE.Mesh(g, fillMat), new THREE.LineSegments(lg, lineMat)];
  }

  /** Floor-staging lane pads of the facility as one mesh. */
  function buildLanePads(lanes) {
    if (!lanes.length) return null;
    const pos = [];
    const idx = [];
    lanes.forEach((bay) => {
      const hw = ((bay.bay_width || 2.0) * 0.9) / 2;
      const hd = ((bay.bay_depth || 2.1) * 0.9) / 2;
      const b = pos.length / 3;
      const y = 0.03;
      pos.push(bay.world_x - hw, y, bay.world_z - hd, bay.world_x + hw, y, bay.world_z - hd,
        bay.world_x + hw, y, bay.world_z + hd, bay.world_x - hw, y, bay.world_z + hd);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return new THREE.Mesh(g, sharedMats.stagingPad);
  }

  function proxyGeometry(w, h, d) {
    const key = `${w.toFixed(2)}x${h.toFixed(2)}x${d.toFixed(2)}`;
    if (!proxyGeoms.has(key)) proxyGeoms.set(key, new THREE.BoxGeometry(w, h, d));
    return proxyGeoms.get(key);
  }

  function slotOffset(bay, slot) {
    const per = bay.max_boxes_per_level || 1;
    if (per === 1) return 0;
    const pitch = ((bay.bay_width || 2.0) * 0.9) / per;
    return (slot - (per - 1) / 2) * pitch;
  }

  function loadFacility(dataset) {
    clearFacilityScene();
    if (!dataset || !Array.isArray(dataset.bays)) return;

    // 1. Zone floors, outlines & floor labels
    const signs = [];
    const zones = dataset.zones || [];
    if (zones.length) facilityRoot.add(...buildZoneFloors(zones));
    zones.forEach((z) => {
      if (z.zone !== "Staging" && z.zone !== "Special") {
        signs.push({ text: z.zone.toUpperCase(), accent: ZONE_TINTS[z.zone] || "#38bdf8", w: 7.2, h: 1.75, fontPx: 24,
          x: (z.min_x + z.max_x) / 2, y: 0.04, z: z.min_z - 1.4, flat: true });
      }
    });

    // 2. Instanced racks, beams and pallet slots
    let postCount = 0;
    let beamCount = 0;
    let slotCount = 0;
    dataset.bays.forEach((bay) => {
      if (bay.max_levels > 1) {
        postCount += 4;
        beamCount += 2 * bay.max_levels;
      }
      slotCount += bay.max_levels * (bay.max_boxes_per_level || 1);
    });

    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 1, 0.08), sharedMats.upright, Math.max(1, postCount));
    const beams = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.06, 0.06), sharedMats.beam, Math.max(1, beamCount));
    palletMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), sharedMats.pallet, Math.max(1, slotCount));
    // three r128 culls an instanced mesh by its base box at the origin, which would drop every rack when the
    // origin leaves the view; the instances span the whole facility, so never cull them
    [posts, beams, palletMesh].forEach((im) => {
      im.frustumCulled = false;
    });
    const lanes = [];

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    let pi = 0;
    let bi = 0;
    const racksById = new Map();

    dataset.bays.forEach((bay) => {
      if (!racksById.has(bay.rack_id)) racksById.set(bay.rack_id, []);
      racksById.get(bay.rack_id).push(bay);
      const bw = bay.bay_width || 2.0;
      const bd = bay.bay_depth || 2.1;
      const totalH = bay.max_levels * LEVEL_H + 0.35;
      const per = bay.max_boxes_per_level || 1;

      if (bay.max_levels > 1) {
        [
          [-bw * 0.45, -bd * 0.45],
          [bw * 0.45, -bd * 0.45],
          [-bw * 0.45, bd * 0.45],
          [bw * 0.45, bd * 0.45],
        ].forEach(([px, pz]) => {
          m.compose(p.set(bay.world_x + px, totalH / 2, bay.world_z + pz), q, s.set(1, totalH, 1));
          posts.setMatrixAt(pi++, m);
        });
        for (let lvl = 1; lvl <= bay.max_levels; lvl++) {
          const y = (lvl - 1) * LEVEL_H + 0.14;
          [bd * 0.45, -bd * 0.45].forEach((dz) => {
            m.compose(p.set(bay.world_x, y, bay.world_z + dz), q, s.set(bw * 0.92, 1, 1));
            beams.setMatrixAt(bi++, m);
          });
        }
      } else {
        lanes.push(bay);
      }

      const base = slotRecords.length;
      const boxW = per === 1 ? bw * 0.78 : ((bw * 0.9) / per) * 0.88;
      for (let lvl = 1; lvl <= bay.max_levels; lvl++) {
        for (let sl = 0; sl < per; sl++) {
          const y = (lvl - 1) * LEVEL_H + 0.17 + 0.36;
          const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(bay.world_x + slotOffset(bay, sl), y, bay.world_z),
            q,
            new THREE.Vector3(boxW, 0.7, bd * 0.72)
          );
          slotRecords.push({ bay, level: lvl, slot: sl, item: null, matrix, key: `${bay.bay_id}:${lvl}:${sl}` });
        }
      }
      (bay.items || []).forEach((it) => {
        const idx = base + (it.level - 1) * per + (it.slot || 0);
        if (slotRecords[idx] && !slotRecords[idx].item) slotRecords[idx].item = it;
      });

      const proxyH = Math.max(1.4, totalH);
      const proxyMesh = new THREE.Mesh(proxyGeometry(bw, proxyH, bd), sharedMats.proxy);
      proxyMesh.position.set(bay.world_x, proxyH / 2, bay.world_z);
      proxyMesh.userData = { bayId: bay.bay_id, bay };
      proxyMesh.updateMatrixWorld(true); // not in the scene: only ray-tested on click / hover
      hitProxies.push(proxyMesh);
      bayVisualMap.set(bay.bay_id, { bay, base, count: bay.max_levels * per, proxyH, bw, bd });
    });

    posts.count = pi;
    beams.count = bi;
    posts.instanceMatrix.needsUpdate = true;
    beams.instanceMatrix.needsUpdate = true;
    facilityRoot.add(posts, beams, palletMesh);
    const lanePads = buildLanePads(lanes);
    if (lanePads) facilityRoot.add(lanePads);

    // signs: rack id at the aisle end of every rack line, one sign per staging / hold area
    racksById.forEach((bays, rackId) => {
      const first = bays[0];
      if (first.zone === "Staging" || first.zone === "Special") {
        const mid = bays[Math.floor(bays.length / 2)];
        signs.push({ text: first.zone === "Staging" ? "DOCK STAGING" : "QUALITY HOLD", accent: ZONE_TINTS[first.zone],
          w: 4.6, h: 1.0, fontPx: 26, x: mid.world_x, y: first.max_levels * LEVEL_H + 1.5, z: first.world_z + 1.4 });
        return;
      }
      const front = bays.reduce((acc, b) => (b.world_z > acc.world_z ? b : acc), first);
      signs.push({ text: rackId, accent: ZONE_TINTS[front.zone] || "#38bdf8", w: 2.2, h: 0.62, fontPx: 30,
        x: front.world_x, y: front.max_levels * LEVEL_H + 1.1, z: front.world_z + 1.15 });
    });
    const signMesh = buildSigns(signs);
    if (signMesh) facilityRoot.add(signMesh);

    facilityRoot.traverse((o) => {
      if (o === facilityRoot) return;
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
    facilityRoot.updateMatrixWorld(true);
    paint();
  }

  /** Legend category of a snapshot pallet in a colour mode (the keys of PALETTES[mode]). */
  function categoryOf(item, bay, mode) {
    if (mode === "occupancy") return bay.occupancy_pct >= 85 ? "high" : bay.occupancy_pct >= 50 ? "medium" : "low";
    if (mode === "aging") return ageBucket(item.age_days);
    if (mode === "turnover") return item.turnover_days <= 15 ? "fast" : item.turnover_days <= 38 ? "moderate" : "slow";
    if (mode === "material") return PALETTES.material[item.material_type] !== undefined ? item.material_type : "OTHER";
    return "";
  }

  /** Draw every slot: snapshot pallets (filters + color mode) or the projected week (weekly view).
   *  Legend categories switched off (setHiddenCategories) are not drawn; counts per category are kept. */
  function paint() {
    if (!palletMesh) return;
    const filterBays = lastFilter.bays;
    const filterItems = lastFilter.items;
    const counts = {};
    const hiddenCats = hiddenByGroup[forecastState ? "forecast" : currentMode] || NONE;
    slotRecords.forEach((rec, i) => {
      let show = false;
      let hex = DIM;
      if (forecastState && rec.bay.in_capacity !== false) {
        const st = forecastState.get(rec.key);
        if (st) {
          const key = PALETTES.forecast[st.status] !== undefined ? st.status : "arrived";
          counts[key] = (counts[key] || 0) + 1;
          show = !hiddenCats.has(key);
          hex = PALETTES.forecast[key];
        }
      } else if (rec.item) {
        show = true;
        if (forecastState) {
          hex = PALETTES.forecast.fixed; // staging / hold pallets stay as they are in the weekly view
          counts.fixed = (counts.fixed || 0) + 1;
          show = !hiddenCats.has("fixed");
        } else {
          const active =
            (!filterBays || filterBays.has(rec.bay.bay_id)) && (!filterItems || filterItems.has(rec.item.box_id));
          const key = categoryOf(rec.item, rec.bay, currentMode);
          if (active) counts[key] = (counts[key] || 0) + 1;
          hex = active ? PALETTES[currentMode][key] : DIM;
          show = !hiddenCats.has(key);
        }
      }
      palletMesh.setMatrixAt(i, show ? rec.matrix : HIDDEN);
      palletMesh.setColorAt(i, tmpColor.setHex(hex));
    });
    categoryCounts = counts;
    palletMesh.instanceMatrix.needsUpdate = true;
    if (palletMesh.instanceColor) palletMesh.instanceColor.needsUpdate = true;
    requestRender();
  }

  /** Legend check boxes: group = colour mode ('occupancy', 'aging', 'turnover', 'material') or 'forecast'
   *  (weekly view); keys = PALETTES[group] keys to hide. */
  function setHiddenCategories(group, keys) {
    hiddenByGroup[group] = new Set(keys || []);
    paint();
  }

  function isHidden(group, key) {
    return !!(hiddenByGroup[group] && hiddenByGroup[group].has(key));
  }

  function applyState(matchedBayIds, matchedItemSet, colorMode) {
    currentMode = colorMode || currentMode;
    lastFilter = { bays: matchedBayIds, items: matchedItemSet };
    paint();
  }

  /** Weekly view: Map positionKey -> {status: 'kept' | 'arrived' | 'fixed', part}; null returns to the snapshot. */
  function setForecastState(stateMap) {
    forecastState = stateMap || null;
    paint();
  }

  function bayForecastCount(bay) {
    if (!forecastState) return null;
    let n = 0;
    const per = bay.max_boxes_per_level || 1;
    for (let lvl = 1; lvl <= bay.max_levels; lvl++) {
      for (let sl = 0; sl < per; sl++) if (forecastState.has(`${bay.bay_id}:${lvl}:${sl}`)) n += 1;
    }
    return n;
  }

  function selectBayById(bayId) {
    if (selectionBoxMesh && facilityRoot) {
      facilityRoot.remove(selectionBoxMesh);
      selectionBoxMesh = null;
    }
    if (!bayId || !bayVisualMap.has(bayId)) return null;
    const entry = bayVisualMap.get(bayId);
    selectionBoxMesh = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(entry.bw + 0.25, entry.proxyH + 0.25, entry.bd + 0.25)),
      new THREE.LineBasicMaterial({ color: 0x38bdf8 })
    );
    selectionBoxMesh.position.set(entry.bay.world_x, (entry.proxyH + 0.25) / 2, entry.bay.world_z);
    facilityRoot.add(selectionBoxMesh);
    selectionBoxMesh.updateMatrixWorld(true);
    if (cameraViewMode === "3d" && window.gsap) {
      gsap.to(controls.target, { x: entry.bay.world_x, y: 2.0, z: entry.bay.world_z, duration: 0.65, ease: "power2.out", onUpdate: requestRender });
    }
    requestRender();
    return entry.bay;
  }

  function clearSelection() {
    if (selectionBoxMesh && facilityRoot) {
      facilityRoot.remove(selectionBoxMesh);
      selectionBoxMesh = null;
    }
    requestRender();
  }

  function setCameraMode(mode) {
    cameraViewMode = mode;
    if (!window.gsap) return;
    const to = mode === "2d" ? CAM_2D : CAM_3D;
    controls.enableRotate = mode !== "2d";
    gsap.to(camera.position, { x: to.x, y: to.y, z: to.z, duration: 0.9, ease: "power2.inOut", onUpdate: requestRender });
    const tg = mode === "2d" ? { x: 0, y: 0, z: 0 } : TARGET_3D;
    gsap.to(controls.target, { x: tg.x, y: tg.y, z: tg.z, duration: 0.9, ease: "power2.inOut", onUpdate: requestRender });
  }

  function resetCamera() {
    setCameraMode(cameraViewMode);
  }

  function setTooltipFormatter(fn) {
    tooltipFormatter = fn;
  }

  function bindEvents(canvasEl, wrapper) {
    const tooltip = document.getElementById("bay-tooltip");

    canvasEl.addEventListener("pointerdown", (ev) => {
      pointerDownPos = { x: ev.clientX, y: ev.clientY };
    });

    let hoverEv = null;
    let hoverQueued = false;
    canvasEl.addEventListener("pointermove", (ev) => {
      if (ev.buttons !== 0) {                 // orbiting / panning: no picking while the camera moves
        hideTip();
        return;
      }
      hoverEv = ev;
      if (hoverQueued) return;
      hoverQueued = true;
      requestAnimationFrame(() => {
        hoverQueued = false;
        if (hoverEv) hover(hoverEv);
      });
    });

    let tipKey = "";
    let cursor = "";
    const setCursor = (c) => {
      if (c !== cursor) canvasEl.style.cursor = cursor = c;
    };
    const hideTip = () => {
      if (tooltip && tipKey) tooltip.classList.add("hidden");
      tipKey = "";
    };
    function hover(ev) {
      const rect = canvasEl.getBoundingClientRect();
      pointerNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNDC, camera);
      const hits = raycaster.intersectObjects(hitProxies, false);
      if (hits.length > 0) {
        const bay = hits[0].object.userData.bay;
        setCursor("pointer");
        if (tooltip) {
          // the text changes only when another bay (or week) is under the pointer; moving is a transform
          const wk = bayForecastCount(bay);
          const key = `${bay.bay_id}|${wk}`;
          if (key !== tipKey) {
            tipKey = key;
            document.getElementById("tip-bay-id").textContent = bay.bay_id;
            document.getElementById("tip-zone").textContent = bay.zone;
            if (wk !== null && bay.in_capacity !== false) {
              const label = tooltipFormatter ? tooltipFormatter() : "selected week";
              document.getElementById("tip-occ").textContent = `${wk} / ${bay.capacity_boxes} pallets (${label})`;
            } else {
              document.getElementById("tip-occ").textContent = `${bay.box_count} / ${bay.capacity_boxes} pallets (${bay.occupancy_pct}%)`;
            }
            document.getElementById("tip-qty").textContent = `${bay.total_qty.toLocaleString()} pcs (snapshot)`;
            document.getElementById("tip-age").textContent = bay.box_count > 0 ? `${bay.max_age_days} days` : "Empty";
            tooltip.classList.remove("hidden");
          }
          tooltip.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY}px) translateY(-50%)`;
        }
      } else {
        setCursor("grab");
        hideTip();
      }
    }

    canvasEl.addEventListener("pointerleave", () => {
      hoverEv = null;
      hideTip();
    });

    canvasEl.addEventListener("pointerup", (ev) => {
      const moved = Math.hypot(ev.clientX - pointerDownPos.x, ev.clientY - pointerDownPos.y);
      if (moved > 5) return;
      const rect = canvasEl.getBoundingClientRect();
      pointerNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNDC, camera);
      const hits = raycaster.intersectObjects(hitProxies, false);
      if (hits.length > 0) {
        const bay = hits[0].object.userData.bay;
        selectBayById(bay.bay_id);
        if (onBayClickCallback) onBayClickCallback(bay);
      }
    });

    const onResize = () => {
      if (!wrapper || !renderer || !camera) return;
      const w = Math.max(1, wrapper.clientWidth);
      const h = Math.max(1, wrapper.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      requestRender();
    };
    window.addEventListener("resize", onResize);
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(wrapper);
  }

  // Frames are drawn only when something changed: camera moves (incl. damping), repaints, tweens, resize.
  let needsRender = true;
  function requestRender() {
    needsRender = true;
  }

  // lite profile: when frames keep coming slower than ~25 fps while the camera moves, draw fewer pixels
  // (a resolution change reallocates the drawing buffer, so it waits for three slow frames in a row); once the
  // camera rests, one frame is drawn at full resolution again.
  // all profiles: if moving the view runs below ~40 fps on average over 24 frames, the GPU is the limit - step
  // the resolution down once (x0.85, at most three times, not below 0.75 x the start) and keep it.
  let lastFrameT = 0;
  let restFrames = 0;
  let slowFrames = 0;
  const stats = { frames: 0, ms: 0, gap: 0, gaps: 0, since: 0 };
  const pace = { sum: 0, n: 0, steps: 0 };
  function stepDown(gap) {
    pace.sum += gap;
    pace.n += 1;
    if (pace.n < 24) return;
    const avg = pace.sum / pace.n;
    pace.sum = 0;
    pace.n = 0;
    const floor = res.base0 * 0.75;
    if (avg > 25 && pace.steps < 3 && res.base > floor + 1e-3) {
      pace.steps += 1;
      res.base = Math.max(floor, res.base * 0.85);
      res.cur = Math.min(res.cur, res.base);
      res.changed = performance.now();
      renderer.setPixelRatio(res.cur);
    }
  }
  function animate(t) {
    requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;
    const moving = controls ? controls.update() : false;
    if (moving || needsRender) {
      if (lastFrameT) {
        const gap = t - lastFrameT;
        stats.gap += gap;
        stats.gaps += 1;
        slowFrames = moving && gap > 40 ? slowFrames + 1 : 0;
        if (moving && gap < 250) stepDown(gap);
      }
      if (PROFILE.adaptive && slowFrames >= 3 && res.cur > res.min && t - res.changed > 400) {
        res.cur = Math.max(res.min, res.cur * 0.75);
        res.changed = t;
        slowFrames = 0;
        renderer.setPixelRatio(res.cur);
      }
      needsRender = false;
      restFrames = 0;
      const t0 = performance.now();
      renderer.render(scene, camera);
      stats.ms += performance.now() - t0;
      stats.frames += 1;
      lastFrameT = t;
    } else if (res.cur < res.base && ++restFrames > 8) {
      res.cur = res.base;
      renderer.setPixelRatio(res.cur);
      renderer.render(scene, camera);
    } else {
      lastFrameT = 0;
    }
    if (perfEl && t - stats.since > 500) updatePerfHud(t);
  }

  // ?perf=1: frame rate while the view moves, CPU time per frame, draw calls, resolution and profile
  let perfEl = null;
  function buildPerfHud(wrapper) {
    perfEl = document.createElement("div");
    perfEl.className = "perf-hud";
    perfEl.textContent = "perf: move the view";
    wrapper.appendChild(perfEl);
  }
  function updatePerfHud(t) {
    const info = renderer.info.render;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const fps = stats.gaps ? Math.round(1000 / (stats.gap / stats.gaps)) : null;
    const cpu = stats.frames ? (stats.ms / stats.frames).toFixed(1) : null;
    perfEl.textContent =
      `${fps ? `${fps} fps` : "idle"}${cpu ? ` · ${cpu} ms cpu` : ""} · ${info.calls} draws · ` +
      `${Math.round(info.triangles / 1000)}k tris · ${size.x}x${size.y} @${res.cur.toFixed(2)} · ` +
      `${QUALITY.mode}${QUALITY.override ? " (url)" : ""} · ${QUALITY.renderer.replace(/^ANGLE \(|\)$/g, "").slice(0, 48)}`;
    stats.frames = 0;
    stats.ms = 0;
    stats.gap = 0;
    stats.gaps = 0;
    stats.since = t;
  }

  window.DemoViewer = {
    init,
    setHiddenCategories,
    isHidden,
    categoryOf,
    ageBucket,
    getCategoryCounts: () => categoryCounts,
    quality: QUALITY,
    loadFacility,
    applyState,
    setForecastState,
    setTooltipFormatter,
    selectBayById,
    clearSelection,
    setCameraMode,
    resetCamera,
    PALETTES,
  };
})();
