module.exports = function (api) {
  api.cache(true);
  return {
    // Use the preset belonging to the installed Expo SDK, including with pnpm's
    // isolated dependency layout (it is Expo's dependency, not a hoisted one).
    presets: [[require.resolve("babel-preset-expo", {
      paths: [require.resolve("expo/package.json")],
    }), { unstable_transformImportMeta: true }]],
  };
};
