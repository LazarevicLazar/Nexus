#include <esp_now.h>
#include <WiFi.h>
#include <Preferences.h>
#include <esp_wifi.h> // Required for setting Tx power

// --- Configuration ---
#define ACTIVE_DELAY_MS 2000
#define POWER_SAVE_DURATION 60 * 1000000 

uint8_t broadcastAddress[] = {0x24, 0x58, 0x7C, 0xD0, 0x5F, 0xFC};

RTC_DATA_ATTR bool inPowerSaveMode;
RTC_DATA_ATTR int bootCount = 0;

// --- Data Structures ---
typedef struct struct_message {
    char name[32];
    int counter;
    bool isPowerSave;
    char deviceRole[32];      
    bool debugMode;           
    unsigned long reportingInterval; 
    int analogReadings[6];    
    bool pingResponse;       
} struct_message;

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

typedef struct struct_command {
    CommandType command;
    char payload[32];
} struct_command;

// --- Global Variables ---
struct_message myData;
Preferences preferences;
unsigned long reportingInterval = ACTIVE_DELAY_MS;
unsigned long sleepDuration = POWER_SAVE_DURATION / 1000000; 
bool debugMode = false;
char deviceRole[32] = "Generic Slave";
bool shouldReset = false;
bool shouldFactoryReset = false;
bool shouldTriggerReport = false;

// --- ESP-NOW Callbacks ---

void OnDataSent(const wifi_tx_info_t *info, esp_now_send_status_t status) {
  if (debugMode) {
    Serial.println(status == ESP_NOW_SEND_SUCCESS ? "Delivery Success" : "Delivery Fail");
  }
}

void OnDataRecv(const esp_now_recv_info *info, const uint8_t *incomingData, int len) {
  struct_command command;
  memcpy(&command, incomingData, sizeof(command));

  switch(command.command) {
    case RENAME_SLAVE:
      Serial.printf("Rename command received. New name: %s\n", command.payload);
      preferences.begin("nexus-slave", false);
      preferences.putString("slaveName", command.payload);
      preferences.end();
      break;
    
    case ENTER_POWER_SAVE: {
      Serial.println("Entering Power Save Mode immediately.");
      inPowerSaveMode = true;
      // Send immediate confirmation with power save status
      myData.isPowerSave = true;
      esp_now_send(broadcastAddress, (uint8_t *) &myData, sizeof(myData));
      delay(100); // Brief delay to ensure message is sent
      
      // Enter deep sleep immediately for faster power save transition
      unsigned long sleepMicros = sleepDuration * 1000000UL;
      Serial.printf("Going to sleep for %lu seconds...\n", sleepDuration);
      esp_deep_sleep(sleepMicros);
      break;
    }

    case EXIT_POWER_SAVE:
      Serial.println("Exiting Power Save Mode.");
      inPowerSaveMode = false;
      // Send immediate confirmation
      myData.isPowerSave = false;
      esp_now_send(broadcastAddress, (uint8_t *) &myData, sizeof(myData));
      break;
      
    case SET_REPORTING_INTERVAL: {
      unsigned long interval = atol(command.payload);
      if (interval >= 500) { // Minimum 500ms to prevent flooding
        reportingInterval = interval;
        Serial.printf("Set reporting interval to %lu ms\n", interval);
        preferences.begin("nexus-slave", false);
        preferences.putULong("reportInterval", interval);
        preferences.end();
      }
      break;
    }
    
    case TRIGGER_IMMEDIATE_REPORT:
      Serial.println("Immediate report requested");
      shouldTriggerReport = true;
      break;
      
    case SET_SLEEP_DURATION: {
      unsigned long seconds = atol(command.payload);
      if (seconds >= 10) { // Minimum 10 seconds
        sleepDuration = seconds;
        Serial.printf("Set sleep duration to %lu seconds\n", seconds);
        preferences.begin("nexus-slave", false);
        preferences.putULong("sleepDuration", seconds);
        preferences.end();
      }
      break;
    }
    
    case SET_DEVICE_ROLE:
      Serial.printf("Setting device role to: %s\n", command.payload);
      strncpy(deviceRole, command.payload, sizeof(deviceRole));
      preferences.begin("nexus-slave", false);
      preferences.putString("deviceRole", command.payload);
      preferences.end();
      break;
      
    case RESET_SLAVE:
      Serial.println("Reset command received. Will reset after sending response.");
      shouldReset = true;
      break;
      
    case FACTORY_RESET:
      Serial.println("Factory reset command received. Will erase all settings and reset.");
      shouldFactoryReset = true;
      break;
      
    case ENABLE_DEBUG_MODE: {
      bool enable = (strcmp(command.payload, "1") == 0 || strcmp(command.payload, "true") == 0);
      debugMode = enable;
      Serial.printf("Debug mode %s\n", enable ? "enabled" : "disabled");
      preferences.begin("nexus-slave", false);
      preferences.putBool("debugMode", enable);
      preferences.end();
      break;
    }
    
    case PING_SLAVE:
      Serial.println("Ping received, sending response");
      myData.pingResponse = true; // Set flag to indicate ping response
      break;

    case SET_GPIO_STATE: {
      int pin, state;
      if (sscanf(command.payload, "%d:%d", &pin, &state) == 2) {
        if ((pin >= 0 && pin <= 10) || pin == 20 || pin == 21) {
          Serial.printf("Setting GPIO %d to %d\n", pin, state);
          pinMode(pin, OUTPUT);
          digitalWrite(pin, state);
        } else {
          Serial.printf("Invalid/unsafe GPIO pin %d for C3 Super Mini\n", pin);
        }
      }
      break;
    }

    case READ_ANALOG_PIN: {
      int pin = atoi(command.payload);
      if (pin >= 0 && pin <= 5) {
        int reading = analogRead(pin);
        Serial.printf("Analog reading from pin %d: %d\n", pin, reading);
        myData.analogReadings[pin] = reading;
      } else {
        Serial.printf("Invalid ADC pin %d for ESP32-C3 Super Mini\n", pin);
      }
      break;
    }

    case SET_TRANSMIT_POWER: {
      int power = atoi(command.payload);
      if (power >= 20 && power <= 80) {
        Serial.printf("Setting Tx Power to %d (approx %d dBm)\n", power, power/4);
        esp_wifi_set_max_tx_power(power);
      } else {
        Serial.println("Invalid Tx Power value. Must be 20-80.");
      }
      break;
    }
    
    case SCAN_WIFI_NETWORKS: {
      Serial.println("Scanning for WiFi networks...");
      int networksFound = WiFi.scanNetworks();
      Serial.printf("Found %d networks\n", networksFound);
      
      if (debugMode) {
        for (int i = 0; i < networksFound; i++) {
          Serial.printf("%d: %s (%d dBm)\n", i + 1, WiFi.SSID(i).c_str(), WiFi.RSSI(i));
        }
      }
      break;
    }
  }
}
 
