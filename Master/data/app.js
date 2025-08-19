// Global variables
let countdownIntervals = {};
let queuedSlaves = [];
let socket = null;
let outbox = []; // queued messages while WS connects
let wsOpen = false;
let reconnectTimer = null;
let currentView = "cards"; // 'cards' or 'network'
let networkNodes = {}; // Store network node positions
let selectedNode = null;

// --- WebSocket bootstrap with auto-reconnect ---
function connectWS() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  )
    return;

  socket = new WebSocket(`ws://${window.location.host}/ws`);

  socket.addEventListener("open", () => {
    wsOpen = true;
    console.log("WebSocket connected");
    // flush outbox
    while (outbox.length) socket.send(outbox.shift());
    // optional hello
    sendWS({ action: "hello" });
  });

  socket.addEventListener("close", () => {
    wsOpen = false;
    console.log("WebSocket disconnected");
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    wsOpen = false;
    console.log("WebSocket error");
    socket.close();
  });

  socket.addEventListener("message", handleWebSocketMessage);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 1000);
}

function sendWS(obj) {
  const s = JSON.stringify(obj);
  if (wsOpen && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(s);
  } else {
    outbox.push(s);
    connectWS();
  }
}

// --- App init/unload ---
window.addEventListener("load", () => {
  connectWS();

  const qb = document.getElementById("queue-button");
  if (qb) qb.addEventListener("click", showSlaveQueue);

  // Tab switching
  const cardsTab = document.getElementById("cards-tab");
  const networkTab = document.getElementById("network-tab");

  if (cardsTab) cardsTab.addEventListener("click", () => switchView("cards"));
  if (networkTab)
    networkTab.addEventListener("click", () => switchView("network"));

  // Network view controls
  const closePanel = document.getElementById("close-panel");
  if (closePanel) closePanel.addEventListener("click", closeInfoPanel);

  // Initialize network view
  initializeNetworkView();
});

window.addEventListener("beforeunload", () => {
  if (socket) socket.close();
});

// --- Enhanced WS Data Handler ---
function handleWebSocketMessage(event) {
  try {
    const data = JSON.parse(event.data);
    if (!data.active && !data.queued) {
      // acks/etc; ignore
      return;
    }

    // Store the last received data for network view
    window.lastReceivedData = data;

    const activeSlaves = data.active || [];
    const queuedSlaves = data.queued || [];

    // Update global queued slaves array
    window.queuedSlaves = queuedSlaves;
    updateQueueButton();

    // Update cards view
    if (currentView === "cards") {
      updateCardsView(activeSlaves);
    }

    // Update network view
    if (currentView === "network") {
      updateNetworkView();
    }

    // Update info panel if open
    if (selectedNode && selectedNode !== "master") {
      const allSlaves = [...activeSlaves, ...queuedSlaves];
      const slave = allSlaves.find((s) => s.id == selectedNode);
      if (slave) {
        showSlaveInfo(slave);
      }
    } else if (selectedNode === "master") {
      showMasterInfo();
    }
  } catch (e) {
    // ignore non-object payloads (acks)
  }
}

