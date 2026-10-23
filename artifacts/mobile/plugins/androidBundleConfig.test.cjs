const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { normalizeEmbedEntry } = require('./expo-embed-cli.cjs');
const { configureBundleCli } = require('./withAegisAndroidBundle');

test('Windows monorepo Gradle entry is made absolute without changing output arguments', () => {
  const root = 'C:\\Aegis\\app\\artifacts\\mobile';
  const args = ['node', 'expo-cli', 'export:embed', '--entry-file', '..\\..\\node_modules\\.pnpm\\expo-router@6_hash\\node_modules\\expo-router\\entry.js', '--bundle-output', 'android\\app\\build\\bundle.js', '--platform', 'android'];
  const actual = normalizeEmbedEntry(args, root, path.win32);
  assert.equal(actual[4], 'C:\\Aegis\\app\\node_modules\\.pnpm\\expo-router@6_hash\\node_modules\\expo-router\\entry.js');
  assert.equal(path.win32.resolve('C:\\Aegis\\app', actual[4]), actual[4]);
  assert.deepEqual(actual.slice(5), args.slice(5));
  assert.equal(args[4].startsWith('..'), true);
});

test('absolute paths, spaces and POSIX entries retain their target', () => {
  const windows = ['node', 'cli', 'export:embed', '--entry-file=C:\\Aegis files\\entry.js'];
  assert.deepEqual(normalizeEmbedEntry(windows, 'C:\\app', path.win32), windows);
  assert.equal(normalizeEmbedEntry(['node', 'cli', 'export:embed', '--entry-file', '../../node_modules/expo-router/entry.js'], '/app/artifacts/mobile', path.posix)[4], '/app/node_modules/expo-router/entry.js');
});

test('web export and unrelated commands are untouched; malformed native entry fails clearly', () => {
  const web = ['node', 'cli', 'export', '--platform', 'web'];
  assert.deepEqual(normalizeEmbedEntry(web, 'C:\\app', path.win32), web);
  assert.throws(() => normalizeEmbedEntry(['node', 'cli', 'export:embed', '--entry-file', '--dev', 'false'], '/app'), /Missing --entry-file/);
});

test('Expo prebuild hook is idempotent and preserves the template outside the bundle hook', () => {
  const source = 'react {\n    cliFile = originalExpoCli\n    bundleCommand = "export:embed"\n    autolinkLibrariesWithApp()\n}\n';
  const configured = configureBundleCli(source);
  assert.ok(configured.includes('cliFile = new File(rootDir, "../plugins/expo-embed-cli.cjs")'));
  assert.ok(configured.includes('cliFile = originalExpoCli'));
  assert.ok(configured.endsWith('    autolinkLibrariesWithApp()\n}\n'));
  assert.equal(configureBundleCli(configured), configured);
  assert.throws(() => configureBundleCli('react { bundleCommand = "bundle" }'), /requires the Expo export:embed/);
});

test('Babel preset resolves from the installed SDK with an isolated pnpm layout', () => {
  let cached;
  const config = require('../babel.config')({ cache(value) { cached = value; } });
  assert.equal(cached, true);
  assert.equal(path.isAbsolute(config.presets[0][0]), true);
  assert.equal(typeof require(config.presets[0][0]), 'function');
  assert.equal(config.presets[0][1].unstable_transformImportMeta, true);
});
