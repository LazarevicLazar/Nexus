// Global variables
let countdownIntervals = {};
let removedSlaves = []; // Queue for removed slaves

// Initialize the application when the window loads
window.addEventListener("load", function () {
  const socket = new WebSocket(`ws://${window.location.host}/ws`);
  socket.addEventListener("open", () => console.log("WebSocket connected"));
  socket.addEventListener("close", () => console.log("WebSocket disconnected"));
  socket.addEventListener("message", handleWebSocketMessage);

  // Initialize the removed slaves queue from localStorage if available
  const savedQueue = localStorage.getItem("removedSlaves");
  if (savedQueue) {
    try {
      removedSlaves = JSON.parse(savedQueue);
      updateQueueButton();
    } catch (e) {
      console.error("Error loading removed slaves queue:", e);
      localStorage.removeItem("removedSlaves");
    }
  }

  // Add event listener for the queue button
  document
    .getElementById("queue-button")
    .addEventListener("click", showSlaveQueue);
});

function handleWebSocketMessage(event) {
  try {
    const slaves = JSON.parse(event.data);
    const grid = document.getElementById("dashboard-grid");
    const template = document.getElementById("slave-card-template");

    // A more efficient way to update the grid without clearing everything
    const existingIds = new Set([...grid.children].map((c) => c.dataset.id));
    const incomingIds = new Set(slaves.map((s) => s.id.toString()));

    // Remove cards for slaves that are no longer present
    existingIds.forEach((id) => {
      if (!incomingIds.has(id)) {
        grid.querySelector(`.card[data-id='${id}']`).remove();
      }
    });

    // Add or update cards for each slave
    slaves.forEach((slave) => {
      let card = grid.querySelector(`.card[data-id='${slave.id}']`);
      if (!card) {
        card = template.content.cloneNode(true).firstElementChild;
        card.dataset.id = slave.id;
        grid.appendChild(card);

        // Add event listeners only once when the card is created
        // Basic controls
        card
          .querySelector(".rename-button")
          .addEventListener("click", () => sendRenameCommand(slave.id));
        card
          .querySelector(".power-button")
          .addEventListener("click", () =>
            togglePowerMode(slave.id, slave.isPowerSave)
          );
        card
          .querySelector(".close-button")
          .addEventListener("click", () => releaseSlaveId(slave.id));

        // Add device chip type indicator if it exists in the response
        if (slave.name.includes("ESP32-C3")) {
          const chipIndicator = document.createElement("div");
          chipIndicator.className = "chip-indicator esp32c3";
          chipIndicator.textContent = "ESP32-C3";
          chipIndicator.title =
            "This device uses ESP32-C3 chip with different GPIO/ADC capabilities";
          card.appendChild(chipIndicator);
        }

        // Toggle advanced controls
        card
          .querySelector(".toggle-advanced-button")
          .addEventListener("click", (e) => toggleAdvancedControls(e, card));

        // Advanced controls
        card
          .querySelector(".role-button")
          .addEventListener("click", () => setDeviceRole(slave.id, card));
        card
          .querySelector(".interval-button")
          .addEventListener("click", () =>
            setReportingInterval(slave.id, card)
          );
        card
          .querySelector(".sleep-button")
          .addEventListener("click", () => setSleepDuration(slave.id, card));
        card
          .querySelector(".gpio-button")
          .addEventListener("click", () => setGpioState(slave.id, card));
        card
          .querySelector(".analog-button")
          .addEventListener("click", () =>
            requestAnalogReading(slave.id, card)
          );
        card
          .querySelector(".tx-power-button")
          .addEventListener("click", () => setTransmitPower(slave.id, card));
        card
          .querySelector(".ping-button")
          .addEventListener("click", () => pingSlave(slave.id));
        card
          .querySelector(".debug-button")
          .addEventListener("click", () =>
            toggleDebugMode(slave.id, slave.debugMode)
          );
        card
          .querySelector(".reset-button")
          .addEventListener("click", () => resetSlave(slave.id));
        card
          .querySelector(".factory-reset-button")
          .addEventListener("click", () => factoryResetSlave(slave.id));
      }

      // Populate card data
      card.querySelector(".slave-name").textContent = slave.name;
      card.querySelector(".slave-counter").textContent = slave.counter;

      const statusPill = card.querySelector(".status-pill");
      statusPill.textContent = slave.status;
      statusPill.className = `status-pill status-${slave.status.toLowerCase()}`;

      // Check for ESP32-C3 chip based on name
      if (
        slave.name.includes("ESP32-C3") &&
        !card.querySelector(".chip-indicator")
      ) {
        const chipIndicator = document.createElement("div");
        chipIndicator.className = "chip-indicator esp32c3";
        chipIndicator.textContent = "ESP32-C3";
        chipIndicator.title =
          "This device uses ESP32-C3 chip with different GPIO/ADC capabilities";
        card.appendChild(chipIndicator);
      }

      // Handle power UI and timer
      updatePowerUI(card, slave);

      // Update advanced fields if they exist
      updateAdvancedFields(card, slave);
    });
  } catch (e) {
    console.error("Invalid JSON from WebSocket:", e);
  }
}