function updateCardsView(activeSlaves) {
  const grid = document.getElementById("dashboard-grid");
  const template = document.getElementById("slave-card-template");
  if (!grid || !template) return;

  const existingIds = new Set([...grid.children].map((c) => c.dataset.id));
  const incomingIds = new Set(activeSlaves.map((s) => s.id.toString()));

  // Remove cards for slaves that are no longer active
  existingIds.forEach((id) => {
    if (!incomingIds.has(id)) {
      const el = grid.querySelector(`.card[data-id='${id}']`);
      if (el) el.remove();
    }
  });

  // Update or create cards for active slaves
  activeSlaves.forEach((slave) => {
    let card = grid.querySelector(`.card[data-id='${slave.id}']`);
    if (!card) {
      card = template.content.cloneNode(true).firstElementChild;
      card.dataset.id = slave.id;
      grid.appendChild(card);

      // wire up once
      card
        .querySelector(".rename-button")
        ?.addEventListener("click", () => sendRenameCommand(slave.id));
      card
        .querySelector(".close-button")
        ?.addEventListener("click", () => deactivateSlaveId(slave.id));

      card
        .querySelector(".toggle-advanced-button")
        ?.addEventListener("click", (e) => toggleAdvancedControls(e, card));

      card
        .querySelector(".role-button")
        ?.addEventListener("click", () => setDeviceRole(slave.id, card));
      card
        .querySelector(".interval-button")
        ?.addEventListener("click", () => setReportingInterval(slave.id, card));
      card
        .querySelector(".sleep-button")
        ?.addEventListener("click", () => setSleepDuration(slave.id, card));
      card
        .querySelector(".gpio-button")
        ?.addEventListener("click", () => setGpioState(slave.id, card));
      card
        .querySelector(".analog-button")
        ?.addEventListener("click", () => requestAnalogReading(slave.id, card));
      card
        .querySelector(".tx-power-button")
        ?.addEventListener("click", () => setTransmitPower(slave.id, card));
      card
        .querySelector(".ping-button")
        ?.addEventListener("click", () => pingSlave(slave.id));

      card
        .querySelector(".reset-button")
        ?.addEventListener("click", () => resetSlave(slave.id));
      card
        .querySelector(".factory-reset-button")
        ?.addEventListener("click", () => factoryResetSlave(slave.id));

      // Power button
      card
        .querySelector(".power-button")
        ?.addEventListener("click", () => togglePowerMode(slave.id));
      card
        .querySelector(".debug-mode")
        ?.addEventListener("change", () => toggleDebugMode(slave.id));
    }

    // populate
    card.querySelector(".slave-name").textContent = slave.name;
    card.querySelector(".slave-counter").textContent = slave.counter;

    const statusPill = card.querySelector(".status-pill");
    statusPill.textContent = slave.status;
    statusPill.className = `status-pill status-${slave.status.toLowerCase()}`;

    updatePowerUI(card, slave);
    updateAdvancedFields(card, slave);
  });
}

// --- Power UI (no client-side wake-up loop) ---
function updatePowerUI(card, slave) {
  const powerButton = card.querySelector(".power-button");
  const timerSection = card.querySelector(".timer-section");

  // Update card sleeping state - only when in power save mode and not waking up
  if (slave.isPowerSave && !slave.wakeUpPending) {
    card.classList.add("sleeping");
  } else {
    card.classList.remove("sleeping");
  }

  if (powerButton) {
    if (slave.wakeUpPending) {
      powerButton.textContent = "Waking Up...";
      powerButton.className = "power-button pending";
    } else if (slave.isPowerSave) {
      powerButton.textContent = "Power Save ON";
      powerButton.className = "power-button inactive";
    } else {
      powerButton.textContent = "Power Save OFF";
      powerButton.className = "power-button active";
    }
  }

  // Simplify: no misleading countdown; hide it unless you truly want a cosmetic timer
  if (timerSection) {
    if (slave.isPowerSave || slave.wakeUpPending) {
      timerSection.style.display = "none"; // hide to avoid lying timer
      stopCountdown(slave.id);
    } else {
      timerSection.style.display = "none";
      stopCountdown(slave.id);
    }
  }
}

function startCountdown(slaveId, card) {
  if (countdownIntervals[slaveId]) return;
  let timeLeft = 60;
  const el = card.querySelector(".timer-countdown");
  if (el) el.textContent = `${timeLeft}s`;
  countdownIntervals[slaveId] = setInterval(() => {
    timeLeft = Math.max(0, timeLeft - 1);
    if (el) el.textContent = `${timeLeft}s`;
    if (timeLeft === 0) stopCountdown(slaveId);
  }, 1000);
}
function stopCountdown(slaveId) {
  clearInterval(countdownIntervals[slaveId]);
  delete countdownIntervals[slaveId];
}

// --- Commands (all WS) ---
function sendRenameCommand(slaveId) {
  const card = document.querySelector(`.card[data-id='${slaveId}']`);
  const input = card.querySelector(".rename-input");
  const name = input.value.trim();
  if (!name) return;
  sendWS({ action: "rename", id: slaveId, name });
  input.value = "";
}

function togglePowerMode(slaveId) {
  const card = document.querySelector(`.card[data-id='${slaveId}']`);
  const powerButton = card?.querySelector(".power-button");

  // Toggle between on and off based on current state
  let mode;
  if (powerButton) {
    mode = powerButton.classList.contains("active") ? "on" : "off";
  } else {
    // If called from network view, determine mode from slave data
    const allSlaves = [
      ...(window.lastReceivedData?.active || []),
      ...(window.lastReceivedData?.queued || []),
    ];
    const slave = allSlaves.find((s) => s.id == slaveId);
    mode = slave?.isPowerSave ? "off" : "on";
  }

  // send once; master handles wakeUpPending + resend on check-in
  sendWS({ action: "power", id: slaveId, mode });
}

