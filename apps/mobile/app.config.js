// Release-time overrides for app.json (Phase 12, D204). Values come from the build environment (EAS env / CI), never
// from the repo: WORKO_WEB_HOST — the web host whose https links open in the app (App Links, must serve
// /.well-known/assetlinks.json, template in store/), WORKO_API_BASE — the API the build talks to, EAS_PROJECT_ID.
module.exports = ({ config }) => {
  const host = process.env.WORKO_WEB_HOST || 'app.worko.in';
  const android = {
    ...config.android,
    intentFilters: (config.android.intentFilters || []).map((f) => ({ ...f, data: f.data.map((d) => ({ ...d, host })) })),
  };
  return {
    ...config,
    android,
    extra: {
      ...config.extra,
      apiBase: process.env.WORKO_API_BASE || config.extra.apiBase,
      eas: { projectId: process.env.EAS_PROJECT_ID || config.extra.eas.projectId },
    },
  };
};
