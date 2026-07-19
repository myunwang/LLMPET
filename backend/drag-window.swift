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

// A process-targeted CGEvent still needs the target window's local coordinate.
// Computer-use-style delivery carries both the desktop point and this
// window-relative point; without the latter Electron receives a syntactically
// valid event but never establishes a transparent-window drag capture.
@_silgen_name("CGEventSetWindowLocation")
func CGEventSetWindowLocation(_ event: CGEvent, _ point: CGPoint)

@_silgen_name("SLEventPostToPid")
func SLEventPostToPid(_ pid: Int32, _ event: CGEvent) -> Int32

@_silgen_name("SLSGetWindowEventMask")
func SLSGetWindowEventMask(_ cid: Int32, _ windowID: CGWindowID,
                           _ mask: UnsafeMutablePointer<UInt32>) -> CGError

@_silgen_name("SLSSetWindowEventMask")
func SLSSetWindowEventMask(_ cid: Int32, _ windowID: CGWindowID,
                           _ mask: UInt32) -> CGError

@_silgen_name("_AXUIElementGetWindow")
func AXUIElementGetWindow(_ element: AXUIElement,
                          _ windowID: UnsafeMutablePointer<CGWindowID>) -> AXError

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

func axWindows(pid: Int32) -> [AXUIElement] {
  let app = AXUIElementCreateApplication(pid_t(pid))
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success,
        let raw, CFGetTypeID(raw) == CFArrayGetTypeID() else { return [] }
  let array = unsafeBitCast(raw, to: CFArray.self)
  return (0..<CFArrayGetCount(array)).map { index in
    unsafeBitCast(CFArrayGetValueAtIndex(array, index), to: AXUIElement.self)
  }
}

func matchingAXPetWindow(pid: Int32, expected: CGRect) -> (CGWindowID, CGRect, Double)? {
  let candidates = axWindows(pid: pid).compactMap { window -> (CGWindowID, CGRect, Double)? in
    guard let position = axPoint(window, kAXPositionAttribute as CFString),
          let size = axSize(window, kAXSizeAttribute as CFString) else { return nil }
    let bounds = CGRect(origin: position, size: size)
    let shapeError = abs(size.width - expected.width) + abs(size.height - expected.height)
    // Never substitute the host application's large chat window for its pet.
    guard shapeError <= 16, size.width <= 650, size.height <= 650 else { return nil }
    var windowID = CGWindowID(0)
    guard AXUIElementGetWindow(window, &windowID) == .success, windowID != 0 else { return nil }
    let positionError = abs(position.x - expected.origin.x) + abs(position.y - expected.origin.y)
    return (windowID, bounds, shapeError * 10 + positionError)
  }
  return candidates.min(by: { $0.2 < $1.2 })
}

func matchingPetWindow(pid: Int32, expectedX: Double, expectedY: Double,
                       expectedW: Double, expectedH: Double) -> (CGWindowID, CGRect, Double)? {
  let expected = CGRect(x: expectedX, y: expectedY, width: expectedW, height: expectedH)
  // Electron may expose a 356x320 logical AX window backed by a differently
  // sized private WindowServer surface (500x500 in current ChatGPT builds).
  // Resolve the exact window number through AX, then use its real server bounds
  // for event routing/visual transforms instead of guessing by CG dimensions.
  if AXIsProcessTrusted(),
     let (windowID, _, score) = matchingAXPetWindow(pid: pid, expected: expected),
     score <= 80 {
    let rows = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID)
      as? [[String: Any]]) ?? []
    if let info = rows.first(where: {
      ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID
    }), let rawBounds = info[kCGWindowBounds as String] as? NSDictionary,
       let serverBounds = CGRect(dictionaryRepresentation: rawBounds) {
      return (windowID, serverBounds, score)
    }
    return (windowID, expected, score)
  }
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

func boundsForWindow(_ windowID: CGWindowID, ownedBy pid: Int32) -> CGRect? {
  let rows = (CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID)
    as? [[String: Any]]) ?? []
  guard let info = rows.first(where: {
    ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID
      && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
  }), let rawBounds = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
  return CGRect(dictionaryRepresentation: rawBounds)
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

