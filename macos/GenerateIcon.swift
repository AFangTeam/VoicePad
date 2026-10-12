import AppKit

let size = 1024
guard CommandLine.arguments.count == 2,
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                    isPlanar: false, colorSpaceName: .deviceRGB,
                                    bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Unable to create icon bitmap")
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high

let base = NSBezierPath(roundedRect: NSRect(x: 48, y: 48, width: 928, height: 928),
                        xRadius: 220, yRadius: 220)
NSShadow().apply {
    $0.shadowColor = NSColor.black.withAlphaComponent(0.32)
    $0.shadowBlurRadius = 38
    $0.shadowOffset = NSSize(width: 0, height: -15)
}
NSGradient(starting: NSColor(calibratedRed: 0.13, green: 0.23, blue: 0.28, alpha: 1),
           ending: NSColor(calibratedRed: 0.055, green: 0.085, blue: 0.12, alpha: 1))!
    .draw(in: base, angle: 105)
NSShadow().set()

let surface = NSBezierPath(roundedRect: NSRect(x: 170, y: 170, width: 684, height: 684),
                           xRadius: 134, yRadius: 134)
NSColor(calibratedRed: 0.075, green: 0.135, blue: 0.17, alpha: 1).setFill()
surface.fill()
NSColor(calibratedRed: 0.40, green: 0.72, blue: 0.72, alpha: 0.34).setStroke()
surface.lineWidth = 9
surface.stroke()

for offset in [307.0, 444.0, 581.0, 718.0] {
    let vertical = NSBezierPath()
    vertical.move(to: NSPoint(x: offset, y: 205))
    vertical.line(to: NSPoint(x: offset, y: 819))
    vertical.lineWidth = 3
    NSColor(calibratedRed: 0.55, green: 0.78, blue: 0.78, alpha: 0.12).setStroke()
    vertical.stroke()

    let horizontal = NSBezierPath()
    horizontal.move(to: NSPoint(x: 205, y: offset))
    horizontal.line(to: NSPoint(x: 819, y: offset))
    horizontal.lineWidth = 3
    horizontal.stroke()
}

let verticalAxis = NSBezierPath()
verticalAxis.move(to: NSPoint(x: 512, y: 208))
verticalAxis.line(to: NSPoint(x: 512, y: 816))
verticalAxis.lineWidth = 6
NSColor(calibratedRed: 0.65, green: 0.88, blue: 0.86, alpha: 0.28).setStroke()
verticalAxis.stroke()

let horizontalAxis = NSBezierPath()
horizontalAxis.move(to: NSPoint(x: 208, y: 512))
horizontalAxis.line(to: NSPoint(x: 816, y: 512))
horizontalAxis.lineWidth = 6
horizontalAxis.stroke()

let wave = NSBezierPath()
wave.move(to: NSPoint(x: 250, y: 512))
wave.curve(to: NSPoint(x: 380, y: 512), controlPoint1: NSPoint(x: 305, y: 512),
           controlPoint2: NSPoint(x: 315, y: 610))
wave.curve(to: NSPoint(x: 512, y: 512), controlPoint1: NSPoint(x: 440, y: 405),
           controlPoint2: NSPoint(x: 445, y: 512))
wave.curve(to: NSPoint(x: 650, y: 512), controlPoint1: NSPoint(x: 575, y: 512),
           controlPoint2: NSPoint(x: 580, y: 625))
wave.curve(to: NSPoint(x: 775, y: 512), controlPoint1: NSPoint(x: 710, y: 410),
           controlPoint2: NSPoint(x: 725, y: 512))
wave.lineWidth = 18
wave.lineCapStyle = .round
NSColor(calibratedRed: 0.35, green: 0.91, blue: 0.82, alpha: 0.95).setStroke()
wave.stroke()

let puckShadow = NSShadow()
puckShadow.shadowColor = NSColor(calibratedRed: 0.29, green: 0.95, blue: 0.83, alpha: 0.65)
puckShadow.shadowBlurRadius = 58
puckShadow.apply { _ in }
let puck = NSBezierPath(ovalIn: NSRect(x: 434, y: 434, width: 156, height: 156))
NSGradient(starting: NSColor.white,
           ending: NSColor(calibratedRed: 0.57, green: 0.98, blue: 0.89, alpha: 1))!
    .draw(in: puck, angle: 100)
NSShadow().set()

NSGraphicsContext.restoreGraphicsState()
guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Unable to encode icon PNG")
}
try data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))

private extension NSShadow {
    func apply(_ body: (NSShadow) -> Void) {
        body(self)
        set()
    }
}
