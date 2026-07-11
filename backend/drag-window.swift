import ApplicationServices
import CoreGraphics
import Foundation

if CommandLine.arguments.count >= 2 && CommandLine.arguments[1] == "--release" {
  let source = CGEventSource(stateID: .hidSystemState)
  let current = CGEvent(source: nil)?.location ?? .zero
  let point: CGPoint
  if CommandLine.arguments.count >= 4,
     let x = Double(CommandLine.arguments[2]),
     let y = Double(CommandLine.arguments[3]) {
    point = CGPoint(x: x, y: y)
  } else {
    point = current
  }
  if let event = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
                         mouseCursorPosition: current, mouseButton: .left) {
    event.post(tap: .cghidEventTap)
  }
  _ = CGDisplayShowCursor(CGMainDisplayID())
  _ = CGWarpMouseCursorPosition(point)
  print("released")
  exit(0)
}

// Low-level fallback for transparent/borderless pets whose AXPosition is exposed
// but silently ignores writes. Usage: swift drag-window.swift sx sy ex ey [ms]
guard CommandLine.arguments.count >= 5,
      let sx = Double(CommandLine.arguments[1]),
      let sy = Double(CommandLine.arguments[2]),
      let ex = Double(CommandLine.arguments[3]),
      let ey = Double(CommandLine.arguments[4]) else {
  fputs("usage: drag-window.swift sx sy ex ey [durationMs]\n", stderr)
  exit(2)
}

guard AXIsProcessTrusted() else {
  fputs("accessibility permission required\n", stderr)
  exit(3)
}

let durationMs = max(180, min(1500, Double(CommandLine.arguments.count > 5 ? CommandLine.arguments[5] : "520") ?? 520))
let steps = max(12, Int(durationMs / 16))
let source = CGEventSource(stateID: .hidSystemState)
let original = CGEvent(source: nil)?.location
if let original {
  print("original|\(original.x)|\(original.y)")
  fflush(stdout)
}
// Disconnecting mouse/cursor breaks absolute hit-testing for synthetic events.
// Hide the visible cursor instead, then restore it without generating an event.
let cursorDisplay = CGMainDisplayID()
let hideResult = CGDisplayHideCursor(cursorDisplay)
defer {
  if let original { _ = CGWarpMouseCursorPosition(original) }
  _ = CGDisplayShowCursor(cursorDisplay)
}

func post(_ type: CGEventType, _ point: CGPoint) {
  guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                            mouseCursorPosition: point, mouseButton: .left) else { return }
  event.post(tap: .cghidEventTap)
}

let start = CGPoint(x: sx, y: sy)
let end = CGPoint(x: ex, y: ey)
post(.mouseMoved, start)
usleep(80_000)
post(.leftMouseDown, start)
usleep(80_000)

for i in 1...steps {
  let t = Double(i) / Double(steps)
  // easeInOutQuad keeps the gesture natural enough for apps that sample drags.
  let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
  let point = CGPoint(x: sx + (ex - sx) * eased, y: sy + (ey - sy) * eased)
  post(.leftMouseDragged, point)
  print("progress|\(eased)")
  fflush(stdout)
  usleep(useconds_t(durationMs * 1000 / Double(steps)))
}

post(.leftMouseUp, end)
usleep(80_000)
print("ok|\(hideResult.rawValue)")
