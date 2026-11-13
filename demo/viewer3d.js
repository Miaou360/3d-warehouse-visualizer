/* ==========================================================================
   3D Warehouse Visualizer (Demo) — Three.js WebGL Rendering Engine
   Racks, beams and pallets are drawn as instanced meshes so a plant-scale layout (hundreds of bays,
   thousands of pallet positions) stays smooth. One pallet instance per position; empty positions are hidden.
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
    aging: {
      critical: 0xf43f5e,
      warning: 0xf59e0b,
      normal: 0x10b981,
    },
    turnover: {
      fast: 0x10b981,
      moderate: 0x38bdf8,
      slow: 0xa855f7,
    },
    material: {
      ROH1: 0x38bdf8,
      ROH2: 0x818cf8,
      HALB: 0xf59e0b,
      FERT: 0x10b981,
      OTHER: 0x94a3b8,
    },
    forecast: {
      kept: 0x3987e5, // pallet already in stock at the snapshot
      arrived: 0x199e70, // pallet received in an earlier simulated week (validated pair with kept: CVD dE 19.6)
      week: 0x8af5d0, // pallet received in the selected week (lighter step of the same hue = newest)
      fixed: 0x64748b, // sub-assembly / finished-goods / staging pallets (not simulated)
    },
  };
  const DIM = 0x1e293b;

  /** 'lite' when the browser draws WebGL without a GPU (SwiftShader / WARP / llvmpipe: common on office PCs,
   *  remote desktops and VMs) or ?quality=lite; 'high' otherwise or with ?quality=high. */
  function detectQuality() {
    const q = (window.location.search.match(/[?&]quality=(lite|high)/) || [])[1];
    if (q) return { mode: q, renderer: "url override" };
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) return { mode: "lite", renderer: "no WebGL" };
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      const soft = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(name);
      return { mode: soft ? "lite" : "high", renderer: name };
    } catch (e) {
      return { mode: "high", renderer: "unknown" };
    }
  }
  const QUALITY = detectQuality();

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

  let hitProxies = [];
  let bayVisualMap = new Map();
  let palletMesh = null; // InstancedMesh, one instance per position slot
  const hiddenByGroup = {}; // legend categories switched off, per colour mode and for the weekly view ('forecast')
  const NONE = new Set();
  let categoryCounts = {}; // pallets per legend category in the last paint
  const res = { base: 1, cur: 1, min: 0.6, changed: 0 }; // render resolution (pixel ratio)
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
    if (QUALITY.mode !== "lite") scene.fog = new THREE.FogExp2(0x090f1d, 0.0031);

    const aspect = Math.max(1, wrapper.clientWidth) / Math.max(1, wrapper.clientHeight);
    camera = new THREE.PerspectiveCamera(45, aspect, 0.5, 600);
    camera.position.set(CAM_3D.x, CAM_3D.y, CAM_3D.z);

    // Light by design (playable on office laptops): pixel ratio capped at 1.5, MSAA only on standard-density
    // screens, no shadow pass, Lambert materials, and frames are drawn only when something changed (see animate)
    // lite (no GPU): no MSAA, one device pixel per CSS pixel at most, and a lower resolution while moving
    const lite = QUALITY.mode === "lite";
    const dpr = lite ? Math.min(window.devicePixelRatio || 1, 1) : Math.min(window.devicePixelRatio || 1, 1.5);
    renderer = new THREE.WebGLRenderer({
      canvas: canvasEl,
      antialias: !lite && dpr < 1.5,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(dpr);
    res.base = dpr;
    res.cur = dpr;
    res.min = lite ? 0.45 : 0.6;
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
    grid.position.y = -0.01;
    scene.add(grid);
  }

  function clearFacilityScene() {
    if (!facilityRoot) return;
    while (facilityRoot.children.length > 0) {
      const child = facilityRoot.children[0];
      facilityRoot.remove(child);
      if (child.geometry) child.geometry.dispose();
    }
    hitProxies = [];
    bayVisualMap.clear();
    slotRecords = [];
    palletMesh = null;
    selectionBoxMesh = null;
  }

  function makeTextBanner(text, accentHex, widthWorld, heightWorld, fontPx) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(11, 17, 32, 0.88)";
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = accentHex;
    ctx.lineWidth = 4;
    ctx.strokeRect(4, 4, 248, 56);
    ctx.fillStyle = "#f8fafc";
    ctx.font = `700 ${fontPx || 26}px Outfit, Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 33);
    const mat = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    return new THREE.Mesh(new THREE.PlaneGeometry(widthWorld, heightWorld), mat);
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

    // 1. Zone pads & floor labels
    (dataset.zones || []).forEach((z) => {
      const w = z.max_x - z.min_x;
      const d = z.max_z - z.min_z;
      const cx = (z.min_x + z.max_x) / 2;
      const cz = (z.min_z + z.max_z) / 2;
      const tint = ZONE_TINTS[z.zone] || "#38bdf8";
      const pad = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(tint), transparent: true, opacity: 0.05, side: THREE.DoubleSide })
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(cx, 0.01, cz);
      facilityRoot.add(pad);
      const border = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.04, d)),
        new THREE.LineBasicMaterial({ color: new THREE.Color(tint), transparent: true, opacity: 0.4 })
      );
      border.position.set(cx, 0.03, cz);
      facilityRoot.add(border);
      if (z.zone !== "Staging" && z.zone !== "Special") {
        const plaque = makeTextBanner(z.zone.toUpperCase(), tint, 7.2, 1.75, 24);
        plaque.rotation.x = -Math.PI / 2;
        plaque.position.set(cx, 0.04, z.min_z - 1.4);
        facilityRoot.add(plaque);
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
        const lanePad = new THREE.Mesh(new THREE.PlaneGeometry(bw * 0.9, bd * 0.9), sharedMats.stagingPad);
        lanePad.rotation.x = -Math.PI / 2;
        lanePad.position.set(bay.world_x, 0.03, bay.world_z);
        facilityRoot.add(lanePad);
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
      const proxyMesh = new THREE.Mesh(new THREE.BoxGeometry(bw, proxyH, bd), sharedMats.proxy);
      proxyMesh.position.set(bay.world_x, proxyH / 2, bay.world_z);
      proxyMesh.userData = { bayId: bay.bay_id, bay };
      facilityRoot.add(proxyMesh);
      hitProxies.push(proxyMesh);
      bayVisualMap.set(bay.bay_id, { bay, base, count: bay.max_levels * per, proxyH, bw, bd });
    });

    posts.count = pi;
    beams.count = bi;
    posts.instanceMatrix.needsUpdate = true;
    beams.instanceMatrix.needsUpdate = true;
    facilityRoot.add(posts, beams, palletMesh);

    // signs: rack id at the aisle end of every rack line, one sign per staging / hold area
    racksById.forEach((bays, rackId) => {
      const first = bays[0];
      if (first.zone === "Staging" || first.zone === "Special") {
        const mid = bays[Math.floor(bays.length / 2)];
        const sign = makeTextBanner(first.zone === "Staging" ? "DOCK STAGING" : "QUALITY HOLD", ZONE_TINTS[first.zone], 4.6, 1.0, 26);
        sign.position.set(mid.world_x, first.max_levels * LEVEL_H + 1.5, first.world_z + 1.4);
        facilityRoot.add(sign);
        return;
      }
      const front = bays.reduce((acc, b) => (b.world_z > acc.world_z ? b : acc), first);
      const sign = makeTextBanner(rackId, ZONE_TINTS[front.zone] || "#38bdf8", 2.2, 0.62, 30);
      sign.position.set(front.world_x, front.max_levels * LEVEL_H + 1.1, front.world_z + 1.15);
      facilityRoot.add(sign);
    });

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
    if (mode === "aging") return item.age_days > 90 ? "critical" : item.age_days > 30 ? "warning" : "normal";
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
          hex = PALETTES.forecast.fixed;
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
        if (tooltip) tooltip.classList.add("hidden");
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

    function hover(ev) {
      const rect = canvasEl.getBoundingClientRect();
      pointerNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNDC, camera);
      const hits = raycaster.intersectObjects(hitProxies, false);
      if (hits.length > 0) {
        const bay = hits[0].object.userData.bay;
        canvasEl.style.cursor = "pointer";
        if (tooltip) {
          const wk = bayForecastCount(bay);
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
          tooltip.style.left = `${ev.clientX}px`;
          tooltip.style.top = `${ev.clientY}px`;
          tooltip.classList.remove("hidden");
        }
      } else {
        canvasEl.style.cursor = "grab";
        if (tooltip) tooltip.classList.add("hidden");
      }
    }

    canvasEl.addEventListener("pointerleave", () => {
      hoverEv = null;
      if (tooltip) tooltip.classList.add("hidden");
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

  // Adaptive resolution: while the camera moves and frames come slower than ~25 fps, draw fewer pixels;
  // once it rests, draw one frame at full resolution again.
  let lastFrameT = 0;
  let restFrames = 0;
  function animate(t) {
    requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;
    const moving = controls ? controls.update() : false;
    if (moving || needsRender) {
      if (moving && lastFrameT && t - lastFrameT > 40 && res.cur > res.min && t - res.changed > 250) {
        res.cur = Math.max(res.min, res.cur * 0.75);
        res.changed = t;
        renderer.setPixelRatio(res.cur);
      }
      needsRender = false;
      restFrames = 0;
      renderer.render(scene, camera);
      lastFrameT = t;
    } else if (res.cur < res.base && ++restFrames > 8) {
      res.cur = res.base;
      renderer.setPixelRatio(res.cur);
      renderer.render(scene, camera);
    } else {
      lastFrameT = 0;
    }
  }

  window.DemoViewer = {
    init,
    setHiddenCategories,
    isHidden,
    categoryOf,
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