// A process-targeted event never enters the global HID stream. The WindowServer
// window fields are filled explicitly so AppKit/Electron can route the event to
// the transparent pet window even while the user's real cursor is elsewhere.
final class TargetedMouseTransport {
  let targetPid: Int32
  let targetWindowID: CGWindowID
  let logicalBounds: CGRect
  private var eventNumber: Int64 = 1
  private var originalEventMask: UInt32 = 0
  private var expandedEventMask = false

  init(targetPid: Int32, targetWindowID: CGWindowID, logicalBounds: CGRect) {
    self.targetPid = targetPid
    self.targetWindowID = targetWindowID
    self.logicalBounds = logicalBounds
    // Electron's transparent pet window dynamically removes mouse bits from
    // its WindowServer event mask (0x00005c08 vs a normal 0xee5cfffe). A
    // process-targeted event cannot establish pointer capture while those bits
    // are absent. Expand only for this short helper lifetime and always restore.
    let cid = SLSMainConnectionID()
    if SLSGetWindowEventMask(cid, targetWindowID, &originalEventMask) == .success {
      let expanded = originalEventMask | 0xee5cffff
      expandedEventMask = SLSSetWindowEventMask(cid, targetWindowID, expanded) == .success
    }
  }

  deinit {
    if expandedEventMask {
      _ = SLSSetWindowEventMask(SLSMainConnectionID(), targetWindowID, originalEventMask)
    }
  }

  @discardableResult
  func post(_ type: CGEventType, at point: CGPoint) -> Bool {
    let nsType: NSEvent.EventType
    switch type {
    case .mouseMoved: nsType = .mouseMoved
    case .leftMouseDown: nsType = .leftMouseDown
    case .leftMouseDragged: nsType = .leftMouseDragged
    case .leftMouseUp: nsType = .leftMouseUp
    default: return false
    }
    // Window coordinates use AppKit's bottom-left origin even though the
    // desktop coordinate carried by CGEvent uses a top-left origin here.
    let local = CGPoint(
      x: point.x - logicalBounds.origin.x,
      y: logicalBounds.height - (point.y - logicalBounds.origin.y))
    let clickCount = type == .leftMouseDown || type == .leftMouseUp ? 1 : 0
    let pressure: Float = type == .leftMouseUp || type == .mouseMoved ? 0 : 1
    guard let nsEvent = NSEvent.mouseEvent(
      with: nsType,
      location: local,
      modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: Int(targetWindowID),
      context: nil,
      eventNumber: Int(eventNumber),
      clickCount: clickCount,
      pressure: pressure),
      let event = nsEvent.cgEvent else { return false }
    event.location = point
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(targetPid))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer,
                               value: Int64(targetWindowID))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent,
                               value: Int64(targetWindowID))
    CGEventSetWindowLocation(event, local)
    event.setIntegerValueField(.mouseEventNumber, value: eventNumber)
    if type == .leftMouseDown || type == .leftMouseUp {
      event.setIntegerValueField(.mouseEventClickState, value: 1)
    }
    event.setDoubleValueField(.mouseEventPressure, value: Double(pressure))
    guard SLEventPostToPid(targetPid, event) == 0 else { return false }
    if type == .leftMouseUp { eventNumber += 1 }
    return true
  }

  var statusLine: String {
    "transport|targeted=1|pid=\(targetPid)|window=\(targetWindowID)" +
      "|nsEvent=1|windowLocation=1|slevent=1" +
      "|eventMask=\(expandedEventMask ? 1 : 0)|warp=0|associate=0|hide=0"
  }
}

func physicalMouseButtonIsDown() -> Bool {
  [.left, .right, .center].contains {
    CGEventSource.buttonState(.combinedSessionState, button: $0)
  }
}

