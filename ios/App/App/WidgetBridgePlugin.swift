import Foundation
import Capacitor
import WidgetKit

// Hands the home-screen widget its numbers: the app writes a small JSON
// summary (streak, today's habits, this week's points and kilos) into the
// shared App Group, then asks iOS to redraw the widgets.
@objc(WidgetBridgePlugin)
public class WidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetBridgePlugin"
    public let jsName = "WidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise)
    ]
    static let appGroup = "group.com.solenyarick.co2tracker"
    static let key = "co2widget"

    @objc func update(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), let defaults = UserDefaults(suiteName: WidgetBridgePlugin.appGroup) else {
            call.reject("The App Group isn't set up.", "NO_GROUP")
            return
        }
        defaults.set(json, forKey: WidgetBridgePlugin.key)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }
}
