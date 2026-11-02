/* ==========================================================================
   3D Warehouse Visualizer (Demo) — Three.js WebGL Rendering Engine
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
  };

  const ZONE_TINTS = {
    "Zone A": "#38bdf8",
    "Zone B": "#818cf8",
    "Zone C": "#34d399",
    Staging: "#fbbf24",
    Special: "#fb7185",
  };

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
  let hoveredBayId = null;
  let selectedBayId = null;
  let currentMode = "occupancy";
  let cameraViewMode = "3d";
  let onBayClickCallback = null;

  const sharedMats = {};

  function init(canvasEl, onBayClick) {
    onBayClickCallback = onBayClick;
    const wrapper = canvasEl.parentElement;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x090f1d);
    scene.fog = new THREE.FogExp2(0x090f1d, 0.0042);

    const aspect = Math.max(1, wrapper.clientWidth) / Math.max(1, wrapper.clientHeight);
    camera = new THREE.PerspectiveCamera(45, aspect, 0.5, 450);
    camera.position.set(0, 52, 62);

    renderer = new THREE.WebGLRenderer({
      canvas: canvasEl,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(wrapper.clientWidth, wrapper.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minDistance = 12;
    controls.maxDistance = 180;
    controls.target.set(0, 2, -2);

    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x0f172a, 0.85);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.05);
    keyLight.position.set(38, 68, 34);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.left = -65;
    keyLight.shadow.camera.right = 65;
    keyLight.shadow.camera.top = 55;
    keyLight.shadow.camera.bottom = -55;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.35);
    rimLight.position.set(-45, 35, -35);
    scene.add(rimLight);

    sharedMats.upright = new THREE.MeshStandardMaterial({
      color: 0x475569,
      metalness: 0.65,
      roughness: 0.38,
    });
    sharedMats.beam = new THREE.MeshStandardMaterial({
      color: 0xd97706,
      metalness: 0.35,
      roughness: 0.45,
    });
    sharedMats.stagingPad = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
    });
    sharedMats.proxy = new THREE.MeshBasicMaterial({ visible: false });

    buildBaseFloor();

    facilityRoot = new THREE.Group();
    scene.add(facilityRoot);

    raycaster = new THREE.Raycaster();
    pointerNDC = new THREE.Vector2(-10, -10);

    bindEvents(canvasEl, wrapper);
    animate();
  }

  function buildBaseFloor() {
    const floorGeo = new THREE.PlaneGeometry(150, 110);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.88,
      metalness: 0.12,
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -0.04;
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);

    const grid = new THREE.GridHelper(140, 70, 0x1e293b, 0x162033);
    grid.position.y = -0.01;
    scene.add(grid);
  }

  function clearFacilityScene() {
    if (!facilityRoot) return;
    while (facilityRoot.children.length > 0) {
      const child = facilityRoot.children[0];
      facilityRoot.remove(child);
    }
    hitProxies = [];
    bayVisualMap.clear();
    hoveredBayId = null;
    selectedBayId = null;
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

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geo = new THREE.PlaneGeometry(widthWorld, heightWorld);
    return new THREE.Mesh(geo, mat);
  }

  function loadFacility(dataset) {
    clearFacilityScene();
    if (!dataset || !Array.isArray(dataset.bays)) return;

    // 1. Render Zone Pads & Floor Labels
    (dataset.zones || []).forEach((z) => {
      const w = z.max_x - z.min_x;
      const d = z.max_z - z.min_z;
      const cx = (z.min_x + z.max_x) / 2;
      const cz = (z.min_z + z.max_z) / 2;
      const tint = ZONE_TINTS[z.zone] || "#38bdf8";

      const padGeo = new THREE.PlaneGeometry(w, d);
      const padMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(tint),
        transparent: true,
        opacity: 0.06,
        side: THREE.DoubleSide,
      });
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(cx, 0.01, cz);
      facilityRoot.add(pad);

      const borderEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.04, d));
      const borderLine = new THREE.LineSegments(
        borderEdges,
        new THREE.LineBasicMaterial({ color: new THREE.Color(tint), transparent: true, opacity: 0.4 })
      );
      borderLine.position.set(cx, 0.03, cz);
      facilityRoot.add(borderLine);

      const plaque = makeTextBanner(z.zone.toUpperCase(), tint, 7.2, 1.75, 24);
      plaque.rotation.x = -Math.PI / 2;
      plaque.position.set(cx, 0.04, z.max_z + 1.3);
      facilityRoot.add(plaque);
    });

    // Group bays by rack_id so we can place rack header signs cleanly
    const racksById = new Map();
    const levelHeight = 1.05;
    const boxGeo = new THREE.BoxGeometry(0.76, 0.66, 0.82);

    dataset.bays.forEach((bay) => {
      if (!racksById.has(bay.rack_id)) {
        racksById.set(bay.rack_id, []);
      }
      racksById.get(bay.rack_id).push(bay);

      const bayGroup = new THREE.Group();
      bayGroup.position.set(bay.world_x, 0, bay.world_z);

      const bw = bay.bay_width || 2.0;
      const bd = bay.bay_depth || 2.1;
      const totalH = bay.max_levels * levelHeight + 0.35;

      if (bay.max_levels > 1) {
        // Steel uprights + beams
        const postGeo = new THREE.BoxGeometry(0.08, totalH, 0.08);
        const corners = [
          [-bw * 0.45, -bd * 0.45],
          [bw * 0.45, -bd * 0.45],
          [-bw * 0.45, bd * 0.45],
          [bw * 0.45, bd * 0.45],
        ];
        corners.forEach(([px, pz]) => {
          const post = new THREE.Mesh(postGeo, sharedMats.upright);
          post.position.set(px, totalH / 2, pz);
          bayGroup.add(post);
        });

        const beamGeo = new THREE.BoxGeometry(bw * 0.92, 0.06, 0.06);
        for (let lvl = 1; lvl <= bay.max_levels; lvl++) {
          const y = (lvl - 1) * levelHeight + 0.14;
          const frontBeam = new THREE.Mesh(beamGeo, sharedMats.beam);
          frontBeam.position.set(0, y, bd * 0.45);
          const backBeam = new THREE.Mesh(beamGeo, sharedMats.beam);
          backBeam.position.set(0, y, -bd * 0.45);
          bayGroup.add(frontBeam, backBeam);
        }
      } else {
        // Staging floor slot pad
        const lanePad = new THREE.Mesh(new THREE.PlaneGeometry(bw * 0.9, bd * 0.9), sharedMats.stagingPad);
        lanePad.rotation.x = -Math.PI / 2;
        lanePad.position.y = 0.03;
        bayGroup.add(lanePad);
      }

      // Render cargo boxes grouped by level
      const boxRecords = [];
      const byLevel = new Map();
      (bay.items || []).forEach((item) => {
        if (!byLevel.has(item.level)) byLevel.set(item.level, []);
        byLevel.get(item.level).push(item);
      });

      byLevel.forEach((lvlItems, lvl) => {
        const shelfY = (lvl - 1) * levelHeight + 0.17;
        lvlItems.slice(0, 3).forEach((item, idx) => {
          const mat = new THREE.MeshStandardMaterial({
            color: 0x38bdf8,
            roughness: 0.36,
            metalness: 0.14,
            transparent: true,
            opacity: 0.95,
          });
          const mesh = new THREE.Mesh(boxGeo, mat);
          const count = Math.min(lvlItems.length, 3);
          const offsetX = count === 1 ? 0 : (idx - (count - 1) / 2) * 0.82;
          mesh.position.set(offsetX, shelfY + 0.35, 0);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          bayGroup.add(mesh);
          boxRecords.push({ mesh, item, bay });
        });
      });

      // Invisible hit proxy for smooth hover & click
      const proxyH = Math.max(1.4, totalH);
      const proxyMesh = new THREE.Mesh(new THREE.BoxGeometry(bw, proxyH, bd), sharedMats.proxy);
      proxyMesh.position.set(0, proxyH / 2, 0);
      proxyMesh.userData = { bayId: bay.bay_id, bay };
      bayGroup.add(proxyMesh);
      hitProxies.push(proxyMesh);

      facilityRoot.add(bayGroup);
      bayVisualMap.set(bay.bay_id, {
        bay,
        group: bayGroup,
        boxRecords,
        proxyH,
        bw,
        bd,
      });
    });

    // Add Rack ID floating badges at the front of each rack
    racksById.forEach((bays, rackId) => {
      const maxZBay = bays.reduce((acc, b) => (b.world_z > acc.world_z ? b : acc), bays[0]);
      const maxH = maxZBay.max_levels * levelHeight + 1.1;
      const tint = ZONE_TINTS[maxZBay.zone] || "#38bdf8";
      const sign = makeTextBanner(rackId, tint, 2.2, 0.62, 30);
      sign.position.set(maxZBay.world_x, maxH, maxZBay.world_z + 1.15);
      facilityRoot.add(sign);
    });
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
    if (mode === "material") {
      return PALETTES.material[item.material_type] || PALETTES.material.OTHER;
    }
    return 0x38bdf8;
  }

  function applyState(matchedBayIds, matchedItemSet, colorMode) {
    currentMode = colorMode || currentMode;
    const hasFilter = matchedBayIds !== null;

    bayVisualMap.forEach((entry, bayId) => {
      const bayMatched = !hasFilter || matchedBayIds.has(bayId);
      entry.boxRecords.forEach(({ mesh, item, bay }) => {
        const itemMatched = !matchedItemSet || matchedItemSet.has(item.box_id);
        const active = bayMatched && itemMatched;
        const hex = resolveItemColor(item, bay, currentMode);
        mesh.material.color.setHex(active ? hex : 0x1e293b);
        mesh.material.opacity = active ? 0.96 : 0.14;
        mesh.material.emissive.setHex(active ? hex : 0x000000);
        mesh.material.emissiveIntensity = active ? 0.14 : 0.0;
      });
    });
  }

  function selectBayById(bayId) {
    selectedBayId = bayId;
    if (selectionBoxMesh && facilityRoot) {
      facilityRoot.remove(selectionBoxMesh);
      selectionBoxMesh = null;
    }
    if (!bayId || !bayVisualMap.has(bayId)) return null;

    const entry = bayVisualMap.get(bayId);
    const geo = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(entry.bw + 0.25, entry.proxyH + 0.25, entry.bd + 0.25)
    );
    const mat = new THREE.LineBasicMaterial({ color: 0x38bdf8 });
    selectionBoxMesh = new THREE.LineSegments(geo, mat);
    selectionBoxMesh.position.set(
      entry.bay.world_x,
      (entry.proxyH + 0.25) / 2,
      entry.bay.world_z
    );
    facilityRoot.add(selectionBoxMesh);

    if (cameraViewMode === "3d" && window.gsap) {
      gsap.to(controls.target, {
        x: entry.bay.world_x,
        y: 2.0,
        z: entry.bay.world_z,
        duration: 0.65,
        ease: "power2.out",
      });
    }
    return entry.bay;
  }

  function clearSelection() {
    selectedBayId = null;
    if (selectionBoxMesh && facilityRoot) {
      facilityRoot.remove(selectionBoxMesh);
      selectionBoxMesh = null;
    }
  }

  function setCameraMode(mode) {
    cameraViewMode = mode;
    if (!window.gsap) return;

    if (mode === "2d") {
      controls.enableRotate = false;
      gsap.to(camera.position, {
        x: 0,
        y: 86,
        z: 0.08,
        duration: 0.9,
        ease: "power2.inOut",
        onUpdate: () => controls.update(),
      });
      gsap.to(controls.target, {
        x: 0,
        y: 0,
        z: -2,
        duration: 0.9,
        ease: "power2.inOut",
      });
    } else {
      controls.enableRotate = true;
      gsap.to(camera.position, {
        x: 0,
        y: 52,
        z: 62,
        duration: 0.9,
        ease: "power2.inOut",
        onUpdate: () => controls.update(),
      });
      gsap.to(controls.target, {
        x: 0,
        y: 2,
        z: -2,
        duration: 0.9,
        ease: "power2.inOut",
      });
    }
  }

  function resetCamera() {
    setCameraMode(cameraViewMode);
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
        hoveredBayId = bay.bay_id;
        canvasEl.style.cursor = "pointer";

        if (tooltip) {
          document.getElementById("tip-bay-id").textContent = bay.bay_id;
          document.getElementById("tip-zone").textContent = bay.zone;
          document.getElementById("tip-occ").textContent = `${bay.occupancy_pct}%`;
          document.getElementById("tip-qty").textContent = `${bay.total_qty.toLocaleString()} EA (${bay.box_count} boxes)`;
          document.getElementById("tip-age").textContent = bay.box_count > 0 ? `${bay.max_age_days} days` : "Empty";
          tooltip.style.left = `${ev.clientX}px`;
          tooltip.style.top = `${ev.clientY}px`;
          tooltip.classList.remove("hidden");
        }
      } else {
        hoveredBayId = null;
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

    window.addEventListener("resize", () => {
      if (!wrapper || !renderer || !camera) return;
      const w = Math.max(1, wrapper.clientWidth);
      const h = Math.max(1, wrapper.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
  }

  function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  }

  window.DemoViewer = {
    init,
    loadFacility,
    applyState,
    selectBayById,
    clearSelection,
    setCameraMode,
    resetCamera,
  };
})();

