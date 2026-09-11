/**
 * What the app thinks it just did.
 *
 * Two jobs. It makes the seed and the mode visible, so a screenshot of a failing
 * run carries the information needed to repeat it — the thing the fingerprint
 * collision cost two days for want of. And it lists the app's own recent HTTP
 * calls, which is the ground truth for the network-visibility work (DEFERRED
 * 80): simframe should be able to see the same calls from outside, and this
 * screen is what "the same" is checked against.
 *
 * Deliberately plain text in a scroll view. It is read by a tool, not admired.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { currentMode, recentCalls, setMode, type Call } from '../api';
import { currentSeed } from '../seed';

const Nav = createNativeStackNavigator();

function DiagnosticsScreen() {
  const [, tick] = useState(0);
  const [calls, setCalls] = useState<Call[]>([]);
  useEffect(() => {
    const t = setInterval(() => { setCalls(recentCalls()); tick((n) => n + 1); }, 500);
    return () => clearInterval(t);
  }, []);

  return (
    <ScrollView style={styles.fill} contentInsetAdjustmentBehavior="automatic">
      <View style={styles.block}>
        <Text style={styles.k}>Seed</Text>
        <Text style={styles.v} accessibilityLabel={`Seed ${currentSeed()}`}>{currentSeed()}</Text>
      </View>
      <View style={styles.block}>
        <Text style={styles.k}>Mode</Text>
        <Text style={styles.v} accessibilityLabel={`Mode ${currentMode()}`}>{currentMode()}</Text>
      </View>
      <Pressable
        style={styles.toggle}
        accessibilityRole="button"
        accessibilityLabel={currentMode() === 'offline' ? 'Go live' : 'Go offline'}
        onPress={() => setMode(currentMode() === 'offline' ? 'live' : 'offline')}
      >
        <Text style={styles.toggleText}>
          {currentMode() === 'offline' ? 'Go live' : 'Go offline'}
        </Text>
      </Pressable>

      <Text style={styles.section}>Recent calls</Text>
      {calls.length === 0 ? (
        <Text style={styles.empty}>Nothing yet. Open Plants or submit a form.</Text>
      ) : (
        calls.slice().reverse().map((c, i) => (
          <View key={`${c.url}-${i}`} style={styles.call}>
            <Text style={styles.callLine} accessibilityLabel={`${c.method} ${c.status ?? 'failed'} ${c.ms} milliseconds`}>
              {c.method} {c.status ?? 'failed'} · {c.ms}ms · {c.mode}
            </Text>
            <Text style={styles.callUrl}>{c.url}</Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

export function DiagnosticsStack() {
  return (
    <Nav.Navigator>
      <Nav.Screen
        name="Diagnostics"
        component={DiagnosticsScreen}
        options={{ title: 'Diagnostics', headerLargeTitle: true }}
      />
    </Nav.Navigator>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#f2f2f7' },
  block: {
    backgroundColor: 'white', paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#c6c6c8',
    flexDirection: 'row', justifyContent: 'space-between',
  },
  k: { fontSize: 15, color: '#6d6d72' },
  v: { fontSize: 15, fontVariant: ['tabular-nums'] },
  toggle: { margin: 16, paddingVertical: 12, borderRadius: 10, backgroundColor: '#e5e5ea', alignItems: 'center' },
  toggleText: { fontSize: 17, color: '#007aff' },
  section: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6, color: '#6d6d72', fontSize: 13 },
  empty: { paddingHorizontal: 16, color: '#8e8e93', fontSize: 13 },
  call: {
    backgroundColor: 'white', paddingHorizontal: 16, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#c6c6c8',
  },
  callLine: { fontSize: 14 },
  callUrl: { fontSize: 12, color: '#8e8e93' },
});
