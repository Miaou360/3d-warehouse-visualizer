/* ==========================================================================
   3D Warehouse Visualizer (Demo) — Application State, Filters & Analytics
   ========================================================================== */

(function () {
  "use strict";

  const LEGENDS = {
    occupancy: {
      title: "Occupancy Heatmap",
      rows: [
        { color: "#f43f5e", label: "High Density (>= 85%)" },
        { color: "#38bdf8", label: "Balanced (50% - 84%)" },
        { color: "#10b981", label: "Available (< 50%)" },
      ],
    },
    aging: {
      title: "Stock Aging Tier",
      rows: [
        { color: "#f43f5e", label: "Critical (> 90 Days)" },
        { color: "#f59e0b", label: "Warning (31 - 90 Days)" },
        { color: "#10b981", label: "Normal (<= 30 Days)" },
      ],
    },
    turnover: {
      title: "Inventory Turnover",
      rows: [
        { color: "#10b981", label: "Fast Moving (<= 15 days)" },
        { color: "#38bdf8", label: "Moderate (16 - 38 days)" },
        { color: "#a855f7", label: "Slow Moving (> 38 days)" },
      ],
    },
    material: {
      title: "Material Category",
      rows: [
        { color: "#38bdf8", label: "ROH1 - Raw Component A" },
        { color: "#818cf8", label: "ROH2 - Raw Component B" },
        { color: "#f59e0b", label: "HALB - Sub-Assembly" },
        { color: "#10b981", label: "FERT - Finished Module" },
      ],
    },
  };

  const state = {
    facilityKey: "north",
    dataset: null,
    searchQuery: "",
    zone: "ALL",
    model: "ALL",
    supplier: "ALL",
    supplierFilterText: "",
    materialType: "ALL",
    ageTier: "ALL",
    colorMode: "occupancy",
    selectedBay: null,
  };

  async function resolveDataset(key) {
    const params = new URLSearchParams(window.location.search);
    const preferApi =
      params.get("source") === "api" ||
      window.location.pathname.startsWith("/demo/") ||
      !window.DEMO_FACILITIES;

    if (preferApi && window.location.protocol.startsWith("http")) {
      try {
        const resp = await fetch(`/api/inventory?facility=${encodeURIComponent(key)}`, {
          headers: { Accept: "application/json" },
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && Array.isArray(data.bays)) {
            document.getElementById("data-source-badge").textContent = "FASTAPI SYNTHETIC";
            return data;
          }
        }
      } catch (_) {
        // Fall through to pre-generated synthetic JS bundle
      }
    }

    if (window.DEMO_FACILITIES && window.DEMO_FACILITIES[key]) {
      document.getElementById("data-source-badge").textContent = "SYNTHETIC DATA";
      return window.DEMO_FACILITIES[key];
    }
    return null;
  }

  function itemMatchesFilters(item, bay) {
    if (state.zone !== "ALL" && bay.zone !== state.zone) return false;
    if (state.model !== "ALL" && item.model !== state.model) return false;
    if (state.supplier !== "ALL" && item.supplier_code !== state.supplier) return false;
    if (state.materialType !== "ALL" && item.material_type !== state.materialType) return false;

    if (state.ageTier === "critical" && item.age_days <= 90) return false;
    if (state.ageTier === "warning" && (item.age_days <= 30 || item.age_days > 90)) return false;
    if (state.ageTier === "normal" && item.age_days > 30) return false;

    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const hay = `${bay.bay_id} ${bay.rack_id} ${item.part_no} ${item.description} ${item.model} ${item.supplier_name} ${item.box_id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function isAnyFilterActive() {
    return (
      state.zone !== "ALL" ||
      state.model !== "ALL" ||
      state.supplier !== "ALL" ||
      state.materialType !== "ALL" ||
      state.ageTier !== "ALL" ||
      state.searchQuery.length > 0
    );
  }

  function populateDropdowns(dataset) {
    const zones = new Set();
    const models = new Set();
    const suppliersMap = new Map();

    dataset.bays.forEach((bay) => {
      zones.add(bay.zone);
      (bay.items || []).forEach((it) => {
        models.add(it.model);
        suppliersMap.set(it.supplier_code, it.supplier_name);
      });
    });

    const zoneSel = document.getElementById("zone-select");
    zoneSel.innerHTML = '<option value="ALL">All Zones</option>';
    Array.from(zones).forEach((z) => {
      const opt = document.createElement("option");
      opt.value = z;
      opt.textContent = z;
      zoneSel.appendChild(opt);
    });
    zoneSel.value = state.zone;

    const modelSel = document.getElementById("model-select");
    modelSel.innerHTML = '<option value="ALL">All Models</option>';
    Array.from(models)
      .sort()
      .forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        modelSel.appendChild(opt);
      });
    modelSel.value = state.model;

    renderSupplierOptions(suppliersMap);
  }

  function renderSupplierOptions(suppliersMap) {
    const supSel = document.getElementById("supplier-select");
    const filterTxt = state.supplierFilterText.toLowerCase();
    supSel.innerHTML = '<option value="ALL">All Suppliers</option>';

    Array.from(suppliersMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([code, name]) => {
        const label = `${name} (${code})`;
        if (filterTxt && !label.toLowerCase().includes(filterTxt)) return;
        const opt = document.createElement("option");
        opt.value = code;
        opt.textContent = label;
        supSel.appendChild(opt);
      });

    if ([...supSel.options].some((o) => o.value === state.supplier)) {
      supSel.value = state.supplier;
    } else {
      state.supplier = "ALL";
      supSel.value = "ALL";
    }
  }

  function refreshDashboard() {
    const ds = state.dataset;
    if (!ds) return;

    const filterActive = isAnyFilterActive();
    const matchedBayIds = new Set();
    const matchedItemIds = new Set();

    let totalQty = 0;
    let totalBoxes = 0;
    let turnoverSum = 0;
    let critCount = 0;
    let warnCount = 0;
    let normCount = 0;

    const skus = new Set();
    const models = new Set();
    const suppliers = new Set();

    ds.bays.forEach((bay) => {
      const items = bay.items || [];
      if (items.length === 0) {
        if (!filterActive || (state.zone !== "ALL" && bay.zone === state.zone && !state.searchQuery)) {
          matchedBayIds.add(bay.bay_id);
        }
        return;
      }

      let bayHasMatch = false;
      items.forEach((it) => {
        // Count global aging buckets before ageTier filter for sidebar badges
        const baseMatch =
          (state.zone === "ALL" || bay.zone === state.zone) &&
          (state.model === "ALL" || it.model === state.model) &&
          (state.supplier === "ALL" || it.supplier_code === state.supplier) &&
          (state.materialType === "ALL" || it.material_type === state.materialType);

        if (baseMatch) {
          if (it.age_days > 90) critCount++;
          else if (it.age_days > 30) warnCount++;
          else normCount++;
        }

        if (itemMatchesFilters(it, bay)) {
          bayHasMatch = true;
          matchedItemIds.add(it.box_id);
          totalQty += it.qty;
          totalBoxes += 1;
          turnoverSum += it.turnover_days;
          skus.add(it.part_no);
          models.add(it.model);
          suppliers.add(it.supplier_code);
        }
      });

      if (bayHasMatch) {
        matchedBayIds.add(bay.bay_id);
      }
    });

    const scopedBays = ds.bays.filter((b) => state.zone === "ALL" || b.zone === state.zone);
    const occupiedScoped = scopedBays.filter((b) => b.box_count > 0).length;
    const occPct = scopedBays.length > 0 ? ((occupiedScoped / scopedBays.length) * 100).toFixed(1) : "0.0";
    const avgTurn = totalBoxes > 0 ? (turnoverSum / totalBoxes).toFixed(1) : "0.0";

    const agingBoxesInScope = filterActive && state.ageTier !== "ALL" ? totalBoxes : critCount;
    const agingShare = totalBoxes > 0 ? ((critCount / Math.max(1, critCount + warnCount + normCount)) * 100).toFixed(1) : "0.0";

    document.getElementById("kpi-total-qty").textContent = totalQty.toLocaleString();
    document.getElementById("kpi-total-boxes").textContent = `${totalBoxes.toLocaleString()} boxes`;
    document.getElementById("kpi-sku-count").textContent = skus.size.toLocaleString();
    document.getElementById("kpi-model-count").textContent = `${models.size} product models`;
    document.getElementById("kpi-occupancy").textContent = `${occPct}%`;
    document.getElementById("kpi-occupancy-bar").style.width = `${occPct}%`;
    document.getElementById("kpi-supplier-count").textContent = suppliers.size.toLocaleString();
    document.getElementById("kpi-avg-turnover").textContent = `Avg turnover: ${avgTurn} d`;
    document.getElementById("kpi-aging-boxes").textContent = agingBoxesInScope.toLocaleString();
    document.getElementById("kpi-aging-share").textContent = `${agingShare}% of scoped boxes`;

    document.getElementById("count-age-critical").textContent = critCount.toLocaleString();
    document.getElementById("count-age-warning").textContent = warnCount.toLocaleString();
    document.getElementById("count-age-normal").textContent = normCount.toLocaleString();
    document.getElementById("filtered-bay-counter").textContent = `${matchedBayIds.size} / ${ds.bays.length} bays`;

    window.DemoViewer.applyState(
      filterActive ? matchedBayIds : null,
      filterActive ? matchedItemIds : null,
      state.colorMode
    );

    renderLegend();
    if (state.selectedBay) {
      renderBayDrawer(state.selectedBay);
    }
  }

  function renderLegend() {
    const spec = LEGENDS[state.colorMode] || LEGENDS.occupancy;
    document.getElementById("legend-title").textContent = spec.title;
    const listEl = document.getElementById("legend-items");
    listEl.innerHTML = "";
    spec.rows.forEach((row) => {
      const div = document.createElement("div");
      div.className = "legend-row";
      div.innerHTML = `<span class="legend-swatch" style="background:${row.color}"></span><span>${row.label}</span>`;
      listEl.appendChild(div);
    });
  }

  function renderBayDrawer(bay) {
    state.selectedBay = bay;
    document.getElementById("drawer-bay-title").textContent = `Bay ${bay.bay_id}`;
    document.getElementById("drawer-bay-zone").textContent = `${bay.zone} · ${bay.max_levels} Shelf Level${bay.max_levels > 1 ? "s" : ""}`;
    document.getElementById("drawer-occ").textContent = `${bay.occupancy_pct}%`;
    document.getElementById("drawer-qty").textContent = `${bay.total_qty.toLocaleString()} EA`;
    document.getElementById("drawer-turn").textContent = bay.box_count > 0 ? `${bay.avg_turnover_days}d` : "--";

    const container = document.getElementById("drawer-levels-list");
    container.innerHTML = "";

    for (let lvl = bay.max_levels; lvl >= 1; lvl--) {
      const lvlItems = (bay.items || []).filter((it) => it.level === lvl);
      const card = document.createElement("div");
      card.className = "level-card";

      const head = document.createElement("div");
      head.className = "level-card-head";
      head.innerHTML = `<span>Level ${lvl}</span><span>${lvlItems.length} box${lvlItems.length === 1 ? "" : "es"}</span>`;
      card.appendChild(head);

      if (lvlItems.length === 0) {
        const empty = document.createElement("div");
        empty.className = "level-empty";
        empty.textContent = "Available empty slot";
        card.appendChild(empty);
      } else {
        lvlItems.forEach((it) => {
          const ageClass = it.age_days > 90 ? "tag-crit" : it.age_days > 30 ? "tag-warn" : "tag-normal";
          const row = document.createElement("div");
          row.className = "box-item";
          row.innerHTML = `
            <div class="box-top-row">
              <span>${it.part_no}</span>
              <span>${it.qty} ${it.uom}</span>
            </div>
            <div class="box-desc">${it.description}</div>
            <div class="box-meta-row">
              <span class="tag ${ageClass}">${it.age_days}d age</span>
              <span>${it.material_type}</span>
              <span>&middot; ${it.model}</span>
              <span>&middot; ${it.supplier_name}</span>
              <span>&middot; GR ${it.gr_date}</span>
              <span>&middot; ${it.box_id}</span>
            </div>
          `;
          card.appendChild(row);
        });
      }
      container.appendChild(card);
    }

    document.getElementById("detail-drawer").classList.add("open");
  }

  function closeDrawer() {
    state.selectedBay = null;
    document.getElementById("detail-drawer").classList.remove("open");
    window.DemoViewer.clearSelection();
  }

  async function switchFacility(facilityKey) {
    state.facilityKey = facilityKey;
    closeDrawer();
    const dataset = await resolveDataset(facilityKey);
    if (!dataset) return;
    state.dataset = dataset;

    document.getElementById("facility-subtitle").textContent = `${dataset.facility_name} — ${dataset.subtitle}`;
    state.zone = "ALL";
    state.model = "ALL";
    state.supplier = "ALL";

    populateDropdowns(dataset);
    window.DemoViewer.loadFacility(dataset);
    refreshDashboard();
  }

  function bindUI() {
    // Facility toggle
    document.querySelectorAll(".seg-btn[data-facility]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".seg-btn[data-facility]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        switchFacility(btn.dataset.facility);
      });
    });

    // Global search
    const searchInput = document.getElementById("global-search");
    const clearBtn = document.getElementById("clear-search-btn");
    searchInput.addEventListener("input", () => {
      state.searchQuery = searchInput.value.trim();
      clearBtn.classList.toggle("hidden", state.searchQuery.length === 0);
      refreshDashboard();
    });
    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      state.searchQuery = "";
      clearBtn.classList.add("hidden");
      refreshDashboard();
    });

    // Dropdowns
    document.getElementById("zone-select").addEventListener("change", (ev) => {
      state.zone = ev.target.value;
      refreshDashboard();
    });
    document.getElementById("model-select").addEventListener("change", (ev) => {
      state.model = ev.target.value;
      refreshDashboard();
    });
    document.getElementById("supplier-select").addEventListener("change", (ev) => {
      state.supplier = ev.target.value;
      refreshDashboard();
    });

    // Supplier text quick-filter
    document.getElementById("supplier-search").addEventListener("input", (ev) => {
      state.supplierFilterText = ev.target.value.trim();
      if (!state.dataset) return;
      const suppliersMap = new Map();
      state.dataset.bays.forEach((b) =>
        (b.items || []).forEach((it) => suppliersMap.set(it.supplier_code, it.supplier_name))
      );
      renderSupplierOptions(suppliersMap);
    });

    // Material pills
    document.querySelectorAll("#material-pills .pill-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#material-pills .pill-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.materialType = btn.dataset.mat;
        refreshDashboard();
      });
    });

    // Aging rows
    document.querySelectorAll(".aging-row").forEach((row) => {
      row.addEventListener("click", () => {
        const tier = row.dataset.age;
        state.ageTier = state.ageTier === tier ? "ALL" : tier;
        document.querySelectorAll(".aging-row").forEach((r) => {
          r.classList.toggle("active", r.dataset.age === state.ageTier);
        });
        refreshDashboard();
      });
    });

    // Reset filters
    document.getElementById("reset-filters-btn").addEventListener("click", () => {
      state.searchQuery = "";
      state.zone = "ALL";
      state.model = "ALL";
      state.supplier = "ALL";
      state.supplierFilterText = "";
      state.materialType = "ALL";
      state.ageTier = "ALL";

      document.getElementById("global-search").value = "";
      document.getElementById("clear-search-btn").classList.add("hidden");
      document.getElementById("supplier-search").value = "";
      document.querySelectorAll("#material-pills .pill-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.mat === "ALL");
      });
      document.querySelectorAll(".aging-row").forEach((r) => r.classList.remove("active"));

      if (state.dataset) populateDropdowns(state.dataset);
      refreshDashboard();
    });

    // Camera modes
    const btn3d = document.getElementById("btn-view-3d");
    const btn2d = document.getElementById("btn-view-2d");
    btn3d.addEventListener("click", () => {
      btn3d.classList.add("active");
      btn2d.classList.remove("active");
      window.DemoViewer.setCameraMode("3d");
    });
    btn2d.addEventListener("click", () => {
      btn2d.classList.add("active");
      btn3d.classList.remove("active");
      window.DemoViewer.setCameraMode("2d");
    });
    document.getElementById("btn-reset-cam").addEventListener("click", () => {
      window.DemoViewer.resetCamera();
    });

    // Heatmap color modes
    document.querySelectorAll("#heatmap-buttons .tool-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#heatmap-buttons .tool-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.colorMode = btn.dataset.mode;
        refreshDashboard();
      });
    });

    document.getElementById("drawer-close-btn").addEventListener("click", closeDrawer);

    // Clock
    const clockEl = document.getElementById("clock-display");
    const tickClock = () => {
      const now = new Date();
      clockEl.textContent = now.toLocaleString("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    };
    tickClock();
    setInterval(tickClock, 1000);
  }

  window.DemoApp = {
    openBayById: (bayId) => {
      const bay = window.DemoViewer.selectBayById(bayId);
      if (bay) renderBayDrawer(bay);
    },
    getState: () => state,
  };

  window.addEventListener("DOMContentLoaded", () => {
    const canvas = document.getElementById("three-canvas");
    window.DemoViewer.init(canvas, (bay) => renderBayDrawer(bay));
    bindUI();
    switchFacility("north");
  });
})();