function deactivateSlaveId(slaveId) {
  if (!confirm(`Move slave #${slaveId} to queue?`)) return;
  sendWS({ action: "deactivate", id: slaveId });
}

function activateSlaveFromQueue(slaveId) {
  sendWS({ action: "activate", id: slaveId });
}

function releaseSlaveId(slaveId) {
  if (!confirm(`Permanently remove slave #${slaveId}?`)) return;
  sendWS({ action: "release", id: slaveId });
}

function setDeviceRole(slaveId, card) {
  const input = card.querySelector(".role-input");
  const role = input.value.trim();
  if (!role) return;
  input.placeholder = `Device role (current: ${role})`;
  sendWS({ action: "role", id: slaveId, role });
  input.value = "";
}

function setReportingInterval(slaveId, card) {
  const input = card.querySelector(".interval-input");
  const v = parseInt(input.value, 10);
  if (Number.isFinite(v) && v >= 500) {
    input.placeholder = `Report interval (current: ${v}ms)`;
    sendWS({ action: "reporting", id: slaveId, interval: v });
    input.value = "";
  }
}

function setSleepDuration(slaveId, card) {
  const input = card.querySelector(".sleep-input");
  const s = parseInt(input.value, 10);
  if (Number.isFinite(s) && s >= 10) {
    input.placeholder = `Sleep duration (current: ${s}s)`;
    sendWS({ action: "sleep_duration", id: slaveId, seconds: s });
    input.value = "";
  }
}

function setGpioState(slaveId, card) {
  const pin = parseInt(card.querySelector(".gpio-pin").value, 10);
  const state = parseInt(card.querySelector(".gpio-state").value, 10);
  sendWS({ action: "gpio", id: slaveId, pin, state });
}

function requestAnalogReading(slaveId, card) {
  const pin = parseInt(card.querySelector(".analog-pin").value, 10);
  sendWS({ action: "analog", id: slaveId, pin });
}

function setTransmitPower(slaveId, card) {
  const power = parseInt(card.querySelector(".tx-power").value, 10);
  sendWS({ action: "tx_power", id: slaveId, power });
}

function pingSlave(slaveId) {
  sendWS({ action: "ping", id: slaveId });
}

function toggleDebugMode(slaveId) {
  const card = document.querySelector(`.card[data-id='${slaveId}']`);
  if (card) {
    const enable = card.querySelector(".debug-mode").value === "1";
    sendWS({ action: "debug", id: slaveId, enable });
  } else {
    // Called from network view, toggle current state
    const allSlaves = [
      ...(window.lastReceivedData?.active || []),
      ...(window.lastReceivedData?.queued || []),
    ];
    const slave = allSlaves.find((s) => s.id == slaveId);
    const enable = !slave?.debugMode;
    sendWS({ action: "debug", id: slaveId, enable });
  }
}

function resetSlave(slaveId) {
  if (confirm(`Reset slave #${slaveId}?`))
    sendWS({ action: "reset", id: slaveId });
}

function factoryResetSlave(slaveId) {
  if (
    confirm(`FACTORY RESET slave #${slaveId}? This will erase all settings.`)
  ) {
    sendWS({ action: "factory_reset", id: slaveId });
  }
}

function triggerImmediateReport(slaveId) {
  sendWS({ action: "trigger_report", id: slaveId });
}

// --- Queue modal helpers ---
function updateQueueButton() {
  const queueButton = document.getElementById("queue-button");
  if (!queueButton) return;
  const queueCount = window.queuedSlaves ? window.queuedSlaves.length : 0;
  queueButton.textContent = `Queue (${queueCount})`;
  queueButton.style.display = queueCount > 0 ? "block" : "none";
}