// --- Setup and Loop ---

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);

  // Load saved preferences
  preferences.begin("nexus-slave", true);
  reportingInterval = preferences.getULong("reportInterval", ACTIVE_DELAY_MS);
  sleepDuration = preferences.getULong("sleepDuration", POWER_SAVE_DURATION / 1000000);
  debugMode = preferences.getBool("debugMode", false);
  String role = preferences.getString("deviceRole", "Generic Slave");
  strncpy(deviceRole, role.c_str(), sizeof(deviceRole));
  preferences.end();

  if (esp_now_init() != ESP_OK) {
    Serial.println("Error initializing ESP-NOW");
    return;
  }

  esp_now_register_send_cb(OnDataSent);
  esp_now_register_recv_cb(OnDataRecv);
  
  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, broadcastAddress, 6);
  peerInfo.channel = 0;
  peerInfo.encrypt = false;
  
  if (esp_now_add_peer(&peerInfo) != ESP_OK){
    Serial.println("Failed to add peer");
    return;
  }
  
  Serial.println("ESP32-C3 Super Mini Slave initialized");
  if (debugMode) {
    Serial.printf("Reporting interval: %lu ms\n", reportingInterval);
    Serial.printf("Sleep duration: %lu seconds\n", sleepDuration);
    Serial.printf("Device role: %s\n", deviceRole);
    Serial.printf("Debug mode: enabled\n");
  }
}
 
void loop() {
  bootCount++;
  
  // Prepare data to send
  myData.counter = bootCount;
  myData.isPowerSave = inPowerSaveMode;
  
  // Load name from preferences
  preferences.begin("nexus-slave", true);
  String savedName = preferences.getString("slaveName", "ESP32-C3 Super Mini");
  preferences.end();
  strncpy(myData.name, savedName.c_str(), sizeof(myData.name));
  
  // Set additional fields
  strncpy(myData.deviceRole, deviceRole, sizeof(myData.deviceRole));
  myData.debugMode = debugMode;
  myData.reportingInterval = reportingInterval;
  
  // Send data to master
  esp_err_t result = esp_now_send(broadcastAddress, (uint8_t *) &myData, sizeof(myData));
  if (result != ESP_OK) {
    Serial.println("Error sending the data.");
  } else if (debugMode) {
    Serial.println("Data sent successfully");
  }
  
  // Reset ping response flag after sending
  myData.pingResponse = false;
  
  // Listen for commands - reduced delay for faster power save transitions
  delay(100);
  
  // Handle reset commands
  if (shouldReset) {
    Serial.println("Performing reset...");
    delay(50);
    ESP.restart();
  }
  
  if (shouldFactoryReset) {
    Serial.println("Performing factory reset...");
    preferences.begin("nexus-slave", false);
    preferences.clear();
    preferences.end();
    delay(50);
    ESP.restart();
  }
  
  // Handle immediate report request
  if (shouldTriggerReport) {
    shouldTriggerReport = false;
    Serial.println("Sending immediate report");
    // We'll just continue to the next loop iteration immediately
    return;
  }
  
  // Sleep or delay based on power mode
  if (inPowerSaveMode) {
    unsigned long sleepMicros = sleepDuration * 1000000UL;
    Serial.printf("Going to sleep for %lu seconds...\n", sleepDuration);
    esp_deep_sleep(sleepMicros);
  } else {
    delay(reportingInterval);
  }
}