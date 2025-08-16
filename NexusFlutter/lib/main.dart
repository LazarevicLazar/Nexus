import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:http/http.dart' as http;

// --- Main Application Entry Point ---
void main() {
  runApp(const NexusApp());
}

class NexusApp extends StatelessWidget {
  const NexusApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Nexus Dashboard',
      theme: ThemeData.dark().copyWith(
        primaryColor: const Color(0xFF00aaff),
        scaffoldBackgroundColor: const Color(0xFF121212),
        cardColor: const Color(0xFF1e1e1e),
        hintColor: const Color(0xFF00aaff),
        textTheme: const TextTheme(
          bodyLarge: TextStyle(color: Color(0xFFe0e0e0)),
          bodyMedium: TextStyle(color: Color(0xFFe0e0e0)),
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: const Color(0xFF00aaff),
            foregroundColor: const Color(0xFF121212),
          ),
        ),
      ),
      home: const HomeScreen(),
    );
  }
}

// --- Data Model for a Slave Device ---
class Slave {
  final int id;
  final String name;
  final int counter;
  final bool isPowerSave;
  final String status;
  final bool wakeUpPending;

  Slave({
    required this.id,
    required this.name,
    required this.counter,
    required this.isPowerSave,
    required this.status,
    required this.wakeUpPending,
  });

  factory Slave.fromJson(Map<String, dynamic> json) {
    return Slave(
      id: json['id'] ?? 0,
      name: json['name'] ?? 'Unknown',
      counter: json['counter'] ?? 0,
      isPowerSave: json['isPowerSave'] ?? false,
      status: json['status'] ?? 'Offline',
      wakeUpPending: json['wakeUpPending'] ?? false,
    );
  }
}

// --- Home Screen Widget ---
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final String _esp32Ip = "192.168.4.1";
  late WebSocketChannel _channel;
  List<Slave> _slaves = [];

  @override
  void initState() {
    super.initState();
    _connectWebSocket();
  }

  void _connectWebSocket() {
    try {
      _channel = WebSocketChannel.connect(Uri.parse('ws://$_esp32Ip/ws'));
      _channel.stream.listen(
        (data) {
          final List<dynamic> slaveData = jsonDecode(data);
          setState(() {
            _slaves = slaveData.map((json) => Slave.fromJson(json)).toList();
          });
        },
        onError: (error) {
          print("WebSocket Error: $error");
          _reconnect();
        },
        onDone: () {
          print("WebSocket disconnected");
          _reconnect();
        },
      );
    } catch (e) {
      print("Error connecting to WebSocket: $e");
      _reconnect();
    }
  }

  void _reconnect() {
    Future.delayed(const Duration(seconds: 5), () {
      print("Reconnecting to WebSocket...");
      _connectWebSocket();
    });
  }

  Future<void> _sendCommand(String endpoint, Map<String, String> params) async {
    final uri = Uri.http(_esp32Ip, endpoint, params);
    try {
      final response = await http.get(uri);
      if (response.statusCode == 200) {
        print("Command sent successfully: $endpoint");
      } else {
        print("Failed to send command: ${response.statusCode}");
      }
    } catch (e) {
      print("Error sending command: $e");
    }
  }

  void _renameSlave(int id, String newName) {
    _sendCommand('/rename', {'id': id.toString(), 'name': newName});
  }

  void _togglePower(int id, bool isPowerSave) {
    _sendCommand('/power', {
      'id': id.toString(),
      'mode': isPowerSave ? 'on' : 'off',
    });
  }

  void _releaseSlave(int id) {
    _sendCommand('/release', {'id': id.toString()});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'NEXUS',
          style: TextStyle(fontWeight: FontWeight.bold, letterSpacing: 4),
        ),
        centerTitle: true,
        backgroundColor: const Color(0xFF1e1e1e),
      ),
      body: _slaves.isEmpty
          ? const Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  CircularProgressIndicator(),
                  SizedBox(height: 20),
                  Text("Awaiting connection to Nexus network..."),
                ],
              ),
            )
          : ListView.builder(
              padding: const EdgeInsets.all(8.0),
              itemCount: _slaves.length,
              itemBuilder: (context, index) {
                return SlaveCard(
                  slave: _slaves[index],
                  onRename: _renameSlave,
                  onTogglePower: _togglePower,
                  onRelease: _releaseSlave,
                );
              },
            ),
    );
  }

  @override
  void dispose() {
    _channel.sink.close();
    super.dispose();
  }
}

