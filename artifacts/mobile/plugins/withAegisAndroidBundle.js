const { withAppBuildGradle } = require('expo/config-plugins');

const marker = '// Aegis: normalize the native embed entry before Expo resolves the workspace root.';

function configureBundleCli(contents) {
  if (contents.includes(marker)) return contents;
  const anchor = /^([\t ]*)bundleCommand\s*=\s*["']export:embed["'][\t ]*\r?$/m;
  if (!anchor.test(contents)) throw new Error('Aegis Android bundle plugin requires the Expo export:embed Gradle configuration.');
  return contents.replace(anchor, (line, indent) =>
    `${line.trimEnd()}\n${indent}${marker}\n${indent}cliFile = new File(rootDir, "../plugins/expo-embed-cli.cjs")`);
}

module.exports = function withAegisAndroidBundle(config) {
  return withAppBuildGradle(config, result => {
    if (result.modResults.language !== 'groovy') throw new Error('Aegis Android bundle plugin requires a Groovy app/build.gradle.');
    result.modResults.contents = configureBundleCli(result.modResults.contents);
    return result;
  });
};
module.exports.configureBundleCli = configureBundleCli;
