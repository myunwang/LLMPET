import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

// The patrol pointer is a native, non-activating AppKit panel owned by this
// short-lived helper. Keeping it out of Electron avoids exposing Chromium's
// rectangular backing surface when macOS composites a rapidly moving window.
// The view is genuinely transparent: no title bar, material, shadow or opaque
// backing color is involved.
final class PatrolPointerView: NSView {
  override var isOpaque: Bool { false }
  override var isFlipped: Bool { true }

  override func draw(_ dirtyRect: NSRect) {
    NSColor.clear.setFill()
    dirtyRect.fill(using: .copy)

    let arrow = NSBezierPath()
    arrow.move(to: NSPoint(x: 5, y: 5))
    arrow.line(to: NSPoint(x: 8, y: 30))
    arrow.line(to: NSPoint(x: 14.6, y: 23.9))
    arrow.line(to: NSPoint(x: 20.4, y: 36))
    arrow.line(to: NSPoint(x: 25.8, y: 33.3))
    arrow.line(to: NSPoint(x: 19.9, y: 21.4))
    arrow.line(to: NSPoint(x: 28.9, y: 20.7))
    arrow.close()
    arrow.lineJoinStyle = .round
    arrow.lineCapStyle = .round

    NSColor(calibratedRed: 0.41, green: 0.65, blue: 1, alpha: 0.9).setFill()
    arrow.fill()
    NSColor(calibratedRed: 0.14, green: 0.26, blue: 0.40, alpha: 0.72).setStroke()
    arrow.lineWidth = 4.4
    arrow.stroke()
    NSColor.white.setStroke()
    arrow.lineWidth = 2.2
    arrow.stroke()
  }
}

final class PatrolPointerOverlay {
  private let size = CGSize(width: 42, height: 42)
  private let hotspot = CGPoint(x: 5, y: 5)
  private let panel: NSPanel
  private let pointerView: PatrolPointerView
  private var visible = false

  init() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    if !app.isRunning { app.finishLaunching() }

    let contentRect = NSRect(x: -200, y: -200, width: 42, height: 42)
    panel = NSPanel(
      contentRect: contentRect,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false)
    pointerView = PatrolPointerView(frame: NSRect(x: 0, y: 0, width: 42, height: 42))
    panel.isReleasedWhenClosed = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.sharingType = .readOnly
    panel.hidesOnDeactivate = false
    panel.becomesKeyOnlyIfNeeded = true
    panel.animationBehavior = .none
    panel.level = .screenSaver
    panel.collectionBehavior = [
      .canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle,
    ]

    pointerView.wantsLayer = true
    pointerView.layer?.isOpaque = false
    pointerView.layer?.backgroundColor = NSColor.clear.cgColor
    panel.contentView = pointerView
  }

  private func pumpFrame() {
    panel.contentView?.displayIfNeeded()
    panel.displayIfNeeded()
    _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.002))
  }

  func move(to quartzPoint: CGPoint) {
    // CoreGraphics desktop coordinates use a top-left origin; AppKit uses a
    // bottom-left origin. Both APIs report logical points on Retina displays.
    let mainHeight = CGDisplayBounds(CGMainDisplayID()).height
    let origin = NSPoint(
      x: quartzPoint.x - hotspot.x,
      y: mainHeight - quartzPoint.y - (size.height - hotspot.y))
    panel.setFrameOrigin(origin)
    if !visible {
      panel.orderFrontRegardless()
      visible = true
    }
    pumpFrame()
  }

  func hide() {
    guard visible else { return }
    panel.orderOut(nil)
    visible = false
    pumpFrame()
  }

  var statusLine: String {
    let alphaIsClear = panel.backgroundColor.alphaComponent <= 0.001
    let captureIsReadOnly = panel.sharingType == .readOnly
    let rep = pointerView.bitmapImageRepForCachingDisplay(in: pointerView.bounds)
    if let rep { pointerView.cacheDisplay(in: pointerView.bounds, to: rep) }
    let cornerAlphaIsClear = rep.map { bitmap in
      let maxX = max(0, bitmap.pixelsWide - 1)
      let maxY = max(0, bitmap.pixelsHigh - 1)
      return [(0, 0), (maxX, 0), (0, maxY), (maxX, maxY)].allSatisfy { x, y in
        (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 1) <= 0.001
      }
    } ?? false
    let serverInfo = (CGWindowListCopyWindowInfo(
      [.optionIncludingWindow], CGWindowID(panel.windowNumber)) as? [[String: Any]])?.first
    let rawBounds = serverInfo?[kCGWindowBounds as String] as? NSDictionary
    let serverBounds = rawBounds.flatMap(CGRect.init(dictionaryRepresentation:))
    let serverBoundsAreExact = serverBounds.map {
      abs($0.width - size.width) <= 0.5 && abs($0.height - size.height) <= 0.5
    } ?? false
    let serverSharingIsReadOnly = (serverInfo?[kCGWindowSharingState as String] as? NSNumber)?.intValue == 1
    return "overlay|native=1|opaque=\(panel.isOpaque ? 1 : 0)" +
      "|alpha=\(alphaIsClear ? 0 : 1)|shadow=\(panel.hasShadow ? 1 : 0)" +
      "|ignoresMouse=\(panel.ignoresMouseEvents ? 1 : 0)" +
      "|sharing=\(captureIsReadOnly ? 1 : 0)" +
      "|cornerAlpha=\(cornerAlphaIsClear ? 0 : 1)" +
      "|serverBounds=\(serverBoundsAreExact ? 1 : 0)" +
      "|serverSharing=\(serverSharingIsReadOnly ? 1 : 0)"
  }

  deinit {
    panel.orderOut(nil)
    panel.close()
  }
}

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

