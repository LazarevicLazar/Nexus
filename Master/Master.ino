#include <WiFi.h>
#include <DNSServer.h>
#include <esp_now.h>
#include <SPIFFS.h>
#include <ArduinoJson.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <vector>
#include <set>

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
    int analogReadings[6];    // Array to store analog readings
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
std::set<int> usedIds; // Track which IDs are currently in use
int nextHighestId = 1; // The next highest ID to assign if no lower IDs are available

// Helper: safely get int/bool/string from JSON
static long  jInt(JsonVariant v, long d=0){ return v.is<long>()? (long)v : d; }
static bool  jBool(JsonVariant v, bool d=false){ return v.is<bool>()? (bool)v : d; }
static String jStr(JsonVariant v, const char* d=""){ return v.is<const char*>()? String((const char*)v) : String(d); }

// Function to get the next available ID (lowest free ID)
int getNextAvailableId() {
  // Start from ID 1 and find the first ID that's not in usedIds
  for (int id = 1; id < nextHighestId; id++) {
    if (usedIds.find(id) == usedIds.end()) {
      // This ID is free, use it
      usedIds.insert(id);
      return id;
    }
  }
  
  // No gaps found, use the next highest ID
  usedIds.insert(nextHighestId);
  return nextHighestId++;
}

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
    memset(command.payload, 0, sizeof(command.payload)); // Clear the payload buffer first
    strncpy(command.payload, payload, sizeof(command.payload) - 1); // Ensure null-termination
    
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
        // Update the local state first
        slaves[slaveIndex].reportingInterval = intervalMs;
        
        // Send the command to the slave
        char payload[32];
        snprintf(payload, sizeof(payload), "%lu", intervalMs);
        sendCommandToSlave(slaves[slaveIndex].macAddress, SET_REPORTING_INTERVAL, payload);
        Serial.printf("Set reporting interval for slave #%d to %lu ms\n", slaveId, intervalMs);
        
        // Broadcast the updated state to all clients
        broadcastAllSlavesData();
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
        // Note: We don't store sleep duration in the master's data structure,
        // but we still send the command to the slave
        
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
        // Update the local state first
        strncpy(slaves[slaveIndex].deviceRole, role, sizeof(slaves[slaveIndex].deviceRole));
        
        // Send the command to the slave
        sendCommandToSlave(slaves[slaveIndex].macAddress, SET_DEVICE_ROLE, role);
        Serial.printf("Set role for slave #%d to %s\n", slaveId, role);
        
        // Broadcast the updated state to all clients
        broadcastAllSlavesData();
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
        // Update the local state first
        slaves[slaveIndex].debugMode = enable;
        
        // Send the command to the slave
        sendCommandToSlave(slaves[slaveIndex].macAddress, ENABLE_DEBUG_MODE, enable ? "1" : "0");
        Serial.printf("Debug mode %s for slave #%d\n", enable ? "enabled" : "disabled", slaveId);
        
        // Broadcast the updated state to all clients
        broadcastAllSlavesData();
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
        
        // Note: We don't store GPIO state in the master's data structure,
        // but we still send the command to the slave
        
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
        
        // Note: We don't store transmit power in the master's data structure,
        // but we still send the command to the slave
        
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

