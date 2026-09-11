const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
/**
 * Port 8083, not Metro's default 8081.
 *
 * The owner runs other React Native apps on this machine, and two Metro
 * instances on one port is not a clash that announces itself — the app happily
 * loads whichever bundle answers, so the testbed would silently run somebody
 * else's JavaScript and every reading taken from it would be a reading of the
 * wrong app.
 *
 * The port has to match in two places or it is worse than not setting it: here,
 * and in `AppDelegate.swift`, where the app decides where to fetch its bundle
 * from at launch. Changing only one of them is the failure this comment exists
 * to prevent.
 */
const config = {
  server: { port: 8083 },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
