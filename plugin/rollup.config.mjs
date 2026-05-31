import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import replace from '@rollup/plugin-replace';

const isWatching = !!process.env.ROLLUP_WATCH;
const isProd = process.env.SDC_PROD === '1';
const sdPlugin = 'bound.serendipity.agentdeck.sdPlugin';

const sharedPlugins = (emitPackageJson) => [
  replace({
    preventAssignment: true,
    values: {
      __SDC_DEBUG__: isProd ? 'false' : 'true',
    },
  }),
  typescript({
    tsconfig: './tsconfig.json',
    compilerOptions: {
      module: 'ES2022',
      moduleResolution: 'bundler',
      declaration: false,
    },
  }),
  resolve({
    browser: false,
    exportConditions: ['node'],
    preferBuiltins: true,
  }),
  commonjs(),
  ...(emitPackageJson
    ? [
        {
          name: 'emit-module-package-file',
          generateBundle() {
            this.emitFile({ fileName: 'package.json', source: '{ "type": "module" }', type: 'asset' });
          },
        },
      ]
    : []),
];

// @napi-rs/keyring is a native N-API module. Its index.js dispatches require()s
// for platform-specific subpackages (e.g. @napi-rs/keyring-darwin-arm64) that
// contain .node binaries — those cannot be bundled by rollup and must be
// resolved at runtime via Node's require.
const keyringExternal = (id) => id === '@napi-rs/keyring' || id.startsWith('@napi-rs/keyring-');

export default [
  {
    input: 'src/plugin.ts',
    output: {
      file: `${sdPlugin}/bin/plugin.js`,
      sourcemap: isWatching,
    },
    // token-store.ts (reached via the bridge-connection action) pulls
    // @napi-rs/keyring into the main entry graph. It is a native N-API module
    // whose platform subpackages ship .node binaries + a package.json that
    // rollup's commonjs resolver cannot parse — keep it external and resolve it
    // at runtime via Node's require (build.mjs copies the native packages into
    // bin/node_modules/@napi-rs so the require succeeds after packaging).
    external: keyringExternal,
    plugins: sharedPlugins(true),
  },
];
