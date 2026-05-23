// Passthrough Pages Function — forwards every request straight to the static
// asset fetcher. Needed because an earlier botched deploy registered a
// broken `_worker.js` at the project level, and subsequent deploys without
// this file kept hitting the stale binding → 500 on /make, /preview, /test-perf.
// Overriding with an explicit passthrough replaces the binding cleanly;
// CF Pages serves the static HTML as if no Function existed.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  }
};
