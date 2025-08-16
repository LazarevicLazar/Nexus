#include <WiFi.h>
#include <DNSServer.h>
#include <esp_now.h>
#include <SPIFFS.h>
#include <ArduinoJson.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <vector>

// Add chip-specific compatibility information
#ifdef CONFIG_IDF_TARGET_ESP32C3
  #define IS_ESP32C3 true
#else
  #define IS_ESP32C3 false
#endif
#include <esp_wifi.h>

// --- Data Structures ---

// Structure to hold data from a slave (no ID here)
typedef struct struct_message {
    char name[32];
    int counter;
    bool isPowerSave;
    char deviceRole[32];      // Role of this device (e.g., "temperature_sensor")
    bool debugMode;           // Whether debug mode is enabled
    unsigned long reportingInterval; // How often to report data
    int analogReadings[4];    // Array to store analog readings
    bool pingResponse;        // Flag for ping response
} struct_message;

// Structure to manage each slave connected to the master
struct SlaveDevice {
  int id;
  uint8_t macAddress[6];
  char name[32];
  int counter;
  bool isPowerSave;
  unsigned long lastRecvTime;
  bool isOnline;
  bool wakeUpPending;
  char deviceRole[32];        // Role of this device
  bool debugMode;             // Whether debug mode is enabled
  unsigned long reportingInterval; // How often to report data
  int analogReadings[6];      // Array to store analog readings
  bool pingResponse;          // Flag for ping response
};

// A vector to store all known slave devices
std::vector<SlaveDevice> slaves;
int nextSlaveId = 1;

// Commands to send back to slaves
typedef enum {
  RENAME_SLAVE,
  ENTER_POWER_SAVE,
  EXIT_POWER_SAVE,
  SET_REPORTING_INTERVAL,
  TRIGGER_IMMEDIATE_REPORT,
  SET_SLEEP_DURATION,
  SET_DEVICE_ROLE,
  RESET_SLAVE,
  FACTORY_RESET,
  ENABLE_DEBUG_MODE,
  PING_SLAVE,
  SET_GPIO_STATE,
  READ_ANALOG_PIN,
  SET_TRANSMIT_POWER,
  SCAN_WIFI_NETWORKS
} CommandType;
typedef struct struct_command { CommandType command; char payload[32]; } struct_command;

// --- Networking Objects ---
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");
DNSServer dnsServer;
const byte DNS_PORT = 53;

// --- Helper Functions ---

// Find a slave in the vector by its MAC address, returns -1 if not found
int findSlaveByMac(const uint8_t* mac) {
    for (int i = 0; i < slaves.size(); i++) {
        if (memcmp(slaves[i].macAddress, mac, 6) == 0) {
            return i;
        }
    }
    return -1;
}

// Find a slave in the vector by its ID, returns -1 if not found
int findSlaveById(int id) {
    for (int i = 0; i < slaves.size(); i++) {
        if (slaves[i].id == id) {
            return i;
        }
    }
    return -1;
}

// Send a command to a specific slave by its MAC address
void sendCommandToSlave(const uint8_t* mac, CommandType cmd, const char* payload = "") {
    struct_command command;
    command.command = cmd;
    strncpy(command.payload, payload, sizeof(command.payload));
    
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, mac, 6);
    peerInfo.channel = 0; 
    peerInfo.encrypt = false;
    
    esp_err_t addResult = esp_now_add_peer(&peerInfo);
    if (addResult != ESP_OK) {
        Serial.printf("Failed to add peer for sending command. Error: %d\n", addResult);
        return;
    }
    
    esp_err_t sendResult = esp_now_send(mac, (uint8_t *) &command, sizeof(command));
    if (sendResult != ESP_OK) {
        Serial.printf("Failed to send command. Error: %d\n", sendResult);
    } else {
        Serial.printf("Command %d sent with payload: %s\n", cmd, payload);
    }
    
    esp_now_del_peer(mac);
}