function updatePowerUI(card, slave) {
  const powerButton = card.querySelector(".power-button");
  const timerSection = card.querySelector(".timer-section");

  // Fix for the "Waking up..." button glowing bug after refresh
  // Only show wakeUpPending if the slave is actually online
  if (slave.wakeUpPending && slave.status === "Online") {
    powerButton.textContent = "Waking Up...";
    powerButton.className = "power-button pending";
  } else if (slave.isPowerSave) {
    powerButton.textContent = "Power Save ON";
    powerButton.className = "power-button inactive";
    // Reset wakeUpPending if the slave is in power save mode
    if (slave.wakeUpPending) {
      slave.wakeUpPending = false;
    }
  } else {
    powerButton.textContent = "Power Save OFF";
    powerButton.className = "power-button active";
  }

  if (timerSection) {
    if (
      slave.isPowerSave ||
      (slave.wakeUpPending && slave.status === "Online")
    ) {
      timerSection.style.display = "block";
      startCountdown(slave.id, card);
    } else {
      timerSection.style.display = "none";
      stopCountdown(slave.id);
    }
  }
}

function startCountdown(slaveId, card) {
  if (countdownIntervals[slaveId]) return; // Timer already running

  let timeLeft = 60;
  const countdownElement = card.querySelector(".timer-countdown");
  if (countdownElement) countdownElement.textContent = `${timeLeft}s`;

  countdownIntervals[slaveId] = setInterval(() => {
    timeLeft--;
    if (timeLeft < 0) {
      timeLeft = 0;
      stopCountdown(slaveId);
    }
    if (countdownElement) countdownElement.textContent = `${timeLeft}s`;
  }, 1000);
}

function stopCountdown(slaveId) {
  clearInterval(countdownIntervals[slaveId]);
  delete countdownIntervals[slaveId];
}

function sendRenameCommand(slaveId) {
  const card = document.querySelector(`.card[data-id='${slaveId}']`);
  const renameInput = card.querySelector(".rename-input");
  const newName = renameInput.value;
  if (newName && newName.trim() !== "") {
    fetch(`/rename?id=${slaveId}&name=${encodeURIComponent(newName)}`)
      .then(handleFetchResponse)
      .catch(handleFetchError);
    renameInput.value = "";
  }
}

function togglePowerMode(slaveId, isPowerSave) {
  const mode = isPowerSave ? "on" : "off";
  fetch(`/power?id=${slaveId}&mode=${mode}`)
    .then(handleFetchResponse)
    .catch(handleFetchError);
}