void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client,
               AwsEventType type, void *arg, uint8_t *data, size_t len) {
  if (type == WS_EVT_CONNECT) {
    Serial.printf("WebSocket client #%u connected\n", client->id());
    broadcastAllSlavesData();
  } else if (type == WS_EVT_DISCONNECT) {
    Serial.printf("WebSocket client #%u disconnected\n", client->id());
  } else if (type == WS_EVT_ERROR) {
    Serial.printf("WebSocket client #%u error\n", client->id());
  } else if (type == WS_EVT_DATA) {
    AwsFrameInfo *info = (AwsFrameInfo*)arg;
    if (!(info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT)) return;

    // Parse JSON
    StaticJsonDocument<512> doc;
    DeserializationError err = deserializeJson(doc, data, len);
    if (err) { client->text("{\"ok\":false,\"err\":\"bad_json\"}"); return; }

    String action = jStr(doc["action"]);
    int id = jInt(doc["id"], -1);

    // Route actions
    if (action == "rename" && id >= 0) {
      String name = jStr(doc["name"]);
      int idx = findSlaveById(id);
      if (idx != -1) {
        strncpy(slaves[idx].name, name.c_str(), sizeof(slaves[idx].name));
        sendCommandToSlave(slaves[idx].macAddress, RENAME_SLAVE, name.c_str());
        broadcastAllSlavesData();
        client->text("{\"ok\":true}");
      } else client->text("{\"ok\":false,\"err\":\"not_found\"}");

    } else if (action == "power" && id >= 0) {
      String mode = jStr(doc["mode"]); // "on" -> enter PS, "off" -> exit PS
      int idx = findSlaveById(id);
      if (idx != -1) {
        if (mode == "on") {
          slaves[idx].isPowerSave = true;
          slaves[idx].wakeUpPending = false;
          sendCommandToSlave(slaves[idx].macAddress, ENTER_POWER_SAVE);
        } else {
          if (slaves[idx].isPowerSave) slaves[idx].wakeUpPending = true;
          sendCommandToSlave(slaves[idx].macAddress, EXIT_POWER_SAVE);
        }
        broadcastAllSlavesData();
        client->text("{\"ok\":true}");
      } else client->text("{\"ok\":false,\"err\":\"not_found\"}");

    } else if (action == "release" && id >= 0) {
      int idx = findSlaveById(id);
      if (idx != -1) {
        usedIds.erase(slaves[idx].id);
        slaves.erase(slaves.begin() + idx);
        broadcastAllSlavesData();
        client->text("{\"ok\":true}");
      } else client->text("{\"ok\":false,\"err\":\"not_found\"}");

    } else if (action == "restore" && id >= 0) {
      usedIds.insert(id);
      broadcastAllSlavesData();
      client->text("{\"ok\":true}");

    } else if (action == "reporting" && id >= 0) {
      unsigned long interval = (unsigned long) jInt(doc["interval"]);
      setReportingInterval(id, interval); client->text("{\"ok\":true}");

    } else if (action == "trigger_report" && id >= 0) {
      triggerImmediateReport(id); client->text("{\"ok\":true}");

    } else if (action == "sleep_duration" && id >= 0) {
      unsigned long secs = (unsigned long) jInt(doc["seconds"]);
      setSleepDuration(id, secs); client->text("{\"ok\":true}");

    } else if (action == "role" && id >= 0) {
      String role = jStr(doc["role"]);
      setDeviceRole(id, role.c_str()); client->text("{\"ok\":true}");

    } else if (action == "reset" && id >= 0) {
      resetSlave(id); client->text("{\"ok\":true}");

    } else if (action == "factory_reset" && id >= 0) {
      factoryResetSlave(id); client->text("{\"ok\":true}");

    } else if (action == "debug" && id >= 0) {
      bool enable = jBool(doc["enable"]);
      setDebugMode(id, enable); client->text("{\"ok\":true}");

    } else if (action == "ping" && id >= 0) {
      pingSlave(id); client->text("{\"ok\":true}");

    } else if (action == "gpio" && id >= 0) {
      int pin = jInt(doc["pin"]); int state = jInt(doc["state"]);
      setGpioState(id, pin, state); client->text("{\"ok\":true}");

    } else if (action == "analog" && id >= 0) {
      int pin = jInt(doc["pin"]);
      requestAnalogReading(id, pin); client->text("{\"ok\":true}");

    } else if (action == "tx_power" && id >= 0) {
      int pwr = jInt(doc["power"]);
      setTransmitPower(id, pwr); client->text("{\"ok\":true}");

    } else if (action == "wifi_scan" && id >= 0) {
      requestWifiScan(id); client->text("{\"ok\":true}");

    } else if (action == "hello") {
      client->text("{\"ok\":true,\"hello\":true}");
    } else {
      client->text("{\"ok\":false,\"err\":\"unknown_action\"}");
    }
  }
}


void OnDataRecv(const esp_now_recv_info * info, const uint8_t *incomingData, int len) {
    struct_message msg;
    memcpy(&msg, incomingData, sizeof(msg));

    int slaveIndex = findSlaveByMac(info->src_addr);

    if (slaveIndex == -1) { // New slave
        SlaveDevice newSlave;
        newSlave.id = getNextAvailableId(); // Use the lowest available ID
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
    
    // Initialize the used IDs set
    usedIds.clear();

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
