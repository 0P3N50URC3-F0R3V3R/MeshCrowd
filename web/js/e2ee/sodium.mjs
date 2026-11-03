// libsodium is large (WASM included) and only needed once encryption is used, so it is imported on
// first `await sodium.ready` instead of at page start. Everything else on this object works exactly
// like the real library once that has resolved.
let lib = null;
let loading = null;

function load() {
  if (!loading) {
    loading = import('libsodium-wrappers-sumo').then(async (mod) => {
      const real = mod.default;
      await real.ready;
      lib = real;
      return real;
    });
  }
  return loading;
}

const sodium = new Proxy({}, {
  get(_, key) {
    if (key === 'ready') return load().then(() => undefined);
    if (!lib) throw new Error('libsodium used before `await sodium.ready`');
    return lib[key];
  },
});

export default sodium;