function releaseSlaveId(slaveId) {
  if (
    confirm(
      `Are you sure you want to release slave #${slaveId}? This will remove it from the dashboard.`
    )
  ) {
    // Find the slave in the dashboard before removing it
    const card = document.querySelector(`.card[data-id='${slaveId}']`);
    if (card) {
      const slaveName = card.querySelector(".slave-name").textContent;
      const slaveCounter = card.querySelector(".slave-counter").textContent;

      // Add to removed slaves queue
      const removedSlave = {
        id: slaveId,
        name: slaveName,
        counter: slaveCounter,
        removedAt: new Date().toISOString(),
      };

      removedSlaves.push(removedSlave);
      localStorage.setItem("removedSlaves", JSON.stringify(removedSlaves));
      updateQueueButton();
    }

    fetch(`/release?id=${slaveId}`)
      .then(handleFetchResponse)
      .catch(handleFetchError);
  }
}

// Function to update the queue button with the current count
function updateQueueButton() {
  const queueButton = document.getElementById("queue-button");
  if (queueButton) {
    queueButton.textContent = `Queue (${removedSlaves.length})`;
    queueButton.style.display = removedSlaves.length > 0 ? "block" : "none";
  }
}

// Function to show the slave queue modal
function showSlaveQueue() {
  // Create modal if it doesn't exist
  let modal = document.getElementById("queue-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "queue-modal";
    modal.className = "modal";

    const modalContent = document.createElement("div");
    modalContent.className = "modal-content";

    const closeBtn = document.createElement("span");
    closeBtn.className = "close-modal";
    closeBtn.innerHTML = "&times;";
    closeBtn.onclick = hideSlaveQueue;

    const modalHeader = document.createElement("h2");
    modalHeader.textContent = "Removed Slaves Queue";

    const queueList = document.createElement("div");
    queueList.id = "queue-list";

    modalContent.appendChild(closeBtn);
    modalContent.appendChild(modalHeader);
    modalContent.appendChild(queueList);
    modal.appendChild(modalContent);
    document.body.appendChild(modal);
  }

  // Populate the queue list
  const queueList = document.getElementById("queue-list");
  queueList.innerHTML = "";

  if (removedSlaves.length === 0) {
    queueList.innerHTML = "<p>No slaves in the queue</p>";
  } else {
    removedSlaves.forEach((slave, index) => {
      const slaveItem = document.createElement("div");
      slaveItem.className = "queue-item";

      const slaveInfo = document.createElement("div");
      slaveInfo.className = "queue-item-info";
      slaveInfo.innerHTML = `
        <strong>${slave.name}</strong> (ID: ${slave.id})
        <span>Removed: ${new Date(slave.removedAt).toLocaleString()}</span>
      `;

      const restoreBtn = document.createElement("button");
      restoreBtn.className = "restore-button";
      restoreBtn.textContent = "Restore";
      restoreBtn.onclick = () => restoreSlave(index);

      slaveItem.appendChild(slaveInfo);
      slaveItem.appendChild(restoreBtn);
      queueList.appendChild(slaveItem);
    });
  }

  // Show the modal
  modal.style.display = "block";
}

// Function to hide the slave queue modal
function hideSlaveQueue() {
  const modal = document.getElementById("queue-modal");
  if (modal) {
    modal.style.display = "none";
  }
}

// Function to restore a slave from the queue
function restoreSlave(index) {
  if (index >= 0 && index < removedSlaves.length) {
    const slave = removedSlaves[index];

    // Remove from queue
    removedSlaves.splice(index, 0);
    localStorage.setItem("removedSlaves", JSON.stringify(removedSlaves));

    // Show feedback
    const feedbackEl = document.createElement("div");
    feedbackEl.className = "command-feedback success";
    feedbackEl.textContent = `Slave "${slave.name}" (ID: ${slave.id}) has been restored`;
    document.body.appendChild(feedbackEl);

    // Remove the feedback after 3 seconds
    setTimeout(() => {
      feedbackEl.remove();
    }, 3000);

    // Update queue button and refresh the queue modal
    updateQueueButton();
    showSlaveQueue();
  }
}

