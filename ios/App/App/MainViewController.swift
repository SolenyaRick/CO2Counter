import UIKit
import Capacitor

// The app's own native plugins, registered with Capacitor when the web view
// loads (Main.storyboard uses this instead of CAPBridgeViewController).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppleSignInPlugin())
        bridge?.registerPluginInstance(WidgetBridgePlugin())
    }
}