// Set the reporting interval for a slave
void setReportingInterval(int slaveId, unsigned long intervalMs) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        char payload[32];
        snprintf(payload, sizeof(payload), "%lu", intervalMs);
        sendCommandToSlave(slaves[slaveIndex].macAddress, SET_REPORTING_INTERVAL, payload);
        Serial.printf("Set reporting interval for slave #%d to %lu ms\n", slaveId, intervalMs);
    }
}

// Trigger an immediate report from a slave
void triggerImmediateReport(int slaveId) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        sendCommandToSlave(slaves[slaveIndex].macAddress, TRIGGER_IMMEDIATE_REPORT);
        Serial.printf("Triggered immediate report from slave #%d\n", slaveId);
    }
}

// Set the sleep duration for a slave
void setSleepDuration(int slaveId, unsigned long durationSec) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        char payload[32];
        snprintf(payload, sizeof(payload), "%lu", durationSec);
        sendCommandToSlave(slaves[slaveIndex].macAddress, SET_SLEEP_DURATION, payload);
        Serial.printf("Set sleep duration for slave #%d to %lu seconds\n", slaveId, durationSec);
    }
}

// Set the role for a slave
void setDeviceRole(int slaveId, const char* role) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        sendCommandToSlave(slaves[slaveIndex].macAddress, SET_DEVICE_ROLE, role);
        Serial.printf("Set role for slave #%d to %s\n", slaveId, role);
    }
}

// Reset a slave
void resetSlave(int slaveId) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        sendCommandToSlave(slaves[slaveIndex].macAddress, RESET_SLAVE);
        Serial.printf("Reset command sent to slave #%d\n", slaveId);
    }
}

// Factory reset a slave
void factoryResetSlave(int slaveId) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        sendCommandToSlave(slaves[slaveIndex].macAddress, FACTORY_RESET);
        Serial.printf("Factory reset command sent to slave #%d\n", slaveId);
    }
}

// Enable or disable debug mode on a slave
void setDebugMode(int slaveId, bool enable) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        sendCommandToSlave(slaves[slaveIndex].macAddress, ENABLE_DEBUG_MODE, enable ? "1" : "0");
        Serial.printf("Debug mode %s for slave #%d\n", enable ? "enabled" : "disabled", slaveId);
    }
}

// Ping a slave
void pingSlave(int slaveId) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        sendCommandToSlave(slaves[slaveIndex].macAddress, PING_SLAVE);
        Serial.printf("Ping sent to slave #%d\n", slaveId);
    }
}

// Set a GPIO pin on a slave
void setGpioState(int slaveId, int pin, int state) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        // Check for known ESP32-C3 GPIO limitations
        bool isPotentialC3Issue = false;
        if (pin > 21) {
            Serial.printf("Warning: ESP32-C3 only supports GPIO 0-21. Pin %d might not work.\n", pin);
            isPotentialC3Issue = true;
        }
        if (pin >= 11 && pin <= 17) {
            Serial.printf("Warning: GPIO %d is used for flash on ESP32-C3 and might not be available.\n", pin);
            isPotentialC3Issue = true;
        }
        
        char payload[32];
        snprintf(payload, sizeof(payload), "%d:%d", pin, state);
        sendCommandToSlave(slaves[slaveIndex].macAddress, SET_GPIO_STATE, payload);
        Serial.printf("Set GPIO %d to %d on slave #%d %s\n",
                      pin, state, slaveId,
                      isPotentialC3Issue ? "(Warning: potential ESP32-C3 compatibility issue)" : "");
    }
}