function showSlaveQueue() {
  let modal = document.getElementById("queue-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "queue-modal";
    modal.className = "modal";
    const content = document.createElement("div");
    content.className = "modal-content";
    const closeBtn = document.createElement("span");
    closeBtn.className = "close-modal";
    closeBtn.innerHTML = "&times;";
    closeBtn.onclick = hideSlaveQueue;
    const header = document.createElement("h2");
    header.textContent = "Queued Slaves";
    const list = document.createElement("div");
    list.id = "queue-list";
    content.appendChild(closeBtn);
    content.appendChild(header);
    content.appendChild(list);
    modal.appendChild(content);
    document.body.appendChild(modal);
  }

  const list = document.getElementById("queue-list");
  list.innerHTML = "";

  if (!window.queuedSlaves || window.queuedSlaves.length === 0) {
    list.innerHTML = "<p>No slaves in the queue</p>";
  } else {
    window.queuedSlaves.forEach((slave) => {
      const item = document.createElement("div");
      item.className = "queue-item";
      const info = document.createElement("div");
      info.className = "queue-item-info";
      info.innerHTML = `<strong>${slave.name}</strong> (ID: ${slave.id}) <span>Status: ${slave.status}</span>`;

      const actions = document.createElement("div");
      actions.className = "queue-actions";

      const activate = document.createElement("button");
      activate.className = "activate-button";
      activate.textContent = "Activate";
      activate.onclick = () => {
        activateSlaveFromQueue(slave.id);
        showSlaveQueue(); // Refresh the modal
      };

      const remove = document.createElement("button");
      remove.className = "remove-button";
      remove.textContent = "Remove";
      remove.onclick = () => {
        if (
          confirm(`Permanently remove slave "${slave.name}" (ID: ${slave.id})?`)
        ) {
          releaseSlaveId(slave.id);
          showSlaveQueue(); // Refresh the modal
        }
      };

      actions.appendChild(activate);
      actions.appendChild(remove);
      item.appendChild(info);
      item.appendChild(actions);
      list.appendChild(item);
    });
  }
  modal.style.display = "block";
}

function hideSlaveQueue() {
  const m = document.getElementById("queue-modal");
  if (m) m.style.display = "none";
}

// --- Advanced fields/UI updates ---
function toggleAdvancedControls(event, card) {
  const section = card.querySelector(".advanced-controls");
  const btn = card.querySelector(".toggle-advanced-button");
  const isHidden = window.getComputedStyle(section).display === "none";
  section.style.display = isHidden ? "block" : "none";
  btn.textContent = isHidden ? "Hide Settings" : "Show Settings";
}

function updateAdvancedFields(card, slave) {
  const roleInput = card.querySelector(".role-input");
  if (roleInput && slave.deviceRole) {
    roleInput.placeholder = `Device role (current: ${slave.deviceRole})`;
  }
  const intervalInput = card.querySelector(".interval-input");
  if (intervalInput && slave.reportingInterval) {
    intervalInput.placeholder = `Report interval (current: ${slave.reportingInterval}ms)`;
  }

  const debugModeSelect = card.querySelector(".debug-mode");
  if (debugModeSelect) debugModeSelect.value = slave.debugMode ? "1" : "0";

  if (slave.analogReadings && slave.analogReadings.length > 0) {
    let analogSection = card.querySelector(".analog-readings");
    if (!analogSection) {
      analogSection = document.createElement("div");
      analogSection.className = "data-section analog-readings";
      const label = document.createElement("p");
      label.className = "label";
      label.textContent = "ANALOG READINGS";
      const readings = document.createElement("div");
      readings.className = "analog-values";
      analogSection.appendChild(label);
      analogSection.appendChild(readings);
      const firstData = card.querySelector(".data-section");
      firstData.parentNode.insertBefore(analogSection, firstData.nextSibling);
    }
    const readingsContainer = analogSection.querySelector(".analog-values");
    readingsContainer.innerHTML = "";
    slave.analogReadings.forEach((reading, i) => {
      if (reading > 0) {
        const el = document.createElement("div");
        el.className = "analog-reading";
        el.innerHTML = `<span>ADC ${i}:</span> <strong>${reading}</strong>`;
        readingsContainer.appendChild(el);
      }
    });
    analogSection.style.display =
      readingsContainer.children.length > 0 ? "block" : "none";
  }
}