let windowCommand = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
if windowCommand == "--inspect-pid" && CommandLine.arguments.count >= 3 {
  guard let pid = Int32(CommandLine.arguments[2]) else {
    fputs("bad --inspect-pid argument\n", stderr)
    exit(2)
  }
  for window in axWindows(pid: pid) {
    var windowID = CGWindowID(0)
    _ = AXUIElementGetWindow(window, &windowID)
    let position = axPoint(window, kAXPositionAttribute as CFString) ?? .zero
    let size = axSize(window, kAXSizeAttribute as CFString) ?? .zero
    let role = axString(window, kAXRoleAttribute as CFString) ?? ""
    let subrole = axString(window, kAXSubroleAttribute as CFString) ?? ""
    let title = axString(window, kAXTitleAttribute as CFString) ?? ""
    print("ax|\(windowID)|\(position.x)|\(position.y)|\(size.width)|\(size.height)|\(role)|\(subrole)|\(title)")
  }
  let rows = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID)
    as? [[String: Any]]) ?? []
  for info in rows {
    guard let owner = info[kCGWindowOwnerPID as String] as? NSNumber,
          owner.int32Value == pid,
          let number = info[kCGWindowNumber as String] as? NSNumber,
          let rawBounds = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: rawBounds) else { continue }
    let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
    let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? -1
    let onscreen = (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true ? 1 : 0
    let sharing = (info[kCGWindowSharingState as String] as? NSNumber)?.intValue ?? -1
    let store = (info[kCGWindowStoreType as String] as? NSNumber)?.intValue ?? -1
    let memory = (info[kCGWindowMemoryUsage as String] as? NSNumber)?.intValue ?? -1
    let name = (info[kCGWindowName as String] as? String) ?? ""
    print("cg|\(number.uint32Value)|\(bounds.origin.x)|\(bounds.origin.y)|\(bounds.width)|\(bounds.height)|\(layer)|\(alpha)|\(onscreen)|\(sharing)|\(store)|\(memory)|\(name)")
  }
  exit(0)
}