// Request an analog reading from a slave
void requestAnalogReading(int slaveId, int pin) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        // Check for known ESP32-C3 ADC limitations
        bool isPotentialC3Issue = false;
        if (pin > 4) {
            Serial.printf("Warning: ESP32-C3 only supports ADC on pins 0-4. Pin %d might not work.\n", pin);
            isPotentialC3Issue = true;
        }
        
        char payload[32];
        snprintf(payload, sizeof(payload), "%d", pin);
        sendCommandToSlave(slaves[slaveIndex].macAddress, READ_ANALOG_PIN, payload);
        Serial.printf("Requested analog reading from pin %d on slave #%d %s\n",
                      pin, slaveId,
                      isPotentialC3Issue ? "(Warning: potential ESP32-C3 compatibility issue)" : "");
    }
}

// Set the transmit power for a slave
void setTransmitPower(int slaveId, int power) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        // Check for known ESP32-C3 power limitations
        bool isPotentialC3Issue = false;
        if (power > 20) {
            Serial.printf("Warning: ESP32-C3 maximum power is 20 dBm. Power %d might be capped.\n", power);
            isPotentialC3Issue = true;
        }
        
        char payload[32];
        snprintf(payload, sizeof(payload), "%d", power);
        sendCommandToSlave(slaves[slaveIndex].macAddress, SET_TRANSMIT_POWER, payload);
        Serial.printf("Set transmit power to %d on slave #%d %s\n",
                      power, slaveId,
                      isPotentialC3Issue ? "(Warning: potential ESP32-C3 compatibility issue)" : "");
    }
}

// Request a WiFi scan from a slave
void requestWifiScan(int slaveId) {
    int slaveIndex = findSlaveById(slaveId);
    if (slaveIndex != -1) {
        sendCommandToSlave(slaves[slaveIndex].macAddress, SCAN_WIFI_NETWORKS);
        Serial.printf("Requested WiFi scan from slave #%d\n", slaveId);
    }
}

// Broadcast the data of all slaves to all WebSocket clients
void broadcastAllSlavesData() {
    StaticJsonDocument<2048> jsonDoc; // Increased size for additional data
    JsonArray slavesArray = jsonDoc.to<JsonArray>();

    for (const auto& slave : slaves) {
        JsonObject slaveObj = slavesArray.createNestedObject();
        slaveObj["id"] = slave.id;
        slaveObj["name"] = slave.name;
        slaveObj["counter"] = slave.counter;
        slaveObj["isPowerSave"] = slave.isPowerSave;
        slaveObj["status"] = slave.isOnline ? "Online" : "Offline";
        slaveObj["wakeUpPending"] = slave.wakeUpPending;
        
        // Add new fields
        slaveObj["deviceRole"] = slave.deviceRole;
        slaveObj["debugMode"] = slave.debugMode;
        slaveObj["reportingInterval"] = slave.reportingInterval;
        
        // Add analog readings as an array
        JsonArray analogArray = slaveObj.createNestedArray("analogReadings");
        for (int i = 0; i < 6; i++) {
            analogArray.add(slave.analogReadings[i]);
        }
        
        slaveObj["pingResponse"] = slave.pingResponse;
    }

    String jsonStr;
    serializeJson(jsonDoc, jsonStr);
    ws.textAll(jsonStr);
}

// --- Callbacks and Setup ---

void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len) {
    if (type == WS_EVT_CONNECT) {
        Serial.printf("WebSocket client #%u connected\n", client->id());
        broadcastAllSlavesData(); // Send current state of all slaves to new client
    }
}