func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
  return value as? String
}

func axElement(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
        let value else { return nil }
  return unsafeBitCast(value, to: AXUIElement.self)
}

func axPoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
        let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  let axValue = unsafeBitCast(value, to: AXValue.self)
  var point = CGPoint.zero
  return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

func axSize(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
        let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  let axValue = unsafeBitCast(value, to: AXValue.self)
  var size = CGSize.zero
  return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}

func containingWindow(_ element: AXUIElement) -> AXUIElement? {
  if let window = axElement(element, kAXWindowAttribute as CFString) { return window }
  var current: AXUIElement? = element
  for _ in 0..<12 {
    guard let node = current else { break }
    if axString(node, kAXRoleAttribute as CFString) == (kAXWindowRole as String) { return node }
    current = axElement(node, kAXParentAttribute as CFString)
  }
  return nil
}

func matchingHitWindow(at point: CGPoint, pid: Int32, expected: CGRect) -> Bool {
  let system = AXUIElementCreateSystemWide()
  var hit: AXUIElement?
  guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
        let hit, let window = containingWindow(hit) else { return false }
  var ownerPid: pid_t = 0
  guard AXUIElementGetPid(window, &ownerPid) == .success, ownerPid == pid,
        let position = axPoint(window, kAXPositionAttribute as CFString),
        let size = axSize(window, kAXSizeAttribute as CFString) else { return false }
  let shapeError = abs(size.width - expected.width) + abs(size.height - expected.height)
  let positionError = abs(position.x - expected.origin.x) + abs(position.y - expected.origin.y)
  return shapeError <= 8 && positionError <= 20
}

let windowCommand = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
if windowCommand == "--preview-pointer" && CommandLine.arguments.count >= 4 {
  guard let x = Double(CommandLine.arguments[2]),
        let y = Double(CommandLine.arguments[3]) else {
    fputs("bad --preview-pointer arguments\n", stderr)
    exit(2)
  }
  let durationMs = max(100, min(30_000,
    Double(CommandLine.arguments.count > 4 ? CommandLine.arguments[4] : "1500") ?? 1500))
  let patrolPointer = PatrolPointerOverlay()
  patrolPointer.move(to: CGPoint(x: x, y: y))
  print(patrolPointer.statusLine)
  fflush(stdout)
  usleep(useconds_t(durationMs * 1000))
  patrolPointer.hide()
  exit(0)
}

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