// 新版 Codex 桌宠(243x253)接受 AXPosition 写入,但 System Events 的
// AXPosition setter 对它静默 no-op,只有直调 AX C API 才真正生效。
// 用法: --move-window pid ew eh nx ny → 按预期尺寸(±24)找 AX 窗,写入新
// 位置,等一拍后读回。输出 "moved|旧x|旧y|新x|新y";找不到匹配窗输出 gone。
if windowCommand == "--move-window" && CommandLine.arguments.count >= 7 {
  guard AXIsProcessTrusted(),
        let pid = Int32(CommandLine.arguments[2]),
        let expectedW = Double(CommandLine.arguments[3]),
        let expectedH = Double(CommandLine.arguments[4]),
        let nx = Double(CommandLine.arguments[5]),
        let ny = Double(CommandLine.arguments[6]) else {
    fputs("bad --move-window arguments or accessibility permission missing\n", stderr)
    exit(2)
  }
  var bestWindow: AXUIElement?
  var bestScore = Double.infinity
  for window in axWindows(pid: pid) {
    guard let size = axSize(window, kAXSizeAttribute as CFString) else { continue }
    let score = abs(size.width - expectedW) + abs(size.height - expectedH)
    guard score <= 24, score < bestScore else { continue }
    bestScore = score
    bestWindow = window
  }
  guard let window = bestWindow,
        let before = axPoint(window, kAXPositionAttribute as CFString) else {
    print("gone")
    exit(0)
  }
  var target = CGPoint(x: nx, y: ny)
  guard let value = AXValueCreate(.cgPoint, &target) else {
    fputs("could not build AXValue\n", stderr)
    exit(4)
  }
  let result = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value)
  guard result == .success else {
    fputs("AXPosition write failed: \(result.rawValue)\n", stderr)
    exit(5)
  }
  // 写入是异步应用的,立即读会拿到旧值;等一拍再读真实落点。
  usleep(250_000)
  let after = axPoint(window, kAXPositionAttribute as CFString) ?? target
  print("moved|\(before.x)|\(before.y)|\(after.x)|\(after.y)")
  exit(0)
}

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
    let durationMs = max(0, min(900,
      Double(CommandLine.arguments.count > 9 ? CommandLine.arguments[9] : "220") ?? 220))
    let pointerStart: CGPoint? = {
      guard CommandLine.arguments.count > 11,
            let x = Double(CommandLine.arguments[10]),
            let y = Double(CommandLine.arguments[11]) else { return nil }
      return CGPoint(x: x, y: y)
    }()
    let patrolPointer = pointerStart.map { _ in PatrolPointerOverlay() }
    if let pointerStart { patrolPointer?.move(to: pointerStart) }
    defer { patrolPointer?.hide() }
    let steps = durationMs > 0 ? max(1, Int(durationMs / 16)) : 1
    var result = CGError.success
    for i in 1...steps {
      if physicalMouseButtonIsDown() {
        _ = CGSSetWindowWarp(cid, windowID, 0, 0, nil)
        patrolPointer?.hide()
        print("interrupted|user=1")
        exit(6)
      }
      let t = Double(i) / Double(steps)
      let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
      result = setWindowWarp(cid, windowID, initialBounds,
        shiftX: shiftX * eased, shiftY: shiftY * eased)
      if result != .success { break }
      if let pointerStart {
        patrolPointer?.move(to: CGPoint(
          x: pointerStart.x + shiftX * eased,
          y: pointerStart.y + shiftY * eased))
      }
      print("progress|\(eased)")
      fflush(stdout)
      if durationMs > 0 { usleep(useconds_t(durationMs * 1000 / Double(steps))) }
    }
    guard result == .success else {
      fputs("window warp failed: \(result.rawValue)\n", stderr)
      exit(5)
    }
    patrolPointer?.hide()
    print("warped|\(windowID)|\(initialBounds.origin.x)|\(initialBounds.origin.y)|\(shiftX)|\(shiftY)")
    fflush(stdout)

    // ChatGPT 的桌宠会自行更新 AX/WindowServer 的逻辑 x。之前把这视为“用户
    // 拖走了”，导致刚输出 warped 就清除网格，JS 却已经误报 victory。这里把
    // 第一次抵达的合成层 x 当成固定边界：逻辑窗自己走动时动态修正 shift，
    // 可见桌宠仍留在边缘。只有窗口/父进程消失，或用户在桌宠上按键接管时清除。
    let parent = getppid()
    let pinnedWindowX = initialBounds.origin.x + shiftX
    var stableTicks = 0
    var announcedStable = false
    while parent != 1 && getppid() == parent {
      usleep(100_000)
      guard let currentBounds = boundsForWindow(windowID, ownedBy: pid) else { break }
      let liveShiftX = pinnedWindowX - currentBounds.origin.x
      let warpedBounds = CGRect(
        x: pinnedWindowX, y: currentBounds.origin.y + shiftY,
        width: currentBounds.width, height: currentBounds.height)
      if physicalMouseButtonIsDown(), let cursor = CGEvent(source: nil)?.location,
         warpedBounds.contains(cursor) {
        print("released|user=1")
        fflush(stdout)
        break
      }
      result = setWindowWarp(cid, windowID, currentBounds,
        shiftX: liveShiftX, shiftY: shiftY)
      if result != .success { break }
      stableTicks += 1
      if !announcedStable && stableTicks >= 4 {
        announcedStable = true
        print("stable|\(windowID)|\(pinnedWindowX)|\(currentBounds.origin.y + shiftY)")
        fflush(stdout)
      }
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

// Probe ChatGPT's possible mascot centers without touching the global cursor.
// A process/window-targeted mouseMoved lets its transparent renderer update
// ignoreMouseEvents; AX hit-testing then confirms which point belongs to the
// 356x320 pet window rather than the larger ChatGPT/Codex main window.
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
  guard let (windowID, _, score) = matchingPetWindow(
    pid: pid, expectedX: expectedX, expectedY: expectedY,
    expectedW: expectedW, expectedH: expectedH), score <= 80 else {
    fputs("matching probe window not found\n", stderr)
    exit(3)
  }
  let original = CGEvent(source: nil)?.location
  if let original { print("cursor-start|\(original.x)|\(original.y)") }
  let patrolPointer = PatrolPointerOverlay()
  let expected = CGRect(x: expectedX, y: expectedY, width: expectedW, height: expectedH)
  let transport = TargetedMouseTransport(
    targetPid: pid, targetWindowID: windowID, logicalBounds: expected)
  defer { patrolPointer.hide() }

  var found = -1
  var index = 0
  var arg = 7
  var interrupted = physicalMouseButtonIsDown()
  var eventFailed = false
  while arg + 1 < CommandLine.arguments.count {
    if physicalMouseButtonIsDown() {
      interrupted = true
      break
    }
    guard let rx = Double(CommandLine.arguments[arg]),
          let ry = Double(CommandLine.arguments[arg + 1]) else { break }
    let point = CGPoint(x: expectedX + expectedW * rx, y: expectedY + expectedH * ry)
    patrolPointer.move(to: point)
    if !transport.post(.mouseMoved, at: point) {
      eventFailed = true
      break
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
  let final = CGEvent(source: nil)?.location
  if let original, let final {
    print("cursor|\(original.x)|\(original.y)|\(final.x)|\(final.y)")
  }
  print("probe|\(found)")
  print("interrupted|user=\(interrupted ? 1 : 0)")
  print(transport.statusLine)
  print(overlayStatus)
  guard !eventFailed else {
    fputs("targeted probe event creation failed\n", stderr)
    exit(5)
  }
  if interrupted { exit(6) }
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

// Emergency cleanup for the short exclusive HID lease used by ChatGPT. The
// parent invokes this if the drag helper crashes or times out, so the system
// cursor can never remain hidden/disassociated and mouseDown cannot stay held.
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
  exit(warpResult == .success && associateResult == .success
    && showResult == .success && !leftButtonDown ? 0 : 5)
}

// ChatGPT's transparent Electron overlay rejects process-targeted pointer
// capture and cross-process window moves. Take a short, verified HID lease:
// hardware deltas are isolated before the first warp, the real cursor is
// hidden, and a separate native overlay visualizes the patrol pointer. The
// exact physical cursor position and association are restored before success.
if windowCommand == "--isolated-drag-pid" && CommandLine.arguments.count >= 12 {
  guard let targetPid = Int32(CommandLine.arguments[2]),
        let expectedX = Double(CommandLine.arguments[3]),
        let expectedY = Double(CommandLine.arguments[4]),
        let expectedW = Double(CommandLine.arguments[5]),
        let expectedH = Double(CommandLine.arguments[6]),
        let sx = Double(CommandLine.arguments[7]),
        let sy = Double(CommandLine.arguments[8]),
        let ex = Double(CommandLine.arguments[9]),
        let ey = Double(CommandLine.arguments[10]),
        let (_, _, score) = matchingPetWindow(
          pid: targetPid, expectedX: expectedX, expectedY: expectedY,
          expectedW: expectedW, expectedH: expectedH), score <= 80,
        AXIsProcessTrusted() else {
    fputs("isolated drag target missing or accessibility permission required\n", stderr)
    exit(3)
  }
  let durationMs = max(180, min(1500,
    Double(CommandLine.arguments[11]) ?? 520))
  // Codex 机器人桌宠的窗口对 AX hit-test 永远隐身(冷查/hover 后都解析不到),
  // 但 WindowServer 的真实 HID 事件路由是通的——drag 实测能移动它。对这类
  // 目标跳过命中门,成功与否交给 JS 侧的 AX frame 位移复核。
  let skipHitGate = CommandLine.arguments.count > 12
    && CommandLine.arguments[12] == "nogate"
  let steps = max(12, Int(durationMs / 16))
  let source = CGEventSource(stateID: .hidSystemState)
  guard let original = CGEvent(source: nil)?.location else {
    fputs("could not read original cursor position\n", stderr)
    exit(4)
  }
  print("original|\(original.x)|\(original.y)")
  fflush(stdout)

  // ChatGPT 的透明桌宠只有在系统光标仍与物理鼠标关联时,才会可靠地激活自己
  // 的 pointer capture(hover 命中)。所以先只隐藏光标、保持关联完成 hover 与
  // mouseDown 捕获;拿到 capture 之后再断开物理鼠标做隔离拖拽。光标此刻已隐藏,
  // 提前解耦反而会让 hover 激活失效,导致 matchingHitWindow 永远命中不到桌宠。
  let cursorDisplay = CGMainDisplayID()
  let hideResult = CGDisplayHideCursor(cursorDisplay)
  guard hideResult == .success else {
    fputs("cursor hide failed\n", stderr)
    exit(4)
  }
  var associationResult = CGError.success
  let patrolPointer = PatrolPointerOverlay()
  var cursorRestored = false
  var mouseIsDown = false
  var lastPoint = CGPoint(x: sx, y: sy)
  func restoreCursor() -> (CGError, CGError, CGError) {
    if mouseIsDown,
       let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
                        mouseCursorPosition: lastPoint, mouseButton: .left) {
      up.post(tap: .cghidEventTap)
      mouseIsDown = false
    }
    let warp = CGWarpMouseCursorPosition(original)
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
    lastPoint = point
    let warped = CGWarpMouseCursorPosition(point)
    if eventWarpResult == .success && warped != .success { eventWarpResult = warped }
    guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                              mouseCursorPosition: point, mouseButton: .left) else { return }
    event.post(tap: .cghidEventTap)
  }

  let start = CGPoint(x: sx, y: sy)
  let end = CGPoint(x: ex, y: ey)
  post(.mouseMoved, start)
  usleep(150_000)
  post(.mouseMoved, CGPoint(x: sx + 1, y: sy))
  usleep(55_000)
  post(.mouseMoved, start)
  usleep(35_000)
  let expected = CGRect(x: expectedX, y: expectedY, width: expectedW, height: expectedH)
  if skipHitGate {
    print("hit|target=skipped")
  } else {
    guard matchingHitWindow(at: start, pid: targetPid, expected: expected) else {
      let restoreResults = restoreCursor()
      cursorRestored = restoreResults.0 == .success
        && restoreResults.1 == .success && restoreResults.2 == .success
      print("hit|target=0")
      print("restore|warp=\(restoreResults.0.rawValue)|associate=\(restoreResults.1.rawValue)|show=\(restoreResults.2.rawValue)")
      exit(7)
    }
    print("hit|target=1")
  }
  post(.leftMouseDown, start)
  mouseIsDown = true
  usleep(80_000)
  // pointer capture 已建立,此刻才断开物理鼠标:后续 warp/拖拽不再被用户手部
  // 移动干扰。失败也已被 defer→restoreCursor() 覆盖(会补 mouseUp 并恢复光标)。
  associationResult = CGAssociateMouseAndMouseCursorPosition(0)
  guard associationResult == .success else {
    fputs("cursor isolation failed after capture\n", stderr)
    exit(4)
  }
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
    let point = CGPoint(x: sx + (ex - sx) * eased, y: sy + (ey - sy) * eased)
    post(.leftMouseDragged, point)
    print("progress|\(eased)")
    fflush(stdout)
    usleep(useconds_t(durationMs * 1000 / Double(steps)))
  }
  for _ in 0..<7 {
    post(.leftMouseDragged, end)
    usleep(30_000)
  }
  post(.leftMouseUp, end)
  mouseIsDown = false
  usleep(80_000)
  let overlayStatus = patrolPointer.statusLine
  patrolPointer.hide()
  let restoreResults = restoreCursor()
  cursorRestored = restoreResults.0 == .success
    && restoreResults.1 == .success && restoreResults.2 == .success
  let restored = CGEvent(source: nil)?.location
  let leftButtonDown = CGEventSource.buttonState(.combinedSessionState, button: .left)
  if let restored {
    print("cursor|\(original.x)|\(original.y)|\(restored.x)|\(restored.y)")
  }
  print("isolation|afterCapture=1|associate=\(associationResult.rawValue)")
  print("restore|warp=\(restoreResults.0.rawValue)|associate=\(restoreResults.1.rawValue)|show=\(restoreResults.2.rawValue)")
  print("button|left=\(leftButtonDown ? 1 : 0)")
  print(overlayStatus)
  guard cursorRestored, eventWarpResult == .success, !leftButtonDown,
        let restored, hypot(restored.x - original.x, restored.y - original.y) <= 2 else {
    fputs("isolated drag restoration verification failed\n", stderr)
    exit(5)
  }
  print("transport|isolated-hid=1|warp=\(eventWarpResult.rawValue)")
  print("ok|hide=\(hideResult.rawValue)|associate=\(associationResult.rawValue)|afterCapture=1|restored=1")
  exit(0)
}

