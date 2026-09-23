/**
 * iOS 27 SDK apps abort at launch without the UIScene life cycle. The scene
 * manifest in app.json points at Expo's own `EXExpoAppSceneDelegate`, which
 * creates the window and starts React Native; the Expo 57 template AppDelegate
 * still does both itself, so strip that here. Delete once the template adopts scenes.
 */
const { withAppDelegate } = require('@expo/config-plugins')

const WINDOW_START = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
`

module.exports = (config) =>
  withAppDelegate(config, (mod) => {
    const source = mod.modResults.contents
    if (!source.includes(WINDOW_START)) {
      throw new Error('[withSceneLifecycle] AppDelegate template changed — re-check the plugin.')
    }
    mod.modResults.contents = source
      .replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {')
      .replace(WINDOW_START, '')
    return mod
  })
