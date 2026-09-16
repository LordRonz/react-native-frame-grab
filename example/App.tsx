import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'

import {
  defaultWorkloads,
  formatReport,
  remoteWorkloads,
  runBenchmark,
  saveReport,
  type Workload,
} from './src/benchmark'
import { runHarness, runRemoteHarness, type Check } from './src/harness'
import {
  ensureDirectories,
  listFixtureSources,
  listLibrarySources,
  listRemoteSources,
  type BenchSource,
} from './src/sources'

const SCHEDULER_LEVELS = [1, 2, 4]

export default function App() {
  const [sources, setSources] = useState<BenchSource[]>([])
  const [selected, setSelected] = useState<BenchSource | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const [checks, setChecks] = useState<Check[]>([])

  const append = useCallback((line: string) => {
    setLog((previous) => `${previous}${previous ? '\n' : ''}${line}`)
  }, [])

  useEffect(() => {
    ensureDirectories()
    listLibrarySources()
      .then((library) => {
        const all = [...listFixtureSources(), ...library, ...listRemoteSources()]
        setSources(all)
        setSelected(all[0] ?? null)
      })
      .catch((error) => append(`Could not list sources: ${error}`))
  }, [append])

  const isRemote = selected?.id.startsWith('remote:') ?? false

  const withBusy = useCallback(
    async (label: string, run: () => Promise<void>) => {
      setBusy(label)
      try {
        await run()
      } catch (error) {
        append(`FAILED: ${error}`)
      } finally {
        setBusy(null)
      }
    },
    [append]
  )

  const onRunHarness = useCallback(() => {
    if (!selected) return
    void withBusy('Acceptance matrix', async () => {
      setLog('')
      setChecks([])
      const results = await runHarness(selected, selected.durationMs ?? null)
      setChecks(results)
      const failed = results.filter((check) => !check.passed)
      append(`${results.length - failed.length}/${results.length} checks passed`)
      failed.forEach((check) => append(`  FAIL ${check.id}: ${check.detail}`))
    })
  }, [append, selected, withBusy])

  const onRunRemoteHarness = useCallback(() => {
    void withBusy('Remote matrix', async () => {
      setLog('')
      setChecks([])
      const results = await runRemoteHarness()
      setChecks(results)
      const failed = results.filter((check) => !check.passed)
      append(`${results.length - failed.length}/${results.length} remote checks passed`)
      failed.forEach((check) => append(`  FAIL ${check.id}: ${check.detail}`))
      append(
        '\nA third-party sample being unreachable is an inconclusive run, not a defect. ' +
          'The gate is your own host — set APP_MEDIA_HOST_URL in src/remote.ts.'
      )
    })
  }, [append, withBusy])

  const onRunBenchmark = useCallback(
    (workloads: Workload[], label: string) => {
      if (!selected) return
      void withBusy(label, async () => {
        setLog('')
        setChecks([])
        for (const maxConcurrency of SCHEDULER_LEVELS) {
          append(`\n=== native scheduler: ${maxConcurrency} concurrent job(s) ===`)
          const report = await runBenchmark({
            source: selected,
            workloads,
            maxConcurrency,
            onProgress: (line) => setBusy(`${label} — ${line}`),
          })
          append(formatReport(report))
          append(`\nsaved: ${saveReport(report)}`)
        }
        append('\nCaveats:')
        append('  Read peak memory and FDs from Instruments / Android Studio, not from here.')
      })
    },
    [append, selected, withBusy]
  )

  return (
    <View style={styles.root}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>frame-grab bench</Text>

        <Text style={styles.heading}>Source</Text>
        {sources.length === 0 ? (
          <Text style={styles.muted}>
            No videos found. Grant media library access, or push fixtures into the
            app&apos;s Documents/fixtures folder (see example/README.md).
          </Text>
        ) : (
          sources.map((source) => (
            <Pressable
              key={source.id}
              onPress={() => setSelected(source)}
              style={[styles.row, selected?.id === source.id && styles.rowSelected]}
            >
              <Text style={styles.rowText} numberOfLines={2}>
                {source.label}
              </Text>
              <Text style={styles.muted}>{source.note}</Text>
            </Pressable>
          ))
        )}

        <Text style={styles.heading}>Run</Text>
        <Button
          label="Acceptance matrix"
          disabled={!selected || busy != null}
          onPress={onRunHarness}
        />
        <Button
          label="Benchmark — primary workload only"
          disabled={!selected || busy != null}
          onPress={() =>
            onRunBenchmark(
              defaultWorkloads().filter((work) => work.id === 'primary'),
              'Primary workload'
            )
          }
        />
        <Button
          label="Benchmark — full plan (slow)"
          disabled={!selected || busy != null}
          onPress={() => onRunBenchmark(defaultWorkloads(), 'Full benchmark')}
        />
        <Button
          label="Remote acceptance matrix"
          disabled={busy != null}
          onPress={onRunRemoteHarness}
        />
        <Button
          label="Benchmark — remote workloads"
          disabled={!isRemote || busy != null}
          onPress={() => onRunBenchmark(remoteWorkloads(), 'Remote benchmark')}
        />
        {!isRemote && (
          <Text style={styles.muted}>
            Select a remote source above to enable the remote benchmark. Remote
            numbers are time-to-first-result on your network, not a property of the
            library.
          </Text>
        )}

        {busy != null && (
          <View style={styles.busy}>
            <ActivityIndicator />
            <Text style={styles.muted}>{busy}</Text>
          </View>
        )}

        {checks.length > 0 && (
          <>
            <Text style={styles.heading}>Checks</Text>
            {checks.map((check) => (
              <View key={check.id} style={styles.check}>
                <Text style={check.passed ? styles.pass : styles.fail}>
                  {check.passed ? 'PASS' : 'FAIL'} {check.id}
                </Text>
                <Text style={styles.muted}>{check.detail}</Text>
                {check.imageUri != null && (
                  <Image
                    source={{ uri: check.imageUri }}
                    style={styles.thumbnail}
                    resizeMode="contain"
                  />
                )}
              </View>
            ))}
            <Text style={styles.muted}>
              Orientation cannot be asserted from dimensions alone. Check the frames
              above against the fixtures&apos; TOP/LEFT markers.
            </Text>
          </>
        )}

        {log !== '' && (
          <>
            <Text style={styles.heading}>Output</Text>
            <Text style={styles.log}>{log}</Text>
          </>
        )}
      </ScrollView>
    </View>
  )
}

