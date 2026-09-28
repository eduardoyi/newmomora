// Sentry's Metro config = Expo's default + a debug ID in every bundle, so
// store-build and OTA source maps line up with crash reports
// (docs/features/observability.md).
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

module.exports = getSentryExpoConfig(__dirname);