function handleFetchResponse(response) {
  if (response.ok) {
    console.log(`Command sent successfully. Status: ${response.status}`);
    // Get the URL that was requested to help with debugging
    const url = response.url;
    console.log(`Successful request to: ${url}`);

    // Check if this is a hardware-sensitive command
    const isHardwareSensitive =
      url.includes("/gpio") ||
      url.includes("/analog") ||
      url.includes("/tx_power");

    // Detect if the target might be an ESP32-C3
    const slaveId = new URLSearchParams(url.split("?")[1]).get("id");
    const card = document.querySelector(`.card[data-id='${slaveId}']`);
    const mightBeC3 = card && card.querySelector(".chip-indicator.esp32c3");

    // Show a visual feedback to the user
    const feedbackEl = document.createElement("div");
    feedbackEl.className = "command-feedback success";

    if (isHardwareSensitive && mightBeC3) {
      feedbackEl.className = "command-feedback warning";
      feedbackEl.textContent =
        "Command sent! (ESP32-C3 compatibility may vary)";
      feedbackEl.title =
        "ESP32-C3 has different pin capabilities. Check Serial output for details.";
    } else {
      feedbackEl.textContent = "Command sent!";
    }

    document.body.appendChild(feedbackEl);

    // Remove the feedback after 3 seconds
    setTimeout(() => {
      feedbackEl.remove();
    }, 3000);

    // Return the response text for further debugging
    response.text().then((text) => {
      console.log(`Response body: ${text}`);
    });
  } else {
    console.error(`Failed to send command. Status: ${response.status}`);
    // Get the URL that was requested to help with debugging
    const url = response.url;
    console.error(`Failed request to: ${url}`);

    // Show error feedback
    const feedbackEl = document.createElement("div");
    feedbackEl.className = "command-feedback error";

    // Determine if this might be a hardware compatibility issue
    if (
      url.includes("/gpio") ||
      url.includes("/analog") ||
      url.includes("/tx_power")
    ) {
      feedbackEl.textContent = `Command failed! Possible hardware compatibility issue`;
      feedbackEl.title =
        "ESP32-C3 has different pin mapping. Check Serial monitor for details.";
    } else {
      feedbackEl.textContent = `Command failed! (${response.status})`;
    }

    document.body.appendChild(feedbackEl);

    // Remove the feedback after 3 seconds
    setTimeout(() => {
      feedbackEl.remove();
    }, 3000);

    // Try to get the response text for more details
    response.text().then((text) => {
      console.error(`Error response body: ${text}`);
    });
  }
}

function handleFetchError(error) {
  console.error("Error sending command:", error);
  console.error("Error details:", error.message);

  // Show error feedback
  const feedbackEl = document.createElement("div");
  feedbackEl.className = "command-feedback error";
  feedbackEl.textContent = `Network error: ${error.message}`;
  document.body.appendChild(feedbackEl);

  // Remove the feedback after 2 seconds
  setTimeout(() => {
    feedbackEl.remove();
  }, 2000);
}

// Function to toggle advanced controls visibility
function toggleAdvancedControls(event, card) {
  const advancedSection = card.querySelector(".advanced-controls");
  const toggleButton = card.querySelector(".toggle-advanced-button");

  // Check if the section is visible by getting computed style
  const isHidden = window.getComputedStyle(advancedSection).display === "none";

  if (isHidden) {
    // Show the advanced controls
    advancedSection.style.display = "block";
    toggleButton.textContent = "Hide Advanced Controls";
    console.log("Showing advanced controls");
  } else {
    // Hide the advanced controls
    advancedSection.style.display = "none";
    toggleButton.textContent = "Show Advanced Controls";
    console.log("Hiding advanced controls");
  }
}

