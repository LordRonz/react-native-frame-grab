// Runs the example against the library working tree rather than a published copy.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const libraryRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

// Watch the library's source so edits reload.
config.watchFolders = [libraryRoot]

// But never resolve *out of* the library's own node_modules. It carries its own
// react-native and metro for development, and letting Metro load a second copy
// of either breaks the bundler with
// "Cannot read properties of undefined (reading 'transformFile')".
const escaped = libraryRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const blocked = new RegExp(`^${escaped}[\\\\/]node_modules[\\\\/].*$`)
const existingBlockList = config.resolver.blockList
config.resolver.blockList = Array.isArray(existingBlockList)
  ? [...existingBlockList, blocked]
  : existingBlockList
    ? [existingBlockList, blocked]
    : [blocked]

config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')]

// The library imports these; resolve them to the example's single copy.
config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, 'node_modules/react'),
  'react-native': path.resolve(projectRoot, 'node_modules/react-native'),
  'react-native-nitro-modules': path.resolve(
    projectRoot,
    'node_modules/react-native-nitro-modules'
  ),
}

module.exports = config
