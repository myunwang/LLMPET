import ApplicationServices
import CoreGraphics
import Foundation

// macOS 26 still exposes visual window transforms even though direct
// cross-process SLSMoveWindow calls are rejected. A translation lets the
// visible body of a transparent pet reach the screen edge after AppKit clamps
// its larger invisible frame inside the display.
@_silgen_name("SLSMainConnectionID")
func SLSMainConnectionID() -> Int32

@_silgen_name("CGSGetWindowTransform")
func CGSGetWindowTransform(_ cid: Int32, _ wid: CGWindowID,
                           _ transform: UnsafeMutablePointer<CGAffineTransform>) -> CGError

@_silgen_name("CGSSetWindowTransform")
func CGSSetWindowTransform(_ cid: Int32, _ wid: CGWindowID,
                           _ transform: CGAffineTransform) -> CGError

struct MeshPoint { var x: Float; var y: Float }
struct WindowWarpPoint { var local: MeshPoint; var global: MeshPoint }

@_silgen_name("CGSSetWindowWarp")
func CGSSetWindowWarp(_ cid: Int32, _ wid: CGWindowID, _ columns: Int32,
                      _ rows: Int32, _ mesh: UnsafeMutablePointer<WindowWarpPoint>?) -> CGError

func matchingPetWindow(pid: Int32, expectedX: Double, expectedY: Double,
                       expectedW: Double, expectedH: Double) -> (CGWindowID, CGRect, Double)? {
  let windows = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID)
    as? [[String: Any]]) ?? []
  let candidates = windows.compactMap { info -> (CGWindowID, CGRect, Double)? in
    guard let owner = info[kCGWindowOwnerPID as String] as? NSNumber,
          owner.int32Value == pid,
          let number = info[kCGWindowNumber as String] as? NSNumber,
          let rawBounds = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: rawBounds) else { return nil }
    let shapeError = abs(bounds.width - expectedW) + abs(bounds.height - expectedH)
    guard shapeError <= 8 else { return nil }
    let positionError = abs(bounds.origin.x - expectedX) + abs(bounds.origin.y - expectedY)
    return (CGWindowID(number.uint32Value), bounds, shapeError * 10 + positionError)
  }
  return candidates.min(by: { $0.2 < $1.2 })
}

func absoluteTransform(_ bounds: CGRect, shiftX: Double, shiftY: Double) -> CGAffineTransform {
  CGAffineTransform(a: 1, b: 0, c: 0, d: 1,
    tx: -bounds.origin.x - shiftX, ty: -bounds.origin.y - shiftY)
}

func setWindowWarp(_ cid: Int32, _ windowID: CGWindowID, _ bounds: CGRect,
                   shiftX: Double, shiftY: Double) -> CGError {
  let x0 = Float(bounds.origin.x + shiftX)
  let y0 = Float(bounds.origin.y + shiftY)
  let x1 = x0 + Float(bounds.width)
  let y1 = y0 + Float(bounds.height)
  var mesh = [
    WindowWarpPoint(local: MeshPoint(x: 0, y: 0), global: MeshPoint(x: x0, y: y0)),
    WindowWarpPoint(local: MeshPoint(x: Float(bounds.width), y: 0), global: MeshPoint(x: x1, y: y0)),
    WindowWarpPoint(local: MeshPoint(x: 0, y: Float(bounds.height)), global: MeshPoint(x: x0, y: y1)),
    WindowWarpPoint(local: MeshPoint(x: Float(bounds.width), y: Float(bounds.height)), global: MeshPoint(x: x1, y: y1)),
  ]
  return mesh.withUnsafeMutableBufferPointer {
    CGSSetWindowWarp(cid, windowID, 2, 2, $0.baseAddress)
  }
}

