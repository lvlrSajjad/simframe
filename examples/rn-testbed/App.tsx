/**
 * simframe's testbed: an app that fails on purpose, reproducibly.
 *
 * Three tabs, each a real `native-stack` so the nav bars are
 * `UINavigationController` bars rather than styled views — large titles on the
 * roots, compact bars with back buttons on anything pushed. That pair is item
 * 110's subject and neither shape can be reproduced on a hosted runner inside
 * half an hour.
 *
 * Everything that varies comes from one seeded stream, and the seed is on the
 * Diagnostics tab. Set it from outside, so a failing run can be repeated
 * exactly:
 *
 *   simframe do '[{"openUrl":"simframetestbed://seed/1234"}]'
 *   simframe do '[{"openUrl":"simframetestbed://live/on"}]'
 */
import React from 'react';
import { Text } from 'react-native';
import { NavigationContainer, type LinkingOptions } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ItemsStack } from './src/screens/Items';
import { FormsStack } from './src/screens/Forms';
import { DiagnosticsStack } from './src/screens/Diagnostics';
import { reseed } from './src/seed';
import { setMode } from './src/api';

const Tabs = createBottomTabNavigator();

/**
 * Deep links, used as a control channel rather than for navigation.
 *
 * `openUrl` is the one way to reach inside a running app from simframe without
 * a native module, so the knobs that must be settable from a test — the seed and
 * the network mode — are URLs. Parsed here and swallowed: these links change
 * state and deliberately do not navigate, because a test that had to visit a
 * screen to set a seed would perturb the run it was setting up.
 */
const linking: LinkingOptions<ReactNavigation.RootParamList> = {
  prefixes: ['simframetestbed://'],
  config: { screens: {} },
  subscribe(listener) {
    const handle = (url: string) => {
      const seed = /seed\/(\d+)/.exec(url);
      if (seed) reseed(Number(seed[1]));
      if (/live\/on/.test(url)) setMode('live');
      if (/live\/off/.test(url)) setMode('offline');
      // Never forwarded to the navigator, on purpose. See above.
    };
    const { Linking } = require('react-native');
    const sub = Linking.addEventListener('url', ({ url }: { url: string }) => handle(url));
    Linking.getInitialURL().then((url: string | null) => { if (url) handle(url); });
    return () => sub.remove();
  },
  getStateFromPath: () => undefined,
};

const icon = (glyph: string) => ({ color }: { color: string }) => (
  <Text style={{ color, fontSize: 20 }}>{glyph}</Text>
);

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer linking={linking}>
        <Tabs.Navigator screenOptions={{ headerShown: false }}>
          <Tabs.Screen name="PlantsTab" component={ItemsStack}
            options={{ title: 'Plants', tabBarIcon: icon('▤') }} />
          <Tabs.Screen name="FormsTab" component={FormsStack}
            options={{ title: 'Forms', tabBarIcon: icon('✎') }} />
          <Tabs.Screen name="DiagnosticsTab" component={DiagnosticsStack}
            options={{ title: 'Diagnostics', tabBarIcon: icon('◔') }} />
        </Tabs.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