// Low-level fallback for transparent/borderless pets whose AXPosition is exposed
// but silently ignores writes. Events are delivered only to the rival process
// and its exact WindowServer window. The native overlay visualizes the virtual
// drag while the user's real cursor remains visible and fully associated.
guard windowCommand == "--drag-pid", CommandLine.arguments.count >= 12,
      let targetPid = Int32(CommandLine.arguments[2]),
      let expectedX = Double(CommandLine.arguments[3]),
      let expectedY = Double(CommandLine.arguments[4]),
      let expectedW = Double(CommandLine.arguments[5]),
      let expectedH = Double(CommandLine.arguments[6]),
      let sx = Double(CommandLine.arguments[7]),
      let sy = Double(CommandLine.arguments[8]),
      let ex = Double(CommandLine.arguments[9]),
      let ey = Double(CommandLine.arguments[10]) else {
  fputs("usage: drag-window.swift --drag-pid pid wx wy ww wh sx sy ex ey [durationMs]\n", stderr)
  exit(2)
}

guard AXIsProcessTrusted() else {
  fputs("accessibility permission required\n", stderr)
  exit(3)
}

guard let (windowID, _, score) = matchingPetWindow(
  pid: targetPid, expectedX: expectedX, expectedY: expectedY,
  expectedW: expectedW, expectedH: expectedH), score <= 80 else {
  fputs("matching drag window not found\n", stderr)
  exit(3)
}