// --- View Switching Functions ---
function switchView(view) {
  const cardsTab = document.getElementById("cards-tab");
  const networkTab = document.getElementById("network-tab");
  const dashboardGrid = document.getElementById("dashboard-grid");
  const networkView = document.getElementById("network-view");

  currentView = view;

  if (view === "cards") {
    cardsTab.classList.add("active");
    networkTab.classList.remove("active");
    dashboardGrid.style.display = "grid";
    networkView.style.display = "none";
  } else if (view === "network") {
    networkTab.classList.add("active");
    cardsTab.classList.remove("active");
    dashboardGrid.style.display = "none";
    networkView.style.display = "block";
    updateNetworkView();
  }
}

// --- Network View Functions ---
function initializeNetworkView() {
  const canvas = document.getElementById("network-canvas");
  if (!canvas) return;

  // Create master node
  createMasterNode(canvas);

  // Add network controls
  const controls = document.createElement("div");
  controls.className = "network-controls";
  controls.innerHTML = `
    <button class="network-control-button" onclick="resetNodePositions()">Reset Layout</button>
    <button class="network-control-button" onclick="autoArrangeNodes()">Auto Arrange</button>
  `;
  canvas.appendChild(controls);
}

function createMasterNode(canvas) {
  const masterNode = document.createElement("div");
  masterNode.className = "network-node master-node";
  masterNode.id = "master-node";
  masterNode.innerHTML = `
    <div class="node-icon">⚡</div>
    <div class="node-label">MASTER</div>
  `;

  // Position master in center
  const centerX = canvas.offsetWidth / 2 - 60;
  const centerY = canvas.offsetHeight / 2 - 60;
  masterNode.style.left = centerX + "px";
  masterNode.style.top = centerY + "px";

  // Add click handler
  masterNode.addEventListener("click", () => showMasterInfo());

  // Make draggable
  makeDraggable(masterNode);

  canvas.appendChild(masterNode);
  networkNodes["master"] = { x: centerX, y: centerY, element: masterNode };
}

function updateNetworkView() {
  if (currentView !== "network") return;

  const canvas = document.getElementById("network-canvas");
  if (!canvas) return;

  // Clear existing slave nodes and connections
  const existingSlaves = canvas.querySelectorAll(".slave-node");
  const existingConnections = canvas.querySelectorAll(".connection-line");
  existingSlaves.forEach((node) => node.remove());
  existingConnections.forEach((line) => line.remove());

  // Get all slaves (active + queued)
  const activeSlaves = window.lastReceivedData?.active || [];
  const queuedSlaves = window.lastReceivedData?.queued || [];
  const allSlaves = [
    ...activeSlaves.map((s) => ({ ...s, isActive: true })),
    ...queuedSlaves.map((s) => ({ ...s, isActive: false })),
  ];

  // Create slave nodes
  allSlaves.forEach((slave, index) => {
    createSlaveNode(canvas, slave, index, allSlaves.length);
  });

  // Draw connections
  drawConnections(canvas);
}

function createSlaveNode(canvas, slave, index, total) {
  const slaveNode = document.createElement("div");
  slaveNode.className = `network-node slave-node ${
    !slave.isActive ? "queued" : ""
  } ${slave.status === "Offline" ? "offline" : ""} ${
    slave.isPowerSave ? "sleeping" : ""
  }`;
  slaveNode.id = `slave-node-${slave.id}`;

  const icon = getSlaveIcon(slave);
  slaveNode.innerHTML = `
    <div class="node-icon">${icon}</div>
    <div class="node-label">${slave.name}</div>
    <div class="node-counter">${slave.counter}</div>
  `;

  // Position node (circular arrangement around master if no saved position)
  let nodeData = networkNodes[`slave-${slave.id}`];
  if (!nodeData) {
    const angle = (index / total) * 2 * Math.PI;
    const radius = slave.isActive ? 200 : 120;
    const masterNode = networkNodes["master"];
    const x = masterNode.x + 60 + Math.cos(angle) * radius - 40;
    const y = masterNode.y + 60 + Math.sin(angle) * radius - 40;

    slaveNode.style.left = x + "px";
    slaveNode.style.top = y + "px";
    networkNodes[`slave-${slave.id}`] = { x, y, element: slaveNode };
  } else {
    slaveNode.style.left = nodeData.x + "px";
    slaveNode.style.top = nodeData.y + "px";
    nodeData.element = slaveNode;
  }

  // Add click handler
  slaveNode.addEventListener("click", () => showSlaveInfo(slave));

  // Make draggable
  makeDraggable(slaveNode);

  canvas.appendChild(slaveNode);
}

