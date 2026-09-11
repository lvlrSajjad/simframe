/**
 * The screens that fail on purpose.
 *
 * This file exists because the supervision log held **one** ruling. A ruling
 * needs a step that genuinely fails, and Apple's Settings does not fail on
 * command — so 101, 96, 106 and 109a were all waiting on failures nobody could
 * produce. Every screen here produces one, from the seeded stream, so the same
 * seed gives the same run.
 *
 * Each maps to a word in the supervisor's vocabulary:
 *
 *   `wait`   — `SimpleForm`'s Submit is disabled until a seeded delay expires.
 *              A tap in that window fails for a reason more time *does* fix.
 *   `retry`  — the first submit always fails and the second always works, so
 *              `retry` is cheaply checkable: did the step work on attempt two?
 *   `stop`   — `Wizard`'s Review step refuses while a required field is empty.
 *              No amount of waiting or retrying helps, and a supervisor that
 *              says `wait` here is wrong in a way the log can score.
 */
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { enableAfterMs, resetSubmits, submitForm } from '../api';

type Stack = {
  FormsHome: undefined;
  SimpleForm: undefined;
  Wizard: undefined;
  LongForm: undefined;
  Confirm: undefined;
};

const Nav = createNativeStackNavigator<Stack>();

function Field({ label, value, onChange, ...rest }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        {...rest}
      />
    </View>
  );
}

function Button({ title, onPress, disabled, busy }: {
  title: string; onPress: () => void; disabled?: boolean; busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={[styles.button, (disabled || busy) && styles.buttonOff]}
    >
      {busy ? <ActivityIndicator color="white" /> : <Text style={styles.buttonText}>{title}</Text>}
    </Pressable>
  );
}

function FormsHome({ navigation }: NativeStackScreenProps<Stack, 'FormsHome'>) {
  const rows: Array<[string, keyof Stack]> = [
    ['One-step form', 'SimpleForm'],
    ['Stepped form', 'Wizard'],
    ['Long form', 'LongForm'],
  ];
  return (
    <ScrollView style={styles.fill} contentInsetAdjustmentBehavior="automatic">
      {rows.map(([title, to]) => (
        <Pressable
          key={to}
          style={styles.row}
          accessibilityRole="button"
          accessibilityLabel={title}
          onPress={() => navigation.navigate(to as never)}
        >
          <Text style={styles.rowTitle}>{title}</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      ))}
      <Pressable
        style={styles.row}
        accessibilityRole="button"
        accessibilityLabel="Confirm in a modal"
        onPress={() => navigation.navigate('Confirm')}
      >
        <Text style={styles.rowTitle}>Confirm in a modal</Text>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
    </ScrollView>
  );
}

/** `wait` and `retry`, in one screen. */
function SimpleForm() {
  const [name, setName] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    resetSubmits();
    // Disabled for a seeded interval. A tap now fails because the control is
    // not yet live — the one failure class where more time is the answer.
    const ms = enableAfterMs();
    const t = setTimeout(() => setReady(true), ms);
    return () => clearTimeout(t);
  }, []);

  return (
    <ScrollView style={styles.fill} contentInsetAdjustmentBehavior="automatic" keyboardDismissMode="on-drag">
      <Field label="Your Name" value={name} onChange={setName} placeholder="Your name" />
      <Text style={styles.hint}>
        {ready ? 'Submit is live' : 'Preparing the form…'}
      </Text>
      <Button
        title="Submit"
        disabled={!ready}
        busy={busy}
        onPress={async () => {
          setBusy(true);
          setResult(null);
          try {
            await submitForm({ name });
            setResult('Order placed');
          } catch (err) {
            setResult(`The order was rejected: ${(err as Error).message}`);
          } finally {
            setBusy(false);
          }
        }}
      />
      {result && <Text style={styles.result} accessibilityLabel={result}>{result}</Text>}
    </ScrollView>
  );
}

/**
 * The stepped form, and the shape that collapsed onto one hash.
 *
 * Its form step and its review step share a nav title and a step indicator and
 * differ only in content — which is exactly the pair that once produced one
 * fingerprint for two screens, and which has a unit test but has never been
 * driven live.
 */
