const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// 状态层唯一真相在 ../web/core（与浏览器端共用，不复制）；vendor 里有 marked
config.projectRoot = repoRoot;
config.watchFolders = [...(config.watchFolders || []), repoRoot];
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, 'node_modules'),
  path.join(repoRoot, 'node_modules'),
];

// web/core/bus.js 为 useBus 引用 vendor preact；RN 端重定向到 react shim
const preactShim = path.join(projectRoot, 'src', 'shims', 'preact-htm.js');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.endsWith('preact-htm-standalone.module.js')) {
    return { type: 'sourceFile', filePath: preactShim };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