function getSlaveIcon(slave) {
  if (!slave.isActive) return "⏸️";
  if (slave.status === "Offline") return "⚫";
  if (slave.isPowerSave) return "💤";

  // Role-based icons
  const role = slave.deviceRole?.toLowerCase() || "";
  if (role.includes("sensor")) return "📊";
  if (role.includes("temperature")) return "🌡️";
  if (role.includes("light")) return "💡";
  if (role.includes("motion")) return "🚶";
  if (role.includes("camera")) return "📷";

  return "📡";
}

function drawConnections(canvas) {
  const masterNode = networkNodes["master"];
  if (!masterNode) return;

  Object.keys(networkNodes).forEach((nodeKey) => {
    if (nodeKey === "master" || !nodeKey.startsWith("slave-")) return;

    const slaveNode = networkNodes[nodeKey];
    if (!slaveNode) return;

    const line = document.createElement("div");
    line.className = "connection-line";

    // Determine line style based on slave status
    const slaveElement = slaveNode.element;
    if (slaveElement.classList.contains("queued")) {
      line.classList.add("queued");
    } else if (slaveElement.classList.contains("offline")) {
      line.classList.add("weak");
    }

    // Calculate line position and rotation
    const masterCenterX = masterNode.x + 60;
    const masterCenterY = masterNode.y + 60;
    const slaveCenterX = slaveNode.x + 40;
    const slaveCenterY = slaveNode.y + 40;

    const deltaX = slaveCenterX - masterCenterX;
    const deltaY = slaveCenterY - masterCenterY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const angle = Math.atan2(deltaY, deltaX);

    line.style.left = masterCenterX + "px";
    line.style.top = masterCenterY + "px";
    line.style.width = distance + "px";
    line.style.transform = `rotate(${angle}rad)`;

    canvas.appendChild(line);
  });
}

function makeDraggable(element) {
  let isDragging = false;
  let startX, startY, initialX, initialY;

  element.addEventListener("mousedown", startDrag);

  function startDrag(e) {
    if (e.target.closest(".panel-button, .panel-input, .close-button")) return;

    isDragging = true;
    element.classList.add("dragging");

    startX = e.clientX;
    startY = e.clientY;

    const rect = element.getBoundingClientRect();
    const canvasRect = element.parentElement.getBoundingClientRect();
    initialX = rect.left - canvasRect.left;
    initialY = rect.top - canvasRect.top;

    document.addEventListener("mousemove", drag);
    document.addEventListener("mouseup", stopDrag);
    e.preventDefault();
  }

  function drag(e) {
    if (!isDragging) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    const newX = Math.max(
      0,
      Math.min(
        initialX + deltaX,
        element.parentElement.offsetWidth - element.offsetWidth
      )
    );
    const newY = Math.max(
      0,
      Math.min(
        initialY + deltaY,
        element.parentElement.offsetHeight - element.offsetHeight
      )
    );

    element.style.left = newX + "px";
    element.style.top = newY + "px";

    // Update stored position
    const nodeKey =
      element.id === "master-node"
        ? "master"
        : element.id.replace("slave-node-", "slave-");
    if (networkNodes[nodeKey]) {
      networkNodes[nodeKey].x = newX;
      networkNodes[nodeKey].y = newY;
    }

    // Redraw connections
    if (currentView === "network") {
      const canvas = document.getElementById("network-canvas");
      const existingConnections = canvas.querySelectorAll(".connection-line");
      existingConnections.forEach((line) => line.remove());
      drawConnections(canvas);
    }
  }

  function stopDrag() {
    isDragging = false;
    element.classList.remove("dragging");
    document.removeEventListener("mousemove", drag);
    document.removeEventListener("mouseup", stopDrag);
  }
}

