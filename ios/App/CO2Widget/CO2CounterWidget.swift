import Foundation
import WidgetKit
import SwiftUI

// CO2 Counter's home-screen and lock-screen widget: your daily-habit streak,
// today's habits and what you've saved this week. The app writes a small
// JSON summary into the shared App Group (WidgetBridgePlugin.swift); this
// reads it, and works out "today" and "this week" itself so it resets at
// midnight and on Mondays even if the app hasn't been opened.

private let appGroup = "group.com.solenyarick.co2tracker"
private let storeKey = "co2widget"

struct HabitItem: Codable, Hashable {
    let name: String
    let color: String
    let done: Bool
}

struct WidgetData: Codable {
    var day: String = ""
    var weekStart: String = ""
    var streak: Int = 0
    var done: Int = 0
    var total: Int = 5
    var weekPts: Int = 0
    var weekKg: Double = 0
    var allKg: Double = 0
    var habits: [HabitItem] = []

    static let sample = WidgetData(day: "", weekStart: "", streak: 5, done: 3, total: 5, weekPts: 120, weekKg: 7.4, allKg: 37, habits: [
        HabitItem(name: "Bought nothing new", color: "#3F5B3A", done: true),
        HabitItem(name: "Heating down a notch", color: "#B27A14", done: true),
        HabitItem(name: "No beef or lamb today", color: "#557546", done: true),
        HabitItem(name: "Car-free commute", color: "#3E7A8A", done: false),
        HabitItem(name: "Checked my energy use", color: "#2B3F28", done: false),
    ])
}

private let canopy = Color(hex: "#17241A")
private let canopy2 = Color(hex: "#24402B")
private let sprout = Color(hex: "#C4E57D")
private let cream = Color(hex: "#F1EDE4")
private let muted = Color(hex: "#B7C2AE")
private let flame = Color(hex: "#FF8A3D")

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

private func dayString(_ d: Date) -> String {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .current
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: d)
}

private func weekStartString(_ d: Date) -> String {
    var cal = Calendar(identifier: .gregorian)
    cal.firstWeekday = 2 // Monday
    return dayString(cal.dateInterval(of: .weekOfYear, for: d)?.start ?? d)
}

// What to show at a moment, from what the app last wrote. A streak stays
// alive until midnight after the last day with a tick.
private func current(_ data: WidgetData, at date: Date) -> WidgetData {
    var w = data
    let today = dayString(date)
    let yesterday = dayString(Calendar.current.date(byAdding: .day, value: -1, to: date) ?? date)
    if data.day != today {
        w.streak = (data.day == yesterday && data.done > 0) ? data.streak : 0
        w.done = 0
        w.habits = data.habits.map { HabitItem(name: $0.name, color: $0.color, done: false) }
    }
    if data.weekStart != weekStartString(date) {
        w.weekPts = 0
        w.weekKg = 0
    }
    return w
}

private func kgText(_ kg: Double) -> String {
    if kg <= 0 { return "0 kg" }
    return "−" + (kg >= 10 ? String(Int(kg.rounded())) : String(format: "%.1f", kg)) + " kg"
}

struct CO2Entry: TimelineEntry {
    let date: Date
    let data: WidgetData
    let empty: Bool
}

struct CO2Provider: TimelineProvider {
    private func load() -> (WidgetData, Bool) {
        guard let s = UserDefaults(suiteName: appGroup)?.string(forKey: storeKey),
              let d = s.data(using: .utf8),
              let w = try? JSONDecoder().decode(WidgetData.self, from: d) else { return (WidgetData(), true) }
        return (w, false)
    }

    func placeholder(in context: Context) -> CO2Entry {
        CO2Entry(date: Date(), data: .sample, empty: false)
    }

    func getSnapshot(in context: Context, completion: @escaping (CO2Entry) -> Void) {
        let (d, empty) = load()
        completion(CO2Entry(date: Date(), data: empty ? .sample : current(d, at: Date()), empty: false))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CO2Entry>) -> Void) {
        let (d, empty) = load()
        let now = Date()
        let cal = Calendar.current
        let midnight = cal.startOfDay(for: cal.date(byAdding: .day, value: 1, to: now) ?? now)
        let entries = [
            CO2Entry(date: now, data: current(d, at: now), empty: empty),
            CO2Entry(date: midnight, data: current(d, at: midnight), empty: empty),
        ]
        completion(Timeline(entries: entries, policy: .after(midnight)))
    }
}

// A ring for today's habits: x of 5.
struct TodayRing: View {
    let done: Int
    let total: Int
    var size: CGFloat = 44
    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.14), lineWidth: 5)
            Circle()
                .trim(from: 0, to: total > 0 ? CGFloat(done) / CGFloat(total) : 0)
                .stroke(sprout, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(done)/\(total)")
                .font(.system(size: size * 0.3, weight: .heavy, design: .rounded))
                .foregroundColor(cream)
        }
        .frame(width: size, height: size)
    }
}