void OnDataRecv(const esp_now_recv_info * info, const uint8_t *incomingData, int len) {
    struct_message msg;
    memcpy(&msg, incomingData, sizeof(msg));

    int slaveIndex = findSlaveByMac(info->src_addr);

    if (slaveIndex == -1) { // New slave
        SlaveDevice newSlave;
        newSlave.id = nextSlaveId++;
        memcpy(newSlave.macAddress, info->src_addr, 6);
        slaves.push_back(newSlave);
        slaveIndex = slaves.size() - 1;
        Serial.printf("New slave registered with ID %d\n", newSlave.id);
    }

    // Update slave data
    strncpy(slaves[slaveIndex].name, msg.name, 32);
    slaves[slaveIndex].counter = msg.counter;
    slaves[slaveIndex].isPowerSave = msg.isPowerSave;
    slaves[slaveIndex].lastRecvTime = millis();
    slaves[slaveIndex].isOnline = true;
    
    // Update new fields
    strncpy(slaves[slaveIndex].deviceRole, msg.deviceRole, 32);
    slaves[slaveIndex].debugMode = msg.debugMode;
    slaves[slaveIndex].reportingInterval = msg.reportingInterval;
    memcpy(slaves[slaveIndex].analogReadings, msg.analogReadings, sizeof(msg.analogReadings));
    slaves[slaveIndex].pingResponse = msg.pingResponse;

    // Handle pending wake-up command
    if (slaves[slaveIndex].wakeUpPending && slaves[slaveIndex].isPowerSave) {
        Serial.printf("Slave #%d checked in. Sending pending wake-up command.\n", slaves[slaveIndex].id);
        sendCommandToSlave(slaves[slaveIndex].macAddress, EXIT_POWER_SAVE);
        slaves[slaveIndex].wakeUpPending = false;
    }
    
    broadcastAllSlavesData();
}