function Button({
  label,
  onPress,
  disabled,
}: {
  label: string
  onPress: () => void
  disabled: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, disabled && styles.buttonDisabled]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0d0d10' },
  content: { padding: 16, paddingTop: 64, gap: 8 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  heading: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 16 },
  muted: { color: '#8a8a94', fontSize: 12 },
  row: { padding: 10, borderRadius: 8, backgroundColor: '#1a1a20' },
  rowSelected: { backgroundColor: '#243044', borderColor: '#4d7dff', borderWidth: 1 },
  rowText: { color: '#e6e6ea', fontSize: 13 },
  button: { padding: 12, borderRadius: 8, backgroundColor: '#4d7dff', marginTop: 4 },
  buttonDisabled: { backgroundColor: '#2a2a33' },
  buttonText: { color: '#fff', fontWeight: '600', textAlign: 'center' },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  check: { marginTop: 8 },
  pass: { color: '#5ad18b', fontSize: 12, fontWeight: '600' },
  fail: { color: '#ff6b6b', fontSize: 12, fontWeight: '600' },
  thumbnail: { width: '100%', height: 160, marginTop: 6, backgroundColor: '#1a1a20' },
  log: {
    color: '#c9c9d1',
    fontSize: 11,
    fontFamily: 'Courier',
    marginTop: 8,
  },
})