struct StreakLine: View {
    let streak: Int
    var big: CGFloat = 30
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Image(systemName: "flame.fill")
                .font(.system(size: big * 0.62, weight: .bold))
                .foregroundColor(streak > 0 ? flame : muted.opacity(0.6))
            Text("\(streak)")
                .font(.system(size: big, weight: .heavy, design: .rounded))
                .foregroundColor(cream)
            Text(streak == 1 ? "day" : "days")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(muted)
        }
    }
}

struct EmptyView2: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: "leaf.fill").foregroundColor(sprout)
            Text("Daily habits")
                .font(.system(size: 15, weight: .heavy, design: .rounded))
                .foregroundColor(cream)
            Text("Open CO2 Counter and tick your first one.")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct SmallView: View {
    let w: WidgetData
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StreakLine(streak: w.streak)
            Text(w.streak > 0 && w.done == 0 ? "Tick one to keep it" : "day streak")
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(w.streak > 0 && w.done == 0 ? flame : muted)
            Spacer(minLength: 6)
            HStack(spacing: 10) {
                TodayRing(done: w.done, total: w.total, size: 42)
                VStack(alignment: .leading, spacing: 1) {
                    Text(kgText(w.weekKg))
                        .font(.system(size: 15, weight: .heavy, design: .rounded))
                        .foregroundColor(sprout)
                    Text("this week")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(muted)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct MediumView: View {
    let w: WidgetData
    var body: some View {
        HStack(spacing: 14) {
            SmallView(w: w).frame(width: 128)
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(w.habits.prefix(5).enumerated()), id: \.offset) { _, h in
                    HStack(spacing: 7) {
                        ZStack {
                            Circle()
                                .fill(h.done ? Color(hex: h.color) : Color.clear)
                                .overlay(Circle().stroke(h.done ? Color(hex: h.color) : Color.white.opacity(0.3), lineWidth: 1.5))
                            if h.done {
                                Image(systemName: "checkmark").font(.system(size: 8, weight: .black)).foregroundColor(.white)
                            }
                        }
                        .frame(width: 15, height: 15)
                        Text(h.name)
                            .font(.system(size: 12, weight: h.done ? .bold : .semibold))
                            .foregroundColor(h.done ? cream : muted)
                            .lineLimit(1)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

@available(iOSApplicationExtension 16.0, *)
struct CircularView: View {
    let w: WidgetData
    var body: some View {
        Gauge(value: Double(w.done), in: 0...Double(max(1, w.total))) {
            Image(systemName: "flame.fill")
        } currentValueLabel: {
            Text("\(w.streak)")
        }
        .gaugeStyle(.accessoryCircular)
    }
}

@available(iOSApplicationExtension 16.0, *)
struct RectangularView: View {
    let w: WidgetData
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("\(Image(systemName: "flame.fill")) \(w.streak)-day streak")
                .font(.headline)
            Text("\(w.done) of \(w.total) habits today")
            Text("\(kgText(w.weekKg)) this week")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct CO2WidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: CO2Entry

    var body: some View {
        content
            .widgetURL(URL(string: "co2counter://habits"))
    }

    // Lock-screen sizes only exist from iOS 16, so they're only named there.
    @ViewBuilder var content: some View {
        if #available(iOSApplicationExtension 16.0, *) {
            modern
        } else {
            classic
        }
    }

    @available(iOSApplicationExtension 16.0, *)
    @ViewBuilder var modern: some View {
        switch family {
        case .accessoryCircular:
            CircularView(w: entry.data).background17(clear: true)
        case .accessoryRectangular:
            RectangularView(w: entry.data).background17(clear: true)
        default:
            classic
        }
    }

    @ViewBuilder var classic: some View {
        if entry.empty {
            EmptyView2().background17()
        } else if family == .systemMedium {
            MediumView(w: entry.data).background17()
        } else {
            SmallView(w: entry.data).background17()
        }
    }
}

extension View {
    // iOS 17 draws the widget background itself; earlier versions need it here.
    @ViewBuilder func background17(clear: Bool = false) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            self.containerBackground(for: .widget) {
                if clear { Color.clear } else { LinearGradient(colors: [canopy2, canopy], startPoint: .topLeading, endPoint: .bottomTrailing) }
            }
        } else if clear {
            self
        } else {
            self.padding(14).background(LinearGradient(colors: [canopy2, canopy], startPoint: .topLeading, endPoint: .bottomTrailing))
        }
    }
}

struct CO2CounterWidget: Widget {
    let kind = "CO2CounterWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: CO2Provider()) { entry in
            CO2WidgetView(entry: entry)
        }
        .configurationDisplayName("Daily habits")
        .description("Your streak, today's habits and what you've saved this week.")
        .supportedFamilies(families)
    }
    private var families: [WidgetFamily] {
        if #available(iOSApplicationExtension 16.0, *) {
            return [.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular]
        }
        return [.systemSmall, .systemMedium]
    }
}

@main
struct CO2CounterWidgets: WidgetBundle {
    var body: some Widget {
        CO2CounterWidget()
    }
}