// Function to update advanced fields in the UI
function updateAdvancedFields(card, slave) {
  // Update role input placeholder
  const roleInput = card.querySelector(".role-input");
  if (roleInput && slave.deviceRole) {
    roleInput.placeholder = `Device role (current: ${slave.deviceRole})`;
  }

  // Update interval input placeholder
  const intervalInput = card.querySelector(".interval-input");
  if (intervalInput && slave.reportingInterval) {
    intervalInput.placeholder = `Report interval (current: ${slave.reportingInterval}ms)`;
  }

  // Update debug button text
  const debugButton = card.querySelector(".debug-button");
  if (debugButton) {
    debugButton.textContent = slave.debugMode ? "Debug: ON" : "Debug: OFF";
    debugButton.className = slave.debugMode
      ? "debug-button active"
      : "debug-button inactive";
  }

  // Display analog readings if available
  if (slave.analogReadings && slave.analogReadings.length > 0) {
    // Check if analog readings section exists, create if not
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

      // Insert after the counter section
      const counterSection = card.querySelector(".data-section");
      counterSection.parentNode.insertBefore(
        analogSection,
        counterSection.nextSibling
      );
    }

    // Update analog readings
    const readingsContainer = analogSection.querySelector(".analog-values");
    readingsContainer.innerHTML = "";

    slave.analogReadings.forEach((reading, index) => {
      if (reading > 0) {
        // Only show non-zero readings
        const readingEl = document.createElement("div");
        readingEl.className = "analog-reading";
        readingEl.innerHTML = `<span>ADC ${index}:</span> <strong>${reading}</strong>`;
        readingsContainer.appendChild(readingEl);
      }
    });

    // Show or hide based on whether there are any readings
    analogSection.style.display =
      readingsContainer.children.length > 0 ? "block" : "none";
  }
}

// Function to set device role
function setDeviceRole(slaveId, card) {
  console.log(`setDeviceRole called for slave #${slaveId}`);
  const roleInput = card.querySelector(".role-input");
  const role = roleInput.value;
  if (role && role.trim() !== "") {
    console.log(`Setting role to: ${role}`);
    fetch(`/role?id=${slaveId}&role=${encodeURIComponent(role)}`)
      .then(handleFetchResponse)
      .catch(handleFetchError);
    roleInput.value = "";
  } else {
    console.log("Role input is empty, not sending command");
  }
}

// Function to set reporting interval
function setReportingInterval(slaveId, card) {
  const intervalInput = card.querySelector(".interval-input");
  const interval = intervalInput.value;
  if (interval && !isNaN(interval) && interval >= 500) {
    fetch(`/reporting?id=${slaveId}&interval=${interval}`)
      .then(handleFetchResponse)
      .catch(handleFetchError);
    intervalInput.value = "";
  }
}

// Function to set sleep duration
function setSleepDuration(slaveId, card) {
  const sleepInput = card.querySelector(".sleep-input");
  const seconds = sleepInput.value;
  if (seconds && !isNaN(seconds) && seconds >= 10) {
    fetch(`/sleep_duration?id=${slaveId}&seconds=${seconds}`)
      .then(handleFetchResponse)
      .catch(handleFetchError);
    sleepInput.value = "";
  }
}

// Function to set GPIO state
function setGpioState(slaveId, card) {
  const pinSelect = card.querySelector(".gpio-pin");
  const stateSelect = card.querySelector(".gpio-state");
  const pin = pinSelect.value;
  const state = stateSelect.value;

  // Check if this is likely an ESP32-C3 device
  const isC3Device = card.querySelector(".chip-indicator.esp32c3") !== null;

  // Warn about potentially incompatible GPIO pins on ESP32-C3 Super Mini
  if (isC3Device) {
    // GPIO 11-19 are used for flash on ESP32-C3
    if (pin >= 11 && pin <= 19) {
      console.warn(
        `GPIO ${pin} is used for flash on ESP32-C3 and may not be available.`
      );
      showWarningNotification(
        `GPIO ${pin} is used for flash on ESP32-C3 and may not be available.`
      );
      return; // Prevent sending the command
    }
  }

  fetch(`/gpio?id=${slaveId}&pin=${pin}&state=${state}`)
    .then(handleFetchResponse)
    .catch(handleFetchError);
}

