// expo-modules-autolinking (react-native-config) does not pick up the `expo` package's own
// react-native.config.js in this pnpm workspace, so it derives `expo.core.ExpoModulesPackage` from the
// Gradle namespace and the release build fails. Point it at the real class.
module.exports = {
  dependencies: {
    expo: {
      platforms: {
        android: { packageImportPath: 'import expo.modules.ExpoModulesPackage;' },
      },
    },
  },
};
