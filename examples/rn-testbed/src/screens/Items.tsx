/**
 * A list and its detail screen — 110's two nameless-screen classes, live.
 *
 * `Items` is a **root** screen, so `native-stack` gives it a real iOS large
 * title. `ItemDetail` is **pushed**, so it gets a compact bar with a back
 * button. That pair is the whole of item 110: a large title is drawn tight
 * against its content and the top-chrome detector looks for the gap *beneath* a
 * bar, so the root screen's own name was discarded as content and the screen
 * had no name in its fingerprint at all. Two such screens then collided.
 *
 * Neither shape is reproducible on a hosted runner in under thirty minutes.
 * Both are reproducible here in seconds, which is the point of the testbed.
 *
 * The list also arrives the way real lists do: a count header first, rows
 * after, sometimes in two waves. That is a screen which is *stable* and
 * *incomplete* at the same instant, which is the state settle detection and the
 * supervisor have both misread.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { fetchItem, fetchItems, listArrivesInWaves, refreshMs, secondWaveMs, type Item } from '../api';

type Stack = {
  Items: undefined;
  ItemDetail: { id: number; title: string };
};

const Nav = createNativeStackNavigator<Stack>();

function ItemsScreen({ navigation }: NativeStackScreenProps<Stack, 'Items'>) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setItems(null);
    const rows = await fetchItems();
    // The header knows the count before the rows exist. Deliberate: a caller
    // that reads "24 plants" and no rows has read a real screen, and
    // deciding whether to wait is exactly the supervisor's job.
    setTotal(rows.length);
    if (listArrivesInWaves()) {
      setItems(rows.slice(0, Math.ceil(rows.length / 3)));
      setTimeout(() => setItems(rows), secondWaveMs());
    } else {
      setItems(rows);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <View style={styles.fill}>
      {total != null && (
        <Text style={styles.countHeader} accessibilityLabel={`${total} plants`}>
          {total} plants
        </Text>
      )}
      {items == null ? (
        <View style={styles.centre}>
          <ActivityIndicator accessibilityLabel="Loading plants" />
          <Text style={styles.muted}>Loading…</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => String(i.id)}
          // Without this the rows start at the top of the screen and scroll
          // *under* the large title, which interleaves the title with the list
          // in y order — the first `sim_ui` read of this screen showed
          // "Plants" sitting between rows 2 and 4 and filed as content.
          // A testbed whose own layout is wrong teaches the wrong lesson.
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.listContent}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                setTimeout(() => { setRefreshing(false); load(); }, refreshMs());
              }}
            />
          )}
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              accessibilityRole="button"
              accessibilityLabel={item.title}
              onPress={() => navigation.navigate('ItemDetail', { id: item.id, title: item.title })}
            >
              <Text style={styles.rowTitle}>{item.title}</Text>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function ItemDetailScreen({ route }: NativeStackScreenProps<Stack, 'ItemDetail'>) {
  const [item, setItem] = useState<Item | null>(null);
  useEffect(() => { fetchItem(route.params.id).then(setItem); }, [route.params.id]);
  return (
    <View style={styles.fill}>
      {item == null ? (
        <View style={styles.centre}><ActivityIndicator accessibilityLabel="Loading detail" /></View>
      ) : (
        <View style={styles.detail}>
          <Text style={styles.detailTitle}>{item.title}</Text>
          <Text style={styles.detailBody}>{item.body}</Text>
        </View>
      )}
    </View>
  );
}

export function ItemsStack() {
  return (
    <Nav.Navigator>
      {/* `headerLargeTitle` is the whole reason this library is here: it is a
          real UINavigationController large title, not a styled Text. */}
      <Nav.Screen
        name="Items"
        component={ItemsScreen}
        options={{ title: 'Plants', headerLargeTitle: true }}
      />
      {/* Pushed, so iOS draws a compact bar with a back button titled
          "Plants" — the second of 110's two shapes. */}
      <Nav.Screen
        name="ItemDetail"
        component={ItemDetailScreen}
        options={({ route }) => ({ title: route.params.title, headerLargeTitle: false })}
      />
    </Nav.Navigator>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#f2f2f7' },
  listContent: { paddingBottom: 24 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  muted: { color: '#8e8e93' },
  countHeader: { paddingHorizontal: 16, paddingVertical: 10, color: '#6d6d72', fontSize: 13 },
  row: {
    backgroundColor: 'white', paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#c6c6c8',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  rowTitle: { fontSize: 17 },
  chevron: { color: '#c7c7cc', fontSize: 20 },
  detail: { padding: 16, gap: 12 },
  detailTitle: { fontSize: 22, fontWeight: '600' },
  detailBody: { fontSize: 15, color: '#3c3c43', lineHeight: 21 },
});
