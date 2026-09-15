(() => {
  "use strict";

  // ---------- Elements ----------
  const video = document.getElementById("video");
  const overlay = document.getElementById("overlay");
  const octx = overlay.getContext("2d");
  const permissionState = document.getElementById("permission-state");
  const permissionMessage = document.getElementById("permission-message");
  const retryCameraBtn = document.getElementById("retry-camera");

  const countNumber = document.getElementById("count-number");
  const torchBtn = document.getElementById("torch-btn");
  const clearBtn = document.getElementById("clear-btn");

  const toast = document.getElementById("toast");

  const sheet = document.getElementById("sheet");
  const sheetHandle = document.getElementById("sheet-handle");
  const scanList = document.getElementById("scan-list");
  const emptyState = document.getElementById("empty-state");
  const exportBtn = document.getElementById("export-btn");
  const exportMenu = document.getElementById("export-menu");
  const sheetToolbar = document.getElementById("sheet-toolbar");
  const searchInput = document.getElementById("search-input");
  const sortSelect = document.getElementById("sort-select");
  const noResults = document.getElementById("no-results");
  const addBtn = document.getElementById("add-btn");
  const copyAllBtn = document.getElementById("copy-all-btn");

  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modal-title");
  const modalInput = document.getElementById("modal-input");
  const modalCancel = document.getElementById("modal-cancel");
  const modalSave = document.getElementById("modal-save");

  // ---------- State ----------
  /** @type {Map<string, {content: string, firstSeen: number, lastSeen: number, count: number}>} */
  const scans = new Map();
  let order = []; // content keys, most recent first
  let stream = null;
  let track = null;
  let torchOn = false;
  let detecting = false;
  let useNativeDetector = false;
  let barcodeDetector = null;
  let rafId = null;
  let lastDetectTime = 0;
  const DETECT_INTERVAL = 90; // ms, ~11fps cap for battery/perf

  let query = "";
  let sortMode = "recent";
  const collapsedTypes = new Set();
  const STORAGE_KEY = "scanroll.session.v1";

  // ---------- Utilities ----------
  function vibrate(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
    }
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 2) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  function showToast(text, kind) {
    toast.textContent = text;
    toast.className = "";
    toast.classList.add("show", kind);
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.classList.remove("show");
    }, 1100);
  }

  // ---------- Content types ----------
  // Order here is the order groups appear in the results list.
  const TYPES = [
    { id: "url", label: "Links" },
    { id: "email", label: "Emails" },
    { id: "phone", label: "Phone numbers" },
    { id: "sms", label: "Messages" },
    { id: "wifi", label: "WiFi networks" },
    { id: "vcard", label: "Contacts" },
    { id: "geo", label: "Locations" },
    { id: "json", label: "JSON" },
    { id: "numeric", label: "Numeric codes" },
    { id: "text", label: "Text" },
  ];
  const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.id, t.label]));
  const TYPE_ORDER = TYPES.map((t) => t.id);
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function isJson(s) {
    if (!s.startsWith("{") && !s.startsWith("[")) return false;
    try {
      JSON.parse(s);
      return true;
    } catch (e) {
      return false;
    }
  }

  function detectType(content) {
    const s = content.trim();
    if (/^WIFI:/i.test(s)) return "wifi";
    if (/^BEGIN:VCARD/i.test(s)) return "vcard";
    if (/^geo:/i.test(s)) return "geo";
    if (/^(https?:\/\/|www\.)\S+$/i.test(s)) return "url";
    if (/^mailto:/i.test(s) || EMAIL_RE.test(s)) return "email";
    if (/^(smsto:|sms:|mms:)/i.test(s)) return "sms";
    if (/^tel:/i.test(s)) return "phone";
    if (isJson(s)) return "json";
    if (/^\d+$/.test(s)) return "numeric";
    if (/^\+?[\d(][\d\s().-]{5,}$/.test(s) && (s.match(/\d/g) || []).length >= 7) return "phone";
    return "text";
  }

  // ---------- Session persistence ----------
  function loadSession() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return; // storage unavailable (private mode)
    }
    if (!raw) return;

    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.entries)) return;
      data.entries.forEach((e) => {
        if (!e || typeof e.content !== "string" || !e.content) return;
        scans.set(e.content, {
          content: e.content,
          firstSeen: e.firstSeen || Date.now(),
          lastSeen: e.lastSeen || e.firstSeen || Date.now(),
          count: e.count || 1,
          type: detectType(e.content),
        });
      });
      order = [...scans.keys()].sort((a, b) => scans.get(b).firstSeen - scans.get(a).firstSeen);
    } catch (e) {
      // corrupt payload: start clean rather than half-loading it
      scans.clear();
      order = [];
    }
  }

  function saveSession() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          v: 1,
          entries: order.map((key) => {
            const e = scans.get(key);
            return {
              content: e.content,
              firstSeen: e.firstSeen,
              lastSeen: e.lastSeen,
              count: e.count,
            };
          }),
        })
      );
    } catch (e) {
      // over quota or storage blocked; the session just stays in-memory
    }
  }

  // ---------- Camera setup ----------
  async function startCamera() {
    permissionState.hidden = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      track = stream.getVideoTracks()[0];

      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) {
        torchBtn.hidden = false;
      }

      resizeOverlay();
      setupDetector();
      startDetectionLoop();
    } catch (err) {
      permissionState.hidden = false;
      if (err && err.name === "NotAllowedError") {
        permissionMessage.textContent = "Camera access was denied. Enable it in your browser or system settings, then try again.";
      } else if (err && err.name === "NotFoundError") {
        permissionMessage.textContent = "No camera was found on this device.";
      } else {
        permissionMessage.textContent = "Couldn't start the camera. Try again.";
      }
    }
  }

  retryCameraBtn.addEventListener("click", startCamera);

  function resizeOverlay() {
    overlay.width = overlay.clientWidth * devicePixelRatio;
    overlay.height = overlay.clientHeight * devicePixelRatio;
  }
  window.addEventListener("resize", resizeOverlay);

  // ---------- Torch ----------
  torchBtn.addEventListener("click", async () => {
    if (!track) return;
    torchOn = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: torchOn }] });
      torchBtn.classList.toggle("active", torchOn);
    } catch (e) {
      torchOn = false;
    }
  });

  // ---------- Detection ----------
  function setupDetector() {
    if ("BarcodeDetector" in window) {
      BarcodeDetector.getSupportedFormats?.().then((formats) => {
        if (formats && formats.includes("qr_code")) {
          barcodeDetector = new BarcodeDetector({ formats: ["qr_code"] });
          useNativeDetector = true;
        }
      }).catch(() => {
        // fall back silently
      });
    }
  }

  function startDetectionLoop() {
    detecting = true;
    const loop = (t) => {
      if (!detecting) return;
      if (t - lastDetectTime >= DETECT_INTERVAL) {
        lastDetectTime = t;
        runDetection();
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  const workCanvas = document.createElement("canvas");
  const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });

  async function runDetection() {
    if (video.readyState < 2 || video.videoWidth === 0) return;

    if (useNativeDetector && barcodeDetector) {
      try {
        const codes = await barcodeDetector.detect(video);
        octx.clearRect(0, 0, overlay.width, overlay.height);
        for (const c of codes) {
          drawBox(c.cornerPoints);
          handleResult(c.rawValue);
        }
      } catch (e) {
        // detector can throw on some frames; ignore and continue
      }
      return;
    }

    // jsQR fallback: single code per frame
    workCanvas.width = video.videoWidth;
    workCanvas.height = video.videoHeight;
    workCtx.drawImage(video, 0, 0, workCanvas.width, workCanvas.height);
    const imageData = workCtx.getImageData(0, 0, workCanvas.width, workCanvas.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "dontInvert",
    });
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (result) {
      const pts = [
        result.location.topLeftCorner,
        result.location.topRightCorner,
        result.location.bottomRightCorner,
        result.location.bottomLeftCorner,
      ].map((p) => ({
        x: (p.x / workCanvas.width) * overlay.clientWidth,
        y: (p.y / workCanvas.height) * overlay.clientHeight,
      }));
      drawBox(pts);
      handleResult(result.data);
    }
  }

  function drawBox(points) {
    if (!points || points.length < 4) return;
    const dpr = devicePixelRatio;
    octx.save();
    octx.scale(dpr, dpr);
    octx.strokeStyle = "#4FA876";
    octx.lineWidth = 3;
    octx.lineJoin = "round";
    octx.beginPath();
    octx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) octx.lineTo(points[i].x, points[i].y);
    octx.closePath();
    octx.stroke();
    octx.restore();
  }

  // ---------- Result handling ----------
  function handleResult(content) {
    if (!content) return;
    const now = Date.now();
    const existing = scans.get(content);

    if (existing) {
      existing.lastSeen = now;
      existing.count += 1;
      // throttle duplicate toasts/vibration so it doesn't spam while lingering on same code
      if (now - (existing.lastToast || 0) > 1200) {
        existing.lastToast = now;
        vibrate(40);
        showToast("Already scanned", "dup");
        flashRow(content);
        renderMeta(content);
        saveSession();
      }
      return;
    }

    const entry = { content, firstSeen: now, lastSeen: now, count: 1, lastToast: now, type: detectType(content) };
    scans.set(content, entry);
    order.unshift(content);

    vibrate([30, 40, 30]);
    showToast("New code saved", "new");
    saveSession();
    renderList();
    openPeekIfCollapsed();
  }

  function openPeekIfCollapsed() {
    // On the very first scan, nudge the sheet up slightly so the user notices it filling in
    if (scans.size === 1 && !sheet.classList.contains("expanded")) {
      sheet.classList.add("dragging");
      requestAnimationFrame(() => {
        sheet.style.transform = "translateY(calc(78vh - 168px))";
        setTimeout(() => {
          sheet.classList.remove("dragging");
          sheet.style.transform = "";
        }, 260);
      });
    }
  }

  // ---------- List rendering ----------
  const ICON_COPY = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';
  const ICON_EDIT = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 20h4L18 10l-4-4L4 16v4z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M14 6l4 4" stroke="currentColor" stroke-width="1.6"/></svg>';
  const ICON_DELETE = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_CHEVRON = '<svg class="chev" viewBox="0 0 24 24" width="14" height="14"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function groupEntries() {
    const q = query.trim().toLowerCase();
    const buckets = new Map();

    order.forEach((key) => {
      const entry = scans.get(key);
      if (!entry) return;
      if (q && !entry.content.toLowerCase().includes(q)) return;
      if (!buckets.has(entry.type)) buckets.set(entry.type, []);
      buckets.get(entry.type).push(entry);
    });

    const groups = [];
    TYPE_ORDER.forEach((type) => {
      const items = buckets.get(type);
      if (!items || !items.length) return;
      groups.push({ type, label: TYPE_LABEL[type], items: sortEntries(items) });
    });
    return groups;
  }

  function sortEntries(items) {
    const arr = [...items];
    if (sortMode === "count") {
      arr.sort((a, b) => b.count - a.count || b.firstSeen - a.firstSeen);
    } else if (sortMode === "az") {
      arr.sort((a, b) =>
        a.content.localeCompare(b.content, undefined, { numeric: true, sensitivity: "base" })
      );
    } else {
      arr.sort((a, b) => b.firstSeen - a.firstSeen);
    }
    return arr;
  }

  // Scan order number, newest first (1 = the code you scanned last)
  function chronologicalIndex() {
    const map = new Map();
    const total = order.length;
    order.forEach((key, i) => map.set(key, total - i));
    return map;
  }

  function toggleGroup(type) {
    if (collapsedTypes.has(type)) collapsedTypes.delete(type);
    else collapsedTypes.add(type);
    renderList();
  }

  function renderList() {
    countNumber.textContent = String(scans.size);
    exportBtn.disabled = scans.size === 0;
    copyAllBtn.disabled = scans.size === 0;
    emptyState.hidden = scans.size !== 0;

    const groups = groupEntries();
    const isSearching = query.trim() !== "";
    sheetToolbar.hidden = scans.size === 0;
    noResults.hidden = scans.size === 0 || groups.length > 0;

    const numbers = chronologicalIndex();
    scanList.innerHTML = "";

    groups.forEach((group) => {
      // While filtering, keep everything open so matches are actually visible
      const collapsed = !isSearching && collapsedTypes.has(group.type);

      const header = document.createElement("li");
      header.className = "group-header";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "group-toggle";
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.innerHTML = ICON_CHEVRON;

      const label = document.createElement("span");
      label.className = "group-label";
      label.textContent = group.label;

      const count = document.createElement("span");
      count.className = "group-count";
      count.textContent = String(group.items.length);

      toggle.appendChild(label);
      toggle.appendChild(count);
      toggle.addEventListener("click", () => toggleGroup(group.type));

      const copyGroup = document.createElement("button");
      copyGroup.type = "button";
      copyGroup.className = "group-copy";
      copyGroup.title = `Copy ${group.label}`;
      copyGroup.setAttribute("aria-label", `Copy ${group.label}`);
      copyGroup.innerHTML = ICON_COPY;
      copyGroup.addEventListener("click", () =>
        copyToClipboard(group.items.map((e) => e.content).join("\n"))
      );

      header.appendChild(toggle);
      header.appendChild(copyGroup);
      scanList.appendChild(header);

      if (collapsed) return;
      group.items.forEach((entry) => {
        scanList.appendChild(buildRow(entry, numbers.get(entry.content)));
      });
    });
  }

  function buildRow(entry, index) {
    const li = document.createElement("li");
    li.className = "scan-row";
    li.dataset.key = entry.content;

    const idx = document.createElement("div");
    idx.className = "scan-index";
    idx.textContent = String(index);

    const main = document.createElement("div");
    main.className = "scan-main";

    const val = document.createElement("div");
    val.className = "scan-value";
    val.textContent = entry.content;

    const meta = document.createElement("div");
    meta.className = "scan-meta";
    meta.innerHTML = metaHTML(entry);

    main.appendChild(val);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.appendChild(rowButton(ICON_COPY, "Copy", () => copyToClipboard(entry.content)));
    actions.appendChild(rowButton(ICON_EDIT, "Edit", () => openEditor(entry.content)));
    actions.appendChild(rowButton(ICON_DELETE, "Delete", () => deleteEntry(entry.content)));

    li.appendChild(idx);
    li.appendChild(main);
    li.appendChild(actions);
    return li;
  }

  function rowButton(icon, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.innerHTML = icon;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function metaHTML(entry) {
    const parts = [timeAgo(entry.firstSeen)];
    if (entry.count > 1) {
      parts.push(`<span class="dup-count">seen ${entry.count}×</span>`);
    }
    return parts.join(" · ");
  }

  function renderMeta(key) {
    const li = scanList.querySelector(`.scan-row[data-key="${CSS.escape(key)}"]`);
    if (!li) return;
    const meta = li.querySelector(".scan-meta");
    if (meta) meta.innerHTML = metaHTML(scans.get(key));
  }

  function flashRow(key) {
    const li = scanList.querySelector(`.scan-row[data-key="${CSS.escape(key)}"]`);
    if (!li) return;
    li.classList.remove("flash");
    void li.offsetWidth; // restart animation
    li.classList.add("flash");
  }

  // refresh relative timestamps periodically
  setInterval(() => {
    if (scans.size === 0) return;
    scanList.querySelectorAll(".scan-row").forEach((li) => {
      const meta = li.querySelector(".scan-meta");
      const entry = scans.get(li.dataset.key);
      if (meta && entry) meta.innerHTML = metaHTML(entry);
    });
  }, 5000);

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied", "new");
    } catch (e) {
      showToast("Couldn't copy", "dup");
    }
  }

  // ---------- Clear ----------
  clearBtn.addEventListener("click", () => {
    if (scans.size === 0) return;
    if (confirm(`Clear all ${scans.size} scanned codes?`)) {
      scans.clear();
      order = [];
      saveSession();
      renderList();
    }
  });

  // ---------- Export ----------
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });

  document.addEventListener("click", (e) => {
    if (!exportMenu.hidden && !exportMenu.contains(e.target) && e.target !== exportBtn) {
      exportMenu.hidden = true;
    }
  });

  exportMenu.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-format]");
    if (!btn) return;
    exportData(btn.dataset.format);
    exportMenu.hidden = true;
  });

  // Everything, ordered the way the list is grouped (type groups, then the
  // current sort). Deliberately ignores the filter box so an export never
  // silently drops codes the user has scanned.
  function entriesForExport() {
    const out = [];
    TYPE_ORDER.forEach((type) => {
      const items = order.map((k) => scans.get(k)).filter((e) => e.type === type);
      if (items.length) out.push(...sortEntries(items));
    });
    return out;
  }

  function exportData(format) {
    const entries = entriesForExport();
    let blob, filename;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    if (format === "csv") {
      const rows = [["#", "type", "content", "first_scanned", "times_seen"]];
      entries.forEach((e, i) => {
        rows.push([i + 1, e.type, csvEscape(e.content), new Date(e.firstSeen).toISOString(), e.count]);
      });
      const csv = rows.map((r) => r.join(",")).join("\n");
      blob = new Blob([csv], { type: "text/csv" });
      filename = `scanroll-${stamp}.csv`;
    } else if (format === "json") {
      const json = JSON.stringify(
        entries.map((e, i) => ({
          index: i + 1,
          type: e.type,
          typeLabel: TYPE_LABEL[e.type],
          content: e.content,
          firstScanned: new Date(e.firstSeen).toISOString(),
          timesSeen: e.count,
        })),
        null,
        2
      );
      blob = new Blob([json], { type: "application/json" });
      filename = `scanroll-${stamp}.json`;
    } else {
      const txt = entries.map((e) => e.content).join("\n");
      blob = new Blob([txt], { type: "text/plain" });
      filename = `scanroll-${stamp}.txt`;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function csvEscape(s) {
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  // ---------- Bottom sheet drag ----------
  let dragStartY = 0;
  let sheetStartTranslate = 0;
  let dragging = false;
  const EXPANDED_TRANSLATE = 0;
  let collapsedTranslate = 0;

  function computeCollapsedTranslate() {
    const sheetHeight = sheet.getBoundingClientRect().height;
    collapsedTranslate = sheetHeight - 128;
    return collapsedTranslate;
  }

  function setSheetState(expanded) {
    sheet.classList.toggle("expanded", expanded);
    sheet.classList.toggle("collapsed", !expanded);
  }

  function onDragStart(clientY) {
    dragging = true;
    sheet.classList.add("dragging");
    dragStartY = clientY;
    const style = getComputedStyle(sheet);
    const matrix = new DOMMatrixReadOnly(style.transform);
    sheetStartTranslate = matrix.m42;
    computeCollapsedTranslate();
  }

  function onDragMove(clientY) {
    if (!dragging) return;
    const delta = clientY - dragStartY;
    let next = sheetStartTranslate + delta;
    next = Math.max(EXPANDED_TRANSLATE, Math.min(collapsedTranslate, next));
    sheet.style.transform = `translateY(${next}px)`;
  }

  function onDragEnd(clientY) {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove("dragging");
    sheet.style.transform = "";
    const delta = clientY - dragStartY;
    const wasExpanded = sheet.classList.contains("expanded");
    // simple threshold: if dragged more than 40px toward collapse/expand, switch; else keep/snap based on position
    const currentTranslate = sheetStartTranslate + delta;
    const midpoint = collapsedTranslate / 2;
    setSheetState(currentTranslate < midpoint);
  }

  sheetHandle.addEventListener("touchstart", (e) => onDragStart(e.touches[0].clientY), { passive: true });
  sheetHandle.addEventListener("touchmove", (e) => onDragMove(e.touches[0].clientY), { passive: true });
  sheetHandle.addEventListener("touchend", (e) => onDragEnd(e.changedTouches[0].clientY));

  sheetHandle.addEventListener("mousedown", (e) => {
    onDragStart(e.clientY);
    const move = (ev) => onDragMove(ev.clientY);
    const up = (ev) => {
      onDragEnd(ev.clientY);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  sheetHandle.addEventListener("click", (e) => {
    if (e.target.closest("#sheet-controls")) return;
    if (Math.abs(e.detail) <= 1) {
      const expanded = sheet.classList.contains("expanded");
      setSheetState(!expanded);
    }
  });

  // ---------- Visibility handling (pause camera when backgrounded) ----------
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      detecting = false;
      if (rafId) cancelAnimationFrame(rafId);
    } else if (stream) {
      startDetectionLoop();
    }
  });

  // ---------- Service worker ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  // ---------- Row actions: add / edit / delete ----------
  let modalMode = null;

  function openModal(mode, value) {
    modalMode = mode;
    modalTitle.textContent = mode.kind === "edit" ? "Edit code" : "Add a code";
    modalInput.value = value || "";
    modal.hidden = false;
    modalInput.focus();
    modalInput.select();
  }

  function closeModal() {
    modal.hidden = true;
    modalMode = null;
  }

  function openEditor(key) {
    openModal({ kind: "edit", key }, key);
  }

  function submitModal() {
    const value = modalInput.value.trim();
    if (!value) return;

    if (modalMode && modalMode.kind === "edit") {
      const key = modalMode.key;
      if (value === key) {
        closeModal();
        return;
      }
      if (scans.has(value)) {
        showToast("That code is already saved", "dup");
        return;
      }
      const entry = scans.get(key);
      entry.content = value;
      entry.type = detectType(value);
      scans.delete(key);
      scans.set(value, entry);
      order = order.map((k) => (k === key ? value : k));
      saveSession();
      renderList();
      closeModal();
      showToast("Updated", "new");
      return;
    }

    closeModal();
    handleResult(value);
  }

  function deleteEntry(key) {
    const entry = scans.get(key);
    if (!entry) return;
    if (!confirm(`Delete this code?\n\n${entry.content}`)) return;
    scans.delete(key);
    order = order.filter((k) => k !== key);
    saveSession();
    renderList();
    showToast("Deleted", "dup");
  }

  addBtn.addEventListener("click", () => openModal({ kind: "add" }, ""));
  modalCancel.addEventListener("click", closeModal);
  modalSave.addEventListener("click", submitModal);
  modalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitModal();
    } else if (e.key === "Escape") {
      closeModal();
    }
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // ---------- Filter / sort / bulk copy ----------
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    renderList();
  });

  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value;
    renderList();
  });

  copyAllBtn.addEventListener("click", () => {
    if (scans.size === 0) return;
    copyToClipboard(order.map((k) => scans.get(k).content).join("\n"));
  });

  // ---------- Init ----------
  loadSession();
  renderList();
  startCamera();
})();
