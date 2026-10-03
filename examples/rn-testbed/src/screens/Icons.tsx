/**
 * Icon-only buttons drawn with an icon font, and nothing else to name them.
 *
 * react-native-vector-icons and every icon font draw an icon as text: one
 * character in a Unicode private use area, set in the icon font. Pressable
 * gathers its children's text into its accessibility label, so the label of a
 * button that shows only an icon is that one character. simframe stripped it as
 * noise for months, and those buttons read as unlabeled. It now looks the
 * character up in the app's own font (src/glyphs.js), and this screen is how
 * that is checked on a real tree rather than reasoned about.
 *
 * Feather.ttf ships in the app bundle and is listed under UIAppFonts, the way
 * react-native-vector-icons installs it. The glyphs are written as code points
 * deliberately, with no accessibilityLabel and (except one) no testID: that is
 * the unlabeled case. The dangerous ones (trash-2, send, log-out) are here
 * because a name is only useful if the barrier can refuse it.
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

const Nav = createNativeStackNavigator();

// Feather code points, as react-native-vector-icons' glyph map gives them.
const GLYPHS: Array<[string, number, string?]> = [
  ['bell', 0xf11e],
  ['search', 0xf1d0],
  ['more-horizontal', 0xf1a8],
  ['bookmark', 0xf124, 'icons-bookmark-button'],
  ['trash-2', 0xf1f5],
  ['send', 0xf1d1],
  ['log-out', 0xf195],
];

function IconsScreen() {
  const [last, setLast] = useState('nothing yet');
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.page}>
      <View style={styles.grid}>
        {GLYPHS.map(([name, cp, testID]) => (
          <Pressable key={name} accessibilityRole="button" testID={testID}
            onPress={() => setLast(name)} style={styles.button}>
            <Text style={styles.glyph}>{String.fromCodePoint(cp)}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable accessibilityRole="button" onPress={() => setLast('settings')} style={styles.row}>
        <Text style={styles.rowText}><Text style={styles.inline}>{String.fromCodePoint(0xf1d3)}</Text> Settings</Text>
      </Pressable>
      <Text style={styles.status}>Last pressed: {last}</Text>
    </ScrollView>
  );
}

export function IconsStack() {
  return (
    <Nav.Navigator>
      <Nav.Screen name="Icons" component={IconsScreen} options={{ headerLargeTitle: true }} />
    </Nav.Navigator>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  button: { width: 64, height: 64, borderRadius: 12, backgroundColor: '#eef', alignItems: 'center', justifyContent: 'center' },
  glyph: { fontFamily: 'Feather', fontSize: 28, color: '#223' },
  row: { marginTop: 24, padding: 14, borderRadius: 10, backgroundColor: '#eef' },
  rowText: { fontSize: 17, color: '#223' },
  inline: { fontFamily: 'Feather', fontSize: 17 },
  status: { marginTop: 24, fontSize: 15, color: '#555' },
});
