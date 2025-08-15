let countdownIntervals = {};

window.addEventListener("load", function () {
  const socket = new WebSocket(`ws://${window.location.host}/ws`);
  socket.addEventListener("open", () => console.log("WebSocket connected"));
  socket.addEventListener("close", () => console.log("WebSocket disconnected"));
  socket.addEventListener("message", handleWebSocketMessage);
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
      }

      // Populate card data
      card.querySelector(".slave-name").textContent = slave.name;
      card.querySelector(".slave-counter").textContent = slave.counter;

      const statusPill = card.querySelector(".status-pill");
      statusPill.textContent = slave.status;
      statusPill.className = `status-pill status-${slave.status.toLowerCase()}`;

      // Handle power UI and timer
      updatePowerUI(card, slave);
    });
  } catch (e) {
    console.error("Invalid JSON from WebSocket:", e);
  }
}

function updatePowerUI(card, slave) {
  const powerButton = card.querySelector(".power-button");
  const timerSection = card.querySelector(".timer-section");

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

  if (timerSection) {
    if (slave.isPowerSave || slave.wakeUpPending) {
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
    fetch(`/release?id=${slaveId}`)
      .then(handleFetchResponse)
      .catch(handleFetchError);
  }
}

function handleFetchResponse(response) {
  if (response.ok) console.log("Command sent successfully.");
  else console.error("Failed to send command.");
}

function handleFetchError(error) {
  console.error("Error sending command:", error);
}
