# Nexus Master Node

<p align="center">
<img src="../pictures/CoreSkeletonMaster.png" alt="Master Core Skeleton" width="400"/>
</p>

## Overview

The Master node is the central hub of the Nexus Network system. It manages communication with all Slave nodes, provides a web interface for monitoring and control, and handles the coordination of the entire network.

## Core Features

- **ESP-NOW Communication**: Efficient low-latency communication with Slave nodes
- **Web Server**: Hosts the dashboard interface accessible via WiFi
- **WebSocket Support**: Real-time updates to the web interface
- **Slave Management**: Handles registration, monitoring, and control of Slave nodes
- **Command Routing**: Processes and routes commands to appropriate Slave nodes
- **State Tracking**: Maintains the current state of all connected devices

## Hardware Requirements

- ESP32 (original or S3 variant recommended)
- Minimum 4MB flash memory
- USB connection for programming and power

## Software Architecture

The Master node software is built around these core components:

1. **ESP-NOW Manager**: Handles device discovery and communication
2. **Web Server**: Provides the user interface via HTTP and WebSockets
3. **Slave Registry**: Maintains information about connected devices
4. **Command Processor**: Interprets and routes commands to Slaves
5. **State Manager**: Tracks and updates the state of all devices

## Web Interface

The web interface provides:

- Real-time status of all connected Slave nodes
- Controls for power management, GPIO, and device settings
- Configuration options for reporting intervals and sleep durations
- System actions like reset and factory reset
- Queue system for managing removed Slaves

## Getting Started

1. Install required libraries:

   - WiFi
   - DNSServer
   - esp_now
   - SPIFFS
   - ArduinoJson
   - AsyncTCP
   - ESPAsyncWebServer

2. Flash the Master.ino sketch to your ESP32 device

3. Connect to the "Nexus Network" WiFi access point

4. Access the dashboard at http://192.168.4.1

## Configuration

The Master node creates its own WiFi access point by default. The settings can be modified in the Master.ino file:

- WiFi SSID: "Nexus Network"
- WiFi Password: "password123"
- Web Server Port: 80

## Development Status

The core skeleton of the Master node is complete and functional. Ongoing development focuses on enhancing features and improving stability.
