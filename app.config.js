// Dynamic wrapper over app.json for EAS builds: google-services.json is
// gitignored (and EAS only uploads git-tracked files), so production builds
// read it from the GOOGLE_SERVICES_JSON secret *file* environment variable
// (EAS materializes it to a temp path and puts that path in the env var).
// Local builds/dev keep using the untracked ./google-services.json.
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? config.android.googleServicesFile,
  },
});
