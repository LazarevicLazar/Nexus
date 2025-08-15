#include <esp_now.h>
#include <WiFi.h>
#include <Preferences.h>

// Define the sleep/delay durations
#define ACTIVE_DELAY_MS 2000
#define POWER_SAVE_DURATION 60 * 1000000 // 1 minute

// RTC memory variables to persist through deep sleep
RTC_DATA_ATTR bool inPowerSaveMode = false;
RTC_DATA_ATTR int bootCount = 0;

// REPLACE WITH THE MAC ADDRESS OF YOUR MASTER BOARD
uint8_t broadcastAddress[] = {0x24, 0x58, 0x7C, 0xD0, 0x5F, 0xFC};

// --- Data Structures ---

// The slave no longer sends an ID. The master will assign one.
typedef struct struct_message {
    char name[32];
    int counter;
    bool isPowerSave;
} struct_message;

typedef enum {
  RENAME_SLAVE,
  ENTER_POWER_SAVE,
  EXIT_POWER_SAVE
} CommandType;

typedef struct struct_command {
  CommandType command;
  char payload[32];
} struct_command;

struct_message myData;
Preferences preferences;

// Callback when data is sent
void OnDataSent(const wifi_tx_info_t *info, esp_now_send_status_t status) {
  Serial.println(status == ESP_NOW_SEND_SUCCESS ? "Delivery Success" : "Delivery Fail");
}

// Callback when a command is received
void OnDataRecv(const esp_now_recv_info *info, const uint8_t *incomingData, int len) {
  struct_command command;
  memcpy(&command, incomingData, sizeof(command));

  switch(command.command) {
    case RENAME_SLAVE:
      Serial.print("Rename command received. New name: ");
      Serial.println(command.payload);
      preferences.begin("nexus-slave", false);
      preferences.putString("slaveName", command.payload);
      preferences.end();
      break;
    
    case ENTER_POWER_SAVE:
      Serial.println("Entering Power Save Mode on next cycle.");
      inPowerSaveMode = true;
      break;

    case EXIT_POWER_SAVE:
      Serial.println("Exiting Power Save Mode.");
      inPowerSaveMode = false;
      break;
  }
}
 
void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);

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
}
 
void loop() {
  bootCount++;
  myData.counter = bootCount;
  myData.isPowerSave = inPowerSaveMode;

  preferences.begin("nexus-slave", true);
  String savedName = preferences.getString("slaveName", "Unassigned Slave");
  preferences.end();
  strncpy(myData.name, savedName.c_str(), sizeof(myData.name));

  esp_err_t result = esp_now_send(broadcastAddress, (uint8_t *) &myData, sizeof(myData));
  if (result != ESP_OK) {
    Serial.println("Error sending the data.");
  }

  delay(200); // Listening window for commands

  if (inPowerSaveMode) {
    Serial.printf("Going to sleep for %d seconds...\n", POWER_SAVE_DURATION / 1000000);
    esp_deep_sleep(POWER_SAVE_DURATION);
  } else {
    delay(ACTIVE_DELAY_MS);
  }
}