// Probe ChatGPT's four possible mascot centers without clicking. A mouseMoved
// lets its transparent renderer update ignoreMouseEvents; AX hit-testing then
// distinguishes the 356x320 overlay window from the larger Codex main window.
if windowCommand == "--probe-window" && CommandLine.arguments.count >= 10 {
  guard AXIsProcessTrusted(),
        let pid = Int32(CommandLine.arguments[2]),
        let expectedX = Double(CommandLine.arguments[3]),
        let expectedY = Double(CommandLine.arguments[4]),
        let expectedW = Double(CommandLine.arguments[5]),
        let expectedH = Double(CommandLine.arguments[6]),
        (CommandLine.arguments.count - 7) % 2 == 0 else {
    fputs("bad --probe-window arguments or accessibility permission missing\n", stderr)
    exit(2)
  }
  guard let original = CGEvent(source: nil)?.location else {
    fputs("could not read cursor location\n", stderr)
    exit(4)
  }
  print("original|\(original.x)|\(original.y)")
  fflush(stdout)

  // Hardware isolation must happen before the first synthetic warp. Physical
  // mouse deltas can no longer race the hover activation or drag start.
  let associateResult = CGAssociateMouseAndMouseCursorPosition(0)
  guard associateResult == .success else {
    fputs("cursor isolation failed before probe\n", stderr)
    exit(4)
  }
  let display = CGMainDisplayID()
  let hideResult = CGDisplayHideCursor(display)
  guard hideResult == .success else {
    _ = CGAssociateMouseAndMouseCursorPosition(1)
    fputs("cursor hide failed while probing\n", stderr)
    exit(4)
  }
  let patrolPointer = PatrolPointerOverlay()
  var restored = false
  func restoreProbeCursor() -> (CGError, CGError, CGError) {
    let warp = CGWarpMouseCursorPosition(original)
    let associate = CGAssociateMouseAndMouseCursorPosition(1)
    let show = CGDisplayShowCursor(display)
    return (warp, associate, show)
  }
  defer {
    patrolPointer.hide()
    if !restored { _ = restoreProbeCursor() }
  }

  let expected = CGRect(x: expectedX, y: expectedY, width: expectedW, height: expectedH)
  let source = CGEventSource(stateID: .hidSystemState)
  var found = -1
  var index = 0
  var arg = 7
  while arg + 1 < CommandLine.arguments.count {
    guard let rx = Double(CommandLine.arguments[arg]),
          let ry = Double(CommandLine.arguments[arg + 1]) else { break }
    let point = CGPoint(x: expectedX + expectedW * rx, y: expectedY + expectedH * ry)
    patrolPointer.move(to: point)
    _ = CGWarpMouseCursorPosition(point)
    if let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                           mouseCursorPosition: point, mouseButton: .left) {
      event.post(tap: .cghidEventTap)
    }
    usleep(180_000)
    if matchingHitWindow(at: point, pid: pid, expected: expected) {
      found = index
      break
    }
    index += 1
    arg += 2
  }
  let overlayStatus = patrolPointer.statusLine
  patrolPointer.hide()
  let restoreResults = restoreProbeCursor()
  restored = restoreResults.0 == .success
    && restoreResults.1 == .success
    && restoreResults.2 == .success
  let final = CGEvent(source: nil)?.location
  let leftButtonDown = CGEventSource.buttonState(.combinedSessionState, button: .left)
  if let final {
    print("cursor|\(original.x)|\(original.y)|\(final.x)|\(final.y)")
  }
  print("probe|\(found)")
  print("isolation|beforeWarp=1|associate=\(associateResult.rawValue)")
  print("restore|warp=\(restoreResults.0.rawValue)|associate=\(restoreResults.1.rawValue)|show=\(restoreResults.2.rawValue)")
  print("button|left=\(leftButtonDown ? 1 : 0)")
  print(overlayStatus)
  guard restored, !leftButtonDown, let final,
        hypot(final.x - original.x, final.y - original.y) <= 2 else {
    fputs("probe cursor restoration verification failed\n", stderr)
    exit(5)
  }
  exit(0)
}

// Emergency cleanup for a targeted drag that was interrupted after mouseDown.
// The release goes only to the rival process and never warps the global cursor.
if windowCommand == "--release-pid" && CommandLine.arguments.count >= 5 {
  guard let pid = Int32(CommandLine.arguments[2]),
        let x = Double(CommandLine.arguments[3]),
        let y = Double(CommandLine.arguments[4]) else {
    fputs("bad --release-pid arguments\n", stderr)
    exit(2)
  }
  let source = CGEventSource(stateID: .privateState)
  let point = CGPoint(x: x, y: y)
  guard let event = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
                            mouseCursorPosition: point, mouseButton: .left) else {
    fputs("could not create targeted mouseUp\n", stderr)
    exit(4)
  }
  event.postToPid(pid_t(pid))
  print("release-pid|\(pid)|\(x)|\(y)")
  exit(0)
}

if windowCommand == "--release" {
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
  let warpResult = CGWarpMouseCursorPosition(point)
  let associateResult = CGAssociateMouseAndMouseCursorPosition(1)
  let showResult = CGDisplayShowCursor(CGMainDisplayID())
  let leftButtonDown = CGEventSource.buttonState(.combinedSessionState, button: .left)
  print("release|warp=\(warpResult.rawValue)|associate=\(associateResult.rawValue)|show=\(showResult.rawValue)|left=\(leftButtonDown ? 1 : 0)")
  exit(warpResult == .success && associateResult == .success && showResult == .success && !leftButtonDown ? 0 : 5)
}