let windowCommand = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
if CommandLine.arguments.count >= 9
    && (windowCommand == "--translate-window" || windowCommand == "--warp-window") {
  guard let pid = Int32(CommandLine.arguments[2]),
        let expectedX = Double(CommandLine.arguments[3]),
        let expectedY = Double(CommandLine.arguments[4]),
        let expectedW = Double(CommandLine.arguments[5]),
        let expectedH = Double(CommandLine.arguments[6]),
        let shiftX = Double(CommandLine.arguments[7]),
        let shiftY = Double(CommandLine.arguments[8]) else {
    fputs("bad --translate-window arguments\n", stderr)
    exit(2)
  }
  guard let (windowID, initialBounds, score) = matchingPetWindow(
    pid: pid, expectedX: expectedX, expectedY: expectedY,
    expectedW: expectedW, expectedH: expectedH), score <= 80 else {
    fputs("matching pet window not found\n", stderr)
    exit(3)
  }

  let cid = SLSMainConnectionID()
  if windowCommand == "--warp-window" {
    if abs(shiftX) < 0.01 && abs(shiftY) < 0.01 {
      let cleared = CGSSetWindowWarp(cid, windowID, 0, 0, nil)
      print("cleared|\(windowID)|\(cleared.rawValue)")
      exit(cleared == .success ? 0 : 5)
    }
    let durationMs = max(0, min(600,
      Double(CommandLine.arguments.count > 9 ? CommandLine.arguments[9] : "220") ?? 220))
    let steps = durationMs > 0 ? max(1, Int(durationMs / 16)) : 1
    var result = CGError.success
    for i in 1...steps {
      let t = Double(i) / Double(steps)
      let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
      result = setWindowWarp(cid, windowID, initialBounds,
        shiftX: shiftX * eased, shiftY: shiftY * eased)
      if result != .success { break }
      if durationMs > 0 { usleep(useconds_t(durationMs * 1000 / Double(steps))) }
    }
    guard result == .success else {
      fputs("window warp failed: \(result.rawValue)\n", stderr)
      exit(5)
    }
    print("warped|\(windowID)|\(initialBounds.origin.x)|\(initialBounds.origin.y)|\(shiftX)|\(shiftY)")
    fflush(stdout)

    // Warp 不会被 ChatGPT 的 transform 动画覆盖。低频观察逻辑 frame：只要
    // 它仍停在同一水平位置，就随 y 更新网格；水平走开/关闭/父进程退出即清除。
    let parent = getppid()
    var bounds = initialBounds
    while parent != 1 && getppid() == parent {
      usleep(100_000)
      guard let (currentID, currentBounds, _) = matchingPetWindow(
        pid: pid, expectedX: expectedX, expectedY: bounds.origin.y,
        expectedW: expectedW, expectedH: expectedH),
        currentID == windowID,
        abs(currentBounds.origin.x - expectedX) <= 3 else { break }
      bounds = currentBounds
      result = setWindowWarp(cid, windowID, bounds, shiftX: shiftX, shiftY: shiftY)
      if result != .success { break }
    }
    _ = CGSSetWindowWarp(cid, windowID, 0, 0, nil)
    print("unwarped|\(windowID)|\(result.rawValue)")
    exit(0)
  }

  let durationMs = max(0, min(600,
    Double(CommandLine.arguments.count > 9 ? CommandLine.arguments[9] : "220") ?? 220))
  var current = CGAffineTransform.identity
  guard CGSGetWindowTransform(cid, windowID, &current) == .success else {
    fputs("could not read window transform\n", stderr)
    exit(4)
  }
  let target = absoluteTransform(initialBounds, shiftX: shiftX, shiftY: shiftY)
  let steps = durationMs > 0 ? max(1, Int(durationMs / 16)) : 1
  var lastResult = CGError.success
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
    let frame = CGAffineTransform(
      a: current.a + (target.a - current.a) * eased,
      b: current.b + (target.b - current.b) * eased,
      c: current.c + (target.c - current.c) * eased,
      d: current.d + (target.d - current.d) * eased,
      tx: current.tx + (target.tx - current.tx) * eased,
      ty: current.ty + (target.ty - current.ty) * eased)
    lastResult = CGSSetWindowTransform(cid, windowID, frame)
    if lastResult != .success { break }
    if durationMs > 0 { usleep(useconds_t(durationMs * 1000 / Double(steps))) }
  }
  guard lastResult == .success else {
    fputs("window transform failed: \(lastResult.rawValue)\n", stderr)
    exit(5)
  }
  print("translated|\(windowID)|\(initialBounds.origin.x)|\(initialBounds.origin.y)|\(shiftX)|\(shiftY)")
  exit(0)
}

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
// The system cursor is hidden while the Electron overlay renders the orange
// patrol cursor. Always restore the hardware cursor to its original location.
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