// --- Slave Card Widget ---
class SlaveCard extends StatelessWidget {
  final Slave slave;
  final Function(int, String) onRename;
  final Function(int, bool) onTogglePower;
  final Function(int) onRelease;

  const SlaveCard({
    super.key,
    required this.slave,
    required this.onRename,
    required this.onTogglePower,
    required this.onRelease,
  });

  @override
  Widget build(BuildContext context) {
    final renameController = TextEditingController();
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 8.0),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: Colors.white.withOpacity(0.1)),
      ),
      child: Column(
        children: [
          // Header
          ListTile(
            title: Text(
              slave.name,
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18),
            ),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                StatusPill(status: slave.status),
                IconButton(
                  icon: const Icon(Icons.close, color: Colors.white54),
                  onPressed: () => onRelease(slave.id),
                ),
              ],
            ),
          ),
          // Body
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _buildDataColumn("HEARTBEAT", slave.counter.toString()),
                if (slave.isPowerSave || slave.wakeUpPending)
                  _buildTimerColumn(),
              ],
            ),
          ),
          // Controls
          Container(
            padding: const EdgeInsets.all(12.0),
            color: Colors.black.withOpacity(0.2),
            child: Column(
              children: [
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: renameController,
                        decoration: const InputDecoration(
                          hintText: 'Enter new name...',
                          border: OutlineInputBorder(),
                          contentPadding: EdgeInsets.symmetric(horizontal: 10),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    ElevatedButton(
                      onPressed: () =>
                          onRename(slave.id, renameController.text),
                      child: const Text('Rename'),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: PowerButton(
                    isPowerSave: slave.isPowerSave,
                    isPending: slave.wakeUpPending,
                    onPressed: () => onTogglePower(slave.id, slave.isPowerSave),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildDataColumn(String label, String value) {
    return Column(
      children: [
        Text(
          label,
          style: const TextStyle(
            color: Colors.white54,
            fontSize: 12,
            letterSpacing: 1,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          value,
          style: TextStyle(
            color: Colors.blueAccent,
            fontSize: 40,
            fontWeight: FontWeight.bold,
          ),
        ),
      ],
    );
  }

  Widget _buildTimerColumn() {
    return Column(
      children: [
        const Text(
          "NEXT CHECK-IN",
          style: TextStyle(
            color: Colors.white54,
            fontSize: 12,
            letterSpacing: 1,
          ),
        ),
        const SizedBox(height: 4),
        CountdownTimer(),
      ],
    );
  }
}

// --- Helper Widgets ---

class StatusPill extends StatelessWidget {
  final String status;
  const StatusPill({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    final isOnline = status == 'Online';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: isOnline
            ? Colors.green.withOpacity(0.2)
            : Colors.red.withOpacity(0.2),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        status,
        style: TextStyle(
          color: isOnline ? Colors.greenAccent : Colors.redAccent,
          fontWeight: FontWeight.bold,
          fontSize: 12,
        ),
      ),
    );
  }
}

class PowerButton extends StatelessWidget {
  final bool isPowerSave;
  final bool isPending;
  final VoidCallback onPressed;

  const PowerButton({
    super.key,
    required this.isPowerSave,
    required this.isPending,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    String text;
    Color bgColor;

    if (isPending) {
      text = 'Waking Up...';
      bgColor = Colors.orange;
    } else if (isPowerSave) {
      text = 'Power Save ON';
      bgColor = Colors.grey[700]!;
    } else {
      text = 'Power Save OFF';
      bgColor = Theme.of(context).primaryColor;
    }

    return ElevatedButton(
      onPressed: onPressed,
      style: ElevatedButton.styleFrom(backgroundColor: bgColor),
      child: Text(text),
    );
  }
}

class CountdownTimer extends StatefulWidget {
  @override
  _CountdownTimerState createState() => _CountdownTimerState();
}

class _CountdownTimerState extends State<CountdownTimer> {
  Timer? _timer;
  int _timeLeft = 60;

  @override
  void initState() {
    super.initState();
    startTimer();
  }

  void startTimer() {
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (_timeLeft > 0) {
        setState(() {
          _timeLeft--;
        });
      } else {
        timer.cancel();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Text(
      '${_timeLeft}s',
      style: const TextStyle(
        color: Colors.blueAccent,
        fontSize: 40,
        fontWeight: FontWeight.bold,
      ),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
