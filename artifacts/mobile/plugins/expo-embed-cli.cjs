#!/usr/bin/env node
const path = require('node:path');

/**
 * RN 0.81 passes Windows CLI paths relative to the mobile project. Expo 54's
 * export:embed resolves its entry relative to Metro's workspace server root.
 * Normalize this one argument before delegating; keep Expo/Metro configuration,
 * assets, source maps, API env inlining and the rest of the command unchanged.
 */
function normalizeEmbedEntry(argv, cwd, paths = path) {
  const result = [...argv];
  if (result[2] !== 'export:embed') return result;
  for (let i = 3; i < result.length; i++) {
    if (result[i] === '--entry-file') {
      if (!result[i + 1] || result[i + 1].startsWith('--')) throw new Error('Missing --entry-file value');
      result[i + 1] = paths.resolve(cwd, result[i + 1]);
      i++;
    } else if (result[i].startsWith('--entry-file=')) {
      const value = result[i].slice('--entry-file='.length);
      if (!value) throw new Error('Missing --entry-file value');
      result[i] = '--entry-file=' + paths.resolve(cwd, value);
    }
  }
  return result;
}

module.exports = { normalizeEmbedEntry };

if (require.main === module) {
  process.argv = normalizeEmbedEntry(process.argv, process.cwd());
  require(require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] }));
}