// --- Info Panel Functions ---
function showMasterInfo() {
  const panel = document.getElementById("node-info-panel");
  const title = document.getElementById("panel-title");
  const content = document.getElementById("panel-content");

  title.textContent = "Master Node";

  const activeCount = window.lastReceivedData?.active?.length || 0;
  const queuedCount = window.lastReceivedData?.queued?.length || 0;

  content.innerHTML = `
    <div class="panel-section">
      <h4>Network Status</h4>
      <div class="panel-data">
        <div class="panel-data-item">
          <div class="label">Active Slaves</div>
          <div class="value">${activeCount}</div>
        </div>
        <div class="panel-data-item">
          <div class="label">Queued Slaves</div>
          <div class="value">${queuedCount}</div>
        </div>
      </div>
    </div>
    <div class="panel-section">
      <h4>Network Controls</h4>
      <div class="panel-controls">
        <button class="panel-button" onclick="showSlaveQueue()">Manage Queue</button>
        <button class="panel-button" onclick="resetNodePositions()">Reset Layout</button>
        <button class="panel-button" onclick="autoArrangeNodes()">Auto Arrange</button>
      </div>
    </div>
  `;

  panel.classList.remove("hidden");
  selectedNode = "master";
}

function showSlaveInfo(slave) {
  const panel = document.getElementById("node-info-panel");
  const title = document.getElementById("panel-title");
  const content = document.getElementById("panel-content");

  title.textContent = `${slave.name} (ID: ${slave.id})`;

  const statusClass = slave.status === "Online" ? "success" : "error";
  const powerStatus = slave.isPowerSave ? "Sleep Mode" : "Active";

  let analogReadingsHtml = "";
  if (slave.analogReadings && slave.analogReadings.some((r) => r > 0)) {
    analogReadingsHtml = `
      <div class="panel-section">
        <h4>Analog Readings</h4>
        <div class="panel-data">
          ${slave.analogReadings
            .map((reading, i) =>
              reading > 0
                ? `
              <div class="panel-data-item">
                <div class="label">ADC ${i}</div>
                <div class="value">${reading}</div>
              </div>
            `
                : ""
            )
            .join("")}
        </div>
      </div>
    `;
  }

  content.innerHTML = `
    <div class="panel-section">
      <h4>Status</h4>
      <div class="panel-data">
        <div class="panel-data-item">
          <div class="label">Connection</div>
          <div class="value" style="color: ${
            slave.status === "Online"
              ? "var(--success-color)"
              : "var(--error-color)"
          }">${slave.status}</div>
        </div>
        <div class="panel-data-item">
          <div class="label">Mode</div>
          <div class="value">${slave.isActive ? "Active" : "Queued"}</div>
        </div>
        <div class="panel-data-item">
          <div class="label">Power</div>
          <div class="value">${powerStatus}</div>
        </div>
        <div class="panel-data-item">
          <div class="label">Heartbeat</div>
          <div class="value">${slave.counter}</div>
        </div>
      </div>
    </div>
    
    <div class="panel-section">
      <h4>Device Info</h4>
      <div class="panel-data">
        <div class="panel-data-item">
          <div class="label">Role</div>
          <div class="value">${slave.deviceRole || "Not Set"}</div>
        </div>
        <div class="panel-data-item">
          <div class="label">Debug Mode</div>
          <div class="value">${slave.debugMode ? "ON" : "OFF"}</div>
        </div>
        <div class="panel-data-item">
          <div class="label">Report Interval</div>
          <div class="value">${slave.reportingInterval || "Default"}ms</div>
        </div>
        <div class="panel-data-item">
          <div class="label">Ping Response</div>
          <div class="value">${slave.pingResponse ? "Yes" : "No"}</div>
        </div>
      </div>
    </div>

    ${analogReadingsHtml}
    
    <div class="panel-section">
      <h4>Quick Controls</h4>
      <div class="panel-controls">
        <div class="panel-control-group">
          <input type="text" class="panel-input" id="quick-rename" placeholder="New name...">
          <button class="panel-button" onclick="quickRename(${
            slave.id
          })">Rename</button>
        </div>
        <div class="panel-control-group">
          <button class="panel-button" onclick="togglePowerMode(${slave.id})">${
    slave.isPowerSave ? "Wake Up" : "Sleep"
  }</button>
          <button class="panel-button" onclick="pingSlave(${
            slave.id
          })">Ping</button>
        </div>
        <div class="panel-control-group">
          <button class="panel-button" onclick="triggerImmediateReport(${
            slave.id
          })">Report Now</button>
          <button class="panel-button" onclick="toggleDebugMode(${slave.id})">${
    slave.debugMode ? "Debug OFF" : "Debug ON"
  }</button>
        </div>
        ${
          slave.isActive
            ? `
          <div class="panel-control-group">
            <button class="panel-button" onclick="deactivateSlaveId(${slave.id})">Move to Queue</button>
            <button class="panel-button danger" onclick="releaseSlaveId(${slave.id})">Release</button>
          </div>
        `
            : `
          <div class="panel-control-group">
            <button class="panel-button" onclick="activateSlaveFromQueue(${slave.id})">Activate</button>
            <button class="panel-button danger" onclick="releaseSlaveId(${slave.id})">Remove</button>
          </div>
        `
        }
      </div>
    </div>
  `;

  panel.classList.remove("hidden");
  selectedNode = slave.id;
}

