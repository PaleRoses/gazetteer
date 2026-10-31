// ARCHITECTURE.md law 1: core <- sources|telemetry|assessment|relay <- agents <- runtime <- http <- main; client imports core only.
const server = (dir) => '^src/server/' + dir + '/';
const forbid = (name, from, to) => ({ name, severity: 'error', from: { path: from }, to: { path: to } });
module.exports = {
  forbidden: [
    forbid('client-imports-core-only', '^src/client/', '^src/server/'),
    forbid('core-imports-nothing-else', '^src/core/', '^src/(server|client)/'),
    forbid('server-never-imports-client', '^src/server/', '^src/client/'),
    forbid('leaf-layers-stay-below-agents', '^src/server/(sources|telemetry|assessment|relay)/', '^src/server/(agents|runtime|http|main)'),
    forbid('agents-stay-below-runtime', server('agents'), '^src/server/(runtime|http|main)'),
    forbid('runtime-stays-below-http', server('runtime'), '^src/server/(http|main)'),
    forbid('http-stays-below-main', server('http'), '^src/server/main'),
    forbid('access-stays-low', server('access'), '^src/server/(agents|runtime|http|main|relay)'),
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: { tsPreCompilationDeps: true, tsConfig: { fileName: 'tsconfig.json' }, doNotFollow: { path: 'node_modules' }, exclude: { path: '\\.d\\.ts$' } },
};