let durationMs = max(180, min(1500,
  Double(CommandLine.arguments.count > 11 ? CommandLine.arguments[11] : "520") ?? 520))
let steps = max(12, Int(durationMs / 16))
let original = CGEvent(source: nil)?.location
if let original { print("cursor-start|\(original.x)|\(original.y)") }
let patrolPointer = PatrolPointerOverlay()
let transport = TargetedMouseTransport(
  targetPid: targetPid,
  targetWindowID: windowID,
  logicalBounds: CGRect(x: expectedX, y: expectedY, width: expectedW, height: expectedH))
var mouseIsDown = false
var lastPoint = CGPoint(x: sx, y: sy)
defer {
  if mouseIsDown { _ = transport.post(.leftMouseUp, at: lastPoint) }
  patrolPointer.hide()
}

var eventFailed = false
func post(_ type: CGEventType, _ point: CGPoint) -> Bool {
  patrolPointer.move(to: point)
  lastPoint = point
  let sent = transport.post(type, at: point)
  if !sent { eventFailed = true }
  return sent
}

let start = CGPoint(x: sx, y: sy)
let end = CGPoint(x: ex, y: ey)
var interrupted = physicalMouseButtonIsDown()
// 第三方透明桌宠可能需要一笔 hover 才建立自己的 pointer capture；给足一帧
// 以上的激活时间，然后再 mouseDown 和连续拖拽。
if !interrupted {
  _ = post(.mouseMoved, start)
  usleep(150_000)
  interrupted = physicalMouseButtonIsDown()
}
if !interrupted && !eventFailed {
  _ = post(.mouseMoved, CGPoint(x: sx + 1, y: sy))
  usleep(55_000)
  interrupted = physicalMouseButtonIsDown()
}
if !interrupted && !eventFailed {
  _ = post(.mouseMoved, start)
  usleep(35_000)
  interrupted = physicalMouseButtonIsDown()
}
if !interrupted && !eventFailed {
  mouseIsDown = post(.leftMouseDown, start)
  usleep(80_000)
}

