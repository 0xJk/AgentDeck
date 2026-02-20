import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import replace from '@rollup/plugin-replace';

const isWatching = !!process.env.ROLLUP_WATCH;
const isProd = process.env.SDC_PROD === '1';
const sdPlugin = 'bound.serendipity.agentdeck.sdPlugin';

export default {
  input: 'src/plugin.ts',
  output: {
    file: `${sdPlugin}/bin/plugin.js`,
    sourcemap: isWatching,
  },
  plugins: [
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
    {
      name: 'emit-module-package-file',
      generateBundle() {
        this.emitFile({ fileName: 'package.json', source: '{ "type": "module" }', type: 'asset' });
      },
    },
  ],
};