// Function to show a warning notification
function showWarningNotification(message) {
  const warningEl = document.createElement("div");
  warningEl.className = "command-feedback warning";
  warningEl.textContent = message;
  document.body.appendChild(warningEl);

  // Remove after 4 seconds
  setTimeout(() => {
    warningEl.remove();
  }, 4000);
}

// Function to request analog reading
function requestAnalogReading(slaveId, card) {
  const pinSelect = card.querySelector(".analog-pin");
  const pin = pinSelect.value;

  // For ESP32-C3 Super Mini, we've already limited the options in the dropdown
  // to only show compatible pins (0-4), so no additional validation is needed

  fetch(`/analog?id=${slaveId}&pin=${pin}`)
    .then(handleFetchResponse)
    .catch(handleFetchError);
}

// Function to set transmit power
function setTransmitPower(slaveId, card) {
  const powerSelect = card.querySelector(".tx-power");
  const power = powerSelect.value;

  console.log(`Setting transmit power for slave #${slaveId} to ${power}`);

  fetch(`/tx_power?id=${slaveId}&power=${power}`)
    .then(handleFetchResponse)
    .catch(handleFetchError);
}

// Function to ping a slave
function pingSlave(slaveId) {
  console.log(`Pinging slave #${slaveId}`);

  // Add timestamp for debugging
  const timestamp = new Date().toISOString();
  console.log(`Ping request sent at: ${timestamp}`);

  // Show a visual indicator that we're sending a ping
  const feedbackEl = document.createElement("div");
  feedbackEl.className = "command-feedback pending";
  feedbackEl.textContent = "Sending ping...";
  document.body.appendChild(feedbackEl);

  fetch(`/ping?id=${slaveId}`)
    .then((response) => {
      console.log(`Ping response status: ${response.status}`);
      console.log(`Ping response received at: ${new Date().toISOString()}`);

      // Remove the pending feedback
      feedbackEl.remove();

      // Process the response
      handleFetchResponse(response);

      // Check if we need to update the slave's status in the UI
      const card = document.querySelector(`.card[data-id='${slaveId}']`);
      if (card) {
        const statusPill = card.querySelector(".status-pill");
        if (statusPill) {
          console.log(`Current status pill text: ${statusPill.textContent}`);
        }
      }
    })
    .catch((error) => {
      // Remove the pending feedback
      feedbackEl.remove();

      console.error(`Ping error at: ${new Date().toISOString()}`);
      handleFetchError(error);
    });
}

// Function to toggle debug mode
function toggleDebugMode(slaveId, currentMode) {
  const enable = !currentMode; // Toggle the current state
  fetch(`/debug?id=${slaveId}&enable=${enable ? 1 : 0}`)
    .then(handleFetchResponse)
    .catch(handleFetchError);
}

// Function to reset a slave
function resetSlave(slaveId) {
  if (confirm(`Are you sure you want to reset slave #${slaveId}?`)) {
    fetch(`/reset?id=${slaveId}`)
      .then(handleFetchResponse)
      .catch(handleFetchError);
  }
}

// Function to factory reset a slave
function factoryResetSlave(slaveId) {
  if (
    confirm(
      `Are you sure you want to FACTORY RESET slave #${slaveId}? This will erase all settings.`
    )
  ) {
    fetch(`/factory_reset?id=${slaveId}`)
      .then(handleFetchResponse)
      .catch(handleFetchError);
  }
}

// Function to trigger an immediate report
function triggerImmediateReport(slaveId) {
  fetch(`/trigger_report?id=${slaveId}`)
    .then(handleFetchResponse)
    .catch(handleFetchError);
}
