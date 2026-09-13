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
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { currentMode, recentCalls, setMode, type Call } from '../api';
import { currentSeed } from '../seed';

const Nav = createNativeStackNavigator();

/**
 * Something that never stops moving, in one corner — item 123.
 *
 * A settle waits for the screen to stop and some screens never do: a streaming
 * summary panel, a Lottie, a support widget. The reporter who raised it lost
 * five steps of a six-step batch to one spinner nobody cared about, because a
 * failed step aborts the rest. Their workaround was `pause` plus
 * `continueOnError`, which they called *"strictly worse than a settle that
 * knows what to ignore"*.
 *
 * Knowing what to ignore is the expensive half and is not built. Saying *where*
 * is the cheap half and is — and it could not be tested without a screen that
 * genuinely never settles. Every candidate on a stock simulator settles
 * eventually; Maps takes two seconds and then stops. So the testbed owns one.
 *
 * Small and in a corner on purpose. A full-screen animation is the easy case
 * and the map already reads "spread across the screen" for it; the case worth
 * proving is the one that should read "bottom right".
 */
function NeverSettles() {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(spin, {
      toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true,
    }));
    loop.start();
    return () => loop.stop();
  }, [spin]);
  return (
    <View style={styles.spinnerCorner} accessibilityLabel="Always animating">
      <Animated.View
        style={[styles.spinner, {
          transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
        }]}
      />
    </View>
  );
}

function DiagnosticsScreen() {
  const [, tick] = useState(0);
  const [calls, setCalls] = useState<Call[]>([]);
  useEffect(() => {
    const t = setInterval(() => { setCalls(recentCalls()); tick((n) => n + 1); }, 500);
    return () => clearInterval(t);
  }, []);

  return (
    <ScrollView style={styles.fill} contentInsetAdjustmentBehavior="automatic">
      <NeverSettles />
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
  // Right-aligned so the animation sits in one band of the region grid rather
  // than across the screen: the case worth proving is the one that should read
  // "top right", not the easy full-screen one.
  spinnerCorner: { alignItems: 'flex-end', paddingHorizontal: 16, paddingVertical: 8 },
  // Sized against the detector, and the first size was measured rather than
  // guessed a second time. At **28pt** this spinner rotates continuously and
  // `settle` returns **satisfied after 247ms**: the stillness signal is a mean
  // over a 4x8 grid, one cell is roughly 80x87 captured pixels, and a 28pt disc
  // moves that mean by less than the 0.004 threshold. Which is a real finding
  // and not this test's subject — it is the *premature settle* a field report
  // raised separately, and the testbed now reproduces it if the size below is
  // turned back down.
  //
  // 120pt is comfortably over the threshold, so the screen genuinely never
  // settles, which is what item 123 needs to exist at all.
  spinner: {
    width: 120, height: 120, borderRadius: 60,
    borderWidth: 18, borderColor: '#007aff', borderTopColor: 'transparent',
  },
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
