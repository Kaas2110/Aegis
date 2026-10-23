module.exports = ({ config }) => {
  const localTest = process.env.AEGIS_ANDROID_LOCAL_TEST === '1';
  return {
    ...config,
    name: localTest ? 'Aegis Local Test' : config.name,
    android: {
      ...config.android,
      package: localTest ? `${config.android.package}.local` : config.android.package,
      allowBackup: false,
      // The app has no camera, microphone, location or media-library feature.
      blockedPermissions: [
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_BACKGROUND_LOCATION',
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.SYSTEM_ALERT_WINDOW',
      ],
    },
    plugins: [...(config.plugins ?? []), ['./plugins/withAegisNetwork', { localTest }], './plugins/withAegisAndroidBundle'],
  };
};