if mouseIsDown && !eventFailed {
  for i in 1...steps {
    if physicalMouseButtonIsDown() {
      interrupted = true
      break
    }
    let t = Double(i) / Double(steps)
    let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
    let point = CGPoint(x: sx + (ex - sx) * eased, y: sy + (ey - sy) * eased)
    if !post(.leftMouseDragged, point) { break }
    print("progress|\(eased)")
    fflush(stdout)
    usleep(useconds_t(durationMs * 1000 / Double(steps)))
  }
}

// 某些桌宠会按 pointerup 前的采样速度增加惯性；末端连续发送同坐标 drag，
// 把速度窗口压成 0，避免刚到边缘又弹回去。
if mouseIsDown && !interrupted && !eventFailed {
  for _ in 0..<7 {
    if physicalMouseButtonIsDown() {
      interrupted = true
      break
    }
    if !post(.leftMouseDragged, end) { break }
    usleep(30_000)
  }
}
if mouseIsDown {
  _ = transport.post(.leftMouseUp, at: interrupted || eventFailed ? lastPoint : end)
  mouseIsDown = false
}
usleep(80_000)
let overlayStatus = patrolPointer.statusLine
patrolPointer.hide()
let restored = CGEvent(source: nil)?.location
if let original, let restored {
  print("cursor|\(original.x)|\(original.y)|\(restored.x)|\(restored.y)")
}
print("interrupted|user=\(interrupted ? 1 : 0)")
print(transport.statusLine)
print("release|targeted=1")
print(overlayStatus)
guard !eventFailed else {
  fputs("targeted drag event creation failed\n", stderr)
  exit(5)
}
if interrupted { exit(6) }
print("ok|targeted=1|userCursorFree=1")