// Low-level fallback for transparent/borderless pets whose AXPosition is exposed
// but silently ignores writes. Hardware input is isolated before global HID
// synthesis, while the native overlay visualizes the synthetic drag position.
guard windowCommand == "--drag-pid", CommandLine.arguments.count >= 8,
      let targetPid = Int32(CommandLine.arguments[2]),
      let sx = Double(CommandLine.arguments[3]),
      let sy = Double(CommandLine.arguments[4]),
      let ex = Double(CommandLine.arguments[5]),
      let ey = Double(CommandLine.arguments[6]) else {
  fputs("usage: drag-window.swift --drag-pid pid sx sy ex ey [durationMs]\n", stderr)
  exit(2)
}

guard AXIsProcessTrusted() else {
  fputs("accessibility permission required\n", stderr)
  exit(3)
}

let durationMs = max(180, min(1500,
  Double(CommandLine.arguments.count > 7 ? CommandLine.arguments[7] : "520") ?? 520))
let steps = max(12, Int(durationMs / 16))
let source = CGEventSource(stateID: .hidSystemState)
let original = CGEvent(source: nil)?.location
if let original {
  print("original|\(original.x)|\(original.y)")
  fflush(stdout)
}
// Isolate hardware input before the very first warp/hover, not after
// mouseDown. This removes the race where physical deltas moved the synthetic
// start point during ChatGPT's activation delay.
let associationResult = CGAssociateMouseAndMouseCursorPosition(0)
guard associationResult == .success else {
  fputs("cursor isolation failed before drag\n", stderr)
  exit(4)
}
let cursorDisplay = CGMainDisplayID()
let hideResult = CGDisplayHideCursor(cursorDisplay)
guard hideResult == .success else {
  _ = CGAssociateMouseAndMouseCursorPosition(1)
  fputs("cursor hide failed\n", stderr)
  exit(4)
}
let patrolPointer = PatrolPointerOverlay()
var cursorRestored = false
func restoreCursor() -> (CGError, CGError, CGError) {
  let warp = original.map(CGWarpMouseCursorPosition) ?? .success
  let associate = CGAssociateMouseAndMouseCursorPosition(1)
  let show = CGDisplayShowCursor(cursorDisplay)
  return (warp, associate, show)
}
defer {
  patrolPointer.hide()
  if !cursorRestored { _ = restoreCursor() }
}

var eventWarpResult = CGError.success
func post(_ type: CGEventType, _ point: CGPoint) {
  patrolPointer.move(to: point)
  let warped = CGWarpMouseCursorPosition(point)
  if eventWarpResult == .success && warped != .success { eventWarpResult = warped }
  guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                            mouseCursorPosition: point, mouseButton: .left) else {
    return
  }
  event.post(tap: .cghidEventTap)
}

let start = CGPoint(x: sx, y: sy)
let end = CGPoint(x: ex, y: ey)
// 第三方透明桌宠可能需要一笔 hover 才建立自己的 pointer capture；给足一帧
// 以上的激活时间，然后再 mouseDown 和连续拖拽。
post(.mouseMoved, start)
usleep(150_000)
post(.mouseMoved, CGPoint(x: sx + 1, y: sy))
usleep(55_000)
post(.mouseMoved, start)
usleep(35_000)
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

// 某些桌宠会按 pointerup 前的采样速度增加惯性；末端连续发送同坐标 drag，
// 把速度窗口压成 0，避免刚到边缘又弹回去。
for _ in 0..<7 {
  post(.leftMouseDragged, end)
  usleep(30_000)
}
post(.leftMouseUp, end)
usleep(80_000)
let overlayStatus = patrolPointer.statusLine
patrolPointer.hide()
let restoreResults = restoreCursor()
cursorRestored = restoreResults.0 == .success
  && restoreResults.1 == .success
  && restoreResults.2 == .success
let restored = CGEvent(source: nil)?.location
let leftButtonDown = CGEventSource.buttonState(.combinedSessionState, button: .left)
if let original, let restored {
  print("cursor|\(original.x)|\(original.y)|\(restored.x)|\(restored.y)")
}
print("isolation|beforeWarp=1|associate=\(associationResult.rawValue)")
print("restore|warp=\(restoreResults.0.rawValue)|associate=\(restoreResults.1.rawValue)|show=\(restoreResults.2.rawValue)")
print("button|left=\(leftButtonDown ? 1 : 0)")
print(overlayStatus)
guard cursorRestored, eventWarpResult == .success, !leftButtonDown,
      let original, let restored,
      hypot(restored.x - original.x, restored.y - original.y) <= 2 else {
  fputs("isolated drag restoration verification failed\n", stderr)
  exit(5)
}
print("transport|warp=\(eventWarpResult.rawValue)")
print("ok|hide=\(hideResult.rawValue)|associate=\(associationResult.rawValue)|beforeWarp=1")