function closeInfoPanel() {
  const panel = document.getElementById("node-info-panel");
  panel.classList.add("hidden");
  selectedNode = null;
}

// --- Network Layout Functions ---
function resetNodePositions() {
  const canvas = document.getElementById("network-canvas");
  if (!canvas) return;

  // Reset master to center
  const centerX = canvas.offsetWidth / 2 - 60;
  const centerY = canvas.offsetHeight / 2 - 60;
  const masterNode = document.getElementById("master-node");
  if (masterNode) {
    masterNode.style.left = centerX + "px";
    masterNode.style.top = centerY + "px";
    networkNodes["master"] = { x: centerX, y: centerY, element: masterNode };
  }

  // Reset slaves in circular arrangement
  const slaveNodes = canvas.querySelectorAll(".slave-node");
  const totalSlaves = slaveNodes.length;

  slaveNodes.forEach((node, index) => {
    const angle = (index / totalSlaves) * 2 * Math.PI;
    const isQueued = node.classList.contains("queued");
    const radius = isQueued ? 120 : 200;

    const x = centerX + 60 + Math.cos(angle) * radius - 40;
    const y = centerY + 60 + Math.sin(angle) * radius - 40;

    node.style.left = x + "px";
    node.style.top = y + "px";

    const nodeId = node.id.replace("slave-node-", "slave-");
    networkNodes[nodeId] = { x, y, element: node };
  });

  // Redraw connections
  setTimeout(() => {
    if (currentView === "network") {
      const existingConnections = canvas.querySelectorAll(".connection-line");
      existingConnections.forEach((line) => line.remove());
      drawConnections(canvas);
    }
  }, 100);
}

function autoArrangeNodes() {
  const canvas = document.getElementById("network-canvas");
  if (!canvas) return;

  // Get active and queued slaves separately
  const activeSlaves = [];
  const queuedSlaves = [];

  canvas.querySelectorAll(".slave-node").forEach((node) => {
    if (node.classList.contains("queued")) {
      queuedSlaves.push(node);
    } else {
      activeSlaves.push(node);
    }
  });

  const centerX = canvas.offsetWidth / 2 - 60;
  const centerY = canvas.offsetHeight / 2 - 60;

  // Arrange active slaves in outer circle
  activeSlaves.forEach((node, index) => {
    const angle = (index / activeSlaves.length) * 2 * Math.PI;
    const x = centerX + 60 + Math.cos(angle) * 220 - 40;
    const y = centerY + 60 + Math.sin(angle) * 220 - 40;

    node.style.left = x + "px";
    node.style.top = y + "px";

    const nodeId = node.id.replace("slave-node-", "slave-");
    networkNodes[nodeId] = { x, y, element: node };
  });

  // Arrange queued slaves in inner circle
  queuedSlaves.forEach((node, index) => {
    const angle = (index / queuedSlaves.length) * 2 * Math.PI;
    const x = centerX + 60 + Math.cos(angle) * 140 - 40;
    const y = centerY + 60 + Math.sin(angle) * 140 - 40;

    node.style.left = x + "px";
    node.style.top = y + "px";

    const nodeId = node.id.replace("slave-node-", "slave-");
    networkNodes[nodeId] = { x, y, element: node };
  });

  // Redraw connections
  setTimeout(() => {
    if (currentView === "network") {
      const existingConnections = canvas.querySelectorAll(".connection-line");
      existingConnections.forEach((line) => line.remove());
      drawConnections(canvas);
    }
  }, 100);
}

// --- Quick Control Functions ---
function quickRename(slaveId) {
  const input = document.getElementById("quick-rename");
  const name = input.value.trim();
  if (!name) return;

  sendWS({ action: "rename", id: slaveId, name });
  input.value = "";
}
