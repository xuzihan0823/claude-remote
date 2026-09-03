const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const webRoot = path.resolve(projectRoot, '..', 'web');

const config = getDefaultConfig(projectRoot);

// 状态层唯一真相在 ../web/core（与浏览器端共用，不复制）；vendor 里有 marked
config.watchFolders = [...(config.watchFolders || []), webRoot];

// web/core/bus.js 为 useBus 引用 vendor preact；RN 端重定向到 react shim
const preactShim = path.join(projectRoot, 'src', 'shims', 'preact-htm.js');
const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.endsWith('preact-htm-standalone.module.js')) {
    return { type: 'sourceFile', filePath: preactShim };
  }
  if (baseResolveRequest) return baseResolveRequest(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