function Wizard() {
  const [step, setStep] = useState(1);
  const [species, setSpecies] = useState('');
  const [potSize, setPotSize] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const missing = species.trim() === '';

  useEffect(() => { resetSubmits(); }, []);

  return (
    <ScrollView style={styles.fill} contentInsetAdjustmentBehavior="automatic">
      <Text style={styles.step} accessibilityLabel={`Step ${step} of 3`}>Step {step} of 3</Text>

      {step === 1 && (
        <>
          <Field label="Species" value={species} onChange={setSpecies} placeholder="Monstera" />
          <Button title="Next" onPress={() => setStep(2)} />
        </>
      )}
      {step === 2 && (
        <>
          <Field label="Pot Size" value={potSize} onChange={setPotSize} placeholder="Medium" />
          <Button title="Next" onPress={() => setStep(3)} />
        </>
      )}
      {step === 3 && (
        <>
          {/* Same chrome as step 1 and 2, different content. The whole point. */}
          <View style={styles.review}>
            <Text style={styles.reviewRow}>Species{'   '}{species || '—'}</Text>
            <Text style={styles.reviewRow}>Pot size{'   '}{potSize || '—'}</Text>
          </View>
          {missing && (
            <Text style={styles.blocked} accessibilityLabel="Species is required before this can be submitted">
              Species is required before this can be submitted
            </Text>
          )}
          {/* `stop`: waiting and retrying are both wrong here. */}
          <Button
            title="Review"
            disabled={missing}
            busy={busy}
            onPress={async () => {
              setBusy(true);
              try { await submitForm({ species, potSize }); setDone(true); } catch { /* shown below */ }
              setBusy(false);
            }}
          />
          {done && <Text style={styles.result}>Submitted</Text>}
        </>
      )}
    </ScrollView>
  );
}

/** Taller than the screen, for `sweep` and `scrollTo`. */
function LongForm() {
  const labels = [
    'First Name', 'Last Name', 'Email', 'Phone', 'Street', 'City',
    'Region', 'Postcode', 'Country', 'Delivery Notes', 'Gift Message',
    'Preferred Day', 'Alternate Contact', 'Referral', 'Comments',
  ];
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <ScrollView style={styles.fill} contentInsetAdjustmentBehavior="automatic" keyboardDismissMode="on-drag">
      {labels.map((l) => (
        <Field key={l} label={l} value={values[l] ?? ''} onChange={(v) => setValues((p) => ({ ...p, [l]: v }))} />
      ))}
      <Button title="Save all" onPress={() => { /* nothing to assert but the scroll */ }} />
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

/** A modal, because a sheet over a dimmed page is its own perception problem. */
function Confirm({ navigation }: NativeStackScreenProps<Stack, 'Confirm'>) {
  return (
    <View style={[styles.fill, styles.modal]}>
      <Text style={styles.modalTitle}>Delete this order?</Text>
      <Text style={styles.modalBody}>
        This cannot be undone. Nothing local may tap a destructive control — see the verify barrier.
      </Text>
      <Button title="Delete" onPress={() => navigation.goBack()} />
      <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => navigation.goBack()}>
        <Text style={styles.cancel}>Cancel</Text>
      </Pressable>
    </View>
  );
}

export function FormsStack() {
  return (
    <Nav.Navigator>
      <Nav.Screen name="FormsHome" component={FormsHome} options={{ title: 'Forms', headerLargeTitle: true }} />
      <Nav.Screen name="SimpleForm" component={SimpleForm} options={{ title: 'One-step form' }} />
      <Nav.Screen name="Wizard" component={Wizard} options={{ title: 'New Order' }} />
      <Nav.Screen name="LongForm" component={LongForm} options={{ title: 'Long form' }} />
      <Nav.Screen name="Confirm" component={Confirm} options={{ presentation: 'modal', title: 'Confirm' }} />
    </Nav.Navigator>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#f2f2f7' },
  row: {
    backgroundColor: 'white', paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#c6c6c8',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  rowTitle: { fontSize: 17 },
  chevron: { color: '#c7c7cc', fontSize: 20 },
  field: { backgroundColor: 'white', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#c6c6c8' },
  label: { fontSize: 13, color: '#6d6d72', marginBottom: 4 },
  input: { fontSize: 17, paddingVertical: 6 },
  hint: { paddingHorizontal: 16, paddingVertical: 12, color: '#8e8e93', fontSize: 13 },
  button: { backgroundColor: '#007aff', margin: 16, paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  buttonOff: { backgroundColor: '#b0d3ff' },
  buttonText: { color: 'white', fontSize: 17, fontWeight: '600' },
  result: { paddingHorizontal: 16, fontSize: 15, color: '#1c1c1e' },
  step: { paddingHorizontal: 16, paddingVertical: 10, color: '#6d6d72', fontSize: 13 },
  review: { backgroundColor: 'white', paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  reviewRow: { fontSize: 15 },
  blocked: { paddingHorizontal: 16, paddingTop: 12, color: '#c1121f', fontSize: 13 },
  modal: { padding: 24, justifyContent: 'center', gap: 12 },
  modalTitle: { fontSize: 22, fontWeight: '600' },
  modalBody: { fontSize: 15, color: '#3c3c43', lineHeight: 21 },
  cancel: { textAlign: 'center', color: '#007aff', fontSize: 17 },
});
