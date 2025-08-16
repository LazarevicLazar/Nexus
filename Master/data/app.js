// Global variables
let countdownIntervals = {};
let queuedSlaves = [];
let socket = null;
let outbox = []; // queued messages while WS connects
let wsOpen = false;
let reconnectTimer = null;

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
});

window.addEventListener("beforeunload", () => {
  if (socket) socket.close();
});

// --- WS data handler (state updates from master) ---
function handleWebSocketMessage(event) {
  try {
    const data = JSON.parse(event.data);
    if (!data.active && !data.queued) {
      // acks/etc; ignore
      return;
    }

    const activeSlaves = data.active || [];
    const queuedSlaves = data.queued || [];

    // Update global queued slaves array
    window.queuedSlaves = queuedSlaves;
    updateQueueButton();

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
          ?.addEventListener("click", () =>
            setReportingInterval(slave.id, card)
          );
        card
          .querySelector(".sleep-button")
          ?.addEventListener("click", () => setSleepDuration(slave.id, card));
        card
          .querySelector(".gpio-button")
          ?.addEventListener("click", () => setGpioState(slave.id, card));
        card
          .querySelector(".analog-button")
          ?.addEventListener("click", () =>
            requestAnalogReading(slave.id, card)
          );
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
  } catch (e) {
    // ignore non-object payloads (acks)
  }
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
  const powerButton = card.querySelector(".power-button");

  // Toggle between on and off based on current state
  const mode = powerButton.classList.contains("active") ? "on" : "off";

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
  const enable = card.querySelector(".debug-mode").value === "1";
  sendWS({ action: "debug", id: slaveId, enable });
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
