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
    scene.fog = new THREE.FogExp2(0x090f1d, 0.0031);

    const aspect = Math.max(1, wrapper.clientWidth) / Math.max(1, wrapper.clientHeight);
    camera = new THREE.PerspectiveCamera(45, aspect, 0.5, 600);
    camera.position.set(CAM_3D.x, CAM_3D.y, CAM_3D.z);

    renderer = new THREE.WebGLRenderer({
      canvas: canvasEl,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(wrapper.clientWidth, wrapper.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minDistance = 10;
    controls.maxDistance = 240;
    controls.target.set(TARGET_3D.x, TARGET_3D.y, TARGET_3D.z);

    scene.add(new THREE.HemisphereLight(0xdbeafe, 0x0f172a, 0.85));

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(46, 80, 40);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.left = -80;
    keyLight.shadow.camera.right = 80;
    keyLight.shadow.camera.top = 70;
    keyLight.shadow.camera.bottom = -70;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.35);
    rimLight.position.set(-55, 40, -45);
    scene.add(rimLight);

    sharedMats.upright = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.65, roughness: 0.38 });
    sharedMats.beam = new THREE.MeshStandardMaterial({ color: 0xd97706, metalness: 0.35, roughness: 0.45 });
    sharedMats.stagingPad = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
    });
    sharedMats.proxy = new THREE.MeshBasicMaterial({ visible: false });
    sharedMats.pallet = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.12 });

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
      new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.88, metalness: 0.12 })
    );
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -0.04;
    floorMesh.receiveShadow = true;
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
    palletMesh.castShadow = true;
    palletMesh.receiveShadow = true;
    posts.castShadow = true;

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

    paint();
  }

  function resolveItemColor(item, bay, mode) {
    if (mode === "occupancy") {
      if (bay.occupancy_pct >= 85) return PALETTES.occupancy.high;
      if (bay.occupancy_pct >= 50) return PALETTES.occupancy.medium;
      return PALETTES.occupancy.low;
    }
    if (mode === "aging") {
      if (item.age_days > 90) return PALETTES.aging.critical;
      if (item.age_days > 30) return PALETTES.aging.warning;
      return PALETTES.aging.normal;
    }
    if (mode === "turnover") {
      if (item.turnover_days <= 15) return PALETTES.turnover.fast;
      if (item.turnover_days <= 38) return PALETTES.turnover.moderate;
      return PALETTES.turnover.slow;
    }
    if (mode === "material") return PALETTES.material[item.material_type] || PALETTES.material.OTHER;
    return 0x38bdf8;
  }

  /** Draw every slot: snapshot pallets (filters + color mode) or the projected week (weekly view). */
  function paint() {
    if (!palletMesh) return;
    const filterBays = lastFilter.bays;
    const filterItems = lastFilter.items;
    slotRecords.forEach((rec, i) => {
      let show = false;
      let hex = DIM;
      if (forecastState && rec.bay.in_capacity !== false) {
        const st = forecastState.get(rec.key);
        if (st) {
          show = true;
          hex = PALETTES.forecast[st.status] !== undefined ? PALETTES.forecast[st.status] : PALETTES.forecast.arrived;
        }
      } else if (rec.item) {
        show = true;
        if (forecastState) {
          hex = PALETTES.forecast.fixed;
        } else {
          const active =
            (!filterBays || filterBays.has(rec.bay.bay_id)) && (!filterItems || filterItems.has(rec.item.box_id));
          hex = active ? resolveItemColor(rec.item, rec.bay, currentMode) : DIM;
        }
      }
      palletMesh.setMatrixAt(i, show ? rec.matrix : HIDDEN);
      palletMesh.setColorAt(i, tmpColor.setHex(hex));
    });
    palletMesh.instanceMatrix.needsUpdate = true;
    if (palletMesh.instanceColor) palletMesh.instanceColor.needsUpdate = true;
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
    if (cameraViewMode === "3d" && window.gsap) {
      gsap.to(controls.target, { x: entry.bay.world_x, y: 2.0, z: entry.bay.world_z, duration: 0.65, ease: "power2.out" });
    }
    return entry.bay;
  }

  function clearSelection() {
    if (selectionBoxMesh && facilityRoot) {
      facilityRoot.remove(selectionBoxMesh);
      selectionBoxMesh = null;
    }
  }

  function setCameraMode(mode) {
    cameraViewMode = mode;
    if (!window.gsap) return;
    const to = mode === "2d" ? CAM_2D : CAM_3D;
    controls.enableRotate = mode !== "2d";
    gsap.to(camera.position, { x: to.x, y: to.y, z: to.z, duration: 0.9, ease: "power2.inOut", onUpdate: () => controls.update() });
    const tg = mode === "2d" ? { x: 0, y: 0, z: 0 } : TARGET_3D;
    gsap.to(controls.target, { x: tg.x, y: tg.y, z: tg.z, duration: 0.9, ease: "power2.inOut" });
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

    canvasEl.addEventListener("pointermove", (ev) => {
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
    });

    canvasEl.addEventListener("pointerleave", () => {
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
    };
    window.addEventListener("resize", onResize);
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(wrapper);
  }

  function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  window.DemoViewer = {
    init,
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
