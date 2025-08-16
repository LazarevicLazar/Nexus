# Nexus Slave Node

<p align="center">
<img src="../pictures/CoreSkeletonSlave.png" alt="Slave Core Skeleton" width="400"/>
</p>

## Overview

The Slave node is a key component of the Nexus Network system. Each Slave connects to the Master node via ESP-NOW protocol, providing sensor data and accepting commands for remote control of its functions.

## Core Features

- **ESP-NOW Communication**: Efficient low-latency communication with the Master node
- **Power Management**: Configurable deep sleep for battery conservation
- **GPIO Control**: Remote control of digital pins
- **ADC Reading**: Analog input measurement and reporting
- **Configurable Parameters**: Customizable reporting intervals and sleep durations
- **Debug Mode**: Enhanced logging for troubleshooting

## Hardware Recommendations

- ESP32-C3 Super Mini (recommended for size and power efficiency)
- Battery power source for portable applications
- Sensors or actuators connected to GPIO pins as needed

## Software Architecture

The Slave node software is built around these core components:

1. **ESP-NOW Client**: Handles communication with the Master node
2. **Command Interpreter**: Processes incoming commands
3. **State Manager**: Maintains device configuration and state
4. **Power Manager**: Controls sleep cycles and power modes
5. **I/O Controller**: Manages GPIO and ADC operations

## Supported Commands

The Slave node responds to these commands from the Master:

- **RENAME_SLAVE**: Change the device name
- **ENTER_POWER_SAVE**: Enter deep sleep mode
- **EXIT_POWER_SAVE**: Wake from deep sleep mode
- **SET_REPORTING_INTERVAL**: Change data reporting frequency
- **TRIGGER_IMMEDIATE_REPORT**: Force an immediate data report
- **SET_SLEEP_DURATION**: Configure deep sleep duration
- **SET_DEVICE_ROLE**: Set the functional role of the device
- **RESET_SLAVE**: Perform a software reset
- **FACTORY_RESET**: Reset to default settings
- **ENABLE_DEBUG_MODE**: Toggle enhanced logging
- **PING_SLAVE**: Check connectivity
- **SET_GPIO_STATE**: Control digital output pins
- **READ_ANALOG_PIN**: Read from ADC pins
- **SET_TRANSMIT_POWER**: Configure ESP-NOW transmit power

## Getting Started

1. Install required libraries:

   - WiFi
   - esp_now
   - ESP32 (board support package)

2. Flash the Slave.ino sketch to your ESP32-C3 device

3. Power on the device - it will automatically connect to the Master when in range

## Power Management

The Slave node supports deep sleep mode for battery conservation:

- Configurable sleep duration (minimum 10 seconds recommended)
- Automatic wake-up and reporting
- Manual wake-up via Master command

## Development Status

The core skeleton of the Slave node is complete and functional. Ongoing development focuses on enhancing features, improving power efficiency, and adding support for additional sensors.