void setup() {
    Serial.begin(115200);
    Serial.println("\nMaster Node Booting Up...");

    // Print hardware information to help with debugging
    #ifdef CONFIG_IDF_TARGET_ESP32C3
        Serial.println("*** Master running on ESP32-C3 chip ***");
    #elif defined(CONFIG_IDF_TARGET_ESP32S3)
        Serial.println("*** Master running on ESP32-S3 chip ***");
    #elif defined(CONFIG_IDF_TARGET_ESP32S2)
        Serial.println("*** Master running on ESP32-S2 chip ***");
    #elif defined(CONFIG_IDF_TARGET_ESP32)
        Serial.println("*** Master running on original ESP32 chip ***");
    #else
        Serial.println("*** Master running on unknown ESP32 variant ***");
    #endif

    WiFi.mode(WIFI_STA);
    delay(2);
    Serial.print("MAC Address: ");
    Serial.println(WiFi.macAddress());

    if(!SPIFFS.begin(true)) { Serial.println("Failed to mount SPIFFS"); return; }

    esp_err_t initResult = esp_now_init();
    if (initResult != ESP_OK) {
        Serial.printf("Error initializing ESP-NOW. Error code: %d\n", initResult);
        return;
    }
    esp_now_register_recv_cb(OnDataRecv);

    WiFi.softAP("Nexus Network", "password123");
    IPAddress myIP = WiFi.softAPIP();
    Serial.print("Access Point Started. IP: ");
    Serial.println(myIP);

    dnsServer.start(DNS_PORT, "*", myIP);
    ws.onEvent(onWsEvent);
    server.addHandler(&ws);

    server.on("/rename", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id") && request->hasParam("name")) {
            int id = request->getParam("id")->value().toInt();
            String newName = request->getParam("name")->value();
            int slaveIndex = findSlaveById(id);
            if (slaveIndex != -1) {
                sendCommandToSlave(slaves[slaveIndex].macAddress, RENAME_SLAVE, newName.c_str());
                request->send(200, "text/plain", "OK");
            } else { request->send(404, "text/plain", "Slave not found"); }
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    server.on("/power", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id") && request->hasParam("mode")) {
            int id = request->getParam("id")->value().toInt();
            String mode = request->getParam("mode")->value();
            int slaveIndex = findSlaveById(id);
            if (slaveIndex != -1) {
                if (mode == "on") {
                    slaves[slaveIndex].wakeUpPending = true;
                    sendCommandToSlave(slaves[slaveIndex].macAddress, EXIT_POWER_SAVE);
                } else if (mode == "off") {
                    slaves[slaveIndex].wakeUpPending = false;
                    sendCommandToSlave(slaves[slaveIndex].macAddress, ENTER_POWER_SAVE);
                }
                broadcastAllSlavesData();
                request->send(200, "text/plain", "OK");
            } else { request->send(404, "text/plain", "Slave not found"); }
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // New endpoint to release/remove a slave
    server.on("/release", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id")) {
            int id = request->getParam("id")->value().toInt();
            int slaveIndex = findSlaveById(id);
            if (slaveIndex != -1) {
                slaves.erase(slaves.begin() + slaveIndex);
                Serial.printf("Released slave with ID %d\n", id);
                broadcastAllSlavesData(); // Update UI
                request->send(200, "text/plain", "OK");
            } else { request->send(404, "text/plain", "Slave not found"); }
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for setting reporting interval
    server.on("/reporting", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id") && request->hasParam("interval")) {
            int id = request->getParam("id")->value().toInt();
            unsigned long interval = request->getParam("interval")->value().toInt();
            setReportingInterval(id, interval);
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for triggering immediate report
    server.on("/trigger_report", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id")) {
            int id = request->getParam("id")->value().toInt();
            triggerImmediateReport(id);
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for setting sleep duration
    server.on("/sleep_duration", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id") && request->hasParam("seconds")) {
            int id = request->getParam("id")->value().toInt();
            unsigned long seconds = request->getParam("seconds")->value().toInt();
            setSleepDuration(id, seconds);
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for setting device role
    server.on("/role", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id") && request->hasParam("role")) {
            int id = request->getParam("id")->value().toInt();
            String role = request->getParam("role")->value();
            setDeviceRole(id, role.c_str());
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for resetting a slave
    server.on("/reset", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id")) {
            int id = request->getParam("id")->value().toInt();
            resetSlave(id);
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for factory resetting a slave
    server.on("/factory_reset", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id")) {
            int id = request->getParam("id")->value().toInt();
            factoryResetSlave(id);
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for setting debug mode
    server.on("/debug", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id") && request->hasParam("enable")) {
            int id = request->getParam("id")->value().toInt();
            bool enable = (request->getParam("enable")->value() == "1" ||
                          request->getParam("enable")->value() == "true");
            setDebugMode(id, enable);
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for pinging a slave
    server.on("/ping", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id")) {
            int id = request->getParam("id")->value().toInt();
            pingSlave(id);
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for setting GPIO state
    server.on("/gpio", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id") && request->hasParam("pin") && request->hasParam("state")) {
            int id = request->getParam("id")->value().toInt();
            int pin = request->getParam("pin")->value().toInt();
            int state = request->getParam("state")->value().toInt();
            setGpioState(id, pin, state);
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for requesting analog reading
    server.on("/analog", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id") && request->hasParam("pin")) {
            int id = request->getParam("id")->value().toInt();
            int pin = request->getParam("pin")->value().toInt();
            requestAnalogReading(id, pin);
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for setting transmit power
    server.on("/tx_power", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id") && request->hasParam("power")) {
            int id = request->getParam("id")->value().toInt();
            int power = request->getParam("power")->value().toInt();
            setTransmitPower(id, power);
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    // Endpoint for requesting WiFi scan
    server.on("/wifi_scan", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (request->hasParam("id")) {
            int id = request->getParam("id")->value().toInt();
            requestWifiScan(id);
            request->send(200, "text/plain", "OK");
        } else { request->send(400, "text/plain", "Bad Request"); }
    });

    server.serveStatic("/", SPIFFS, "/").setDefaultFile("index.html");
    server.begin();
}

void loop() {
    dnsServer.processNextRequest();
    ws.cleanupClients();

    bool changed = false;
    for (int i = 0; i < slaves.size(); i++) {
        if (slaves[i].isOnline && (millis() - slaves[i].lastRecvTime > 4000)) {
            slaves[i].isOnline = false;
            slaves[i].wakeUpPending = false;
            changed = true;
            Serial.printf("Slave #%d timed out.\n", slaves[i].id);
        }
    }
    if (changed) {
        broadcastAllSlavesData();
    }
}
