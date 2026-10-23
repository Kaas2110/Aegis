const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('expo/config-plugins');

module.exports = function withAegisNetwork(config, { localTest = false } = {}) {
  config = withAndroidManifest(config, result => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(result.modResults);
    application.$['android:usesCleartextTraffic'] = 'false';
    application.$['android:networkSecurityConfig'] = '@xml/aegis_network_security';
    return result;
  });
  return withDangerousMod(config, ['android', async result => {
    const directory = path.join(result.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    fs.mkdirSync(directory, { recursive: true });
    const loopback = localTest ? `
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>` : '';
    fs.writeFileSync(path.join(directory, 'aegis_network_security.xml'),
      `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />${loopback}
</network-security-config>
`);
    return result;
  }]);
};
