#include <WiFi.h>
#include <DNSServer.h>
#include <esp_now.h>
#include <SPIFFS.h>
#include <ArduinoJson.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <vector>

// --- Data Structures ---

// Structure to hold data from a slave (no ID here)
typedef struct struct_message {
    char name[32];
    int counter;
    bool isPowerSave;
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
};

// A vector to store all known slave devices
std::vector<SlaveDevice> slaves;
int nextSlaveId = 1;

// Commands to send back to slaves
typedef enum { RENAME_SLAVE, ENTER_POWER_SAVE, EXIT_POWER_SAVE } CommandType;
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
    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
        Serial.println("Failed to add peer for sending command");
        return;
    }
    esp_now_send(mac, (uint8_t *) &command, sizeof(command));
    esp_now_del_peer(mac);
}

// Broadcast the data of all slaves to all WebSocket clients
void broadcastAllSlavesData() {
    StaticJsonDocument<1024> jsonDoc;
    JsonArray slavesArray = jsonDoc.to<JsonArray>();

    for (const auto& slave : slaves) {
        JsonObject slaveObj = slavesArray.createNestedObject();
        slaveObj["id"] = slave.id;
        slaveObj["name"] = slave.name;
        slaveObj["counter"] = slave.counter;
        slaveObj["isPowerSave"] = slave.isPowerSave;
        slaveObj["status"] = slave.isOnline ? "Online" : "Offline";
        slaveObj["wakeUpPending"] = slave.wakeUpPending;
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

    if(!SPIFFS.begin(true)) { Serial.println("Failed to mount SPIFFS"); return; }

    WiFi.mode(WIFI_STA);
    if (esp_now_init() != ESP_OK) { Serial.println("Error initializing ESP-NOW"); return; }
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
